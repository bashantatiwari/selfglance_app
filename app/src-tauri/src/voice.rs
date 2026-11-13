// Bond's own voice and ears, on this laptop (sherpa-onnx, in-process, CPU):
//
//   Speaking   Kokoro v1.0 (82M parameters): natural voices, a sentence at a time so he
//              starts talking right away (the frontend asks for the next sentence while one
//              plays). Full precision on 8 threads: 5 s of speech in 1.3 s on an i5-13450HX;
//              the int8 model was slower than real time at any thread count (measured
//              2026-10-08, voice::tests::speak_speed).
//   Listening  Parakeet TDT 0.6B v2 (int8): 0.24 s to understand a request, no word errors
//              on Bond's own test sentences (voice::tests::bench).
//              Push-to-talk: hold Ctrl+Alt, speak, let go; or click the mic in the Ask box
//              and he stops by himself when you go quiet. The microphone is open only then.
//              What he hears goes through exactly the same path as typed requests.
//
// Models are downloaded once into <local app data>/voice. Nothing is sent anywhere.
// Loaded they take about 1 GB of RAM, so they're let go after a few quiet minutes and
// load again (about a second) the next time he speaks or listens.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

pub(crate) const RELEASES: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download";
const TTS_ARCHIVE: &str = "tts-models/kokoro-multi-lang-v1_0.tar.bz2";
const TTS_DIR: &str = "kokoro-multi-lang-v1_0";
const ASR_ARCHIVE: &str = "asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2";
const ASR_DIR: &str = "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8";
/// The archives' SHA-256, as GitHub publishes them for these releases (brain.rs `download` checks them).
const TTS_SHA: &str = "60703707bc05ccd48d60e1eb723f38b07d6e474795a0b6a588d7220400e0f7a4";
const ASR_SHA: &str = "6fc4426b54aa549a0019b8a75b8dea59164e71790a37ac56a045ad57f915f714";

const TTS_MODEL: &str = "model.onnx";
const TTS_THREADS: i32 = 8;

/// The recognizer's sample rate.
pub(crate) const ASR_RATE: u32 = 16_000;

/// Let the models go after this long without speaking or listening.
const IDLE_UNLOAD: Duration = Duration::from_secs(5 * 60);

static DIR: OnceLock<PathBuf> = OnceLock::new();
static LAST_USED: Mutex<Option<Instant>> = Mutex::new(None);

pub fn init(app: &AppHandle) {
    if let Ok(d) = app.path().app_local_data_dir() {
        let _ = DIR.set(d.join("voice"));
    }
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_secs(30));
        let idle = LAST_USED.lock().unwrap().is_some_and(|t| t.elapsed() > IDLE_UNLOAD);
        // "Hey Bond" uses the ears for every stretch of speech: they stay loaded meanwhile.
        if idle && !LISTENING.load(Ordering::SeqCst) && !crate::wake::active() {
            unload();
        }
    });
}

fn touch() {
    *LAST_USED.lock().unwrap() = Some(Instant::now());
}

/// Free the voice and ears models' memory now. True if anything was loaded.
pub fn unload() -> bool {
    WARM.store(false, Ordering::SeqCst);
    let tts = TTS.lock().unwrap().take().is_some();
    let asr = ASR.lock().unwrap().take().is_some();
    *LAST_USED.lock().unwrap() = None;
    tts || asr
}

#[cfg(test)]
pub fn use_dir(p: PathBuf) {
    let _ = DIR.set(p);
}

pub(crate) fn dir() -> Result<&'static Path, String> {
    DIR.get().map(|p| p.as_path()).ok_or_else(|| "The app data folder isn't available.".to_string())
}

fn tts_dir() -> Result<PathBuf, String> {
    Ok(dir()?.join(TTS_DIR))
}

fn asr_dir() -> Result<PathBuf, String> {
    Ok(dir()?.join(ASR_DIR))
}

fn path_str(p: PathBuf) -> Option<String> {
    Some(p.to_string_lossy().into_owned())
}

pub fn installed() -> bool {
    tts_dir().map(|d| d.join(TTS_MODEL).exists()).unwrap_or(false) && asr_dir().map(|d| d.join("tokens.txt").exists()).unwrap_or(false)
}

#[derive(Serialize)]
pub struct VoiceStatus {
    installed: bool,
    installing: bool,
    listening: bool,
}

#[tauri::command]
pub fn voice_status() -> VoiceStatus {
    VoiceStatus { installed: installed(), installing: *INSTALLING.lock().unwrap(), listening: LISTENING.load(Ordering::Relaxed) }
}

// --- Install -----------------------------------------------------------------------------

static INSTALLING: Mutex<bool> = Mutex::new(false);

/// Download the voice (~350 MB) and the ears (~480 MB). Emits `brain-progress`.
#[tauri::command]
pub async fn voice_install(app: AppHandle) -> Result<(), String> {
    {
        let mut busy = INSTALLING.lock().unwrap();
        if *busy {
            return Err("Already downloading.".into());
        }
        *busy = true;
    }
    let result = install(&app).await;
    *INSTALLING.lock().unwrap() = false;
    result
}

