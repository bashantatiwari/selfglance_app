// A small diagnostics log (<app data>/logs/bond.log): what Bond heard and did, step by
// step, so a problem on someone's own laptop can be traced. Kept under 1 MB; no audio.

use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

const MAX_BYTES: u64 = 1024 * 1024;

static FILE: Mutex<Option<PathBuf>> = Mutex::new(None);

pub fn init(app: &AppHandle) {
    if let Ok(d) = app.path().app_data_dir() {
        let dir = d.join("logs");
        let _ = std::fs::create_dir_all(&dir);
        *FILE.lock().unwrap() = Some(dir.join("bond.log"));
    }
}

/// Append one line, with the time.
pub fn log(line: &str) {
    let Some(path) = FILE.lock().unwrap().clone() else { return };
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > MAX_BYTES) {
        let _ = std::fs::rename(&path, path.with_extension("old.log"));
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{} {}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f"), line.trim());
    }
}

/// Write every panic to the log (message, file and line, thread) before anything else happens to it.
pub fn log_panics() {
    std::panic::set_hook(Box::new(|info| {
        let place = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_else(|| "unknown place".into());
        let what = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "no message".into());
        let thread = std::thread::current();
        log(&format!("PANIC in thread {} at {place}: {what}", thread.name().unwrap_or("unnamed")));
    }));
}

/// From the overlay: what it did with an event.
#[tauri::command]
pub fn diag_log(line: String) {
    log(&format!("[overlay] {}", line.chars().take(500).collect::<String>()));
}
