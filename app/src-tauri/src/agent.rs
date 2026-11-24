// Bond doing small jobs on the laptop. Every action is one of a fixed menu, carried out by plain
// code here. The AI only picks an item from the menu and fills in a name; it never writes a
// command, a path to run, or keystrokes of its own.
//
//   open_app / focus_app / minimize_app / close_app   apps by name (close = like its ×; it can still ask to save)
//   open_url / web_search                              http(s) pages, in the default or a named browser
//   open_folder                                        Downloads, Documents, … or a folder that exists
//   tab                                                new / close / next / previous / reopen a browser tab
//   media / set_volume / show_desktop
//   system_status / system_specs                       battery, memory, disks; what the laptop is made of
//   find_files                                         names only, read-only, in your home folder and project folders
//   open_project                                       a folder from your project folders, opened in Claude Code,
//                                                      VS Code, a terminal or File Explorer
//
// Nothing here deletes, ends programs, runs a command the AI wrote, types, clicks or reads the screen.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const MAX_ACTIONS: usize = 4;
const MAX_INFO_CHARS: usize = 4000;

#[derive(Deserialize, Debug, Clone)]
#[serde(tag = "do", rename_all = "snake_case")]
pub enum Action {
    OpenApp { name: String },
    FocusApp { name: String },
    MinimizeApp { #[serde(default)] name: String },
    CloseApp { #[serde(default)] name: String },
    OpenUrl { url: String, #[serde(default)] browser: Option<String> },
    WebSearch { query: String, #[serde(default)] browser: Option<String> },
    OpenFolder { name: String },
    Tab { key: String },
    Media { key: String },
    SetVolume { percent: f64 },
    ShowDesktop,
    SystemStatus,
    SystemSpecs,
    FindFiles { query: String },
    OpenProject { name: String, #[serde(default)] tool: String },
}

/// What came of a plan: short lines for what was done, and longer text to read.
#[derive(Serialize, Default)]
pub struct Outcome {
    pub done: Vec<String>,
    pub info: Vec<String>,
}

/// Run actions from the frontend's own rules.
#[tauri::command]
pub async fn agent_run(app: AppHandle, actions: Vec<Action>) -> Result<Outcome, String> {
    run(&app, actions).await
}

/// "Stop": stop an answer Bond is in the middle of writing.
#[tauri::command]
pub fn agent_cancel() {
    crate::brain::cancel_stream();
}

/// Run actions one after another; stop at the first failure so later steps never act on the wrong window.
pub async fn run(app: &AppHandle, actions: Vec<Action>) -> Result<Outcome, String> {
    let mut out = Outcome::default();
    for action in actions.into_iter().take(MAX_ACTIONS) {
        let a = app.clone();
        let step = tauri::async_runtime::spawn_blocking(move || perform(&a, action)).await.map_err(|e| e.to_string())?;
        match step {
            Ok(effect) => {
                let settle = effect.settle;
                effect.add_to(&mut out);
                if settle > 0 {
                    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(Duration::from_millis(settle))).await;
                }
            }
            Err(err) if out.done.is_empty() && out.info.is_empty() => return Err(err),
            Err(err) => {
                out.done.push(format!("Stopped: {err}"));
                break;
            }
        }
    }
    Ok(out)
}

/// What one action did: a short line, maybe text to read, and how long to let it settle.
struct Effect {
    line: String,
    info: Option<String>,
    settle: u64,
}

impl Effect {
    fn line(line: impl Into<String>, settle: u64) -> Self {
        Effect { line: line.into(), info: None, settle }
    }
    fn info(text: String) -> Self {
        Effect { line: String::new(), info: Some(clip(&text)), settle: 0 }
    }
    fn add_to(self, out: &mut Outcome) {
        if !self.line.is_empty() {
            out.done.push(self.line);
        }
        if let Some(i) = self.info.filter(|i| !i.trim().is_empty()) {
            out.info.push(i);
        }
    }
}

fn clip(text: &str) -> String {
    if text.chars().count() <= MAX_INFO_CHARS {
        return text.to_string();
    }
    let head: String = text.chars().take(MAX_INFO_CHARS).collect();
    format!("{head}\n…")
}

fn perform(app: &AppHandle, action: Action) -> Result<Effect, String> {
    match action {
        Action::OpenApp { name } => {
            // Already running, even minimized? Bring it forward instead of starting it again.
            if let Ok(title) = crate::system::focus_app(&name) {
                return Ok(Effect::line(format!("Brought {title} to the front"), 800));
            }
            let n = open_app(&name)?;
            crate::system::focus_app_wait(&name, Duration::from_secs(3));
            Ok(Effect::line(format!("Opened {n}"), 1000))
        }
        Action::FocusApp { name } => crate::system::focus_app(&name).map(|t| Effect::line(format!("Brought {t} to the front"), 800)),
        Action::MinimizeApp { name } => crate::system::minimize_app(&name).map(|n| Effect::line(format!("Minimized {n}"), 400)),
        Action::CloseApp { name } => {
            let (pids, shown) = crate::system::which_app(&name)?;
            crate::system::close_windows(&pids);
            if crate::system::wait_closed(&pids, Duration::from_millis(2500)) {
                Ok(Effect::line(format!("Closed {shown}"), 300))
            } else {
                // It is asking about unsaved work: that is your call, in its own window.
                crate::system::bring_to_front(&pids);
                Ok(Effect::line(format!("{shown} is asking about unsaved work. Answer it there."), 0))
            }
        }
        Action::OpenUrl { url, browser } => {
            let url = clean_url(&url)?;
            let in_ = open_url_in(browser.as_deref(), &url)?;
            Ok(Effect::line(format!("Opened {}{in_}", short(&url)), 1500))
        }
        Action::WebSearch { query, browser } => {
            let query = query.trim();
            if query.is_empty() {
                return Err("Nothing to search for.".into());
            }
            let url = reqwest::Url::parse_with_params("https://www.google.com/search", &[("q", query)]).map_err(|e| e.to_string())?;
            let in_ = open_url_in(browser.as_deref(), url.as_str())?;
            Ok(Effect::line(format!("Searched for “{query}”{in_}"), 1500))
        }
        Action::OpenFolder { name } => {
            let (label, path) = folder(app, &name)?;
            open_target(&path.to_string_lossy())?;
            Ok(Effect::line(format!("Opened {label}"), 800))
        }
        Action::Tab { key } => {
            let (mods, k, label): (&[Key], Key, &str) = match key.trim().to_lowercase().as_str() {
                "new" => (&[Key::Control], Key::Unicode('t'), "New tab"),
                "close" => (&[Key::Control], Key::Unicode('w'), "Closed the tab"),
                "next" => (&[Key::Control], Key::Tab, "Next tab"),
                "previous" | "prev" => (&[Key::Control, Key::Shift], Key::Tab, "Previous tab"),
                "reopen" => (&[Key::Control, Key::Shift], Key::Unicode('t'), "Reopened the tab"),
                other => return Err(format!("I don't know the tab action “{other}”.")),
            };
            press_combo(mods, k)?;
            Ok(Effect::line(label, 300))
        }
        Action::Media { key } => {
            let (k, label) = match key.to_lowercase().replace([' ', '-'], "_").as_str() {
                "play_pause" | "play" | "pause" => (Key::MediaPlayPause, "Play/pause"),
                "next" | "next_track" => (Key::MediaNextTrack, "Next track"),
                "previous" | "prev" | "previous_track" => (Key::MediaPrevTrack, "Previous track"),
                "volume_up" => (Key::VolumeUp, "Volume up"),
                "volume_down" => (Key::VolumeDown, "Volume down"),
                "mute" | "unmute" => (Key::VolumeMute, "Mute toggled"),
                other => return Err(format!("Unknown media key “{other}”.")),
            };
            let mut e = input()?;
            // Volume steps are 2% each on Windows; press a few times so the change is noticeable.
            let times = if matches!(k, Key::VolumeUp | Key::VolumeDown) { 5 } else { 1 };
            for _ in 0..times {
                e.key(k, Direction::Click).map_err(|e| e.to_string())?;
            }
            Ok(Effect::line(label, 200))
        }
        Action::SetVolume { percent } => {
            let p = percent.clamp(0.0, 100.0);
            let mut e = input()?;
            for _ in 0..50 {
                e.key(Key::VolumeDown, Direction::Click).map_err(|e| e.to_string())?;
            }
            for _ in 0..(p / 2.0).round() as u32 {
                e.key(Key::VolumeUp, Direction::Click).map_err(|e| e.to_string())?;
            }
            Ok(Effect::line(format!("Volume set to {:.0}%", (p / 2.0).round() * 2.0), 200))
        }
        Action::ShowDesktop => {
            press_combo(&[Key::Meta], Key::Unicode('d'))?;
            Ok(Effect::line("Showed the desktop", 500))
        }
        Action::SystemStatus => Ok(Effect::info(crate::system::status())),
        Action::SystemSpecs => Ok(Effect::info(crate::system::specs())),
        Action::FindFiles { query } => Ok(Effect::info(find_files(app, &query)?)),
        Action::OpenProject { name, tool } => open_project(&name, &tool),
    }
}

fn input() -> Result<Enigo, String> {
    Enigo::new(&Settings::default()).map_err(|e| format!("Can't use the keyboard: {e}"))
}

/// A fixed shortcut as real key presses (virtual-key codes), which every app treats as a shortcut.
fn press_combo(mods: &[Key], key: Key) -> Result<(), String> {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{keybd_event, KEYEVENTF_KEYUP};
    let vk = |k: Key| -> Option<u8> {
        Some(match k {
            Key::Control => 0x11,
            Key::Shift => 0x10,
            Key::Meta => 0x5B,
            Key::Tab => 0x09,
            Key::Unicode(c) if c.is_ascii_alphabetic() => c.to_ascii_uppercase() as u8,
            _ => return None,
        })
    };
    let codes: Vec<u8> = mods.iter().map(|m| vk(*m)).collect::<Option<_>>().ok_or("Unknown key.")?;
    let code = vk(key).ok_or("Unknown key.")?;
    let pause = || std::thread::sleep(Duration::from_millis(25));
    unsafe {
        for m in &codes {
            keybd_event(*m, 0, 0, 0);
            pause();
        }
        keybd_event(code, 0, 0, 0);
        pause();
        keybd_event(code, 0, KEYEVENTF_KEYUP, 0);
        pause();
        for m in codes.iter().rev() {
            keybd_event(*m, 0, KEYEVENTF_KEYUP, 0);
        }
    }
    Ok(())
}

// --- Project folders and finding files ----------------------------------------------------

/// Where your projects live (Settings → Bond). Only folders that exist are kept.
static PROJECT_ROOTS: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

/// Folders never searched or opened as projects.
const SKIP: &[&str] = &["node_modules", "appdata", "$recycle.bin", "system volume information", "target", "windows", "program files", "program files (x86)", "programdata", "quarantine", "delete", ".git"];

fn skipped(name: &str) -> bool {
    let n = name.to_lowercase();
    n.starts_with('.') || n.starts_with('$') || SKIP.contains(&n.as_str())
}

/// Set from the overlay when settings load or change. Anything that isn't an existing folder, or is
/// a system folder, is dropped.
#[tauri::command]
pub fn set_project_roots(roots: Vec<String>) -> Vec<String> {
    let mut kept = Vec::new();
    for r in roots.iter().take(5) {
        let p = PathBuf::from(r.trim());
        let lower = p.to_string_lossy().to_lowercase();
        if !p.is_absolute() || !p.is_dir() || lower.contains("\\windows") || lower.contains("\\program") {
            continue;
        }
        kept.push(p);
    }
    let shown = kept.iter().map(|p| p.display().to_string()).collect();
    *PROJECT_ROOTS.lock().unwrap() = kept;
    shown
}

fn project_roots() -> Vec<PathBuf> {
    PROJECT_ROOTS.lock().unwrap().clone()
}

/// Lower-case letters and digits only, so "Self Glance", "selfglance" and "self-glance" are the same name.
fn squash(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).flat_map(|c| c.to_lowercase()).collect()
}

/// Project folders: the folders in each project root, and the folders inside those.
fn project_folders() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let subdirs = |d: &Path| -> Vec<PathBuf> {
        std::fs::read_dir(d)
            .map(|it| it.flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_dir()) && !skipped(&e.file_name().to_string_lossy())).map(|e| e.path()).collect())
            .unwrap_or_default()
    };
    for root in project_roots() {
        for d in subdirs(&root) {
            out.extend(subdirs(&d));
            out.push(d);
        }
    }
    out
}

