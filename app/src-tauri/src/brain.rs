// Bond's own brain: a small open model run on this laptop, so understanding commands,
// reading the screen and answering questions need no API key and nothing leaves the PC.
//
//   Model   Qwen3.5-4B (Apache 2.0), 4-bit, with its vision projector: text, screenshots,
//           tool calls. ~3.4 GB on disk.
//   Engine  llama.cpp's llama-server, downloaded once into the app data folder. It speaks
//           the OpenAI chat API on 127.0.0.1 only, and can force replies to match a JSON
//           schema, so the model can't produce a broken action.
//
// The server starts on the first request (or when the Ask box opens), and stops after a
// few idle minutes to give the GPU memory back. On Windows it runs in a job object, so it
// ends with SelfGlance even if SelfGlance crashes.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

/// llama.cpp build the engine is downloaded from (tested with this model).
const ENGINE_TAG: &str = "b11507";
const MODEL_REPO: &str = "https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main";
const MODEL_FILE: &str = "Qwen3.5-4B-Q4_K_M.gguf";
const MMPROJ_FILE: &str = "mmproj-F16.gguf";
/// Context window. Room for the router prompt, a few of your past examples and a screenshot.
const CONTEXT: u32 = 16384;
/// Free the GPU after this long without a request.
const IDLE_STOP: Duration = Duration::from_secs(10 * 60);

static DIR: OnceLock<PathBuf> = OnceLock::new();

/// Where the engine and model live: <local app data>/brain (not roaming: 3.4 GB).
pub fn init(app: &AppHandle) {
    if let Ok(d) = app.path().app_local_data_dir() {
        let _ = DIR.set(d.join("brain"));
    }
    spawn_idle_stop();
}

/// Point tests at an existing brain folder.
#[cfg(test)]
pub fn use_dir(p: PathBuf) {
    let _ = DIR.set(p);
}

fn dir() -> Result<&'static Path, String> {
    DIR.get().map(|p| p.as_path()).ok_or_else(|| "The app data folder isn't available.".to_string())
}

// --- Engine ------------------------------------------------------------------------------

/// The Vulkan build runs on any GPU (NVIDIA, AMD, Intel). On an RTX 3050 laptop it generated
/// as fast as the CUDA build (44 vs 45 tokens/s) and read prompts ~25% slower, for a 33 MB
/// download instead of 656 MB (measured 2026-10-08).
fn engine_archive() -> String {
    format!("https://github.com/ggml-org/llama.cpp/releases/download/{ENGINE_TAG}/llama-{ENGINE_TAG}-bin-win-vulkan-x64.zip")
}

fn engine_dir() -> Result<PathBuf, String> {
    Ok(dir()?.join(format!("engine-{ENGINE_TAG}")))
}

fn server_exe() -> Result<PathBuf, String> {
    Ok(engine_dir()?.join(if cfg!(windows) { "llama-server.exe" } else { "llama-server" }))
}

fn model_path(file: &str) -> Result<PathBuf, String> {
    Ok(dir()?.join("models").join(file))
}

/// Downloaded and ready to start.
pub fn ready() -> bool {
    installed()
}

fn installed() -> bool {
    server_exe().map(|p| p.exists()).unwrap_or(false)
        && model_path(MODEL_FILE).map(|p| p.exists()).unwrap_or(false)
        && model_path(MMPROJ_FILE).map(|p| p.exists()).unwrap_or(false)
}

#[derive(Serialize)]
pub struct Status {
    supported: bool,
    installed: bool,
    running: bool,
    installing: bool,
    model: &'static str,
}

#[tauri::command]
pub fn brain_status() -> Status {
    Status {
        supported: cfg!(target_os = "windows"),
        installed: installed(),
        running: SERVER.lock().unwrap().is_some(),
        installing: *INSTALLING.lock().unwrap(),
        model: "Qwen3.5-4B",
    }
}

// --- Install -----------------------------------------------------------------------------

static INSTALLING: Mutex<bool> = Mutex::new(false);

#[derive(Serialize, Clone)]
struct Progress {
    /// What is downloading ("Bond's brain", "Engine").
    what: String,
    done: u64,
    total: u64,
}

