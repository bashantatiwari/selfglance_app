// Bond doing things on the computer. Every action is one of a known set and checked
// before it runs. Powerful ones never run on Bond's (or the AI's) word alone: they stop
// and wait for your approval in his card, and the rest of the plan waits with them.
//
//   open_app        start an installed app by name (Windows: the Start menu's app list)
//   open_url        a web page in the default browser (http/https only)
//   web_search      a Google search
//   open_folder     Downloads / Documents / Desktop / Pictures / Music / Videos / Home
//   media           play/pause, next, previous, volume up/down, mute
//   set_volume      an exact volume, 0-100%
//   show_desktop    minimise everything
//   lock_screen     lock the computer
//   set_wallpaper   a solid-colour desktop background ("black", "#1e1e2e")
//   system_status   battery, memory, CPU, disks
//   top_processes   what is using the CPU and memory
//   clipboard_get / clipboard_set
//   remind / list_reminders                   (reminders.rs)
//   find_files      search for files by name (read-only)
//   click           a point on the screenshot Bond just looked at
//   type_text       type text into whatever has focus
//   hotkey          a key combination such as "ctrl+t"
//   wait            pause between steps
//
// Need your approval first (agent_approve / agent_deny):
//   run_command     any command in PowerShell (Windows) or sh: you see the exact command
//   kill_process    end a program: you see what it is and how many processes
//   delete          files/folders: you see every path and its size, and confirm TWICE.
//                   They go to the Recycle Bin unless "permanent" was asked for.
//                   A command that deletes things (rm, del, Remove-Item…) also needs two yeses.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use enigo::{Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const MAX_ACTIONS: usize = 8;
const MAX_TYPE_CHARS: usize = 2000;
const MAX_INFO_CHARS: usize = 4000;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);
const APPROVAL_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Deserialize, Debug, Clone)]
#[serde(tag = "do", rename_all = "snake_case")]
pub enum Action {
    OpenApp { name: String },
    OpenUrl { url: String },
    WebSearch { query: String },
    OpenFolder { name: String },
    Media { key: String },
    SetVolume { percent: f64 },
    ShowDesktop,
    LockScreen,
    SetWallpaper { color: String },
    SystemStatus,
    TopProcesses,
    ClipboardGet,
    ClipboardSet { text: String },
    Remind {
        text: String,
        #[serde(default)]
        in_minutes: Option<f64>,
        #[serde(default)]
        at: Option<String>,
    },
    ListReminders,
    FindFiles {
        query: String,
        #[serde(default)]
        folder: Option<String>,
    },
    Click { x: f64, y: f64, #[serde(default)] double: bool },
    /// A control from the last look at the screen (UI Automation), by its number.
    ClickElement { id: usize, #[serde(default)] double: bool },
    /// Visible text from the last look (OCR); `nth` picks among repeats, top to bottom.
    ClickText {
        text: String,
        #[serde(default)]
        nth: Option<usize>,
        #[serde(default)]
        double: bool,
    },
    TypeText { text: String },
    Hotkey { keys: String },
    Wait { ms: u64 },
    RunCommand {
        command: String,
        #[serde(default)]
        why: String,
    },
    KillProcess { name: String },
    Delete {
        paths: Vec<String>,
        #[serde(default)]
        permanent: bool,
    },
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

/// What came of a plan: short lines for what was done, longer text to read (status,
/// command output), and possibly a step waiting for the user's approval.
#[derive(Serialize, Default)]
pub struct Outcome {
    pub done: Vec<String>,
    pub info: Vec<String>,
    pub pending: Option<Approval>,
}

/// The approval card: exactly what will happen, shown before anything does.
#[derive(Serialize, Clone)]
pub struct Approval {
    pub id: String,
    /// "command" | "delete" | "kill"
    pub kind: &'static str,
    /// Which yes this is (1, then 2 for deletions).
    pub step: u8,
    pub steps: u8,
    pub title: String,
    /// The command, the paths with their sizes, or the program.
    pub items: Vec<String>,
    /// Why Bond wants to do it, or what to know before saying yes.
    pub why: String,
    pub button: String,
}

/// What an approval unlocks: already resolved, so the yes applies to exactly what was shown.
enum Approved {
    Command { command: String, home: PathBuf },
    Delete { paths: Vec<PathBuf>, permanent: bool },
    Kill { pids: Vec<u32>, name: String },
}

struct Pending {
    approval: Approval,
    task: Approved,
    rest: Vec<Action>,
    shot: Option<ShotGeometry>,
    created: Instant,
}

static PENDING: Mutex<Vec<Pending>> = Mutex::new(Vec::new());

fn new_id() -> String {
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{t:x}-{n}")
}

fn park(p: Pending) {
    let mut list = PENDING.lock().unwrap();
    list.retain(|q| q.created.elapsed() < APPROVAL_TTL);
    list.push(p);
}

fn unpark(id: &str) -> Option<Pending> {
    let mut list = PENDING.lock().unwrap();
    list.retain(|q| q.created.elapsed() < APPROVAL_TTL);
    let i = list.iter().position(|q| q.approval.id == id)?;
    Some(list.remove(i))
}

/// Run actions from the frontend's own classifier (no screenshot, so no clicks).
#[tauri::command]
pub async fn agent_run(app: AppHandle, actions: Vec<Action>) -> Result<Outcome, String> {
    run(&app, actions, None).await
}

/// The user said yes. Deletions need a second yes (a new id each time); after the last one
/// the action runs and the rest of the plan continues.
#[tauri::command]
pub async fn agent_approve(app: AppHandle, id: String) -> Result<Outcome, String> {
    let mut p = unpark(&id).ok_or("That request has expired. Ask me again.")?;
    if p.approval.step < p.approval.steps {
        p.approval.step += 1;
        p.approval.id = new_id();
        p.created = Instant::now();
        let out = Outcome { pending: Some(p.approval.clone()), ..Default::default() };
        park(p);
        return Ok(out);
    }
    let task = p.task;
    let effect = tauri::async_runtime::spawn_blocking(move || execute(task)).await.map_err(|e| e.to_string())??;
    let mut out = Outcome::default();
    effect.add_to(&mut out);
    proceed(&app, out, p.rest, p.shot).await
}

/// The user said no (or closed the card): drop the request and the rest of its plan.
#[tauri::command]
pub fn agent_deny(id: String) {
    unpark(&id);
}

/// Run actions one after another. Stops at the first failure, so later steps never act on
/// the wrong window, and at the first one that needs approval.
pub async fn run(app: &AppHandle, actions: Vec<Action>, shot: Option<ShotGeometry>) -> Result<Outcome, String> {
    proceed(app, Outcome::default(), actions.into_iter().take(MAX_ACTIONS).collect(), shot).await
}

async fn proceed(app: &AppHandle, mut out: Outcome, actions: Vec<Action>, shot: Option<ShotGeometry>) -> Result<Outcome, String> {
    let mut queue: VecDeque<Action> = actions.into();
    while let Some(action) = queue.pop_front() {
        let a = app.clone();
        let step = tauri::async_runtime::spawn_blocking(move || match gate(&a, &action) {
            Ok(Some(g)) => Ok(Err(g)),
            Ok(None) => perform(&a, action, shot).map(Ok),
            Err(e) => Err(e),
        })
        .await
        .map_err(|e| e.to_string())?;
        match step {
            Ok(Ok(effect)) => {
                let settle = effect.settle;
                effect.add_to(&mut out);
                tokio_sleep(settle).await;
            }
            Ok(Err(g)) => {
                let approval = Approval { id: new_id(), kind: g.kind, step: 1, steps: g.steps, title: g.title, items: g.items, why: g.why, button: g.button };
                out.pending = Some(approval.clone());
                park(Pending { approval, task: g.task, rest: queue.into(), shot, created: Instant::now() });
                return Ok(out);
            }
            Err(err) if out.done.is_empty() && out.info.is_empty() => return Err(err),
            Err(err) => {
                out.done.push(format!("Stopped: {err}"));
                break;
            }
        }
    }
    Ok(out)
}

async fn tokio_sleep(ms: u64) {
    if ms > 0 {
        let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(Duration::from_millis(ms))).await;
    }
}

/// What one action did: a short line, maybe text to read, and how long to let it settle.
struct Effect {
    line: String,
    info: Option<String>,
    settle: u64,
}

impl Effect {
    fn line(line: impl Into<String>, settle: u64) -> Self {
        Effect { line: line.into(), info: None, settle }
    }
    fn info(text: String) -> Self {
        Effect { line: String::new(), info: Some(clip(&text)), settle: 0 }
    }
    fn add_to(self, out: &mut Outcome) {
        if !self.line.is_empty() {
            out.done.push(self.line);
        }
        if let Some(i) = self.info.filter(|i| !i.trim().is_empty()) {
            out.info.push(i);
        }
    }
}

/// Long text keeps its end (where a command's result and errors usually are).
fn clip(text: &str) -> String {
    let n = text.chars().count();
    if n <= MAX_INFO_CHARS {
        return text.to_string();
    }
    let tail: String = text.chars().skip(n - MAX_INFO_CHARS).collect();
    format!("…(earlier output cut)\n{tail}")
}

// --- Approval gate ---------------------------------------------------------------------

struct Gate {
    kind: &'static str,
    steps: u8,
    title: String,
    items: Vec<String>,
    why: String,
    button: String,
    task: Approved,
}

/// Actions that must wait for a yes, resolved to exactly what will happen.
fn gate(app: &AppHandle, action: &Action) -> Result<Option<Gate>, String> {
    Ok(Some(match action {
        Action::RunCommand { command, why } => {
            let command = command.trim().to_string();
            if command.is_empty() {
                return Err("There's no command to run.".into());
            }
            let destructive = deletes_things(&command);
            Gate {
                kind: "command",
                steps: if destructive { 2 } else { 1 },
                title: if destructive { "Run this command? It deletes or erases things.".into() } else { "Run this command?".into() },
                items: vec![command.clone()],
                why: why.trim().to_string(),
                button: "Run it".into(),
                task: Approved::Command { command, home: app.path().home_dir().map_err(|e| e.to_string())? },
            }
        }
        Action::KillProcess { name } => {
            let found = crate::system::find_processes(name)?;
            Gate {
                kind: "kill",
                steps: 1,
                title: format!("End {}?", name.trim()),
                items: vec![found.summary],
                why: String::new(),
                button: "End it".into(),
                task: Approved::Kill { pids: found.pids, name: name.trim().to_string() },
            }
        }
        Action::Delete { paths, permanent } => {
            let resolved = resolve_paths(app, paths)?;
            let n = resolved.len();
            let what = if n == 1 { "this".to_string() } else { format!("these {n} items") };
            Gate {
                kind: "delete",
                steps: 2,
                title: if *permanent { format!("Permanently delete {what}?") } else { format!("Delete {what}?") },
                items: resolved.iter().map(|p| describe_path(p)).collect(),
                why: if *permanent { "This can't be undone.".into() } else { "They go to the Recycle Bin, so you can still restore them.".into() },
                button: "Yes, delete".into(),
                task: Approved::Delete { paths: resolved, permanent: *permanent },
            }
        }
        _ => return Ok(None),
    }))
}

/// rm, del, Remove-Item, rmdir, format… anywhere in the command.
fn deletes_things(command: &str) -> bool {
    const WORDS: &[&str] = &["rm", "del", "erase", "rd", "rmdir", "remove-item", "ri", "format", "format-volume", "clear-content", "clear-recyclebin", "clear-disk", "remove-itemproperty", "cipher", "diskpart", "shred", "unlink", "truncate"];
    command
        .to_lowercase()
        .split(|c: char| !(c.is_alphanumeric() || c == '-'))
        .any(|w| WORDS.contains(&w))
}

/// Run an approved action.
fn execute(task: Approved) -> Result<Effect, String> {
    match task {
        Approved::Command { command, home } => {
            let output = run_shell(&command, &home)?;
            Ok(Effect { line: "Ran the command".into(), info: Some(clip(&output)), settle: 0 })
        }
        Approved::Kill { pids, name } => {
            crate::system::kill(&pids)?;
            Ok(Effect::line(format!("Closed {name}"), 300))
        }
        Approved::Delete { paths, permanent } => {
            let n = paths.len();
            if permanent {
                for p in &paths {
                    let r = if p.is_dir() { std::fs::remove_dir_all(p) } else { std::fs::remove_file(p) };
                    r.map_err(|e| format!("Couldn't delete {}: {e}", p.display()))?;
                }
                Ok(Effect::line(format!("Deleted {n} item{} permanently", if n == 1 { "" } else { "s" }), 0))
            } else {
                trash::delete_all(&paths).map_err(|e| format!("Couldn't move to the Recycle Bin: {e}"))?;
                Ok(Effect::line(format!("Moved {n} item{} to the Recycle Bin", if n == 1 { "" } else { "s" }), 0))
            }
        }
    }
}

/// Run a command in PowerShell (Windows) or sh, without a console window, from the home
/// folder. Returns what it printed and how it ended. Stopped after two minutes.
fn run_shell(command: &str, home: &Path) -> Result<String, String> {
    use std::io::Read;
    use std::process::{Command, Stdio};

    #[cfg(target_os = "windows")]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new("powershell");
        c.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"])
            .arg(format!("[Console]::OutputEncoding = [Text.Encoding]::UTF8; {command}"))
            .creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        c
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = Command::new("sh");
        c.arg("-c").arg(command);
        c
    };
    let mut child = cmd
        .current_dir(home)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Couldn't start the command: {e}"))?;

    let pipe = |mut r: Box<dyn Read + Send>| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = r.read_to_end(&mut buf);
            String::from_utf8_lossy(&buf).to_string()
        })
    };
    let out = pipe(Box::new(child.stdout.take().unwrap()));
    let err = pipe(Box::new(child.stderr.take().unwrap()));

    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) if start.elapsed() > COMMAND_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(e.to_string()),
        }
    };
    let stdout = out.join().unwrap_or_default();
    let stderr = err.join().unwrap_or_default();

    let mut text = stdout.trim_end().to_string();
    if !stderr.trim().is_empty() {
        if !text.is_empty() {
            text.push_str("\n\n");
        }
        text.push_str(stderr.trim_end());
    }
    match status {
        None => text.push_str("\n\n(Still running after 2 minutes, so I stopped it.)"),
        Some(s) if !s.success() => text.push_str(&format!("\n\n(Exit code {})", s.code().unwrap_or(-1))),
        Some(_) if text.trim().is_empty() => text = "Done. (No output.)".into(),
        Some(_) => {}
    }
    Ok(text.trim_start().to_string())
}

