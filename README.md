# SelfGlance

A friendly desktop companion for Windows that helps you stick to what you planned for the day.

Each morning you write a short to-do list. Bond, a small character on your screen, notices when
you drift away from it, reminds you to take breaks and drink water, and handles small tasks for
you. Everything runs on your own laptop: no account, no cloud, no data sent anywhere.

## Features

- **Today's list**: plan your day as a simple to-do list and tick things off.
- **Drift alerts**: a short nudge when you've spent a while on something that isn't on your list.
- **Break reminders**: a prompt to stand up and drink water after long stretches at the laptop.
- **Talk or type**: hold `Ctrl+Alt` and speak, or press `Win+Alt` to type.
- **Quick actions**: timers, reminders, saving ideas, opening apps, websites, folders and projects, and finding files.
- **Private**: the AI, speech recognition and all your data stay on your computer.

## Requirements

- Windows 10 or 11 (64-bit)
- 16 GB RAM; a graphics card with about 6 GB of memory is recommended for fast answers
- About 5 GB of free disk space
- A microphone (optional, for talking to Bond)

## Install

1. Download `SelfGlance_x64-setup.exe` from the [latest release](../../releases/latest).
2. Run it. If Windows shows "Windows protected your PC", click **More info → Run anyway**
   (the app isn't code-signed).
3. Bond appears on your screen, and SelfGlance starts with Windows from then on.

## First-time setup

1. Right-click Bond (or the SelfGlance icon in the system tray) and open the **Dashboard**.
2. **Settings → Bond's brain → Download** (about 3.4 GB, one time).
3. **Settings → Voice → Download** (about 1 GB, one time).
4. **Settings → About you**: tell Bond a little about yourself and your goals.
5. **Settings → Bond → Project folders**: where you keep your projects, so you can say
   "open my portfolio project in VS Code".

## Using Bond

| Do this | Say or type |
|---|---|
| Plan the day | `today: finish the report, go to the gym, learn Python` |
| Save an idea | `idea: an app that sorts my downloads` |
| Start a timer | `start a 25 minute timer` |
| Set a reminder | `remind me at 5pm to call mom` |
| Open things | `open spotify` · `open downloads` · `search for standing desks` |
| Find a file | `is there a file called resume` |
| Hide Bond | Right-click him → **Tuck away**; click the small head in the corner to bring him back |

## Uninstall

Windows **Settings → Apps → Installed apps → SelfGlance → Uninstall**.

## Build from source

Requires Node.js 22 and Rust.

```powershell
cd app
npm install
npm run tauri dev      # run in development
npm run tauri build    # build the installer
```

Run the tests with `npm test` in `app` and `cargo test --lib` in `app/src-tauri`.
