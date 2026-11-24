// Goals, the brain's part: for the day's goal, label the activities the rules (goals.ts)
// can't judge from your own words, entertainment or meetings. One short call labels up to a
// handful of them (an app plus a window or page title each); the answers are remembered by
// the frontend, so each is asked once.
//
// Like everything the brain does, it runs on this laptop. Password managers, banking and
// private windows are never sent to it (they stay "neutral"), and nothing is asked on a low
// battery or when no brain is installed: the rules still work, just with more left unclear.

use serde::Deserialize;
use serde_json::{json, Value};

/// At most this many items in one call.
const MAX_ITEMS: usize = 8;

#[derive(Deserialize, Debug)]
pub struct Item {
    pub app: String,
    pub label: String,
}

const SYSTEM: &str = r#"You help someone stay on their goal for the day. They give the goal, then numbered activities. Each activity is an app and the title of its window or page.
For each activity answer one word:
- on: it plausibly helps the goal (the topic itself, its tools, documentation, research, a related tutorial or course).
- off: it clearly has nothing to do with the goal (entertainment, social media, shopping, news, a different subject).
- neutral: you can't tell from the text, or it is general-purpose (email, chat, file manager, settings, a code project whose name says nothing about the goal).
Judge only from the text. When in doubt, answer neutral. Give exactly one answer per activity, in order.

Goal: finish the micrograd tutorial
1. Google Chrome — PyTorch autograd documentation
2. Google Chrome — Best pizza places near me
3. Slack — #general
4. Google Chrome — Karpathy: the spelled-out intro to neural networks
5. Spotify — Chill Hits
→ {"fits":["on","off","neutral","on","off"]}

Goal: file my tax return
1. Google Chrome — Income tax e-filing portal
2. Visual Studio Code — selfglance
3. Google Chrome — IPL live score
4. Microsoft Excel — expenses 2025
→ {"fits":["on","neutral","off","on"]}"#;

fn prompt(goals: &[String], items: &[Item]) -> String {
    let mut p = format!("Goal: {}\n", goals.join("; "));
    for (i, it) in items.iter().enumerate() {
        p += &format!("{}. {} — {}\n", i + 1, it.app, it.label);
    }
    p
}

fn schema(n: usize) -> Value {
    json!({
        "type": "object",
        "properties": {
            "fits": {
                "type": "array",
                "items": {"type": "string", "enum": ["on", "off", "neutral"]},
                "minItems": n,
                "maxItems": n,
            }
        },
        "required": ["fits"],
        "additionalProperties": false,
    })
}

/// The answers in order, or an error when the reply doesn't match what was asked.
fn parse(reply: &str, n: usize) -> Result<Vec<String>, String> {
    let v: Value = serde_json::from_str(reply).map_err(|e| format!("unreadable reply: {e}"))?;
    let fits: Vec<String> = v["fits"]
        .as_array()
        .ok_or("no answers")?
        .iter()
        .map(|x| x.as_str().unwrap_or("neutral"))
        .map(|s| if matches!(s, "on" | "off") { s.to_string() } else { "neutral".to_string() })
        .collect();
    if fits.len() == n {
        Ok(fits)
    } else {
        Err(format!("asked about {n} activities, got {} answers", fits.len()))
    }
}

/// Ask the brain, no checks on the machine's state (the tests use this).
async fn judge(goals: &[String], items: &[Item]) -> Result<Vec<String>, String> {
    if items.is_empty() {
        return Ok(vec![]);
    }
    let reply = crate::brain::chat(SYSTEM, &prompt(goals, items), None, Some(&schema(items.len())), 20 + 8 * items.len() as u32).await?;
    parse(&reply, items.len())
}

