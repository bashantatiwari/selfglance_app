// The overlay: a full-screen transparent window holding the 3D character.
// No panels, no text — the character's actions carry the message:
//
//   Break    every ~45 min of active use he web-drops in carrying a water bottle and
//            holds it out to you. Step away and he knows; come back and he cheers.
//            Or click the bottle to drink, and he does a stretch dance with you.
//   Play     Ctrl+Alt+G (Cmd+Option+G) drops him at your cursor. Throw him around,
//            poke him, or right-click him for actions: sit, dance, jump, wave,
//            follow my cursor, open the dashboard ("Later" too, during a break).
//   Ask      Ctrl+Alt+Space (or the menu): one box for everything. Bond works out what you
//            mean: log your day, save an idea, do something on the desktop (open apps,
//            sites, folders, media keys, or click/type on screen), explain your screen,
//            or help when you're stuck. Clear commands are handled locally; the rest
//            goes to the AI. Typing goes straight back to your app once you press Enter.
//   Nudge    long stretches of chatting with AI / note-taking without building → "Time to build!"
//   Diary    what you do all day (watching / working / browsing, and on what) is
//            recorded locally for the dashboard.
//   Life     he follows what you're doing: sits and watches videos with you (facing
//            you, turned toward the video), stays faint while you code, leaves during
//            meetings and games, dozes off when you're away and waves when you return.
//   Ghost    the rest of the time he stands still and faint so he never blocks you.

import { useEffect, useRef, useState } from "react";
import { CharacterStage } from "./stage/CharacterStage";
import type { ClipName, Rect } from "./stage/types";
import { BreakCoach, type BreakPhase } from "./break/BreakCoach";
import { classify, type Activity, type Context } from "./companion/context";
import { cursorPosition, inTauri, onTauriEvent, sendHitRegions } from "./platform";
import { invoke } from "@tauri-apps/api/core";
import { Tracker } from "./companion/tracker";
import { loadSettings, type Settings } from "./settings";
import { ActionMenu, ARC, arcBox, type ActionId } from "./ui/ActionMenu";
import { AnswerCard, AskBox, type AskState } from "./ui/Ask";
import { releaseFocus, routeCommand, runActions, screenAsk, speak, stopSpeaking } from "./ai";
import { understand, type ScreenMode } from "./assistant/intent";
import { addIdea, logToJournal } from "./assistant/notes";
import "./overlay.css";

const TOUCH_AWAKE_MS = 6_000; // fully visible this long after you last touched him, then he fades
const MANUAL_HOLD_MS = 3 * 60_000; // something you asked for overrides automatic behaviour this long
const FOLLOW_MS = 30_000;
const MENU_OPEN_MS = 8_000;
const AWAY_AFTER_SEC = 120;
const BRAINSTORM_WINDOW_MS = 30 * 60_000; // look back this far
const BRAINSTORM_CHAT_MS = 20 * 60_000; // this much chatting / note-taking in the window...
const BRAINSTORM_BUILD_MS = 2 * 60_000; // ...with less than this in an editor or terminal
const BRAINSTORM_COOLDOWN_MS = 45 * 60_000;
const CHATTY = /\b(chatgpt|claude|gemini|perplexity|copilot|deepseek|grok|notion|obsidian|onenote|google keep)\b/i;
const POKE_REACTIONS: ClipName[] = ["wave", "nod", "celebrate", "hang"];

const store = {
  get(key: string) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* not persisted */
    }
  },
};

