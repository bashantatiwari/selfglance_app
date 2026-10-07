// Bond doing things on the desktop. Every action is one of a fixed, small set (no shell
// commands, nothing that deletes or changes files), and each is checked before it runs.
//
//   open_app      start an installed app by name (Windows: the Start menu's app list)
//   open_url      a web page in the default browser (http/https only)
//   web_search    a Google search
//   open_folder   Downloads / Documents / Desktop / Pictures / Music / Videos / Home
//   media         play/pause, next, previous, volume up/down, mute
//   show_desktop  minimise everything
//   lock_screen   lock the computer
//   set_wallpaper a solid-colour desktop background ("black", "#1e1e2e")
//   click         a point on the screenshot Bond just looked at
//   type_text     type text into whatever has focus
//   hotkey        a key combination such as "ctrl+t"
//   wait          pause between steps

use std::sync::Mutex;
use std::time::Duration;

use enigo::{Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use serde::Deserialize;
use tauri::{AppHandle, Manager};

const MAX_ACTIONS: usize = 8;
const MAX_TYPE_CHARS: usize = 2000;

#[derive(Deserialize, Debug, Clone)]
#[serde(tag = "do", rename_all = "snake_case")]
pub enum Action {
    OpenApp { name: String },
    OpenUrl { url: String },
    WebSearch { query: String },
    OpenFolder { name: String },
    Media { key: String },
    ShowDesktop,
    LockScreen,
    SetWallpaper { color: String },
    Click { x: f64, y: f64, #[serde(default)] double: bool },
    TypeText { text: String },
    Hotkey { keys: String },
    Wait { ms: u64 },
}

/// Where a screenshot came from, so a click on it lands on the right physical pixel.
#[derive(Clone, Copy)]
pub struct ShotGeometry {
    /// Monitor origin in physical pixels.
    pub mx: f64,
    pub my: f64,
    /// Screenshot size in pixels.
    pub width: f64,
    pub height: f64,
    /// Screenshot pixels per physical pixel.
    pub scale: f64,
    /// Click coordinates are on a 0-1000 grid (Gemini) rather than screenshot pixels (Claude).
    pub normalized: bool,
}

/// Run actions from the frontend's own classifier (no screenshot, so no clicks).
#[tauri::command]
pub async fn agent_run(app: AppHandle, actions: Vec<Action>) -> Result<Vec<String>, String> {
    run(&app, actions, None).await
}

/// Run actions one after another; returns a short line per action for Bond's answer.
/// Stops at the first failure, so later steps never act on the wrong window.
pub async fn run(app: &AppHandle, actions: Vec<Action>, shot: Option<ShotGeometry>) -> Result<Vec<String>, String> {
    let mut done = Vec::new();
    for action in actions.into_iter().take(MAX_ACTIONS) {
        let app = app.clone();
        let step = tauri::async_runtime::spawn_blocking(move || perform(&app, action, shot))
            .await
            .map_err(|e| e.to_string())?;
        match step {
            Ok((line, settle_ms)) => {
                if !line.is_empty() {
                    done.push(line);
                }
                tokio_sleep(settle_ms).await;
            }
            Err(err) if done.is_empty() => return Err(err),
            Err(err) => {
                done.push(format!("Stopped: {err}"));
                break;
            }
        }
    }
    Ok(done)
}

async fn tokio_sleep(ms: u64) {
    if ms > 0 {
        let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(Duration::from_millis(ms))).await;
    }
}

/// One action. Returns what was done and how long to let it settle before the next one.
fn perform(app: &AppHandle, action: Action, shot: Option<ShotGeometry>) -> Result<(String, u64), String> {
    match action {
        Action::OpenApp { name } => open_app(&name).map(|n| (format!("Opened {n}"), 1500)),
        Action::OpenUrl { url } => {
            let url = clean_url(&url)?;
            open_target(&url)?;
            Ok((format!("Opened {}", short(&url)), 1500))
        }
        Action::WebSearch { query } => {
            let query = query.trim();
            if query.is_empty() {
                return Err("Nothing to search for.".into());
            }
            let url = reqwest::Url::parse_with_params("https://www.google.com/search", &[("q", query)]).map_err(|e| e.to_string())?;
            open_target(url.as_str())?;
            Ok((format!("Searched for “{query}”"), 1500))
        }
        Action::OpenFolder { name } => {
            let (label, path) = folder(app, &name)?;
            open_target(&path.to_string_lossy())?;
            Ok((format!("Opened {label}"), 800))
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
            Ok((label.to_string(), 200))
        }
        Action::ShowDesktop => {
            if !cfg!(target_os = "windows") {
                return Err("Show desktop works on Windows only for now.".into());
            }
            press_combo(&[Key::Meta], Key::Unicode('d'))?;
            Ok(("Showed the desktop".into(), 500))
        }
        Action::LockScreen => {
            lock()?;
            Ok(("Locked the screen".into(), 0))
        }
        Action::SetWallpaper { color } => {
            let rgb = parse_color(&color)?;
            set_wallpaper(app, rgb)?;
            Ok((format!("Wallpaper set to {}", color.trim()), 300))
        }
        Action::Click { x, y, double } => {
            let g = shot.ok_or("Clicking needs a look at the screen first.")?;
            let (ix, iy) = if g.normalized { (x / 1000.0 * g.width, y / 1000.0 * g.height) } else { (x, y) };
            if !(0.0..=g.width).contains(&ix) || !(0.0..=g.height).contains(&iy) {
                return Err("That spot is off the screen.".into());
            }
            let px = (g.mx + ix / g.scale).round() as i32;
            let py = (g.my + iy / g.scale).round() as i32;
            let mut e = input()?;
            e.move_mouse(px, py, Coordinate::Abs).map_err(|e| e.to_string())?;
            std::thread::sleep(Duration::from_millis(60));
            e.button(Button::Left, Direction::Click).map_err(|e| e.to_string())?;
            if double {
                std::thread::sleep(Duration::from_millis(60));
                e.button(Button::Left, Direction::Click).map_err(|e| e.to_string())?;
            }
            Ok((String::new(), 600))
        }
        Action::TypeText { text } => {
            if text.chars().count() > MAX_TYPE_CHARS {
                return Err("That's too much text to type at once.".into());
            }
            input()?.text(&text).map_err(|e| e.to_string())?;
            Ok((String::new(), 300))
        }
        Action::Hotkey { keys } => {
            let (mods, key) = parse_combo(&keys)?;
            press_combo(&mods, key)?;
            Ok((String::new(), 500))
        }
        Action::Wait { ms } => Ok((String::new(), ms.min(5000))),
    }
}

fn input() -> Result<Enigo, String> {
    Enigo::new(&Settings::default()).map_err(|e| format!("Can't control the keyboard/mouse: {e}"))
}

fn press_combo(mods: &[Key], key: Key) -> Result<(), String> {
    let mut e = input()?;
    for m in mods {
        e.key(*m, Direction::Press).map_err(|e| e.to_string())?;
    }
    let res = e.key(key, Direction::Click).map_err(|e| e.to_string());
    for m in mods.iter().rev() {
        let _ = e.key(*m, Direction::Release);
    }
    res
}

/// "ctrl+shift+t" → ([Control, Shift], 't'). Unknown names are rejected rather than guessed.
fn parse_combo(combo: &str) -> Result<(Vec<Key>, Key), String> {
    let parts: Vec<String> = combo.split('+').map(|p| p.trim().to_lowercase()).filter(|p| !p.is_empty()).collect();
    let (last, mods) = parts.split_last().ok_or("Empty key combination.")?;
    let mut keys = Vec::new();
    for m in mods {
        keys.push(match m.as_str() {
            "ctrl" | "control" => Key::Control,
            "shift" => Key::Shift,
            "alt" | "option" => Key::Alt,
            "win" | "windows" | "meta" | "super" | "cmd" | "command" => Key::Meta,
            other => return Err(format!("Unknown key “{other}”.")),
        });
    }
    let key = match last.as_str() {
        "enter" | "return" => Key::Return,
        "tab" => Key::Tab,
        "esc" | "escape" => Key::Escape,
        "space" => Key::Space,
        "backspace" => Key::Backspace,
        "delete" | "del" => Key::Delete,
        "up" => Key::UpArrow,
        "down" => Key::DownArrow,
        "left" => Key::LeftArrow,
        "right" => Key::RightArrow,
        "home" => Key::Home,
        "end" => Key::End,
        "pageup" => Key::PageUp,
        "pagedown" => Key::PageDown,
        "f1" => Key::F1,
        "f2" => Key::F2,
        "f3" => Key::F3,
        "f4" => Key::F4,
        "f5" => Key::F5,
        "f6" => Key::F6,
        "f7" => Key::F7,
        "f8" => Key::F8,
        "f9" => Key::F9,
        "f10" => Key::F10,
        "f11" => Key::F11,
        "f12" => Key::F12,
        s if s.chars().count() == 1 => Key::Unicode(s.chars().next().unwrap()),
        other => return Err(format!("Unknown key “{other}”.")),
    };
    // Closing windows or apps from a guessed shortcut is too easy to get wrong.
    if keys.contains(&Key::Alt) && key == Key::F4 {
        return Err("Bond won't close windows with Alt+F4.".into());
    }
    Ok((keys, key))
}

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

fn folder(app: &AppHandle, name: &str) -> Result<(String, std::path::PathBuf), String> {
    let p = app.path();
    let n = name.trim().to_lowercase();
    let (label, dir) = match n.trim_end_matches(" folder") {
        "downloads" | "download" => ("Downloads", p.download_dir()),
        "documents" | "document" | "docs" => ("Documents", p.document_dir()),
        "desktop" => ("Desktop", p.desktop_dir()),
        "pictures" | "photos" | "images" => ("Pictures", p.picture_dir()),
        "music" => ("Music", p.audio_dir()),
        "videos" | "video" => ("Videos", p.video_dir()),
        "home" | "user" => ("your home folder", p.home_dir()),
        _ => {
            let path = std::path::PathBuf::from(name.trim());
            return if path.is_absolute() && path.is_dir() {
                Ok((path.to_string_lossy().to_string(), path))
            } else {
                Err(format!("I don't know a folder called “{name}”."))
            };
        }
    };
    Ok((label.to_string(), dir.map_err(|e| e.to_string())?))
}

/// Open a file, folder or URL with its default handler, without going through a shell.
fn open_target(target: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let mut cmd = std::process::Command::new("explorer");
    #[cfg(target_os = "macos")]
    let mut cmd = std::process::Command::new("open");
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = std::process::Command::new("xdg-open");
    cmd.arg(target).spawn().map(|_| ()).map_err(|e| format!("Couldn't open it: {e}"))
}

/// "black", "dark blue", "#1e1e2e", "1e1e2e" → RGB.
fn parse_color(color: &str) -> Result<[u8; 3], String> {
    let c = color.trim().to_lowercase();
    let named: &[(&str, [u8; 3])] = &[
        ("black", [0, 0, 0]),
        ("white", [255, 255, 255]),
        ("gray", [128, 128, 128]),
        ("grey", [128, 128, 128]),
        ("dark gray", [40, 40, 40]),
        ("dark grey", [40, 40, 40]),
        ("red", [200, 30, 30]),
        ("dark red", [110, 10, 10]),
        ("green", [30, 150, 60]),
        ("dark green", [10, 70, 30]),
        ("blue", [30, 90, 200]),
        ("dark blue", [10, 25, 70]),
        ("navy", [0, 0, 80]),
        ("purple", [110, 50, 170]),
        ("pink", [230, 120, 170]),
        ("orange", [240, 130, 30]),
        ("yellow", [240, 210, 40]),
        ("teal", [0, 128, 128]),
        ("brown", [110, 70, 40]),
    ];
    if let Some((_, rgb)) = named.iter().find(|(n, _)| *n == c) {
        return Ok(*rgb);
    }
    let hex = c.trim_start_matches('#');
    if hex.len() == 6 && hex.chars().all(|ch| ch.is_ascii_hexdigit()) {
        let b = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).unwrap();
        return Ok([b(0), b(2), b(4)]);
    }
    Err(format!("I don't know the colour “{color}”. Try a name like black or a code like #1e1e2e."))
}