// --- Paths -----------------------------------------------------------------------------

/// "~/Downloads/x.pdf", "Downloads\*.zip", "C:\Users\me\old" → existing absolute paths.
/// Wildcards (* ?) are allowed in the last part. Whole drives, the home folder, the main
/// user folders and system folders are refused.
fn resolve_paths(app: &AppHandle, raw: &[String]) -> Result<Vec<PathBuf>, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let mut out: Vec<PathBuf> = Vec::new();
    for s in raw {
        let s = s.trim().trim_matches('"');
        if s.is_empty() {
            continue;
        }
        let p = expand(app, &home, s);
        let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let matches = if name.contains(['*', '?']) {
            let dir = p.parent().ok_or("That path has no folder.")?;
            let mut hits: Vec<PathBuf> = std::fs::read_dir(dir)
                .map_err(|_| format!("There's no folder {}.", dir.display()))?
                .flatten()
                .filter(|e| wildcard(&name.to_lowercase(), &e.file_name().to_string_lossy().to_lowercase()))
                .map(|e| e.path())
                .collect();
            hits.sort();
            if hits.is_empty() {
                return Err(format!("Nothing matches {}.", p.display()));
            }
            hits
        } else if p.exists() {
            vec![p]
        } else {
            return Err(format!("There's no {}.", p.display()));
        };
        for m in matches {
            refuse_protected(app, &home, &m)?;
            if !out.contains(&m) {
                out.push(m);
            }
        }
    }
    if out.is_empty() {
        return Err("Which files should I delete?".into());
    }
    if out.len() > 200 {
        return Err(format!("That's {} items; I only delete up to 200 at a time.", out.len()));
    }
    Ok(out)
}

