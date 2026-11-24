// What Bond's brain (brain.rs, on this laptop) is asked. Nothing leaves the laptop.
//
// The frontend's own rules (assistant/intent.ts) handle clear requests instantly. Only what they
// can't place comes here:
//   ai_route  is it an idea, a small job from the fixed menu (agent.rs), or talk?
//   ai_chat   talk, streamed piece by piece so Bond starts speaking about a second in.

use serde::Serialize;
use serde_json::{json, Value};
use tauri::AppHandle;

const ACTIONS_DOC: &str = r#"Actions (JSON objects, run in order, at most 4). These are ALL the actions there are:
{"do":"open_app","name":"Spotify"}                start an installed app by its name (brings it forward if already open)
{"do":"focus_app","name":"OBS Studio"}            switch to a program that is already open
{"do":"minimize_app","name":"terminal"}           put a program's window away ("it" = the app in front)
{"do":"close_app","name":"notepad"}               close a program as its × does ("it" = the app in front)
{"do":"open_url","url":"https://...","browser":"brave"}   open a web page; browser only when the user names one
{"do":"web_search","query":"...","browser":"brave"}        Google search; browser only when the user names one
{"do":"open_folder","name":"downloads"}           downloads, documents, desktop, pictures, screenshots, music, videos, home, "d drive"
{"do":"tab","key":"close"}                        browser tab: new, close, next, previous, reopen
{"do":"media","key":"play_pause"}                 play_pause, next, previous, volume_up, volume_down, mute
{"do":"set_volume","percent":30}                  exact volume 0-100
{"do":"show_desktop"}                             minimize everything
{"do":"system_status"}                            battery, memory, CPU, disk space
{"do":"system_specs"}                             what the laptop is made of (processor, RAM, graphics card, storage)
{"do":"find_files","query":"resume pdf"}          find files or folders by name ("is there a file called ...", "where is my ...")
{"do":"open_project","name":"SelfGlance","tool":"claude"}  open one of the user's project folders; tool: claude (Claude Code), code (VS Code), terminal, folder
To play something on YouTube use open_url with https://www.youtube.com/results?search_query=...
A search on one particular site is open_url with that site's own search address. Looking something up online is web_search."#;

const ROUTER_SYSTEM: &str = r#"You are the command router of Bond, a friendly companion on the user's Windows laptop (the SelfGlance app).
Classify the user's message and reply with ONLY one JSON object:
{"intent":"...","actions":[]}

intent is one of:
- "idea": the user wants to save an idea ("I got an idea, ...", "note this idea ..."). actions empty.
- "task": the user wants one of the actions below done. List them in actions.
- "chat": anything else: a question, how to do something, small talk, or a job none of the actions can do. actions empty. Bond answers it right after.

Never invent actions that are not in the list. Use "it", "that" and short follow-ups from the conversation ("close it" right after opening Notepad means Notepad).
A spoken message may contain misheard words: read it by how it sounds ("open not bad" is "open Notepad").

ACTIONS_DOC

Examples:
User: what's a good name for a coffee shop
You: {"intent":"chat","actions":[]}
User: how do I make a python virtual environment
You: {"intent":"chat","actions":[]}
User: i got an idea, a sleep mask that plays rain sounds
You: {"intent":"idea","actions":[]}
User: close this tab
You: {"intent":"task","actions":[{"do":"tab","key":"close"}]}
User: louder
You: {"intent":"task","actions":[{"do":"media","key":"volume_up"}]}
User: is there a file called internship offer on my laptop
You: {"intent":"task","actions":[{"do":"find_files","query":"internship offer"}]}
User: open claude code in the portfolio project
You: {"intent":"task","actions":[{"do":"open_project","name":"portfolio","tool":"claude"}]}
User: open bullet news in vs code
You: {"intent":"task","actions":[{"do":"open_project","name":"bullet news","tool":"code"}]}
User: find me the best pizza dough recipes online
You: {"intent":"task","actions":[{"do":"web_search","query":"best pizza dough recipes"}]}
User: delete my old screenshots
You: {"intent":"chat","actions":[]}