async fn install(app: &AppHandle) -> Result<(), String> {
    let http = reqwest::Client::builder().connect_timeout(Duration::from_secs(20)).build().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(dir()?).map_err(|e| e.to_string())?;
    for (archive, folder, what, sha) in [(TTS_ARCHIVE, TTS_DIR, "Bond's voice", TTS_SHA), (ASR_ARCHIVE, ASR_DIR, "Bond's ears", ASR_SHA)] {
        if dir()?.join(folder).exists() {
            continue;
        }
        let file = dir()?.join(archive.rsplit('/').next().unwrap_or("model.tar.bz2"));
        crate::brain::download(app, &http, &format!("{RELEASES}/{archive}"), &file, what, sha).await?;
        let (f, target) = (file.clone(), dir()?.to_path_buf());
        tauri::async_runtime::spawn_blocking(move || untar(&f, &target)).await.map_err(|e| e.to_string())??;
        let _ = std::fs::remove_file(&file);
    }
    if !installed() {
        return Err("The voice download was incomplete. Try again.".into());
    }
    Ok(())
}

/// Unpack a .tar.bz2 into `target`, refusing paths that would land outside it.
pub(crate) fn untar(archive: &Path, target: &Path) -> Result<(), String> {
    let f = std::fs::File::open(archive).map_err(|e| e.to_string())?;
    let mut tar = tar::Archive::new(bzip2::read::BzDecoder::new(f));
    for entry in tar.entries().map_err(|e| e.to_string())? {
        let mut entry = entry.map_err(|e| e.to_string())?;
        // unpack_in skips entries with absolute paths or "..".
        entry.unpack_in(target).map_err(|e| format!("Couldn't unpack the voice: {e}"))?;
    }
    Ok(())
}

// --- Speaking ----------------------------------------------------------------------------

static TTS: Mutex<Option<Arc<sherpa_onnx::OfflineTts>>> = Mutex::new(None);
/// The voice has loaded and said one throwaway word, so the first real answer isn't slow.
static WARM: AtomicBool = AtomicBool::new(false);

