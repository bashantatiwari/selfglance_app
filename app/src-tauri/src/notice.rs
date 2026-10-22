// Bond notices: suggestions he makes without being asked, like a colleague at the next desk.
//
//   Habits    what you ask him for again and again in the same situation (same app, or the
//             same time of day, on 3+ different days), found in his experience log:
//             "You usually open Spotify when you start in VS Code. Want it?"
//   Stuck     the frontend sees several web searches in a few minutes while you're working;
//             the brain decides whether it has one specific tip (optionally after looking
//             at the screen).
//   Error     you copied an error message, or one is showing in the editor or terminal
//             you're working in (read on-device by OCR during a pause); the brain decides
//             whether it can explain it.
//
// The brain judges on this laptop, like everything else Bond does: nothing is sent to any
// cloud service. He never looks at password managers, banking or private browser windows, and
// doesn't think on battery below 30% (unplugged).
//
// How each suggestion went (taken, 👎, or let pass) goes into the experience log, and
// decides whether he makes it again: a 👎 mutes it for two weeks; one that's ignored three
// times and never taken stops coming. When and how often he speaks up (natural pauses, a
// per-hour cap, quiet hours, your settings) is decided by the frontend (assistant/notice.ts).

use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use chrono::{Local, TimeZone};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::experience::{self, Exp};

/// Suggestions are switched on (the clipboard watch only runs then).
static ON: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub fn notice_enable(on: bool) {
    ON.store(on, Ordering::Relaxed);
}

// --- Habits ------------------------------------------------------------------------------

/// Actions worth offering again: harmless, and the same every time.
const HABIT_ACTIONS: &[&str] = &["open_app", "open_url", "open_folder", "media", "set_volume"];
/// Different days a request must have been made on to count as a habit.
const HABIT_DAYS: usize = 3;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Habit {
    /// Identifies this suggestion in the log ("habit:<actions>@app:<app>").
    key: String,
    /// It applies when you're in this app…
    app: Option<String>,
    /// …or around this hour (0-23).
    hour: Option<u32>,
    actions: Value,
    /// What he'd do, for the card: "open Spotify".
    label: String,
    /// On how many different days you asked for it.
    days: usize,
    /// Already done today: no need to offer it.
    done_today: bool,
}

fn local(ts: i64) -> chrono::DateTime<Local> {
    Local.timestamp_millis_opt(ts).single().unwrap_or_else(Local::now)
}

/// The actions of a request that went well, if they could make a habit.
fn habit_actions(e: &Exp) -> Option<&Value> {
    let trusted = e.ok && (e.kind == "rule" || e.kind == "route") && !matches!(e.feedback.as_deref(), Some("bad" | "declined"));
    let actions = e.output.get("actions")?;
    let list = actions.as_array()?;
    let eligible = !list.is_empty() && list.iter().all(|a| a["do"].as_str().is_some_and(|d| HABIT_ACTIONS.contains(&d)));
    (trusted && eligible).then_some(actions)
}

/// The same actions written the same way ("Spotify" and "spotify" are one habit).
fn signature(actions: &Value) -> String {
    actions.to_string().to_lowercase()
}