CONTEXT"#;

/// Fields of each action, for the JSON schema the brain must follow. A leading "?" marks an optional field.
const ACTION_FIELDS: &[(&str, &[(&str, &str)])] = &[
    ("open_app", &[("name", "string")]),
    ("focus_app", &[("name", "string")]),
    ("minimize_app", &[("name", "string")]),
    ("close_app", &[("name", "string")]),
    ("open_url", &[("url", "string"), ("browser", "?browser")]),
    ("web_search", &[("query", "string"), ("browser", "?browser")]),
    ("open_folder", &[("name", "string")]),
    ("tab", &[("key", "tab_key")]),
    ("media", &[("key", "media_key")]),
    ("set_volume", &[("percent", "number")]),
    ("show_desktop", &[]),
    ("system_status", &[]),
    ("system_specs", &[]),
    ("find_files", &[("query", "string")]),
    ("open_project", &[("name", "string"), ("tool", "tool")]),
];

/// One action as a schema: {"do": <its name>, ...its fields}, nothing else. Strings are capped so a
/// small model can never run on and on.
fn action_schema(name: &str, fields: &[(&str, &str)]) -> Value {
    let mut props = serde_json::Map::new();
    props.insert("do".into(), json!({"const": name}));
    let mut required = vec![json!("do")];
    for (field, ty) in fields {
        let (optional, ty) = match ty.strip_prefix('?') {
            Some(t) => (true, t),
            None => (false, *ty),
        };
        let schema = match ty {
            "string" => json!({"type": "string", "maxLength": if *field == "url" { 600 } else { 200 }}),
            "media_key" => json!({"enum": ["play_pause", "next", "previous", "volume_up", "volume_down", "mute"]}),
            "tab_key" => json!({"enum": ["new", "close", "next", "previous", "reopen"]}),
            "tool" => json!({"enum": ["claude", "code", "terminal", "folder"]}),
            "browser" => json!({"enum": ["brave", "chrome", "edge", "firefox", "opera", "vivaldi"]}),
            t => json!({"type": t}),
        };
        props.insert((*field).into(), schema);
        if !optional {
            required.push(json!(field));
        }
    }
    json!({"type": "object", "properties": props, "required": required, "additionalProperties": false})
}

fn router_schema() -> Value {
    let all: Vec<Value> = ACTION_FIELDS.iter().map(|(n, f)| action_schema(n, f)).collect();
    json!({
        "type": "object",
        "properties": {
            "intent": {"enum": ["idea", "task", "chat"]},
            "actions": {"type": "array", "maxItems": 4, "items": {"anyOf": all}},
        },
        "required": ["intent", "actions"],
        "additionalProperties": false,
    })
}

fn router_system() -> String {
    let now = format!("Now: {} (the user's local time).", chrono::Local::now().format("%A %Y-%m-%d %H:%M"));
    ROUTER_SYSTEM.replace("ACTIONS_DOC", ACTIONS_DOC).replace("CONTEXT", &now)
}

/// The JSON object in a model reply, even if it came wrapped in prose or ``` fences.
fn json_in(reply: &str) -> Result<Value, String> {
    const UNREADABLE: &str = "I couldn't work that out. Try saying it another way.";
    let (Some(a), Some(b)) = (reply.find('{'), reply.rfind('}')) else {
        return Err(UNREADABLE.into());
    };
    serde_json::from_str(&reply[a..=b]).map_err(|_| UNREADABLE.to_string())
}

/// Actions from a model reply. Anything not on the menu is refused, never guessed.
fn actions_in(v: &Value) -> Result<Vec<crate::agent::Action>, String> {
    let Some(list) = v["actions"].as_array() else { return Ok(Vec::new()) };
    list.iter()
        .map(|a| serde_json::from_value(a.clone()).map_err(|_| format!("I can't do “{}”.", a["do"].as_str().unwrap_or("that"))))
        .collect()
}

#[derive(Serialize)]
pub struct Route {
    intent: String,
    outcome: Option<crate::agent::Outcome>,
}

