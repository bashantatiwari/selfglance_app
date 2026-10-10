# SelfGlance

A desktop companion for Windows. Bond, a small animated character, lives on your
screen, reminds you to take water breaks, keeps your notes and reminders, reads
your screen, does things on the computer for you, and talks — all on this laptop
by default, with no cloud account needed.

## Run it

Needs [Node.js](https://nodejs.org) and [Rust](https://rustup.rs).

```powershell
cd app
npm install
npm run tauri dev      # opens the app (first launch downloads Bond's brain and voice)
```

Build an installer with `npm run tauri build`. Pushing a tag like `v0.1.0` builds
installers for Windows, macOS and Linux on GitHub (`.github/workflows/release.yml`).

## Using Bond

| Hotkey | Does |
|---|---|
| `Ctrl+Alt+G` | Summon Bond |
| `Ctrl+Alt+Space` | Ask Bond (type a request) |
| Hold `Ctrl+Alt+V` | Talk to Bond; let go when you're done |

Click Bond for Dance / Jump / Wave, Ask Bond, and the Dashboard (journal, ideas,
reminders, activity, settings). Things to ask:

- **Notes:** `log: finished the voice feature` · `idea: an app that sorts downloads` ·
  `remind me to stretch in 20 minutes` · `what reminders do i have`
- **Computer:** `open downloads` · `open notepad` · `search rust books` ·
  `play lofi on youtube` · `volume 30` · `next track` · `show desktop` ·
  `lock my laptop` · `set wallpaper to dark blue` · `what's using my cpu` ·
  `kill chrome` · `$ ipconfig`
- **Clipboard:** `what's on my clipboard` · `copy hello to clipboard`
- **Memory:** `free up ram` · `what's eating my ram`
- **Files:** `delete my screenshots` (shows thumbnails, asks twice, goes to the Recycle Bin)
- **Screen:** `what am I looking at` · `I'm stuck` · `click the Save button`

Running commands, ending programs and deleting files always ask first.

On his own, Bond brings water breaks, warns about low battery, and suggests things
when you seem stuck or copy an error. Tune or turn these off in Dashboard → Settings.

## How it works

The app is in `app/`, built with [Tauri](https://tauri.app):

- `app/src/` — the interface, in **TypeScript** with React (screens) and Three.js (Bond).
- `app/src-tauri/src/` — the core, in **Rust**: everything that touches Windows.

| Rust module | Job |
|---|---|
| `lib.rs` | Overlay window, hotkeys, tray menu, idle and active-app tracking |
| `brain.rs` | Runs the local model (Qwen3.5-4B via llama.cpp, GPU through Vulkan) |
| `ai.rs` | Sends requests to the local brain, or to Gemini / Claude with your own key |
| `agent.rs` | The actions Bond can take on the computer |
| `screen.rs` | Reads the screen (Windows OCR + UI Automation) and finds controls by name |
| `voice.rs` | Speech in and out (Parakeet and Kokoro via sherpa-onnx) |
| `notice.rs` | Decides when a suggestion is worth making |
| `experience.rs` | Remembers past requests so Bond adapts to you |
| `reminders.rs`, `system.rs` | Reminders; battery, programs, clipboard |

Data stays on the computer in `%LOCALAPPDATA%\com.selfglance.app` (models, notes,
reminders, the learning log). Cloud API keys go in the Windows Credential Manager.

## Roadmap

Where Bond is and what comes next: [ROADMAP.md](ROADMAP.md).

## Tests

```powershell
cd app
npm test                                   # TypeScript
cd src-tauri
cargo test --lib                           # Rust
cargo test --lib eval -- --ignored --nocapture   # local-model accuracy check (slow)
```