fn expand(app: &AppHandle, home: &Path, s: &str) -> PathBuf {
    let s = s.replace("%USERPROFILE%", &home.to_string_lossy()).replace("$HOME", &home.to_string_lossy());
    if let Some(rest) = s.strip_prefix("~") {
        return home.join(rest.trim_start_matches(['/', '\\']));
    }
    let p = PathBuf::from(&s);
    if p.is_absolute() {
        return p;
    }
    // "Downloads\report.pdf" → the real Downloads folder.
    let mut parts = s.splitn(2, ['/', '\\']);
    let first = parts.next().unwrap_or("");
    let rest = parts.next().unwrap_or("");
    match folder(app, first) {
        Ok((_, dir)) if !rest.is_empty() => dir.join(rest),
        _ => home.join(&s),
    }
}

fn refuse_protected(app: &AppHandle, home: &Path, p: &Path) -> Result<(), String> {
    let canon = |x: &Path| x.canonicalize().unwrap_or_else(|_| x.to_path_buf());
    let c = canon(p);
    let mut protected: Vec<PathBuf> = vec![home.to_path_buf()];
    let ap = app.path();
    protected.extend([ap.download_dir(), ap.document_dir(), ap.desktop_dir(), ap.picture_dir(), ap.audio_dir(), ap.video_dir()].into_iter().flatten());
    if c.parent().is_none() || protected.iter().any(|x| canon(x) == c) {
        return Err(format!("Bond won't delete {} itself — name the files inside it.", p.display()));
    }
    let lower = c.to_string_lossy().to_lowercase();
    let sys = ["\\windows", "\\program files", "\\programdata", "/system", "/usr", "/bin", "/etc", "/library"];
    if sys.iter().any(|s| lower.trim_start_matches("\\\\?\\").get(2..).is_some_and(|rest| rest.starts_with(s)) || lower.starts_with(s)) {
        return Err(format!("{} is a system folder; Bond won't delete anything there.", p.display()));
    }
    Ok(())
}