/// The project folders that answer to `name`: exact names first; otherwise names containing it.
fn match_projects(name: &str, folders: &[PathBuf]) -> Vec<PathBuf> {
    let q = squash(name);
    if q.len() < 2 {
        return Vec::new();
    }
    let base = |p: &PathBuf| squash(&p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default());
    let exact: Vec<PathBuf> = folders.iter().filter(|p| base(p) == q).cloned().collect();
    if !exact.is_empty() {
        return exact;
    }
    folders.iter().filter(|p| q.len() >= 3 && base(p).contains(&q)).cloned().collect()
}

fn open_project(name: &str, tool: &str) -> Result<Effect, String> {
    if project_roots().is_empty() {
        return Err("Tell me where your projects are first: Settings → Bond → Project folders.".into());
    }
    let found = match_projects(name, &project_folders());
    let dir = match found.as_slice() {
        [] => return Err(format!("I couldn't find a project folder called “{}”.", name.trim())),
        [one] => one.clone(),
        many => {
            let list: Vec<String> = many.iter().take(6).map(|p| p.display().to_string()).collect();
            return Ok(Effect::info(format!("More than one folder is called that. Which one?\n{}", list.join("\n"))));
        }
    };
    let shown = dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    // The folder is given as the working directory, never inside a command line, so a folder's
    // name can't add to what runs. What runs is fixed: claude, VS Code, PowerShell, or File Explorer.
    match tool.trim().to_lowercase().as_str() {
        "claude" | "claude code" => {
            new_console("cmd", &["/k", "claude"], &dir)?;
            Ok(Effect::line(format!("Opened Claude Code in {shown}"), 0))
        }
        "code" | "vs code" | "vscode" => {
            open_in_vscode(&dir)?;
            Ok(Effect::line(format!("Opened {shown} in VS Code"), 0))
        }
        "terminal" | "powershell" | "cmd" => {
            new_console("powershell", &["-NoExit"], &dir)?;
            Ok(Effect::line(format!("Opened a terminal in {shown}"), 0))
        }
        _ => {
            open_target(&dir.to_string_lossy())?;
            Ok(Effect::line(format!("Opened {shown}"), 0))
        }
    }
}