/// Get the voice ready while the user is still asking: loading it and its first sentence cost
/// seconds, and they used to land between the text appearing and Bond speaking.
#[tauri::command]
pub async fn voice_warm() -> Result<(), String> {
    if WARM.load(Ordering::SeqCst) || !installed() {
        touch();
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(|| {
        let started = Instant::now();
        match synthesize("Hi.", 0, 1.0) {
            Ok(_) => {
                WARM.store(true, Ordering::SeqCst);
                crate::diag::log(&format!("voice warmed in {} ms", started.elapsed().as_millis()));
            }
            Err(e) => crate::diag::log(&format!("voice warm-up failed: {e}")),
        }
    })
    .await
    .map_err(|e| e.to_string())
}

fn tts() -> Result<Arc<sherpa_onnx::OfflineTts>, String> {
    touch();
    let mut guard = TTS.lock().unwrap();
    if let Some(t) = guard.as_ref() {
        return Ok(t.clone());
    }
    if !installed() {
        return Err("Bond's voice isn't set up yet — download it in Dashboard → Settings.".into());
    }
    let config = tts_config(&tts_dir()?, TTS_MODEL, TTS_THREADS);
    let t = Arc::new(sherpa_onnx::OfflineTts::create(&config).ok_or("Bond's voice couldn't start.")?);
    *guard = Some(t.clone());
    Ok(t)
}

fn tts_config(d: &Path, model: &str, threads: i32) -> sherpa_onnx::OfflineTtsConfig {
    let mut config = sherpa_onnx::OfflineTtsConfig::default();
    config.model.kokoro.model = path_str(d.join(model));
    config.model.kokoro.voices = path_str(d.join("voices.bin"));
    config.model.kokoro.tokens = path_str(d.join("tokens.txt"));
    config.model.kokoro.data_dir = path_str(d.join("espeak-ng-data"));
    config.model.kokoro.lexicon = path_str(d.join("lexicon-us-en.txt"));
    config.model.kokoro.dict_dir = path_str(d.join("dict"));
    config.model.kokoro.lang = Some("en-us".into());
    config.model.num_threads = threads;
    config.max_num_sentences = 1;
    config
}

/// One piece of speech as a base64 WAV. `voice` is a Kokoro speaker id, `speed` 1.0 normal.
#[tauri::command]
pub async fn voice_say(text: String, voice: i32, speed: f32) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let audio = synthesize(&text, voice, speed)?;
        let pcm: Vec<u8> = audio.0.iter().flat_map(|s| ((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes()).collect();
        Ok(base64::engine::general_purpose::STANDARD.encode(crate::ai::wav(&pcm, audio.1)))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Samples (mono, -1..1) and their sample rate.
pub fn synthesize(text: &str, voice: i32, speed: f32) -> Result<(Vec<f32>, u32), String> {
    let tts = tts()?;
    let gen = sherpa_onnx::GenerationConfig { sid: voice, speed: speed.clamp(0.6, 1.6), ..Default::default() };
    let audio = tts.generate_with_config(text.trim(), &gen, None::<fn(&[f32], f32) -> bool>).ok_or("Bond couldn't say that.")?;
    Ok((audio.samples().to_vec(), audio.sample_rate() as u32))
}

// --- Listening ---------------------------------------------------------------------------

static ASR: Mutex<Option<Arc<sherpa_onnx::OfflineRecognizer>>> = Mutex::new(None);

fn asr() -> Result<Arc<sherpa_onnx::OfflineRecognizer>, String> {
    touch();
    let mut guard = ASR.lock().unwrap();
    if let Some(r) = guard.as_ref() {
        return Ok(r.clone());
    }
    if !installed() {
        return Err("Bond's ears aren't set up yet — download them in Dashboard → Settings.".into());
    }
    let d = asr_dir()?;
    let mut config = sherpa_onnx::OfflineRecognizerConfig::default();
    config.model_config.transducer.encoder = path_str(d.join("encoder.int8.onnx"));
    config.model_config.transducer.decoder = path_str(d.join("decoder.int8.onnx"));
    config.model_config.transducer.joiner = path_str(d.join("joiner.int8.onnx"));
    config.model_config.tokens = path_str(d.join("tokens.txt"));
    config.model_config.model_type = Some("nemo_transducer".into());
    config.model_config.num_threads = 4;
    let r = Arc::new(sherpa_onnx::OfflineRecognizer::create(&config).ok_or("Bond's ears couldn't start.")?);
    *guard = Some(r.clone());
    Ok(r)
}

/// Text from mono samples at `rate` Hz.
pub fn transcribe(samples: &[f32], rate: u32) -> Result<String, String> {
    let r = asr()?;
    let audio = resample(samples, rate, ASR_RATE);
    let stream = r.create_stream();
    stream.accept_waveform(ASR_RATE as i32, &audio);
    r.decode(&stream);
    Ok(stream.get_result().map(|x| x.text.trim().to_string()).unwrap_or_default())
}

/// Linear resampling: plenty for speech recognition.
pub(crate) fn resample(x: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || x.is_empty() {
        return x.to_vec();
    }
    let ratio = from as f64 / to as f64;
    let n = (x.len() as f64 / ratio) as usize;
    (0..n)
        .map(|i| {
            let p = i as f64 * ratio;
            let j = p as usize;
            let f = (p - j as f64) as f32;
            let a = x[j];
            let b = *x.get(j + 1).unwrap_or(&a);
            a + (b - a) * f
        })
        .collect()
}

/// Downsampling with a low-pass filter. Plain interpolation lets sound above the new rate fold back into
/// the speech band (a laptop microphone has plenty of it), which is what the recognizer then mishears.
/// A windowed sinc keeps what is below the new Nyquist and removes the rest.
pub(crate) fn resample_filtered(x: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from <= to || x.is_empty() {
        return resample(x, from, to);
    }
    let ratio = from as f64 / to as f64;
    let n = (x.len() as f64 / ratio) as usize;
    let cut = 0.92 / ratio; // a little under the new Nyquist, as a fraction of the old one
    let half = (8.0 / cut).ceil();
    (0..n)
        .map(|i| {
            let p = i as f64 * ratio;
            let c = p.round() as isize;
            let (mut acc, mut sum) = (0f64, 0f64);
            for j in (c - half as isize)..=(c + half as isize) {
                if j < 0 || j as usize >= x.len() {
                    continue;
                }
                let t = j as f64 - p;
                if t.abs() > half {
                    continue;
                }
                let a = std::f64::consts::PI * cut * t;
                let sinc = if a.abs() < 1e-9 { 1.0 } else { a.sin() / a };
                let hann = 0.5 + 0.5 * (std::f64::consts::PI * t / half).cos();
                let w = cut * sinc * hann;
                acc += w * x[j as usize] as f64;
                sum += w;
            }
            if sum.abs() > 1e-9 { (acc / sum) as f32 } else { 0.0 }
        })
        .collect()
}

/// What the microphone recorded, ready for the recognizer: at its rate, and brought up to a good level
/// when the microphone is quiet. The length and loudness go in the log, so a weak microphone shows up.
pub(crate) fn prepare_mic(samples: &[f32], rate: u32) -> Vec<f32> {
    let mut x = resample_filtered(samples, rate, ASR_RATE);
    let peak = x.iter().fold(0f32, |m, s| m.max(s.abs()));
    let level = (x.iter().map(|s| s * s).sum::<f32>() / x.len().max(1) as f32).sqrt();
    crate::diag::log(&format!("voice: heard {:.1} s, peak {:.2}, level {:.3}", x.len() as f32 / ASR_RATE as f32, peak, level));
    if peak > 0.01 {
        let gain = (0.7 / peak).clamp(1.0, 10.0);
        if gain > 1.05 {
            for s in x.iter_mut() {
                *s = (*s * gain).clamp(-1.0, 1.0);
            }
        }
    }
    x
}

pub(crate) static LISTENING: AtomicBool = AtomicBool::new(false);
/// Set when the keys turned out to be another shortcut: what was recorded is thrown away, not answered.
static CANCEL: AtomicBool = AtomicBool::new(false);
/// Set to stop the recording (key released, or the click-to-talk heard silence).
static STOP: AtomicBool = AtomicBool::new(false);

/// Longest a single request can be.
const MAX_LISTEN: Duration = Duration::from_secs(30);
/// Click-to-talk: quiet this long after speaking ends it. Long enough for someone who talks slowly
/// or stops to think; holding Ctrl+Alt has no such limit.
pub(crate) const END_SILENCE: Duration = Duration::from_millis(2000);
/// …or this long without any speech at all.
const NO_SPEECH: Duration = Duration::from_secs(6);

/// Start listening. `hands_free` (the mic button): stop by itself when you go quiet;
/// otherwise (the hotkey) when `voice_listen_stop` is called. Emits `voice-state`
/// ("listening" → "thinking" → "idle") and then `voice-heard` with the text.
pub fn start(app: AppHandle, hands_free: bool) {
    if LISTENING.swap(true, Ordering::SeqCst) {
        return; // already listening
    }
    STOP.store(false, Ordering::SeqCst);
    CANCEL.store(false, Ordering::SeqCst);
    std::thread::spawn(move || {
        // "Listening…" only once sound is actually arriving (the microphone takes ~0.5 s to
        // start), so the cue is honest and the first words aren't lost.
        let ready = app.clone();
        // A panic in the microphone or the recognizer must not leave LISTENING set: nothing could be heard again.
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            record(hands_free, move || {
                let _ = ready.emit("voice-state", "listening");
            })
            .and_then(|(samples, rate)| {
                if CANCEL.load(Ordering::SeqCst) {
                    return Ok(String::new());
                }
                let _ = app.emit("voice-state", "thinking");
                if samples.len() < (rate as usize) / 4 {
                    return Ok(String::new()); // a tap, not speech
                }
                transcribe(&prepare_mic(&samples, rate), ASR_RATE)
            })
        }))
        .unwrap_or_else(|_| Err("Bond's ears ran into a problem. Try again.".to_string()));
        LISTENING.store(false, Ordering::SeqCst);
        let _ = app.emit("voice-state", "idle");
        if CANCEL.swap(false, Ordering::SeqCst) {
            return; // it was a different shortcut: nothing to say about it
        }
        match result {
            Ok(text) => {
                let _ = app.emit("voice-heard", text);
            }
            Err(e) => {
                let _ = app.emit("voice-error", e);
            }
        }
    });
}