/// `*` any run of characters, `?` one character.
fn wildcard(pat: &str, name: &str) -> bool {
    let (p, n): (Vec<char>, Vec<char>) = (pat.chars().collect(), name.chars().collect());
    let (mut pi, mut ni, mut star, mut mark) = (0, 0, None, 0);
    while ni < n.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == n[ni]) {
            pi += 1;
            ni += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ni;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ni = mark;
        } else {
            return false;
        }
    }
    p[pi..].iter().all(|c| *c == '*')
}

const KB: f64 = 1024.0;

fn size_text(bytes: u64) -> String {
    let b = bytes as f64;
    if b >= KB * KB * KB {
        format!("{:.1} GB", b / (KB * KB * KB))
    } else if b >= KB * KB {
        format!("{:.1} MB", b / (KB * KB))
    } else if b >= KB {
        format!("{:.0} KB", b / KB)
    } else {
        format!("{bytes} bytes")
    }
}

fn modified_text(p: &Path) -> String {
    std::fs::metadata(p)
        .and_then(|m| m.modified())
        .map(|t| chrono::DateTime::<chrono::Local>::from(t).format("%-d %b %Y").to_string())
        .unwrap_or_default()
}

/// "C:\…\offer.pdf — 2.3 MB, 3 Oct 2026" or "C:\…\old — folder, 120 files, 1.4 GB".
fn describe_path(p: &Path) -> String {
    if p.is_dir() {
        let (mut files, mut bytes, mut seen) = (0u64, 0u64, 0u32);
        let mut stack = vec![p.to_path_buf()];
        while let Some(d) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&d) else { continue };
            for e in entries.flatten() {
                seen += 1;
                if seen > 50_000 {
                    return format!("{} — folder, more than {files} files, over {}", p.display(), size_text(bytes));
                }
                match e.file_type() {
                    Ok(t) if t.is_dir() => stack.push(e.path()),
                    Ok(_) => {
                        files += 1;
                        bytes += e.metadata().map(|m| m.len()).unwrap_or(0);
                    }
                    Err(_) => {}
                }
            }
        }
        format!("{} — folder, {files} files, {}", p.display(), size_text(bytes))
    } else {
        let len = std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
        format!("{} — {}, {}", p.display(), size_text(len), modified_text(p))
    }
}

