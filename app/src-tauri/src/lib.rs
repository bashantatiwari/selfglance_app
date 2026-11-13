// SelfGlance core (Rust side).
//
// Responsibilities kept here because they need the operating system:
//   1. Size the transparent overlay window to the screen's work area.
//   2. Click-through: the overlay ignores the mouse everywhere except on the
//      "hit regions" (character, bottle) that the frontend reports.
//   3. Idle detection: seconds since the last keyboard/mouse input, so breaks are
//      timed on *active* use and "you stepped away" can be recognised.
//   4. Activity: which app/window is in front (and whether it's fullscreen), so the
//      companion can watch videos with you, stay quiet while you code, and get out
//      of the way in meetings and games. Read locally, never stored or sent anywhere.
//   5. Hotkeys (Ctrl+Alt+G summon, Win+Alt ask Bond, hold Ctrl+Alt to talk to
//      him) and the tray menu. His own voice and ears (voice.rs) run on this laptop.
//   6. AI (ai.rs): Bond's own brain on this laptop (brain.rs). No cloud, no account, no API
//      key: nothing you say or show leaves it. Daily summary and "ask Bond". What he learns from you
//      (experience.rs): past requests and your feedback, reused as examples. What he
//      notices on his own (notice.rs): your habits, a copied error, when you seem stuck.
//      Doing things on the computer for you (agent.rs): a known set of actions; running
//      commands, ending programs and deleting files wait for your approval first.
//   7. The laptop itself (system.rs): status, busy programs, clipboard, low-battery warning.
//      Bond is left out of screenshots and recordings unless you ask (capture.rs).
//   8. Start with the computer (autostart plugin; on by default in the installed app)
//      and only ever one running copy (single-instance plugin).
// Everything visual lives in the React + Three.js frontend.

mod agent;
mod diag;
mod draft;
mod egress;
mod ai;
mod brain;
mod capture;
mod experience;
mod goals;
mod hotkeys;
mod memory;
mod notice;
mod policy;
mod screen;
mod system;
mod voice;
mod wake;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, WebviewWindow,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// A rectangle in CSS pixels, relative to the overlay window's top-left corner.
#[derive(Deserialize, Clone, Copy, Debug)]
struct Rect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

impl Rect {
    fn contains(&self, px: f64, py: f64) -> bool {
        px >= self.x && px <= self.x + self.w && py >= self.y && py <= self.y + self.h
    }
}

#[derive(Default)]
struct HitRegions(Mutex<Vec<Rect>>);

/// Called by the frontend whenever the character or bottle moves.
#[tauri::command]
fn set_hit_regions(state: tauri::State<'_, Arc<HitRegions>>, rects: Vec<Rect>) {
    *state.0.lock().unwrap() = rects;
}

fn overlay(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("overlay")
}

/// Show the dashboard window (stats + settings), optionally on one page.
#[tauri::command]
fn open_dashboard(app: AppHandle, page: Option<String>) {
    show_dashboard(&app);
    if let Some(page) = page {
        let _ = app.emit_to("dashboard", "dashboard-page", page);
    }
}

