// "Hey Bond": talk to him without a hotkey, and only he answers you (like Siri).
//
//   Wake word  A small streaming keyword spotter (sherpa-onnx, zipformer, 3.3M parameters)
//              listens for "hey bond". It runs on one CPU thread; nothing is recorded or
//              kept, only the last few seconds in memory.
//   Voice match  Once, you read a few short "Hey Bond, ..." lines (enrolment). After that a
//              speaker model (NVIDIA TitaNet-small) checks every request, wake word and command
//              together, against your voiceprint, so other people, videos and calls are
//              ignored. Whole requests, not the 1-second wake word alone: on short clips no
//              model told voices apart (wake::tests::compare). On whole requests TitaNet
//              separated 8 voices perfectly (you >= 0.88, others <= 0.70), 80 ms per check.
//   After it   What you say next (in the same breath or after a pause) is captured until you
//              stop, transcribed by the same ears as push-to-talk, and sent as `voice-heard`.
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

/// "hey bond" in the model's word pieces. `:` boosts the phrase, `#` is how sure the
/// spotter must be (lower wakes more easily). Over 8 voices this caught 22/24 "hey bond"s
/// and 0/56 look-alikes ("James Bond", "hey Bob", "a government bond"...); the default
/// (#0.25) caught only 16/24 (wake::tests::compare).
const KEYWORDS: &str = "▁HE Y ▁BO ND :3.0 #0.10 @HEY_BOND";

