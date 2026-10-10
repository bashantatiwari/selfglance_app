// The laptop itself: battery, memory, CPU and disk, what is slowing it down, ending a
// program (only after you approve, see agent.rs), the clipboard, and a low-battery warning.
// Everything here is read locally; nothing is sent anywhere unless you ask Bond about it.

use std::collections::HashMap;
use std::time::Duration;

use sysinfo::{Disks, Pid, ProcessesToUpdate, System};
use tauri::{AppHandle, Emitter};

const GB: f64 = 1024.0 * 1024.0 * 1024.0;

/// Processes Bond never ends: Windows can't run (or crashes) without them.
const PROTECTED: &[&str] = &["system", "idle", "csrss", "wininit", "winlogon", "services", "lsass", "smss", "svchost", "dwm", "fontdrvhost", "registry", "memory compression", "launchd", "kernel_task", "systemd", "init"];

pub struct Battery {
    pub percent: u8,
    pub charging: bool,
}

#[cfg(target_os = "windows")]
pub fn battery() -> Option<Battery> {
    use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    let mut s: SYSTEM_POWER_STATUS = unsafe { std::mem::zeroed() };
    if unsafe { GetSystemPowerStatus(&mut s) } == 0 || s.BatteryFlag == 128 || s.BatteryLifePercent > 100 {
        return None; // no battery (desktop PC) or unknown
    }
    Some(Battery { percent: s.BatteryLifePercent, charging: s.ACLineStatus == 1 })
}

#[cfg(not(target_os = "windows"))]
pub fn battery() -> Option<Battery> {
    None
}

/// "How's my laptop?": battery, memory, CPU and every disk, one line each.
pub fn status() -> String {
    let mut sys = System::new();
    sys.refresh_memory();
    sys.refresh_cpu_usage();
    std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL.max(Duration::from_millis(300)));
    sys.refresh_cpu_usage();

    let mut lines = Vec::new();
    if let Some(b) = battery() {
        lines.push(format!("Battery {}%{}", b.percent, if b.charging { " (plugged in)" } else { "" }));
    }
    let total = sys.total_memory() as f64;
    let used = total - sys.available_memory() as f64;
    if total > 0.0 {
        lines.push(format!("Memory {:.1} of {:.1} GB used ({:.0}%)", used / GB, total / GB, used / total * 100.0));
    }
    lines.push(format!("CPU {:.0}% busy", sys.global_cpu_usage()));
    let disks = Disks::new_with_refreshed_list();
    let mut seen = std::collections::HashSet::new();
    for d in disks.list() {
        let mount = d.mount_point().to_string_lossy().to_string();
        if d.total_space() == 0 || !seen.insert(mount.clone()) {
            continue;
        }
        let (free, total) = (d.available_space() as f64, d.total_space() as f64);
        let pct = (total - free) / total * 100.0;
        let warn = if pct >= 90.0 { "  ⚠ almost full" } else { "" };
        lines.push(format!("Disk {}  {:.0} GB free of {:.0} GB ({:.0}% used){warn}", mount.trim_end_matches('\\'), free / GB, total / GB, pct));
    }
    lines.join("\n")
}

/// A program as people think of it: all processes with the same name added together.
struct Group {
    name: String,
    cpu: f32,
    mem: u64,
    count: usize,
}

fn groups(sys: &System) -> Vec<Group> {
    let own = std::process::id();
    let cores = sys.cpus().len().max(1) as f32;
    let mut by_name: HashMap<String, Group> = HashMap::new();
    for (pid, p) in sys.processes() {
        if pid.as_u32() == own {
            continue;
        }
        let name = clean_name(&p.name().to_string_lossy());
        if name.is_empty() || PROTECTED.contains(&name.to_lowercase().as_str()) {
            continue;
        }
        let g = by_name.entry(name.to_lowercase()).or_insert(Group { name, cpu: 0.0, mem: 0, count: 0 });
        g.cpu += p.cpu_usage() / cores;
        g.mem += p.memory();
        g.count += 1;
    }
    by_name.into_values().collect()
}

fn clean_name(name: &str) -> String {
    let n = name.trim();
    n.strip_suffix(".exe").or_else(|| n.strip_suffix(".EXE")).unwrap_or(n).to_string()
}

