// Drafts: Bond writes a message you asked for, and puts it in the box you were typing in.
//
//   "write me a message to my manager saying the review is late"  → a ready-to-send draft
//   You read it, change it if you like, and press "Put in the box" (or Copy).
//
// Putting it in the box pastes the text (Ctrl+V) into the window that was in front when you
// asked, and that is all: Bond never presses Enter and never sends anything. You read it in
// the app, and you press Send yourself. This is not one of the actions the AI can plan (see
// policy.rs): it only runs when you press the button on a draft you can see, with exactly the
// text on the card.
//
// Not in password managers, banking or private windows (the draft is copied instead), and the
// clipboard you had before is put back afterwards.

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};

/// Longest draft (characters) he writes or pastes.
const MAX_CHARS: usize = 4000;

/// The window to write in: the one in front when the request was made.
static TARGET: Mutex<Option<Target>> = Mutex::new(None);

#[derive(Clone)]
struct Target {
    hwnd: usize,
    title: String,
}

#[derive(Serialize)]
pub struct Written {
    /// Pasted into the window. When false the text is on the clipboard and `note` says why.
    pub pasted: bool,
    pub note: String,
}

// --- Writing the draft -------------------------------------------------------------------

#[derive(Serialize, Debug, PartialEq)]
pub struct Draft {
    /// For an email: a subject line. Empty otherwise.
    pub subject: String,
    pub message: String,
    /// The text on screen was read to answer a conversation.
    pub used_screen: bool,
}

const SYSTEM: &str = r#"You write messages for the user to send, in their voice. They tell you what they want to say; you write the message itself.
Rules:
- Put only the message in "message": no preamble ("Here is"), no quotes around it, no explanation, no placeholders like [name].
- Keep every fact, name, date and @mention exactly as given. Never add anything they did not say: no extra facts, dates, numbers, promises, offers or reasons.
- Clear, correct, polite and natural; as short as the point allows (a few sentences for chat; a greeting, a short body and a sign-off only for email). Match the language they wrote in. No emojis unless asked. Plain text, no markdown.
- For an email, put a short subject line in "subject" (otherwise leave it empty) and leave the sign-off name out.
- If they ask for a prompt for ChatGPT or another AI, the message is that prompt itself: specific, well structured, ready to paste (up to about 150 words), written to the AI, not to the user.
- If conversation text from their screen is given, write a reply to its last message that does what they asked.

Examples:
Request: write me a msg stating it has been a lot of time and i am still waiting for the review i submitted the task on oct 19 and not able to get the review till now
{"subject":"","message":"Hi, it's been a while since I submitted the task on October 19, and I'm still waiting for the review. Could you please check on it?"}
Request: write an email to my manager asking for friday off because of a family event
{"subject":"Leave request for Friday","message":"Hi,\n\nI would like to request Friday off because of a family event.\n\nPlease let me know if that works.\n\nThank you."}"#;

fn schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "subject": {"type": "string", "maxLength": 120},
            "message": {"type": "string", "maxLength": 1800},
        },
        "required": ["subject", "message"],
        "additionalProperties": false,
    })
}

/// Replies to what is on screen need to see it; a fresh message doesn't.
fn needs_screen(request: &str) -> bool {
    let r = request.to_lowercase();
    ["reply", "respond", "answer her", "answer him", "answer them", "this message", "this mail", "this email", "his message", "her message", "their message", "what should i say", "what should i write"]
        .iter()
        .any(|k| r.contains(k))
}

fn parse(reply: &str) -> Result<(String, String), String> {
    let v: Value = serde_json::from_str(reply).map_err(|e| format!("unreadable draft: {e}"))?;
    let message = v["message"].as_str().unwrap_or("").trim().to_string();
    if message.is_empty() {
        return Err("Bond couldn't write that one. Try saying a bit more about what you want to say.".into());
    }
    Ok((v["subject"].as_str().unwrap_or("").trim().to_string(), message))
}