/// Download the engine and model (about 3.4 GB; resumes if interrupted). Emits
/// `brain-progress` while it works.
#[tauri::command]
pub async fn brain_install(app: AppHandle) -> Result<(), String> {
    if !cfg!(target_os = "windows") {
        return Err("Bond's own brain runs on Windows for now.".into());
    }
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
    let models = dir()?.join("models");
    std::fs::create_dir_all(&models).map_err(|e| e.to_string())?;
    for file in [MODEL_FILE, MMPROJ_FILE] {
        let dest = models.join(file);
        if !dest.exists() {
            download(app, &http, &format!("{MODEL_REPO}/{file}"), &dest, "Bond's brain").await?;
        }
    }
    if !server_exe()?.exists() {
        let target = engine_dir()?;
        std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
        let zip_path = dir()?.join("engine.zip");
        download(app, &http, &engine_archive(), &zip_path, "Engine").await?;
        let (zp, t) = (zip_path.clone(), target.clone());
        tauri::async_runtime::spawn_blocking(move || unzip(&zp, &t)).await.map_err(|e| e.to_string())??;
        let _ = std::fs::remove_file(&zip_path);
        if !server_exe()?.exists() {
            return Err("The engine download didn't contain llama-server.".into());
        }
    }
    Ok(())
}

/// Stream a file to disk, resuming a partial download.
pub(crate) async fn download(app: &AppHandle, http: &reqwest::Client, url: &str, dest: &Path, what: &str) -> Result<(), String> {
    use std::io::Write;
    let part = dest.with_extension("part");
    let have = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    let mut req = http.get(url);
    if have > 0 {
        req = req.header("Range", format!("bytes={have}-"));
    }
    let mut res = req.send().await.map_err(|e| format!("Download failed: {e}"))?;
    let status = res.status();
    if !status.is_success() {
        return Err(format!("Download failed ({status}) for {url}"));
    }
    let resumed = status.as_u16() == 206;
    let mut done = if resumed { have } else { 0 };
    let total = done + res.content_length().unwrap_or(0);
    let mut out = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(resumed)
        .truncate(!resumed)
        .open(&part)
        .map_err(|e| e.to_string())?;
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    while let Some(chunk) = res.chunk().await.map_err(|e| format!("Download interrupted: {e}"))? {
        out.write_all(&chunk).map_err(|e| e.to_string())?;
        done += chunk.len() as u64;
        if last_emit.elapsed() > Duration::from_millis(250) {
            last_emit = Instant::now();
            let _ = app.emit("brain-progress", Progress { what: what.into(), done, total });
        }
    }
    out.flush().map_err(|e| e.to_string())?;
    drop(out);
    let _ = app.emit("brain-progress", Progress { what: what.into(), done, total });
    std::fs::rename(&part, dest).map_err(|e| e.to_string())
}

