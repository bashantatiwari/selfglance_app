// Modifier-only hotkeys: hold Ctrl+Alt to talk to Bond, tap Win+Alt to type to him.
//
// The global-shortcut plugin needs a letter or key in every combination, so these two are
// found by looking at the keyboard state ~50 times a second. Nothing is recorded: only
// whether Ctrl, Alt, Win and any other key are down right now.
//
//   Ctrl+Alt held 0.3 s, nothing else pressed → listening, until you let go.
//   Win+Alt pressed and released alone        → the Ask box.
//
// Any other key pressed during the hold (Ctrl+Alt+G, Ctrl+Alt+Del, Alt+Tab) cancels it, so
// ordinary shortcuts still work. AltGr counts as Ctrl+Alt on some keyboard layouts, so that
// key would start listening: use the tray or the Ask box there.

use tauri::AppHandle;

/// Ctrl+Alt must be held this long before he listens. Short, because the microphone takes about half a second
/// to deliver sound and a longer wait cuts off the first words; a shortcut that turns out to be another one
/// (Ctrl+Alt+G, an arrow key in an editor) throws the recording away.
#[cfg(target_os = "windows")]
const HOLD_MS: u128 = 120;
/// A Win+Alt press longer than this is not a tap.
#[cfg(target_os = "windows")]
const TAP_MAX_MS: u128 = 1200;

/// The "voice isn't downloaded" note is said once per run.
#[cfg(target_os = "windows")]
static TOLD: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg(target_os = "windows")]
pub fn spawn(app: AppHandle) {
    use std::time::Duration;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;

    fn down(vk: u16) -> bool {
        unsafe { GetAsyncKeyState(vk as i32) as u16 & 0x8000 != 0 }
    }
    /// Any key other than Ctrl, Alt, Win and our own marker key (mouse buttons are below 8).
    fn other_key() -> bool {
        (0x08u16..=0xFE).any(|vk| !matches!(vk, 0x11 | 0x12 | 0xA2..=0xA5 | 0x5B | 0x5C | 0xE8) && down(vk))
    }

    // One pass of the loop per call. A panic in it is logged and the watching starts again: without that, the
    // thread would end quietly and the shortcuts would stop working until Bond was restarted.
    fn watch(app: &AppHandle) {
        use std::time::{Duration, Instant};
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{keybd_event, KEYEVENTF_KEYUP, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN};
        let mut listen_since: Option<Instant> = None;
        let mut listening = false;
        let mut spoiled = false; // another key joined in: wait until everything is let go
        let mut tap_since: Option<Instant> = None;
        let mut tap_spoiled = false;
        loop {
            std::thread::sleep(Duration::from_millis(20));
            let ctrl = down(VK_CONTROL);
            let alt = down(VK_MENU);
            let win = down(VK_LWIN) || down(VK_RWIN);
            // The whole keyboard is only looked at while a Bond combination is held; otherwise four cheap checks.
            let other = ((ctrl && alt) || (win && alt)) && other_key();

            // Talk: Ctrl+Alt.
            if ctrl && alt && !win && !other && !spoiled {
                let since = *listen_since.get_or_insert_with(Instant::now);
                if !listening && since.elapsed().as_millis() >= HOLD_MS {
                    listening = true;
                    if crate::voice::installed() {
                        crate::diag::log("hotkey: Ctrl+Alt held, listening");
                        crate::voice::start(app.clone(), false);
                    } else if !TOLD.swap(true, std::sync::atomic::Ordering::SeqCst) {
                        use tauri::Emitter;
                        let _ = app.emit("voice-error", "Bond's voice isn't downloaded yet. Open the dashboard, Settings, Voice, and download it.");
                    }
                }
            } else {
                if listening {
                    listening = false;
                    if crate::voice::installed() {
                        // Another key joined in: it was a shortcut, not a request.
                        if ctrl && alt && (other || win) {
                            crate::voice::cancel();
                        } else {
                            crate::voice::stop();
                        }
                    }
                }
                listen_since = None;
                spoiled = (ctrl && alt) && (other || win || spoiled);
            }

            // Type: Win+Alt, on release.
            if win && alt && !ctrl && !other && !tap_spoiled {
                if tap_since.is_none() {
                    tap_since = Some(Instant::now());
                    // A key Windows doesn't know, tapped while Win is down, stops the Start menu opening on release.
                    unsafe {
                        keybd_event(0xE8, 0, 0, 0);
                        keybd_event(0xE8, 0, KEYEVENTF_KEYUP, 0);
                    }
                }
            } else {
                if let Some(t) = tap_since.take() {
                    if !tap_spoiled && !other && t.elapsed().as_millis() <= TAP_MAX_MS {
                        crate::open_ask(&app);
                    }
                }
                tap_spoiled = (win && alt) && (other || ctrl || tap_spoiled);
            }
        }
    }

    std::thread::spawn(move || loop {
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| watch(&app))).is_err() {
            crate::diag::log("hotkeys: the key watcher hit an error and was restarted");
            std::thread::sleep(Duration::from_secs(1));
        }
    });
}

#[cfg(not(target_os = "windows"))]
pub fn spawn(_app: AppHandle) {}