/// A program in its own new console window, started in `dir`.
fn new_console(program: &str, args: &[&str], dir: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
    std::process::Command::new(program)
        .args(args)
        .current_dir(dir)
        .creation_flags(CREATE_NEW_CONSOLE)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Couldn't open it: {e}"))
}

fn open_in_vscode(dir: &Path) -> Result<(), String> {
    let candidates = [
        std::env::var("LOCALAPPDATA").map(|l| PathBuf::from(l).join(r"Programs\Microsoft VS Code\Code.exe")).ok(),
        std::env::var("ProgramFiles").map(|p| PathBuf::from(p).join(r"Microsoft VS Code\Code.exe")).ok(),
    ];
    let exe = candidates.into_iter().flatten().find(|p| p.exists()).ok_or("I couldn't find VS Code on this laptop.")?;
    std::process::Command::new(exe).arg(dir).spawn().map(|_| ()).map_err(|e| format!("Couldn't start VS Code: {e}"))
}

/// Files and folders whose names contain every word of `query`, newest first, in your home folder
/// and your project folders. Names only: no file is opened or read.
fn find_files(app: &AppHandle, query: &str) -> Result<String, String> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Err("What should I look for?".into());
    }
    let words: Vec<&str> = q.split_whitespace().collect();
    let mut roots = vec![app.path().home_dir().map_err(|e| e.to_string())?];
    roots.extend(project_roots());
    let mut found: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    let mut seen = 0u32;
    'roots: for root in &roots {
        let mut stack = vec![root.clone()];
        while let Some(d) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&d) else { continue };
            for e in entries.flatten() {
                seen += 1;
                if seen > 400_000 {
                    break 'roots;
                }
                let name = e.file_name().to_string_lossy().to_lowercase();
                let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
                if is_dir && skipped(&name) {
                    continue;
                }
                if words.iter().all(|w| name.contains(w)) && !found.iter().any(|(_, p)| *p == e.path()) {
                    let t = e.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
                    found.push((t, e.path()));
                }
                if is_dir {
                    stack.push(e.path());
                }
            }
        }
    }
    if found.is_empty() {
        return Ok(format!("Nothing called “{}” in your home folder or project folders.", query.trim()));
    }
    found.sort_by(|a, b| b.0.cmp(&a.0));
    let total = found.len();
    let mut lines: Vec<String> = found.iter().take(12).map(|(_, p)| p.display().to_string()).collect();
    if total > 12 {
        lines.push(format!("…and {} more.", total - 12));
    }
    Ok(format!("Found {total}:\n{}", lines.join("\n")))
}