pub fn stop() {
    STOP.store(true, Ordering::SeqCst);
}

/// Stop and throw away what was recorded (the keys were part of another shortcut).
pub fn cancel() {
    CANCEL.store(true, Ordering::SeqCst);
    STOP.store(true, Ordering::SeqCst);
}

#[tauri::command]
pub fn voice_listen(app: AppHandle) {
    start(app, true);
}

#[tauri::command]
pub fn voice_listen_stop() {
    stop();
}

/// One utterance from the microphone, ending when you go quiet (enrolment).
pub(crate) fn record_once(on_ready: impl FnOnce()) -> Result<(Vec<f32>, u32), String> {
    STOP.store(false, Ordering::SeqCst);
    record(true, on_ready)
}

/// Record from the default microphone (mono) until stopped. `on_ready` runs when the first
/// sound arrives.
fn record(hands_free: bool, on_ready: impl FnOnce()) -> Result<(Vec<f32>, u32), String> {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    let device = cpal::default_host().default_input_device().ok_or("No microphone found.")?;
    let supported = device.default_input_config().map_err(|e| format!("The microphone isn't available: {e}"))?;
    let rate = supported.sample_rate();
    let channels = supported.channels() as usize;
    let format = supported.sample_format();
    let config: cpal::StreamConfig = supported.config();

    let buf: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = buf.clone();
    let push = move |mono: Vec<f32>| sink.lock().unwrap().extend(mono);
    let err = |e| eprintln!("microphone: {e}");
    let stream = match format {
        cpal::SampleFormat::F32 => device.build_input_stream(config, move |d: &[f32], _: &_| push(downmix(d, channels, |s| s)), err, None),
        cpal::SampleFormat::I16 => device.build_input_stream(config, move |d: &[i16], _: &_| push(downmix(d, channels, |s| s as f32 / 32768.0)), err, None),
        cpal::SampleFormat::I32 => device.build_input_stream(config, move |d: &[i32], _: &_| push(downmix(d, channels, |s| s as f32 / 2_147_483_648.0)), err, None),
        f => return Err(format!("This microphone's format ({f:?}) isn't supported.")),
    }
    .map_err(|e| format!("Couldn't open the microphone: {e}"))?;
    stream.play().map_err(|e| format!("Couldn't start the microphone: {e}"))?;

    let mut on_ready = Some(on_ready);
    let started = Instant::now();
    let mut talk = Endpoint::default();
    let mut seen = 0usize;
    while !STOP.load(Ordering::SeqCst) && started.elapsed() < MAX_LISTEN {
        std::thread::sleep(Duration::from_millis(30));
        if on_ready.is_some() && !buf.lock().unwrap().is_empty() {
            on_ready.take().map(|f| f());
        }
        if hands_free {
            let frame: Vec<f32> = buf.lock().unwrap()[seen..].to_vec();
            seen += frame.len();
            if talk.feed(&frame, started.elapsed()) {
                break;
            }
        }
    }
    drop(stream);
    let samples = std::mem::take(&mut *buf.lock().unwrap());
    Ok((samples, rate))
}

