// Journal: one plain-text file per day (journal/2026-10-10.md in the app data folder), so
// entries survive restarts, updates and dev builds alike, and you can open them yourself.
// The Journal page saves as you type; "log …" to Bond appends a timestamped line.

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

fn dir(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_data_dir().map_err(|e| e.to_string())?.join("journal");
    std::fs::create_dir_all(&d).map_err(|e| format!("Couldn't make the journal folder: {e}"))?;
    Ok(d)
}

/// "2026-10-10" only, so a day can never name a path outside the folder.
fn file(app: &AppHandle, day: &str) -> Result<PathBuf, String> {
    let ok = day.len() == 10 && day.chars().enumerate().all(|(i, c)| if i == 4 || i == 7 { c == '-' } else { c.is_ascii_digit() });
    if !ok {
        return Err(format!("“{day}” isn't a day."));
    }
    Ok(dir(app)?.join(format!("{day}.md")))
}

fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

#[tauri::command]
pub fn journal_get(app: AppHandle, day: String) -> Result<String, String> {
    Ok(std::fs::read_to_string(file(&app, &day)?).unwrap_or_default())
}

/// Save a day's entry; an empty one removes the file.
#[tauri::command]
pub fn journal_set(app: AppHandle, day: String, text: String) -> Result<(), String> {
    let path = file(&app, &day)?;
    if text.trim().is_empty() {
        let _ = std::fs::remove_file(path);
        return Ok(());
    }
    // Write beside it, then swap in: a crash mid-save never leaves half an entry.
    let tmp = path.with_extension("md.tmp");
    std::fs::write(&tmp, &text).map_err(|e| format!("Couldn't save the journal: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("Couldn't save the journal: {e}"))
}

/// Add a line to today's entry and tell an open Journal page.
#[tauri::command]
pub fn journal_append(app: AppHandle, line: String) -> Result<(), String> {
    let day = today();
    let before = journal_get(app.clone(), day.clone())?;
    let before = before.trim_end();
    let text = if before.is_empty() { line.trim().to_string() } else { format!("{before}\n{}", line.trim()) };
    journal_set(app.clone(), day, text)?;
    let _ = app.emit("notes-changed", ());
    Ok(())
}

#[derive(Serialize)]
pub struct Entry {
    pub day: String,
    pub text: String,
}

/// Every entry, newest first.
#[tauri::command]
pub fn journal_list(app: AppHandle) -> Result<Vec<Entry>, String> {
    let mut out: Vec<Entry> = std::fs::read_dir(dir(&app)?)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let day = name.strip_suffix(".md")?.to_string();
            file(&app, &day).ok()?;
            let text = std::fs::read_to_string(e.path()).ok()?;
            (!text.trim().is_empty()).then_some(Entry { day, text })
        })
        .collect();
    out.sort_by(|a, b| b.day.cmp(&a.day));
    Ok(out)
}
