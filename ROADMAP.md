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
| 5 | **"Hey Bond" + voice match**: wake word, answers only your voice, follow-ups, spoken yes/no | Built 10 Oct; needs testing with your real voice |
| — | **Guide mode, 12 Oct**: "walk me through buying a domain": a virtual cursor points at each next click; you click, Bond re-reads the screen and points again. Logs whether you followed each pick | Built; works on standard apps, accuracy not yet measured |
| — | **Window control and patient listening, 14 Oct**: switch to / minimize apps, bring a minimized app forward, wait out unfinished sentences, "stop" at once | Built; needs more real use |
| — | **Dashboard redesign, 15 Oct**: soft neo-brutalist look in light and dark, bento Today, Activity details, interactive Week, notebook Journal, Privacy panel; "Journal first" evenings | Built |
| — | **Idea workbench, 15 Oct**: stages, stars, action plan, notes, and Bond's Explore / Plan / Saved panel | Built; AI answers need trying with a real brain |

About 12,000 lines: TypeScript (the interface) and Rust (everything that touches Windows).

## Next, in order

### Phase 5: "Hey Bond", and only for you (built 10 Oct)
Bond hears you without a hotkey, the way Siri does, and answers only your voice.
Measured on 8 synthetic voices: wake word caught 21/24 with 0/56 false wakes; voice match
accepted the right voice 13/13 and others 0/97; listening costs 2.2% of one CPU core.
Left to do: try it with your own voice and mic and tune the bar if needed.
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

### Phase 6b: Runs on an ordinary laptop (next)
The local brain wants a GPU with about 6 GB. To reach other laptops:
- Detect the hardware on first run and pick a tier: **Full** (today's model), **Lite** (a much smaller text-only model with shorter instructions, since Bond already reads the screen through OCR and UI Automation), or **Cloud** (your own Gemini key, with a clear note about what is sent).
- Measure first: run the router test on CPU only and on candidate small models, then choose the smallest that scores about the same.
- Keep the platform-specific parts (screen reading, window control) behind clear adapters so a Mac port stays possible.
- Learn from how guide steps went (already logged): rank controls using what you actually click, and offer to replay steps you have done before.

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
