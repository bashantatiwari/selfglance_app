// AI features: the user's own API key (kept in the OS keychain: Windows Credential
// Manager / macOS Keychain / Linux Secret Service), and calls to the chosen provider.
//
//   Claude (Anthropic) — raw HTTP to the Messages API (Rust has no official SDK).
//   Gemini (Google)    — raw HTTP to generateContent (has a free tier).
//
// The key never reaches the webview: the frontend only asks Rust to run a request.

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Manager};

const KEYCHAIN_SERVICE: &str = "SelfGlance";
const CLAUDE_MODEL: &str = "claude-opus-5-5";
/// Free Gemini models tried in order when one is overloaded (503), out of quota (429) or
/// retired (404). Checked against a free-tier key on 2026-10-07; the chain keeps working as
/// Google renames models because any failure just moves on to the next one.
/// Fast "lite" models first: on a screenshot question they answer in ~2 s, while the big
/// free models were often overloaded or 3-6x slower (measured 2026-10-07).
const GEMINI_CHAIN: &[&str] = &[
    "gemini-flash-lite-latest",
    "gemini-3.5-flash-lite",
    "gemini-3-flash-preview",
    "gemini-3.1-flash-lite",
    "gemini-3.7-flash",
    "gemini-flash-latest",
];

/// The last Gemini model that answered; tried first next time so we don't wait on busy ones.
static LAST_GOOD_GEMINI: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

#[derive(Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Claude,
    Gemini,
}

impl Provider {
    fn account(self) -> &'static str {
        match self {
            Provider::Claude => "api-key-claude",
            Provider::Gemini => "api-key-gemini",
        }
    }
}

fn entry(p: Provider) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, p.account()).map_err(|e| e.to_string())
}

fn key(p: Provider) -> Result<String, String> {
    entry(p)?
        .get_password()
        .map_err(|_| "No API key saved yet — add one in Dashboard → Settings.".to_string())
}

#[tauri::command]
pub fn ai_set_key(provider: Provider, key: String) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return entry(provider)?.delete_credential().or(Ok(()));
    }
    entry(provider)?.set_password(key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ai_has_key(provider: Provider) -> bool {
    entry(provider).and_then(|e| e.get_password().map_err(|e| e.to_string())).is_ok()
}

/// One image (base64 JPEG) to send along with the prompt.
struct Image {
    b64: String,
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())
}

async fn complete(provider: Provider, gemini_model: Option<String>, system: &str, prompt: &str, image: Option<Image>, effort: &str) -> Result<String, String> {
    let key = key(provider)?;
    match provider {
        Provider::Claude => {
            let mut content = Vec::new();
            if let Some(img) = &image {
                content.push(json!({"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": img.b64}}));
            }
            content.push(json!({"type": "text", "text": prompt}));
            let body = json!({
                "model": CLAUDE_MODEL,
                "max_tokens": 16000,
                "system": system,
                "output_config": {"effort": effort},
                // If a safety classifier declines, re-run server-side on Anthropic's recommended fallback.
                "fallbacks": "default",
                "messages": [{"role": "user", "content": content}],
            });
            let res = client()?
                .post("https://api.anthropic.com/v1/messages")
                .header("x-api-key", key)
                .header("anthropic-version", "2023-06-01")
                .header("anthropic-beta", "server-side-fallback-2026-07-01")
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("Network error: {e}"))?;
            let status = res.status();
            let v: Value = res.json().await.map_err(|e| e.to_string())?;
            if !status.is_success() {
                let msg = v["error"]["message"].as_str().unwrap_or("request failed");
                return Err(match status.as_u16() {
                    401 => "Claude rejected the API key. Check it in Settings.".into(),
                    429 => "Claude is rate-limiting this key. Try again in a minute.".into(),
                    s if s >= 500 => format!("Claude is having trouble ({s}). Try again shortly."),
                    s => format!("Claude error {s}: {msg}"),
                });
            }
            if v["stop_reason"] == "refusal" {
                return Err("Claude declined this request.".into());
            }
            let text: Vec<&str> = v["content"]
                .as_array()
                .map(|blocks| blocks.iter().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect())
                .unwrap_or_default();
            Ok(text.join("\n").trim().to_string())
        }
        Provider::Gemini => {
            // Order: last model that worked, the user's choice, then the free chain.
            let mut models: Vec<String> = Vec::new();
            if let Some(m) = LAST_GOOD_GEMINI.lock().unwrap().clone() {
                models.push(m);
            }
            if let Some(m) = gemini_model.filter(|m| !m.trim().is_empty() && m.trim() != "auto") {
                models.push(m.trim().to_string());
            }
            models.extend(GEMINI_CHAIN.iter().map(|m| m.to_string()));
            models.dedup();
            let mut seen = std::collections::HashSet::new();
            models.retain(|m| seen.insert(m.clone()));

            let mut parts = vec![json!({"text": prompt})];
            if let Some(img) = &image {
                parts.push(json!({"inline_data": {"mime_type": "image/jpeg", "data": img.b64}}));
            }
            let body = json!({
                "system_instruction": {"parts": [{"text": system}]},
                "contents": [{"role": "user", "parts": parts}],
            });
            let http = client()?;
            let mut last_err = String::from("No Gemini model answered.");
            for model in &models {
                let url = format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent");
                let res = match http.post(url).header("x-goog-api-key", &key).json(&body).send().await {
                    Ok(r) => r,
                    Err(e) => {
                        last_err = format!("Network error: {e}");
                        continue;
                    }
                };
                let status = res.status().as_u16();
                let v: Value = res.json().await.unwrap_or(Value::Null);
                match status {
                    200 => {
                        let text: Vec<&str> = v["candidates"][0]["content"]["parts"]
                            .as_array()
                            .map(|p| p.iter().filter_map(|x| x["text"].as_str()).collect())
                            .unwrap_or_default();
                        if text.is_empty() {
                            last_err = "The model returned no answer.".into();
                            continue;
                        }
                        *LAST_GOOD_GEMINI.lock().unwrap() = Some(model.clone());
                        return Ok(text.join("
").trim().to_string());
                    }
                    // Busy, out of quota, or retired: try the next free model.
                    429 | 404 | 500 | 502 | 503 | 504 => {
                        if LAST_GOOD_GEMINI.lock().unwrap().as_deref() == Some(model.as_str()) {
                            *LAST_GOOD_GEMINI.lock().unwrap() = None;
                        }
                        last_err = match status {
                            429 => "Gemini's free quota is used up for now. Try again in a few minutes.".into(),
                            404 => "No available Gemini model found for this key.".into(),
                            _ => "Gemini is overloaded right now. Try again in a minute.".into(),
                        };
                    }
                    400 | 401 | 403 => {
                        let msg = v["error"]["message"].as_str().unwrap_or("request rejected");
                        return Err(format!("Gemini rejected the key or request: {msg}"));
                    }
                    s => last_err = format!("Gemini error {s}."),
                }
            }
            Err(last_err)
        }
    }
}