// --- Web, folders -------------------------------------------------------------------------

fn clean_url(url: &str) -> Result<String, String> {
    let url = url.trim();
    let url = if url.contains("://") { url.to_string() } else { format!("https://{url}") };
    let parsed = reqwest::Url::parse(&url).map_err(|_| format!("“{url}” isn't a web address."))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Bond only opens web pages (http/https).".into());
    }
    Ok(parsed.to_string())
}

fn short(url: &str) -> String {
    reqwest::Url::parse(url).ok().and_then(|u| u.host_str().map(|h| h.trim_start_matches("www.").to_string())).unwrap_or_else(|| url.to_string())
}

fn folder(app: &AppHandle, name: &str) -> Result<(String, PathBuf), String> {
    let p = app.path();
    let n = name.trim().to_lowercase();
    let (label, dir) = match n.trim_end_matches(" folder") {
        "downloads" | "download" => ("Downloads", p.download_dir()),
        "documents" | "document" | "docs" => ("Documents", p.document_dir()),
        "desktop" => ("Desktop", p.desktop_dir()),
        "pictures" | "photos" | "images" => ("Pictures", p.picture_dir()),
        "screenshots" | "screenshot" => ("Screenshots", p.picture_dir().map(|d| d.join("Screenshots"))),
        "music" => ("Music", p.audio_dir()),
        "videos" | "video" => ("Videos", p.video_dir()),
        "home" | "user" => ("your home folder", p.home_dir()),
        _ => {
            // "D drive", "d:"
            if let Some(c) = drive_letter(&n) {
                let path = PathBuf::from(format!("{c}:\\"));
                return if path.is_dir() { Ok((format!("{} drive", c.to_ascii_uppercase()), path)) } else { Err(format!("There's no {} drive.", c.to_ascii_uppercase())) };
            }
            let path = PathBuf::from(name.trim());
            return if path.is_absolute() && path.is_dir() { Ok((path.to_string_lossy().to_string(), path)) } else { Err(format!("I don't know a folder called “{name}”.")) };
        }
    };
    Ok((label.to_string(), dir.map_err(|e| e.to_string())?))
}

