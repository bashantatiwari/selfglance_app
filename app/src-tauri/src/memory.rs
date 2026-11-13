// What Bond keeps in mind between requests, so a conversation can go on:
//
//   Conversation  the last few exchanges (what you said, what he said or did, what he saw on
//                 screen), for 10 minutes. "Close it" after "open Notepad" means Notepad;
//                 "yes, run it" means the command he just proposed.
//   About you     what you wrote in Settings → About you (one line, put first), and lasting
//                 facts you tell him ("call me Alex"), kept in memory.json in the app data
//                 folder and given to the brain with every request. Settings lists them; any
//                 can be forgotten.
//   Right now     the app and window in front of you.
//
// Without this every request reached the brain alone: "Say my name again" got "Your name
// is Sam" a minute after "Call me Alex".

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// Exchanges older than this are a new conversation.
const CONVERSATION: Duration = Duration::from_secs(10 * 60);
const MAX_TURNS: usize = 8;
const MAX_FACTS: usize = 60;
const MAX_TEXT: usize = 400;

struct Turn {
    at: Instant,
    you: String,
    bond: String,
}

static TURNS: Mutex<VecDeque<Turn>> = Mutex::new(VecDeque::new());

/// A job Bond walked you through ("create a YouTube channel"), kept for hours so that a later
/// "now write the bio for it" knows what "it" is, long after the 10-minute conversation is gone.
struct Job {
    at: Instant,
    goal: String,
    steps: Vec<String>,
    finished: bool,
    /// What you told him about it afterwards ("The channel is about cooking").
    notes: Vec<String>,
}

const JOB_KEEP: Duration = Duration::from_secs(6 * 60 * 60);
const MAX_JOBS: usize = 3;
static JOBS: Mutex<VecDeque<Job>> = Mutex::new(VecDeque::new());

/// A guided job ended: what the goal was and the steps he showed (finished, or stopped early).
#[tauri::command]
pub fn job_done(goal: String, steps: Vec<String>, finished: bool) {
    if goal.trim().is_empty() {
        return;
    }
    let mut jobs = JOBS.lock().unwrap();
    jobs.retain(|j| j.at.elapsed() < JOB_KEEP);
    jobs.push_back(Job { at: Instant::now(), goal: clip(&goal), steps: steps.iter().take(12).map(|s| clip(s)).collect(), finished, notes: Vec::new() });
    while jobs.len() > MAX_JOBS {
        jobs.pop_front();
    }
}

/// Something you told him about the latest job (an answer to "what is the channel about?").
#[tauri::command]
pub fn job_note(note: String) {
    let note = clip(&note);
    if note.is_empty() {
        return;
    }
    let mut jobs = JOBS.lock().unwrap();
    jobs.retain(|j| j.at.elapsed() < JOB_KEEP);
    match jobs.back_mut() {
        Some(j) => j.notes.push(note),
        None => jobs.push_back(Job { at: Instant::now(), goal: "something the user is working on".into(), steps: Vec::new(), finished: false, notes: vec![note] }),
    }
}

fn jobs_block() -> Option<String> {
    let jobs = JOBS.lock().unwrap();
    let lines: Vec<String> = jobs
        .iter()
        .filter(|j| j.at.elapsed() < JOB_KEEP)
        .map(|j| {
            let mut s = format!("- {} ({})", j.goal, if j.finished { "finished" } else { "stopped before the end" });
            if !j.steps.is_empty() {
                s.push_str(&format!("; steps shown: {}", j.steps.join("; ")));
            }
            if !j.notes.is_empty() {
                s.push_str(&format!("; the user said: {}", j.notes.join(" ")));
            }
            s
        })
        .collect();
    (!lines.is_empty()).then(|| format!("Jobs you recently walked the user through (oldest first):\n{}", lines.join("\n")))
}
static NOW: Mutex<Option<String>> = Mutex::new(None);
/// The program in front of you: (process name, app name), for "close it".
static LAST_APP: Mutex<Option<(String, String)>> = Mutex::new(None);
static FILE: Mutex<Option<PathBuf>> = Mutex::new(None);
static FACTS: Mutex<Option<Vec<String>>> = Mutex::new(None);

#[derive(Serialize, Deserialize, Default)]
struct Stored {
    #[serde(default)]
    facts: Vec<String>,
    /// Settings → About you, as the one line the screens made of it (assistant/profile.ts).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    profile: String,
}

static PROFILE: Mutex<Option<String>> = Mutex::new(None);
/// The most of the profile line kept: it goes into every request, and the brain reads ~900 tokens a second.
const MAX_PROFILE: usize = 500;

fn stored() -> Option<Stored> {
    let path = FILE.lock().unwrap().clone()?;
    serde_json::from_str::<Stored>(&std::fs::read_to_string(path).ok()?).ok()
}