/// Label activities against today's goals: "on", "off" or "neutral" for each, in order. An empty
/// list when there is no brain, the battery is low, or there is nothing to ask.
#[tauri::command]
pub async fn goal_judge(goals: Vec<String>, items: Vec<Item>, blocked: Vec<String>) -> Result<Vec<String>, String> {
    if goals.is_empty() || items.is_empty() || !crate::brain::ready() || low_battery() {
        return Ok(vec![]);
    }
    let items: Vec<Item> = items
        .into_iter()
        .take(MAX_ITEMS)
        .map(|i| Item { app: i.app.chars().take(60).collect(), label: i.label.chars().take(100).collect() })
        .collect();
    let goals: Vec<String> = goals.into_iter().take(3).map(|g| g.chars().take(120).collect()).collect();
    // Private windows are never sent; they count as neutral.
    let open: Vec<usize> = (0..items.len()).filter(|&i| !is_private(&format!("{} {}", items[i].app, items[i].label), &blocked)).collect();
    let sent: Vec<Item> = open.iter().map(|&i| Item { app: items[i].app.clone(), label: items[i].label.clone() }).collect();
    let answers = judge(&goals, &sent).await?;
    let mut out = vec!["neutral".to_string(); items.len()];
    for (a, &i) in answers.into_iter().zip(open.iter()) {
        out[i] = a;
    }
    Ok(out)
}

/// Windows that are never sent to the brain: they count as neutral.
const PRIVATE: &[&str] = &[
    "password", "1password", "bitwarden", "keepass", "lastpass", "dashlane", "bank", "paypal", "wallet", "inprivate", "incognito", "private browsing",
    "credential", "sign in", "log in", "login",
];

fn is_private(text: &str, blocked: &[String]) -> bool {
    let t = text.to_lowercase();
    PRIVATE.iter().any(|p| t.contains(p)) || blocked.iter().any(|b| !b.trim().is_empty() && t.contains(&b.trim().to_lowercase()))
}