/// Files whose names contain every word of `query` (or match a * ? pattern), newest first.
fn find_files(app: &AppHandle, query: &str, folder_name: Option<&str>) -> Result<String, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let root = match folder_name.map(str::trim).filter(|f| !f.is_empty()) {
        Some(f) => match folder(app, f) {
            Ok((_, d)) => d,
            Err(_) => expand(app, &home, f),
        },
        None => home.clone(),
    };
    if !root.is_dir() {
        return Err(format!("There's no folder {}.", root.display()));
    }
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Err("What should I look for?".into());
    }
    let words: Vec<&str> = q.split_whitespace().collect();
    let hit = |name: &str| if q.contains(['*', '?']) { wildcard(&q, name) } else { words.iter().all(|w| name.contains(w)) };
    const SKIP: &[&str] = &["node_modules", "appdata", "$recycle.bin", "target", "library", "windows"];

    let mut found: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    let mut stack = vec![root.clone()];
    let mut seen = 0u32;
    while let Some(d) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else { continue };
        for e in entries.flatten() {
            seen += 1;
            if seen > 300_000 {
                break;
            }
            let name = e.file_name().to_string_lossy().to_lowercase();
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if is_dir && (name.starts_with('.') || SKIP.contains(&name.as_str())) {
                continue;
            }
            if hit(&name) {
                let t = e.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
                found.push((t, e.path()));
            }
            if is_dir {
                stack.push(e.path());
            }
        }
    }
    if found.is_empty() {
        return Ok(format!("Nothing called “{query}” in {}.", root.display()));
    }
    found.sort_by(|a, b| b.0.cmp(&a.0));
    let total = found.len();
    let mut lines: Vec<String> = found.iter().take(15).map(|(_, p)| describe_path(p)).collect();
    if total > 15 {
        lines.push(format!("…and {} more.", total - 15));
    }
    Ok(lines.join("\n"))
}

