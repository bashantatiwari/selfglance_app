// The overlay: a full-screen transparent window holding Bond.
//
//   Your day  In the morning he asks what's on today (a short list). When about ten minutes in a row go to
//             something not on it, he says so in one line. At the end of your laptop day, a last call.
//   Care      After about 50 minutes of sitting he brings water and asks you to stand up. Low battery: one line.
//   Talk      Hold Ctrl+Alt and speak; "Listening…" stays up while you hold, "thinking…" until he answers.
//   Ask       Win+Alt to type. Ideas are saved word for word; timers, reminders and small jobs are done at once.
//   Tuck      Click him → "Tuck away" (or the tray): he leaves and a small head waits at the corner. His
//             cards still appear there. Click the head to bring him back.
//   Life      He watches videos with you, stays faint while you work, leaves during meetings and games.

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CharacterStage } from "./stage/CharacterStage";
import type { CharacterManifest, Rect } from "./stage/types";
import { addReminder, LATE_MS, takeDue, whenText } from "./assistant/remind";
import { BreakCoach, BREAK_EVERY_MIN, type BreakPhase } from "./break/BreakCoach";
import { backLine, doneLine, nudgeLine, offerLine, reaction } from "./break/lines";
import { classify, type Activity, type Context } from "./companion/context";
import { inTauri, onTauriEvent, sendHitRegions } from "./platform";
import { loadDay, Tracker } from "./companion/tracker";
import { loadSettings, projectRoots, type Settings } from "./settings";
import { ActionMenu, ARC, arcBox, type ActionId } from "./ui/ActionMenu";
import { AnswerCard, AskBox, type AskState } from "./ui/Ask";
import { Timers } from "./ui/Timers";
import { loadTimers, newTimer, saveTimers, spanText, type Timer } from "./assistant/timer";
import {
  aiChat,
  aiPrime,
  cancelAgent,
  captureHideByDefault,
  diag,
  goalJudge,
  isSpeaking,
  memoryKeep,
  memoryProfile,
  releaseFocus,
  routeCommand,
  runActions,
  setProjectRoots,
  speak,
  speakStream,
  stopSpeaking,
  voiceListen,
  voiceStatus,
  type Outcome,
} from "./ai";
import { ideaText, saidStop, understand } from "./assistant/intent";
import { addIdea } from "./assistant/notes";
import { dayBounds, hasProfile, loadProfile, profileLine } from "./assistant/profile";
import {
  addTodos,
  cacheKey,
  canNudge,
  dayId,
  driftMoment,
  driftRun,
  driftText,
  evening,
  loadCache,
  loadFixes,
  loadGoals,
  loadState,
  loadTodos,
  makeJudge,
  makeStandingJudge,
  patchState,
  recordNudge,
  saveCache,
  saveFixes,
  saveState,
  shouldAsk,
  splitTodos,
  stalled,
  stallText,
  standingDriftText,
  standingGoals,
  tomorrowOf,
  unclear,
  type Drift,
  type Fit,
} from "./assistant/goals";
import "./overlay.css";

const TOUCH_AWAKE_MS = 6_000; // fully visible this long after you last touched him, then he fades
const MANUAL_HOLD_MS = 3 * 60_000; // something you asked for overrides automatic behaviour this long
const MENU_OPEN_MS = 8_000;
const AWAY_AFTER_SEC = 120;
const SNOOZE_MIN = 10;
/** Where his cards go while he is tucked away: above the little head in the corner. */
const PEEK = () => ({ x: window.innerWidth - 84, y: window.innerHeight - 84, w: 64, h: 64 });

/** Two quick soft notes: a timer rang. */
function chime() {
  try {
    const ctx = new AudioContext();
    [880, 1320].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      const t = ctx.currentTime + i * 0.09;
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.08, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.15);
    });
    window.setTimeout(() => void ctx.close(), 600);
  } catch {
    /* no audio */
  }
}

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

