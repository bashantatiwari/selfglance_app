// What Bond keeps in mind between requests, so a conversation can go on:
//
//   Conversation  the last few exchanges (what you said, what he said or did, what he saw on
//                 screen), for 10 minutes. "Close it" after "open Notepad" means Notepad;
//                 "yes, run it" means the command he just proposed.
//   About you     lasting facts you tell him ("call me Alex"), kept in memory.json in the
//                 app data folder and given to the brain with every request. Settings lists
//                 them; any can be forgotten.
//   Right now     the app and window in front of you.
//
// Without this every request reached the brain alone: "Say my name again" got "Your name
// is Sam" a minute after "Call me Alex".

use std::collections::VecDeque;
use std::path::PathBuf;
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
static NOW: Mutex<Option<String>> = Mutex::new(None);
static FILE: Mutex<Option<PathBuf>> = Mutex::new(None);
static FACTS: Mutex<Option<Vec<String>>> = Mutex::new(None);

#[derive(Serialize, Deserialize, Default)]
struct Stored {
    facts: Vec<String>,
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
    let mut t = TURNS.lock().unwrap();
    t.retain(|x| x.at.elapsed() < CONVERSATION);
    t.push_back(Turn { at: Instant::now(), you: clip(you), bond: clip(bond) });
    while t.len() > MAX_TURNS {
        t.pop_front();
    }
}

/// The app and window in front of you.
pub fn set_activity(name: &str, title: &str) {
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
    let facts = guard.get_or_insert_with(|| {
        FILE.lock()
            .unwrap()
            .as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str::<Stored>(&s).ok())
            .map(|s| s.facts)
            .unwrap_or_default()
    });
    f(facts)
}

fn save(facts: &[String]) {
    if let Some(p) = FILE.lock().unwrap().clone() {
        if let Some(d) = p.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        let _ = std::fs::write(p, serde_json::to_string_pretty(&Stored { facts: facts.to_vec() }).unwrap_or_default());
    }
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
    let facts = with_facts(|f| f.clone());
    if !facts.is_empty() {
        out.push(format!("What you know about the user:\n{}", facts.iter().map(|f| format!("- {f}")).collect::<Vec<_>>().join("\n")));
    }
    if let Some(now) = NOW.lock().unwrap().clone() {
        out.push(format!("In front of the user right now: {now}"));
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
    with_facts(|facts| {
        match fact {
            Some(x) => facts.retain(|f| *f != x),
            None => facts.clear(),
        }
        save(facts);
    });
    TURNS.lock().unwrap().clear();
}

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
        *FACTS.lock().unwrap() = Some(Vec::new());
        learn("The user's name is Sam.");
        learn("The user's name is Alex.");
        learn("The user likes lofi music.");
        assert_eq!(memory_list(), vec!["The user's name is Alex.", "The user likes lofi music."]);
        turn("Open Notepad", "Opened Notepad.");
        turn("Close it", "");
        let c = context_block();
        assert!(c.contains("- The user's name is Alex."));
        assert!(c.contains("User: Open Notepad\nBond: Opened Notepad.\nUser: Close it\nBond: (did it)"));
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