// --- Actions ---------------------------------------------------------------------------

/// One action that needs no approval. Returns what was done and how long to let it settle.
fn perform(app: &AppHandle, action: Action, shot: Option<ShotGeometry>) -> Result<Effect, String> {
    match action {
        Action::OpenApp { name } => open_app(&name).map(|n| Effect::line(format!("Opened {n}"), 1500)),
        Action::OpenUrl { url } => {
            let url = clean_url(&url)?;
            open_target(&url)?;
            Ok(Effect::line(format!("Opened {}", short(&url)), 1500))
        }
        Action::WebSearch { query } => {
            let query = query.trim();
            if query.is_empty() {
                return Err("Nothing to search for.".into());
            }
            let url = reqwest::Url::parse_with_params("https://www.google.com/search", &[("q", query)]).map_err(|e| e.to_string())?;
            open_target(url.as_str())?;
            Ok(Effect::line(format!("Searched for “{query}”"), 1500))
        }
        Action::OpenFolder { name } => {
            let (label, path) = folder(app, &name)?;
            open_target(&path.to_string_lossy())?;
            Ok(Effect::line(format!("Opened {label}"), 800))
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
            Ok(Effect::line(label, 200))
        }
        Action::SetVolume { percent } => {
            if !cfg!(target_os = "windows") {
                return Err("Setting an exact volume works on Windows only for now.".into());
            }
            let p = percent.clamp(0.0, 100.0);
            // Each volume key is a 2% step on Windows: all the way down, then up to the level.
            let mut e = input()?;
            for _ in 0..50 {
                e.key(Key::VolumeDown, Direction::Click).map_err(|e| e.to_string())?;
            }
            for _ in 0..(p / 2.0).round() as u32 {
                e.key(Key::VolumeUp, Direction::Click).map_err(|e| e.to_string())?;
            }
            Ok(Effect::line(format!("Volume set to {:.0}%", (p / 2.0).round() * 2.0), 200))
        }
        Action::ShowDesktop => {
            if !cfg!(target_os = "windows") {
                return Err("Show desktop works on Windows only for now.".into());
            }
            press_combo(&[Key::Meta], Key::Unicode('d'))?;
            Ok(Effect::line("Showed the desktop", 500))
        }
        Action::LockScreen => {
            lock()?;
            Ok(Effect::line("Locked the screen", 0))
        }
        Action::SetWallpaper { color } => {
            let rgb = parse_color(&color)?;
            set_wallpaper(app, rgb)?;
            Ok(Effect::line(format!("Wallpaper set to {}", color.trim()), 300))
        }
        Action::SystemStatus => Ok(Effect::info(crate::system::status())),
        Action::TopProcesses => Ok(Effect::info(crate::system::top_processes())),
        Action::ClipboardGet => Ok(Effect::info(crate::system::clipboard_get()?)),
        Action::ClipboardSet { text } => {
            crate::system::clipboard_set(&text)?;
            Ok(Effect::line("Copied to the clipboard", 0))
        }
        Action::Remind { text, in_minutes, at } => {
            let when = crate::reminders::due_at(in_minutes, at.as_deref())?;
            let r = crate::reminders::add(app, &text, when)?;
            Ok(Effect::line(format!("Reminder set for {} — {}", crate::reminders::describe(r.at), r.text), 0))
        }
        Action::ListReminders => Ok(Effect::info(crate::reminders::summary(app))),
        Action::FindFiles { query, folder } => Ok(Effect::info(find_files(app, &query, folder.as_deref())?)),
        Action::Click { x, y, double } => {
            let g = shot.ok_or("Clicking needs a look at the screen first.")?;
            let (ix, iy) = if g.normalized { (x / 1000.0 * g.width, y / 1000.0 * g.height) } else { (x, y) };
            if !(0.0..=g.width).contains(&ix) || !(0.0..=g.height).contains(&iy) {
                return Err("That spot is off the screen.".into());
            }
            let px = (g.mx + ix / g.scale).round() as i32;
            let py = (g.my + iy / g.scale).round() as i32;
            click_at(px, py, double)
        }
        Action::ClickElement { id, double } => {
            let (px, py) = crate::screen::element_center(id)?;
            click_at(px, py, double)
        }
        Action::ClickText { text, nth, double } => {
            let (px, py) = crate::screen::text_center(&text, nth.unwrap_or(1))?;
            click_at(px, py, double)
        }
        Action::TypeText { text } => {
            if text.chars().count() > MAX_TYPE_CHARS {
                return Err("That's too much text to type at once.".into());
            }
            input()?.text(&text).map_err(|e| e.to_string())?;
            Ok(Effect::line("", 300))
        }
        Action::Hotkey { keys } => {
            let (mods, key) = parse_combo(&keys)?;
            press_combo(&mods, key)?;
            Ok(Effect::line("", 500))
        }
        Action::Wait { ms } => Ok(Effect::line("", ms.min(5000))),
        // Never reached: gate() stops these for approval first.
        Action::RunCommand { .. } | Action::KillProcess { .. } | Action::Delete { .. } => Err("That needs your approval first.".into()),
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

/// Move the mouse to a physical screen position and click there.
fn click_at(px: i32, py: i32, double: bool) -> Result<Effect, String> {
    let mut e = input()?;
    e.move_mouse(px, py, Coordinate::Abs).map_err(|e| e.to_string())?;
    std::thread::sleep(Duration::from_millis(60));
    e.button(Button::Left, Direction::Click).map_err(|e| e.to_string())?;
    if double {
        std::thread::sleep(Duration::from_millis(60));
        e.button(Button::Left, Direction::Click).map_err(|e| e.to_string())?;
    }
    Ok(Effect::line("", 600))
}

/// The window you were using before Bond took the keyboard (0 if unknown).
pub fn previous_foreground() -> usize {
    *PREVIOUS_FOREGROUND.lock().unwrap()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wildcards() {
        assert!(wildcard("*.zip", "old.zip"));
        assert!(wildcard("*intern*.pdf", "my internship offer.pdf"));
        assert!(wildcard("img_??.png", "img_01.png"));
        assert!(!wildcard("*.zip", "old.zip.txt"));
        assert!(!wildcard("img_??.png", "img_1.png"));
    }

    #[test]
    fn spots_deleting_commands() {
        assert!(deletes_things(r"Remove-Item C:\temp\x -Recurse"));
        assert!(deletes_things("Get-ChildItem *.log | rm"));
        assert!(deletes_things("del /q file.txt"));
        assert!(!deletes_things("Get-ChildItem ~/Downloads"));
        assert!(!deletes_things("ipconfig /all"));
        assert!(!deletes_things("git remote -v"));
    }

    #[test]
    fn long_output_keeps_the_end() {
        let s = "x".repeat(MAX_INFO_CHARS + 50) + "END";
        let c = clip(&s);
        assert!(c.ends_with("END") && c.starts_with("…(earlier"));
    }
}

#[cfg(test)]
mod shell_tests {
    /// Runs real commands; `cargo test -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn runs_a_command() {
        let home = std::env::temp_dir();
        let out = super::run_shell("Write-Output 'héllo'; Get-Date -Format yyyy", &home).unwrap();
        println!("{out}");
        assert!(out.contains("héllo"));
        let bad = super::run_shell("exit 3", &home).unwrap();
        assert!(bad.contains("Exit code 3"), "{bad}");
    }
}
