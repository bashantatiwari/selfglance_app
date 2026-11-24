# SelfGlance

**Bond** is a small desktop companion for Windows. In the morning you write what you mean to do today.
During the day he notices when you drift from it, reminds you to stand up and drink water, and does
small jobs on the laptop. Everything runs on your laptop: no account, no cloud.

> Status: finished personal project (v0.2, minimal). Not developed further.

## What it does

| | |
|---|---|
| **Today's list** | Bond asks "What's on today?" once in the morning. Write a few lines (or say "today: make the video, learn LangGraph"). Tick things off in the dashboard. |
| **Drift** | About ten minutes in a row on something not on the list: one line, with *Back to it*, *This counts* (he learns) or *Not now*. At most twice an hour. |
| **End of the day** | Before your laptop day ends (Settings → About you), one line if things are still open. |
| **Breaks** | After about 50 minutes of sitting, he brings water and asks you to stand up. No counting, nothing to set. |
| **Battery** | One line when it runs low. |
| **Ideas** | "idea: …" or "I got an idea, …" is saved **word for word** on the Ideas page. |
| **Timers and reminders** | "start a one minute countdown", "remind me at 5pm to submit the report". |
| **Small jobs** | Open apps, sites and folders ("open my d drive"); browser tabs (new / close / next / reopen); volume and media; laptop status and specs; **find a file by name**; **open a project in Claude Code, VS Code or a terminal** ("open claude code in selfglance"). |
| **Talk** | Ask anything; the answer streams and he speaks as it is written. |
| **Tuck away** | Click Bond → *Tuck away* (or the tray): he leaves and a small head waits in the corner. His cards still show there. Click it to bring him back. |

**Keys:** hold `Ctrl+Alt` and talk ("Listening…" stays up while you hold, "thinking…" until he answers);
tap `Win+Alt` to type; `Ctrl+Alt+G` calls him over.

## What it will not do

Bond can only pick from a fixed menu of small jobs, carried out by plain code (`agent.rs`). The AI never
writes a command, a path to run, or keystrokes. Nothing deletes files, ends programs, runs commands, types,
clicks or reads the screen. Projects open with the folder as the working directory and a fixed program
(`claude`, VS Code, PowerShell or Explorer), so a folder's name can't change what runs.

## How it works

- **Tauri 2** (Rust core, React + TypeScript interface, Three.js for Bond). Windows only.
- **Rules first, AI second.** Clear requests are understood instantly by `assistant/intent.ts`. The rest goes to a
  local **Qwen3.5-4B** (llama.cpp, Vulkan) that answers in strict JSON from a fixed schema: idea, task (from the
  menu) or chat.
- **Drift** is judged from the window in front (app and title) against the open items on today's list: rules
  first (`assistant/goals.ts`), the local brain only labels what the rules can't, once, and remembers it.
- **Voice:** sherpa-onnx with Parakeet (listening) and Kokoro (speaking), loaded once at start and kept.

| `app/src-tauri/src` | Job |
|---|---|
| `lib.rs`, `hotkeys.rs` | Overlay window, tray, keys, idle time and the window in front |
| `brain.rs`, `ai.rs` | The local model server; routing and talk |
| `agent.rs` | The fixed menu of small jobs |
| `goals.rs` | Labels stretches of your day the rules can't judge |
| `voice.rs` | Speech in and out |
| `memory.rs`, `system.rs`, `capture.rs`, `diag.rs`, `egress.rs` | Recent conversation and About you; the laptop; out of screenshots; log; the no-cloud test |

| `app/src` | Job |
|---|---|
| `App.tsx`, `stage/`, `ui/` | The overlay: Bond, his cards, timers |
| `dashboard/` | Today's list, Today, Activity, Ideas, Settings |
| `assistant/` | Command rules, today's list and drift rules, timers, reminders, ideas |
| `break/` | Breaks |

## Privacy

- Nothing leaves the laptop. The internet is used only to download the brain and voice once (each file checked
  against a pinned SHA-256) and to open sites you ask for. `egress.rs` fails the tests if code ever calls an AI service.
- The microphone is open only while you hold `Ctrl+Alt`.
- What is tracked is the window in front (app and title), on this laptop, forgettable item by item. Password
  managers, banking and private windows are never sent to the brain.
- The interface runs under a strict content security policy.

## Run it

Windows 10/11, [Node.js](https://nodejs.org) 22 and [Rust](https://rustup.rs). A GPU with about 6 GB (or 16 GB RAM)
is recommended for the brain.

```powershell
cd app
npm install
npm run tauri dev        # or: npm run tauri build
```

Download the brain (about 3.4 GB) and voice (about 1 GB) from Settings on first run. Fill in Settings → About you,
and check Settings → Bond → Project folders (default `D:\`).

Tests: `npm test`, `npx tsc --noEmit`, and `cargo test --lib` in `app/src-tauri`.

## Acknowledgements

[Tauri](https://tauri.app), [llama.cpp](https://github.com/ggml-org/llama.cpp), the Qwen team,
[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) with NVIDIA's Parakeet, Kokoro, and [Three.js](https://threejs.org).
Bond's robot model is CC0 (Quaternius).
