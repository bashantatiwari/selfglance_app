# Bond v0.1: what to test

Tick a box when it works. If something doesn't, write what happened next to it (for a bug, also copy the last
lines of `%APPDATA%\com.selfglance.app\logs\bond.log`).

**Before you start:** quit the installed Bond from the tray, close heavy apps, then run `npm run tauri dev` from
`D:\SelfGlance\app` in your own PowerShell window. Settings are saved per copy, so in the dev copy turn on
Settings → Voice → "Hey Bond" first.

---

## 1. Time tracking (the one to check first)

Bond measures every 2 seconds which window is in front and how long since you last touched the keyboard or mouse.
Time counts only while Bond is running and you have used the keyboard or mouse in the last 2 minutes (or a video is playing).

- [ ] **Stopwatch test.** Open Notepad. Type for 3 minutes, don't touch anything for 1 minute, type for 1 more. Today → Top of the day should show about 4 to 5 minutes for Notepad (the idle minute is not counted).
- [ ] **Idle test.** Leave the laptop untouched for 4 minutes with Notepad in front. Nothing should be added for those minutes.
- [ ] **30-minute test.** Use the laptop normally for 30 minutes with a phone stopwatch (running only while you are at the laptop). Compare with the change in Today's total.
- [ ] **Window changes.** Switch between 3 apps. Activity shows each one, with the right name and kind (App, Site, Video, Project).
- [ ] **Bond not running = nothing recorded.** Quit Bond for 5 minutes and start him again. Those 5 minutes are missing, and that is expected.
- [ ] **Which copy.** The dev copy and the installed copy keep separate records. Check that the number you look at is from the copy you used.

## 2. Talking to Bond

- [ ] Hold `Ctrl+Alt+V`, say "what time is it", release. He answers out loud.
- [ ] Say "Hey Bond" alone. He says "Yes?" and listens about 10 seconds.
- [ ] Say "Hey Bond, open Notepad" in one breath.
- [ ] Say a request with a pause in the middle ("Hey Bond, open … Notepad"). He waits for you to finish.
- [ ] After he answers, say a follow-up without "Hey Bond" within about 12 seconds.
- [ ] Someone else's voice, or a YouTube video, does not wake him (voice match on).
- [ ] While he is working, say "stop". He goes quiet and stops.
- [ ] "Teach him my voice" (Settings → Voice) completes and he still recognises you afterwards.

## 3. Things he does on the computer

- [ ] Open an app by name ("open spotify"). If it is already open, it comes to the front.
- [ ] "Switch to OBS" with OBS minimized: it is restored and in front.
- [ ] "Minimize the terminal".
- [ ] "Close notepad" with unsaved text: he asks (Don't save / Save / Cancel) and does the one you pick.
- [ ] "Volume 30", "next track", "mute".
- [ ] "Open downloads" opens the folder.
- [ ] "Search for rust tutorials" opens a web search.
- [ ] "What's on my clipboard", "copy hello to clipboard".
- [ ] "How's my battery", "why is my laptop slow", "free up RAM".
- [ ] `$ ipconfig` shows the command first and runs only after you say yes.
- [ ] "Delete my screenshots": shows thumbnails, asks twice, goes to the Recycle Bin.

## 4. Seeing the screen

- [ ] "What am I looking at" explains the window in front.
- [ ] "I'm stuck" with an error on screen: he reads it and suggests a fix.
- [ ] "Click the Save button" in Notepad's save dialog.
- [ ] He never reads a password field.

## 5. Guide mode

- [ ] "Walk me through saving this file" (Notepad): File → Save as → file name box → Save → "done".
- [ ] A real task: "walk me through buying a domain" on a registrar page (stop before paying).
- [ ] "Help me record my screen using OBS Studio" with OBS minimized: OBS comes to the front, then the cursor starts.
- [ ] He never clicks or types for you.
- [ ] He stops when the goal is done and does not start over.
- [ ] Settings → Bond → "Guide mode: show what he picked": outlines match what he was shown. Note each step he gets wrong.
- [ ] After a session, `bond.log` ends with a line like "guide: … N of M steps followed his pick". Write down the ratio.

## 6. Bond by himself

- [ ] **Bond stays out of screenshots.** Take a screenshot with Win+Shift+S, Print Screen and Snipping Tool. Bond is on screen but not in the picture.
- [ ] Say "Hey Bond, include yourself in the screenshot", or use the tray item "Show Bond in screenshots (5 min)". Take a screenshot: he is in it. After 5 minutes (or "Hide Bond from screenshots again") he is out again.
- [ ] Settings → Bond → "Keep Bond out of screenshots and recordings" off: he always appears in captures; the tray item is greyed out.
- [ ] Water break after the set minutes of use; the bottle, drinking, "Later".
- [ ] Battery warning at 15% (unplugged).
- [ ] Suggestions (Settings → Suggestions): he offers a habit or a tip at a pause, and 👎 stops that one.
- [ ] He stays faint while you code, sits with you during a video, leaves during a meeting or game.

## 7. Journal, ideas, reminders

- [ ] Journal: write, close the window, reopen. It is saved. The streak and word count look right.
- [ ] "Log: finished testing" adds a timestamped line.
- [ ] "Journal first" (Settings → Bond): from your chosen hour, he asks once; start a video and he asks again; "Not tonight" silences the day; 20 words (including dictated ones) end it.
- [ ] Ideas: add one by typing and one by voice ("idea: …"). Both appear.
- [ ] Idea card: change stage, star it, edit it (does not open the workbench), delete it and Undo.
- [ ] Workbench: add steps, tick one, write notes, reopen later. Everything is still there.
- [ ] Bond panel: Explore ("Is it feasible?") answers with your chosen brain. Save an answer as a finding. Plan ("Next steps") suggests tasks and adds only the ones you tick.
- [ ] Reminders: "remind me in 2 minutes to stretch". It fires, even with the dashboard closed. Snooze works.

## 8. Dashboard and settings

- [ ] Light / dark / system theme, and the sidebar theme button.
- [ ] Today, Activity (details panel), Week (click a day) show sensible numbers.
- [ ] Settings → Privacy shows what is true (microphone state, brain, screen reading).
- [ ] Changing a setting and restarting keeps it.
- [ ] Bond steps aside while the dashboard is focused and comes back when you leave.

## 8b. Nothing leaves the laptop

- [ ] Settings → Bond's brain: no provider choice and no API key box, only the brain download or "✓ on this laptop".
- [ ] Settings → Privacy says answers stay on this laptop and lists no API keys.
- [ ] **Wi-Fi off test.** Turn Wi-Fi off. "What time is it", "open notepad", "what am I looking at", a guide-mode walk-through and the Ask box all still work.
- [ ] Voice: "Bond's own" and "Windows voice" are the only choices. With "Windows voice", he never uses an "Online" voice.
- [ ] In `bond.log`, after the first start of this version, a line "deleted a saved API key" appears only if an old key existed.

## 9. Speed and weight (for "faster and lighter")

Note these once with nothing else running:

- [ ] Time from asking a first question after startup to the answer: ______ s (a cold brain load is the slow part).
- [ ] Time for a second question: ______ s.
- [ ] Memory used by Bond (Task Manager → Details → `selfglance.exe`, `llama-server.exe`): ______ MB / ______ MB.
- [ ] GPU memory used while the brain is loaded: ______ MB.
- [ ] Laptop gets noticeably hot or loud with "Hey Bond" on? yes / no.