/// "d drive", "d:", "drive d" → 'd'.
fn drive_letter(n: &str) -> Option<char> {
    let t = n.trim().trim_start_matches("my ").trim_start_matches("the ");
    let letter = t.strip_suffix(" drive").or_else(|| t.strip_suffix(':')).or_else(|| t.strip_suffix(":\\")).or_else(|| t.strip_prefix("drive "))?;
    let mut c = letter.trim().chars();
    match (c.next(), c.next()) {
        (Some(l), None) if l.is_ascii_alphabetic() => Some(l.to_ascii_lowercase()),
        _ => None,
    }
}

/// The browsers he can be told to use ("search in Brave").
fn browser_key(name: &str) -> Option<&'static str> {
    let n = name.trim().to_lowercase();
    ["brave", "chrome", "edge", "firefox", "opera", "vivaldi"].into_iter().find(|k| n.contains(k))
}

/// Where a browser is installed on this PC, if it is.
fn browser_path(key: &str) -> Option<(&'static str, PathBuf)> {
    let (label, files): (&'static str, &[&str]) = match key {
        "brave" => ("Brave", &[r"%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe", r"%ProgramFiles(x86)%\BraveSoftware\Brave-Browser\Application\brave.exe", r"%LOCALAPPDATA%\BraveSoftware\Brave-Browser\Application\brave.exe"]),
        "chrome" => ("Chrome", &[r"%ProgramFiles%\Google\Chrome\Application\chrome.exe", r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe", r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"]),
        "edge" => ("Edge", &[r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe", r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"]),
        "firefox" => ("Firefox", &[r"%ProgramFiles%\Mozilla Firefox\firefox.exe", r"%ProgramFiles(x86)%\Mozilla Firefox\firefox.exe"]),
        "opera" => ("Opera", &[r"%LOCALAPPDATA%\Programs\Opera\opera.exe", r"%ProgramFiles%\Opera\opera.exe"]),
        "vivaldi" => ("Vivaldi", &[r"%LOCALAPPDATA%\Vivaldi\Application\vivaldi.exe", r"%ProgramFiles%\Vivaldi\Application\vivaldi.exe"]),
        _ => return None,
    };
    files.iter().find_map(|f| {
        let mut p = f.to_string();
        for var in ["ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"] {
            if let Ok(v) = std::env::var(var) {
                p = p.replace(&format!("%{var}%"), &v);
            }
        }
        let path = PathBuf::from(p);
        path.exists().then_some((label, path))
    })
}