/// Get the brain ready for a request that's coming (the Ask box opening, Ctrl+Alt pressed).
#[tauri::command]
pub async fn ai_prime() -> Result<(), String> {
    crate::brain::prime(&router_system()).await
}

/// Classify a request the rules couldn't place; run a task from the menu straight away.
#[tauri::command]
pub async fn ai_route(app: AppHandle, text: String, spoken: Option<bool>) -> Result<Route, String> {
    let text = text.trim();
    let prompt = with_context(text, spoken.unwrap_or(false));
    // The intent comes first. Once it says "chat" the rest isn't needed: ai_chat answers talk.
    let mut seen = String::new();
    let mut talk = false;
    let reply = crate::brain::chat_stream(&router_system(), &prompt, Some(&router_schema()), 512, |delta| {
        seen.push_str(delta);
        talk = says_chat(&seen);
        !talk
    })
    .await?;
    if talk {
        return Ok(Route { intent: "chat".into(), outcome: None });
    }
    let v = json_in(&reply)?;
    let actions = actions_in(&v)?;
    if actions.is_empty() {
        let intent = if v["intent"] == "idea" { "idea" } else { "chat" };
        return Ok(Route { intent: intent.into(), outcome: None });
    }
    let result = crate::agent::run(&app, actions).await;
    let did = match &result {
        Ok(o) => format!("[done: {}] {}", o.done.join("; "), o.info.first().map(|i| i.chars().take(200).collect::<String>()).unwrap_or_default()),
        Err(e) => format!("[failed: {e}]"),
    };
    crate::memory::turn(text, &did);
    Ok(Route { intent: "task".into(), outcome: Some(result?) })
}

