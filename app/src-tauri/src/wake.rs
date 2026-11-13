// "Hey Bond": talk to him without a hotkey, and only he answers you (like Siri).
//
//   Wake word  Each stretch of speech the microphone hears goes through his ears (Parakeet,
//              on this laptop) and is checked for "hey bond" as the ears hear real voices
//              ("they bond", "say bond"…, plus how they heard yours when you taught him).
//              The small keyword spotter tried first caught only 1 of 6 of the owner's
//              "Hey Bond"s; the ears caught all of them in the same recording. Nothing is
//              recorded or kept: what isn't for him is dropped as soon as it's read.
//   Voice match  Once, you read a few short "Hey Bond, ..." lines (enrolment). After that a
//              speaker model (NVIDIA TitaNet-small) checks every request, wake word and command
//              together, against your voiceprint, so other people, videos and calls are
//              ignored. Whole requests, not the 1-second wake word alone: on short clips no
//              model told voices apart (wake::tests::compare). On whole requests TitaNet
//              separated 8 voices perfectly (you >= 0.88, others <= 0.70), 80 ms per check.
//   After it   "Hey Bond, open Spotify" in one go is done at once; "Hey Bond" alone gets
//              "Yes?" and the next thing you say is the request.
//   Follow-up  After he answers out loud, he keeps listening a few seconds for a follow-up
//              without the wake word (still only your voice).
//
// Models (~57 MB) are downloaded into <local app data>/voice next to his voice and ears.
// The voiceprint is <app data>/voiceprint.json: numbers describing your voice, no audio.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::voice::{self, Endpoint, ASR_RATE};

const KWS_ARCHIVE: &str = "kws-models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2";
const KWS_DIR: &str = "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01";
const KWS_MODEL: &str = "epoch-12-avg-2-chunk-16-left-64.int8.onnx";
const SPEAKER_URL: &str = "speaker-recongition-models/nemo_en_titanet_small.onnx";
const SPEAKER_FILE: &str = "speaker/nemo_en_titanet_small.onnx";
/// SHA-256 of the two downloads. GitHub publishes no digest for these older uploads: these are of fresh
/// downloads of the same URLs (2026-11-14), matching their published sizes.
const KWS_SHA: &str = "f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a";
const SPEAKER_SHA: &str = "ad4a1802485d8b34c722d2a9d04249662f2ece5d28a7a039063ca22f515a789e";

/// "hey bond" in the model's word pieces. `:` boosts the phrase, `#` is how sure the
/// spotter must be (lower wakes more easily). Over 8 voices this caught 22/24 "hey bond"s
/// and 0/56 look-alikes ("James Bond", "hey Bob", "a government bond"...); the default
/// (#0.25) caught only 16/24 (wake::tests::compare).
const KEYWORDS: &str = "▁HE Y ▁BO ND :3.0 #0.10 @HEY_BOND";

/// Audio kept in memory, so the wake word itself can be checked against your voice.
const RING: usize = ASR_RATE as usize * 3;
/// The stretch of audio checked for your voice when the keyword spotter fires (tests).
#[cfg(test)]
const WAKE_AUDIO: usize = ASR_RATE as usize * 16 / 10;
/// Voice match is looser on a follow-up (different words than the enrolment, often short).
const FOLLOW_UP_SLACK: f32 = 0.75;
/// …and looser still for the request just after a "Hey Bond" that was already your voice:
/// the owner's short requests scored 0.32-0.37 against a bar of 0.45 (2026-10-10).
const AFTER_WAKE_SLACK: f32 = 0.6;
/// Requests you confirmed were you ("Was that you?" → yes) kept in the voiceprint.
const MAX_LEARNED: usize = 10;
/// Turned away by less than this: he asks "Was that you?" instead of staying silent.
const UNSURE_MARGIN: f32 = 0.12;
/// Enrolment: at least this many lines read.
pub const MIN_SAMPLES: usize = 3;
/// What Settings asks you to read for enrolment (each starts with the wake word, so it's
/// also checked that "hey bond" is heard in your voice).
pub const ENROL_LINES: [&str; 5] = [
    "Hey Bond, this is my voice.",
    "Hey Bond, open Spotify and play some music.",
    "Hey Bond, remind me to call my mother this evening.",
    "Hey Bond, what's on my screen right now?",
    "Hey Bond, free up some memory please.",
];

// --- Models ------------------------------------------------------------------------------

fn kws_dir() -> Result<PathBuf, String> {
    Ok(voice::dir()?.join(KWS_DIR))
}

fn speaker_path() -> Result<PathBuf, String> {
    Ok(voice::dir()?.join(SPEAKER_FILE))
}

pub fn installed() -> bool {
    kws_dir().map(|d| d.join(format!("encoder-{KWS_MODEL}")).exists()).unwrap_or(false) && speaker_path().map(|p| p.exists()).unwrap_or(false)
}

fn path_str(p: PathBuf) -> Option<String> {
    Some(p.to_string_lossy().into_owned())
}

fn spotter() -> Result<sherpa_onnx::KeywordSpotter, String> {
    spotter_for(KEYWORDS)
}

fn spotter_for(keywords: &str) -> Result<sherpa_onnx::KeywordSpotter, String> {
    if !installed() {
        return Err("“Hey Bond” isn't set up yet — download it in Dashboard → Settings.".into());
    }
    let d = kws_dir()?;
    let mut c = sherpa_onnx::KeywordSpotterConfig::default();
    c.model_config.transducer.encoder = path_str(d.join(format!("encoder-{KWS_MODEL}")));
    c.model_config.transducer.decoder = path_str(d.join(format!("decoder-{KWS_MODEL}")));
    c.model_config.transducer.joiner = path_str(d.join(format!("joiner-{KWS_MODEL}")));
    c.model_config.tokens = path_str(d.join("tokens.txt"));
    c.model_config.num_threads = 1;
    c.keywords_buf = Some(keywords.to_string());
    sherpa_onnx::KeywordSpotter::create(&c).ok_or_else(|| "The wake word couldn't start.".to_string())
}

static EXTRACTOR: Mutex<Option<Arc<sherpa_onnx::SpeakerEmbeddingExtractor>>> = Mutex::new(None);

fn extractor() -> Result<Arc<sherpa_onnx::SpeakerEmbeddingExtractor>, String> {
    let mut guard = EXTRACTOR.lock().unwrap();
    if let Some(e) = guard.as_ref() {
        return Ok(e.clone());
    }
    let config = sherpa_onnx::SpeakerEmbeddingExtractorConfig { model: path_str(speaker_path()?), num_threads: 2, debug: false, provider: None };
    let e = Arc::new(sherpa_onnx::SpeakerEmbeddingExtractor::create(&config).ok_or("Voice match couldn't start.")?);
    *guard = Some(e.clone());
    Ok(e)
}

/// What a voice sounds like, as a unit vector (16 kHz mono in).
pub fn embed(samples: &[f32]) -> Result<Vec<f32>, String> {
    embed_with(&*extractor()?, samples)
}

fn embed_with(x: &sherpa_onnx::SpeakerEmbeddingExtractor, samples: &[f32]) -> Result<Vec<f32>, String> {
    let stream = x.create_stream().ok_or("Voice match couldn't start.")?;
    stream.accept_waveform(ASR_RATE as i32, samples);
    stream.input_finished();
    if !x.is_ready(&stream) {
        return Err("That was too short to tell whose voice it is.".into());
    }
    let mut v = x.compute(&stream).ok_or("Voice match failed.")?;
    normalize(&mut v);
    Ok(v)
}

fn normalize(v: &mut [f32]) {
    let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if n > 0.0 {
        v.iter_mut().for_each(|x| *x /= n);
    }
}