/// Open a web address in the default browser, or in the one the user named.
fn open_url_in(browser: Option<&str>, url: &str) -> Result<String, String> {
    let Some(name) = browser.map(str::trim).filter(|b| !b.is_empty()) else {
        open_target(url)?;
        return Ok(String::new());
    };
    let key = browser_key(name).ok_or_else(|| format!("I don't know the browser “{name}”. I can use Brave, Chrome, Edge, Firefox, Opera or Vivaldi."))?;
    let (label, exe) = browser_path(key).ok_or_else(|| format!("I couldn't find {key} on this laptop."))?;
    std::process::Command::new(exe).arg(url).spawn().map_err(|e| format!("Couldn't start {label}: {e}"))?;
    Ok(format!(" in {label}"))
}

/// Open a folder or URL with its default handler, without going through a shell.
pub(crate) fn open_target(target: &str) -> Result<(), String> {
    std::process::Command::new("explorer").arg(target).spawn().map(|_| ()).map_err(|e| format!("Couldn't open it: {e}"))
}

// --- Apps ---------------------------------------------------------------------------------

/// Installed apps as (display name, launch target), read once and cached.
static APPS: Mutex<Option<Vec<(String, String)>>> = Mutex::new(None);
static APPS_READ: Mutex<Option<Instant>> = Mutex::new(None);

/// Common names people say that differ from the Start-menu name.
const ALIASES: &[(&str, &str)] = &[
    ("chrome", "google chrome"),
    ("vs code", "visual studio code"),
    ("vscode", "visual studio code"),
    ("code", "visual studio code"),
    ("edge", "microsoft edge"),
    ("explorer", "file explorer"),
    ("files", "file explorer"),
    ("cmd", "command prompt"),
    ("store", "microsoft store"),
];

/// Apps that are web sites for most people; opened in the browser if not installed.
const SITES: &[(&str, &str)] = &[
    ("youtube", "https://www.youtube.com"),
    ("gmail", "https://mail.google.com"),
    ("github", "https://github.com"),
    ("chatgpt", "https://chatgpt.com"),
    ("claude", "https://claude.ai"),
    ("gemini", "https://gemini.google.com"),
    ("google", "https://www.google.com"),
    ("google drive", "https://drive.google.com"),
    ("google calendar", "https://calendar.google.com"),
    ("whatsapp", "https://web.whatsapp.com"),
    ("linkedin", "https://www.linkedin.com"),
    ("twitter", "https://x.com"),
];

fn open_app(name: &str) -> Result<String, String> {
    let wanted = name.trim().to_lowercase();
    if wanted.is_empty() {
        return Err("Which app?".into());
    }
    let wanted = ALIASES.iter().find(|(a, _)| *a == wanted).map(|(_, b)| b.to_string()).unwrap_or(wanted);
    if let Some((display, target)) = find_app(&wanted) {
        open_target(&target)?;
        return Ok(display);
    }
    if let Some((site, url)) = SITES.iter().find(|(s, _)| *s == wanted) {
        open_target(url)?;
        return Ok(title_case(site));
    }
    Err(not_found(name))
}

/// "I couldn't find …", with the apps it may have been, since speech mishears names ("Jed" for Zed).
fn not_found(name: &str) -> String {
    let close = {
        let mut cache = APPS.lock().unwrap();
        let apps = cache.get_or_insert_with(list_apps);
        sounds_like(name, apps.iter().map(|(n, _)| n.as_str()))
    };
    match close.as_slice() {
        [] => format!("I couldn't find an app called “{name}”."),
        [one] => format!("I couldn't find an app called “{name}”. Did you mean {one}? Say “open {one}”."),
        [a, b, ..] => format!("I couldn't find an app called “{name}”. Did you mean {a} or {b}?"),
    }
}