/// Does the start of the router's reply already say the request is talk?
fn says_chat(start: &str) -> bool {
    let s: String = start.chars().filter(|c| !c.is_whitespace()).take(40).collect();
    s.starts_with(r#"{"intent":"chat""#)
}

/// Your message with what Bond knows around it (memory.rs).
fn with_context(text: &str, spoken: bool) -> String {
    let context = crate::memory::context_block();
    let said = if spoken { "The user's new message (spoken, so words may be misheard)" } else { "The user's new message" };
    if context.is_empty() {
        return format!("{said}: {text}");
    }
    format!("{context}\n\n{said}: {text}")
}

// --- Talking ------------------------------------------------------------------------------

const CHAT_SYSTEM: &str = r#"You are Bond, the companion in SelfGlance on the user's Windows laptop. You help them do what they meant to do today. Right now you are simply talking with them.
- Answer what they actually said, directly and warmly, like a sharp friend. Plain text only: no markdown, no lists, no emojis.
- LENGTH
- Answer general questions yourself from what you know. Things that change by the day (news, weather, prices) you can't look up: you have no internet.
- You are only talking. Never say you opened, saved, changed or scheduled anything. If they want a job done, tell them how to ask ("say: open Notepad", "say: idea: ...", "say: open claude code in my project").
- You can't delete files, run commands, type, click or see the screen. If asked, say so in one sentence and tell them the steps to do it themselves.
- How to do something on the computer: at most five short steps.
- Use what you know about them and today's list. Never make up facts."#;

fn chat_prompt(text: &str, spoken: bool) -> (String, String) {
    let length = if spoken { "They are speaking and you answer out loud: one or two short sentences." } else { "Keep it short: at most five sentences, fewer when one will do." };
    let system = CHAT_SYSTEM.replace("LENGTH", length);
    let known = crate::memory::chat_context();
    let now = chrono::Local::now().format("%A %Y-%m-%d %H:%M");
    let said = if spoken { "The user says (spoken, so words may be misheard)" } else { "The user says" };
    let prompt = if known.is_empty() { format!("Now: {now}.\n\n{said}: {text}") } else { format!("Now: {now}.\n{known}\n\n{said}: {text}") };
    (system, prompt)
}

/// Cuts an answer that arrives bit by bit into pieces to say: the first few words as soon as there is a
/// natural break (so he starts talking at once), then whole sentences.
#[derive(Default)]
pub(crate) struct Pieces {
    buf: String,
    sent: usize,
}

const PIECE_CHARS: usize = 120;

impl Pieces {
    pub(crate) fn push(&mut self, delta: &str) -> Option<String> {
        self.buf.push_str(delta);
        let first = self.sent == 0;
        let ends = |c: char| if first { matches!(c, '.' | '!' | '?' | '…' | ',' | ';' | ':') } else { matches!(c, '.' | '!' | '?' | '…') };
        let want = if first { 18 } else { PIECE_CHARS };
        let chars: Vec<(usize, char)> = self.buf.char_indices().collect();
        let cuts: Vec<usize> = chars.windows(2).filter(|w| ends(w[0].1) && w[1].1.is_whitespace()).map(|w| w[1].0).collect();
        // The first piece: the earliest break that makes it long enough. Later: the last sentence end.
        let cut = if first { cuts.into_iter().find(|&c| self.buf[..c].trim().chars().count() >= want)? } else { cuts.last().copied()? };
        if self.buf[..cut].trim().chars().count() < want {
            return None;
        }
        let piece = self.buf[..cut].trim().to_string();
        self.buf = self.buf[cut..].to_string();
        self.sent += 1;
        Some(piece)
    }

    pub(crate) fn rest(&mut self) -> Option<String> {
        let piece = std::mem::take(&mut self.buf).trim().to_string();
        (!piece.is_empty()).then_some(piece)
    }
}

#[derive(Serialize, Clone)]
struct ChatPiece {
    id: u64,
    text: String,
}

/// Answer plain talk, piece by piece (`chat-piece` events) while it is written; whole at the end.
#[tauri::command]
pub async fn ai_chat(app: AppHandle, text: String, spoken: Option<bool>, id: u64) -> Result<String, String> {
    use tauri::Emitter;
    let text = text.trim().to_string();
    let spoken = spoken.unwrap_or(false);
    let (system, prompt) = chat_prompt(&text, spoken);
    let started = std::time::Instant::now();
    let mut first: Option<f64> = None;
    let mut pieces = Pieces::default();
    let answer = crate::brain::chat_stream(&system, &prompt, None, if spoken { 160 } else { 400 }, |delta| {
        if let Some(piece) = pieces.push(delta) {
            first.get_or_insert_with(|| started.elapsed().as_secs_f64());
            let _ = app.emit("chat-piece", ChatPiece { id, text: piece });
        }
        true
    })
    .await?;
    if let Some(piece) = pieces.rest() {
        let _ = app.emit("chat-piece", ChatPiece { id, text: piece });
    }
    crate::diag::log(&format!("chat: {} characters in {:.1}s, first piece after {:.1}s", answer.chars().count(), started.elapsed().as_secs_f64(), first.unwrap_or_else(|| started.elapsed().as_secs_f64())));
    if answer.is_empty() {
        return Err("I didn't come up with an answer. Ask me again?".into());
    }
    crate::memory::turn(&text, &answer);
    Ok(answer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_piece_comes_at_the_first_natural_break() {
        let mut p = Pieces::default();
        assert_eq!(p.push("Sure, a virtual environment keeps"), None);
        let first = p.push(" packages apart, so projects don't clash. Then");
        assert_eq!(first.as_deref(), Some("Sure, a virtual environment keeps packages apart,"));
        assert_eq!(p.rest().as_deref(), Some("so projects don't clash. Then"));
    }

    #[test]
    fn the_schema_only_allows_the_menu() {
        let s = router_schema().to_string();
        for gone in ["run_command", "delete", "kill_process", "type_text", "click", "clipboard", "wallpaper", "lock_screen"] {
            assert!(!s.contains(gone), "{gone} is still in the schema");
        }
        assert!(s.contains("open_project") && s.contains("find_files"));
    }

    #[test]
    fn spots_talk_early() {
        assert!(says_chat(r#"{ "intent": "chat", "#));
        assert!(!says_chat(r#"{"intent":"task","#));
    }
}