pub(crate) fn downmix<T: Copy>(data: &[T], channels: usize, to_f32: impl Fn(T) -> f32) -> Vec<f32> {
    data.chunks(channels.max(1)).map(|c| c.iter().map(|s| to_f32(*s)).sum::<f32>() / c.len() as f32).collect()
}

/// Ends click-to-talk: speech, then a pause; or no speech at all for a while. The noise
/// floor adapts to the room, so a fan or keyboard doesn't count as talking.
#[derive(Default)]
pub(crate) struct Endpoint {
    floor: Option<f32>,
    spoke_at: Option<Duration>,
    quiet_since: Option<Duration>,
}

impl Endpoint {
    /// Start from a known room noise level, for listening that may begin mid-sentence.
    pub(crate) fn with_floor(floor: f32) -> Self {
        Endpoint { floor: Some(floor), ..Default::default() }
    }

    /// Talking right now (the last frame was speech).
    pub(crate) fn speaking(&self) -> bool {
        self.spoke_at.is_some() && self.quiet_since.is_none()
    }

    /// How long it's been quiet since speech, at time `t` (zero while talking or before).
    pub(crate) fn quiet_for(&self, t: Duration) -> Duration {
        match (self.spoke_at, self.quiet_since) {
            (Some(_), Some(q)) => t.saturating_sub(q),
            _ => Duration::ZERO,
        }
    }