/// Letters speech recognition swaps for each other: a swap inside a group costs half.
const SOUND_GROUPS: &[&str] = &["jzsgcx", "bpv", "dt", "kcqg", "mn", "iye", "ou", "fv", "wv"];

/// App names within a small, sound-aware edit distance of what was heard, closest first (at most 2).
fn sounds_like<'a>(heard: &str, names: impl Iterator<Item = &'a str>) -> Vec<String> {
    let h: Vec<char> = squash(heard).chars().collect();
    if h.len() < 2 {
        return Vec::new();
    }
    let cost = |a: char, b: char| {
        if a == b {
            0.0
        } else if SOUND_GROUPS.iter().any(|g| g.contains(a) && g.contains(b)) {
            0.5
        } else {
            1.0
        }
    };
    let dist = |w: &[char]| {
        let mut prev: Vec<f32> = (0..=w.len()).map(|j| j as f32).collect();
        for (i, &a) in h.iter().enumerate() {
            let mut cur = vec![i as f32 + 1.0; w.len() + 1];
            for (j, &b) in w.iter().enumerate() {
                cur[j + 1] = (prev[j] + cost(a, b)).min(prev[j + 1] + 1.0).min(cur[j] + 1.0);
            }
            prev = cur;
        }
        prev[w.len()]
    };
    let allowed = (h.len() as f32 / 4.0).max(1.0);
    let mut found: Vec<(f32, String)> = Vec::new();
    for name in names {
        let whole: Vec<char> = squash(name).chars().collect();
        let first: Vec<char> = squash(name.split_whitespace().next().unwrap_or("")).chars().collect();
        let d = dist(&whole).min(if first.is_empty() { f32::MAX } else { dist(&first) });
        if d <= allowed && !found.iter().any(|(_, n)| n == name) {
            found.push((d, name.to_string()));
        }
    }
    found.sort_by(|a, b| a.0.total_cmp(&b.0));
    found.into_iter().take(2).map(|(_, n)| n).collect()
}

fn title_case(s: &str) -> String {
    let mut c = s.chars();
    c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
}

/// Best match: exact name, then a name starting with it, then a whole word inside it.
fn find_app(wanted: &str) -> Option<(String, String)> {
    let mut cache = APPS.lock().unwrap();
    if cache.is_none() {
        *cache = Some(list_apps());
        *APPS_READ.lock().unwrap() = Some(Instant::now());
    }
    if let Some(hit) = app_in(cache.as_ref().unwrap(), wanted) {
        return Some(hit);
    }
    // Maybe installed since the list was read: read it again (at most once a minute).
    let stale = APPS_READ.lock().unwrap().is_none_or(|t| t.elapsed() > Duration::from_secs(60));
    if !stale {
        return None;
    }
    let fresh = list_apps();
    *APPS_READ.lock().unwrap() = Some(Instant::now());
    if fresh.is_empty() {
        return None;
    }
    let hit = app_in(&fresh, wanted);
    *cache = Some(fresh);
    hit
}

fn app_in(apps: &[(String, String)], wanted: &str) -> Option<(String, String)> {
    let lower = |s: &str| s.to_lowercase();
    apps.iter()
        .find(|(n, _)| lower(n) == wanted)
        .or_else(|| apps.iter().find(|(n, _)| lower(n).starts_with(wanted)))
        .or_else(|| apps.iter().find(|(n, _)| lower(n).split(|c: char| !c.is_alphanumeric()).any(|w| w == wanted)))
        .or_else(|| apps.iter().find(|(n, _)| wanted.len() >= 4 && lower(n).contains(wanted)))
        .cloned()
}

/// Every app in the Start menu (desktop and Store apps alike), from Get-StartApps.
fn list_apps() -> Vec<(String, String)> {
    use std::os::windows::process::CommandExt;
    #[derive(Deserialize)]
    struct StartApp {
        #[serde(rename = "Name")]
        name: String,
        #[serde(rename = "AppID")]
        app_id: String,
    }
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", "Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress"])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .output();
    let Ok(out) = out else { return Vec::new() };
    let apps: Vec<StartApp> = serde_json::from_str(&String::from_utf8_lossy(&out.stdout)).unwrap_or_default();
    apps.into_iter()
        .filter(|a| !a.name.trim().is_empty() && !a.app_id.trim().is_empty())
        .map(|a| (a.name, format!("shell:AppsFolder\\{}", a.app_id)))
        .collect()
}

