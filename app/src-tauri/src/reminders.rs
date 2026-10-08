// Reminders: "remind me in 45 minutes to stretch", "remind me at 17:30 to submit the report".
// Kept by Rust in reminders.json (app data folder) and checked every few seconds, so they
// fire whenever SelfGlance is running, even with the dashboard closed. One missed while
// the laptop was off fires right after the next start.
//
// When one is due it is removed from the list and sent to the overlay as `reminder`;
// Bond walks in with it (Snooze puts it back for later).

use std::sync::Mutex;
use std::time::Duration;

use chrono::{Local, NaiveDate, NaiveDateTime, NaiveTime, TimeZone};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Serialize, Deserialize, Clone)]
pub struct Reminder {
    pub id: String,
    pub text: String,
    /// When it is due, ms since the epoch.
    pub at: i64,
}

static STORE: Mutex<Option<Vec<Reminder>>> = Mutex::new(None);

fn file(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("reminders.json"))
}

fn with_store<T>(app: &AppHandle, f: impl FnOnce(&mut Vec<Reminder>) -> T) -> T {
    let mut guard = STORE.lock().unwrap();
    let list = guard.get_or_insert_with(|| {
        file(app)
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    });
    f(list)
}

fn save(app: &AppHandle, list: &[Reminder]) {
    if let Some(p) = file(app) {
        let _ = std::fs::create_dir_all(p.parent().unwrap());
        let _ = std::fs::write(p, serde_json::to_string_pretty(list).unwrap_or_default());
    }
    let _ = app.emit("reminders-changed", ());
}

fn now_ms() -> i64 {
    Local::now().timestamp_millis()
}

/// When a reminder is due: `in_minutes` from now, or `at` in local time ("17:30", "5pm",
/// "5:30 pm", "2026-10-08 09:00"). A time of day already past today means tomorrow.
pub fn due_at(in_minutes: Option<f64>, at: Option<&str>) -> Result<i64, String> {
    if let Some(m) = in_minutes {
        if !(m > 0.0 && m <= 60.0 * 24.0 * 366.0) {
            return Err("That's not a time I can set a reminder for.".into());
        }
        return Ok(now_ms() + (m * 60_000.0) as i64);
    }
    let raw = at.map(str::trim).filter(|s| !s.is_empty()).ok_or("When should I remind you?")?;
    let s = raw.to_uppercase().replace('.', "");
    let local = |dt: NaiveDateTime| Local.from_local_datetime(&dt).earliest().map(|d| d.timestamp_millis());
    for fmt in ["%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S"] {
        if let Ok(dt) = NaiveDateTime::parse_from_str(&s, fmt) {
            return local(dt).ok_or_else(|| "That time doesn't exist here.".into());
        }
    }
    let time = time_of_day(&s.replace(' ', "")).ok_or_else(|| format!("I don't understand the time “{raw}”."))?;
    let today: NaiveDate = Local::now().date_naive();
    let mut when = local(today.and_time(time)).ok_or("That time doesn't exist here.")?;
    if when <= now_ms() {
        when = local(today.succ_opt().unwrap().and_time(time)).ok_or("That time doesn't exist here.")?;
    }
    Ok(when)
}

/// "17:30", "5PM", "5:30PM", "9" (already upper-cased, no spaces).
fn time_of_day(s: &str) -> Option<NaiveTime> {
    let (clock, half) = match s.strip_suffix("PM").or_else(|| s.strip_suffix("P")) {
        Some(c) => (c, Some(12)),
        None => match s.strip_suffix("AM").or_else(|| s.strip_suffix("A")) {
            Some(c) => (c, Some(0)),
            None => (s, None),
        },
    };
    let (h, m) = match clock.split_once(':') {
        Some((h, m)) => (h.parse::<u32>().ok()?, m.parse::<u32>().ok()?),
        None => (clock.parse::<u32>().ok()?, 0),
    };
    let h = match half {
        Some(add) if (1..=12).contains(&h) => h % 12 + add,
        Some(_) => return None,
        None => h,
    };
    NaiveTime::from_hms_opt(h, m, 0)
}

