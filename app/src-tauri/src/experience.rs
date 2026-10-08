// What Bond learns from you. Every request is kept with what Bond did about it, how it
// went, and what you thought of it (👍 / 👎, approving or refusing what he proposed):
//
//   Right away   Before the AI handles a new request, the most similar past requests that
//                went well go into its prompt as examples. Your app names, folders, sites
//                and phrasing are reused, so he adapts without any training.
//   Later        The same log exports as a fine-tuning dataset (chat-format JSONL), to
//                train Bond's own model on your behaviour (a LoRA on Qwen3.5-4B).
//
// Stored only on this computer: <app data>/brain/experience.jsonl, one JSON object per
// line, appended (feedback is its own line, merged on read). "Learn from me" off in
// Settings stops recording; "Forget" deletes the file.

use std::collections::HashSet;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Clone)]
pub struct Exp {
    pub id: String,
    /// ms since the epoch.
    pub ts: i64,
    /// "rule" (understood on his own), "route" (the AI read a command), "screen".
    pub kind: String,
    pub input: String,
    /// The app you were in when you asked.
    #[serde(default)]
    pub app: String,
    /// What Bond decided: {"intent","text","reply","actions","needs_screen"}.
    pub output: Value,
    /// Which brain answered ("local", "gemini", "claude", "rules").
    #[serde(default)]
    pub brain: String,
    pub ok: bool,
    #[serde(default)]
    pub error: Option<String>,
    /// "good", "bad", or "declined" (you refused what he proposed).
    #[serde(default)]
    pub feedback: Option<String>,
}

#[derive(Deserialize)]
struct FeedbackLine {
    feedback_for: String,
    value: String,
}

static LEARN: AtomicBool = AtomicBool::new(true);
static STORE: Mutex<Option<Vec<Exp>>> = Mutex::new(None);
static FILE: Mutex<Option<PathBuf>> = Mutex::new(None);

pub fn init(app: &AppHandle) {
    if let Ok(d) = app.path().app_data_dir() {
        *FILE.lock().unwrap() = Some(d.join("brain").join("experience.jsonl"));
    }
}

fn path() -> Option<PathBuf> {
    FILE.lock().unwrap().clone()
}

fn with_store<T>(f: impl FnOnce(&mut Vec<Exp>) -> T) -> T {
    let mut guard = STORE.lock().unwrap();
    let list = guard.get_or_insert_with(load);
    f(list)
}

fn load() -> Vec<Exp> {
    let Some(text) = path().and_then(|p| std::fs::read_to_string(p).ok()) else { return Vec::new() };
    let mut list: Vec<Exp> = Vec::new();
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        if let Ok(e) = serde_json::from_str::<Exp>(line) {
            list.push(e);
        } else if let Ok(f) = serde_json::from_str::<FeedbackLine>(line) {
            if let Some(e) = list.iter_mut().rev().find(|e| e.id == f.feedback_for) {
                e.feedback = Some(f.value);
            }
        }
    }
    list
}

fn append(line: &Value) {
    let Some(p) = path() else { return };
    if let Some(d) = p.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p) {
        let _ = writeln!(f, "{line}");
    }
}

fn new_id() -> String {
    format!("{:x}", chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default())
}

/// The app in front right now (the user's, once the Ask box has given focus back).
fn foreground_app() -> String {
    active_win_pos_rs::get_active_window().map(|w| w.app_name).unwrap_or_default()
}

/// Keep one request and what came of it. Returns its id (for feedback), or "" when
/// learning is off.
pub fn record(kind: &str, input: &str, output: Value, brain: &str, result: Result<(), String>) -> String {
    if !LEARN.load(Ordering::Relaxed) || input.trim().is_empty() {
        return String::new();
    }
    let e = Exp {
        id: new_id(),
        ts: chrono::Utc::now().timestamp_millis(),
        kind: kind.into(),
        input: input.trim().chars().take(2000).collect(),
        app: foreground_app(),
        output,
        brain: brain.into(),
        ok: result.is_ok(),
        error: result.err(),
        feedback: None,
    };
    append(&serde_json::to_value(&e).unwrap_or_default());
    let id = e.id.clone();
    with_store(|l| l.push(e));
    id
}

fn set_feedback(id: &str, value: &str) {
    if id.is_empty() || !LEARN.load(Ordering::Relaxed) {
        return;
    }
    let found = with_store(|l| match l.iter_mut().rev().find(|e| e.id == id) {
        Some(e) => {
            e.feedback = Some(value.into());
            true
        }
        None => false,
    });
    if found {
        append(&json!({"feedback_for": id, "value": value}));
    }
}

// --- Recall ------------------------------------------------------------------------------

const STOP: &[&str] = &[
    "a", "an", "the", "to", "of", "and", "or", "in", "on", "for", "my", "me", "i", "it", "is", "please", "can", "you", "could", "would", "bond",
    "hey", "with", "at", "this", "that", "up", "do",
];

fn words(s: &str) -> HashSet<String> {
    s.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty() && !STOP.contains(w))
        .map(str::to_string)
        .collect()
}