    /// Feed new samples heard at time `t`; true when it's time to stop.
    pub(crate) fn feed(&mut self, frame: &[f32], t: Duration) -> bool {
        if frame.is_empty() {
            return false;
        }
        let rms = (frame.iter().map(|s| s * s).sum::<f32>() / frame.len() as f32).sqrt();
        let floor = *self.floor.get_or_insert(rms);
        let speaking = rms > (floor * 3.0).max(0.01);
        if !speaking {
            self.floor = Some(floor * 0.95 + rms * 0.05);
        }
        if speaking {
            self.spoke_at = Some(t);
            self.quiet_since = None;
        } else if self.spoke_at.is_some() && self.quiet_since.is_none() {
            self.quiet_since = Some(t);
        }
        match (self.spoke_at, self.quiet_since) {
            (Some(_), Some(q)) => t - q >= END_SILENCE,
            (None, _) => t >= NO_SPEECH,
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Word error rate of `got` against `want` (case and punctuation ignored).
    fn wer(want: &str, got: &str) -> f64 {
        let words = |s: &str| -> Vec<String> {
            s.to_lowercase().split(|c: char| !c.is_alphanumeric() && c != '\'').filter(|w| !w.is_empty()).map(str::to_string).collect()
        };
        let (a, b) = (words(want), words(got));
        let mut d: Vec<Vec<usize>> = (0..=a.len()).map(|i| (0..=b.len()).map(|j| if i == 0 { j } else if j == 0 { i } else { 0 }).collect()).collect();
        for i in 1..=a.len() {
            for j in 1..=b.len() {
                d[i][j] = (d[i - 1][j] + 1).min(d[i][j - 1] + 1).min(d[i - 1][j - 1] + (a[i - 1] != b[j - 1]) as usize);
            }
        }
        d[a.len()][b.len()] as f64 / a.len().max(1) as f64
    }

    /// Bond speaks requests (Kokoro), each candidate ear transcribes them: speed and accuracy.
    ///   BOND_VOICE_DIR=<folder with the unpacked models> cargo test --lib voice::tests::bench -- --ignored --nocapture
    /// Synthetic speech is cleaner than a real microphone, so real-world errors will be higher.
    #[test]
    #[ignore]
    fn bench() {
        let root = PathBuf::from(std::env::var("BOND_VOICE_DIR").expect("BOND_VOICE_DIR"));
        use_dir(root.clone());
        let lines = [
            "Open Spotify and play something.",
            "Remind me tomorrow morning to call the bank.",
            "What's eating my RAM?",
            "Delete the zip files in my downloads folder.",
            "Log that I finished the login page today and felt great.",
            "Search for the best Rust web frameworks.",
            "Why is my laptop so slow right now?",
            "Turn the volume down a little.",
            "Save an idea: an app that waters my plants when the soil is dry.",
            "Explain the error on my screen.",
        ];
        // Speaking: how fast, compared with how long the speech lasts.
        let mut clips = Vec::new();
        for (i, text) in lines.iter().enumerate() {
            let t = Instant::now();
            let (samples, rate) = synthesize(text, 18, 1.0).unwrap(); // am_puck
            let took = t.elapsed().as_secs_f64();
            let dur = samples.len() as f64 / rate as f64;
            if i < 3 {
                println!("say  {took:.2}s for {dur:.1}s of speech (x{:.1} real time)  {text}", dur / took);
            }
            clips.push((text, samples, rate));
        }
        let total_speech: f64 = clips.iter().map(|c| c.1.len() as f64 / c.2 as f64).sum();

        let ear = |name: &str, make: &dyn Fn(&Path) -> sherpa_onnx::OfflineRecognizerConfig| {
            let d = root.join(name);
            if !d.exists() {
                println!("({name} not found)");
                return;
            }
            let t = Instant::now();
            let r = sherpa_onnx::OfflineRecognizer::create(&make(&d)).expect("recognizer");
            let load = t.elapsed().as_secs_f64();
            let (mut errs, mut secs) = (0.0, 0.0);
            for (text, samples, rate) in &clips {
                let audio = resample(samples, *rate, ASR_RATE);
                let t = Instant::now();
                let s = r.create_stream();
                s.accept_waveform(ASR_RATE as i32, &audio);
                r.decode(&s);
                let got = s.get_result().map(|x| x.text).unwrap_or_default();
                secs += t.elapsed().as_secs_f64();
                let e = wer(text, &got);
                errs += e;
                if e > 0.0 {
                    println!("     {name}: “{}” → “{}”", text, got.trim());
                }
            }
            println!(
                "hear {name}: load {load:.1}s, {:.2}s per request (x{:.0} real time), word errors {:.1}%",
                secs / clips.len() as f64,
                total_speech / secs,
                100.0 * errs / clips.len() as f64
            );
        };
        let s = |p: PathBuf| Some(p.to_string_lossy().into_owned());
        ear("sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8", &|d| {
            let mut c = sherpa_onnx::OfflineRecognizerConfig::default();
            c.model_config.transducer.encoder = s(d.join("encoder.int8.onnx"));
            c.model_config.transducer.decoder = s(d.join("decoder.int8.onnx"));
            c.model_config.transducer.joiner = s(d.join("joiner.int8.onnx"));
            c.model_config.tokens = s(d.join("tokens.txt"));
            c.model_config.model_type = Some("nemo_transducer".into());
            c.model_config.num_threads = 4;
            c
        });
        ear("sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8", &|d| {
            let mut c = sherpa_onnx::OfflineRecognizerConfig::default();
            c.model_config.transducer.encoder = s(d.join("encoder.int8.onnx"));
            c.model_config.transducer.decoder = s(d.join("decoder.int8.onnx"));
            c.model_config.transducer.joiner = s(d.join("joiner.int8.onnx"));
            c.model_config.tokens = s(d.join("tokens.txt"));
            c.model_config.model_type = Some("nemo_transducer".into());
            c.model_config.num_threads = 4;
            c
        });
        ear("sherpa-onnx-moonshine-base-en-quantized-2026-02-27", &|d| {
            let mut c = sherpa_onnx::OfflineRecognizerConfig::default();
            c.model_config.moonshine.encoder = s(d.join("encoder_model.ort"));
            c.model_config.moonshine.merged_decoder = s(d.join("decoder_model_merged.ort"));
            c.model_config.tokens = s(d.join("tokens.txt"));
            c.model_config.num_threads = 4;
            c
        });
    }

    /// Kokoro variants: model precision × threads.
    ///   BOND_VOICE_DIR=… cargo test --release --lib voice::tests::speak_speed -- --ignored --nocapture
    /// A laptop microphone is quiet and hissy, with sound well above what the recognizer needs. Say lines,
    /// push them through that, and see what the recognizer hears the old way (plain interpolation) and the
    /// new way (prepare_mic). BOND_VOICE_DIR=%LOCALAPPDATA%\com.selfglance.app\voice
    #[test]
    #[ignore]
    fn mic_path() {
        let root = PathBuf::from(std::env::var("BOND_VOICE_DIR").expect("BOND_VOICE_DIR"));
        use_dir(root);
        let lines = [
            "What is on my desktop?",
            "Open the downloads folder.",
            "Remind me in ten minutes to stretch.",
            "Walk me through creating a YouTube channel.",
            "What are my laptop specs?",
            "Close all the notepad windows.",
            "I need a bio for my channel.",
            "Why is my laptop so slow right now?",
        ];
        let words = |t: &str| -> Vec<String> { t.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(String::from).collect() };
        let (mut old_ok, mut new_ok, mut total) = (0, 0, 0);
        let mut seed = 12345u32;
        let mut noise = move || {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            (seed >> 8) as f32 / 8_388_608.0 - 1.0
        };
        for line in lines {
            let (speech, rate) = synthesize(line, 18, 1.0).unwrap();
            // To a 48 kHz microphone: quiet speech, hiss across the whole band, a low hum.
            let up = resample(&speech, rate, 48_000);
            let peak = up.iter().fold(0f32, |m, s| m.max(s.abs())).max(1e-6);
            let mic: Vec<f32> = up.iter().enumerate().map(|(i, s)| s / peak * 0.06 + noise() * 0.012 + 0.004 * (i as f32 * 0.0131).sin()).collect();
            let old = transcribe(&mic, 48_000).unwrap();
            let new = transcribe(&prepare_mic(&mic, 48_000), ASR_RATE).unwrap();
            let want = words(line);
            let hit = |heard: &str| {
                let h = words(heard);
                want.iter().filter(|w| h.contains(w)).count()
            };
            let (o, n) = (hit(&old), hit(&new));
            old_ok += o;
            new_ok += n;
            total += want.len();
            println!("{line}
   old {o}/{}: {old}
   new {n}/{}: {new}", want.len(), want.len());
        }
        println!("WORDS HEARD: old {old_ok}/{total}, new {new_ok}/{total}");
    }

    #[test]
    #[ignore]
    fn speak_speed() {
        let root = PathBuf::from(std::env::var("BOND_VOICE_DIR").expect("BOND_VOICE_DIR"));
        let text = "Your battery is at fifteen percent. Time to plug in, or I'll start dimming things to save power.";
        for (folder, model) in [("kokoro-int8-multi-lang-v1_0", "model.int8.onnx"), ("kokoro-multi-lang-v1_0", "model.onnx")] {
            if !root.join(folder).exists() {
                continue;
            }
            for threads in [2, 4, 8] {
                let tts = sherpa_onnx::OfflineTts::create(&tts_config(&root.join(folder), model, threads)).unwrap();
                let gen = sherpa_onnx::GenerationConfig { sid: 18, ..Default::default() };
                let _ = tts.generate_with_config("Warm up.", &gen, None::<fn(&[f32], f32) -> bool>);
                let t = Instant::now();
                let a = tts.generate_with_config(text, &gen, None::<fn(&[f32], f32) -> bool>).unwrap();
                let took = t.elapsed().as_secs_f64();
                let dur = a.samples().len() as f64 / a.sample_rate() as f64;
                println!("{model:<16} {threads} threads: {took:.2}s for {dur:.1}s of speech (x{:.1} real time)", dur / took);
            }
        }
    }

    fn installed_dir() -> PathBuf {
        PathBuf::from(std::env::var("LOCALAPPDATA").unwrap()).join("com.selfglance.app").join("voice")
    }

    /// The real speak → hear path with the installed models:
    ///   cargo test --lib voice::tests::round_trip -- --ignored --nocapture
    #[test]
    #[ignore]
    fn round_trip() {
        use_dir(installed_dir());
        assert!(installed());
        for text in ["Hey, it's Bond. Your build failed because a value was moved into the closure.", "Remind me at six to call mom."] {
            let t = Instant::now();
            let (samples, rate) = synthesize(text, 18, 1.0).unwrap();
            let said = t.elapsed().as_secs_f64();
            let t = Instant::now();
            let heard = transcribe(&samples, rate).unwrap();
            println!("said in {said:.2}s ({:.1}s of speech), heard in {:.2}s: “{heard}”", samples.len() as f64 / rate as f64, t.elapsed().as_secs_f64());
            assert!(wer(text, &heard) < 0.15, "{heard}");
        }
    }

    /// Opens the default microphone for 1.5 s (prints only how much sound arrived):
    ///   cargo test --lib voice::tests::mic_opens -- --ignored --nocapture
    #[test]
    #[ignore]
    fn mic_opens() {
        use cpal::traits::{DeviceTrait, HostTrait};
        let host = cpal::default_host();
        let name = |d: &cpal::Device| d.description().map(|x| x.to_string()).unwrap_or_default();
        println!("default input: {:?}", host.default_input_device().map(|d| name(&d)));
        for d in host.input_devices().unwrap() {
            println!("input: {}", name(&d));
        }
        STOP.store(false, Ordering::SeqCst);
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_millis(1500));
            stop();
        });
        let t = Instant::now();
        let first = Arc::new(Mutex::new(None));
        let mark = first.clone();
        let (samples, rate) = record(false, move || *mark.lock().unwrap() = Some(t.elapsed())).unwrap();
        let rms = (samples.iter().map(|s| s * s).sum::<f32>() / samples.len().max(1) as f32).sqrt();
        println!(
            "microphone: sound after {:?}, {} samples at {rate} Hz ({:.2}s), loudness {rms:.4}",
            first.lock().unwrap(),
            samples.len(),
            samples.len() as f64 / rate as f64
        );
        assert!(samples.len() as f64 > 0.5 * rate as f64);
    }