/// Write a draft for a request. Replies read the conversation on screen first (text only, on
/// this laptop); private windows are never read.
#[tauri::command]
pub async fn ai_draft(request: String) -> Result<Draft, String> {
    if !crate::brain::ready() {
        return Err("Bond's brain isn't installed yet. Open the dashboard → Settings → Bond's brain.".into());
    }
    let request: String = request.chars().take(1500).collect();
    let mut prompt = format!("Request: {request}");
    let mut used_screen = false;
    if needs_screen(&request) {
        let window = active_win_pos_rs::get_active_window().map(|w| format!("{} {}", w.app_name, w.title)).unwrap_or_default();
        if !crate::notice::is_private(&window, &[]) {
            if let Ok(Ok(shot)) = tauri::async_runtime::spawn_blocking(crate::ai::capture).await.map_err(|e| e.to_string()).map(|r| r) {
                if !shot.seen.trim().is_empty() {
                    let seen: String = shot.seen.chars().take(3500).collect();
                    prompt = format!("Text on their screen (it may include the conversation to reply to):\n{seen}\n\n{prompt}");
                    used_screen = true;
                }
            }
        }
    }
    let reply = crate::brain::chat(SYSTEM, &prompt, None, Some(&schema()), 600).await?;
    let (subject, message) = parse(&reply)?;
    Ok(Draft { subject, message, used_screen })
}

// --- Putting it in the box ---------------------------------------------------------------

/// The text may be pasted: not empty, not huge.
fn check(text: &str) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("There's nothing to write.".into());
    }
    if text.chars().count() > MAX_CHARS {
        return Err("That's too long to put in a box at once.".into());
    }
    Ok(())
}

/// A window of the user's (not Bond's own), by handle; None for a dead or null handle.
#[cfg(target_os = "windows")]
fn user_window(hwnd: usize) -> Option<Target> {
    use windows_sys::Win32::System::Threading::GetCurrentProcessId;
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowTextW, GetWindowThreadProcessId, IsWindow};
    let h = hwnd as *mut core::ffi::c_void;
    if h.is_null() {
        return None;
    }
    unsafe {
        if IsWindow(h) == 0 {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(h, &mut pid);
        if pid == GetCurrentProcessId() {
            return None;
        }
        let mut buf = [0u16; 256];
        let n = GetWindowTextW(h, buf.as_mut_ptr(), buf.len() as i32).max(0) as usize;
        Some(Target { hwnd, title: String::from_utf16_lossy(&buf[..n]) })
    }
}

/// The last window of the user's that was in front (not Bond's own, not the taskbar). Kept up to
/// date by a light background check, because how Bond's box was opened (hotkey, menu, dashboard)
/// decides whether the window before it can be found any other way.
static LAST_USER: Mutex<Option<Target>> = Mutex::new(None);

/// Note the front window if it is one of the user's.
#[cfg(target_os = "windows")]
fn sample_foreground() {
    use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    let front = unsafe { GetForegroundWindow() } as usize;
    if let Some(t) = user_window(front) {
        if !t.title.trim().is_empty() {
            *LAST_USER.lock().unwrap() = Some(t);
        }
    }
}

/// Start the check (every half second, nothing is stored but one window handle and its title).
pub fn spawn_foreground_watch() {
    #[cfg(target_os = "windows")]
    std::thread::spawn(|| loop {
        sample_foreground();
        std::thread::sleep(Duration::from_millis(500));
    });
}

/// The window a draft goes back to: the user's window in front now, else the last one that was.
fn current_target() -> Option<Target> {
    #[cfg(target_os = "windows")]
    {
        sample_foreground();
        let last = LAST_USER.lock().unwrap().clone();
        // Still there? A closed window is no target.
        return last.filter(|t| user_window(t.hwnd).is_some()).or_else(|| user_window(crate::agent::previous_foreground()));
    }
    #[allow(unreachable_code)]
    None
}