fn sampled() -> System {
    let mut sys = System::new();
    sys.refresh_cpu_usage();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    std::thread::sleep(Duration::from_millis(700));
    sys.refresh_cpu_usage();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    sys
}

/// "Why is my laptop slow?": the programs using the most CPU, then the most memory.
pub fn top_processes() -> String {
    let sys = sampled();
    let mut gs = groups(&sys);
    let line = |g: &Group| {
        let many = if g.count > 1 { format!(" ({} processes)", g.count) } else { String::new() };
        format!("{} — {:.0}% CPU, {:.1} GB{many}", g.name, g.cpu, g.mem as f64 / GB)
    };
    let mut out = vec!["Busiest right now:".to_string()];
    gs.sort_by(|a, b| b.cpu.total_cmp(&a.cpu));
    out.extend(gs.iter().take(5).map(|g| format!("  {}", line(g))));
    gs.sort_by(|a, b| b.mem.cmp(&a.mem));
    out.push("Most memory:".into());
    out.extend(gs.iter().take(5).map(|g| format!("  {}", line(g))));
    let total = sys.total_memory() as f64;
    if total > 0.0 {
        let used = total - sys.available_memory() as f64;
        out.push(format!("Memory {:.0}% used, CPU {:.0}% busy.", used / total * 100.0, sys.global_cpu_usage()));
    }
    out.push("Say “close <name>” and I'll end one (you approve first).".into());
    out.join("\n")
}

/// Free memory available right now, in bytes.
pub fn available_memory() -> u64 {
    let mut sys = System::new();
    sys.refresh_memory();
    sys.available_memory()
}

/// "Free up some RAM": what Bond let go of, then the programs holding the most memory,
/// so you can pick which to close (each one still asks first).
pub fn free_memory_report(freed_own: Option<u64>, unloaded: &[&str]) -> String {
    let mut sys = System::new();
    sys.refresh_memory();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    let mut out = Vec::new();
    match (unloaded.is_empty(), freed_own) {
        (true, _) => out.push("My own models weren't loaded, so nothing of mine to free.".to_string()),
        (false, Some(b)) if b > 50 * 1024 * 1024 => out.push(format!("Unloaded my {}: about {:.1} GB back.", unloaded.join(" and "), b as f64 / GB)),
        (false, _) => out.push(format!("Unloaded my {} (their memory is on the graphics card or was already small).", unloaded.join(" and "))),
    }
    let mut gs = groups(&sys);
    gs.sort_by(|a, b| b.mem.cmp(&a.mem));
    out.push("Holding the most memory now:".into());
    out.extend(gs.iter().take(6).map(|g| {
        let many = if g.count > 1 { format!(" ({} processes)", g.count) } else { String::new() };
        format!("  {} — {:.1} GB{many}", g.name, g.mem as f64 / GB)
    }));
    let total = sys.total_memory() as f64;
    if total > 0.0 {
        let free = sys.available_memory() as f64;
        out.push(format!("{:.1} of {:.1} GB free.", free / GB, total / GB));
    }
    out.push("Say “close <name>” to end one of these (you approve first).".into());
    out.join("\n")
}

/// Processes matching a name ("chrome", "chrome.exe") or a PID, for the approval card.
pub struct Found {
    pub pids: Vec<u32>,
    pub summary: String,
}

pub fn find_processes(name: &str) -> Result<Found, String> {
    let wanted = clean_name(name).to_lowercase();
    if wanted.is_empty() {
        return Err("Which program?".into());
    }
    if PROTECTED.contains(&wanted.as_str()) {
        return Err(format!("“{name}” is part of the operating system; Bond won't end it."));
    }
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    let own = std::process::id();
    let by_pid = wanted.parse::<u32>().ok();
    let mut pids = Vec::new();
    let mut mem = 0;
    let mut shown = String::new();
    for (pid, p) in sys.processes() {
        let pname = clean_name(&p.name().to_string_lossy());
        let hit = match by_pid {
            Some(n) => pid.as_u32() == n,
            None => pname.to_lowercase() == wanted,
        };
        if hit && pid.as_u32() != own && !PROTECTED.contains(&pname.to_lowercase().as_str()) {
            pids.push(pid.as_u32());
            mem += p.memory();
            shown = pname;
        }
    }
    if pids.is_empty() {
        return Err(format!("No running program called “{name}”."));
    }
    let many = if pids.len() > 1 { format!("{} processes", pids.len()) } else { format!("PID {}", pids[0]) };
    Ok(Found { pids, summary: format!("{shown} — {many}, {:.1} GB memory. Unsaved work in it will be lost.", mem as f64 / GB) })
}