fn profile() -> String {
    PROFILE.lock().unwrap().get_or_insert_with(|| stored().map(|s| s.profile).unwrap_or_default()).clone()
}

/// Settings → About you changed: the line the brain gets about you ("" to forget it).
#[tauri::command]
pub fn memory_profile(text: String) {
    let line: String = text.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(MAX_PROFILE).collect();
    if profile() == line {
        return;
    }
    *PROFILE.lock().unwrap() = Some(line);
    let facts = with_facts(|f| f.clone());
    save(&facts);
    crate::diag::log("memory: profile updated");
}

pub fn init(app: &AppHandle) {
    if let Ok(d) = app.path().app_data_dir() {
        *FILE.lock().unwrap() = Some(d.join("memory.json"));
    }
}

fn clip(s: &str) -> String {
    let s = s.trim().replace('\n', " ");
    if s.chars().count() <= MAX_TEXT {
        return s;
    }
    format!("{}…", s.chars().take(MAX_TEXT).collect::<String>())
}

/// One exchange: what you said and what Bond said or did about it.
pub fn turn(you: &str, bond: &str) {
    if you.trim().is_empty() {
        return;
    }
    {
        let mut t = TURNS.lock().unwrap();
        t.retain(|x| x.at.elapsed() < CONVERSATION);
        t.push_back(Turn { at: Instant::now(), you: clip(you), bond: clip(bond) });
        while t.len() > MAX_TURNS {
            t.pop_front();
        }
    }
    if KEEP.load(Ordering::Relaxed) {
        let (you, bond) = (clip_to(you, PAST_TEXT), clip_to(bond, PAST_TEXT));
        with_past(|past| {
            past.push(Past { at: now_ms(), you, bond });
            while past.len() > MAX_PAST {
                past.remove(0);
            }
            save_past(past);
        });
    }
}

// --- Earlier conversations ----------------------------------------------------------------
// The last few exchanges are kept on disk (a small, capped file) so a talk can go on after a restart or the
// next day: "now make it shorter" still knows what "it" is. Settings → Memory shows the size and can empty it.

/// Past exchanges kept, oldest dropped first; each side is cut short.
const MAX_PAST: usize = 40;
const PAST_TEXT: usize = 200;
/// How many of them the brain is shown, and how old they may be.
const PAST_SHOWN: usize = 4;
const PAST_AGE_MS: u64 = 3 * 24 * 60 * 60 * 1000;

#[derive(Serialize, Deserialize, Clone)]
struct Past {
    at: u64,
    you: String,
    bond: String,
}

static PAST: Mutex<Option<Vec<Past>>> = Mutex::new(None);
/// "Keep my chat history" in Settings: off, nothing new is written to disk.
static KEEP: AtomicBool = AtomicBool::new(true);

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn clip_to(s: &str, max: usize) -> String {
    let s = s.trim().replace('\n', " ");
    if s.chars().count() <= max {
        return s;
    }
    format!("{}…", s.chars().take(max).collect::<String>())
}

fn past_file() -> Option<PathBuf> {
    FILE.lock().unwrap().as_ref().and_then(|p| p.parent().map(|d| d.join("history.json")))
}

fn with_past<T>(f: impl FnOnce(&mut Vec<Past>) -> T) -> T {
    let mut guard = PAST.lock().unwrap();
    let past = guard.get_or_insert_with(|| past_file().and_then(|p| std::fs::read_to_string(p).ok()).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default());
    f(past)
}

fn save_past(past: &[Past]) {
    if let Some(p) = past_file() {
        if let Some(d) = p.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        let _ = std::fs::write(p, serde_json::to_string(past).unwrap_or_default());
    }
}

/// Older exchanges worth showing: not part of the live conversation, not stale, the latest few.
fn earlier_block() -> Option<String> {
    let now = now_ms();
    let live = CONVERSATION.as_millis() as u64;
    let lines: Vec<String> = with_past(|past| {
        let old: Vec<&Past> = past.iter().filter(|p| now.saturating_sub(p.at) > live && now.saturating_sub(p.at) < PAST_AGE_MS).collect();
        old.iter().rev().take(PAST_SHOWN).rev().map(|p| format!("User: {}\nBond: {}", p.you, if p.bond.is_empty() { "(did it)" } else { &p.bond })).collect()
    });
    (!lines.is_empty()).then(|| format!("Earlier conversations (older, may be out of date):\n{}", lines.join("\n")))
}

/// What Bond keeps, for Settings → Memory.
#[derive(Serialize)]
pub struct MemoryUsage {
    facts: usize,
    conversations: usize,
    bytes: u64,
}

