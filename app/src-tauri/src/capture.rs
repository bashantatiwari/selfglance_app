// Bond in screenshots. The overlay window asks Windows to leave it out of screenshots and screen
// recordings (the "exclude from capture" flag), so a picture of your work doesn't have Bond
// standing in it. It only changes what is captured: you still see him on screen.
//
// Three ways to change it:
//   - Settings → Bond: hide him always (the default), or let him appear in captures always.
//   - The tray item, or saying "include yourself in the screenshot": he shows up for a few
//     minutes, then is hidden again.
// Bond's own screen reading (ai.rs) goes through the same capture, so it no longer sees him either.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{menu::MenuItem, AppHandle, Emitter, Manager};

/// How long "show Bond in screenshots" lasts before he is hidden again.
const SHOW_FOR: Duration = Duration::from_secs(5 * 60);

static HIDE_BY_DEFAULT: AtomicBool = AtomicBool::new(true);
static SHOW_UNTIL: Mutex<Option<Instant>> = Mutex::new(None);
static TRAY_ITEM: Mutex<Option<MenuItem<tauri::Wry>>> = Mutex::new(None);

/// He is in a screenshot taken right now only if you asked for it, or settings say always.
fn showing_for_now() -> bool {
    SHOW_UNTIL.lock().unwrap().is_some_and(|until| Instant::now() < until)
}

/// Is the overlay left out of captures right now?
pub fn hidden() -> bool {
    HIDE_BY_DEFAULT.load(Ordering::Relaxed) && !showing_for_now()
}

/// What the tray item says, and whether it can be used (not when settings show him always).
fn tray_label() -> (&'static str, bool) {
    if !HIDE_BY_DEFAULT.load(Ordering::Relaxed) {
        ("Bond appears in screenshots (Settings)", false)
    } else if showing_for_now() {
        ("Hide Bond from screenshots again", true)
    } else {
        ("Show Bond in screenshots (5 min)", true)
    }
}

/// Put the current choice into effect: the window flag, the tray text, and a note for the screens.
pub fn apply(app: &AppHandle) {
    let hide = hidden();
    if let Some(win) = app.get_webview_window("overlay") {
        let _ = win.set_content_protected(hide);
    }
    if let Some(item) = TRAY_ITEM.lock().unwrap().as_ref() {
        let (text, enabled) = tray_label();
        let _ = item.set_text(text);
        let _ = item.set_enabled(enabled);
    }
    let _ = app.emit("capture-hidden", hide);
}

/// Called once the tray exists: remembers its item and puts him back after "show for 5 minutes".
pub fn init(app: &AppHandle, item: MenuItem<tauri::Wry>) {
    *TRAY_ITEM.lock().unwrap() = Some(item);
    apply(app);
    let app = app.clone();
    std::thread::spawn(move || {
        let mut last = hidden();
        loop {
            std::thread::sleep(Duration::from_secs(2));
            let now = hidden();
            if now != last {
                last = now;
                apply(&app);
                crate::diag::log(if now { "capture: Bond is hidden from screenshots again" } else { "capture: Bond appears in screenshots" });
            }
        }
    });
}

/// The tray item: show him for a few minutes, or hide him again at once.
pub fn toggle(app: &AppHandle) {
    set_showing(app, !showing_for_now());
}

fn set_showing(app: &AppHandle, show: bool) -> bool {
    *SHOW_UNTIL.lock().unwrap() = if show && HIDE_BY_DEFAULT.load(Ordering::Relaxed) { Some(Instant::now() + SHOW_FOR) } else { None };
    apply(app);
    hidden()
}

/// Settings: keep him out of captures (true, the default) or let him appear in them.
#[tauri::command]
pub fn capture_hide_by_default(app: AppHandle, hide: bool) -> bool {
    // Every settings change calls this; only a real change ends a "show him for 5 minutes".
    if HIDE_BY_DEFAULT.swap(hide, Ordering::Relaxed) != hide {
        *SHOW_UNTIL.lock().unwrap() = None;
    }
    apply(&app);
    hidden()
}

/// "Include yourself in the screenshot" (true) or "hide again" (false). Returns whether he is
/// hidden from captures afterwards, so he can say what actually happened.
#[tauri::command]
pub fn capture_show(app: AppHandle, show: bool) -> bool {
    set_showing(&app, show)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hidden_unless_asked_or_set_to_always_show() {
        *SHOW_UNTIL.lock().unwrap() = None;
        HIDE_BY_DEFAULT.store(true, Ordering::Relaxed);
        assert!(hidden());
        // Asked for a few minutes: shown until then.
        *SHOW_UNTIL.lock().unwrap() = Some(Instant::now() + Duration::from_secs(60));
        assert!(!hidden());
        assert!(tray_label().0.starts_with("Hide Bond"));
        // The time ran out: hidden again, without anyone doing anything.
        *SHOW_UNTIL.lock().unwrap() = Some(Instant::now() - Duration::from_secs(1));
        assert!(hidden());
        assert!(tray_label().0.starts_with("Show Bond"));
        // Settings say always show: never hidden, and the tray item is off.
        HIDE_BY_DEFAULT.store(false, Ordering::Relaxed);
        *SHOW_UNTIL.lock().unwrap() = None;
        assert!(!hidden());
        assert_eq!(tray_label().1, false);
        HIDE_BY_DEFAULT.store(true, Ordering::Relaxed);
    }
}