/// "17:30", "tomorrow 09:00", "Fri 12 Oct 09:00".
pub fn describe(at: i64) -> String {
    let Some(t) = Local.timestamp_millis_opt(at).single() else { return String::new() };
    let today = Local::now().date_naive();
    let d = t.date_naive();
    if d == today {
        t.format("%H:%M").to_string()
    } else if Some(d) == today.succ_opt() {
        format!("tomorrow {}", t.format("%H:%M"))
    } else {
        t.format("%a %-d %b %H:%M").to_string()
    }
}

pub fn add(app: &AppHandle, text: &str, at: i64) -> Result<Reminder, String> {
    let text = text.trim().trim_start_matches("to ").trim();
    if text.is_empty() {
        return Err("What should I remind you about?".into());
    }
    let r = Reminder { id: format!("{:x}{:04x}", now_ms(), rand_u16()), text: text.to_string(), at };
    with_store(app, |list| {
        list.push(r.clone());
        list.sort_by_key(|r| r.at);
        save(app, list);
    });
    Ok(r)
}

fn rand_u16() -> u16 {
    (std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0) & 0xffff) as u16
}

/// Upcoming reminders as lines for Bond's answer card.
pub fn summary(app: &AppHandle) -> String {
    let list = with_store(app, |l| l.clone());
    if list.is_empty() {
        return "No reminders set. Try “remind me in 30 minutes to stretch”.".into();
    }
    list.iter().map(|r| format!("{} — {}", describe(r.at), r.text)).collect::<Vec<_>>().join("\n")
}

#[tauri::command]
pub fn reminders_list(app: AppHandle) -> Vec<Reminder> {
    with_store(&app, |l| l.clone())
}

#[tauri::command]
pub fn reminder_add(app: AppHandle, text: String, at: i64) -> Result<Reminder, String> {
    add(&app, &text, at)
}

#[tauri::command]
pub fn reminder_remove(app: AppHandle, id: String) {
    with_store(&app, |list| {
        list.retain(|r| r.id != id);
        save(&app, list);
    });
}

/// Put a reminder that just fired back for `minutes` from now.
#[tauri::command]
pub fn reminder_snooze(app: AppHandle, text: String, minutes: f64) -> Result<Reminder, String> {
    let at = due_at(Some(minutes), None)?;
    add(&app, &text, at)
}

/// Fire due reminders. Waits a little at startup so the overlay is listening first.
pub fn spawn_watch(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(8));
        loop {
            let now = now_ms();
            let due: Vec<Reminder> = with_store(&app, |list| {
                let (due, rest): (Vec<_>, Vec<_>) = list.drain(..).partition(|r| r.at <= now);
                *list = rest;
                if !due.is_empty() {
                    save(&app, list);
                }
                due
            });
            for r in due {
                let _ = app.emit("reminder", &r);
            }
            std::thread::sleep(Duration::from_secs(5));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn times_of_day() {
        assert_eq!(time_of_day("17:30"), NaiveTime::from_hms_opt(17, 30, 0));
        assert_eq!(time_of_day("5PM"), NaiveTime::from_hms_opt(17, 0, 0));
        assert_eq!(time_of_day("5:15PM"), NaiveTime::from_hms_opt(17, 15, 0));
        assert_eq!(time_of_day("12AM"), NaiveTime::from_hms_opt(0, 0, 0));
        assert_eq!(time_of_day("12PM"), NaiveTime::from_hms_opt(12, 0, 0));
        assert_eq!(time_of_day("9"), NaiveTime::from_hms_opt(9, 0, 0));
        assert_eq!(time_of_day("13PM"), None);
        assert_eq!(time_of_day("soon"), None);
    }

    #[test]
    fn due_times() {
        let now = now_ms();
        let in45 = due_at(Some(45.0), None).unwrap();
        assert!((in45 - now - 45 * 60_000).abs() < 2000);
        let at = due_at(None, Some("5:30 pm")).unwrap();
        assert!(at > now && at <= now + 24 * 3600_000);
        assert!(due_at(None, Some("2030-01-02 09:00")).is_ok());
        assert!(due_at(Some(-5.0), None).is_err());
        assert!(due_at(None, Some("whenever")).is_err());
    }
}