fn cosine(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

/// Does this clip (16 kHz) contain "hey bond"?
pub fn hears_wake_word(samples: &[f32]) -> Result<bool, String> {
    let kws = spotter()?;
    let stream = kws.create_stream();
    stream.accept_waveform(ASR_RATE as i32, samples);
    stream.accept_waveform(ASR_RATE as i32, &vec![0.0; ASR_RATE as usize / 2]);
    stream.input_finished();
    while kws.is_ready(&stream) {
        kws.decode(&stream);
        if kws.get_result(&stream).is_some_and(|r| !r.keyword.is_empty()) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Download the wake word and voice match models (~57 MB). Emits `brain-progress`.
#[tauri::command]
pub async fn wake_install(app: AppHandle) -> Result<(), String> {
    let http = reqwest::Client::builder().connect_timeout(Duration::from_secs(20)).build().map_err(|e| e.to_string())?;
    let dir = voice::dir()?.to_path_buf();
    std::fs::create_dir_all(dir.join("speaker")).map_err(|e| e.to_string())?;
    if !kws_dir()?.exists() {
        let file = dir.join("kws.tar.bz2");
        crate::brain::download(&app, &http, &format!("{}/{KWS_ARCHIVE}", voice::RELEASES), &file, "the wake word", KWS_SHA).await?;
        let (f, target) = (file.clone(), dir.clone());
        tauri::async_runtime::spawn_blocking(move || voice::untar(&f, &target)).await.map_err(|e| e.to_string())??;
        let _ = std::fs::remove_file(&file);
    }
    if !speaker_path()?.exists() {
        crate::brain::download(&app, &http, &format!("{}/{SPEAKER_URL}", voice::RELEASES), &speaker_path()?, "voice match", SPEAKER_SHA).await?;
    }
    if installed() {
        Ok(())
    } else {
        Err("The download was incomplete. Try again.".into())
    }
}

// --- Voiceprint --------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone)]
pub struct Voiceprint {
    /// Your average voice (unit vector).
    pub centroid: Vec<f32>,
    /// Each enrolment sample.
    pub samples: Vec<Vec<f32>>,
    /// Lowest similarity to the centroid that still counts as you.
    pub threshold: f32,
    /// How the ears heard your "Hey Bond" while you taught him ("they bond").
    #[serde(default)]
    pub aliases: Vec<String>,
}

impl Voiceprint {
    pub fn from_samples(samples: Vec<Vec<f32>>) -> Voiceprint {
        let dim = samples[0].len();
        let mut centroid = vec![0.0; dim];
        for s in &samples {
            centroid.iter_mut().zip(s).for_each(|(c, x)| *c += x);
        }
        normalize(&mut centroid);
        // How alike your own samples are sets the bar: below your least typical one, since a
        // request on another day, mood or mic scores lower than the enrolment itself.
        let threshold = Self::bar(&samples, &centroid);
        Voiceprint { centroid, samples, threshold, aliases: Vec::new() }
    }

    /// Your least typical sample, less a margin: a request on another day, mood or mic
    /// scores lower than the enrolment itself. The owner's real requests scored 0.50-0.77
    /// against an enrolment whose least typical sample was 0.78 (2026-10-10), so 0.3. Other
    /// voices scored at most 0.32 in tests.
    fn bar(samples: &[Vec<f32>], centroid: &[f32]) -> f32 {
        let worst = samples.iter().map(|s| cosine(s, centroid)).fold(f32::MAX, f32::min);
        (worst - 0.3).clamp(0.45, 0.7)
    }

    /// Learn from a request you confirmed was you: it joins the samples (the newest few
    /// replace older learned ones; the enrolment lines stay).
    fn learn(&mut self, e: Vec<f32>, enrolled: usize) {
        self.samples.push(e);
        while self.samples.len() > enrolled.max(5) + MAX_LEARNED {
            self.samples.remove(enrolled.max(5));
        }
        let mut centroid = vec![0.0; self.centroid.len()];
        for s in &self.samples {
            centroid.iter_mut().zip(s).for_each(|(c, x)| *c += x);
        }
        normalize(&mut centroid);
        self.threshold = Self::bar(&self.samples, &centroid);
        self.centroid = centroid;
    }

    pub fn score(&self, e: &[f32]) -> f32 {
        cosine(e, &self.centroid)
    }
}

static PRINT: Mutex<Option<Voiceprint>> = Mutex::new(None);
static PRINT_FILE: Mutex<Option<PathBuf>> = Mutex::new(None);

fn print_file(app: &AppHandle) -> Option<PathBuf> {
    let mut f = PRINT_FILE.lock().unwrap();
    if f.is_none() {
        *f = app.path().app_data_dir().ok().map(|d| d.join("voiceprint.json"));
    }
    f.clone()
}

fn load_print(app: &AppHandle) {
    let mut p = print_file(app).and_then(|f| std::fs::read_to_string(f).ok()).and_then(|s| serde_json::from_str::<Voiceprint>(&s).ok());
    if let Some(p) = p.as_mut() {
        p.threshold = Voiceprint::bar(&p.samples, &p.centroid);
    }
    crate::diag::log(&format!("voiceprint: {}", p.as_ref().map(|p| format!("{} samples, bar {:.2}", p.samples.len(), p.threshold)).unwrap_or("none".into())));
    *PRINT.lock().unwrap() = p;
}

/// Enrolment samples taken so far (not saved until `wake_enroll_save`).
static ENROLLING: Mutex<Vec<Vec<f32>>> = Mutex::new(Vec::new());
/// How the ears heard "Hey Bond" in each line read so far.
static ENROLL_HEARD: Mutex<Vec<String>> = Mutex::new(Vec::new());
/// While enrolling, hearing "hey bond" doesn't wake him.
static ENROLL_MODE: AtomicBool = AtomicBool::new(false);

#[derive(Serialize)]
pub struct EnrollStep {
    /// The wake word was heard clearly in this sample.
    pub heard: bool,
    pub count: usize,
    pub needed: usize,
}

/// Record one "Hey Bond" (stops when you go quiet) and keep it if the wake word is in it.
#[tauri::command]
pub async fn wake_enroll_record(app: AppHandle) -> Result<EnrollStep, String> {
    ENROLL_MODE.store(true, Ordering::SeqCst);
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<EnrollStep, String> {
        let ready = app.clone();
        let (samples, rate) = voice::record_once(move || {
            let _ = ready.emit("voice-state", "listening");
        })?;
        let _ = app.emit("voice-state", "idle");
        let audio = trim_silence(&voice::resample(&samples, rate, ASR_RATE));
        let text = if audio.is_empty() { String::new() } else { voice::transcribe(&audio, ASR_RATE)? };
        crate::diag::log(&format!("enrolment: heard “{text}”"));
        let heard = !audio.is_empty() && (asr_wake(&text).is_some() || hears_wake_word(&audio)? || first_words(&text, 2).split_whitespace().count() == 2);
        let mut list = ENROLLING.lock().unwrap();
        if heard {
            list.push(embed(&audio)?);
            ENROLL_HEARD.lock().unwrap().push(first_words(&text, 2));
        }
        Ok(EnrollStep { heard, count: list.len(), needed: ENROL_LINES.len() })
    })
    .await
    .map_err(|e| e.to_string())?;
    if result.is_err() {
        ENROLL_MODE.store(false, Ordering::SeqCst);
    }
    result
}

/// Keep the samples as your voiceprint.
#[tauri::command]
pub fn wake_enroll_save(app: AppHandle) -> Result<(), String> {
    ENROLL_MODE.store(false, Ordering::SeqCst);
    let samples = std::mem::take(&mut *ENROLLING.lock().unwrap());
    let heard = std::mem::take(&mut *ENROLL_HEARD.lock().unwrap());
    if samples.len() < MIN_SAMPLES {
        return Err(format!("I need at least {MIN_SAMPLES} clear “Hey Bond”s."));
    }
    let mut print = Voiceprint::from_samples(samples);
    // Your own "Hey Bond", as the ears hear it, when they don't already know it.
    let mut aliases: Vec<String> = heard.into_iter().filter(|h| !h.is_empty() && asr_wake(h).is_none()).collect();
    aliases.sort();
    aliases.dedup();
    crate::diag::log(&format!("enrolment: your “Hey Bond” is heard as {aliases:?}"));
    print.aliases = aliases;
    let file = print_file(&app).ok_or("The app data folder isn't available.")?;
    if let Some(d) = file.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    std::fs::write(&file, serde_json::to_string(&print).map_err(|e| e.to_string())?).map_err(|e| format!("Couldn't save your voiceprint: {e}"))?;
    *PRINT.lock().unwrap() = Some(print);
    Ok(())
}

/// Throw away an enrolment in progress.
#[tauri::command]
pub fn wake_enroll_cancel() {
    ENROLL_MODE.store(false, Ordering::SeqCst);
    ENROLLING.lock().unwrap().clear();
    ENROLL_HEARD.lock().unwrap().clear();
}

/// The first `n` words, lower case, without punctuation: "They bond, this is…" → "they bond".
fn first_words(text: &str, n: usize) -> String {
    text.split_whitespace()
        .take(n)
        .map(|w| w.chars().filter(|c| c.is_alphanumeric() || *c == '\'').collect::<String>().to_lowercase())
        .filter(|w| !w.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Forget your voiceprint.
#[tauri::command]
pub fn wake_forget_voice(app: AppHandle) {
    if let Some(f) = print_file(&app) {
        let _ = std::fs::remove_file(f);
    }
    *PRINT.lock().unwrap() = None;
}

/// The part of a clip with sound in it, plus a little either side.
fn trim_silence(x: &[f32]) -> Vec<f32> {
    let win = ASR_RATE as usize / 50; // 20 ms
    let energies: Vec<f32> = x.chunks(win).map(|c| (c.iter().map(|s| s * s).sum::<f32>() / c.len() as f32).sqrt()).collect();
    let peak = energies.iter().cloned().fold(0.0, f32::max);
    if peak < 0.005 {
        return Vec::new();
    }
    let loud = |e: &f32| *e > peak * 0.08;
    let (Some(first), Some(last)) = (energies.iter().position(loud), energies.iter().rposition(loud)) else { return Vec::new() };
    let pad = 10; // 200 ms
    let start = first.saturating_sub(pad) * win;
    let end = ((last + 1 + pad) * win).min(x.len());
    x[start..end].to_vec()
}

// --- Listening ---------------------------------------------------------------------------

static ENABLED: AtomicBool = AtomicBool::new(false);
static VOICE_MATCH: AtomicBool = AtomicBool::new(true);
static RUNNING: AtomicBool = AtomicBool::new(false);
static FOLLOW_UNTIL: Mutex<Option<Instant>> = Mutex::new(None);

/// The last few voice checks (score, accepted), so Settings can show how sure he is.
static SCORES: Mutex<VecDeque<(f32, bool)>> = Mutex::new(VecDeque::new());

fn remember_score(score: f32, you: bool) {
    let mut s = SCORES.lock().unwrap();
    s.push_back((score, you));
    while s.len() > 8 {
        s.pop_front();
    }
}

#[derive(Serialize)]
pub struct WakeStatus {
    installed: bool,
    enrolled: bool,
    enabled: bool,
    listening: bool,
    /// Your voiceprint's bar, and the latest checks against it.
    threshold: Option<f32>,
    recent: Vec<(f32, bool)>,
    /// The lines to read when teaching him your voice.
    lines: [&'static str; 5],
}

#[tauri::command]
pub fn wake_status(app: AppHandle) -> WakeStatus {
    if PRINT.lock().unwrap().is_none() {
        load_print(&app);
    }
    let print = PRINT.lock().unwrap();
    WakeStatus {
        installed: installed(),
        enrolled: print.is_some(),
        enabled: ENABLED.load(Ordering::SeqCst),
        listening: RUNNING.load(Ordering::SeqCst),
        threshold: print.as_ref().map(|p| p.threshold),
        recent: SCORES.lock().unwrap().iter().copied().collect(),
        lines: ENROL_LINES,
    }
}

/// Turn "Hey Bond" on or off; `voice_match` makes him answer only your voice.
#[tauri::command]
pub fn wake_set(app: AppHandle, enabled: bool, voice_match: bool) -> Result<(), String> {
    VOICE_MATCH.store(voice_match, Ordering::SeqCst);
    ENABLED.store(enabled, Ordering::SeqCst);
    crate::diag::log(&format!("wake_set enabled={enabled} voice_match={voice_match} running={}", RUNNING.load(Ordering::SeqCst)));
    if !enabled {
        return Ok(());
    }
    if !installed() {
        ENABLED.store(false, Ordering::SeqCst);
        return Err("“Hey Bond” isn't set up yet — download it in Dashboard → Settings.".into());
    }
    load_print(&app);
    if !RUNNING.swap(true, Ordering::SeqCst) {
        std::thread::spawn(move || {
            crate::diag::log("listener: started");
            if let Err(e) = listen(&app) {
                crate::diag::log(&format!("listener: stopped with error: {e}"));
                let _ = app.emit("voice-error", format!("“Hey Bond” stopped: {e}"));
            }
            crate::diag::log("listener: ended");
            RUNNING.store(false, Ordering::SeqCst);
            let _ = app.emit("wake-listening", false);
        });
    }
    Ok(())
}

/// He just answered out loud: take a follow-up without the wake word for a few seconds.
#[tauri::command]
pub fn wake_follow_up(seconds: f64) {
    if ENABLED.load(Ordering::SeqCst) {
        *FOLLOW_UNTIL.lock().unwrap() = Some(Instant::now() + Duration::from_secs_f64(seconds.clamp(1.0, 15.0)));
    }
}

/// Whether a voice is yours: always true with voice match off or before enrolment.
fn is_you(audio: &[f32], slack: f32) -> Result<(bool, f32, Option<(Vec<f32>, f32)>), String> {
    if !VOICE_MATCH.load(Ordering::SeqCst) {
        return Ok((true, 1.0, None));
    }
    let Some(print) = PRINT.lock().unwrap().clone() else { return Ok((true, 1.0, None)) };
    let e = embed(audio)?;
    let score = print.score(&e);
    let bar = print.threshold * slack;
    Ok((score >= bar, score, Some((e, bar))))
}

/// A request turned away by a little: kept a minute in case you say it was you.
pub(crate) struct Unsure {
    voice: Vec<f32>,
    /// What you asked (empty: "Hey Bond" alone).
    text: String,
    at: Instant,
}

static UNSURE: Mutex<Option<Unsure>> = Mutex::new(None);

/// "Was that you?" → yes: he learns that voice sample and does what you asked.
#[tauri::command]
pub fn wake_confirm_you(app: AppHandle) -> Result<(), String> {
    let u = UNSURE.lock().unwrap().take().filter(|u| u.at.elapsed() < Duration::from_secs(90)).ok_or("That was a while ago. Say it again?")?;
    if let Some(print) = PRINT.lock().unwrap().as_mut() {
        print.learn(u.voice, ENROL_LINES.len());
        crate::diag::log(&format!("voiceprint: learned a confirmed request, {} samples, bar {:.2}", print.samples.len(), print.threshold));
        if let (Some(file), Ok(json)) = (print_file(&app), serde_json::to_string(&*print)) {
            let _ = std::fs::write(file, json);
        }
    }
    crate::diag::log(&format!("confirmed: “{}”", u.text));
    if u.text.is_empty() {
        let _ = app.emit("wake-empty", ());
    } else {
        let _ = app.emit("voice-heard", u.text);
    }
    Ok(())
}

/// "Was that you?" → no.
#[tauri::command]
pub fn wake_not_you() {
    UNSURE.lock().unwrap().take();
}

/// What the listener made of the latest audio.
pub(crate) enum Event {
    /// You started talking while he waits for a request (after "Yes?" or a follow-up).
    Listening,
    /// "Hey Bond" on its own: he says "Yes?" and takes the next thing you say.
    Woke,
    /// Your request, already transcribed (`woke`: it came with "Hey Bond").
    Heard { text: String, woke: bool },
    /// Not your voice: ignored. `close`: only just under the bar, with what's needed to ask.
    Rejected { score: f32, close: Option<Unsure> },
    /// He was waiting for a request and none came.
    Idle,
}

impl Event {
    fn describe(&self) -> String {
        match self {
            Event::Listening => "listening".into(),
            Event::Woke => "wake word alone: Yes?".into(),
            Event::Heard { text, woke } => format!("heard “{text}”{}", if *woke { " (with the wake word)" } else { "" }),
            Event::Rejected { score, close } => format!("not your voice ({score:.2}){}", if close.is_some() { ", close: asking" } else { "" }),
            Event::Idle => "nothing came: idle".into(),
        }
    }
}

/// A pause this long ends a stretch of speech, which is then transcribed.
const STRETCH_PAUSE: Duration = Duration::from_millis(600);
/// When what he has heard so far ends mid-sentence ("…as well as", "…using"), he waits this
/// long in all before taking it as finished, the way a person waits for you to go on.
const LONG_PAUSE: Duration = Duration::from_millis(2200);
/// Longest stretch transcribed at once.
const MAX_STRETCH: usize = ASR_RATE as usize * 10;
/// Shorter than this isn't a word (a knock, a click).
const MIN_STRETCH: usize = ASR_RATE as usize * 3 / 10;
/// After "Hey Bond" alone, the next thing you say within this long is the request.
const AWAIT_REQUEST: Duration = Duration::from_secs(10);

struct Stretch {
    audio: Vec<f32>,
    talk: Endpoint,
    started: Duration,
    /// What the speech so far says, read at the first pause (kept while he waits to see if
    /// you go on, dropped if you do).
    draft: Option<String>,
}

/// Whether a request sounds unfinished: it ends on a word nobody ends a sentence with, or on a comma.
pub(crate) fn unfinished(text: &str) -> bool {
    let t = text.trim().to_lowercase();
    if t.is_empty() || t.ends_with(['.', '!', '?']) {
        return false;
    }
    if t.ends_with([',', ';', ':', '-', '…']) {
        return true;
    }
    // His ears put a full stop or question mark on a sentence they hear end; a stretch without
    // one was cut off ("I want to generate"). A single word ("Stop", "Yes") is a whole request.
    if t.split_whitespace().count() >= 3 {
        return true;
    }
    let last = t.trim_end_matches(|c: char| !c.is_alphanumeric()).rsplit(|c: char| c.is_whitespace()).next().unwrap_or("");
    const OPEN: &[&str] = &[
        "and", "or", "but", "so", "to", "the", "a", "an", "my", "your", "our", "with", "using", "in", "on", "at", "for", "of", "from", "into",
        "that", "because", "then", "also", "as", "like", "about", "how", "what", "when", "where", "which", "who", "if", "i", "i'm", "me", "um", "uh",
        "well", "is", "are", "was", "can", "could", "would", "should", "do", "does", "not", "by", "than", "this", "these", "those", "some", "any",
    ];
    OPEN.contains(&last)
}

/// Microphone audio in (16 kHz chunks), events out. Every stretch of speech goes through the
/// ears (Parakeet) and is checked for "hey bond" as they hear it from real voices; the small
/// keyword spotter tried first caught 1 of 6 of the owner's "Hey Bond"s (wake::tests::kws_tune,
/// 2026-10-10). Kept apart from the microphone so it can be tested on recorded speech.
pub(crate) struct Listener {
    ring: VecDeque<f32>,
    stretch: Option<Stretch>,
    /// After "Hey Bond" alone: until when the next stretch is the request (audio time).
    awaiting: Option<Duration>,
    /// Audio time so far.
    t: Duration,
    aliases: Vec<String>,
}

impl Listener {
    pub fn new() -> Result<Listener, String> {
        let aliases = PRINT.lock().unwrap().as_ref().map(|p| p.aliases.clone()).unwrap_or_default();
        Ok(Listener { ring: VecDeque::with_capacity(RING), stretch: None, awaiting: None, t: Duration::ZERO, aliases })
    }

    /// Start over (push-to-talk or enrolment took the microphone).
    pub fn pause(&mut self) {
        self.stretch = None;
        self.awaiting = None;
    }

    /// Feed the next chunk; `follow_up_open` while a follow-up needs no wake word.
    pub fn push(&mut self, chunk: &[f32], follow_up_open: bool) -> Result<Vec<Event>, String> {
        self.t += Duration::from_secs_f64(chunk.len() as f64 / ASR_RATE as f64);
        self.ring.extend(chunk.iter().copied());
        while self.ring.len() > RING {
            self.ring.pop_front();
        }
        let now = self.t;
        let mut out = Vec::new();
        let waiting = self.awaiting.is_some_and(|until| now < until);
        if self.awaiting.is_some() && !waiting && self.stretch.is_none() {
            self.awaiting = None;
            out.push(Event::Idle);
        }
        let Some(s) = &mut self.stretch else {
            // Quiet so far: does this chunk start a stretch of speech?
            let floor = noise_floor(self.ring.make_contiguous());
            let mut probe = Endpoint::with_floor(floor);
            probe.feed(chunk, Duration::from_millis(40));
            if probe.speaking() {
                // Start a little early, so the first sound isn't cut.
                let lead: Vec<f32> = self.ring.iter().skip(self.ring.len().saturating_sub(ASR_RATE as usize * 3 / 10)).copied().collect();
                self.stretch = Some(Stretch { audio: lead, talk: probe, started: now, draft: None });
                if waiting || follow_up_open {
                    out.push(Event::Listening);
                }
            }
            return Ok(out);
        };
        s.audio.extend_from_slice(chunk);
        let at = now - s.started;
        s.talk.feed(chunk, at);
        let quiet = s.talk.quiet_for(at);
        if quiet < STRETCH_PAUSE {
            s.draft = None; // you went on
            if s.audio.len() < MAX_STRETCH {
                return Ok(out);
            }
        }
        // A pause. If it stops mid-sentence, give you a little longer before taking it as done.
        if s.audio.len() < MAX_STRETCH && quiet < LONG_PAUSE && s.audio.len() >= MIN_STRETCH {
            if s.draft.is_none() {
                s.draft = Some(voice::transcribe(&s.audio, ASR_RATE)?);
            }
            if s.draft.as_deref().is_some_and(unfinished) {
                return Ok(out);
            }
        }
        let draft = s.draft.take();
        let audio = std::mem::take(&mut s.audio);
        self.stretch = None;
        if audio.len() < MIN_STRETCH {
            return Ok(out);
        }
        let text = match draft {
            Some(t) => t,
            None => voice::transcribe(&audio, ASR_RATE)?,
        };
        let wanted = waiting || follow_up_open;
        if wanted {
            // So "he said Yes? and then nothing happened" can be traced to what he heard.
            crate::diag::log(&format!("listener: {:.1} s of speech while waiting, heard “{}”", audio.len() as f32 / ASR_RATE as f32, text.trim()));
        }
        let (rest, woke) = match asr_wake_with(&text, &self.aliases) {
            Some(rest) => (rest, true),
            None if wanted => (text.trim().to_string(), false),
            None => return Ok(out), // talk that isn't for him
        };
        if rest.is_empty() && !woke {
            return Ok(out);
        }
        // Your voice? The whole stretch: wake word and request together when said in one go.
        let slack = if woke { 1.0 } else if waiting { AFTER_WAKE_SLACK } else { FOLLOW_UP_SLACK };
        let (you, score, check) = is_you(&trim_silence(&audio), slack)?;
        remember_score(score, you);
        if !you {
            let close = check.filter(|(_, bar)| score >= bar - UNSURE_MARGIN).map(|(voice, _)| Unsure { voice, text: rest, at: Instant::now() });
            out.push(Event::Rejected { score, close });
            return Ok(out);
        }
        if rest.is_empty() {
            self.awaiting = Some(now + AWAIT_REQUEST);
            out.push(Event::Woke);
        } else {
            self.awaiting = None;
            out.push(Event::Heard { text: rest, woke });
        }
        Ok(out)
    }
}

/// Whether "Hey Bond" is on and listening (his ears stay loaded meanwhile).
pub fn active() -> bool {
    RUNNING.load(Ordering::SeqCst) && ENABLED.load(Ordering::SeqCst)
}

/// The always-on loop: microphone → Listener → events for the overlay.
fn listen(app: &AppHandle) -> Result<(), String> {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    let mut listener = Listener::new()?;
    let device = cpal::default_host().default_input_device().ok_or("No microphone found.")?;
    let supported = device.default_input_config().map_err(|e| format!("The microphone isn't available: {e}"))?;
    let rate = supported.sample_rate();
    let channels = supported.channels() as usize;
    let config: cpal::StreamConfig = supported.config();
    let buf: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = buf.clone();
    let push = move |mono: Vec<f32>| sink.lock().unwrap().extend(mono);
    let err = |e| eprintln!("wake microphone: {e}");
    let stream = match supported.sample_format() {
        cpal::SampleFormat::F32 => device.build_input_stream(config, move |d: &[f32], _: &_| push(voice::downmix(d, channels, |s| s)), err, None),
        cpal::SampleFormat::I16 => device.build_input_stream(config, move |d: &[i16], _: &_| push(voice::downmix(d, channels, |s| s as f32 / 32768.0)), err, None),
        cpal::SampleFormat::I32 => device.build_input_stream(config, move |d: &[i32], _: &_| push(voice::downmix(d, channels, |s| s as f32 / 2_147_483_648.0)), err, None),
        f => return Err(format!("This microphone's format ({f:?}) isn't supported.")),
    }
    .map_err(|e| format!("Couldn't open the microphone: {e}"))?;
    stream.play().map_err(|e| format!("Couldn't start the microphone: {e}"))?;
    let _ = app.emit("wake-listening", true);
    crate::diag::log(&format!("listener: microphone {:?} at {rate} Hz, {channels} ch", device.description().map(|d| d.name().to_string()).unwrap_or_default()));
    // Load the ears now, so the first "Hey Bond" isn't slow.
    let _ = voice::transcribe(&vec![0.0; ASR_RATE as usize / 2], ASR_RATE);

    // Every 20 s the log says how much sound arrived and how loud, so a silent or stalled
    // microphone shows up.
    let mut beat = (Instant::now(), 0usize, 0.0f32, 0usize);
    while ENABLED.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(40));
        if beat.0.elapsed() > Duration::from_secs(20) {
            crate::diag::log(&format!("listener: {:.1} s of sound in the last 20 s, loudest {:.3}, paused {} times", beat.1 as f32 / ASR_RATE as f32, beat.2, beat.3));
            beat = (Instant::now(), 0, 0.0, 0);
        }
        let raw = std::mem::take(&mut *buf.lock().unwrap());
        if raw.is_empty() {
            continue;
        }
        let chunk = voice::resample(&raw, rate, ASR_RATE);
        beat.1 += chunk.len();
        beat.2 = chunk.iter().fold(beat.2, |m, s| m.max(s.abs()));
        // Push-to-talk or enrolment has the microphone's attention.
        if voice::LISTENING.load(Ordering::SeqCst) || ENROLL_MODE.load(Ordering::SeqCst) {
            beat.3 += 1;
            listener.pause();
            continue;
        }
        let open = FOLLOW_UNTIL.lock().unwrap().is_some_and(|t| Instant::now() < t);
        let events = match listener.push(&chunk, open) {
            Ok(e) => e,
            Err(e) => {
                crate::diag::log(&format!("listener: couldn't transcribe: {e}"));
                continue;
            }
        };
        for event in events {
            crate::diag::log(&format!("listener: {}", event.describe()));
            match event {
                Event::Listening => {
                    let _ = app.emit("voice-state", "listening");
                }
                Event::Idle => {
                    let _ = app.emit("voice-state", "idle");
                }
                Event::Woke => {
                    *FOLLOW_UNTIL.lock().unwrap() = None;
                    let _ = app.emit("wake", ());
                    let _ = app.emit("wake-empty", ()); // he says "Yes?"
                }
                Event::Heard { text, woke } => {
                    *FOLLOW_UNTIL.lock().unwrap() = None;
                    if woke {
                        let _ = app.emit("wake", ());
                    }
                    let _ = app.emit("voice-state", "idle");
                    let _ = app.emit("voice-heard", text);
                }
                Event::Rejected { score, close } => {
                    let _ = app.emit("voice-state", "idle");
                    match close {
                        Some(u) => {
                            *UNSURE.lock().unwrap() = Some(u);
                            let _ = app.emit("wake-unsure", score);
                        }
                        None => {
                            let _ = app.emit("wake-rejected", score);
                        }
                    }
                }
            }
        }
    }
    drop(stream);
    Ok(())
}

/// "Hey Bond" in what the ears heard, as they hear it from real voices: "hey bone",
/// "hay bond", "a bond", and for the owner "they bond", "say bond" and, said alone,
/// "they won't" (2026-10-10, wake::tests::clips) within the first words. Returns what was
/// said after it.
pub fn asr_wake(text: &str) -> Option<String> {
    asr_wake_with(text, &[])
}

/// `aliases`: how the ears heard your own "Hey Bond" when you taught him your voice.
pub fn asr_wake_with(text: &str, aliases: &[String]) -> Option<String> {
    const HEY: &[&str] = &["hey", "hay", "hei", "hi", "a", "ay", "eh", "ok", "okay", "he", "they", "say"];
    const BOND: &[&str] = &["bond", "bonds", "bon", "bone", "bones", "born", "bund", "bonn", "bound", "bomb"];
    // Common words that are also how "Hey Bond" can sound: only on their own.
    const WEAK: &[&str] = &["won't", "wont", "wand", "want", "won"];
    let words: Vec<(usize, String)> = text
        .split_whitespace()
        .scan(0usize, |pos, w| {
            let at = text[*pos..].find(w).map(|i| i + *pos).unwrap_or(*pos);
            *pos = at + w.len();
            Some((at + w.len(), w.chars().filter(|c| c.is_alphanumeric() || *c == '\'').collect::<String>().to_lowercase()))
        })
        .collect();
    let rest = |end: usize| text[end..].trim_start_matches([',', '.', '!', '?', ' ']).trim().to_string();
    for a in aliases {
        let a: Vec<&str> = a.split_whitespace().collect();
        if !a.is_empty() && words.len() >= a.len() && words.iter().zip(&a).all(|((_, w), x)| w == x) {
            return Some(rest(words[a.len() - 1].0));
        }
    }
    if words.len() == 2 && HEY.contains(&words[0].1.as_str()) && WEAK.contains(&words[1].1.as_str()) {
        return Some(String::new());
    }
    for i in 0..words.len().min(3) {
        let w = &words[i].1;
        // "heybond" as one word.
        if HEY.iter().any(|h| w.strip_prefix(h).is_some_and(|b| BOND.contains(&b))) {
            return Some(rest(words[i].0));
        }
        if HEY.contains(&w.as_str()) && words.get(i + 1).is_some_and(|(_, b)| BOND.contains(&b.as_str())) {
            return Some(rest(words[i + 1].0));
        }
    }
    None
}

/// The room's background level: the quiet end of the last few seconds (20 ms frames).
fn noise_floor(x: &[f32]) -> f32 {
    let mut rms: Vec<f32> = x.chunks(ASR_RATE as usize / 50).map(|c| (c.iter().map(|s| s * s).sum::<f32>() / c.len() as f32).sqrt()).collect();
    if rms.is_empty() {
        return 0.0;
    }
    rms.sort_by(f32::total_cmp);
    rms[rms.len() / 10]
}

/// "Hey Bond, open Spotify" → "open Spotify". The recording starts a little before the wake
/// word, so anything up to the first "bond" in the opening words goes too.
#[cfg(test)]
pub fn strip_wake_word(text: &str) -> String {
    let t = text.trim();
    let lower = t.to_lowercase();
    let head: usize = lower.split_inclusive(' ').take(4).map(str::len).sum();
    let found = lower.match_indices("bond").find(|(i, _)| {
        let before = lower[..*i].chars().last();
        let after = lower[i + 4..].chars().next();
        *i < head && !before.is_some_and(char::is_alphanumeric) && !after.is_some_and(char::is_alphanumeric)
    });
    match found {
        Some((i, _)) => t[i + 4..].trim_start_matches([',', '.', '!', '?', ' ']).to_string(),
        None => t.to_string(),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn knows_when_a_sentence_is_unfinished() {
        for t in ["Help me to record my screen as well as", "open the", "I want to record my screen using", "Hey Bond, I want to,", "uh", "I want to generate"] {
            assert!(super::unfinished(t), "{t}");
        }
        for t in ["Help me to record my screen as well as my face.", "Open Notepad", "What time is it?", "Stop", "Hey Bond", ""] {
            assert!(!super::unfinished(t), "{t}");
        }
    }

    use super::*;

    #[test]
    fn finds_the_wake_word_as_the_ears_hear_it() {
        assert_eq!(asr_wake("Hey bone, what time is it?").as_deref(), Some("what time is it?"));
        assert_eq!(asr_wake("Hey Bond.").as_deref(), Some(""));
        assert_eq!(asr_wake("hay bond open spotify").as_deref(), Some("open spotify"));
        assert_eq!(asr_wake("So, hey Bond, lock it.").as_deref(), Some("lock it."));
        assert_eq!(asr_wake("Heybond what's up").as_deref(), Some("what's up"));
        assert_eq!(asr_wake("James Bond is a spy"), None);
        assert_eq!(asr_wake("I bought a savings bond"), None);
        assert_eq!(asr_wake("Hey Bob, open the door"), None);
        assert_eq!(asr_wake("He won't come today"), None);
        // How the owner's "Hey Bond" comes through.
        assert_eq!(asr_wake("They bond.").as_deref(), Some(""));
        assert_eq!(asr_wake("Say bond, open Spotify.").as_deref(), Some("open Spotify."));
        assert_eq!(asr_wake("They won't.").as_deref(), Some(""));
        assert_eq!(asr_wake("They won't come today"), None);
        assert_eq!(asr_wake("They want pizza"), None);
        // Your own way of saying it, learned when you taught him your voice.
        let mine = vec!["they wand".to_string()];
        assert_eq!(asr_wake_with("They wand, lock it.", &mine).as_deref(), Some("lock it."));
    }

    #[test]
    fn strips_the_wake_word() {
        assert_eq!(strip_wake_word("Hey Bond, open Spotify."), "open Spotify.");
        assert_eq!(strip_wake_word("bond what time is it"), "what time is it");
        assert_eq!(strip_wake_word("Open Spotify"), "Open Spotify");
        assert_eq!(strip_wake_word("so. Hey, Bond. Open Spotify."), "Open Spotify.");
        assert_eq!(strip_wake_word("Hey Bonds"), "Hey Bonds");
        // A "bond" later in the request stays.
        assert_eq!(strip_wake_word("Hey Bond, what is a government bond?"), "what is a government bond?");
        assert_eq!(strip_wake_word("I bought a savings bond today"), "I bought a savings bond today");
    }

    #[test]
    fn voiceprint_threshold_follows_your_samples() {
        let mut a = vec![1.0, 0.1, 0.0];
        let mut b = vec![1.0, -0.1, 0.05];
        let mut c = vec![0.95, 0.0, -0.1];
        for v in [&mut a, &mut b, &mut c] {
            normalize(v);
        }
        let p = Voiceprint::from_samples(vec![a.clone(), b, c]);
        assert!(p.aliases.is_empty());
        assert!(p.score(&a) > p.threshold);
        assert!(p.score(&[0.0, 1.0, 0.0]) < p.threshold);
        assert!((0.45..=0.7).contains(&p.threshold));
    }

    /// Feeds audio the way the live loop does (40 ms chunks); the sample index where the
    /// wake word fired, if it did.
    fn stream_detect(kws: &sherpa_onnx::KeywordSpotter, audio: &[f32]) -> Option<usize> {
        stream_detect_stamps(kws, audio).map(|(at, _)| at)
    }

    /// Like `stream_detect`, with the wake word's token times.
    fn stream_detect_stamps(kws: &sherpa_onnx::KeywordSpotter, audio: &[f32]) -> Option<(usize, Vec<f32>)> {
        let s = kws.create_stream();
        let chunk = ASR_RATE as usize / 25;
        let padded: Vec<f32> = audio.iter().copied().chain(std::iter::repeat_n(0.0, ASR_RATE as usize)).collect();
        for (i, c) in padded.chunks(chunk).enumerate() {
            s.accept_waveform(ASR_RATE as i32, c);
            while kws.is_ready(&s) {
                kws.decode(&s);
                if let Some(r) = kws.get_result(&s).filter(|r| !r.keyword.is_empty()) {
                    return Some(((i + 1) * chunk, r.timestamps));
                }
            }
        }
        None
    }

    fn installed_dir() -> PathBuf {
        PathBuf::from(std::env::var("LOCALAPPDATA").unwrap()).join("com.selfglance.app").join("voice")
    }

    /// Kokoro's English voices stand in for different people:
    /// cargo test --lib wake::tests::accuracy -- --ignored --nocapture
    #[test]
    #[ignore]
    fn accuracy() {
        voice::use_dir(installed_dir());
        let say = |text: &str, sid: i32, speed: f32| {
            let (x, rate) = voice::synthesize(text, sid, speed).unwrap();
            voice::resample(&x, rate, ASR_RATE)
        };
        let kws = spotter().unwrap();
        let voices = [(2, "af_bella"), (9, "af_sarah"), (11, "am_adam"), (16, "am_michael"), (18, "am_puck"), (21, "bf_emma"), (24, "bm_daniel"), (26, "bm_george")];

        let wakes = ["Hey Bond, open Spotify.", "Hey Bond.", "Hey Bond, what time is it?"];
        let others = ["Hey Bob, open the door.", "James Bond is a famous spy.", "I bought a government bond last year.", "Hey, can you pass me the salt?", "Hey Siri, set a timer.", "Beyond the hills there is a pond.", "They found the bond between them."];
        let (mut hit, mut miss, mut false_wake) = (0, 0, 0);
        for (sid, name) in voices {
            for w in wakes {
                if stream_detect(&kws, &say(w, sid, 1.0)).is_some() { hit += 1 } else { miss += 1; println!("  missed  {name}: {w}") }
            }
            for o in others {
                if stream_detect(&kws, &say(o, sid, 1.0)).is_some() { false_wake += 1; println!("  FALSE   {name}: {o}") }
            }
        }
        println!("wake word: caught {hit}/{}, false wakes {false_wake}/{}", hit + miss, voices.len() * others.len());

        // Voice match as the live loop does it: enrol on the lines Settings asks you to read,
        // then check whole requests (from 1.6 s before the wake word fired to the end).
        let request_clip = |audio: &[f32]| -> Option<Vec<f32>> {
            let at = stream_detect(&kws, audio)?;
            Some(trim_silence(&audio[at.saturating_sub(WAKE_AUDIO).min(audio.len())..]))
        };
        let (mut you_ok, mut you_all, mut others_in, mut others_all) = (0, 0, 0, 0);
        for (me, me_name) in voices {
            let print = Voiceprint::from_samples(ENROL_LINES.iter().map(|t| embed(&trim_silence(&say(t, me, 1.0))).unwrap()).collect());
            let mut row = Vec::new();
            for (sid, name) in voices {
                for t in ["Hey Bond, turn the volume down a bit.", "Hey Bond, what time is it in London?"] {
                    let Some(clip) = request_clip(&say(t, sid, 1.05)) else { continue };
                    let s = print.score(&embed(&clip).unwrap());
                    let accepted = s >= print.threshold;
                    if sid == me { you_all += 1; you_ok += accepted as i32 } else { others_all += 1; others_in += accepted as i32 }
                    if accepted && sid != me { row.push(format!("{name} {s:.2}")) }
                    if !accepted && sid == me { row.push(format!("REJECTED self {s:.2}")) }
                }
            }
            println!("enrolled {me_name:<11} bar {:.2}  {}", print.threshold, row.join(", "));
        }
        println!("voice match: accepted you {you_ok}/{you_all}, accepted someone else {others_in}/{others_all}");
    }

    /// Which settings and model to ship. Needs the CAM++ and WeSpeaker models downloaded into
    /// voice/speaker next to TitaNet (only TitaNet ships):
    /// cargo test --lib wake::tests::compare -- --ignored --nocapture
    #[test]
    #[ignore]
    fn compare() {
        use std::collections::HashMap;
        voice::use_dir(installed_dir());
        let mut cache: HashMap<(String, i32), Vec<f32>> = HashMap::new();
        let mut say = |text: &str, sid: i32| {
            cache
                .entry((text.to_string(), sid))
                .or_insert_with(|| {
                    let (x, rate) = voice::synthesize(text, sid, 1.0).unwrap();
                    voice::resample(&x, rate, ASR_RATE)
                })
                .clone()
        };
        let voices = [(2, "af_bella"), (9, "af_sarah"), (11, "am_adam"), (16, "am_michael"), (18, "am_puck"), (21, "bf_emma"), (24, "bm_daniel"), (26, "bm_george")];
        let wakes = ["Hey Bond, open Spotify.", "Hey Bond.", "Hey Bond, what time is it?"];
        let others = ["Hey Bob, open the door.", "James Bond is a famous spy.", "I bought a government bond last year.", "Hey, can you pass me the salt?", "Hey Siri, set a timer.", "Beyond the hills there is a pond.", "They found the bond between them."];
        let enrol_lines = ["Hey Bond, this is my voice.", "The quick brown fox jumps over the lazy dog near the river bank.", "I usually start work at nine and take a short break around eleven.", "Hey Bond, remind me to call my mother this evening."];
        let tests = ["Hey Bond, open Spotify.", "Hey Bond, turn the volume down a bit.", "Hey Bond, what's on my calendar today?", "And what's the weather like tomorrow?"];

        // Wake word settings.
        let audio: Vec<(bool, Vec<f32>)> = voices
            .iter()
            .flat_map(|(sid, _)| wakes.iter().map(move |w| (true, *w, *sid)).chain(others.iter().map(move |o| (false, *o, *sid))))
            .map(|(is_wake, t, sid)| (is_wake, say(t, sid)))
            .collect();
        for kw in [
            "▁HE Y ▁BO ND :2.0 #0.25 @HEY_BOND",
            "▁HE Y ▁BO ND :2.0 #0.15 @HEY_BOND",
            "▁HE Y ▁BO ND :3.0 #0.10 @HEY_BOND",
            "▁HE Y ▁BO ND :3.5 #0.05 @HEY_BOND",
            "▁HE Y ▁BO ND :3.0 #0.10 @HEY_BOND
▁HE Y ▁B O ND :3.0 #0.10 @HEY_BOND
▁HI ▁BO ND :3.0 #0.10 @HEY_BOND",
        ] {
            let kws = spotter_for(kw).unwrap();
            let (mut hit, mut fa) = (0, 0);
            for (is_wake, a) in &audio {
                let fired = stream_detect(&kws, a).is_some();
                if *is_wake && fired { hit += 1 }
                if !*is_wake && fired { fa += 1 }
            }
            println!("{:<70} caught {hit:>2}/24  false {fa}/56", kw.replace('\n', " | "));
        }

        // Speaker models, on whole requests (wake word + command) against a longer enrolment.
        for model in ["3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx", "wespeaker_en_voxceleb_resnet34_LM.onnx", "nemo_en_titanet_small.onnx"] {
            let config = sherpa_onnx::SpeakerEmbeddingExtractorConfig { model: path_str(voice::dir().unwrap().join("speaker").join(model)), num_threads: 4, debug: false, provider: None };
            let x = sherpa_onnx::SpeakerEmbeddingExtractor::create(&config).unwrap();
            let t0 = Instant::now();
            let mut emb: HashMap<(i32, &str), Vec<f32>> = HashMap::new();
            for (sid, _) in voices {
                for t in enrol_lines.iter().chain(tests.iter()) {
                    let a = trim_silence(&say(t, sid));
                    emb.insert((sid, t), embed_with(&x, &a).unwrap());
                }
            }
            let per = t0.elapsed() / (voices.len() * (enrol_lines.len() + tests.len())) as u32;
            let (mut same, mut diff): (Vec<f32>, Vec<f32>) = (vec![], vec![]);
            for (me, _) in voices {
                let print = Voiceprint::from_samples(enrol_lines.iter().map(|t| emb[&(me, *t)].clone()).collect());
                for (sid, _) in voices {
                    for t in tests {
                        let sc = print.score(&emb[&(sid, t)]);
                        if sid == me { same.push(sc) } else { diff.push(sc) }
                    }
                }
            }
            let min_same = same.iter().cloned().fold(f32::MAX, f32::min);
            let max_diff = diff.iter().cloned().fold(f32::MIN, f32::max);
            // Best single threshold: fewest mistakes on both sides.
            let (mut best_t, mut best_err) = (0.0, usize::MAX);
            for i in 0..100 {
                let th = i as f32 / 100.0;
                let err = same.iter().filter(|s| **s < th).count() + diff.iter().filter(|s| **s >= th).count();
                if err < best_err { best_err = err; best_t = th }
            }
            let fr = same.iter().filter(|s| **s < best_t).count();
            let fa = diff.iter().filter(|s| **s >= best_t).count();
            println!("{model:<52} same≥{min_same:.2} other≤{max_diff:.2}  at {best_t:.2}: rejects you {fr}/{}, accepts others {fa}/{}  ({per:?} per clip)", same.len(), diff.len());
        }
    }

    /// The real listening loop on synthetic speech, fed like the microphone does (40 ms):
    /// cargo test --lib wake::tests::pipeline -- --ignored --nocapture
    #[test]
    #[ignore]
    fn pipeline() {
        voice::use_dir(installed_dir());
        let say = |text: &str, sid: i32| {
            let (x, rate) = voice::synthesize(text, sid, 1.0).unwrap();
            voice::resample(&x, rate, ASR_RATE)
        };
        // A quiet room: faint deterministic noise.
        let room = |secs: f32| -> Vec<f32> { (0..(secs * ASR_RATE as f32) as usize).map(|i| (((i * 7919) % 1000) as f32 / 1000.0 - 0.5) * 0.003).collect() };
        let run = |audio: Vec<f32>, follow_open: bool| -> Vec<String> {
            let mut l = Listener::new().unwrap();
            let mut out = Vec::new();
            for c in audio.chunks(ASR_RATE as usize / 25) {
                for e in l.push(c, follow_open).unwrap() {
                    out.push(e.describe());
                }
            }
            out
        };
        let me = 16;
        *PRINT.lock().unwrap() = Some(Voiceprint::from_samples(ENROL_LINES.iter().map(|t| embed(&trim_silence(&say(t, me))).unwrap()).collect()));
        VOICE_MATCH.store(true, Ordering::SeqCst);
        let cat = |parts: Vec<Vec<f32>>| parts.concat();
        for (sid, who) in [(me, "me (am_michael)"), (2, "af_bella"), (24, "bm_daniel"), (26, "bm_george")] {
            println!("{who}:");
            println!("  one breath  {:?}", run(cat(vec![room(1.5), say("Hey Bond, open Spotify.", sid), room(2.0)]), false));
            println!("  pause       {:?}", run(cat(vec![room(1.5), say("Hey Bond.", sid), room(1.0), say("What time is it in London?", sid), room(2.0)]), false));
            println!("  follow-up   {:?}", run(cat(vec![room(1.0), say("And turn the volume down a bit.", sid), room(2.0)]), true));
        }
        println!("me:\n  nothing     {:?}", run(cat(vec![room(1.5), say("Hey Bond.", me), room(7.0)]), false));
        println!("  no wake     {:?}", run(cat(vec![room(1.5), say("James Bond is my favourite spy.", me), room(2.0)]), false));

        // What always-on listening costs: CPU time per second of audio while waiting.
        let talk: Vec<f32> = (0..6).flat_map(|i| say("They talked about the weather, the news and what to cook for dinner tonight.", [2, 11, 21][i % 3])).collect();
        let mut l = Listener::new().unwrap();
        let t0 = Instant::now();
        for c in talk.chunks(ASR_RATE as usize / 25) {
            l.push(c, false).unwrap();
        }
        let secs = talk.len() as f64 / ASR_RATE as f64;
        println!("waiting: {:.1} ms of work per second of audio ({:.1}% of one core), over {secs:.0} s of speech", t0.elapsed().as_secs_f64() * 1000.0 / secs, t0.elapsed().as_secs_f64() / secs * 100.0);
    }

    /// The real microphone, the real listener: plays "Hey Bond…" through the speakers and
    /// prints the sound level and what the listener makes of it.
    /// cargo test --lib wake::tests::live_mic -- --ignored --nocapture
    #[test]
    #[ignore]
    fn live_mic() {
        use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
        voice::use_dir(installed_dir());
        // Your voiceprint, so the scores are the ones the app would see.
        let print_path = PathBuf::from(std::env::var("APPDATA").unwrap()).join("com.selfglance.app").join("voiceprint.json");
        let print: Option<Voiceprint> = std::fs::read_to_string(&print_path).ok().and_then(|s| serde_json::from_str(&s).ok());
        println!("voiceprint: {}", print.as_ref().map(|p| format!("bar {:.2}", p.threshold)).unwrap_or("none".into()));
        *PRINT.lock().unwrap() = print;
        VOICE_MATCH.store(true, Ordering::SeqCst);

        let host = cpal::default_host();
        let device = host.default_input_device().unwrap();
        let supported = device.default_input_config().unwrap();
        println!("microphone: {:?}, {} Hz, {} channels, {:?}", device.description().map(|d| d.name().to_string()).unwrap_or_default(), supported.sample_rate(), supported.channels(), supported.sample_format());
        let (rate, channels) = (supported.sample_rate(), supported.channels() as usize);
        let buf: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = buf.clone();
        let push = move |mono: Vec<f32>| sink.lock().unwrap().extend(mono);
        let stream = match supported.sample_format() {
            cpal::SampleFormat::F32 => device.build_input_stream(supported.config(), move |d: &[f32], _: &_| push(voice::downmix(d, channels, |s| s)), |e| eprintln!("{e}"), None),
            cpal::SampleFormat::I16 => device.build_input_stream(supported.config(), move |d: &[i16], _: &_| push(voice::downmix(d, channels, |s| s as f32 / 32768.0)), |e| eprintln!("{e}"), None),
            f => panic!("{f:?}"),
        }
        .unwrap();
        stream.play().unwrap();

        // Bond's voice says it through the speakers, as a person in the room would.
        let dir = std::env::temp_dir();
        let lines = ["Hey Bond, what time is it?", "Hey Bond.", "Hey Bond, open Notepad."];
        for (i, t) in lines.iter().enumerate() {
            let (x, r) = voice::synthesize(t, 16, 1.0).unwrap();
            let pcm: Vec<u8> = x.iter().flat_map(|s| ((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes()).collect();
            std::fs::write(dir.join(format!("bond-live-{i}.wav")), crate::ai::wav(&pcm, r)).unwrap();
        }
        let wavs: Vec<PathBuf> = (0..lines.len()).map(|i| dir.join(format!("bond-live-{i}.wav"))).collect();
        // BOND_PLAY=1: Bond's voice plays them (echo cancellation may hide that); otherwise you talk.
        let play = std::env::var("BOND_PLAY").is_ok();
        std::thread::spawn(move || {
            for w in wavs.into_iter().filter(|_| play) {
                std::thread::sleep(Duration::from_secs(4));
                let _ = std::process::Command::new("powershell").args(["-NoProfile", "-c", &format!("(New-Object Media.SoundPlayer '{}').PlaySync()", w.display())]).status();
                std::thread::sleep(Duration::from_secs(5));
            }
        });

        let mut l = Listener::new().unwrap();
        let start = Instant::now();
        let mut level = (0.0f32, 0usize);
        println!("Listening for 40 s: say “Hey Bond, what time is it?” a few times, with pauses.");
        while start.elapsed() < Duration::from_secs(40) {
            std::thread::sleep(Duration::from_millis(40));
            let raw = std::mem::take(&mut *buf.lock().unwrap());
            if raw.is_empty() {
                continue;
            }
            let chunk = voice::resample(&raw, rate, ASR_RATE);
            let peak = chunk.iter().fold(0.0f32, |m, s| m.max(s.abs()));
            level = (level.0.max(peak), level.1 + chunk.len());
            if level.1 >= ASR_RATE as usize {
                println!("{:>5.1}s  loudest {:.3}", start.elapsed().as_secs_f32(), level.0);
                level = (0.0, 0);
            }
            for e in l.push(&chunk, false).unwrap() {
                println!("        → {}", e.describe());
            }
        }
        drop(stream);
    }

    /// Each microphone channel on its own, while Bond's voice plays through the speakers:
    /// cargo test --lib wake::tests::mic_channels -- --ignored --nocapture
    #[test]
    #[ignore]
    fn mic_channels() {
        use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
        voice::use_dir(installed_dir());
        let device = cpal::default_host().default_input_device().unwrap();
        let supported = device.default_input_config().unwrap();
        let channels = supported.channels() as usize;
        let raw: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = raw.clone();
        let stream = device.build_input_stream(supported.config(), move |d: &[f32], _: &_| sink.lock().unwrap().extend_from_slice(d), |e| eprintln!("{e}"), None).unwrap();
        stream.play().unwrap();
        let (x, r) = voice::synthesize("Hey Bond, what time is it? I am testing the microphone now.", 16, 1.0).unwrap();
        let pcm: Vec<u8> = x.iter().flat_map(|s| ((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes()).collect();
        let w = std::env::temp_dir().join("bond-mic-test.wav");
        std::fs::write(&w, crate::ai::wav(&pcm, r)).unwrap();
        std::thread::sleep(Duration::from_millis(800));
        let _ = std::process::Command::new("powershell").args(["-NoProfile", "-c", &format!("(New-Object Media.SoundPlayer '{}').PlaySync()", w.display())]).status();
        std::thread::sleep(Duration::from_millis(500));
        drop(stream);
        let data = raw.lock().unwrap().clone();
        let frames: Vec<&[f32]> = data.chunks(channels).collect();
        let peak = |f: &dyn Fn(&[f32]) -> f32| frames.iter().map(|c| f(c).abs()).fold(0.0f32, f32::max);
        let rms = |f: &dyn Fn(&[f32]) -> f32| (frames.iter().map(|c| f(c).powi(2)).sum::<f32>() / frames.len() as f32).sqrt();
        for ch in 0..channels {
            println!("channel {ch}: peak {:.4}  rms {:.5}", peak(&|c| c[ch]), rms(&|c| c[ch]));
        }
        if channels == 2 {
            println!("average (L+R)/2: peak {:.4}  rms {:.5}", peak(&|c| (c[0] + c[1]) / 2.0), rms(&|c| (c[0] + c[1]) / 2.0));
            println!("difference (L-R)/2: peak {:.4}  rms {:.5}", peak(&|c| (c[0] - c[1]) / 2.0), rms(&|c| (c[0] - c[1]) / 2.0));
        }
    }

    /// Several wake word settings side by side on the live microphone, for tuning on a real
    /// voice: cargo test --lib wake::tests::kws_tune -- --ignored --nocapture
    #[test]
    #[ignore]
    fn kws_tune() {
        use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
        voice::use_dir(installed_dir());
        let configs = [
            ("A now", "▁HE Y ▁BO ND :3.0 #0.10 @HEY_BOND".to_string()),
            ("B sensitive", "▁HE Y ▁BO ND :4.0 #0.03 @HEY_BOND".to_string()),
            ("C accents", ["▁HE Y ▁BO ND", "▁HA Y ▁BO ND", "▁HE Y ▁BO N", "▁HI ▁BO ND"].iter().map(|t| format!("{t} :3.0 #0.10 @HEY_BOND")).collect::<Vec<_>>().join("\n")),
            ("D accents+", ["▁HE Y ▁BO ND", "▁HA Y ▁BO ND", "▁HE Y ▁BO N", "▁HI ▁BO ND"].iter().map(|t| format!("{t} :4.0 #0.03 @HEY_BOND")).collect::<Vec<_>>().join("\n")),
        ];
        let spotters: Vec<(&str, sherpa_onnx::KeywordSpotter)> = configs.iter().map(|(n, k)| (*n, spotter_for(k).unwrap())).collect();
        let mut streams: Vec<sherpa_onnx::OnlineStream> = spotters.iter().map(|(_, k)| k.create_stream()).collect();
        let device = cpal::default_host().default_input_device().unwrap();
        let supported = device.default_input_config().unwrap();
        let (rate, channels) = (supported.sample_rate(), supported.channels() as usize);
        let buf: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = buf.clone();
        let stream = device.build_input_stream(supported.config(), move |d: &[f32], _: &_| sink.lock().unwrap().extend(voice::downmix(d, channels, |s| s)), |e| eprintln!("{e}"), None).unwrap();
        stream.play().unwrap();
        let start = Instant::now();
        let mut fired: Vec<Vec<f32>> = vec![Vec::new(); spotters.len()];
        let mut said_half = false;
        println!("0-30 s: say “Hey Bond” (alone or with a request) 5-6 times, a few seconds apart.");
        while start.elapsed() < Duration::from_secs(60) {
            std::thread::sleep(Duration::from_millis(40));
            if !said_half && start.elapsed() > Duration::from_secs(30) {
                said_half = true;
                println!("30-60 s: now say other things: “James Bond”, “hey Bob”, “a savings bond”, normal sentences.");
            }
            let raw = std::mem::take(&mut *buf.lock().unwrap());
            if raw.is_empty() {
                continue;
            }
            let chunk = voice::resample(&raw, rate, ASR_RATE);
            for (i, (name, kws)) in spotters.iter().enumerate() {
                streams[i].accept_waveform(ASR_RATE as i32, &chunk);
                let mut hit = false;
                while kws.is_ready(&streams[i]) {
                    kws.decode(&streams[i]);
                    hit |= kws.get_result(&streams[i]).is_some_and(|r| !r.keyword.is_empty());
                }
                if hit {
                    let t = start.elapsed().as_secs_f32();
                    println!("  {t:>5.1}s  {name}");
                    fired[i].push(t);
                    streams[i] = kws.create_stream();
                }
            }
        }
        drop(stream);
        println!("\nwoke in the first 30 s (you said Hey Bond) / in the last 30 s (look-alikes):");
        for (i, (name, _)) in spotters.iter().enumerate() {
            println!("  {name:<12} {} / {}", fired[i].iter().filter(|t| **t < 30.0).count(), fired[i].iter().filter(|t| **t >= 30.0).count());
        }
    }

    /// The ears (Parakeet) as the wake word: every stretch of speech is transcribed and
    /// checked for "hey bond". cargo test --lib wake::tests::asr_tune -- --ignored --nocapture
    #[test]
    #[ignore]
    fn asr_tune() {
        use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
        voice::use_dir(installed_dir());
        let device = cpal::default_host().default_input_device().unwrap();
        let supported = device.default_input_config().unwrap();
        let (rate, channels) = (supported.sample_rate(), supported.channels() as usize);
        let buf: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = buf.clone();
        let stream = device.build_input_stream(supported.config(), move |d: &[f32], _: &_| sink.lock().unwrap().extend(voice::downmix(d, channels, |s| s)), |e| eprintln!("{e}"), None).unwrap();
        let _ = voice::transcribe(&vec![0.0; 16_000], ASR_RATE); // load the ears first
        stream.play().unwrap();
        let start = Instant::now();
        let mut ring: VecDeque<f32> = VecDeque::new();
        let mut seg: Option<(Vec<f32>, Endpoint, Duration)> = None;
        let mut t = Duration::ZERO;
        let mut said_half = false;
        let mut work = Duration::ZERO;
        // BOND_SAVE=<folder>: keep the whole minute and each stretch as WAVs, for tuning offline.
        let save = std::env::var("BOND_SAVE").ok().map(PathBuf::from);
        let mut all: Vec<f32> = Vec::new();
        let mut n = 0;
        let to_wav = |a: &[f32]| crate::ai::wav(&a.iter().flat_map(|s| ((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes()).collect::<Vec<u8>>(), ASR_RATE);
        println!("0-30 s: say “Hey Bond” (alone or with a request) 5-6 times, a few seconds apart.");
        while start.elapsed() < Duration::from_secs(60) {
            std::thread::sleep(Duration::from_millis(40));
            if !said_half && start.elapsed() > Duration::from_secs(30) {
                said_half = true;
                println!("30-60 s: now say other things: “James Bond”, “hey Bob”, “a savings bond”, normal sentences.");
            }
            let raw = std::mem::take(&mut *buf.lock().unwrap());
            if raw.is_empty() {
                continue;
            }
            let chunk = voice::resample(&raw, rate, ASR_RATE);
            all.extend_from_slice(&chunk);
            t += Duration::from_secs_f64(chunk.len() as f64 / ASR_RATE as f64);
            ring.extend(chunk.iter().copied());
            while ring.len() > RING {
                ring.pop_front();
            }
            match &mut seg {
                None => {
                    let floor = noise_floor(ring.make_contiguous());
                    let mut e = Endpoint::with_floor(floor);
                    e.feed(&chunk, Duration::from_millis(40));
                    if e.speaking() {
                        let lead: Vec<f32> = ring.iter().skip(ring.len().saturating_sub(ASR_RATE as usize * 3 / 10)).copied().collect();
                        seg = Some((lead, Endpoint::with_floor(floor), t));
                    }
                }
                Some((audio, talk, since)) => {
                    audio.extend_from_slice(&chunk);
                    // A short pause ends a stretch (0.5 s), so "hey bond … open spotify" can be one or two.
                    let ended = talk.feed(&chunk, t - *since) || talk.quiet_for(t - *since) >= Duration::from_millis(500) || audio.len() > ASR_RATE as usize * 8;
                    if ended {
                        let a = std::mem::take(audio);
                        seg = None;
                        let t0 = Instant::now();
                        let text = voice::transcribe(&a, ASR_RATE).unwrap();
                        work += t0.elapsed();
                        println!("  {:>5.1}s  {:.1}s of speech → “{text}”  {}", start.elapsed().as_secs_f32(), a.len() as f32 / ASR_RATE as f32, if asr_wake(&text).is_some() { "WAKE" } else { "" });
                        if let Some(dir) = &save {
                            n += 1;
                            let half = if said_half { "other" } else { "wake" };
                            let _ = std::fs::write(dir.join(format!("{n:02}-{half}.wav")), to_wav(&a));
                        }
                    }
                }
            }
        }
        drop(stream);
        if let Some(dir) = &save {
            let _ = std::fs::write(dir.join("all.wav"), to_wav(&all));
            println!("saved {n} clips and the whole minute in {}", dir.display());
        }
        println!("transcribing took {:.1} s of CPU over the minute", work.as_secs_f32());
    }

    /// Can the ears be nudged toward "hey bond"? cargo test --lib wake::tests::hotwords -- --ignored --nocapture
    #[test]
    #[ignore]
    fn hotwords() {
        voice::use_dir(installed_dir());
        let d = voice::dir().unwrap().join("sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8");
        let hw = std::env::temp_dir().join("bond-hotwords.txt");
        std::fs::write(&hw, "▁he y ▁bo nd :2.5\n").unwrap();
        let make = |hot: bool| {
            let mut c = sherpa_onnx::OfflineRecognizerConfig::default();
            c.model_config.transducer.encoder = path_str(d.join("encoder.int8.onnx"));
            c.model_config.transducer.decoder = path_str(d.join("decoder.int8.onnx"));
            c.model_config.transducer.joiner = path_str(d.join("joiner.int8.onnx"));
            c.model_config.tokens = path_str(d.join("tokens.txt"));
            c.model_config.model_type = Some("nemo_transducer".into());
            c.model_config.num_threads = 4;
            if hot {
                c.decoding_method = Some("modified_beam_search".into());
                c.max_active_paths = 4;
                c.hotwords_file = path_str(hw.clone());
                c.hotwords_score = 2.5;
            }
            sherpa_onnx::OfflineRecognizer::create(&c)
        };
        let plain = make(false).unwrap();
        let Some(hot) = make(true) else { return println!("hotwords: the recognizer can't be created with them") };
        let say = |text: &str, sid: i32| {
            let (x, rate) = voice::synthesize(text, sid, 1.0).unwrap();
            voice::resample(&x, rate, ASR_RATE)
        };
        let run = |r: &sherpa_onnx::OfflineRecognizer, a: &[f32]| {
            let s = r.create_stream();
            s.accept_waveform(ASR_RATE as i32, a);
            r.decode(&s);
            s.get_result().map(|x| x.text).unwrap_or_default()
        };
        for (t, sid) in [("Hey Bond, open Spotify.", 16), ("Hey Bond.", 2), ("He won't come today.", 16), ("Hey Bob, open the door.", 26), ("James Bond is a spy.", 24)] {
            let a = say(t, sid);
            let t0 = Instant::now();
            let h = run(&hot, &a);
            let th = t0.elapsed();
            println!("{t:<26} plain “{}”  hot “{h}” ({th:?})", run(&plain, &a));
        }
    }

    /// Wake word settings tried on saved clips of a real voice (BOND_CLIPS=<folder> with
    /// NN-wake.wav / NN-other.wav and all.wav from asr_tune):
    /// cargo test --lib wake::tests::clips -- --ignored --nocapture
    #[test]
    #[ignore]
    fn clips() {
        voice::use_dir(installed_dir());
        let dir = PathBuf::from(std::env::var("BOND_CLIPS").expect("BOND_CLIPS"));
        let d = voice::dir().unwrap().join("sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8");
        let recognizer = |hot: Option<(&str, f32)>| {
            let mut c = sherpa_onnx::OfflineRecognizerConfig::default();
            c.model_config.transducer.encoder = path_str(d.join("encoder.int8.onnx"));
            c.model_config.transducer.decoder = path_str(d.join("decoder.int8.onnx"));
            c.model_config.transducer.joiner = path_str(d.join("joiner.int8.onnx"));
            c.model_config.tokens = path_str(d.join("tokens.txt"));
            c.model_config.model_type = Some("nemo_transducer".into());
            c.model_config.num_threads = 4;
            if let Some((words, score)) = hot {
                let f = std::env::temp_dir().join(format!("bond-hot-{score}.txt"));
                std::fs::write(&f, words).unwrap();
                c.decoding_method = Some("modified_beam_search".into());
                c.max_active_paths = 4;
                c.hotwords_file = path_str(f);
                c.hotwords_score = score;
            }
            sherpa_onnx::OfflineRecognizer::create(&c).unwrap()
        };
        let hot = "▁he y ▁bo nd\n";
        let rs = [("plain", recognizer(None)), ("hot 2", recognizer(Some((hot, 2.0)))), ("hot 4", recognizer(Some((hot, 4.0)))), ("hot 6", recognizer(Some((hot, 6.0))))];
        let mut files: Vec<PathBuf> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.path()).filter(|p| p.file_name().is_some_and(|n| n.to_string_lossy().contains('-'))).collect();
        files.sort();
        let mut wakes = vec![(0, 0); rs.len()];
        for f in &files {
            let w = sherpa_onnx::Wave::read(&f.to_string_lossy()).unwrap();
            let is_wake = f.to_string_lossy().contains("wake");
            let heard: Vec<String> = rs
                .iter()
                .enumerate()
                .map(|(i, (name, r))| {
                    let s = r.create_stream();
                    s.accept_waveform(w.sample_rate(), w.samples());
                    r.decode(&s);
                    let text = s.get_result().map(|x| x.text).unwrap_or_default();
                    let woke = asr_wake(&text).is_some();
                    if woke {
                        if is_wake { wakes[i].0 += 1 } else { wakes[i].1 += 1 }
                    }
                    format!("{name}: “{text}”{}", if woke { " ✓" } else { "" })
                })
                .collect();
            println!("{}  {}", f.file_name().unwrap().to_string_lossy(), heard.join("  "));
        }
        println!("\nwoke on wake clips / on other clips:");
        for (i, (name, _)) in rs.iter().enumerate() {
            println!("  {name:<6} {} / {}", wakes[i].0, wakes[i].1);
        }
    }

    /// The real listener on a saved minute of a real voice (BOND_CLIPS/all.wav: "Hey Bond…"
    /// for 30 s, then look-alikes), with your voiceprint, as the app runs it:
    /// cargo test --lib wake::tests::clips_listener -- --ignored --nocapture
    #[test]
    #[ignore]
    fn clips_listener() {
        voice::use_dir(installed_dir());
        let dir = PathBuf::from(std::env::var("BOND_CLIPS").expect("BOND_CLIPS"));
        let print_path = PathBuf::from(std::env::var("APPDATA").unwrap()).join("com.selfglance.app").join("voiceprint.json");
        let mut print: Option<Voiceprint> = std::fs::read_to_string(&print_path).ok().and_then(|s| serde_json::from_str(&s).ok());
        if let Some(p) = print.as_mut() {
            p.threshold = Voiceprint::bar(&p.samples, &p.centroid);
        }
        println!("voiceprint: {}", print.as_ref().map(|p| format!("{} samples, bar {:.2}", p.samples.len(), p.threshold)).unwrap_or("none".into()));
        *PRINT.lock().unwrap() = print;
        VOICE_MATCH.store(true, Ordering::SeqCst);
        let w = sherpa_onnx::Wave::read(&dir.join("all.wav").to_string_lossy()).unwrap();
        let mut l = Listener::new().unwrap();
        let mut t = 0usize;
        for c in w.samples().chunks(640) {
            t += c.len();
            for e in l.push(c, false).unwrap() {
                println!("  {:>5.1}s  {}", t as f32 / ASR_RATE as f32, e.describe());
            }
        }
    }

    #[test]
    fn noise_floor_ignores_speech() {
        let mut x: Vec<f32> = (0..32_000).map(|i| ((i * 7919) % 100) as f32 / 100.0 * 0.004 - 0.002).collect();
        x.extend((0..16_000).map(|i| (i as f32 * 0.05).sin() * 0.3));
        assert!(noise_floor(&x) < 0.01, "{}", noise_floor(&x));
        // Starting from that floor, speech right away counts as speech.
        let mut talk = Endpoint::with_floor(noise_floor(&x));
        talk.feed(&x[32_000..32_640], Duration::from_millis(40));
        assert!(talk.speaking());
    }

    #[test]
    fn learning_keeps_the_enrolment_and_the_newest_requests() {
        let unit = |v: Vec<f32>| {
            let mut v = v;
            normalize(&mut v);
            v
        };
        let enrol: Vec<Vec<f32>> = (0..5).map(|i| unit(vec![1.0, 0.05 * i as f32, 0.0])).collect();
        let mut p = Voiceprint::from_samples(enrol.clone());
        let before = p.threshold;
        // A confirmed request a bit unlike the enrolment widens what counts as you.
        let unlike = unit(vec![0.8, 0.0, 0.6]);
        let score_before = p.score(&unlike);
        p.learn(unlike.clone(), 5);
        assert!(p.score(&unlike) > score_before);
        assert!(p.threshold <= before);
        for i in 0..20 {
            p.learn(unit(vec![1.0, 0.0, 0.01 * i as f32]), 5);
        }
        assert_eq!(p.samples.len(), 5 + MAX_LEARNED);
        assert_eq!(&p.samples[..5], &enrol[..], "the lines you read stay");
    }

    #[test]
    fn trims_to_the_sound() {
        let mut x = vec![0.0; 16_000];
        x.extend((0..8_000).map(|i| (i as f32 * 0.05).sin() * 0.3));
        x.extend(vec![0.0; 16_000]);
        let t = trim_silence(&x);
        assert!(t.len() > 8_000 && t.len() < 8_000 + 2 * 3_200 + 640, "{}", t.len());
    }
}