async function loadCharacter(): Promise<{ base: string; manifest: CharacterManifest }> {
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
  const ctxRef = useRef<Context>("other");
  const activityRef = useRef<Activity | null>(null);
  const settingsRef = useRef<Settings>(loadSettings());
  /** The request on screen was spoken: answer out loud even if "read answers aloud" is off. */
  const heardRef = useRef(false);
  const [canListen, setCanListen] = useState(false);
  const coachBreakRef = useRef<() => boolean>(() => false);
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
  const peekRef = useRef<HTMLButtonElement>(null);
  const askTimer = useRef<number | undefined>(undefined);

  const [phase, setPhase] = useState<BreakPhase>("idle");
  const [hover, setHover] = useState(false);
  const [busy, setBusy] = useState(true); // entering / dragging / flying
  const [touched, setTouched] = useState(false);
  const touchTimer = useRef<number | undefined>(undefined);
  const [ctx, setCtx] = useState<Context>("other");
  const [menu, setMenu] = useState(false);
  const [pop, setPop] = useState<{ text: string; n: number; note: boolean | "long" } | null>(null);
  const [ask, setAsk] = useState<AskState | null>(null);
  const askRef = useRef<AskState | null>(null);
  askRef.current = ask;
  /** Goes up on every new request and on "stop": an older request that comes back later is dropped. */
  const askEpoch = useRef(0);
  const [timers, setTimers] = useState<Timer[]>(() => loadTimers());
  const timersRef = useRef<HTMLDivElement>(null);
  const changeTimers = (next: (list: Timer[]) => Timer[]) =>
    setTimers((list) => {
      const now = next(list);
      saveTimers(now);
      return now;
    });
  /** The dashboard has the focus: Bond steps aside (unless he has something to say). */
  const [inDashboard, setInDashboard] = useState(false);
  const tuckedRef = useRef(false);
  /** You tucked him away: he stays out of sight until you bring him back. Remembered across restarts. */
  const [away, setAway] = useState(() => store.get("selfglance.tucked") === "1");
  const awayRef = useRef(away);
  awayRef.current = away;

  const homeX = () => {
    const saved = Number(store.get("selfglance.homeX"));
    const w = stageRef.current?.width ?? window.innerWidth;
    return saved > 0 && saved < w ? saved : w - 160;
  };

  /** A word popping up beside his head ("Hey!"). */
  const showPop = (text: string, ms = 1600, note: boolean | "long" = false) => {
    setPop((p) => ({ text, n: (p?.n ?? 0) + 1, note }));
    clearTimeout(heyTimer.current);
    heyTimer.current = window.setTimeout(() => setPop(null), ms);
  };

  /** Stay fully visible for `ms`, then fade back. */
  const wake = (ms = TOUCH_AWAKE_MS) => {
    playUntilRef.current = Date.now() + ms;
    setTouched(true);
    clearTimeout(touchTimer.current);
    touchTimer.current = window.setTimeout(() => setTouched(false), ms);
  };

  /** Show him (unless you tucked him away: then his cards appear by the little head). */
  const appear = async () => {
    const stage = stageRef.current;
    if (!stage || awayRef.current) return;
    if (!stage.visible && !stage.busy) {
      hiddenByCtx.current = false;
      await stage.webDrop(homeX());
    }
  };

  // --- Mount ------------------------------------------------------------------------------
  useEffect(() => {
    let disposed = false;
    const stage = new CharacterStage(canvasRef.current!);
    stageRef.current = stage;
    stage.onClip = (name) => {
      if (name === "wave") showPop("Hey!");
    };

    // Every frame: glue the hit targets to him and the bottle, and tell Rust which rectangles
    // should catch the mouse (everything else stays click-through).
    stage.onFrame = (rect) => {
      const regions: Rect[] = [];
      const place = (el: HTMLElement | null, r: Rect | null) => {
        if (!el) return;
        el.style.display = r ? "block" : "none";
        if (r) Object.assign(el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
      };
      const tucked = tuckedRef.current;
      place(hitRef.current, tucked ? null : rect);
      const bottle = stage.bottleRect();
      place(bottleHitRef.current, tucked ? null : bottle);

      if (drag.current?.active) regions.push({ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight });
      else if (!tucked) {
        if (rect) regions.push(rect);
        if (bottle) regions.push(bottle);
      }
      // Cards sit by him, or by the little head when he's tucked away.
      const anchor = rect && !awayRef.current ? rect : awayRef.current ? PEEK() : null;
      const hy = heyRef.current;
      if (hy && anchor) {
        const right = anchor.x + anchor.w / 2 < window.innerWidth - 120;
        const x = right ? anchor.x + anchor.w * 0.85 : anchor.x + anchor.w * 0.15 - hy.offsetWidth;
        hy.style.transform = `translate(${x}px, ${anchor.y - 6}px)`;
      }
      const m = menuRef.current;
      if (m && rect) {
        const { w, h } = arcBox();
        const left = Math.min(Math.max(4, rect.x + rect.w / 2 - w / 2), window.innerWidth - w - 4);
        const top = Math.max(4, rect.y + 22 - (h - ARC.pad));
        m.style.transform = `translate(${left}px, ${top}px)`;
        regions.push({ x: left, y: top, w, h });
      }
      for (const el of [askBoxRef.current, askCardRef.current]) {
        if (!el || !anchor) continue;
        const w = el.offsetWidth;
        const hh = el.offsetHeight;
        let left = anchor.x + anchor.w / 2 - w / 2;
        let top = anchor.y - hh - 14;
        if (top < 8) {
          top = Math.min(window.innerHeight - hh - 8, anchor.y + 10);
          left = anchor.x + anchor.w / 2 > window.innerWidth / 2 ? anchor.x - w - 14 : anchor.x + anchor.w + 14;
        }
        left = Math.min(Math.max(8, left), window.innerWidth - w - 8);
        el.style.transform = `translate(${left}px, ${top}px)`;
        regions.push({ x: left, y: top, w, h: hh });
      }
      for (const el of [timersRef.current, peekRef.current]) {
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (r.width && r.height) regions.push({ x: r.x, y: r.y, w: r.width, h: r.height });
      }
      sendHitRegions(regions);
    };

    const coach = new BreakCoach(
      {
        async start() {
          if (awayRef.current) {
            // Tucked away: no bottle scene, just the line by the little head.
            coach.arrived();
            setPhase("offering");
            showPop(offerLine(), 9000, "long");
            if (settingsRef.current.speakAnswers && ctxRef.current !== "meeting") void speak("Time to get up and drink some water.");
            return;
          }
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
            showPop(offerLine(), 7000, "long");
            if (settingsRef.current.speakAnswers && ctxRef.current !== "meeting") void speak("Time to get up and drink some water.");
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
          showPop(nudgeLine(), 4500, "long");
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
          if (awayRef.current) return void showPop(how === "drank" ? doneLine() : backLine(), 3000, "long");
          await stage.drinkBottle();
          stage.play(reaction(), true);
          showPop(how === "drank" ? doneLine() : backLine(), 4500, "long");
          if (how === "drank") window.setTimeout(() => stage.play("dance", true), 1600);
        },
      },
      () => {
        const c = ctxRef.current;
        return c === "meeting" || c === "game" || hiddenByCtx.current ? "hard" : c === "watching" ? "soft" : null;
      },
      BREAK_EVERY_MIN,
      diag,
    );

    // Fit his behaviour to what you're doing. Runs on every activity change and idle tick.
    let behaving = false;
    let arrived = false;
    const behave = async () => {
      if (!arrived || behaving || stage.busy || Date.now() < playUntilRef.current || Date.now() < manualUntil.current) return;
      const c = ctxRef.current;
      const hard = c === "meeting" || c === "game" || awayRef.current;
      behaving = true;
      try {
        if (hard) {
          if (coach.inBreak && !awayRef.current) {
            coach.cancel();
            stage.dropBottle();
            setPhase("idle");
          }
          if (stage.visible) {
            hiddenByCtx.current = true;
            await stage.webClimb();
          }
          return;
        }
        if (hiddenByCtx.current || !stage.visible) {
          hiddenByCtx.current = false;
          await stage.webDrop(homeX());
          return;
        }
        if (coach.inBreak) return;
        const gone = c !== "watching" && idleRef.current >= AWAY_AFTER_SEC;
        const want = gone ? "sleep" : c === "watching" ? "watch" : "stand";
        const was = stage.currentPose;
        if (want === was) return;
        stage.setPose(want);
        if (was === "sleep" && want !== "sleep") stage.play("wave", true);
      } finally {
        behaving = false;
      }
    };
    coachRef.current = coach;

    /** You called him (Ctrl+Alt, Win+Alt): make sure his card can be seen. */
    const bringIn = async () => {
      manualUntil.current = Date.now() + MANUAL_HOLD_MS;
      if (awayRef.current || stage.visible || stage.busy) return;
      hiddenByCtx.current = false;
      setBusy(true);
      await stage.webDrop(homeX());
      setBusy(false);
    };

    const applySettings = (st: Settings) => {
      settingsRef.current = st;
      coach.configure({ everyMin: BREAK_EVERY_MIN, enabled: st.breaksOn });
      void memoryKeep(st.keepChats);
      void captureHideByDefault(st.hideFromCaptures);
      void setProjectRoots(projectRoots(st));
    };
    coachBreakRef.current = () => coach.inBreak;
    applySettings(settingsRef.current);
    const about = loadProfile();
    if (hasProfile(about)) void memoryProfile(profileLine(about));
    const tracker = new Tracker();

    (async () => {
      const { base, manifest } = await loadCharacter();
      await stage.load(base, manifest);
      if (disposed) return;
      if (!awayRef.current) await stage.webDrop(homeX());
      arrived = true;
      setBusy(false);
    })().catch((err) => {
      diag(`character failed to load: ${err}`);
      setBusy(false);
    });
    const fakeIdle = inTauri ? undefined : window.setInterval(() => coach.onIdle(0), 2000);

    const unlisten = [
      onTauriEvent<Settings>("settings-changed", applySettings),
      onTauriEvent<null>("ask-open", () => openAsk()),
      // Talking: the card says "Listening…" from the moment the keys go down until they come up, then "thinking…".
      onTauriEvent<string>("voice-state", (state) => {
        if (state === "starting" || state === "listening") {
          void bringIn();
          void aiPrime();
          stopSpeaking();
          clearTimeout(askTimer.current);
          wake(35_000);
          if (state === "starting") stageRef.current?.play("nod", true);
          setPop(null);
          setAsk({ step: "listening", ready: state === "listening" });
        } else if (state === "thinking") {
          setAsk({ step: "thinking", question: "", note: "understanding you…" });
        } else if (state === "idle" && askRef.current?.step === "listening") {
          setAsk(null); // the keys were part of another shortcut: nothing was heard
        }
      }),
      onTauriEvent<string>("voice-heard", (text) => {
        const said = text.trim();
        diag(`voice-heard ${said.length} characters`);
        if (!said) {
          setAsk(null);
          return showPop("I didn't catch that", 2200, true);
        }
        heardRef.current = true;
        if (saidStop(said)) return cancelAll();
        void doAsk(said, false);
      }),
      onTauriEvent<string>("voice-error", (e) => {
        diag(`voice-error ${e}`);
        setPop(null);
        setAsk({ step: "error", question: "", error: e });
        autoClose();
      }),
      onTauriEvent<number>("idle", (sec) => {
        idleRef.current = sec;
        const watching = ctxRef.current === "watching";
        coach.onIdle(watching ? 0 : sec);
        try {
          tracker.tick(activityRef.current, ctxRef.current, watching || sec < AWAY_AFTER_SEC);
        } catch (e) {
          diag(`idle tick failed: ${e}`);
        }
        void behave();
        void goalTick();
        void reminderTick();
      }),
      onTauriEvent<Activity>("activity", (a) => {
        activityRef.current = a;
        const c = classify(a);
        if (c === ctxRef.current) return;
        ctxRef.current = c;
        setCtx(c);
        void behave();
      }),
      onTauriEvent<number>("low-battery", async (pct) => {
        await appear();
        wake(10_000);
        stage.play("wave", true);
        showPop(`Battery ${pct}% — plug in`, 8000, true);
        if (settingsRef.current.speakAnswers && ctxRef.current !== "meeting") void speak(`Battery at ${pct} percent. Plug me in?`);
      }),
      onTauriEvent<null>("break-now", () => coach.startNow()),
      onTauriEvent<null>("tuck", () => setTucked(!awayRef.current)),
      onTauriEvent<number>("snooze", (min) => {
        const wasInBreak = coach.inBreak;
        coach.snooze(min);
        setPhase("idle");
        if (wasInBreak) {
          stage.dropBottle();
          stage.setSitting(false);
        }
      }),
      onTauriEvent<number | null>("summon", async (x) => {
        if (awayRef.current) return setTucked(false);
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

  useEffect(() => {
    const un = onTauriEvent<boolean>("dashboard-focus", (f) => setInDashboard(f));
    return () => void un.then((f) => f());
  }, []);

  /** Tuck him away (out of sight, a small head in the corner) or bring him back. */
  const setTucked = (on: boolean) => {
    setAway(on);
    awayRef.current = on;
    store.set("selfglance.tucked", on ? "1" : "0");
    const stage = stageRef.current;
    if (!stage) return;
    if (on) {
      if (stage.visible) void stage.webClimb();
    } else {
      hiddenByCtx.current = false;
      wake();
      if (!stage.visible) void stage.webDrop(homeX()).then(() => stage.play("wave", true));
    }
  };

  // --- Ask Bond ----------------------------------------------------------------------------
  function openAsk() {
    setMenu(false);
    clearTimeout(askTimer.current);
    manualUntil.current = Date.now() + MANUAL_HOLD_MS;
    wake(60_000);
    setAsk({ step: "input" });
    void voiceStatus().then((v) => setCanListen(v.installed));
    void aiPrime();
  }

  const closeAsk = async () => {
    clearTimeout(askTimer.current);
    const cur = askRef.current;
    const wasTyping = cur?.step === "input" || cur?.step === "todoask";
    setAsk(null);
    stopSpeaking();
    wake();
    heardRef.current = false;
    if (wasTyping) await releaseFocus();
  };

  // Clicking anywhere else closes an empty ask box.
  useEffect(() => {
    if (ask?.step !== "input") return;
    const onBlur = () => {
      if (askRef.current?.step === "input") void closeAsk();
    };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [ask?.step]);

  /** Close a card by itself after the time set in Settings (once he has finished speaking). */
  const autoClose = (seconds = settingsRef.current.answerSeconds) => {
    const ms = Math.max(4, seconds) * 1000;
    manualUntil.current = Date.now() + ms;
    clearTimeout(askTimer.current);
    askTimer.current = window.setTimeout(closeWhenQuiet, ms);
  };
  const closeWhenQuiet = () => {
    if (isSpeaking()) askTimer.current = window.setTimeout(closeWhenQuiet, 500);
    else void closeAsk();
  };

  /** Say it out loud when he reads answers aloud, or when you talked to him. */
  const talkBack = (text: string) => {
    if (settingsRef.current.speakAnswers || heardRef.current) void speak(text);
  };

  /** An answer worth reading: shown in the card (and spoken). */
  const answer = (question: string, text: string, done: string[], info: string[] = []) => {
    setAsk({ step: "answer", question, answer: text, done, info });
    if (text) talkBack(text);
    stageRef.current?.play("nod", true);
    autoClose(info.length ? 60 : undefined);
  };

  /** Something done or saved: a short note beside his head, no card to dismiss. */
  const confirm = (text: string) => {
    clearTimeout(askTimer.current);
    setAsk(null);
    wake();
    stageRef.current?.play("nod", true);
    showPop(text.length > 60 ? `${text.slice(0, 57)}…` : text, 2800, true);
    if (heardRef.current) void speak(text.replace(/✓/g, "").trim());
    heardRef.current = false;
  };

  const showOutcome = (question: string, o: Outcome) => {
    if (o.info.length) return answer(question, "", o.done, o.info);
    confirm(o.done.join(" · ") || "Done ✓");
  };

  /** "Stop": quiet at once, an answer still on its way is dropped. */
  const cancelAll = () => {
    askEpoch.current++;
    stopSpeaking();
    void cancelAgent();
    void closeAsk();
  };

  /** Talk: the answer is shown and spoken piece by piece while it is still being written. */
  const talk = async (question: string, my: number) => {
    const byVoice = heardRef.current;
    const voice = settingsRef.current.speakAnswers || byVoice ? speakStream() : null;
    let text = "";
    const un = await onTauriEvent<{ id: number; text: string }>("chat-piece", (p) => {
      if (p.id !== my || askEpoch.current !== my) return;
      text = text ? `${text} ${p.text}` : p.text;
      clearTimeout(askTimer.current);
      setAsk({ step: "answer", question, answer: text, done: [] });
      voice?.push(p.text);
    });
    try {
      const full = await aiChat(question, byVoice, my);
      if (askEpoch.current !== my) return;
      setAsk({ step: "answer", question, answer: full, done: [] });
      stageRef.current?.play("nod", true);
      void aiPrime();
      autoClose();
    } finally {
      un();
    }
  };

  /** Today's list, said in a sentence ("Three things today: …"). */
  const listText = () => {
    const list = loadTodos();
    if (!list.length) return "Nothing on today's list yet. Tell me: today: …";
    const open = list.filter((t) => !t.done);
    if (!open.length) return `All ${list.length} done today.`;
    return `${open.length} to go: ${open.map((t) => t.text).join("; ")}.`;
  };

  const doAsk = async (question: string, typed = true) => {
    const my = ++askEpoch.current;
    setAsk({ step: "thinking", question });
    if (typed) {
      heardRef.current = false;
      await releaseFocus(); // typing goes back to the app you were in
    }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    try {
      // 1. Bond's own rules: instant, no AI.
      const own = understand(question);
      if (own?.kind === "timer") {
        changeTimers((list) => [...list, newTimer(own.ms, own.label)].slice(-5));
        return confirm(`Timer set for ${spanText(own.ms)} ✓`);
      }
      if (own?.kind === "remind") {
        const r = addReminder(own.at, own.text);
        return confirm(`I'll remind you ${whenText(r.at)} ✓`);
      }
      if (own?.kind === "todo") {
        const day = own.tomorrow ? tomorrowOf() : new Date();
        const list = addTodos(own.items, day);
        return confirm(own.tomorrow ? "On tomorrow's list ✓" : `On today's list ✓ (${list.length})`);
      }
      if (own?.kind === "list") return answer(question, listText(), []);
      if (own?.kind === "idea") {
        addIdea(own.text);
        return confirm("Idea saved ✓");
      }
      if (own?.kind === "do") {
        try {
          return showOutcome(question, await runActions(own.actions));
        } catch (e) {
          // A project or file the rules named but couldn't find: say so, don't guess.
          if (own.actions.some((a) => a.do === "open_project" || a.do === "find_files")) throw e;
          /* e.g. no app by that name: let the AI work out what was meant */
        }
      }

      // 2. The AI: an idea, a small job from the menu (already done), or talk.
      const r = await routeCommand(question, heardRef.current);
      if (askEpoch.current !== my) return;
      if (r.intent === "idea") {
        addIdea(ideaText(question) || question); // your words, never rewritten
        return confirm("Idea saved ✓");
      }
      if (r.intent === "task" && r.outcome) return showOutcome(question, r.outcome);
      return await talk(question, my);
    } catch (e) {
      diag(`request failed: ${String(e)}`);
      setAsk({ step: "error", question, error: String(e) });
      stageRef.current?.play("annoyed", true);
      if (heardRef.current) void speak(String(e));
      autoClose();
    }
  };

  // --- Your day ----------------------------------------------------------------------------
  // The morning list, a nudge when about ten minutes in a row go to something not on it, a last
  // call at the end of your laptop day, and (in between) asking the brain about stretches the
  // rules can't judge. The rules and numbers are in assistant/goals.ts.

  const goalCheck = useRef({ at: 0, drift: null as Drift | null });

  /** Bring a card up (by him, or by the little head) and let it go after `ms`. */
  const showCard = async (card: AskState, ms: number, say?: string) => {
    await appear();
    wake(ms);
    stageRef.current?.play("wave", true);
    setAsk(card);
    clearTimeout(askTimer.current);
    askTimer.current = window.setTimeout(() => void closeAsk(), ms);
    if (say && settingsRef.current.speakAnswers && ctxRef.current !== "meeting") void speak(say);
  };

  const reminderTick = async () => {
    if (askRef.current || stageRef.current?.busy === true || coachBreakRef.current()) return;
    const due = takeDue();
    if (!due.length) return;
    const now = Date.now();
    const text = due.map((r) => (now - r.at > LATE_MS ? `${r.text} (it was due at ${new Date(r.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })})` : r.text)).join("\n");
    await showCard({ step: "answer", question: "Reminder", answer: text, done: [] }, 30_000, `Reminder: ${due.map((r) => r.text).join(". ")}`);
  };

  /** On the idle tick, at most every 20 s: the one thing about your day that is due, if any. */
  const goalTick = async () => {
    const now = Date.now();
    if (now - goalCheck.current.at < 20_000) return;
    goalCheck.current.at = now;
    const d = new Date();
    const state = loadState();
    const goals = loadGoals(d);
    const busy = !!askRef.current || stageRef.current?.busy === true;
    const moment = { idleSec: idleRef.current, ctx: ctxRef.current, busy, inBreak: coachBreakRef.current() };
    const today = loadDay(d);
    if (busy || !today.length) return;
    const pause = idleRef.current < 30 && ctxRef.current !== "meeting" && ctxRef.current !== "game";

    // 1. Nothing on today's list yet: ask once, in the morning.
    if (shouldAsk(state, loadTodos(d).map((t) => t.text), d) && pause) {
      patchState({ askedDay: dayId(d) });
      return void showCard({ step: "todoask" }, 180_000, "What's on today?");
    }

    const profile = loadProfile();
    const dayKey = dayId(d);

    // 2. The end of your laptop day (About you): a last call, then time to close.
    const ev = evening(d, dayBounds(profile).end, today, profile, { study: state.studyCall, close: state.closeCall });
    if (ev) {
      patchState(ev.kind === "study" ? { studyCall: dayKey } : { closeCall: dayKey });
      const open = loadTodos(d).filter((t) => !t.done);
      const text = ev.kind === "study" && open.length ? `${open.length} left on today's list: ${open[0].text} first?` : ev.text;
      return void showCard({ step: "choice", title: ev.kind === "study" ? "Before the day ends" : "Laptop off", text, options: [{ label: "Okay", primary: true, run: () => void closeAsk() }] }, 45_000, text);
    }

    // With nothing on the list, the day is judged against what you told him about yourself.
    const lines = goals.length ? goals : standingGoals(profile, d);
    if (!lines.length) return;
    const judge = goals.length ? makeJudge(goals) : makeStandingJudge(profile);
    const st = settingsRef.current;

    // 3. An hour on the laptop and nothing from the list yet: once a day.
    if (goals.length && st.goalNudge && pause && canNudge(state, now) && stalled(today, judge, state, d)) {
      const ms = today.reduce((n, s) => n + (s.end - s.start), 0);
      saveState(recordNudge({ ...state, stalledDay: dayKey }, now));
      const text = stallText(goals[0], ms);
      return void showCard({ step: "choice", title: "Today's list", text, options: [{ label: "Later", run: () => void closeAsk() }, { label: "On it", primary: true, run: () => void closeAsk() }] }, 30_000, text);
    }

    // 4. About ten minutes in a row on something not on the list.
    if (st.goalNudge && canNudge(state, now) && driftMoment(moment)) {
      const run = driftRun(today, judge, now);
      if (run) {
        goalCheck.current.drift = run;
        saveState(recordNudge(state, now));
        const text = goals.length ? driftText(goals[0], run) : standingDriftText(profile, run);
        return void showCard({ step: "drift", text }, 25_000, text);
      }
    }

    // 5. Stretches the rules can't judge: ask the brain, a few at a time, remembering what it says.
    if (now - (state.judgedAt ?? 0) < 90_000 || ctxRef.current === "meeting" || ctxRef.current === "game") return;
    const items = unclear(today, judge, 2 * 60_000).slice(0, 6);
    if (!items.length) return;
    patchState({ judgedAt: now });
    const fits = await goalJudge(lines, items.map((i) => ({ app: i.app, label: i.label })), []);
    if (fits.length !== items.length) return patchState({ judgedAt: now + 8 * 60_000 });
    const cache = loadCache();
    items.forEach((it, i) => (cache[cacheKey(judge, it.key)] = fits[i] as Fit));
    saveCache(cache);
  };

  /** The morning card: one item per line. */
  const saveDay = async (text: string) => {
    const list = addTodos(splitTodos(text));
    await releaseFocus();
    confirm(`Your day: ${list.length} thing${list.length === 1 ? "" : "s"} ✓`);
  };

  const driftOk = () => {
    const key = goalCheck.current.drift?.topKey;
    if (key) saveFixes({ ...loadFixes(), [key]: "on" as Fit });
    confirm("Okay, that counts ✓");
  };

  const driftSnooze = () => {
    patchState({ snoozeUntil: Date.now() + 30 * 60_000 });
    void closeAsk();
  };

  /** A timer reached zero: he rings and says so. */
  const timerDone = async (t: Timer) => {
    await appear();
    wake(12_000);
    stageRef.current?.play("wave", true);
    chime();
    window.setTimeout(chime, 450);
    const what = t.label ? `Time's up: ${t.label}` : "Time's up";
    showPop(what, 6000, "long");
    if (settingsRef.current.speakAnswers && ctxRef.current !== "meeting") void speak(`${what}.`);
  };

  // --- Right-click / double-click menu -------------------------------------------------------
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
      case "ask":
        openAsk();
        break;
      case "dashboard":
        if (inTauri) void invoke("open_dashboard");
        break;
      case "tuck":
        setTucked(true);
        break;
      case "later":
        manualUntil.current = 0;
        coachRef.current?.later(SNOOZE_MIN);
        setPhase("idle");
        stage.stowBottle();
        stage.setSitting(false);
        stage.play("nod", true);
        break;
    }
  };

  // --- Move: drag and throw ------------------------------------------------------------
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
    if (!d.active) return wake();
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
  tuckedRef.current = away || (inDashboard && !inBreak && !ask && !menu);
  const awake = hover || busy || touched || menu || !!ask || phase === "arriving" || phase === "offering";
  const dim = !awake && inBreak;
  const look = awake ? "" : dim ? "dim" : ctx === "watching" ? "watch" : ctx === "focus" ? "faint" : "ghost";

  return (
    <>
      <canvas ref={canvasRef} className={`stage ${look}${tuckedRef.current ? " tucked" : ""}`} />
      <div
        ref={hitRef}
        className="hit"
        onPointerEnter={() => setHover(true)}
        onPointerLeave={() => {
          setHover(false);
          wake();
        }}
        onPointerDown={(e) => e.button === 0 && onPointerDown(e)}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => e.button === 0 && onPointerUp()}
        onContextMenu={openMenu}
        onDoubleClick={openMenu}
      />
      <div ref={bottleHitRef} className="bottle-hit" onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)} onClick={() => coachRef.current?.drank()} aria-label="Drink the water" />
      {away && (
        <button ref={peekRef} className="peek" onClick={() => setTucked(false)} title="Bring Bond back" aria-label="Bring Bond back">
          <img src="/bond-icon.png" alt="" />
        </button>
      )}
      {pop && (
        <div ref={heyRef} className="hey-pos" aria-hidden>
          <span key={pop.n} className={pop.note === "long" ? "hey note long" : pop.note ? "hey note" : "hey"}>
            {pop.text}
          </span>
        </div>
      )}
      {ask?.step === "input" && (
        <AskBox
          boxRef={askBoxRef}
          onAsk={(q) => void doAsk(q)}
          onClose={() => void closeAsk()}
          onMic={
            canListen
              ? () => {
                  void releaseFocus();
                  void voiceListen();
                }
              : null
          }
        />
      )}
      {ask && ask.step !== "input" && (
        <AnswerCard
          cardRef={askCardRef}
          state={ask}
          onClose={() => void closeAsk()}
          onSettings={() => {
            void closeAsk();
            if (inTauri) void invoke("open_dashboard", { page: "settings" });
          }}
          onWantFocus={() => void (inTauri && invoke("take_focus"))}
          onCopy={(text) => void navigator.clipboard?.writeText(text).then(() => showPop("Copied ✓", 1500, true))}
          onTodos={(text) => void saveDay(text)}
          onTodoSkip={() => void closeAsk()}
          onDriftBack={() => void closeAsk()}
          onDriftOk={driftOk}
          onDriftSnooze={driftSnooze}
        />
      )}
      {timers.length > 0 && <Timers timers={timers} boxRef={timersRef} onCancel={(id) => changeTimers((list) => list.filter((t) => t.id !== id))} onDone={(t) => void timerDone(t)} />}
      {menu && <ActionMenu menuRef={menuRef} inBreak={phase !== "idle"} laterMin={SNOOZE_MIN} onPick={act} />}
    </>
  );
}