#[tauri::command]
pub fn memory_usage() -> MemoryUsage {
    let size = |p: Option<PathBuf>| p.and_then(|p| std::fs::metadata(p).ok()).map(|m| m.len()).unwrap_or(0);
    // Take the path first: the lock guard would otherwise still be held when past_file() locks it again.
    let facts_file = FILE.lock().unwrap().clone();
    MemoryUsage {
        facts: with_facts(|f| f.len()),
        conversations: with_past(|p| p.len()),
        bytes: size(facts_file) + size(past_file()),
    }
}

/// Forget what was talked about (the live conversation and the saved history), but keep the facts about you.
#[tauri::command]
pub fn memory_forget_conversations() {
    TURNS.lock().unwrap().clear();
    JOBS.lock().unwrap().clear();
    with_past(|past| {
        past.clear();
        save_past(past);
    });
}

/// The "Keep my chat history" switch. Off: new exchanges are not written to disk (the live conversation still works).
#[tauri::command]
pub fn memory_keep(on: bool) {
    KEEP.store(on, Ordering::Relaxed);
}

/// The app and window in front of you; `process` is its program ("notepad").
pub fn set_activity(process: &str, name: &str, title: &str) {
    if !process.trim().is_empty() {
        *LAST_APP.lock().unwrap() = Some((process.trim().to_lowercase(), name.trim().to_string()));
    }
    let s = match (name.trim(), title.trim()) {
        ("", "") => return,
        (n, "") => n.to_string(),
        ("", t) => t.to_string(),
        (n, t) => format!("{n}: “{t}”"),
    };
    *NOW.lock().unwrap() = Some(s);
}

fn with_facts<T>(f: impl FnOnce(&mut Vec<String>) -> T) -> T {
    let mut guard = FACTS.lock().unwrap();
    let facts = guard.get_or_insert_with(|| stored().map(|s| s.facts).unwrap_or_default());
    f(facts)
}

fn save(facts: &[String]) {
    let profile = profile(); // before FILE is locked: reading it the first time locks FILE too
    if let Some(p) = FILE.lock().unwrap().clone() {
        if let Some(d) = p.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        let _ = std::fs::write(p, serde_json::to_string_pretty(&Stored { facts: facts.to_vec(), profile }).unwrap_or_default());
    }
}

/// The program in front of you: (process name, app name).
pub fn last_app() -> Option<(String, String)> {
    LAST_APP.lock().unwrap().clone()
}

/// Keep a lasting fact. One about the same thing ("The user's name is …") replaces the older.
pub fn learn(fact: &str) {
    let fact = clip(fact);
    if fact.len() < 4 {
        return;
    }
    let key = |s: &str| s.to_lowercase().split_whitespace().take(4).collect::<Vec<_>>().join(" ");
    with_facts(|facts| {
        facts.retain(|f| key(f) != key(&fact) && !f.eq_ignore_ascii_case(&fact));
        facts.push(fact.clone());
        while facts.len() > MAX_FACTS {
            facts.remove(0);
        }
        save(facts);
    });
    crate::diag::log(&format!("memory: learned “{fact}”"));
}

/// Whether a message tells something about the person saying it ("call me Alex", "I
/// study at BCU", "my sister is Asha"), rather than asking or talking about something else.
pub fn about_yourself(text: &str) -> bool {
    let t = text.trim().to_lowercase();
    const ASKING: &[&str] = &["what", "who", "where", "when", "why", "how", "which", "do", "does", "did", "is", "are", "can", "could", "will", "would", "should", "tell", "say"];
    let words: Vec<String> = t.split(|c: char| !c.is_alphanumeric() && c != '\'').filter(|w| !w.is_empty()).map(String::from).collect();
    if t.ends_with('?') || words.first().is_some_and(|w| ASKING.contains(&w.as_str())) {
        return false;
    }
    words.iter().any(|w| matches!(w.as_str(), "my" | "i'm" | "im" | "i" | "me" | "mine" | "i've" | "i'd"))
}

/// Everything the brain should know before reading your new message.
pub fn context_block() -> String {
    let mut out = Vec::new();
    let about = profile();
    if !about.is_empty() {
        out.push(format!("About the user, in their own words (use it to fit your answers to them): {about}"));
    }
    let facts = with_facts(|f| f.clone());
    if !facts.is_empty() {
        out.push(format!("What you know about the user:\n{}", facts.iter().map(|f| format!("- {f}")).collect::<Vec<_>>().join("\n")));
    }
    if let Some(now) = NOW.lock().unwrap().clone() {
        out.push(format!("In front of the user right now: {now}"));
    }
    let open = crate::system::open_windows_summary();
    if !open.is_empty() {
        out.push(format!("Open windows now (front first): {open}"));
    }
    if let Some(jobs) = jobs_block() {
        out.push(jobs);
    }
    if let Some(earlier) = earlier_block() {
        out.push(earlier);
    }
    let turns = TURNS.lock().unwrap();
    let recent: Vec<String> = turns
        .iter()
        .filter(|t| t.at.elapsed() < CONVERSATION)
        .map(|t| format!("User: {}\nBond: {}", t.you, if t.bond.is_empty() { "(did it)" } else { &t.bond }))
        .collect();
    if !recent.is_empty() {
        out.push(format!("The conversation so far (oldest first):\n{}", recent.join("\n")));
    }
    out.join("\n\n")
}