/// The program a request means: "it" / "this app" is the one in front of you; a name is a
/// process ("notepad") or the app's own name ("Visual Studio Code" → code).
pub fn which_app(name: &str) -> Result<(Vec<u32>, String), String> {
    let n = name.trim().trim_end_matches(['.', '!']).to_lowercase();
    let n = n.trim_start_matches("the ").trim_end_matches(" app").trim_end_matches(" window").trim().to_string();
    let last = crate::memory::last_app();
    let generic = matches!(n.as_str(), "" | "it" | "this" | "that" | "app" | "window" | "this app" | "that app" | "this window" | "that one" | "this one");
    let process = if generic {
        last.as_ref().map(|(p, _)| p.clone()).ok_or("Which app should I close?")?
    } else {
        match find_processes(&n) {
            Ok(_) => n.clone(),
            Err(e) => match &last {
                Some((p, shown)) if shown.to_lowercase().contains(&n) || n.contains(&shown.to_lowercase()) => p.clone(),
                _ => return Err(e),
            },
        }
    };
    if process == "selfglance" {
        return Err("That's me. Right-click me and choose Quit to close me.".into());
    }
    let found = find_processes(&process)?;
    let shown = match &last {
        Some((p, shown)) if *p == process && !shown.is_empty() => shown.clone(),
        _ => {
            let mut c = process.chars();
            c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
        }
    };
    Ok((found.pids, shown))
}

/// The visible windows of these processes (with their owned dialogs when `owned`).
#[cfg(target_os = "windows")]
fn windows_of(pids: &[u32], owned: bool) -> Vec<usize> {
    use windows_sys::Win32::Foundation::{HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{EnumWindows, GetClassNameW, GetWindow, GetWindowThreadProcessId, IsWindowVisible, GW_OWNER};
    struct Ctx<'a> {
        pids: &'a [u32],
        owned: bool,
        out: Vec<usize>,
    }
    unsafe extern "system" fn each(hwnd: HWND, lp: LPARAM) -> i32 {
        let ctx = &mut *(lp as *mut Ctx);
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if !ctx.pids.contains(&pid) || IsWindowVisible(hwnd) == 0 || (!ctx.owned && !GetWindow(hwnd, GW_OWNER).is_null()) {
            return 1;
        }
        // Never the desktop or the taskbar (closing those asks to shut down).
        let mut class = [0u16; 64];
        let len = GetClassNameW(hwnd, class.as_mut_ptr(), class.len() as i32).max(0) as usize;
        let class = String::from_utf16_lossy(&class[..len]);
        if !matches!(class.as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd") {
            ctx.out.push(hwnd as usize);
        }
        1
    }
    let mut ctx = Ctx { pids, owned, out: Vec::new() };
    unsafe {
        EnumWindows(Some(each), &mut ctx as *mut Ctx as LPARAM);
    }
    ctx.out
}

/// Ask a program's windows to close, as their × button does.
#[cfg(target_os = "windows")]
pub fn close_windows(pids: &[u32]) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{PostMessageW, WM_CLOSE};
    for hwnd in windows_of(pids, false) {
        unsafe {
            PostMessageW(hwnd as _, WM_CLOSE, 0, 0);
        }
    }
}

