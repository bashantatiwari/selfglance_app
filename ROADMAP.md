# Bond roadmap

Bond is a **guide**: he reads your screen, shows you the next click, and helps with what the job leaves
behind. Everything runs on your laptop. The scope is fixed on purpose: improve the guidance, do not add
features.

## Where Bond is (October 2026)

| Area | State |
|---|---|
| **Own brain**: Qwen3.5-4B on the GPU, no cloud, no keys | Done. Router: 71 of 75 unseen requests right, none harmful. Goal labelling: 31 of 34. |
| **Sees the screen**: Windows OCR + UI Automation | Done |
| **Guide mode**: a virtual cursor points at each next click, notices when the page or tab changed, moves text between apps through Copy and Ctrl+V | Built. Not yet measured at scale. |
| **Remembers the job**: what he guided you through, kept for 6 hours, so "now write the bio for it" works. One question when a fact is missing. | Built |
| **Voice**: hold Ctrl+Alt to talk (no cut-off), tap Win+Alt to type, Kokoro speaking, Parakeet listening | Built. Voice warm-up added; needs real-use timing. |
| **Goals**: today, tomorrow, drift nudge, "an hour in and nothing started", Sunday summary | Built |
| **Water breaks, reminders, specs, battery** | Built. Water-break timer now logs why it did or did not fire. |
| **Dashboard**: Today, Activity (forget any item), Plan (your items and Bond's fitted into one day), Ideas, Settings (Memory: what he keeps, empty it) | Built |
| **Optional, behind Labs**: "Hey Bond" wake word and voice match, suggestions, learning from you | Built, off by default |

## Next, in order

### 1. Make guide mode fast and trustworthy (the one thing that matters)
- Measure it: log per step the time, the control picked, and whether you followed it; aim for 8 of 10 steps
  followed the pick on the apps you really use.
- Cut the time per step. The vision call (3 to 6 seconds) is the cost. Options: a smaller screenshot, only
  the active window, skipping the image when the control list is enough. Decide with numbers.
- Skills: short recipes for common jobs in common apps (create a YouTube channel, record in OBS, buy a
  domain), retrieved by app and goal, so a small model follows a recipe instead of working it out. Written by
  hand, shipped with the app, checked against the same step-follow numbers.

### 2. Runs on an ordinary laptop
The brain wants a GPU with about 6 GB.
- Detect the hardware on first run and pick a tier: **Full** (today), **Standard** (2B), **Lite** (smaller,
  text-first). Below the floor, say so honestly.
- Measure on CPU-only before choosing the smallest model that scores about the same.

### 3. Ship-readiness
- Installer signed, so SmartScreen does not warn.
- A real content security policy, tested on a running build.
- Pick a license.

## Not planned
The Android companion, a cloud mode, a journal, weekly reports and a general-purpose agent that clicks for
you. They were cut so the guidance can be good.

## Keep doing every release
- `npm test`, `npx tsc --noEmit`, `cargo test --lib`.
- `cargo test --lib eval::heldout -- --ignored --nocapture` after any prompt or model change (do not tune
  against it). Fail the release if it drops by more than 2 cases or shows anything harmful.
- Work through `docs/RELEASE-BREAK-PLAN.md` on the installed build.