fn similarity(a: &HashSet<String>, b: &HashSet<String>) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let shared = a.intersection(b).count() as f64;
    shared / ((a.len() * b.len()) as f64).sqrt()
}

/// A past request worth imitating: it worked and you didn't object.
fn trusted(e: &Exp) -> bool {
    e.ok && (e.kind == "rule" || e.kind == "route") && !matches!(e.feedback.as_deref(), Some("bad" | "declined"))
}

/// The past requests most like `input` that went well, newest preferred, as prompt text.
/// Empty when there's nothing close enough.
pub fn examples_for(input: &str, max: usize) -> String {
    let q = words(input);
    let mut scored: Vec<(f64, Exp)> = with_store(|l| {
        l.iter()
            .filter(|e| trusted(e))
            .map(|e| (similarity(&q, &words(&e.input)) + if e.feedback.as_deref() == Some("good") { 0.1 } else { 0.0 }, e.clone()))
            .filter(|(s, _)| *s >= 0.4)
            .collect()
    });
    scored.sort_by(|a, b| b.0.total_cmp(&a.0).then(b.1.ts.cmp(&a.1.ts)));
    let mut seen = HashSet::new();
    let lines: Vec<String> = scored
        .into_iter()
        .filter(|(_, e)| seen.insert(e.input.to_lowercase()))
        .take(max)
        .map(|(_, e)| format!("User: {}\nYou: {}", e.input, compact(&e.output)))
        .collect();
    if lines.is_empty() {
        return String::new();
    }
    format!(
        "How this user's similar requests were handled before (they worked; follow the same habits: app names, folders, sites, wording):\n{}",
        lines.join("\n")
    )
}

/// The decision as the router writes it, without empty fields.
fn compact(v: &Value) -> String {
    let mut o = serde_json::Map::new();
    for k in ["intent", "text", "reply", "actions", "needs_screen"] {
        match &v[k] {
            Value::Null => {}
            Value::String(s) if s.is_empty() => {}
            Value::Array(a) if a.is_empty() => {}
            Value::Bool(false) => {}
            x => {
                o.insert(k.into(), x.clone());
            }
        }
    }
    Value::Object(o).to_string()
}

// --- Commands ----------------------------------------------------------------------------

#[tauri::command]
pub fn brain_set_learning(on: bool) {
    LEARN.store(on, Ordering::Relaxed);
}

/// 👍 / 👎 on an answer, or "declined" when you refuse what he proposed.
#[tauri::command]
pub fn brain_feedback(id: String, value: String) {
    if matches!(value.as_str(), "good" | "bad" | "declined") {
        set_feedback(&id, &value);
    }
}

/// Something Bond understood on his own (no AI), worth learning from: it's always right.
#[tauri::command]
pub fn brain_record(input: String, output: Value, ok: bool, error: Option<String>) -> String {
    record("rule", &input, output, "rules", if ok { Ok(()) } else { Err(error.unwrap_or_default()) })
}

#[derive(Serialize)]
pub struct LearnStats {
    total: usize,
    good: usize,
    bad: usize,
    /// Usable as training examples.
    trainable: usize,
}

#[tauri::command]
pub fn brain_learn_stats() -> LearnStats {
    with_store(|l| LearnStats {
        total: l.len(),
        good: l.iter().filter(|e| e.feedback.as_deref() == Some("good")).count(),
        bad: l.iter().filter(|e| matches!(e.feedback.as_deref(), Some("bad" | "declined"))).count(),
        trainable: l.iter().filter(|e| trusted(e)).count(),
    })
}

/// Delete everything Bond has learned.
#[tauri::command]
pub fn brain_forget() {
    with_store(|l| l.clear());
    if let Some(p) = path() {
        let _ = std::fs::remove_file(p);
    }
}

/// Write the trusted examples as a chat fine-tuning dataset; returns the file path.
#[tauri::command]
pub fn brain_export() -> Result<String, String> {
    let system = crate::ai::router_system_for_training();
    let rows: Vec<String> = with_store(|l| {
        l.iter()
            .filter(|e| trusted(e))
            .map(|e| {
                json!({"messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": e.input},
                    {"role": "assistant", "content": compact(&e.output)},
                ]})
                .to_string()
            })
            .collect()
    });
    if rows.is_empty() {
        return Err("Nothing to export yet — use Bond for a while first.".into());
    }
    let out = path().ok_or("The app data folder isn't available.")?.with_file_name("bond-router-sft.jsonl");
    std::fs::write(&out, rows.join("\n") + "\n").map_err(|e| e.to_string())?;
    Ok(out.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn similar_requests_score_high() {
        let a = words("open my selfglance project in vs code");
        assert!(similarity(&a, &words("open the selfglance project in vscode")) > 0.4);
        assert!(similarity(&a, &words("what's the weather")) < 0.1);
    }

    #[test]
    fn compact_drops_empty_fields() {
        let v = json!({"intent": "task", "text": "", "reply": "On it", "actions": [{"do": "lock_screen"}], "needs_screen": false});
        assert_eq!(compact(&v), r#"{"intent":"task","reply":"On it","actions":[{"do":"lock_screen"}]}"#);
    }
}
