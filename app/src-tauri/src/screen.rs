// Seeing the screen precisely, on this laptop, without any AI:
//
//   Text      Windows' built-in OCR (Windows.Media.Ocr) reads every word on the screen with
//             its position, exactly as written. Error messages reach the model letter for
//             letter, and "click Sign in" finds the words "Sign in".
//   Controls  UI Automation (the accessibility tree) lists the buttons, fields, links,
//             tabs and menu items of the window you're using, with their names and where
//             they are. The model picks one by number and Bond clicks its centre, which is
//             far more reliable than guessing coordinates from pixels.
//
// Each look is kept as a map until the next one, so the actions that follow ("click_element
// 12", "click_text Submit") resolve against what the model was shown. Passwords are never
// read: UI Automation gives names, not values, and password fields are skipped.

use std::sync::Mutex;

use serde::Serialize;

/// A word (or a run of words) on screen; positions in physical screen pixels.
#[derive(Clone, Debug, Serialize)]
pub struct Word {
    pub text: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct Line {
    pub text: String,
    pub words: Vec<Word>,
}

/// Something you can click or type into.
#[derive(Clone, Debug, Serialize)]
pub struct Element {
    pub id: usize,
    pub kind: &'static str,
    pub name: String,
    /// left, top, right, bottom in physical screen pixels.
    pub rect: (i32, i32, i32, i32),
}

#[derive(Clone, Debug, Default)]
pub struct ScreenMap {
    pub lines: Vec<Line>,
    pub elements: Vec<Element>,
}

static LAST: Mutex<Option<ScreenMap>> = Mutex::new(None);

/// Read the screen (text and controls) and keep it for the actions that follow. Never fails:
/// what can't be read is simply missing. `img` is the full-resolution capture of the monitor
/// whose top-left corner is at (`mx`, `my`).
pub fn read(img: &image::RgbaImage, mx: f64, my: f64) -> ScreenMap {
    let lines = ocr(img, mx, my).unwrap_or_default();
    let elements = elements(150).unwrap_or_default();
    let map = ScreenMap { lines, elements };
    *LAST.lock().unwrap() = Some(map.clone());
    map
}

/// Use this map for the clicks that follow (tests that read a picture, not the screen).
#[cfg(test)]
pub fn remember(map: ScreenMap) {
    *LAST.lock().unwrap() = Some(map);
}

/// The map as text for the model: controls first (to click), then the text (to read).
pub fn describe(map: &ScreenMap, max_chars: usize) -> String {
    let mut out = String::new();
    if !map.elements.is_empty() {
        out.push_str("Controls in the window in front (click one with click_element and its id):\n");
        for e in &map.elements {
            let line = format!("[{}] {} \"{}\"\n", e.id, e.kind, e.name);
            if out.len() + line.len() > max_chars / 2 {
                break;
            }
            out.push_str(&line);
        }
    }
    if !map.lines.is_empty() {
        out.push_str("Text on the screen, exactly as written (top to bottom):\n");
        for l in &map.lines {
            if out.len() + l.text.len() + 1 > max_chars {
                out.push_str("…\n");
                break;
            }
            out.push_str(&l.text);
            out.push('\n');
        }
    }
    out
}

/// What a guide step reads: the controls and the words, with no header chatter and no repeats. Every button's
/// words are also on the screen as text, so a line of text that is just a control's name (or part of one) is
/// left out; that alone is often a third of what was sent. The brain reads about 900 tokens a second, so this is time.
pub fn describe_for_guide(map: &ScreenMap, max_chars: usize) -> String {
    use std::collections::HashSet;
    let mut out = String::new();
    let mut names: Vec<String> = Vec::new();
    // The taskbar on one short line, first: the window's list is cut at a budget, and Start must never be cut.
    let bar: Vec<String> = map.elements.iter().filter(|e| e.kind == "taskbar").map(|e| format!("[{}] {}", e.id, e.name)).collect();
    if !bar.is_empty() {
        out.push_str(&format!("Taskbar buttons: {}\n", bar.join(", ")));
    }
    if map.elements.iter().any(|e| e.kind != "taskbar") {
        out.push_str("Controls [id] kind \"name\":\n");
        // What is listed is cut at a budget, and the page's own buttons come last in reading order, after the
        // window's frame. So the frame's noise goes first: caption buttons, the same control repeated (seven
        // "Close tab" buttons), and the dozens of items of context menus that are not open.
        let mut listed: HashSet<(String, String)> = HashSet::new();
        let mut menu_items = 0;
        for e in map.elements.iter().filter(|e| e.kind != "taskbar") {
            let low = e.name.to_lowercase();
            if matches!(low.as_str(), "minimize" | "maximize" | "restore" | "restore down" | "system") {
                continue;
            }
            if !listed.insert((e.kind.to_string(), low.clone())) {
                continue;
            }
            if e.kind == "menu item" {
                menu_items += 1;
                if menu_items > 10 {
                    continue;
                }
            }
            let name: String = e.name.chars().take(if e.kind == "tab" { 32 } else { 50 }).collect();
            let line = format!("[{}] {} \"{}\"\n", e.id, e.kind, name);
            if out.len() + line.len() > max_chars * 2 / 3 {
                break;
            }
            out.push_str(&line);
            names.push(name.to_lowercase());
        }
    }
    if !map.lines.is_empty() {
        out.push_str("Other text on the screen, top to bottom:\n");
        for l in &map.lines {
            let t = l.text.trim();
            let low = t.to_lowercase();
            if t.chars().count() < 3 || names.iter().any(|n| n.contains(&low)) {
                continue;
            }
            if out.len() + t.len() + 1 > max_chars {
                out.push_str("…\n");
                break;
            }
            out.push_str(t);
            out.push('\n');
        }
    }
    out
}

/// Centre of element `id` from the last look.
pub fn element_center(id: usize) -> Result<(i32, i32), String> {
    let guard = LAST.lock().unwrap();
    let map = guard.as_ref().ok_or("Clicking needs a look at the screen first.")?;
    let e = map.elements.iter().find(|e| e.id == id).ok_or_else(|| format!("There's no control {id} on the screen."))?;
    Ok(((e.rect.0 + e.rect.2) / 2, (e.rect.1 + e.rect.3) / 2))
}

/// Every control from the last look.
pub fn elements_now() -> Vec<Element> {
    LAST.lock().unwrap().as_ref().map(|m| m.elements.clone()).unwrap_or_default()
}

/// The box (left, top, right, bottom, physical pixels) of element `id` from the last look.
pub fn element_rect(id: usize) -> Option<(i32, i32, i32, i32)> {
    let guard = LAST.lock().unwrap();
    guard.as_ref()?.elements.iter().find(|e| e.id == id).map(|e| e.rect)
}

/// Centre of the visible text `target` from the last look (the `nth` match, 1-based,
/// top to bottom). Matches whole words, ignoring case and punctuation around them.
pub fn text_center(target: &str, nth: usize) -> Result<(i32, i32), String> {
    let guard = LAST.lock().unwrap();
    let map = guard.as_ref().ok_or("Clicking needs a look at the screen first.")?;
    let found = find_text(&map.lines, target);
    let hit = found.get(nth.max(1) - 1).ok_or_else(|| format!("I can't see “{}” on the screen.", target.trim()))?;
    // The words are a field's label ("Email" over its box): the box is what you meant.
    if let Some(f) = field_by_label(&map.elements, hit) {
        return Ok(((f.rect.0 + f.rect.2) / 2, (f.rect.1 + f.rect.3) / 2));
    }
    Ok(((hit.x + hit.w / 2.0).round() as i32, (hit.y + hit.h / 2.0).round() as i32))
}

/// A text field right under the words (within 60 px, overlapping horizontally) or right of
/// them (within 40 px, on the same line).
fn field_by_label<'a>(elements: &'a [Element], label: &Word) -> Option<&'a Element> {
    let (lx0, ly0, lx1, ly1) = (label.x, label.y, label.x + label.w, label.y + label.h);
    elements.iter().filter(|e| e.kind == "field").find(|e| {
        let (x0, y0, x1, y1) = (e.rect.0 as f64, e.rect.1 as f64, e.rect.2 as f64, e.rect.3 as f64);
        let below = y0 >= ly1 - 2.0 && y0 - ly1 <= 60.0 && x0 < lx1 && x1 > lx0;
        let beside = x0 >= lx1 - 2.0 && x0 - lx1 <= 40.0 && y0 < ly1 && y1 > ly0;
        below || beside
    })
}