/// Judging costs battery: on a low battery off the charger it waits.
fn low_battery() -> bool {
    crate::system::battery().is_some_and(|b| !b.charging && b.percent < 30)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_lists_the_goal_and_numbered_activities() {
        let p = prompt(&["finish micrograd".into(), "reply to mum".into()], &[Item { app: "Google Chrome".into(), label: "Gmail".into() }]);
        assert_eq!(p, "Goal: finish micrograd; reply to mum\n1. Google Chrome — Gmail\n");
    }

    #[test]
    fn schema_demands_one_answer_per_activity() {
        let s = schema(3);
        assert_eq!(s["properties"]["fits"]["minItems"], 3);
        assert_eq!(s["properties"]["fits"]["maxItems"], 3);
    }

    #[test]
    fn parses_answers_and_rejects_a_wrong_count() {
        assert_eq!(parse(r#"{"fits":["on","off","neutral"]}"#, 3).unwrap(), ["on", "off", "neutral"]);
        assert_eq!(parse(r#"{"fits":["maybe"]}"#, 1).unwrap(), ["neutral"]);
        assert!(parse(r#"{"fits":["on"]}"#, 2).is_err());
        assert!(parse("nope", 1).is_err());
    }

    #[test]
    fn the_examples_in_the_prompt_are_valid() {
        for line in SYSTEM.lines().filter(|l| l.starts_with("→ ")) {
            let v: Value = serde_json::from_str(line.trim_start_matches("→ ")).expect("example is JSON");
            assert!(v["fits"].is_array());
        }
    }

    /// Hand-labelled activities, none of them in the prompt's examples: what a right answer says.
    /// on / off / neutral, per goal. `neutral` means the text can't settle it.
    const CASES: &[(&str, &[(&str, &str, &str)])] = &[
        (
            "learn deep learning: finish the micrograd tutorial",
            &[
                ("Google Chrome", "3Blue1Brown: But what is a neural network? | Chapter 1", "on"),
                ("Google Chrome", "Backpropagation calculus explained", "on"),
                ("Visual Studio Code", "micrograd", "on"),
                ("Google Chrome", "Stack Overflow: how does autograd compute gradients", "on"),
                ("Google Chrome", "numpy.dot — NumPy documentation", "on"),
                ("Google Chrome", "Top 10 anime fights of all time", "off"),
                ("Google Chrome", "Amazon.in: wireless earbuds under 2000", "off"),
                ("Google Chrome", "Instagram", "off"),
                ("Google Chrome", "India vs Australia highlights", "off"),
                ("Google Chrome", "Gmail", "neutral"),
                ("File Explorer", "Downloads", "neutral"),
                ("Slack", "team-chat", "neutral"),
                ("Settings", "Display", "neutral"),
                ("Visual Studio Code", "invoice-app", "neutral"),
            ],
        ),
        (
            "write the quarterly report for work",
            &[
                ("Microsoft Word", "Q3 report - draft", "on"),
                ("Microsoft Excel", "sales figures q3", "on"),
                ("Google Chrome", "Quarterly business report template", "on"),
                ("Google Chrome", "How to write an executive summary", "on"),
                ("Google Chrome", "YouTube: funny cats compilation", "off"),
                ("Google Chrome", "Reddit: r/gaming", "off"),
                ("Steam", "Library", "off"),
                ("Google Chrome", "Flights to Goa in December", "off"),
                ("Outlook", "Inbox", "neutral"),
                ("Google Chrome", "Google Calendar", "neutral"),
                ("Notepad", "Untitled", "neutral"),
            ],
        ),
        (
            "prepare for the DSA interview: two LeetCode problems",
            &[
                ("Google Chrome", "Two Sum - LeetCode", "on"),
                ("Google Chrome", "Binary tree traversal explained - GeeksforGeeks", "on"),
                ("Visual Studio Code", "solutions", "on"),
                ("Google Chrome", "Time complexity cheat sheet", "on"),
                ("Google Chrome", "Netflix", "off"),
                ("Google Chrome", "Zomato: order food online", "off"),
                ("Google Chrome", "Twitter / X", "off"),
                ("WhatsApp", "Family group", "neutral"),
                ("Google Chrome", "Gmail", "neutral"),
            ],
        ),
    ];

    /// How well the brain labels them, in the batches of six the app asks:
    ///   cargo test --lib goals::tests::labels -- --ignored --nocapture
    /// Needs the brain downloaded (LOCALAPPDATA decides which one). "Wrongly off" (calling goal work
    /// off-goal) is the mistake that would nag you; "missed off" lets a distraction pass.
    #[test]
    #[ignore]
    fn labels() {
        let local = std::env::var("LOCALAPPDATA").expect("LOCALAPPDATA");
        crate::brain::use_dir(std::path::Path::new(&local).join("com.selfglance.app").join("brain"));
        tauri::async_runtime::block_on(async {
            let t = std::time::Instant::now();
            crate::brain::brain_warm().await.expect("brain starts");
            println!("brain loaded in {:.1}s", t.elapsed().as_secs_f64());
            let (mut right, mut total, mut false_off, mut missed_off, mut secs) = (0, 0, 0, 0, 0.0);
            let mut calls = 0;
            for (goal, cases) in CASES {
                for chunk in cases.chunks(6) {
                    let items: Vec<Item> = chunk.iter().map(|(a, l, _)| Item { app: a.to_string(), label: l.to_string() }).collect();
                    let t = std::time::Instant::now();
                    let got = judge(&[goal.to_string()], &items).await;
                    secs += t.elapsed().as_secs_f64();
                    calls += 1;
                    let got = match got {
                        Ok(g) => g,
                        Err(e) => {
                            println!("✗ call failed: {e}");
                            total += chunk.len();
                            continue;
                        }
                    };
                    for ((app, label, want), have) in chunk.iter().zip(got.iter()) {
                        total += 1;
                        let ok = want == have;
                        right += ok as usize;
                        false_off += (*want != "off" && have == "off") as usize;
                        missed_off += (*want == "off" && have != "off") as usize;
                        println!("{} {:<8} want {:<7} got {:<7} {app} — {label}", if ok { "✓" } else { "✗" }, "", want, have);
                    }
                }
            }
            println!("\n{right} / {total} right · wrongly off {false_off} · missed off {missed_off} · {:.1}s per call over {calls} calls", secs / calls as f64);
        });
    }
}