async function loadCharacter() {
  const index: { default: string; characters: string[] } = await (await fetch("/characters/index.json")).json();
  const saved = store.get("selfglance.character");
  const id = saved && index.characters.includes(saved) ? saved : index.default;
  const base = `/characters/${id}`;
  return { base, manifest: await (await fetch(`${base}/character.json`)).json() };
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hitRef = useRef<HTMLDivElement>(null);
  const bottleHitRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<CharacterStage | null>(null);
  const coachRef = useRef<BreakCoach | null>(null);
  const drag = useRef<{ startX: number; startY: number; active: boolean; samples: { x: number; y: number; t: number }[] } | null>(null);
  const pokes = useRef<number[]>([]);
  const ctxRef = useRef<Context>("other");
  const activityRef = useRef<Activity | null>(null);
  const settingsRef = useRef<Settings>(loadSettings());
  const idleRef = useRef(0);
  const hiddenByCtx = useRef(false);
  const playUntilRef = useRef(0);
  const manualUntil = useRef(0);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTimer = useRef<number | undefined>(undefined);
  const heyRef = useRef<HTMLDivElement>(null);
  const heyTimer = useRef<number | undefined>(undefined);
  const askBoxRef = useRef<HTMLDivElement>(null);
  const askCardRef = useRef<HTMLDivElement>(null);
  const askTimer = useRef<number | undefined>(undefined);
  const brainLog = useRef<{ t: number; chat: boolean; build: boolean }[]>([]);
  const lastBrainAlert = useRef(0);

  const [phase, setPhase] = useState<BreakPhase>("idle");
  const [hover, setHover] = useState(false);
  const [busy, setBusy] = useState(true); // entering / dragging / flying
  const [touched, setTouched] = useState(false);
  const touchTimer = useRef<number | undefined>(undefined);
  const [ctx, setCtx] = useState<Context>("other");
  const [menu, setMenu] = useState(false);
  const [following, setFollowing] = useState(false);
  const [pop, setPop] = useState<{ text: string; n: number; note: boolean } | null>(null); // "Hey!" etc. beside his head
  const [ask, setAsk] = useState<AskState | null>(null);
  const askRef = useRef<AskState | null>(null);
  askRef.current = ask;

  const homeX = () => {
    const saved = Number(store.get("selfglance.homeX"));
    const w = stageRef.current?.width ?? window.innerWidth;
    return saved > 0 && saved < w ? saved : w - 160;
  };

  /** A word popping up beside his head ("Hey!", "Time to build!"). */
  const showPop = (text: string, ms = 1600, note = false) => {
    setPop((p) => ({ text, n: (p?.n ?? 0) + 1, note }));
    clearTimeout(heyTimer.current);
    heyTimer.current = window.setTimeout(() => setPop(null), ms);
  };

  /** Stay fully visible for `ms`, then fade back (a real timer, so it always fades). */
  const wake = (ms = TOUCH_AWAKE_MS) => {
    playUntilRef.current = Date.now() + ms;
    setTouched(true);
    clearTimeout(touchTimer.current);
    touchTimer.current = window.setTimeout(() => setTouched(false), ms);
  };

  // --- Mount ------------------------------------------------------------------------------
  useEffect(() => {
    let disposed = false;
    const stage = new CharacterStage(canvasRef.current!);
    stageRef.current = stage;
    stage.onClip = (name) => {
      if (name === "wave") showPop("Hey!");
    };

    // Every frame: glue the hit targets to the character and bottle, and tell Rust
    // which rectangles should catch the mouse (everything else stays click-through).
    stage.onFrame = (rect) => {
      const regions: Rect[] = [];
      const place = (el: HTMLElement | null, r: Rect | null) => {
        if (!el) return;
        el.style.display = r ? "block" : "none";
        if (r) Object.assign(el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
      };
      place(hitRef.current, rect);
      const bottle = stage.bottleRect();
      place(bottleHitRef.current, bottle);

      if (drag.current?.active) regions.push({ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight });
      else {
        if (rect) regions.push(rect);
        if (bottle) regions.push(bottle);
      }
      const hy = heyRef.current;
      if (hy && rect) {
        // Beside his head, on the side with more room.
        const right = rect.x + rect.w / 2 < window.innerWidth - 120;
        const x = right ? rect.x + rect.w * 0.85 : rect.x + rect.w * 0.15 - hy.offsetWidth;
        hy.style.transform = `translate(${x}px, ${rect.y - 6}px)`;
      }
      const m = menuRef.current;
      if (m && rect) {
        // The arc's centre sits on his head; slide it inward if he's near a screen edge.
        const { w, h } = arcBox();
        const headX = rect.x + rect.w / 2;
        const headY = rect.y + 22;
        const left = Math.min(Math.max(4, headX - w / 2), window.innerWidth - w - 4);
        const top = Math.max(4, headY - (h - ARC.pad));
        m.style.transform = `translate(${left}px, ${top}px)`;
        regions.push({ x: left, y: top, w, h });
      }
      for (const el of [askBoxRef.current, askCardRef.current]) {
        if (!el || !rect) continue;
        // Above his head when there's room, otherwise beside him.
        const w = el.offsetWidth;
        const hh = el.offsetHeight;
        let left = rect.x + rect.w / 2 - w / 2;
        let top = rect.y - hh - 14;
        if (top < 8) {
          top = Math.min(window.innerHeight - hh - 8, rect.y + 10);
          left = rect.x + rect.w / 2 > window.innerWidth / 2 ? rect.x - w - 14 : rect.x + rect.w + 14;
        }
        left = Math.min(Math.max(8, left), window.innerWidth - w - 8);
        el.style.transform = `translate(${left}px, ${top}px)`;
        regions.push({ x: left, y: top, w, h: hh });
      }
      sendHitRegions(regions);
    };

    const coach = new BreakCoach({
      async start() {
        setPhase("arriving");
        setBusy(true);
        await stage.webClimb();
        stage.holdBottle();
        await stage.webDrop(homeX());
        setBusy(false);
        window.setTimeout(() => {
          stage.offerBottle(true);
          coach.arrived();
          setPhase("offering");
        }, 900);
      },
      settle() {
        setPhase("waiting");
        stage.offerBottle(false);
        stage.setSitting(true);
      },
      nudge() {
        stage.offerBottle(true);
        stage.play("wave", true);
        window.setTimeout(() => stage.offerBottle(false), 15_000);
      },
      away() {
        setPhase("away");
        stage.offerBottle(false);
        stage.setSitting(true);
      },
      async complete(how) {
        setPhase("idle");
        stage.setSitting(false);
        await stage.drinkBottle();
        stage.play("celebrate", true);
        // Drank at the desk: he leads a quick stretch so the break still gets one.
        if (how === "drank") window.setTimeout(() => stage.play("dance", true), 1600);
      },
    }, () => {
      const c = ctxRef.current;
      return c === "meeting" || c === "game" || hiddenByCtx.current ? "hard" : c === "watching" ? "soft" : null;
    });

    // Brainstorm loop: lots of chatting with AI / note-taking, almost no building → nudge.
    const checkBrainstorm = (active: boolean) => {
      const now = Date.now();
      const a = activityRef.current;
      const focus = ctxRef.current === "focus";
      const chat = active && !focus && !!a && CHATTY.test(`${a.title} ${a.name}`);
      const build = active && focus;
      const log = brainLog.current;
      log.push({ t: now, chat, build });
      while (log.length && now - log[0].t > BRAINSTORM_WINDOW_MS) log.shift();
      if (!settingsRef.current.brainstormAlert || coach.inBreak || stage.busy) return;
      if (now - lastBrainAlert.current < BRAINSTORM_COOLDOWN_MS) return;
      const tick = 2000;
      const chatMs = log.filter((e) => e.chat).length * tick;
      const buildMs = log.filter((e) => e.build).length * tick;
      if (chatMs >= BRAINSTORM_CHAT_MS && buildMs < BRAINSTORM_BUILD_MS) {
        lastBrainAlert.current = now;
        wake(8000);
        stage.setPose("stand");
        stage.play("determined", true);
        showPop("Time to build!", 3500);
      }
    };

    // Fit his behaviour to what you're doing. Runs on every activity change and idle tick;
    // only acts when something should change.
    let behaving = false;
    let demoRunning = false;
    const behave = async () => {
      if (behaving || stage.busy || Date.now() < playUntilRef.current || Date.now() < manualUntil.current) return;
      const c = ctxRef.current;
      const hard = c === "meeting" || c === "game";
      behaving = true;
      try {
        if (hard) {
          if (coach.inBreak) {
            coach.cancel(); // the break comes back after the meeting
            stage.dropBottle();
            setPhase("idle");
          }
          if (stage.visible) {
            hiddenByCtx.current = true;
            await stage.webClimb();
          }
          return;
        }
        if (hiddenByCtx.current) {
          hiddenByCtx.current = false;
          await stage.webDrop(homeX());
          return;
        }
        if (coach.inBreak) return; // the break scene owns his pose
        const away = c !== "watching" && idleRef.current >= AWAY_AFTER_SEC;
        const want = away ? "sleep" : c === "watching" ? "watch" : "stand";
        const was = stage.currentPose;
        if (want === was) return;
        stage.setPose(want);
        if (was === "sleep" && want !== "sleep") stage.play("wave", true); // welcome back
      } finally {
        behaving = false;
      }
    };
    coachRef.current = coach;
    const applySettings = (st: Settings) => {
      settingsRef.current = st;
      coach.configure({ everyMin: st.breakEveryMin, enabled: st.breaksOn });
    };
    applySettings(settingsRef.current);
    const tracker = new Tracker();

    (async () => {
      const { base, manifest } = await loadCharacter();
      await stage.load(base, manifest);
      if (disposed) return;
      await stage.webDrop(homeX());
      setBusy(false);
    })().catch((err) => {
      console.error("Failed to load character", err);
      setBusy(false);
    });

    // Without Tauri (plain browser preview) there is no idle signal: assume active use.
    const fakeIdle = inTauri ? undefined : window.setInterval(() => coach.onIdle(0), 2000);

    const unlisten = [
      onTauriEvent<Settings>("settings-changed", applySettings),
      onTauriEvent<null>("ask-open", () => openAsk()),
      onTauriEvent<number>("idle", (sec) => {
        idleRef.current = sec;
        const watching = ctxRef.current === "watching";
        tracker.tick(activityRef.current, ctxRef.current, watching || sec < AWAY_AFTER_SEC);
        checkBrainstorm(sec < AWAY_AFTER_SEC);
        // Watching a video is screen time even with no keyboard/mouse input.
        coach.onIdle(ctxRef.current === "watching" ? 0 : sec);
        void behave();
      }),
      onTauriEvent<Activity>("activity", (a) => {
        activityRef.current = a;
        const c = classify(a);
        if (c === ctxRef.current) return;
        ctxRef.current = c;
        setCtx(c);
        void behave();
      }),
      onTauriEvent<null>("break-now", () => coach.startNow()),
      onTauriEvent<number>("snooze", (min) => {
        const wasInBreak = coach.inBreak;
        coach.snooze(min);
        setPhase("idle");
        if (wasInBreak) {
          stage.dropBottle();
          stage.setSitting(false);
        }
      }),
      onTauriEvent<null>("demo", async () => {
        // A guided tour of everything he does, start to finish (~35 s).
        if (demoRunning || coach.inBreak) return;
        demoRunning = true;
        wake(60_000);
        setBusy(true);
        const pause = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
        const w = stage.width;
        const home = homeX();
        try {
          await stage.webClimb();
          await stage.webDrop(w * 0.55); // 1. arrives on his thread and waves
          await pause(1800);
          await stage.walkTo(w * 0.68); // 2. walks along the taskbar
          stage.setPose("watch"); // 3. sits facing the screen: watching a video with you
          await pause(4000);
          stage.setPose("sleep"); // 4. you went away: he dozes off
          await pause(4000);
          stage.setPose("stand"); // 5. you're back: wakes up and waves
          stage.play("wave", true);
          await pause(2200);
          stage.holdBottle(); // 6. break time: brings water and holds it out
          await pause(900);
          stage.offerBottle(true);
          await pause(4000);
          await stage.drinkBottle(); // 7. you drank: thumbs up, then a stretch dance
          stage.play("celebrate", true);
          await pause(1800);
          stage.play("dance", true);
          await pause(4500);
          stage.play("annoyed", true); // 8. poked too much: grumpy
          await pause(2000);
          await stage.walkTo(home); // 9. back to his spot
        } finally {
          demoRunning = false;
          setBusy(false);
          wake();
        }
      }),
      onTauriEvent<number | null>("summon", async (x) => {
        wake();
        if (coach.inBreak || stage.busy) {
          stage.play("wave", true);
          return;
        }
        setBusy(true);
        await stage.webClimb();
        await stage.webDrop(x ?? homeX());
        store.set("selfglance.homeX", String(Math.round(stage.x)));
        setBusy(false);
      }),
    ];

    return () => {
      disposed = true;
      clearInterval(fakeIdle);
      stage.dispose();
      unlisten.forEach((p) => p.then((u) => u()));
    };
  }, []);

  useEffect(() => stageRef.current?.setHighlight(hover), [hover]);

  // --- Ask Bond ----------------------------------------------------------------------------
  function openAsk() {
    setMenu(false);
    clearTimeout(askTimer.current);
    manualUntil.current = Date.now() + MANUAL_HOLD_MS;
    wake(60_000);
    setAsk({ step: "input" });
  }

  const closeAsk = async () => {
    clearTimeout(askTimer.current);
    const wasTyping = askRef.current?.step === "input";
    setAsk(null);
    stopSpeaking();
    wake();
    if (wasTyping) await releaseFocus();
  };

  // Clicking anywhere else closes an empty-handed ask box (it never lingers).
  useEffect(() => {
    if (ask?.step !== "input") return;
    const onBlur = () => {
      if (askRef.current?.step === "input") void closeAsk();
    };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [ask?.step]);

  /** Close a card by itself after the time set in Settings. */
  const autoClose = () => {
    const ms = Math.max(4, settingsRef.current.answerSeconds) * 1000;
    manualUntil.current = Date.now() + ms;
    clearTimeout(askTimer.current);
    askTimer.current = window.setTimeout(() => void closeAsk(), ms);
  };

  /** An answer worth reading: shown in the card (and spoken if that's on). */
  const answer = (question: string, text: string, done: string[], say: boolean) => {
    setAsk({ step: "answer", question, answer: text, done });
    if (say && settingsRef.current.speakAnswers && text) speak(text);
    stageRef.current?.play("nod", true);
    autoClose();
  };

  /** Something done or saved: a short note beside his head, no card to dismiss. */
  const confirm = (text: string) => {
    clearTimeout(askTimer.current);
    setAsk(null);
    wake();
    stageRef.current?.play("nod", true);
    showPop(text.length > 60 ? `${text.slice(0, 57)}…` : text, 2800, true);
  };

  const lookAtScreen = async (question: string, mode: ScreenMode) => {
    setAsk({ step: "thinking", question, looking: true });
    const res = await screenAsk(question, mode);
    if (mode === "task" && !res.answer && res.done.length) return confirm(res.done.join(" · "));
    answer(question, res.answer, res.done, mode !== "task");
  };

  const doAsk = async (question: string) => {
    setAsk({ step: "thinking", question, looking: false });
    // Typing goes back to the app you were in, and the box is gone before any screenshot.
    await releaseFocus();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    try {
      // 1. Bond's own understanding: instant, no AI call.
      const own = understand(question);
      if (own?.kind === "log") {
        logToJournal(own.text);
        return confirm("Logged in your journal ✓");
      }
      if (own?.kind === "idea") {
        addIdea(own.text);
        return confirm("Idea saved ✓");
      }
      if (own?.kind === "do") {
        try {
          return confirm((await runActions(own.actions)).join(" · ") || "Done ✓");
        } catch {
          /* e.g. no app by that name: let the AI work out what was meant */
        }
      }
      if (own?.kind === "screen") return await lookAtScreen(question, own.mode);

      // 2. Not sure: the AI classifies it (text only), and runs simple tasks right away.
      const r = await routeCommand(question);
      switch (r.intent) {
        case "log":
          logToJournal(r.text || question);
          return confirm("Logged in your journal ✓");
        case "idea":
          addIdea(r.text || question);
          return confirm("Idea saved ✓");
        case "screen":
          return await lookAtScreen(question, "explain");
        case "help":
          return await lookAtScreen(question, "help");
        case "task":
          if (r.needs_screen) return await lookAtScreen(question, "task");
          return confirm(r.done.join(" · ") || r.reply || "Done ✓");
        default:
          return answer(question, r.reply, [], true);
      }
    } catch (e) {
      setAsk({ step: "error", question, error: String(e) });
      stageRef.current?.play("annoyed", true);
      autoClose();
    }
  };

  // --- Right-click actions ----------------------------------------------------------------
  const openMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    wake(MENU_OPEN_MS);
    setMenu(true);
    clearTimeout(menuTimer.current);
    menuTimer.current = window.setTimeout(() => setMenu(false), MENU_OPEN_MS);
  };

  const act = (id: ActionId) => {
    const stage = stageRef.current;
    setMenu(false);
    if (!stage) return;
    manualUntil.current = Date.now() + MANUAL_HOLD_MS;
    wake();
    switch (id) {
      case "sit":
        stage.setPose(stage.currentPose === "sit" ? "stand" : "sit");
        break;
      case "dance":
        stage.setPose("stand");
        stage.play("dance");
        window.setTimeout(() => stage.play("idle"), 7000);
        break;
      case "jump":
        void stage.jump();
        break;
      case "wave":
        stage.setPose("stand");
        stage.play("wave", true);
        break;
      case "follow":
        setFollowing((f) => !f);
        break;
      case "ask":
        openAsk();
        break;
      case "dashboard":
        if (inTauri) void invoke("open_dashboard");
        break;
      case "later": {
        // Put the bottle away; he stays, and brings it back after the snooze time.
        manualUntil.current = 0;
        coachRef.current?.later(settingsRef.current.snoozeMin);
        setPhase("idle");
        stage.stowBottle();
        stage.setSitting(false);
        stage.play("nod", true);
        break;
      }
    }
  };

  // Follow my cursor: walk along the taskbar under the mouse for a while.
  useEffect(() => {
    if (!following) return;
    const stage = stageRef.current;
    const until = Date.now() + FOLLOW_MS;
    const t = window.setInterval(async () => {
      if (!stage || Date.now() > until) return setFollowing(false);
      manualUntil.current = Date.now() + 2000;
      playUntilRef.current = Date.now() + 2000;
      const c = await cursorPosition();
      if (c && stage.canWalk && Math.abs(c.x - stage.x) > 28) void stage.walkTo(c.x);
    }, 200);
    return () => {
      clearInterval(t);
      store.set("selfglance.homeX", String(Math.round(stage?.x ?? homeX())));
    };
  }, [following]);

  // --- Play: poke, drag, throw ------------------------------------------------------------
  const poke = () => {
    const stage = stageRef.current;
    if (!stage || stage.busy) return;
    wake();
    const now = Date.now();
    pokes.current = [...pokes.current.filter((t) => now - t < 2500), now];
    if (pokes.current.length >= 4) {
      pokes.current = [];
      stage.play("annoyed", true);
    } else {
      stage.play(POKE_REACTIONS[Math.floor(Math.random() * POKE_REACTIONS.length)], true);
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startY: e.clientY, active: false, samples: [] };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const stage = stageRef.current;
    if (!d || !stage) return;
    if (!d.active && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > 5) {
      d.active = stage.grab();
      if (d.active) {
        setBusy(true);
        wake();
      }
    }
    if (!d.active) return;
    stage.dragTo(e.clientX, e.clientY);
    d.samples.push({ x: e.clientX, y: e.clientY, t: performance.now() });
    if (d.samples.length > 6) d.samples.shift();
  };

  const onPointerUp = async () => {
    const d = drag.current;
    drag.current = null;
    const stage = stageRef.current;
    if (!stage || !d) return;
    if (!d.active) {
      poke();
      return;
    }

    // Throw velocity from the last ~120 ms of movement.
    const now = performance.now();
    const recent = d.samples.filter((s) => now - s.t < 120);
    let vx = 0;
    let vy = 0;
    if (recent.length >= 2) {
      const a = recent[0];
      const b = recent[recent.length - 1];
      const dt = Math.max(0.016, (b.t - a.t) / 1000);
      vx = (b.x - a.x) / dt;
      vy = (b.y - a.y) / dt;
    }
    const impact = await stage.release(vx, vy);
    if (impact > 1400) stage.play("annoyed", true);
    store.set("selfglance.homeX", String(Math.round(stage.x)));
    setBusy(false);
  };

  // --- Render -----------------------------------------------------------------------------
  const inBreak = phase !== "idle";
  const awake = hover || busy || touched || menu || following || !!ask || phase === "arriving" || phase === "offering";
  const dim = !awake && inBreak; // waiting / away: half visible, bottle still in view
  const look = awake ? "" : dim ? "dim" : ctx === "watching" ? "watch" : ctx === "focus" ? "faint" : "ghost";

  return (
    <>
      <canvas ref={canvasRef} className={`stage ${look}`} />
      <div
        ref={hitRef}
        className="hit"
        onPointerEnter={() => setHover(true)}
        onPointerLeave={() => {
          setHover(false);
          wake(); // linger a moment after you move away, then fade
        }}
        onPointerDown={(e) => e.button === 0 && onPointerDown(e)}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => e.button === 0 && onPointerUp()}
        onContextMenu={openMenu}
        onDoubleClick={openMenu}
      />
      <div
        ref={bottleHitRef}
        className="bottle-hit"
        onPointerEnter={() => setHover(true)}
        onPointerLeave={() => setHover(false)}
        onClick={() => coachRef.current?.drank()}
        aria-label="Drink the water"
      />
      {pop && (
        <div ref={heyRef} className="hey-pos" aria-hidden>
          <span key={pop.n} className={pop.note ? "hey note" : "hey"}>
            {pop.text}
          </span>
        </div>
      )}
      {ask?.step === "input" && <AskBox boxRef={askBoxRef} onAsk={(q) => void doAsk(q)} onClose={() => void closeAsk()} />}
      {ask && ask.step !== "input" && (
        <AnswerCard
          cardRef={askCardRef}
          state={ask}
          onClose={() => void closeAsk()}
          onSettings={() => {
            void closeAsk();
            if (inTauri) void invoke("open_dashboard");
          }}
        />
      )}
      {menu && <ActionMenu menuRef={menuRef} sitting={stageRef.current?.currentPose === "sit"} following={following} inBreak={phase !== "idle"} laterMin={settingsRef.current.snoozeMin} onPick={act} />}
    </>
  );
}