/// Write a small solid-colour image and make it the desktop background.
fn set_wallpaper(app: &AppHandle, rgb: [u8; 3]) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // A new file name per colour, so Windows doesn't keep showing a cached image.
    let path = dir.join(format!("wallpaper-{:02x}{:02x}{:02x}.png", rgb[0], rgb[1], rgb[2]));
    image::RgbImage::from_pixel(64, 64, image::Rgb(rgb)).save(&path).map_err(|e| format!("Couldn't make the wallpaper: {e}"))?;

    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{SystemParametersInfoW, SPIF_SENDCHANGE, SPIF_UPDATEINIFILE, SPI_SETDESKWALLPAPER};
        let mut wide: Vec<u16> = path.as_os_str().to_string_lossy().encode_utf16().chain(std::iter::once(0)).collect();
        let ok = unsafe { SystemParametersInfoW(SPI_SETDESKWALLPAPER, 0, wide.as_mut_ptr() as _, SPIF_UPDATEINIFILE | SPIF_SENDCHANGE) };
        if ok == 0 {
            return Err("Windows didn't accept the new wallpaper.".into());
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        Err("Changing the wallpaper works on Windows only for now.".into())
    }
}

fn lock() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let r = std::process::Command::new("rundll32.exe").args(["user32.dll,LockWorkStation"]).spawn();
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("pmset").arg("displaysleepnow").spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = std::process::Command::new("loginctl").arg("lock-session").spawn();
    r.map(|_| ()).map_err(|e| format!("Couldn't lock the screen: {e}"))
}