/// Warm the app list in the background at startup, so the first "open …" is instant.
pub fn preload_apps() {
    std::thread::spawn(|| {
        let apps = list_apps();
        *APPS.lock().unwrap() = Some(apps);
        *APPS_READ.lock().unwrap() = Some(Instant::now());
    });
}

// --- Focus --------------------------------------------------------------------------------

/// The window that was in front before Bond's ask box took the keyboard.
static PREVIOUS_FOREGROUND: Mutex<usize> = Mutex::new(0);

/// Remember the foreground window (call just before the overlay takes focus).
pub fn remember_foreground() {
    unsafe {
        let hwnd = windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow();
        *PREVIOUS_FOREGROUND.lock().unwrap() = hwnd as usize;
    }
}

/// Give the keyboard back to the window you were using, so typing never lands in Bond.
#[tauri::command]
pub fn release_focus(app: AppHandle) {
    let own = app.get_webview_window("overlay").and_then(|w| w.hwnd().ok()).map(|h| h.0 as usize).unwrap_or(0);
    let prev = *PREVIOUS_FOREGROUND.lock().unwrap();
    if prev != 0 && prev != own {
        unsafe {
            windows_sys::Win32::UI::WindowsAndMessaging::SetForegroundWindow(prev as _);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_browsers_are_launched() {
        assert_eq!(browser_key("Brave"), Some("brave"));
        assert_eq!(browser_key("Microsoft Edge"), Some("edge"));
        assert_eq!(browser_key("powershell"), None);
        assert!(open_url_in(Some("cmd.exe /c calc"), "https://example.com").is_err());
    }

    #[test]
    fn only_web_addresses_open() {
        assert!(clean_url("javascript:alert(1)").is_err());
        assert!(clean_url("file:///C:/Windows/System32/calc.exe").is_err());
        assert_eq!(clean_url("github.com").unwrap(), "https://github.com/");
    }

    #[test]
    fn the_ai_cannot_ask_for_anything_off_the_menu() {
        for bad in [r#"{"do":"run_command","command":"calc"}"#, r#"{"do":"delete","paths":["C:\\"]}"#, r#"{"do":"type_text","text":"x"}"#, r#"{"do":"kill_process","name":"x"}"#] {
            assert!(serde_json::from_str::<Action>(bad).is_err(), "{bad}");
        }
        assert!(serde_json::from_str::<Action>(r#"{"do":"open_project","name":"SelfGlance","tool":"claude"}"#).is_ok());
    }

    #[test]
    fn a_misheard_app_name_suggests_the_one_it_sounds_like() {
        let apps = ["Zed", "Zoom", "OBS Studio", "SelfGlance", "Google Chrome", "Notepad"];
        assert_eq!(sounds_like("Jed", apps.iter().copied()), vec!["Zed"]);
        assert_eq!(sounds_like("Self Glans", apps.iter().copied()), vec!["SelfGlance"]);
        assert!(sounds_like("x", apps.iter().copied()).is_empty());
    }

    #[test]
    fn projects_match_by_name_without_spaces_or_case() {
        let folders = vec![PathBuf::from(r"D:\SelfGlance"), PathBuf::from(r"D:\Projects\self-glance-old"), PathBuf::from(r"D:\Music App"), PathBuf::from(r"D:\Projects\music")];
        assert_eq!(match_projects("Self Glance", &folders), vec![PathBuf::from(r"D:\SelfGlance")], "an exact name wins");
        assert_eq!(match_projects("music app", &folders), vec![PathBuf::from(r"D:\Music App")]);
        assert_eq!(match_projects("music", &folders), vec![PathBuf::from(r"D:\Projects\music")]);
        assert!(match_projects("x", &folders).is_empty());
    }

    #[test]
    fn drive_names() {
        assert_eq!(drive_letter("d drive"), Some('d'));
        assert_eq!(drive_letter("my d drive"), Some('d'));
        assert_eq!(drive_letter("d:"), Some('d'));
        assert_eq!(drive_letter("downloads"), None);
    }

    #[test]
    fn system_folders_are_not_project_roots() {
        assert!(set_project_roots(vec![r"C:\Windows".into(), "relative".into(), r"C:\Program Files".into()]).is_empty());
    }
}