/// Unpack an archive flat into `target` (the release zips keep everything at the top level).
fn unzip(zip_path: &Path, target: &Path) -> Result<(), String> {
    let f = std::fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(f).map_err(|e| format!("Bad engine archive: {e}"))?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        if entry.is_dir() {
            continue;
        }
        // Only the file name: never write outside the engine folder.
        let Some(name) = entry.enclosed_name().and_then(|p| p.file_name().map(|n| n.to_owned())) else { continue };
        let mut out = std::fs::File::create(target.join(name)).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// --- Run ---------------------------------------------------------------------------------

struct Server {
    child: Child,
    port: u16,
    last_used: Instant,
    /// The model has finished loading (until then the engine answers "Loading model").
    ready: bool,
}

static SERVER: Mutex<Option<Server>> = Mutex::new(None);
/// One start at a time (opening the Ask box and asking right away both want it).
static STARTING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Start the engine if it isn't running (loads the model onto the GPU, a few seconds).
#[tauri::command]
pub async fn brain_warm() -> Result<(), String> {
    port().await.map(|_| ())
}

/// Start the engine and have it read `system` now, so the next request with these
/// instructions only reads its new words. Reading Bond's 1,900-token instructions takes
/// ~15 s on this laptop's GPU; a request that finds them already read starts in ~1 s.
pub async fn prime(system: &str) -> Result<(), String> {
    chat(system, "", None, None, 1).await.map(|_| ())
}

/// The engine's process id while it's running.
pub fn running_pid() -> Option<u32> {
    SERVER.lock().unwrap().as_ref().map(|s| s.child.id())
}

/// Stop the engine now and free the GPU.
#[tauri::command]
pub fn brain_stop() {
    if let Some(mut s) = SERVER.lock().unwrap().take() {
        let _ = s.child.kill();
        let _ = s.child.wait();
    }
}

/// The port of a running, healthy engine; starts it if needed. Every caller gets a port
/// only once the model is loaded: a request that arrives while it loads waits for it.
async fn port() -> Result<u16, String> {
    if let Some(p) = ready_port() {
        return Ok(p);
    }
    let _guard = STARTING.lock().await;
    if let Some(p) = ready_port() {
        return Ok(p);
    }
    if !installed() {
        return Err("Bond's brain isn't set up yet — download it in Dashboard → Settings.".into());
    }
    brain_stop(); // an engine that is running but never got ready is no use
    // Second try with less GPU memory (a game, OBS or a browser may be sharing the card).
    let mut why = String::new();
    for (attempt, (ctx, offload)) in [(CONTEXT, true), (8192, false)].into_iter().enumerate() {
        let port = free_port()?;
        let child = spawn(port, ctx, offload)?;
        *SERVER.lock().unwrap() = Some(Server { child, port, last_used: Instant::now(), ready: false });
        match wait_until_ready(port).await {
            Ok(()) => {
                if let Some(s) = SERVER.lock().unwrap().as_mut() {
                    s.ready = true;
                    s.last_used = Instant::now();
                }
                if attempt > 0 {
                    crate::diag::log("brain: started on the smaller setting");
                }
                return Ok(port);
            }
            Err(e) => {
                why = e;
                crate::diag::log(&format!("brain: start failed ({why}){}", if attempt == 0 { "; trying again with less GPU memory" } else { "" }));
                brain_stop();
            }
        }
    }
    Err(why)
}

/// Wait for the model to load (/health answers 503 until it's ready).
async fn wait_until_ready(port: u16) -> Result<(), String> {
    let http = reqwest::Client::new();
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        tokio::time::sleep(Duration::from_millis(300)).await;
        if alive().is_none() {
            return Err(format!("Bond's brain stopped while starting{}. Your GPU may be out of memory: close a game or heavy app (OBS, a browser with video) and try again.", engine_failure()));
        }
        if let Ok(r) = http.get(format!("http://127.0.0.1:{port}/health")).send().await {
            if r.status().is_success() {
                return Ok(());
            }
        }
        if Instant::now() > deadline {
            return Err("Bond's brain took too long to start.".into());
        }
    }
}

/// The engine's own reason for stopping, from the end of its log (": out of memory…"), or "".
fn engine_failure() -> String {
    let Ok(dir) = dir() else { return String::new() };
    let Ok(log) = std::fs::read_to_string(dir.join("engine.log")) else { return String::new() };
    let plain: String = {
        // Drop the colour codes the engine writes.
        let mut out = String::new();
        let mut chars = log.chars().peekable();
        while let Some(c) = chars.next() {
            if c == '\u{1b}' {
                for d in chars.by_ref() {
                    if d.is_ascii_alphabetic() {
                        break;
                    }
                }
            } else {
                out.push(c);
            }
        }
        out
    };
    plain
        .lines()
        .rev()
        .find(|l| {
            let l = l.to_lowercase();
            l.contains("out of memory") || l.contains("failed to") || l.contains("error") || l.contains("unable to")
        })
        .map(|l| format!(": {}", l.trim().chars().take(160).collect::<String>()))
        .unwrap_or_default()
}

/// The port of an engine whose model has finished loading. Marks it as used.
fn ready_port() -> Option<u16> {
    let p = alive()?;
    SERVER.lock().unwrap().as_ref().filter(|s| s.ready).map(|_| p)
}

/// The running server's port, if its process is still alive. Marks it as used.
fn alive() -> Option<u16> {
    let mut guard = SERVER.lock().unwrap();
    let s = guard.as_mut()?;
    if !matches!(s.child.try_wait(), Ok(None)) {
        *guard = None;
        return None;
    }
    s.last_used = Instant::now();
    Some(s.port)
}