// --- Apps ------------------------------------------------------------------------------

/// Installed apps as (display name, launch target), read once and cached.
static APPS: Mutex<Option<Vec<(String, String)>>> = Mutex::new(None);

/// Common names people say that differ from the Start-menu name.
const ALIASES: &[(&str, &str)] = &[
    ("chrome", "google chrome"),
    ("vs code", "visual studio code"),
    ("vscode", "visual studio code"),
    ("code", "visual studio code"),
    ("word", "word"),
    ("excel", "excel"),
    ("powerpoint", "powerpoint"),
    ("edge", "microsoft edge"),
    ("calculator", "calculator"),
    ("explorer", "file explorer"),
    ("files", "file explorer"),
    ("terminal", "terminal"),
    ("cmd", "command prompt"),
    ("settings", "settings"),
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
    ("facebook", "https://www.facebook.com"),
    ("instagram", "https://www.instagram.com"),
    ("linkedin", "https://www.linkedin.com"),
    ("netflix", "https://www.netflix.com"),
    ("twitter", "https://x.com"),
    ("x", "https://x.com"),
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
    Err(format!("I couldn't find an app called “{name}”."))
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
    }
    let apps = cache.as_ref().unwrap();
    let lower = |s: &str| s.to_lowercase();
    apps.iter()
        .find(|(n, _)| lower(n) == wanted)
        .or_else(|| apps.iter().find(|(n, _)| lower(n).starts_with(wanted)))
        .or_else(|| apps.iter().find(|(n, _)| lower(n).split(|c: char| !c.is_alphanumeric()).any(|w| w == wanted)))
        .or_else(|| apps.iter().find(|(n, _)| wanted.len() >= 4 && lower(n).contains(wanted)))
        .cloned()
}

