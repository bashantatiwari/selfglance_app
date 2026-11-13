# Bond roadmap

Bond is a **companion that keeps you on track**: he knows what you meant to do, sees what you actually do on
this laptop, and speaks up when the two drift apart. Everything runs on your laptop. The scope is fixed on
purpose: make that loop good, then ship it.

## Where Bond is (November 2026)

| Area | State |
|---|---|
| **Own brain**: Qwen3.5-4B on the GPU, no cloud, no keys | Done. Router: 71 of 75 unseen requests right, none harmful. Goal labelling: 31 of 34. Downloads checked against pinned SHA-256; the engine only answers requests carrying a key made at each start. |
| **Talk**: its own instructions, streamed | Done. First sentence about 1 s after the router (0.3–0.4 s) on the RTX 3050. |
| **Drift engine, part 1** | Built, not yet used on real days: judging against About you with no goal needed, the drift nudge, lesson follow-through, end-of-day calls, weekend choice. |
| **Goals**: today, tomorrow, Sunday review | Built |
| **Small jobs**: apps, sites, timers, reminders, files, laptop status | Built. Commands, ending programs and deleting files wait for approval; AI plans can't press Win+R and the like. |
| **Voice**: hold Ctrl+Alt to talk, Kokoro speaking, Parakeet listening | Built. Mishears an accent often; indicators unclear. |
| **Optional, behind Labs**: "Hey Bond", suggestions, learning from you | Built, off by default |
| Removed | Guide mode (pointing at each click), the photo buddy. |

## Next, in order

### 1. Make the loop give something back
- Bond's talk knows your day: today's numbers, plan and open lessons, so "what should I do now?" and "how did
  today go?" answer from facts.
- Today page leads with on-track, off-track and aim time.
- Evening wrap and a Sunday review built on About you, with "lessons watched, lessons used".
- Use it for two weeks and tune the thresholds on real days.

### 2. Voice that hears you
- "Listening" for the whole key press, "Thinking" after it.
- Compare speech models on recordings of real voices; keep the microphone stream open.
- App names matched against installed apps (the "Roblox Studio not found" case).

### 3. Ship-readiness
- Records and settings in files, not the webview, so updates and a second copy never lose them.
- A real content security policy, tested on a running build.
- Hardware tiers: the 2B model on laptops without a 6 GB GPU, text-only.
- First run: About you before anything else; the brain download explained.
- Installer signed, so SmartScreen does not warn. Pick a license.
- Work through `docs/RELEASE-BREAK-PLAN.md` on the installed build.

## Not planned
A click-by-click guide, a custom or photo-made character, the Android companion, a cloud mode, a journal and a
general-purpose agent. They were cut so the core can be good.

## Keep doing every release
- `npm test`, `npx tsc --noEmit`, `cargo test --lib`.
- `cargo test --lib eval::heldout -- --ignored --nocapture` after any prompt or model change (do not tune
  against it). Fail the release if it drops by more than 2 cases or shows anything harmful.
- `cargo test --lib talk_tests::talk_live -- --ignored --nocapture` to time talk on the real brain.