/// Remember which window the user is in (their app, not Bond), so a draft can go back there. Call
/// when a request is made.
#[tauri::command]
pub fn draft_remember_target() {
    let t = current_target();
    crate::diag::log(&format!("draft: target window = {:?}", t.as_ref().map(|t| t.title.chars().take(60).collect::<String>())));
    *TARGET.lock().unwrap() = t;
}

/// Put text on the clipboard (the Copy button).
#[tauri::command]
pub fn copy_text(text: String) -> Result<(), String> {
    check(&text)?;
    crate::system::clipboard_set(&text)
}

/// Paste the draft into the window the request was made in. Never presses Enter.
#[tauri::command]
pub async fn draft_write(text: String) -> Result<Written, String> {
    check(&text)?;
    let copied = |note: &str| -> Result<Written, String> {
        crate::system::clipboard_set(&text)?;
        Ok(Written { pasted: false, note: note.into() })
    };
    let remembered = TARGET.lock().unwrap().clone().or_else(current_target);
    crate::diag::log(&format!("draft: writing {} chars into {:?}", text.chars().count(), remembered.as_ref().map(|t| t.title.chars().take(60).collect::<String>())));
    let Some(target) = remembered else {
        return copied("I don't know which window to write in, so it's copied: click the box and press Ctrl+V.");
    };
    if crate::notice::is_private(&target.title, &[]) {
        return copied("That looks like a private window, so I only copied it: click the box and press Ctrl+V.");
    }
    #[cfg(target_os = "windows")]
    {
        let ok = tauri::async_runtime::spawn_blocking(move || paste_into(target.hwnd, &text)).await.map_err(|e| e.to_string())?;
        match ok {
            Ok(()) => Ok(Written { pasted: true, note: "It's in the box. Read it, then press Send yourself.".into() }),
            Err(note) => Ok(Written { pasted: false, note }),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = target;
        copied("It's copied: click the box and press Ctrl+V.")
    }
}

/// Bring the window forward without the "tap Alt" trick (a lone Alt moves the keyboard to the menu
/// bar in Chrome, Notepad and others, and the paste would go nowhere). Ok(true) when it already was.
#[cfg(target_os = "windows")]
fn focus_quietly(hwnd: usize) -> Result<bool, String> {
    use windows_sys::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId, IsIconic, SetForegroundWindow, ShowWindow, SW_RESTORE};
    let h = hwnd as *mut core::ffi::c_void;
    unsafe {
        if GetForegroundWindow() == h {
            return Ok(true);
        }
        if IsIconic(h) != 0 {
            ShowWindow(h, SW_RESTORE);
        }
        let (me, them) = (GetCurrentThreadId(), GetWindowThreadProcessId(GetForegroundWindow(), std::ptr::null_mut()));
        if them != me {
            AttachThreadInput(me, them, 1);
        }
        SetForegroundWindow(h);
        if them != me {
            AttachThreadInput(me, them, 0);
        }
        std::thread::sleep(Duration::from_millis(150));
        if GetForegroundWindow() == h {
            Ok(false)
        } else {
            Err("Windows wouldn't let me switch back, so it's copied: click the box and press Ctrl+V.".into())
        }
    }
}