fn norm(s: &str) -> String {
    s.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase()
}

/// Every place the words of `target` appear in a row, as one box each.
fn find_text(lines: &[Line], target: &str) -> Vec<Word> {
    let want: Vec<String> = target.split_whitespace().map(norm).filter(|w| !w.is_empty()).collect();
    if want.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    for line in lines {
        let words: Vec<String> = line.words.iter().map(|w| norm(&w.text)).collect();
        if words.len() < want.len() {
            continue;
        }
        for start in 0..=(words.len() - want.len()) {
            if words[start..start + want.len()] == want[..] {
                let ws = &line.words[start..start + want.len()];
                let (x0, y0) = ws.iter().fold((f64::MAX, f64::MAX), |(x, y), w| (x.min(w.x), y.min(w.y)));
                let (x1, y1) = ws.iter().fold((f64::MIN, f64::MIN), |(x, y), w| (x.max(w.x + w.w), y.max(w.y + w.h)));
                out.push(Word { text: target.into(), x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
            }
        }
    }
    out
}

// --- OCR ---------------------------------------------------------------------------------

#[cfg(target_os = "windows")]
pub fn ocr(img: &image::RgbaImage, ox: f64, oy: f64) -> Result<Vec<Line>, String> {
    use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::Streams::DataWriter;

    let e = |e: windows::core::Error| format!("Couldn't read the screen's text: {e}");
    let engine = OcrEngine::TryCreateFromUserProfileLanguages().map_err(e)?;
    // The engine has a size limit; shrink very large screens (positions are scaled back).
    let max = OcrEngine::MaxImageDimension().map_err(e)? as f64;
    let scale = (max / img.width().max(img.height()) as f64).min(1.0);
    let img = if scale < 1.0 {
        image::imageops::resize(img, (img.width() as f64 * scale) as u32, (img.height() as f64 * scale) as u32, image::imageops::FilterType::Triangle)
    } else {
        img.clone()
    };
    let (w, h) = (img.width() as i32, img.height() as i32);
    // RGBA → BGRA, the layout SoftwareBitmap wants.
    let mut bgra = img.into_raw();
    for px in bgra.chunks_exact_mut(4) {
        px.swap(0, 2);
    }
    let writer = DataWriter::new().map_err(e)?;
    writer.WriteBytes(&bgra).map_err(e)?;
    let buffer = writer.DetachBuffer().map_err(e)?;
    let bitmap = SoftwareBitmap::CreateCopyFromBuffer(&buffer, BitmapPixelFormat::Bgra8, w, h).map_err(e)?;
    let result = engine.RecognizeAsync(&bitmap).map_err(e)?.join().map_err(e)?;
    let mut lines = Vec::new();
    for line in result.Lines().map_err(e)? {
        let mut words = Vec::new();
        for word in line.Words().map_err(e)? {
            let r = word.BoundingRect().map_err(e)?;
            words.push(Word {
                text: word.Text().map_err(e)?.to_string(),
                x: ox + r.X as f64 / scale,
                y: oy + r.Y as f64 / scale,
                w: r.Width as f64 / scale,
                h: r.Height as f64 / scale,
            });
        }
        let text = line.Text().map_err(e)?.to_string();
        if !text.trim().is_empty() {
            lines.push(Line { text, words });
        }
    }
    // Top to bottom, then left to right (OCR returns lines in its own order).
    let pos = |l: &Line| l.words.first().map_or((0.0, 0.0), |w| (w.y, w.x));
    reading_order(&mut lines, 6.0, |l| pos(l));
    Ok(lines)
}

/// Top to bottom, then left to right. Items within `tol` of the row's first item share a row. Sorting
/// with "close enough counts as equal" directly is not a valid order (a~b, b~c, but not a~c), and the
/// sort panics on it; so the rows are formed first and each row is sorted by x.
pub(crate) fn reading_order<T>(items: &mut Vec<T>, tol: f64, key: impl Fn(&T) -> (f64, f64)) {
    items.sort_by(|a, b| key(a).0.total_cmp(&key(b).0));
    let mut rows: Vec<Vec<T>> = Vec::new();
    let mut top = f64::NAN;
    for it in items.drain(..) {
        let y = key(&it).0;
        if rows.is_empty() || (y - top).abs() > tol {
            top = y;
            rows.push(Vec::new());
        }
        rows.last_mut().unwrap().push(it);
    }
    for mut row in rows {
        row.sort_by(|a, b| key(a).1.total_cmp(&key(b).1));
        items.extend(row);
    }
}

#[cfg(not(target_os = "windows"))]
pub fn ocr(_img: &image::RgbaImage, _ox: f64, _oy: f64) -> Result<Vec<Line>, String> {
    Err("Reading screen text works on Windows for now.".into())
}

// --- UI Automation -----------------------------------------------------------------------

/// The window you're using: the one in front, or the one you were in before Bond took the
/// keyboard.
///
/// The desktop, the Start menu and the system flyouts (Wi-Fi, notifications) are what you are using when
/// they are in front, so they are read as they are. Reading the window behind them instead had the guide
/// telling you to close your terminal while you were looking at the desktop.
#[cfg(target_os = "windows")]
pub fn user_window() -> usize {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};
    unsafe {
        let hwnd = GetForegroundWindow();
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        let class = crate::system::window_class(hwnd as usize);
        if matches!(class.as_str(), "Progman" | "WorkerW") {
            return desktop_icons_window().unwrap_or(hwnd as usize);
        }
        if pid == std::process::id() || matches!(class.as_str(), "Shell_TrayWnd" | "Shell_SecondaryTrayWnd") {
            // Bond has the focus (you clicked his note), or the taskbar has it (you clicked a pinned program):
            // the window you were using is the one in front of the others that isn't minimized.
            // Nothing open (everything minimized, as after Win+D): the desktop is what you see.
            match crate::system::top_windows().into_iter().find(|w| !w.minimized) {
                Some(w) => w.hwnd,
                None => desktop_icons_window().unwrap_or_else(crate::agent::previous_foreground),
            }
        } else {
            hwnd as usize
        }
    }
}

/// The window that holds the desktop's icons: Progman, or the WorkerW it moves to when the wallpaper changes.
#[cfg(target_os = "windows")]
fn desktop_icons_window() -> Option<usize> {
    use windows_sys::Win32::UI::WindowsAndMessaging::FindWindowExW;
    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let (progman, workerw, defview) = (wide("Progman"), wide("WorkerW"), wide("SHELLDLL_DefView"));
    unsafe {
        let p = FindWindowExW(std::ptr::null_mut(), std::ptr::null_mut(), progman.as_ptr(), std::ptr::null());
        if !p.is_null() && !FindWindowExW(p, std::ptr::null_mut(), defview.as_ptr(), std::ptr::null()).is_null() {
            return Some(p as usize);
        }
        let mut w = FindWindowExW(std::ptr::null_mut(), std::ptr::null_mut(), workerw.as_ptr(), std::ptr::null());
        while !w.is_null() {
            if !FindWindowExW(w, std::ptr::null_mut(), defview.as_ptr(), std::ptr::null()).is_null() {
                return Some(w as usize);
            }
            w = FindWindowExW(std::ptr::null_mut(), w, workerw.as_ptr(), std::ptr::null());
        }
    }
    None
}

#[cfg(target_os = "windows")]
pub fn elements(max: usize) -> Result<Vec<Element>, String> {
    use uiautomation::types::ControlType;
    use uiautomation::UIAutomation;

    const KINDS: &[(ControlType, &str)] = &[
        (ControlType::Button, "button"),
        (ControlType::SplitButton, "button"),
        (ControlType::Edit, "field"),
        (ControlType::ComboBox, "dropdown"),
        (ControlType::CheckBox, "checkbox"),
        (ControlType::RadioButton, "option"),
        (ControlType::Hyperlink, "link"),
        (ControlType::TabItem, "tab"),
        (ControlType::MenuItem, "menu item"),
        (ControlType::ListItem, "list item"),
        (ControlType::TreeItem, "tree item"),
    ];
    let e = |e: uiautomation::Error| format!("Couldn't read the window's controls: {e}");
    let ua = UIAutomation::new().map_err(e)?;
    let hwnd = user_window();
    let mut out = if hwnd == 0 { Vec::new() } else { controls_of(&ua, hwnd, KINDS, max.saturating_sub(TASKBAR_MAX))? };
    // The taskbar is always on screen, and "click Start" or "open the Wi-Fi menu" is on it: its buttons are always
    // listed (after the window's, so they never crowd them out). They were missing, and he pointed at the window's Close.
    if let Some(tray) = taskbar_window() {
        let mut bar = controls_of(&ua, tray, &[(ControlType::Button, "taskbar")], TASKBAR_MAX).unwrap_or_default();
        for b in &mut bar {
            b.name = taskbar_name(&b.name);
        }
        out.extend(bar.into_iter().filter(|b| !b.name.is_empty()));
    }
    for (i, el) in out.iter_mut().enumerate() {
        el.id = i + 1;
    }
    Ok(out)
}

/// At most this many taskbar buttons are listed.
#[cfg(target_os = "windows")]
const TASKBAR_MAX: usize = 24;

/// "Google Chrome pinned", "Terminal - 2 running windows" → "Google Chrome", "Terminal"; a name of several lines
/// ("Network Internet-Wifi", then its status) → its first line.
fn taskbar_name(name: &str) -> String {
    let first = name.lines().next().unwrap_or("").trim();
    let first = first.split(" - ").next().unwrap_or(first).trim();
    first.strip_suffix(" pinned").unwrap_or(first).trim().to_string()
}

#[cfg(target_os = "windows")]
fn taskbar_window() -> Option<usize> {
    use windows_sys::Win32::UI::WindowsAndMessaging::FindWindowW;
    let class: Vec<u16> = "Shell_TrayWnd".encode_utf16().chain(Some(0)).collect();
    let h = unsafe { FindWindowW(class.as_ptr(), std::ptr::null()) };
    (!h.is_null()).then_some(h as usize)
}

/// The visible, enabled, named controls of one window, of the kinds given, in reading order (ids not set yet).
#[cfg(target_os = "windows")]
fn controls_of(ua: &uiautomation::UIAutomation, hwnd: usize, kinds: &[(uiautomation::types::ControlType, &'static str)], max: usize) -> Result<Vec<Element>, String> {
    use uiautomation::types::{TreeScope, UIProperty};
    use uiautomation::variants::Variant;
    let e = |e: uiautomation::Error| format!("Couldn't read the window's controls: {e}");
    let root = ua.element_from_handle((hwnd as isize).into()).map_err(e)?;
    let mut condition = None;
    for (kind, _) in kinds {
        let c = ua.create_property_condition(UIProperty::ControlType, Variant::from(*kind as i32), None).map_err(e)?;
        condition = Some(match condition {
            None => c,
            Some(prev) => ua.create_or_condition(prev, c).map_err(e)?,
        });
    }
    let condition = condition.expect("KINDS isn't empty");
    // One round-trip for everything we need, instead of one per property per element.
    let cache = ua.create_cache_request().map_err(e)?;
    for p in [UIProperty::Name, UIProperty::ControlType, UIProperty::BoundingRectangle, UIProperty::IsEnabled, UIProperty::IsOffscreen, UIProperty::IsPassword] {
        cache.add_property(p).map_err(e)?;
    }
    let found = root.find_all_build_cache(TreeScope::Descendants, &condition, &cache).map_err(e)?;

    let mut out: Vec<Element> = Vec::new();
    for el in found {
        if el.is_cached_offscreen().unwrap_or(true) || !el.is_cached_enabled().unwrap_or(false) || el.is_cached_password().unwrap_or(false) {
            continue;
        }
        let Ok(r) = el.get_cached_bounding_rectangle() else { continue };
        if r.get_width() < 4 || r.get_height() < 4 {
            continue;
        }
        let Ok(ct) = el.get_cached_control_type() else { continue };
        let Some((_, kind)) = kinds.iter().find(|(k, _)| *k == ct) else { continue };
        let name: String = el.get_cached_name().unwrap_or_default().split_whitespace().collect::<Vec<_>>().join(" ");
        if name.is_empty() && *kind != "field" {
            continue; // nothing to tell it by
        }
        let rect = (r.get_left(), r.get_top(), r.get_right(), r.get_bottom());
        if out.iter().any(|o| o.rect == rect && o.name == name) {
            continue;
        }
        out.push(Element { id: 0, kind, name: name.chars().take(80).collect(), rect });
    }
    reading_order(&mut out, 8.0, |e| (e.rect.1 as f64, e.rect.0 as f64));
    out.truncate(max);
    Ok(out)
}

#[cfg(not(target_os = "windows"))]
pub fn elements(_max: usize) -> Result<Vec<Element>, String> {
    Ok(Vec::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn el(id: usize, kind: &'static str, name: &str) -> Element {
        Element { id, kind, name: name.into(), rect: (0, 0, 10, 10) }
    }

    #[test]
    fn the_guides_screen_text_drops_noise_repeats_and_what_the_controls_already_say() {
        let mut elements = vec![el(1, "button", "Minimize"), el(2, "button", "Close tab"), el(3, "button", "Close tab"), el(4, "button", "Log in")];
        for i in 0..15 {
            elements.push(el(10 + i, "menu item", &format!("Hidden item {i}")));
        }
        elements.push(el(40, "button", "Start building for free"));
        let lines = ["Log in", "Everything we learned from powering the Internet", "ok"]
            .iter()
            .map(|t| Line { text: t.to_string(), words: vec![] })
            .collect();
        let text = describe_for_guide(&ScreenMap { lines, elements }, 3400);
        assert!(!text.contains("Minimize"), "caption buttons are noise");
        assert_eq!(text.matches("Close tab").count(), 1, "a repeated control is listed once");
        assert!(text.contains("[4] button \"Log in\"") && text.contains("[40] button \"Start building for free\""), "the page's own buttons reach the list: {text}");
        assert_eq!(text.matches("menu item").count(), 10, "context-menu items are capped");
        assert_eq!(text.matches("Log in").count(), 1, "text that is only a control's name is not repeated");
        assert!(text.contains("Everything we learned") && !text.contains("\nok\n"), "real text stays, scraps go");
    }

    #[test]
    fn reading_order_survives_a_busy_page_and_reads_rows_left_to_right() {
        // Many items whose heights drift by a few pixels: the old "close enough is equal" comparison panicked on these.
        let mut v: Vec<(f64, f64)> = (0..400).map(|i| (((i * 7) % 50) as f64, ((i * 13) % 97) as f64)).collect();
        super::reading_order(&mut v, 8.0, |p| *p);
        assert_eq!(v.len(), 400);
        let mut rows = vec![(10.0, 300.0), (12.0, 20.0), (40.0, 5.0), (9.0, 100.0)];
        super::reading_order(&mut rows, 8.0, |p| *p);
        assert_eq!(rows, vec![(12.0, 20.0), (9.0, 100.0), (10.0, 300.0), (40.0, 5.0)]);
    }

    fn line(words: &[(&str, f64)]) -> Line {
        Line {
            text: words.iter().map(|w| w.0).collect::<Vec<_>>().join(" "),
            words: words.iter().map(|(t, x)| Word { text: t.to_string(), x: *x, y: 100.0, w: 40.0, h: 20.0 }).collect(),
        }
    }

    #[test]
    fn finds_words_in_a_row() {
        let lines = vec![
            line(&[("Already", 0.0), ("have", 50.0), ("an", 100.0), ("account?", 150.0), ("Sign", 200.0), ("in.", 250.0)]),
            line(&[("Sign", 0.0), ("in", 50.0)]),
        ];
        let hits = find_text(&lines, "sign in");
        assert_eq!(hits.len(), 2);
        assert_eq!((hits[0].x, hits[0].w), (200.0, 90.0));
        assert!(find_text(&lines, "log in").is_empty());
        assert_eq!(find_text(&lines, "Account").len(), 1);
    }

    #[test]
    fn a_label_leads_to_its_field() {
        let label = Word { text: "Email".into(), x: 400.0, y: 290.0, w: 50.0, h: 22.0 };
        let field = |rect| Element { id: 1, kind: "field", name: String::new(), rect };
        // The box under the label (the test signup form).
        let under = [field((400, 320, 880, 355))];
        assert!(field_by_label(&under, &label).is_some());
        // A box beside it.
        assert!(field_by_label(&[field((470, 288, 800, 314))], &label).is_some());
        // Far away, or a button: the words themselves.
        assert!(field_by_label(&[field((400, 600, 880, 635))], &label).is_none());
        let button = Element { id: 2, kind: "button", name: "Go".into(), rect: (400, 320, 480, 355) };
        assert!(field_by_label(&[button], &label).is_none());
    }

    /// OCR on BOND_IMAGE, the 1280x720 test signup form (Submit button centred at 790,475;
    /// red error "Error: Email address is invalid").
    #[test]
    #[ignore]
    fn reads_test_screen() {
        let path = std::env::var("BOND_IMAGE").expect("BOND_IMAGE");
        let img = image::open(path).unwrap().to_rgba8();
        let lines = ocr(&img, 0.0, 0.0).unwrap();
        for l in &lines {
            println!("{}", l.text);
        }
        assert!(lines.iter().any(|l| l.text == "Error: Email address is invalid"));
        let hit = &find_text(&lines, "submit")[0];
        let (cx, cy) = (hit.x + hit.w / 2.0, hit.y + hit.h / 2.0);
        println!("Submit at {cx:.0},{cy:.0}");
        assert!((cx - 790.0).abs() < 15.0 && (cy - 475.0).abs() < 15.0);
    }

    /// Reads this machine's screen (prints only counts and timings):
    ///   cargo test --lib screen::tests::look -- --ignored --nocapture
    #[test]
    #[ignore]
    fn look() {
        let monitor = xcap::Monitor::all().unwrap().into_iter().find(|m| m.is_primary().unwrap_or(false)).unwrap();
        let img = monitor.capture_image().unwrap();
        let t = std::time::Instant::now();
        let lines = ocr(&img, 0.0, 0.0).unwrap();
        println!("OCR: {} lines in {:.2}s", lines.len(), t.elapsed().as_secs_f64());
        let t = std::time::Instant::now();
        let els = elements(150).unwrap();
        println!("UI Automation: {} controls in {:.2}s", els.len(), t.elapsed().as_secs_f64());
    }
}

#[cfg(all(test, target_os = "windows"))]
mod desktop_live {
    /// What UI Automation sees on the desktop: cargo test --lib desktop_live -- --ignored --nocapture
    #[test]
    #[ignore]
    fn desktop_icons_are_readable() {
        use uiautomation::types::{ControlType, TreeScope, UIProperty};
        use uiautomation::variants::Variant;
        use uiautomation::UIAutomation;
        let hwnd = super::desktop_icons_window().expect("no desktop window");
        println!("desktop window class {}", crate::system::window_class(hwnd));
        let ua = UIAutomation::new().unwrap();
        let root = ua.element_from_handle((hwnd as isize).into()).unwrap();
        let cond = ua.create_property_condition(UIProperty::ControlType, Variant::from(ControlType::ListItem as i32), None).unwrap();
        let found = root.find_all(TreeScope::Descendants, &cond).unwrap();
        for el in &found {
            println!("{:?} offscreen={:?} enabled={:?} rect={:?}", el.get_name(), el.is_offscreen(), el.is_enabled(), el.get_bounding_rectangle().map(|r| (r.get_left(), r.get_top())));
        }
        let tray = unsafe { windows_sys::Win32::UI::WindowsAndMessaging::FindWindowW("Shell_TrayWnd".encode_utf16().chain(Some(0)).collect::<Vec<u16>>().as_ptr(), std::ptr::null()) };
        let troot = ua.element_from_handle((tray as isize).into()).unwrap();
        let all = troot.find_all(TreeScope::Descendants, &ua.create_true_condition().unwrap()).unwrap();
        for el in all.iter().take(60) {
            let n = el.get_name().unwrap_or_default();
            if !n.is_empty() {
                println!("tray: {:?} {:?} offscreen={:?}", el.get_control_type(), n, el.is_offscreen());
            }
        }
    }
}