    #[test]
    fn filtered_downsampling_keeps_speech_and_drops_what_would_fold_back() {
        let tone = |hz: f32| -> Vec<f32> { (0..48_000).map(|i| (2.0 * std::f32::consts::PI * hz * i as f32 / 48_000.0).sin()).collect() };
        let rms = |x: &[f32]| (x[2000..x.len() - 2000].iter().map(|s| s * s).sum::<f32>() / (x.len() - 4000) as f32).sqrt();
        let low = resample_filtered(&tone(1000.0), 48_000, 16_000);
        assert_eq!(low.len(), 16_000);
        assert!(rms(&low) > 0.65, "speech-band sound stays: {}", rms(&low));
        // 12 kHz cannot exist at 16 kHz: plain interpolation folds it down to 4 kHz, the filter removes it.
        let high = resample_filtered(&tone(12_000.0), 48_000, 16_000);
        assert!(rms(&high) < 0.05, "above the new Nyquist it is gone: {}", rms(&high));
        assert!(rms(&resample(&tone(12_000.0), 48_000, 16_000)) > 0.3, "the old way let it through");
    }

    #[test]
    fn resamples_to_the_right_length() {
        let x: Vec<f32> = (0..48_000).map(|i| (i as f32 / 10.0).sin()).collect();
        assert_eq!(resample(&x, 48_000, 16_000).len(), 16_000);
        assert_eq!(resample(&x, 16_000, 16_000).len(), 48_000);
    }