fn free_port() -> Result<u16, String> {
    let l = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    l.local_addr().map(|a| a.port()).map_err(|e| e.to_string())
}

fn spawn(port: u16, ctx: u32, mmproj_on_gpu: bool) -> Result<Child, String> {
    let log = std::fs::File::create(dir()?.join("engine.log")).ok();
    let mut cmd = Command::new(server_exe()?);
    cmd.current_dir(engine_dir()?)
        .arg("--model")
        .arg(model_path(MODEL_FILE)?)
        .arg("--mmproj")
        .arg(model_path(MMPROJ_FILE)?)
        .args(["--host", "127.0.0.1", "--port", &port.to_string()])
        .args(["--ctx-size", &ctx.to_string()])
        .args(["--n-gpu-layers", "99", "--parallel", "1", "--jinja", "--no-webui"])
        // Answers come straight away: Bond's requests are short, thinking only slows them.
        .args(["--reasoning", "off"])
        .args(if mmproj_on_gpu { &[][..] } else { &["--no-mmproj-offload"][..] })
        .stdin(Stdio::null())
        .stdout(Stdio::null());
    match log {
        Some(f) => cmd.stderr(f),
        None => cmd.stderr(Stdio::null()),
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let child = cmd.spawn().map_err(|e| format!("Couldn't start Bond's brain: {e}"))?;
    #[cfg(windows)]
    end_with_us(&child);
    Ok(child)
}

/// Put the engine in a job object that is closed (killing it) when SelfGlance exits.
#[cfg(windows)]
fn end_with_us(child: &Child) {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    // One job for the app's lifetime; its handle is never closed, so the OS closes it at exit.
    static JOB: OnceLock<usize> = OnceLock::new();
    let job = *JOB.get_or_init(|| unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return 0;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        job as usize
    });
    if job != 0 {
        unsafe {
            AssignProcessToJobObject(job as _, child.as_raw_handle() as _);
        }
    }
}

fn spawn_idle_stop() {
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_secs(30));
        let idle = SERVER.lock().unwrap().as_ref().map(|s| s.last_used.elapsed() > IDLE_STOP).unwrap_or(false);
        if idle {
            brain_stop();
        }
    });
}

// --- Ask ---------------------------------------------------------------------------------

/// One chat turn. `image` is a base64 JPEG; `schema` forces the reply to match it.
pub async fn chat(system: &str, prompt: &str, image: Option<&str>, schema: Option<&Value>, max_tokens: u32) -> Result<String, String> {
    let port = port().await?;
    let mut content = vec![json!({"type": "text", "text": prompt})];
    if let Some(b64) = image {
        content.insert(0, json!({"type": "image_url", "image_url": {"url": format!("data:image/jpeg;base64,{b64}")}}));
    }
    let mut body = json!({
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": content},
        ],
        "max_tokens": max_tokens,
        // Qwen's recommended non-thinking settings.
        "temperature": 0.7,
        "top_p": 0.8,
        "top_k": 20,
        "chat_template_kwargs": {"enable_thinking": false},
    });
    if let Some(s) = schema {
        body["response_format"] = json!({"type": "json_schema", "json_schema": {"name": "reply", "schema": s}});
        body["temperature"] = json!(0.0);
    }
    let res = reqwest::Client::new()
        .post(format!("http://127.0.0.1:{port}/v1/chat/completions"))
        .timeout(Duration::from_secs(180))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Bond's brain didn't answer: {e}"))?;
    let status = res.status();
    let v: Value = res.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let msg = v["error"]["message"].as_str().unwrap_or("request failed");
        return Err(format!("Bond's brain had a problem: {msg}"));
    }
    alive(); // a long answer counts as use
    Ok(v["choices"][0]["message"]["content"].as_str().unwrap_or("").trim().to_string())
}

/// Set by "stop": the answer being streamed is dropped, which also stops the engine writing it.
static STREAM_CANCEL: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Stop the answer that is streaming now, if any.
pub fn cancel_stream() {
    STREAM_CANCEL.store(true, std::sync::atomic::Ordering::SeqCst);
}