/// What Bond remembers about you, for Settings.
#[tauri::command]
pub fn memory_list() -> Vec<String> {
    with_facts(|f| f.clone())
}

/// Forget one fact (by its text), or everything (None).
#[tauri::command]
pub fn memory_forget(fact: Option<String>) {
    let fact_is_all = fact.is_none();
    with_facts(|facts| {
        match fact {
            Some(x) => facts.retain(|f| *f != x),
            None => facts.clear(),
        }
        save(facts);
    });
    // Forgetting everything includes what was talked about, not only the facts.
    if fact_is_all {
        memory_forget_conversations();
    }
    TURNS.lock().unwrap().clear();
}

/// These tests share the memory's global state, so they take turns.
#[cfg(test)]
static SERIAL: Mutex<()> = Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_what_you_say_about_yourself_is_kept() {
        for yes in ["Call me Alex.", "My name is Alex", "I study at BCU", "I'm a student", "my sister is Asha"] {
            assert!(about_yourself(yes), "{yes}");
        }
        for no in ["Thanks.", "What am I working on?", "Say my name again.", "Tell me who am I", "Open Notepad", "What else do you know about it?"] {
            assert!(!about_yourself(no), "{no}");
        }
    }

    #[test]
    fn a_new_fact_about_the_same_thing_replaces_the_old_one() {
        let _turn = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        TURNS.lock().unwrap().clear();
        with_past(|p| p.clear());
        *FACTS.lock().unwrap() = Some(Vec::new());
        learn("The user's name is Sam.");
        learn("The user's name is Alex.");
        learn("The user likes lofi music.");
        assert_eq!(memory_list(), vec!["The user's name is Alex.", "The user likes lofi music."]);
        turn("Open Notepad", "Opened Notepad.");
        turn("Close it", "");
        *PROFILE.lock().unwrap() = Some(String::new());
        memory_profile("Call them Alex.   Aiming to become: AI Engineer.".into());
        let c = context_block();
        assert!(c.starts_with("About the user, in their own words (use it to fit your answers to them): Call them Alex. Aiming to become: AI Engineer."));
        memory_profile(String::new());
        assert!(!context_block().contains("About the user"));
        let c = context_block();
        assert!(c.contains("- The user's name is Alex."));
        assert!(c.contains("User: Open Notepad\nBond: Opened Notepad.\nUser: Close it\nBond: (did it)"));
    }
}

#[cfg(test)]
mod history_tests {
    use super::*;

    #[test]
    fn older_talk_comes_back_capped_and_can_be_emptied() {
        let _turn = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        *FACTS.lock().unwrap() = Some(Vec::new());
        TURNS.lock().unwrap().clear();
        let day = 24 * 60 * 60 * 1000;
        with_past(|p| {
            p.clear();
            p.push(Past { at: now_ms() - 10 * day, you: "ancient".into(), bond: "too old".into() });
            for i in 0..6 {
                p.push(Past { at: now_ms() - day + i, you: format!("question {i}"), bond: format!("answer {i}") });
            }
            p.push(Past { at: now_ms(), you: "just now".into(), bond: "live".into() });
        });
        let c = context_block();
        assert!(c.contains("Earlier conversations"));
        assert!(c.contains("question 5") && c.contains("question 2"), "{c}");
        assert!(!c.contains("question 1\n"), "only the latest four: {c}");
        assert!(!c.contains("ancient"), "three days is the limit: {c}");
        assert!(!c.contains("just now"), "the live conversation is shown on its own: {c}");
        assert_eq!(memory_usage().conversations, 8);
        memory_forget(None);
        assert_eq!(memory_usage().conversations, 0);
        assert!(!context_block().contains("Earlier conversations"));
    }

    #[test]
    fn the_history_is_capped() {
        let _turn = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        with_past(|p| p.clear());
        for i in 0..(MAX_PAST + 15) {
            turn(&format!("say {i}"), "ok");
        }
        assert_eq!(memory_usage().conversations, MAX_PAST);
        memory_forget_conversations();
    }
}

#[cfg(test)]
pub fn tests_facts() -> std::sync::MutexGuard<'static, Option<Vec<String>>> {
    FACTS.lock().unwrap()
}

#[cfg(test)]
pub fn set_activity_for_tests(now: Option<&str>) {
    *NOW.lock().unwrap() = now.map(String::from);
}