/// Natural-sounding speech for Bond's answers (Gemini TTS; free tier). Returns a base64 WAV.
/// Tries several TTS models in turn; the frontend falls back to the system voice on error.
#[tauri::command]
pub async fn ai_speak(text: String) -> Result<String, String> {
    const TTS_CHAIN: &[&str] = &["gemini-3.8-flash-tts", "gemini-3.1-flash-tts-preview", "gemini-2.5-flash-preview-tts"];
    let key = key(Provider::Gemini)?;
    let body = json!({
        "contents": [{"parts": [{"text": format!("Say in a warm, friendly, upbeat voice: {}", text)}]}],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": "Puck"}}}
        }
    });
    let http = client()?;
    for model in TTS_CHAIN {
        let url = format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent");
        let Ok(res) = http.post(url).header("x-goog-api-key", &key).json(&body).send().await else { continue };
        if !res.status().is_success() {
            continue;
        }
        let v: Value = res.json().await.unwrap_or(Value::Null);
        let part = &v["candidates"][0]["content"]["parts"][0]["inlineData"];
        let (Some(mime), Some(data)) = (part["mimeType"].as_str(), part["data"].as_str()) else { continue };
        if mime.contains("wav") {
            return Ok(data.to_string());
        }
        // Raw 16-bit PCM ("audio/L16; rate=24000"): wrap it in a WAV header so <audio> can play it.
        let rate: u32 = mime
            .split(';')
            .find_map(|p| p.trim().strip_prefix("rate="))
            .and_then(|r| r.parse().ok())
            .unwrap_or(24000);
        let pcm = base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| e.to_string())?;
        return Ok(base64::engine::general_purpose::STANDARD.encode(wav(&pcm, rate)));
    }
    Err("No voice available right now.".into())
}

/// Minimal WAV container for mono 16-bit little-endian PCM.
fn wav(pcm: &[u8], rate: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity(44 + pcm.len());
    let data_len = pcm.len() as u32;
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // fmt chunk size
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * 2).to_le_bytes()); // byte rate
    out.extend_from_slice(&2u16.to_le_bytes()); // block align
    out.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    out.extend_from_slice(pcm);
    out
}

/// Plain text request (e.g. the daily summary).
#[tauri::command]
pub async fn ai_text(provider: Provider, gemini_model: Option<String>, system: String, prompt: String) -> Result<String, String> {
    complete(provider, gemini_model, &system, &prompt, None, "low").await
}

#[derive(Serialize)]
pub struct GuideAnswer {
    answer: String,
    /// Where to point, in overlay CSS pixels (None = nothing specific on screen).
    point: Option<(f64, f64)>,
    label: Option<String>,
}