    #[test]
    fn stops_after_speech_then_quiet() {
        let ms = Duration::from_millis;
        let quiet = vec![0.001f32; 480];
        let loud: Vec<f32> = (0..480).map(|i| if i % 2 == 0 { 0.2 } else { -0.2 }).collect();
        let mut e = Endpoint::default();
        assert!(!e.feed(&quiet, ms(30)));
        assert!(!e.feed(&loud, ms(600)));
        assert!(!e.feed(&quiet, ms(1000)));
        assert!(!e.feed(&quiet, ms(2300)), "1.3 s of quiet: someone who talks slowly is still thinking");
        assert!(e.feed(&quiet, ms(3100)), "2 s of quiet after speaking");
        let mut never = Endpoint::default();
        assert!(!never.feed(&quiet, ms(3000)));
        assert!(never.feed(&quiet, ms(6100)), "no speech at all");
    }
}

#[cfg(test)]
mod tts_probe {
    /// Awkward text through the real speech engine. A native failure kills the test process, so each
    /// line is printed first: the last one shown is the culprit. BOND_VOICE_DIR=...\voice
    /// cargo test --lib tts_probe -- --ignored --nocapture --test-threads=1
    #[test]
    #[ignore]
    fn awkward_text() {
        super::use_dir(std::path::PathBuf::from(std::env::var("BOND_VOICE_DIR").expect("BOND_VOICE_DIR")));
        let long = "The window in front is Notepad and the screen shows a document with several lines of text. ".repeat(12);
        let cases: Vec<(&str, String)> = vec![
            ("plain", "You are looking at Notepad.".into()),
            ("one dot", ".".into()),
            ("one letter", "a".into()),
            ("digits", "You have 3,189 characters and 12 windows, 4.5 GB free at 10:42.".into()),
            ("url", "Open https://www.youtube.com/results?search_query=lofi+beats now.".into()),
            ("path", r"Your file is in C:\Users\Lenovo\Documents\notes\final_v2.txt today.".into()),
            ("symbols", "Press Ctrl+Alt+Del, then <Enter> & {save} [now] #1 @home 50% ~ ^ | / * =".into()),
            ("quotes", "He said \u{201c}hello\u{201d} and she said \u{2018}no\u{2019} \u{2014} then left\u{2026}".into()),
            ("emoji", "Great job \u{1F44D} you did it \u{2705}".into()),
            ("unicode", "Caf\u{e9} na\u{ef}ve \u{4f60}\u{597d} \u{43f}\u{440}\u{438}\u{432}\u{435}\u{442} \u{928}\u{92e}\u{938}\u{94d}\u{924}\u{947}".into()),
            ("long", long),
            ("code", "fn main() { println!(\"hi\"); } // let x = vec![1,2,3];".into()),
            ("only symbols", "-> ... ??? !!!".into()),
            ("newlines", "Line one\nLine two\n\nLine three".into()),
            ("whitespace", "   ".into()),
        ];
        for (name, text) in cases {
            print!("{name} ... ");
            use std::io::Write;
            std::io::stdout().flush().ok();
            let t = std::time::Instant::now();
            let r = super::synthesize(&text, 18, 1.0);
            println!("{} ({:.1}s)", match &r { Ok((s, _)) => format!("ok, {} samples", s.len()), Err(e) => format!("error: {e}") }, t.elapsed().as_secs_f64());
        }
    }
}