/// Audio kept in memory, so the wake word itself can be checked against your voice.
const RING: usize = ASR_RATE as usize * 3;
/// The stretch of audio checked for your voice when the wake word is heard.
const WAKE_AUDIO: usize = ASR_RATE as usize * 16 / 10;
/// Longest request after the wake word.
const MAX_REQUEST: Duration = Duration::from_secs(15);
/// Voice match is looser on a follow-up (longer, different words than the enrolment).
const FOLLOW_UP_SLACK: f32 = 0.85;
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
        crate::brain::download(&app, &http, &format!("{}/{KWS_ARCHIVE}", voice::RELEASES), &file, "the wake word").await?;
        let (f, target) = (file.clone(), dir.clone());
        tauri::async_runtime::spawn_blocking(move || voice::untar(&f, &target)).await.map_err(|e| e.to_string())??;
        let _ = std::fs::remove_file(&file);
    }
    if !speaker_path()?.exists() {
        crate::brain::download(&app, &http, &format!("{}/{SPEAKER_URL}", voice::RELEASES), &speaker_path()?, "voice match").await?;
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
        Voiceprint { centroid, samples, threshold }
    }

    /// Your least typical sample, less a margin: a request on another day, mood or mic
    /// scores lower than the enrolment itself. With 0.2 a real 0.57 from the owner was
    /// turned away (bar 0.58, 2026-10-10), so 0.25.
    fn bar(samples: &[Vec<f32>], centroid: &[f32]) -> f32 {
        let worst = samples.iter().map(|s| cosine(s, centroid)).fold(f32::MAX, f32::min);
        (worst - 0.25).clamp(0.45, 0.7)
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
        let heard = !audio.is_empty() && hears_wake_word(&audio)?;
        let mut list = ENROLLING.lock().unwrap();
        if heard {
            list.push(embed(&audio)?);
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
    if samples.len() < MIN_SAMPLES {
        return Err(format!("I need at least {MIN_SAMPLES} clear “Hey Bond”s."));
    }
    let print = Voiceprint::from_samples(samples);
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
fn is_you(audio: &[f32], slack: f32) -> Result<(bool, f32), String> {
    if !VOICE_MATCH.load(Ordering::SeqCst) {
        return Ok((true, 1.0));
    }
    let Some(print) = PRINT.lock().unwrap().clone() else { return Ok((true, 1.0)) };
    let score = print.score(&embed(audio)?);
    Ok((score >= print.threshold * slack, score))
}

enum Mode {
    /// Listening for "hey bond" (or a follow-up).
    Waiting,
    /// Taking down what you say after it.
    /// `wake` is the wake word itself (empty for a follow-up), checked with the rest.
    Request { started: Duration, talk: Endpoint, wake: Vec<f32>, audio: Vec<f32>, follow_up: bool },
}

/// What the listener made of the latest audio.
#[derive(Debug)]
pub enum Event {
    /// "Hey Bond": he's listening.
    Woke,
    /// You started a follow-up (no wake word needed).
    FollowUp,
    /// Not your voice: ignored.
    Rejected(f32),
    /// "Hey Bond" and then nothing.
    Empty,
    /// The window closed with nothing said, or the request was dropped.
    Idle,
    /// Your request (16 kHz), to transcribe.
    Request(Vec<f32>),
}

/// Microphone audio in (16 kHz chunks), events out. Kept apart from the microphone so it can
/// be tested on recorded speech.
pub struct Listener {
    kws: sherpa_onnx::KeywordSpotter,
    kstream: sherpa_onnx::OnlineStream,
    ring: VecDeque<f32>,
    mode: Mode,
    follow_talk: Option<(Endpoint, Duration)>,
    /// Audio time so far.
    t: Duration,
}

impl Listener {
    pub fn new() -> Result<Listener, String> {
        let kws = spotter()?;
        let kstream = kws.create_stream();
        Ok(Listener { kws, kstream, ring: VecDeque::with_capacity(RING), mode: Mode::Waiting, follow_talk: None, t: Duration::ZERO })
    }

    /// Start over (push-to-talk or enrolment took the microphone).
    pub fn pause(&mut self) {
        self.mode = Mode::Waiting;
        self.follow_talk = None;
    }

    /// Feed the next chunk; `follow_up_open` while a follow-up needs no wake word.
    pub fn push(&mut self, chunk: &[f32], follow_up_open: bool) -> Result<Vec<Event>, String> {
        self.t += Duration::from_secs_f64(chunk.len() as f64 / ASR_RATE as f64);
        self.ring.extend(chunk.iter().copied());
        while self.ring.len() > RING {
            self.ring.pop_front();
        }
        let now = self.t;
        match &mut self.mode {
            Mode::Waiting => {
                self.kstream.accept_waveform(ASR_RATE as i32, chunk);
                let mut woke: Option<Vec<f32>> = None;
                while self.kws.is_ready(&self.kstream) {
                    self.kws.decode(&self.kstream);
                    if let Some(r) = self.kws.get_result(&self.kstream).filter(|r| !r.keyword.is_empty()) {
                        woke = Some(r.timestamps);
                    }
                }
                if let Some(stamps) = woke {
                    self.kws.reset(&self.kstream);
                    self.kstream = self.kws.create_stream(); // a clean start, so one "hey bond" can't fire twice
                    self.follow_talk = None;
                    // Listen straight away; whose voice it is gets checked on the whole request.
                    let wake: Vec<f32> = self.ring.iter().skip(self.ring.len().saturating_sub(WAKE_AUDIO)).copied().collect();
                    // The room's noise from before the wake word: you may still be talking now.
                    let talk = Endpoint::with_floor(noise_floor(self.ring.make_contiguous()));
                    // What you said after "bond" so far (in one breath it fires only once you pause).
                    let ring = self.ring.make_contiguous();
                    let after: Vec<f32> = ring[keyword_end(ring, &stamps)..].to_vec();
                    self.mode = Mode::Request { started: now, talk, wake, audio: after, follow_up: false };
                    return Ok(vec![Event::Woke]);
                }
                // A follow-up: speech within the window, without the wake word.
                if !follow_up_open {
                    self.follow_talk = None;
                    return Ok(vec![]);
                }
                let floor = noise_floor(self.ring.make_contiguous());
                let (talk, since) = self.follow_talk.get_or_insert_with(|| (Endpoint::with_floor(floor), now));
                talk.feed(chunk, now - *since);
                if talk.speaking() {
                    // Start with the last half second, so the first word isn't cut.
                    let lead: Vec<f32> = self.ring.iter().skip(self.ring.len().saturating_sub(ASR_RATE as usize / 2)).copied().collect();
                    let (talk, _) = self.follow_talk.take().unwrap();
                    self.mode = Mode::Request { started: now, talk, wake: Vec::new(), audio: lead, follow_up: true };
                    return Ok(vec![Event::FollowUp]);
                }
                Ok(vec![])
            }
            Mode::Request { started, talk, wake, audio, follow_up } => {
                audio.extend_from_slice(chunk);
                let done = talk.feed(chunk, now - *started) || now - *started > MAX_REQUEST;
                if !done {
                    return Ok(vec![]);
                }
                let (wake, audio, follow_up, spoke) = (std::mem::take(wake), std::mem::take(audio), *follow_up, talk.spoke());
                self.mode = Mode::Waiting;
                if !spoke && follow_up {
                    return Ok(vec![Event::Idle]);
                }
                // Your voice? The wake word and what followed it, together.
                let said: Vec<f32> = wake.iter().chain(if spoke { audio.iter() } else { [].iter() }).copied().collect();
                let (you, score) = is_you(&trim_silence(&said), if follow_up { FOLLOW_UP_SLACK } else { 1.0 })?;
                remember_score(score, you);
                Ok(vec![match (you, spoke) {
                    (false, _) => Event::Rejected(score),
                    (true, false) => Event::Empty,
                    (true, true) => Event::Request(audio),
                }])
            }
        }
    }
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
        for event in listener.push(&chunk, open)? {
            match &event {
                Event::Request(a) => crate::diag::log(&format!("listener: request, {:.1} s of audio", a.len() as f32 / ASR_RATE as f32)),
                e => crate::diag::log(&format!("listener: {e:?}")),
            }
            match event {
                Event::Woke | Event::FollowUp => {
                    *FOLLOW_UNTIL.lock().unwrap() = None;
                    if matches!(event, Event::Woke) {
                        let _ = app.emit("wake", ());
                    }
                    let _ = app.emit("voice-state", "listening");
                }
                Event::Idle => {
                    let _ = app.emit("voice-state", "idle");
                }
                Event::Rejected(score) => {
                    let _ = app.emit("voice-state", "idle");
                    let _ = app.emit("wake-rejected", score);
                }
                Event::Empty => {
                    let _ = app.emit("voice-state", "idle");
                    let _ = app.emit("wake-empty", ()); // "hey bond" and then nothing: he asks "Yes?"
                }
                Event::Request(audio) => {
                    let _ = app.emit("voice-state", "thinking");
                    let text = voice::transcribe(&audio, ASR_RATE).map(|t| strip_wake_word(&t));
                    crate::diag::log(&format!("listener: heard {text:?}"));
                    let _ = app.emit("voice-state", "idle");
                    match text {
                        Ok(t) => {
                            let _ = app.emit("voice-heard", t);
                        }
                        Err(e) => {
                            let _ = app.emit("voice-error", e);
                        }
                    }
                }
            }
        }
    }
    drop(stream);
    Ok(())
}

/// Where "hey bond" ends in `ring` (which ends at the moment it fired). The spotter fires
/// right after "bond" when you pause, but in one breath ("hey bond open spotify") only at
/// the next pause, so the end is found from the other side: where your speech started,
/// plus how long the wake word took (its token times are relative, but their spacing is
/// right). Never later than 0.2 s before firing: with a pause, that's where the next word
/// may begin (0.2 s heard 10/10 test requests exactly, 0.3 s+ caught the end of "bond").
fn keyword_end(ring: &[f32], stamps: &[f32]) -> usize {
    let frame = ASR_RATE as usize / 50; // 20 ms
    let latest = ring.len().saturating_sub(ASR_RATE as usize / 5);
    let (Some(first), Some(last)) = (stamps.first(), stamps.last()) else { return latest };
    // "hey" starts a little before its first token, "bond" ends a little after its last.
    let spoken = ((last - first + 0.35).max(0.4) * ASR_RATE as f32) as usize;
    let rms: Vec<f32> = ring.chunks(frame).map(|c| (c.iter().map(|s| s * s).sum::<f32>() / c.len() as f32).sqrt()).collect();
    let floor = noise_floor(ring);
    let loud = |r: f32| r > (floor * 3.0).max(0.01);
    // Back from the end to the start of this stretch of speech (gaps under 300 ms are inside it).
    let (mut start, mut gap) = (rms.len(), 0);
    for i in (0..rms.len()).rev() {
        if loud(rms[i]) {
            start = i;
            gap = 0;
        } else {
            gap += 1;
            if gap > 15 && start < rms.len() {
                break;
            }
        }
    }
    if start == rms.len() {
        return latest;
    }
    (start * frame + spoken).min(latest)
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
    use super::*;

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
                    out.push(match e {
                        Event::Request(a) => format!("heard “{}”", strip_wake_word(&voice::transcribe(&a, ASR_RATE).unwrap())),
                        Event::Rejected(s) => format!("rejected {s:.2}"),
                        e => format!("{e:?}"),
                    });
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
                match e {
                    Event::Request(a) => println!("        → heard “{}”", strip_wake_word(&voice::transcribe(&a, ASR_RATE).unwrap())),
                    Event::Rejected(s) => println!("        → woke, but not your voice ({s:.2})"),
                    e => println!("        → {e:?}"),
                }
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

    /// What the spotter's timestamps mean: cargo test --lib wake::tests::timestamps -- --ignored --nocapture
    #[test]
    #[ignore]
    fn timestamps() {
        voice::use_dir(installed_dir());
        let kws = spotter().unwrap();
        for lead in [0.5f32, 2.0] {
            let (x, rate) = voice::synthesize("Hey Bond, open Spotify.", 16, 1.0).unwrap();
            let speech = voice::resample(&x, rate, ASR_RATE);
            let audio: Vec<f32> = std::iter::repeat_n(0.0, (lead * ASR_RATE as f32) as usize).chain(speech).chain(std::iter::repeat_n(0.0, ASR_RATE as usize)).collect();
            let s = kws.create_stream();
            let mut fed = 0;
            for c in audio.chunks(640) {
                s.accept_waveform(ASR_RATE as i32, c);
                fed += c.len();
                let mut hit = None;
                while kws.is_ready(&s) {
                    kws.decode(&s);
                    if let Some(r) = kws.get_result(&s).filter(|r| !r.keyword.is_empty()) {
                        hit = Some(r);
                    }
                }
                if let Some(r) = hit {
                    println!("lead {lead}s: fired at {:.2}s fed; start_time {:.2}; tokens {:?} at {:?}", fed as f32 / ASR_RATE as f32, r.start_time, r.tokens_arr, r.timestamps);
                    break;
                }
            }
        }
    }

    /// How much audio from just before the wake word fired to keep for the request, so the
    /// first word isn't lost and "bond" isn't heard: cargo test --lib wake::tests::lead_in -- --ignored --nocapture
    #[test]
    #[ignore]
    fn lead_in() {
        voice::use_dir(installed_dir());
        let kws = spotter().unwrap();
        let phrases = ["Hey Bond, open Spotify.", "Hey Bond open Spotify", "Hey Bond, turn the volume down.", "Hey Bond what time is it", "Hey Bond, lock my laptop."];
        for (sid, name) in [(16, "am_michael"), (2, "af_bella"), (26, "bm_george")] {
            for p in phrases {
                let (x, rate) = voice::synthesize(p, sid, 1.0).unwrap();
                let audio: Vec<f32> = std::iter::repeat_n(0.0, 8000).chain(voice::resample(&x, rate, ASR_RATE)).chain(std::iter::repeat_n(0.0, 8000)).collect();
                let padded: Vec<f32> = audio.iter().copied().chain(std::iter::repeat_n(0.0, ASR_RATE as usize)).collect();
                let Some((at, stamps)) = stream_detect_stamps(&kws, &audio) else { println!("{name}: missed {p}"); continue };
                let ring = &padded[at.saturating_sub(RING)..at];
                let cut = keyword_end(ring, &stamps);
                let heard = strip_wake_word(&voice::transcribe(&padded[at - ring.len() + cut..], ASR_RATE).unwrap());
                println!("{name:<10} {p:<34} fired {:.2}s after the start, cut at -{:.2}s: “{heard}”", at as f32 / ASR_RATE as f32, (ring.len() - cut) as f32 / ASR_RATE as f32);
            }
        }
    }

    /// cargo test --lib wake::tests::fire_time -- --ignored --nocapture
    #[test]
    #[ignore]
    fn fire_time() {
        voice::use_dir(installed_dir());
        VOICE_MATCH.store(false, Ordering::SeqCst);
        let (x, rate) = voice::synthesize("Hey Bond, open Spotify.", 16, 1.0).unwrap();
        let speech = voice::resample(&x, rate, ASR_RATE);
        println!("speech is {:.2}s long", speech.len() as f32 / ASR_RATE as f32);
        let room = |n: usize| -> Vec<f32> { (0..n).map(|i| (((i * 7919) % 1000) as f32 / 1000.0 - 0.5) * 0.003).collect() };
        for (label, before) in [("silence", vec![0.0; 24_000]), ("room noise", room(24_000))] {
            let audio: Vec<f32> = before.iter().copied().chain(speech.iter().copied()).chain(room(32_000)).collect();
            let mut l = Listener::new().unwrap();
            let mut fed = 0;
            for c in audio.chunks(640) {
                fed += c.len();
                for e in l.push(c, false).unwrap() {
                    match e {
                        Event::Woke => println!("{label}: fired {:.2}s into the speech; request starts with {:.2}s already said", (fed - before.len()) as f32 / ASR_RATE as f32, match &l.mode { Mode::Request { audio, .. } => audio.len() as f32 / ASR_RATE as f32, _ => 0.0 }),
                        Event::Request(a) => println!("{label}: request {:.2}s → “{}”", a.len() as f32 / ASR_RATE as f32, voice::transcribe(&a, ASR_RATE).unwrap()),
                        e => println!("{label}: {e:?}"),
                    }
                }
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
    fn trims_to_the_sound() {
        let mut x = vec![0.0; 16_000];
        x.extend((0..8_000).map(|i| (i as f32 * 0.05).sin() * 0.3));
        x.extend(vec![0.0; 16_000]);
        let t = trim_silence(&x);
        assert!(t.len() > 8_000 && t.len() < 8_000 + 2 * 3_200 + 640, "{}", t.len());
    }
}