const GUIDE_SYSTEM: &str = "You are Bond, a friendly desktop companion who teaches the user how to do things on their computer. \
You receive a screenshot of the user's screen and their question. Answer in at most 4 short sentences, plain text, \
practical and specific to what is visible. If one on-screen element is the next thing to click or look at, add a final line \
exactly in the form: POINT: x,y | short label — where x,y are COORDS. \
Only add POINT when you can see the element. Never invent UI that is not on screen.";
const COORDS_PIXELS: &str = "pixel coordinates in the screenshot (origin top-left)";
const COORDS_NORMALIZED: &str = "coordinates normalized to 0-1000 (x from left, y from top)";

struct Shot {
    b64: String,
    width: u32,
    height: u32,
    mx: f64,
    my: f64,
    /// screenshot pixels per physical screen pixel
    scale: f64,
}

/// Capture the primary monitor, downscale and JPEG-encode it. Kept synchronous and separate
/// so the platform capture handles are released before any network await.
fn capture() -> Result<Shot, String> {
    let monitors = xcap::Monitor::all().map_err(|e| format!("Couldn't capture the screen: {e}"))?;
    let monitor = monitors
        .into_iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .ok_or("No primary screen found")?;
    let raw = monitor.capture_image().map_err(|e| format!("Couldn't capture the screen: {e}"))?;
    let (mx, my) = (monitor.x().unwrap_or(0) as f64, monitor.y().unwrap_or(0) as f64);
    let (w, h) = (raw.width(), raw.height());
    let max_w = 1280u32; // small and fast to upload, still sharp enough to read UI text
    let scale = if w > max_w { max_w as f64 / w as f64 } else { 1.0 };
    let img = image::DynamicImage::ImageRgba8(raw);
    let img = if scale < 1.0 {
        img.resize((w as f64 * scale) as u32, (h as f64 * scale) as u32, image::imageops::FilterType::Triangle)
    } else {
        img
    };
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 72)
        .encode_image(&img.to_rgb8())
        .map_err(|e| e.to_string())?;
    Ok(Shot {
        b64: base64::engine::general_purpose::STANDARD.encode(jpeg),
        width: img.width(),
        height: img.height(),
        mx,
        my,
        scale,
    })
}

/// "Bond, how do I…": screenshot the primary screen (only now, on request), ask the model,
/// and return the answer plus an optional point mapped into the overlay's coordinates.
#[tauri::command]
pub async fn ai_guide(app: AppHandle, provider: Provider, gemini_model: Option<String>, question: String) -> Result<GuideAnswer, String> {
    // 0. No key → say so right away, before doing any work.
    key(provider)?;

    // 1. Screenshot (only now, because you asked) — on a worker thread so nothing else waits.
    let shot = tauri::async_runtime::spawn_blocking(capture).await.map_err(|e| e.to_string())??;
    let (mx, my, scale) = (shot.mx, shot.my, shot.scale);

    // 2. Ask.
    let prompt = format!("Screenshot size: {}x{} pixels.\nQuestion: {}", shot.width, shot.height, question.trim());
    // Gemini reads positions on a 0-1000 grid natively; Claude answers in pixels.
    let normalized = provider == Provider::Gemini;
    let system = GUIDE_SYSTEM.replace("COORDS", if normalized { COORDS_NORMALIZED } else { COORDS_PIXELS });
    let reply = complete(provider, gemini_model, &system, &prompt, Some(Image { b64: shot.b64 }), "medium").await?;
    let (iw, ih) = (shot.width as f64, shot.height as f64);

    // 3. Split off the POINT line and map screenshot pixels → overlay CSS pixels.
    let mut answer_lines = Vec::new();
    let mut point = None;
    let mut label = None;
    for line in reply.lines() {
        if let Some(rest) = line.trim().strip_prefix("POINT:") {
            let (coords, lbl) = rest.split_once('|').unwrap_or((rest, ""));
            let nums: Vec<f64> = coords.split(',').filter_map(|n| n.trim().parse().ok()).collect();
            if nums.len() == 2 {
                if let Some(win) = app.get_webview_window("overlay") {
                    let (Ok(origin), Ok(sf)) = (win.outer_position(), win.scale_factor()) else { continue };
                    let (ix, iy) = if normalized { (nums[0] / 1000.0 * iw, nums[1] / 1000.0 * ih) } else { (nums[0], nums[1]) };
                    let px = mx + ix / scale;
                    let py = my + iy / scale;
                    point = Some(((px - origin.x as f64) / sf, (py - origin.y as f64) / sf));
                    label = Some(lbl.trim().to_string()).filter(|s| !s.is_empty());
                }
            }
        } else {
            answer_lines.push(line);
        }
    }
    Ok(GuideAnswer { answer: answer_lines.join("\n").trim().to_string(), point, label })
}