/// One chat turn in plain text, handed over as it is written: `on_text` gets each new bit, so Bond can
/// start speaking the first sentence while the rest is still coming. Returns the whole answer. `schema`
/// forces the reply's shape as in `chat`; `on_text` returns false to stop early.
pub async fn chat_stream(system: &str, prompt: &str, schema: Option<&Value>, max_tokens: u32, mut on_text: impl FnMut(&str) -> bool) -> Result<String, String> {
    use std::sync::atomic::Ordering;
    let port = port().await?;
    STREAM_CANCEL.store(false, Ordering::SeqCst);
    let mut body = json!({
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ],
        "max_tokens": max_tokens,
        "stream": true,
        "temperature": 0.7,
        "top_p": 0.8,
        "top_k": 20,
        "chat_template_kwargs": {"enable_thinking": false},
    });
    if let Some(s) = schema {
        body["response_format"] = json!({"type": "json_schema", "json_schema": {"name": "reply", "schema": s}});
        body["temperature"] = json!(0.0);
    }
    let mut res = reqwest::Client::new().post(format!("http://127.0.0.1:{port}/v1/chat/completions")).timeout(Duration::from_secs(180)).json(&body).send().await.map_err(|e| format!("Bond's brain didn't answer: {e}"))?;
    if !res.status().is_success() {
        let v: Value = res.json().await.unwrap_or(Value::Null);
        return Err(format!("Bond's brain had a problem: {}", v["error"]["message"].as_str().unwrap_or("request failed")));
    }
    let mut all = String::new();
    let mut pending: Vec<u8> = Vec::new();
    'read: while let Some(chunk) = res.chunk().await.map_err(|e| format!("Bond's brain stopped mid-answer: {e}"))? {
        if STREAM_CANCEL.load(Ordering::SeqCst) {
            break; // dropping the response closes the connection, and the engine stops writing
        }
        pending.extend_from_slice(&chunk);
        // The answer arrives as lines of "data: {json}"; a line may be split across chunks.
        while let Some(end) = pending.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = pending.drain(..=end).collect();
            match stream_delta(&String::from_utf8_lossy(&line)) {
                Delta::Text(t) => {
                    all.push_str(&t);
                    // "Enough": the caller has what it needs, so the engine stops writing.
                    if !on_text(&t) {
                        break 'read;
                    }
                }
                Delta::Done => break 'read,
                Delta::Nothing => {}
            }
        }
    }
    alive();
    Ok(all.trim().to_string())
}

#[derive(Debug, PartialEq)]
enum Delta {
    Text(String),
    Done,
    Nothing,
}

/// What one line of the engine's stream carries.
fn stream_delta(line: &str) -> Delta {
    let Some(data) = line.trim().strip_prefix("data:") else { return Delta::Nothing };
    let data = data.trim();
    if data == "[DONE]" {
        return Delta::Done;
    }
    match serde_json::from_str::<Value>(data).ok().and_then(|v| v["choices"][0]["delta"]["content"].as_str().map(String::from)) {
        Some(t) if !t.is_empty() => Delta::Text(t),
        _ => Delta::Nothing,
    }
}

#[cfg(test)]
mod stream_tests {
    use super::*;

    #[test]
    fn reads_the_engines_stream_lines() {
        assert_eq!(stream_delta(r#"data: {"choices":[{"delta":{"content":"Hel"}}]}"#), Delta::Text("Hel".into()));
        assert_eq!(stream_delta("data: {\"choices\":[{\"delta\":{\"content\":\" lo\"}}]}\r\n"), Delta::Text(" lo".into()));
        assert_eq!(stream_delta(r#"data: {"choices":[{"delta":{"role":"assistant","content":null}}]}"#), Delta::Nothing);
        assert_eq!(stream_delta(r#"data: {"choices":[{"delta":{},"finish_reason":"stop"}]}"#), Delta::Nothing);
        assert_eq!(stream_delta(""), Delta::Nothing);
        assert_eq!(stream_delta(": keep-alive"), Delta::Nothing);
        assert_eq!(stream_delta("data: [DONE]"), Delta::Done);
    }
}