/// Focus the window, paste, put the old clipboard back. On failure the draft is left on the
/// clipboard and the error says what to do.
#[cfg(target_os = "windows")]
fn paste_into(hwnd: usize, text: &str) -> Result<(), String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::IsWindow;
    let old = arboard::Clipboard::new().and_then(|mut c| c.get_text()).ok();
    crate::system::clipboard_set(text)?;
    if unsafe { IsWindow(hwnd as *mut core::ffi::c_void) } == 0 {
        return Err("That window is gone, so it's copied: click the box and press Ctrl+V.".into());
    }
    let already = focus_quietly(hwnd)?;
    // Give the window a moment to put the caret back in its text box after being brought forward.
    std::thread::sleep(Duration::from_millis(if already { 60 } else { 300 }));
    // Never paste into some other window: if focus moved since, leave it on the clipboard.
    if unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow() } as usize != hwnd {
        return Err("The window lost focus, so it's copied: click the box and press Ctrl+V.".into());
    }
    crate::agent::paste_shortcut()?;
    std::thread::sleep(Duration::from_millis(350));
    if let Some(old) = old {
        let _ = crate::system::clipboard_set(&old);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replies_read_the_screen_new_messages_do_not() {
        assert!(needs_screen("What should I reply to this?"));
        assert!(needs_screen("reply to her saying yes"));
        assert!(!needs_screen("write me a message to my manager about leave"));
    }

    #[test]
    fn only_sensible_text_is_written() {
        assert!(check("Hi, could you check on it?").is_ok());
        assert!(check("   ").is_err());
        assert!(check(&"x".repeat(MAX_CHARS + 1)).is_err());
    }

    #[test]
    fn parses_a_draft_and_refuses_an_empty_one() {
        assert_eq!(parse(r#"{"subject":" Leave ","message":" Hi, Friday off please. "}"#).unwrap(), ("Leave".to_string(), "Hi, Friday off please.".to_string()));
        assert!(parse(r#"{"subject":"","message":"  "}"#).is_err());
        assert!(parse("nope").is_err());
    }

    #[test]
    fn the_prompt_examples_are_valid_json() {
        for line in SYSTEM.lines().filter(|l| l.starts_with("{\"subject\"")) {
            let v: Value = serde_json::from_str(line).expect("example is JSON");
            assert!(v["message"].as_str().is_some_and(|m| !m.is_empty()));
        }
    }

    /// Never writes into a private window.
    #[test]
    fn private_windows_are_recognised() {
        assert!(crate::notice::is_private("Sign in - Bank of Somewhere - Google Chrome", &[]));
        assert!(!crate::notice::is_private("#general - Slack", &[]));
    }

    /// The real thing on this desktop: a draft pasted into Notepad, nothing sent, and the clipboard
    /// you had before put back. Opens and ends a Notepad:
    ///   cargo test --lib draft::tests::paste_live -- --ignored --nocapture
    #[test]
    #[ignore]
    #[cfg(target_os = "windows")]
    fn paste_live() {
        let before = crate::system::find_processes("notepad").map(|f| f.pids).unwrap_or_default();
        // A fresh file name each run, so Notepad's restored tabs from earlier runs don't interfere.
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis();
        let name = format!("bond-draft-test-{stamp}");
        let file = std::env::temp_dir().join(format!("{name}.txt"));
        std::fs::write(&file, "").unwrap();
        std::process::Command::new("notepad").arg(&file).spawn().unwrap();
        std::thread::sleep(Duration::from_secs(4));
        let shown = crate::system::focus_app(&name).expect("Notepad comes to the front");
        println!("in front: {shown}");
        std::thread::sleep(Duration::from_millis(600));
        // focus_app taps Alt to get the window forward, which can leave Notepad's menu bar active:
        // Escape returns the keyboard to the text box (what the person's own window would have).
        let (mods, key) = crate::agent::parse_combo_for_tests("esc");
        crate::agent::press_combo_for_tests(&mods, key);
        std::thread::sleep(Duration::from_millis(300));

        crate::system::clipboard_set("my old clipboard").unwrap();
        draft_remember_target();
        let text = "Hi Cecilia,\nit has been a while since I submitted the task.\nCould you please check on it?";
        let r = tauri::async_runtime::block_on(draft_write(text.into())).expect("written");
        println!("pasted: {} · {}", r.pasted, r.note);
        assert!(r.pasted, "{}", r.note);
        assert_eq!(crate::system::clipboard_get().unwrap(), "my old clipboard", "the old clipboard is put back");

        // Read what is in the window: select all, copy.
        println!("front after paste: {:?}", active_win_pos_rs::get_active_window().map(|w| w.title));
        std::thread::sleep(Duration::from_millis(500));
        crate::system::clipboard_set("sentinel").unwrap();
        crate::agent::ctrl_combo(b'A').unwrap();
        crate::agent::ctrl_combo(b'C').unwrap();
        std::thread::sleep(Duration::from_millis(400));
        let seen = crate::system::clipboard_get().unwrap().replace("\r\n", "\n");
        println!("window text: {seen:?}");

        // Leave nothing unsaved behind (Notepad would restore it): empty the file and save.
        crate::agent::ctrl_combo(b'A').unwrap();
        std::thread::sleep(Duration::from_millis(150));
        let (mods, key) = crate::agent::parse_combo_for_tests("delete");
        crate::agent::press_combo_for_tests(&mods, key);
        std::thread::sleep(Duration::from_millis(150));
        crate::agent::ctrl_combo(b'S').unwrap();
        std::thread::sleep(Duration::from_millis(800));
        let pids: Vec<u32> = crate::system::find_processes("notepad").map(|f| f.pids).unwrap_or_default().into_iter().filter(|p| !before.contains(p)).collect();
        let _ = crate::system::kill(&pids);
        let _ = std::fs::remove_file(&file);
        assert_eq!(seen, text, "the draft is in the window, as written, with its line breaks, and nothing was sent");
    }

    /// The watcher finds the user's window even when it is not in front at the moment of asking:
    ///   cargo test --lib draft::tests::watch_live -- --ignored --nocapture
    #[test]
    #[ignore]
    #[cfg(target_os = "windows")]
    fn watch_live() {
        let before = crate::system::find_processes("notepad").map(|f| f.pids).unwrap_or_default();
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis();
        let name = format!("bond-watch-test-{stamp}");
        let file = std::env::temp_dir().join(format!("{name}.txt"));
        std::fs::write(&file, "").unwrap();
        spawn_foreground_watch();
        std::process::Command::new("notepad").arg(&file).spawn().unwrap();
        std::thread::sleep(Duration::from_secs(4));
        crate::system::focus_app(&name).expect("Notepad in front");
        std::thread::sleep(Duration::from_millis(1500));
        let t = LAST_USER.lock().unwrap().clone().expect("a user window was noted");
        println!("noted: {}", t.title);
        let pids: Vec<u32> = crate::system::find_processes("notepad").map(|f| f.pids).unwrap_or_default().into_iter().filter(|p| !before.contains(p)).collect();
        let _ = crate::system::kill(&pids);
        let _ = std::fs::remove_file(&file);
        assert!(t.title.contains(&name), "the Notepad window was noted, not {:?}", t.title);
    }

    /// The drafts the brain writes for a few requests (read them yourself):
    ///   cargo test --lib draft::tests::quality -- --ignored --nocapture
    #[test]
    #[ignore]
    fn quality() {
        let local = std::env::var("LOCALAPPDATA").expect("LOCALAPPDATA");
        crate::brain::use_dir(std::path::Path::new(&local).join("com.selfglance.app").join("brain"));
        let requests = [
            "write me a msg stating that I am sorry for the late reply and I will send the report by tomorrow evening",
            "write a polite email to my manager asking for two days of leave next week because I have a family function",
            "draft a message to cecilia asking if the new task focus has been shared yet, it's been three days since the meeting",
            "write a short message telling the team the build is fixed and they can pull the latest changes",
            "write a message to my landlord saying the water heater is broken since monday and asking when it can be fixed",
            "Write a prompt in the chatgpt stating that I want logo for selfglance and while writing prompt be professional like write it more professional way",
        ];
        tauri::async_runtime::block_on(async {
            crate::brain::brain_warm().await.expect("brain starts");
            for r in requests {
                let t = std::time::Instant::now();
                let reply = crate::brain::chat(SYSTEM, &format!("Request: {r}"), None, Some(&schema()), 600).await;
                println!("\n> {r}\n({:.1}s) {}", t.elapsed().as_secs_f64(), reply.map(|x| parse(&x).map(|(s, m)| format!("[{s}]\n{m}")).unwrap_or_else(|e| e)).unwrap_or_else(|e| e));
            }
        });
    }
}