#[cfg(target_os = "windows")]
fn list_apps() -> Vec<(String, String)> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    #[derive(Deserialize)]
    struct StartApp {
        #[serde(rename = "Name")]
        name: String,
        #[serde(rename = "AppID")]
        app_id: String,
    }
    // Get-StartApps lists every app in the Start menu, desktop and Store apps alike.
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", "Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    let Ok(out) = out else { return Vec::new() };
    let text = String::from_utf8_lossy(&out.stdout);
    let apps: Vec<StartApp> = serde_json::from_str(&text).unwrap_or_default();
    apps.into_iter()
        .filter(|a| !a.name.trim().is_empty() && !a.app_id.trim().is_empty())
        .map(|a| (a.name, format!("shell:AppsFolder\\{}", a.app_id)))
        .collect()
}

#[cfg(target_os = "macos")]
fn list_apps() -> Vec<(String, String)> {
    let mut out = Vec::new();
    for dir in ["/Applications", "/System/Applications", "/System/Applications/Utilities"] {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for e in entries.flatten() {
                let path = e.path();
                if path.extension().is_some_and(|x| x == "app") {
                    if let Some(stem) = path.file_stem() {
                        out.push((stem.to_string_lossy().to_string(), path.to_string_lossy().to_string()));
                    }
                }
            }
        }
    }
    out
}

#[cfg(all(unix, not(target_os = "macos")))]
fn list_apps() -> Vec<(String, String)> {
    // .desktop files carry a Name=; xdg-open launches them via the desktop environment.
    let mut out = Vec::new();
    let home = std::env::var("HOME").unwrap_or_default();
    for dir in ["/usr/share/applications".to_string(), format!("{home}/.local/share/applications")] {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for e in entries.flatten() {
                let path = e.path();
                let Ok(text) = std::fs::read_to_string(&path) else { continue };
                if let Some(name) = text.lines().find_map(|l| l.strip_prefix("Name=")) {
                    out.push((name.to_string(), path.to_string_lossy().to_string()));
                }
            }
        }
    }
    out
}

/// Warm the app list in the background at startup, so the first "open …" is instant.
pub fn preload_apps() {
    std::thread::spawn(|| {
        let apps = list_apps();
        *APPS.lock().unwrap() = Some(apps);
    });
}

// --- Focus -----------------------------------------------------------------------------

/// The window that was in front before Bond's ask box took the keyboard.
static PREVIOUS_FOREGROUND: Mutex<usize> = Mutex::new(0);

/// Remember the foreground window (call just before the overlay takes focus).
pub fn remember_foreground() {
    #[cfg(target_os = "windows")]
    unsafe {
        let hwnd = windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow();
        *PREVIOUS_FOREGROUND.lock().unwrap() = hwnd as usize;
    }
}

/// Give the keyboard back to the window you were using, so typing never lands in Bond.
#[tauri::command]
pub fn release_focus(app: AppHandle) {
    #[cfg(target_os = "windows")]
    {
        let own = app
            .get_webview_window("overlay")
            .and_then(|w| w.hwnd().ok())
            .map(|h| h.0 as usize)
            .unwrap_or(0);
        let prev = *PREVIOUS_FOREGROUND.lock().unwrap();
        if prev != 0 && prev != own {
            unsafe {
                windows_sys::Win32::UI::WindowsAndMessaging::SetForegroundWindow(prev as _);
            }
        }
    }
    let _ = app;
}