fn show_dashboard(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("dashboard") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// The cursor in overlay CSS pixels (for "follow me"); None where the OS can't say.
#[tauri::command]
fn cursor_position(app: AppHandle) -> Option<(f64, f64)> {
    let win = overlay(&app)?;
    cursor_in_overlay(&app, &win)
}

fn fit_to_work_area(win: &WebviewWindow) -> tauri::Result<()> {
    if let Some(monitor) = win.primary_monitor()? {
        // The work area excludes the taskbar / dock, so the character stands on top of it.
        let area = monitor.work_area();
        win.set_position(area.position)?;
        win.set_size(area.size)?;
    }
    Ok(())
}

/// Cursor position in the overlay's CSS pixels, if the platform can report it.
fn cursor_in_overlay(app: &AppHandle, win: &WebviewWindow) -> Option<(f64, f64)> {
    let cursor = app.cursor_position().ok()?;
    let origin = win.outer_position().ok()?;
    let scale = win.scale_factor().ok()?;
    Some(((cursor.x - origin.x as f64) / scale, (cursor.y - origin.y as f64) / scale))
}

/// Polls the global cursor ~25 times a second and turns click-through off only
/// while the cursor is over a hit region. Cheap: no work unless the state flips.
fn spawn_click_through(app: AppHandle, win: WebviewWindow, regions: Arc<HitRegions>) {
    std::thread::spawn(move || {
        let mut ignoring = true;
        let _ = win.set_ignore_cursor_events(true);
        loop {
            std::thread::sleep(Duration::from_millis(40));
            // Some platforms (e.g. Linux Wayland) cannot report the cursor; then we
            // simply stay click-through and the hotkey / tray remain the way to interact.
            let Some((lx, ly)) = cursor_in_overlay(&app, &win) else {
                continue;
            };
            let over = regions.0.lock().unwrap().iter().any(|r| r.contains(lx, ly));
            if over == ignoring {
                ignoring = !over;
                let _ = win.set_ignore_cursor_events(ignoring);
            }
        }
    });
}

/// Emits `idle` (seconds since last keyboard/mouse input) every 2 seconds.
fn spawn_idle_watch(app: AppHandle) {
    std::thread::spawn(move || loop {
        if let Ok(idle) = user_idle::UserIdle::get_time() {
            let _ = app.emit("idle", idle.as_seconds());
        }
        std::thread::sleep(Duration::from_secs(2));
    });
}

/// What the user has in front of them right now.
#[derive(Serialize, Clone, PartialEq, Debug)]
struct Activity {
    /// Executable name, lower-case, without extension (e.g. "chrome", "code").
    app: String,
    /// Human app name as the OS reports it (e.g. "Google Chrome").
    name: String,
    /// Window title (e.g. "Lofi beats - YouTube - Google Chrome").
    title: String,
    /// The window covers the whole screen (fullscreen video, game, presentation).
    fullscreen: bool,
}

/// Emits `activity` whenever the foreground window (or its title) changes.
fn spawn_activity_watch(app: AppHandle, win: &WebviewWindow) {
    // Screen size, read once here on the main thread (asking from the watcher thread can stall).
    let screen = win
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| (m.size().width as f64, m.size().height as f64))
        .unwrap_or((f64::MAX, f64::MAX));
    std::thread::spawn(move || {
        let own_pid = std::process::id() as u64;
        let mut last: Option<Activity> = None;
        loop {
            std::thread::sleep(Duration::from_millis(1500));
            let Ok(w) = active_win_pos_rs::get_active_window() else {
                continue;
            };
            if w.process_id == own_pid {
                continue; // clicking the companion itself is not an activity change
            }
            let fullscreen = w.position.width >= screen.0 - 2.0 && w.position.height >= screen.1 - 2.0;
            let activity = Activity {
                app: w
                    .process_path
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_lowercase())
                    .unwrap_or_default(),
                name: w.app_name,
                title: w.title,
                fullscreen,
            };
            if last.as_ref() != Some(&activity) {
                crate::memory::set_activity(&activity.app, &activity.name, &activity.title);
                let _ = app.emit("activity", &activity);
                last = Some(activity);
            }
        }
    });
}

/// Drop the character in near the cursor (or at home when the cursor is unknown).
fn summon(app: &AppHandle) {
    let x = overlay(app).and_then(|w| cursor_in_overlay(app, &w)).map(|(x, _)| x);
    let _ = app.emit("summon", x);
}

/// "Learn more" links in the dashboard: only these sites, only after a click, in your own browser.
const LINK_SITES: &[&str] = &["huggingface.co", "github.com", "qwen.ai"];

#[tauri::command]
fn open_link(url: String) -> Result<(), String> {
    let parsed = reqwest::Url::parse(&url).map_err(|_| "That isn't a web address.".to_string())?;
    let host = parsed.host_str().unwrap_or("");
    if parsed.scheme() != "https" || !LINK_SITES.iter().any(|s| host == *s || host.ends_with(&format!(".{s}"))) {
        return Err("Bond only opens his own \"learn more\" pages.".into());
    }
    agent::open_target(parsed.as_str())
}

/// Dashboard: bring a water break now, to see what it does.
#[tauri::command]
fn break_now(app: AppHandle) {
    let _ = app.emit("break-now", ());
}