/// Whether the program closed (or put all its windows away) within `within`.
#[cfg(target_os = "windows")]
pub fn wait_closed(pids: &[u32], within: Duration) -> bool {
    let start = std::time::Instant::now();
    loop {
        if windows_of(pids, true).is_empty() {
            return true;
        }
        if start.elapsed() > within {
            return false;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
}

/// Put the program's front window (its question, if it is asking) in front of you.
#[cfg(target_os = "windows")]
pub fn bring_to_front(pids: &[u32]) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId, SetForegroundWindow};
    let front = |pids: &[u32]| unsafe {
        let mut pid = 0u32;
        GetWindowThreadProcessId(GetForegroundWindow(), &mut pid);
        pids.contains(&pid)
    };
    if front(pids) {
        return true;
    }
    // A dialog it owns first (that is where Save is), then its main window.
    let mut wins = windows_of(pids, true);
    wins.sort_by_key(|w| windows_of(pids, false).contains(w));
    for w in wins {
        unsafe {
            SetForegroundWindow(w as _);
        }
        std::thread::sleep(Duration::from_millis(200));
        if front(pids) {
            return true;
        }
    }
    false
}

#[cfg(not(target_os = "windows"))]
pub fn close_windows(_pids: &[u32]) {}

#[cfg(not(target_os = "windows"))]
pub fn wait_closed(_pids: &[u32], _within: Duration) -> bool {
    false
}

#[cfg(not(target_os = "windows"))]
pub fn bring_to_front(_pids: &[u32]) -> bool {
    false
}

pub fn kill(pids: &[u32]) -> Result<usize, String> {
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    let ended = pids.iter().filter(|pid| sys.process(Pid::from_u32(**pid)).is_some_and(|p| p.kill())).count();
    if ended == 0 {
        return Err("Couldn't end it (it may need administrator rights, or it already closed).".into());
    }
    Ok(ended)
}

pub fn clipboard_get() -> Result<String, String> {
    let text = arboard::Clipboard::new().and_then(|mut c| c.get_text()).map_err(|_| "There's no text on the clipboard.".to_string())?;
    if text.trim().is_empty() {
        return Err("The clipboard is empty.".into());
    }
    Ok(text)
}

pub fn clipboard_set(text: &str) -> Result<(), String> {
    arboard::Clipboard::new().and_then(|mut c| c.set_text(text)).map_err(|e| format!("Couldn't copy: {e}"))
}

/// The clipboard text, for asking the AI about what you copied.
#[tauri::command]
pub fn clipboard_text() -> Result<String, String> {
    clipboard_get()
}

/// Emits `low-battery` (percent) once when the battery drops to 15% while unplugged, and
/// once more at 7%. Plugging in resets it.
pub fn spawn_battery_watch(app: AppHandle) {
    std::thread::spawn(move || {
        let mut warned_at: Option<u8> = None;
        loop {
            if let Some(b) = battery() {
                if b.charging || b.percent > 20 {
                    warned_at = None;
                } else {
                    let level = if b.percent <= 7 { 7 } else if b.percent <= 15 { 15 } else { 100 };
                    if level < 100 && warned_at.is_none_or(|w| level < w) {
                        warned_at = Some(level);
                        let _ = app.emit("low-battery", b.percent);
                    }
                }
            }
            std::thread::sleep(Duration::from_secs(60));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    /// A real Notepad opened and closed politely: cargo test --lib system::tests::close_live -- --ignored --nocapture
    #[test]
    #[ignore]
    #[cfg(target_os = "windows")]
    fn close_live() {
        let before = find_processes("notepad").map(|f| f.pids).unwrap_or_default();
        let dir = std::env::temp_dir().join("bond-close-test.txt");
        std::fs::write(&dir, "test").unwrap();
        std::process::Command::new("notepad").arg(&dir).spawn().unwrap();
        std::thread::sleep(Duration::from_secs(3));
        let pids: Vec<u32> = find_processes("notepad").unwrap().pids.into_iter().filter(|p| !before.contains(p)).collect();
        println!("new notepad pids {pids:?}, windows {:?}", windows_of(&pids, true).len());
        if pids.is_empty() {
            println!("Notepad reused a running process; skipping");
            return;
        }
        close_windows(&pids);
        let closed = wait_closed(&pids, Duration::from_millis(2500));
        println!("closed politely: {closed}");
        assert!(closed);
    }

    /// Reads the real machine; run with `cargo test -- --ignored --nocapture` to see it.
    #[test]
    #[ignore]
    fn show_this_machine() {
        println!("{}\n\n{}", super::status(), super::top_processes());
        assert!(super::find_processes("csrss").is_err());
        assert!(super::find_processes("no-such-program-xyz").is_err());
    }
}