fn describe(actions: &Value) -> String {
    let parts: Vec<String> = actions
        .as_array()
        .map(|l| {
            l.iter()
                .map(|a| {
                    let s = |k: &str| a[k].as_str().unwrap_or("").to_string();
                    match a["do"].as_str().unwrap_or("") {
                        "open_app" => format!("open {}", s("name")),
                        "open_url" => {
                            let url = s("url");
                            let host = url.split("://").nth(1).unwrap_or(&url).split('/').next().unwrap_or("").trim_start_matches("www.").to_string();
                            format!("open {host}")
                        }
                        "open_folder" => format!("open your {} folder", s("name")),
                        "media" => match s("key").as_str() {
                            "play_pause" => "play your music".into(),
                            "mute" => "mute the sound".into(),
                            k => k.replace('_', " "),
                        },
                        "set_volume" => format!("set the volume to {}%", a["percent"].as_f64().unwrap_or(0.0)),
                        d => d.replace('_', " "),
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    match parts.len() {
        0 => String::new(),
        1 => parts[0].clone(),
        n => format!("{} and {}", parts[..n - 1].join(", "), parts[n - 1]),
    }
}

/// Habits in the log, as of `now` (ms).
fn find_habits(log: &[Exp], now: i64) -> Vec<Habit> {
    let today = local(now).date_naive();
    // signature → (actions, by app → days, by hour → days, done today)
    struct Seen {
        actions: Value,
        apps: BTreeMap<String, BTreeSet<chrono::NaiveDate>>,
        hours: BTreeMap<u32, BTreeSet<chrono::NaiveDate>>,
        today: bool,
    }
    let mut seen: BTreeMap<String, Seen> = BTreeMap::new();
    for e in log {
        let Some(actions) = habit_actions(e) else { continue };
        let t = local(e.ts);
        let s = seen.entry(signature(actions)).or_insert_with(|| Seen {
            actions: actions.clone(),
            apps: BTreeMap::new(),
            hours: BTreeMap::new(),
            today: false,
        });
        if !e.app.trim().is_empty() && !e.app.eq_ignore_ascii_case("selfglance") {
            s.apps.entry(e.app.clone()).or_default().insert(t.date_naive());
        }
        use chrono::Timelike;
        s.hours.entry(t.hour()).or_default().insert(t.date_naive());
        s.today |= t.date_naive() == today;
    }
    let mut out = Vec::new();
    for (sig, s) in seen {
        let label = describe(&s.actions);
        let mut by_app = false;
        for (app, days) in &s.apps {
            if days.len() >= HABIT_DAYS {
                by_app = true;
                out.push(Habit {
                    key: format!("habit:{sig}@app:{}", app.to_lowercase()),
                    app: Some(app.clone()),
                    hour: None,
                    actions: s.actions.clone(),
                    label: label.clone(),
                    days: days.len(),
                    done_today: s.today,
                });
            }
        }
        if by_app {
            continue; // the app says more than the time of day
        }
        // Around the same hour: count this hour together with its neighbours.
        for h in 0..24u32 {
            let days: BTreeSet<_> = [(h + 23) % 24, h, (h + 1) % 24].iter().filter_map(|x| s.hours.get(x)).flatten().collect();
            let centre = s.hours.get(&h).map_or(0, |d| d.len());
            if days.len() >= HABIT_DAYS && centre > 0 && s.hours.iter().all(|(x, d)| *x == h || d.len() <= centre) {
                out.push(Habit {
                    key: format!("habit:{sig}@hour:{h}"),
                    app: None,
                    hour: Some(h),
                    actions: s.actions.clone(),
                    label: label.clone(),
                    days: days.len(),
                    done_today: s.today,
                });
                break;
            }
        }
    }
    out
}

#[tauri::command]
pub fn notice_habits() -> Vec<Habit> {
    find_habits(&experience::snapshot(), chrono::Utc::now().timestamp_millis())
}

// --- How suggestions went ----------------------------------------------------------------

const MUTE_AFTER_BAD_MS: i64 = 14 * 24 * 3600 * 1000;
const DAY_MS: i64 = 24 * 3600 * 1000;

#[derive(Serialize, Debug, PartialEq)]
pub struct Allowed {
    allowed: bool,
    /// Why not, for the log.
    reason: String,
}

fn allowed_at(log: &[Exp], key: &str, min_gap_min: f64, now: i64) -> Allowed {
    let shown: Vec<&Exp> = log.iter().filter(|e| e.kind == "notice" && e.input == key).collect();
    let no = |r: &str| Allowed { allowed: false, reason: r.into() };
    if shown.iter().any(|e| e.feedback.as_deref() == Some("bad") && now - e.ts < MUTE_AFTER_BAD_MS) {
        return no("you said not to");
    }
    if let Some(last) = shown.last() {
        if ((now - last.ts) as f64) < min_gap_min * 60_000.0 {
            return no("suggested recently");
        }
        // Habits once a day at most.
        if key.starts_with("habit:") && local(last.ts).date_naive() == local(now).date_naive() {
            return no("already offered today");
        }
    }
    let taken = shown.iter().filter(|e| e.feedback.as_deref() == Some("good")).count();
    let passed = shown.iter().filter(|e| matches!(e.feedback.as_deref(), Some("ignored") | None)).count();
    if taken == 0 && passed >= 3 {
        // Try again only after a long while: maybe it's useful now.
        if shown.last().is_some_and(|l| now - l.ts < 7 * DAY_MS) {
            return no("you never take it");
        }
    }
    Allowed { allowed: true, reason: String::new() }
}

/// May he make this suggestion now? `min_gap_min`: least minutes since he last made it.
#[tauri::command]
pub fn notice_allowed(key: String, min_gap_min: f64) -> Allowed {
    allowed_at(&experience::snapshot(), &key, min_gap_min, chrono::Utc::now().timestamp_millis())
}

/// He made a suggestion; returns its id, for how it went (brain_feedback: "good" when you
/// take it, "bad" for 👎, "ignored" when you let it pass).
#[tauri::command]
pub fn notice_shown(key: String, text: String) -> String {
    experience::record("notice", &key, json!({"text": text}), "bond", Ok(()))
}

// --- Judging -----------------------------------------------------------------------------

/// Windows he never looks at or thinks about on his own.
const PRIVATE: &[&str] = &[
    "password", "1password", "bitwarden", "keepass", "lastpass", "dashlane", "bank", "paypal", "wallet", "inprivate", "incognito", "private browsing",
    "credential", "sign in", "log in", "login",
];

pub(crate) fn is_private(text: &str, blocked: &[String]) -> bool {
    let t = text.to_lowercase();
    PRIVATE.iter().any(|p| t.contains(p)) || blocked.iter().any(|b| !b.trim().is_empty() && t.contains(&b.trim().to_lowercase()))
}

pub(crate) fn low_battery() -> bool {
    crate::system::battery().is_some_and(|b| !b.charging && b.percent < 30)
}

const NOTICE_SYSTEM: &str = r#"You are Bond, a quiet desktop companion sitting beside the user while they work, like a helpful colleague at the next desk.
Something suggests they might want help (below). First name the concrete problem in "problem", or "unclear" if the details don't show one.
Then decide whether you have ONE specific, genuinely useful thing to say right now:
- suggest only when the problem is concrete and you know the usual cause or fix. A clear error message with a known cause IS concrete: explain the cause and the fix.
- don't suggest when the problem is unclear, it's not about their work, or all you could offer is generic advice (take a break, save again, restart, check the docs, search online, stay positive, let me know).
Never make things up. text = what you'd say: at most 2 short sentences, friendly, plain text, no markdown. confidence = how sure you are it helps, 0 to 1.

Examples:
Copied: "ModuleNotFoundError: No module named 'requests'" → {"problem":"the requests package isn't installed in this Python environment","suggest":true,"confidence":0.9,"text":"That means requests isn't installed here — run pip install requests in the same environment you run the script from."}
Copied: "Failed to load resource: the server responded with a status of 404" → {"problem":"unclear: which file is missing isn't shown","suggest":false,"confidence":0.2,"text":""}
Searched: "cheap flights to delhi", "delhi weather october" → {"problem":"unclear: personal browsing, not stuck on work","suggest":false,"confidence":0.1,"text":""}
Searched: "git push rejected non-fast-forward", "git pull before push" → {"problem":"the remote branch has commits they don't have locally","suggest":true,"confidence":0.85,"text":"Your branch is behind the remote: run git pull --rebase, fix any conflicts, then push again."}"#;

#[derive(Serialize, Debug)]
pub struct Judgement {
    /// The brain looked at it (false: no brain here, a private window, or low battery).
    judged: bool,
    suggest: bool,
    text: String,
}

/// Ask the local brain whether to say something. `details` describes the moment (recent
/// searches, the copied error…); `look` adds a screenshot.
#[tauri::command]
pub async fn notice_judge(details: String, look: bool, blocked: Vec<String>) -> Result<Judgement, String> {
    let nothing = Judgement { judged: false, suggest: false, text: String::new() };
    if !crate::brain::ready() || low_battery() {
        return Ok(nothing);
    }
    let window = active_win_pos_rs::get_active_window().map(|w| format!("{} — {}", w.app_name, w.title)).unwrap_or_default();
    if is_private(&window, &blocked) || is_private(&details, &[]) {
        return Ok(nothing);
    }
    let shot = if look { tauri::async_runtime::spawn_blocking(crate::ai::capture).await.map_err(|e| e.to_string())?.ok() } else { None };
    let details = match &shot {
        Some(s) if !s.seen.is_empty() => format!("{details}\n{}", s.seen),
        _ => details,
    };
    judge(&window, &details, shot.as_ref().map(|s| s.b64.as_str())).await
}

async fn judge(window: &str, details: &str, image: Option<&str>) -> Result<Judgement, String> {
    let prompt = format!(
        "The window in front: {window}\n{details}{}",
        if image.is_some() { "\nThe screenshot shows their screen right now." } else { "" }
    );
    let schema = json!({
        "type": "object",
        "properties": {
            "problem": {"type": "string", "maxLength": 200},
            "suggest": {"type": "boolean"},
            "confidence": {"type": "number"},
            "text": {"type": "string", "maxLength": 300},
        },
        "required": ["problem", "suggest", "confidence", "text"],
        "additionalProperties": false,
    });
    let reply = crate::brain::chat(NOTICE_SYSTEM, &prompt, image.as_deref(), Some(&schema), 260).await?;
    let v: Value = serde_json::from_str(&reply).unwrap_or(Value::Null);
    let text = v["text"].as_str().unwrap_or("").trim().to_string();
    let sure = v["confidence"].as_f64().unwrap_or(0.0) >= 0.6 && !v["problem"].as_str().unwrap_or("unclear").to_lowercase().starts_with("unclear");
    Ok(Judgement { judged: true, suggest: v["suggest"] == true && sure && !text.is_empty(), text })
}

// --- Copied an error ---------------------------------------------------------------------

/// Text that looks like an error message or stack trace.
pub fn looks_like_error(text: &str) -> bool {
    let len = text.trim().len();
    (15..=20_000).contains(&len) && has_marker(text)
}

fn has_marker(text: &str) -> bool {
    let t = text.to_lowercase();
    const MARKERS: &[&str] = &[
        "traceback (most recent call last)",
        "exception",
        "error:",
        "error[e",
        "npm err!",
        "panicked at",
        "syntaxerror",
        "typeerror",
        "referenceerror",
        "is not recognized as",
        "fatal:",
        "unhandled",
        "segmentation fault",
        "cannot find module",
        "undefined reference",
        "build failed",
        "command failed",
        "permission denied",
        "access is denied",
        "stack trace",
    ];
    MARKERS.iter().any(|m| t.contains(m))
}

/// The last error in some lines of screen text (the bottom one is the newest in a terminal),
/// with a little context: a few lines before, several after.
fn error_snippet(lines: &[String]) -> Option<String> {
    let i = lines.iter().rposition(|l| has_marker(l))?;
    let from = i.saturating_sub(3);
    let to = (i + 9).min(lines.len());
    let snippet = lines[from..to].join("\n");
    (snippet.trim().len() >= 15).then_some(snippet)
}

/// The error showing in the window you're working in, if any, read on-device by OCR.
/// Nothing is read in private windows or the apps you blocked.
#[tauri::command]
pub async fn notice_scan(blocked: Vec<String>) -> Result<Option<String>, String> {
    if !ON.load(Ordering::Relaxed) {
        return Ok(None);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let Ok(w) = active_win_pos_rs::get_active_window() else { return None };
        if w.process_id == std::process::id() as u64 || is_private(&format!("{} {}", w.app_name, w.title), &blocked) {
            return None;
        }
        // The monitor the window is on, then just the window's part of it.
        let (cx, cy) = (w.position.x + w.position.width / 2.0, w.position.y + w.position.height / 2.0);
        let monitor = xcap::Monitor::from_point(cx as i32, cy as i32).ok()?;
        let (mx, my) = (monitor.x().ok()? as f64, monitor.y().ok()? as f64);
        let img = monitor.capture_image().ok()?;
        let x = (w.position.x - mx).clamp(0.0, img.width() as f64) as u32;
        let y = (w.position.y - my).clamp(0.0, img.height() as f64) as u32;
        let width = (w.position.width as u32).min(img.width() - x);
        let height = (w.position.height as u32).min(img.height() - y);
        if width < 50 || height < 50 {
            return None;
        }
        let part = image::imageops::crop_imm(&img, x, y, width, height).to_image();
        let lines: Vec<String> = crate::screen::ocr(&part, 0.0, 0.0).ok()?.into_iter().map(|l| l.text).collect();
        error_snippet(&lines)
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(target_os = "windows")]
fn clipboard_version() -> u32 {
    unsafe { windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber() }
}

#[cfg(not(target_os = "windows"))]
fn clipboard_version() -> u32 {
    0 // no cheap change counter: never read the clipboard on our own
}

/// Emits `clipboard-error` (the text, trimmed) when you copy something that looks like an
/// error, while suggestions are on. Reads the clipboard only when it has changed.
pub fn spawn_clipboard_watch(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last = clipboard_version();
        loop {
            std::thread::sleep(Duration::from_millis(1500));
            let now = clipboard_version();
            if now == last || now == 0 {
                continue;
            }
            last = now;
            if !ON.load(Ordering::Relaxed) {
                continue;
            }
            if let Ok(text) = crate::system::clipboard_get() {
                if looks_like_error(&text) {
                    let _ = app.emit("clipboard-error", text.chars().take(6000).collect::<String>());
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: i64 = 24 * 3600 * 1000;

    fn exp(ts: i64, app: &str, actions: Value) -> Exp {
        Exp {
            id: ts.to_string(),
            ts,
            kind: "rule".into(),
            input: "open spotify".into(),
            app: app.into(),
            output: json!({"intent": "task", "actions": actions}),
            brain: "rules".into(),
            ok: true,
            error: None,
            feedback: None,
        }
    }

    fn at(day: i64, hour: u32) -> i64 {
        let base = Local.with_ymd_and_hms(2026, 10, 1, 0, 0, 0).unwrap().timestamp_millis();
        base + day * DAY + hour as i64 * 3600 * 1000
    }

    #[test]
    fn habit_by_app_after_three_days() {
        let spotify = json!([{"do": "open_app", "name": "Spotify"}]);
        let mut log = vec![exp(at(0, 10), "Visual Studio Code", spotify.clone()), exp(at(1, 14), "Visual Studio Code", spotify.clone())];
        assert!(find_habits(&log, at(2, 9)).is_empty(), "two days is not a habit");
        log.push(exp(at(2, 20), "Visual Studio Code", json!([{"do": "open_app", "name": "spotify"}])));
        let h = find_habits(&log, at(3, 9));
        assert_eq!(h.len(), 1);
        assert_eq!(h[0].app.as_deref(), Some("Visual Studio Code"));
        assert_eq!(h[0].label, "open Spotify");
        assert!(!h[0].done_today);
        assert!(find_habits(&log, at(2, 21))[0].done_today);
    }

    #[test]
    fn habit_by_hour_when_apps_differ() {
        let lofi = json!([{"do": "open_url", "url": "https://www.youtube.com/watch?v=lofi"}]);
        let log = vec![exp(at(0, 9), "Chrome", lofi.clone()), exp(at(1, 9), "Explorer", lofi.clone()), exp(at(2, 10), "Code", lofi.clone())];
        let h = find_habits(&log, at(3, 8));
        assert_eq!(h.len(), 1);
        assert_eq!(h[0].hour, Some(9));
        assert_eq!(h[0].label, "open youtube.com");
    }

    #[test]
    fn risky_or_failed_requests_are_not_habits() {
        let cmd = json!([{"do": "run_command", "command": "ipconfig", "why": ""}]);
        let log: Vec<Exp> = (0..4).map(|d| exp(at(d, 9), "Code", cmd.clone())).collect();
        assert!(find_habits(&log, at(5, 9)).is_empty());
        let mut failed: Vec<Exp> = (0..4).map(|d| exp(at(d, 9), "Code", json!([{"do": "open_app", "name": "X"}]))).collect();
        failed.iter_mut().for_each(|e| e.ok = false);
        assert!(find_habits(&failed, at(5, 9)).is_empty());
    }

    fn notice(ts: i64, key: &str, feedback: Option<&str>) -> Exp {
        let mut e = exp(ts, "Code", json!(null));
        e.kind = "notice".into();
        e.input = key.into();
        e.feedback = feedback.map(str::to_string);
        e
    }

    #[test]
    fn suggestions_back_off() {
        let k = "stuck@code";
        assert!(allowed_at(&[], k, 30.0, at(0, 9)).allowed);
        // Too soon after the last one.
        assert!(!allowed_at(&[notice(at(0, 9), k, Some("good"))], k, 30.0, at(0, 9) + 10 * 60_000).allowed);
        assert!(allowed_at(&[notice(at(0, 9), k, Some("good"))], k, 30.0, at(0, 10)).allowed);
        // 👎 mutes it for two weeks.
        assert!(!allowed_at(&[notice(at(0, 9), k, Some("bad"))], k, 30.0, at(10, 9)).allowed);
        assert!(allowed_at(&[notice(at(0, 9), k, Some("bad"))], k, 30.0, at(15, 9)).allowed);
        // Ignored three times, never taken: quiet for a week.
        let ignored: Vec<Exp> = (0..3).map(|d| notice(at(d, 9), k, Some("ignored"))).collect();
        assert!(!allowed_at(&ignored, k, 30.0, at(4, 9)).allowed);
        assert!(allowed_at(&ignored, k, 30.0, at(10, 9)).allowed);
        // A habit at most once a day.
        let h = "habit:x@app:code";
        assert!(!allowed_at(&[notice(at(0, 9), h, Some("good"))], h, 5.0, at(0, 15)).allowed);
    }

    /// Does the local brain speak up only when it has something specific?
    ///   cargo test --lib notice::tests::judgement -- --ignored --nocapture
    #[test]
    #[ignore]
    fn judgement() {
        let local = std::env::var("LOCALAPPDATA").unwrap();
        crate::brain::use_dir(std::path::Path::new(&local).join("com.selfglance.app").join("brain"));
        let searched = |q: &[&str]| format!("They searched the web {} times in the last 6 minutes while working: \"{}\".", q.len(), q.join("\", \""));
        let copied = |e: &str| format!("They just copied this error:\n{e}");
        let cases: Vec<(bool, &str, String)> = vec![
            (true, "main.rs - api - Visual Studio Code", searched(&["rust borrow of moved value", "rust value moved into closure", "error E0382 rust"])),
            (true, "App.tsx - shop - Visual Studio Code", copied("TypeError: Cannot read properties of undefined (reading 'map')\n    at ProductList (ProductList.tsx:42:18)")),
            (true, "Windows PowerShell", copied("pip : The term 'pip' is not recognized as the name of a cmdlet, function, script file, or operable program.")),
            (false, "Inbox - Gmail - Google Chrome", searched(&["weather tomorrow", "pizza near me", "movie times tonight"])),
            (false, "report.docx - Word", copied("Error: something went wrong.")),
            (false, "notes.md - Obsidian", searched(&["how to be more productive", "best productivity apps", "pomodoro technique"])),
        ];
        tauri::async_runtime::block_on(async {
            crate::brain::brain_warm().await.expect("brain starts");
            let mut right = 0;
            for (want, window, details) in &cases {
                let t = std::time::Instant::now();
                let j = judge(window, details, None).await.unwrap();
                right += (j.suggest == *want) as usize;
                println!("{} {:.1}s want {want:<5} got {:<5} {}", if j.suggest == *want { "✓" } else { "✗" }, t.elapsed().as_secs_f64(), j.suggest, j.text);
            }
            println!("{right} / {} right", cases.len());
            crate::brain::brain_stop();
        });
    }

    #[test]
    fn finds_the_newest_error_on_screen() {
        let lines: Vec<String> = ["$ cargo build", "   Compiling api v0.1.0", "error[E0382]: borrow of moved value: `cfg`", "  --> src/main.rs:12:5", "$ npm test", "npm ERR! Test failed.", "See above for more details."]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let s = error_snippet(&lines).unwrap();
        // The newest error (npm's), with the three lines before it.
        assert!(s.starts_with("error[E0382]"), "{s}");
        assert!(s.ends_with("See above for more details."), "{s}");
        assert!(error_snippet(&["all good".to_string(), "tests passed".to_string()]).is_none());
    }

    #[test]
    fn spots_errors_and_private_windows() {
        assert!(looks_like_error("Traceback (most recent call last):\n  File \"a.py\", line 1"));
        assert!(looks_like_error("error[E0382]: borrow of moved value: `x`"));
        assert!(!looks_like_error("see you at 5"));
        assert!(!looks_like_error("Meeting notes: discussed the error budget for Q4 and next steps for launch")); // no marker phrase
        assert!(is_private("Bitwarden — Vault", &[]));
        assert!(is_private("Chase Bank - Google Chrome", &[]));
        assert!(is_private("Payroll — Excel", &["payroll".into()]));
        assert!(!is_private("main.rs — selfglance — Visual Studio Code", &[]));
    }
}
