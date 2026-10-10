# Bond roadmap

The goal: Bond is a working partner that runs the computer for you, like Jarvis. He
understands what you say, sees the screen, acts on it safely, remembers you, and keeps
you on track on the laptop and the phone. The character is how he shows up, not the point.

Each phase ends with something you can use every day. A phase is done when it works on
this laptop with your own voice and habits, not only in tests.

## Where Bond is (October 2026)

| | Phase | State |
|---|---|---|
| 1 | **Own brain**: Qwen3.5-4B on the GPU, no cloud needed; learns from your requests | Done |
| 2 | **Sees the screen**: Windows OCR + UI Automation; clicks buttons by name | Done |
| 3 | **Voice**: Kokoro (speaking) + Parakeet (listening); hold Ctrl+Alt+V | Done, untested with your voice |
| 4 | **Speaks up on his own**: stuck, copied errors, habits; quiet hours | Done; tip wording sometimes off |
| — | **Fixes, 10 Oct**: screenshots delete with previews, journal saved as files + evening reminder, "free up RAM", voice models unload when idle | Done |

About 12,000 lines: TypeScript (the interface) and Rust (everything that touches Windows).

## Next, in order

### Phase 5: "Hey Bond", and only for you
Bond hears you without a hotkey, the way Siri does, and answers only your voice.
- A small wake-word model listens all the time for "Hey Bond" (sherpa-onnx keyword
  spotting: a few MB, a few % of one CPU core). Nothing is recorded or saved.
- **Voice match**: you say "Hey Bond" 5 times once to enroll. After that, a speaker model
  checks each wake-up against your voiceprint and ignores other people, YouTube and calls.
- A setting to turn it off, plus a visible "listening" indicator while the mic is open.
- Done when it wakes for you 9 times in 10 and almost never for someone else.

### Phase 6: Jarvis-level control
Bond becomes a real operator, not a list of fixed commands.
- **Multi-step tasks**: look → act → check the screen → continue until the goal is met, or
  stop and ask ("book the 3pm slot", "fill this form from my CV").
- **Windows**: switch to, snap, move, maximise and close windows by name.
- **Files**: move, rename, sort ("tidy my downloads by type"), zip, find duplicates. Always
  shows previews first, and every change can be undone.
- **Settings as direct actions**: Wi-Fi, Bluetooth, brightness, night light, do-not-disturb,
  default apps.
- **Routines**: "work mode" opens your tools, mutes notifications and closes distractions;
  "end the day" saves the journal and shuts things down.
- **Undo log**: everything Bond did, with "undo that".
- Rule that stays: anything destructive (deleting, killing, commands) shows exactly what
  will happen and waits for your yes.

### Phase 7: Remembers you
- Long-term memory: facts you tell him, projects, people and preferences, found by meaning
  (embeddings) and used in answers.
- Fine-tune the brain (LoRA) on your request log once it has a few weeks of real use.
- Daily and weekly summaries built from the journal and activity.

### Phase 8: A dashboard worth opening
- Redesign around one question: "how did my day go, and what's next?"
- Today: focus time, top apps, reminders, journal status, Bond's suggestions.
- Journal with search, mood, and Bond's own day log beside your writing.

### Phase 9: Bond on the phone (anti-doomscrolling)
- An **Android** app: Bond floats over other apps when you've scrolled Instagram, YouTube
  Shorts or TikTok too long, and nudges you to stop. He then blocks the app for a while,
  if you allow that.
- Needs Android's usage-access and accessibility permissions, so it's a separate native app.
- Syncs with the laptop: reminders, the journal, one "screen time today" across both devices.
- iPhone is much more locked down. Apple only allows this through Screen Time, which needs
  a special entitlement, so iPhone comes after Android, if at all.

## Version 1.0, so this doesn't run forever

v1.0 = Phases 1–6, plus an installer you'd give a friend. After that, new work only starts
when daily use shows a real need. Phone (Phase 9) is v2.

## Keep doing every phase
- Rebuild and reinstall after each phase; the installed copy is what starts with Windows.
- `npm test` and `cargo test --lib`; `cargo test --lib eval -- --ignored --nocapture` after
  any prompt or model change.