fn hotkey_mods() -> Modifiers {
    #[cfg(target_os = "macos")]
    return Modifiers::SUPER | Modifiers::ALT;
    #[cfg(not(target_os = "macos"))]
    return Modifiers::CONTROL | Modifiers::ALT;
}

fn summon_shortcut() -> Shortcut {
    Shortcut::new(Some(hotkey_mods()), Code::KeyG)
}

// Talking (hold Ctrl+Alt) and typing (Win+Alt) have no letter in them, so hotkeys.rs watches the keyboard for them.

/// Open the "Ask Bond" box: the overlay takes keyboard focus so you can type.
fn open_ask(app: &AppHandle) {
    agent::remember_foreground();
    if let Some(w) = overlay(app) {
        let _ = w.set_focus();
    }
    let _ = app.emit("ask-open", ());
}

/// Let the overlay take the keyboard for a moment (typing the delete confirmation).
#[tauri::command]
fn take_focus(app: AppHandle) {
    agent::remember_foreground();
    if let Some(w) = overlay(&app) {
        let _ = w.set_focus();
    }
}

#[tauri::command]
fn ask_bond(app: AppHandle) {
    open_ask(&app);
}

/// Start with the computer. Only real in the installed app: a dev build would register
/// the debug binary, which can't run without the dev server.
#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<bool, String> {
    if cfg!(debug_assertions) {
        return Err("Works in the installed app (not in dev mode).".into());
    }
    let al = app.autolaunch();
    if enabled { al.enable() } else { al.disable() }.map_err(|e| e.to_string())?;
    al.is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn get_autostart(app: AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

/// On the installed app's first run, turn "start with the computer" on, so the companion
/// is simply there every time the laptop starts. A marker file records that this was done
/// once; if the user later switches it off in the dashboard, it stays off.
fn enable_autostart_first_run(app: &AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    let Ok(dir) = app.path().app_config_dir() else {
        return;
    };
    let marker = dir.join("autostart-initialized");
    if marker.exists() {
        return;
    }
    if let Err(err) = app.autolaunch().enable() {
        eprintln!("autostart unavailable: {err}");
        return;
    }
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(&marker, b"1");
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let dash = MenuItem::with_id(app, "dashboard", "Dashboard", true, None::<&str>)?;
    let demo = MenuItem::with_id(app, "demo", "Show me what you can do", true, None::<&str>)?;
    let play = MenuItem::with_id(app, "summon", "Play with me  (Ctrl+Alt+G)", true, None::<&str>)?;
    let ask = MenuItem::with_id(app, "ask", "Ask Bond  (Win+Alt)", true, None::<&str>)?;
    let brk = MenuItem::with_id(app, "test-break", "Take a break now", true, None::<&str>)?;
    let snooze = MenuItem::with_id(app, "snooze", "Quiet for 1 hour", true, None::<&str>)?;
    let shots = MenuItem::with_id(app, "capture", "Show Bond in screenshots (5 min)", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit SelfGlance", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&dash, &ask, &demo, &play, &brk, &sep, &shots, &snooze, &quit])?;
    capture::init(app, shots);

    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("SelfGlance")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "summon" => summon(app),
            "dashboard" => show_dashboard(app),
            "ask" => open_ask(app),
            "demo" => {
                let _ = app.emit("demo", ());
            }
            "test-break" => {
                let _ = app.emit("break-now", ());
            }
            "snooze" => {
                let _ = app.emit("snooze", 60);
            }
            "capture" => capture::toggle(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let regions = Arc::new(HitRegions::default());
    let summon_key = summon_shortcut();

    tauri::Builder::default()
        // Must be registered first. Launching SelfGlance again while it already runs
        // (e.g. it started with Windows, then you click its Start-menu icon) opens the
        // dashboard of the running copy instead of starting a second companion.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_dashboard(app);
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    if shortcut == &summon_key {
                        summon(app);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .manage(regions.clone())
        // Closing the dashboard just hides it; the app keeps running in the tray.
        .on_window_event(|window, event| {
            // The overlay is Bond's body. If it is ever closed (Alt+F4 while the Ask box has the
            // keyboard, a WM_CLOSE from a tool) the app keeps running from the tray and nothing
            // can bring him back, so the close is refused. "Quit" in the tray is the way out.
            if window.label() == "overlay" {
                match event {
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        diag::log("overlay: close refused (use Quit in the tray menu)");
                    }
                    tauri::WindowEvent::Destroyed => diag::log("overlay: window destroyed"),
                    _ => {}
                }
            }
            if window.label() == "dashboard" {
                match event {
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                    // Bond steps aside while you're reading the dashboard, so he never covers it.
                    tauri::WindowEvent::Focused(focused) => {
                        let _ = window.app_handle().emit("dashboard-focus", *focused);
                    }
                    _ => {}
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            set_hit_regions,
            cursor_position,
            open_dashboard,
            ask_bond,
            set_autostart,
            get_autostart,
            ai::ai_text,
            ai::ai_route,
            ai::ai_chat,
            ai::ai_prime,
            ai::ai_screen,
            ai::ai_guide,
            ai::guide_mouse,
            ai::guide_signature,
            open_link,
            break_now,
            ai::guide_outcome,
            agent::agent_run,
            agent::agent_approve,
            agent::agent_deny,
            agent::agent_cancel,
            policy::agent_set_advanced,
            system::guide_prepare,
            system::clipboard_text,
            take_focus,
            capture::capture_hide_by_default,
            capture::capture_show,
            agent::release_focus,
            brain::brain_status,
            brain::brain_install,
            brain::brain_warm,
            brain::brain_stop,
            experience::brain_set_learning,
            experience::brain_feedback,
            experience::brain_record,
            experience::brain_learn_stats,
            experience::brain_forget,
            experience::brain_export,
            notice::notice_enable,
            notice::notice_habits,
            notice::notice_allowed,
            notice::notice_shown,
            notice::notice_judge,
            goals::goal_judge,
            draft::ai_draft,
            draft::draft_remember_target,
            draft::draft_write,
            draft::copy_text,
            notice::notice_scan,
            voice::voice_status,
            voice::voice_install,
            voice::voice_say,
            voice::voice_warm,
            voice::voice_listen,
            diag::diag_log,
            memory::memory_list,
            memory::memory_profile,
            memory::job_done,
            memory::job_note,
            memory::memory_forget,
            memory::memory_usage,
            memory::memory_forget_conversations,
            memory::memory_keep,
            wake::wake_install,
            wake::wake_status,
            wake::wake_set,
            wake::wake_follow_up,
            wake::wake_enroll_record,
            wake::wake_enroll_save,
            wake::wake_enroll_cancel,
            wake::wake_forget_voice,
            wake::wake_confirm_you,
            wake::wake_not_you,
            voice::voice_listen_stop
        ])
        .setup(move |app| {
            let win = overlay(app.handle()).expect("overlay window is defined in tauri.conf.json");
            fit_to_work_area(&win)?;
            // Left out of screenshots from his very first frame (the tray item comes later).
            capture::apply(app.handle());
            win.show()?;
            spawn_activity_watch(app.handle().clone(), &win);
            spawn_click_through(app.handle().clone(), win, regions.clone());
            spawn_idle_watch(app.handle().clone());
            build_tray(app.handle())?;
            enable_autostart_first_run(app.handle());
            agent::preload_apps();
            draft::spawn_foreground_watch();
            diag::init(app.handle());
            diag::log_panics();
            ai::forget_old_keys();
            memory::init(app.handle());
            diag::log("SelfGlance started");
            brain::init(app.handle());
            experience::init(app.handle());
            notice::spawn_clipboard_watch(app.handle().clone());
            voice::init(app.handle());
            hotkeys::spawn(app.handle().clone());
            system::spawn_battery_watch(app.handle().clone());
            // Another app may already own the shortcut; the tray item still works then, and
            // Bond says which one is taken (once the overlay is up to show it).
            let mut taken = Vec::new();
            for (key, name) in [(summon_shortcut(), "Ctrl+Alt+G")] {
                if let Err(err) = app.global_shortcut().register(key) {
                    eprintln!("hotkey {name} unavailable: {err}");
                    taken.push(name);
                }
            }
            if !taken.is_empty() {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(8));
                    let _ = handle.emit("voice-error", format!("Another app is using {}, so that shortcut won't reach me. Change it in that app, or use the tray menu (or “Hey Bond”).", taken.join(" and ")));
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running SelfGlance");
}
