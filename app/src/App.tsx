// The overlay: a full-screen transparent window holding the 3D character.
// No panels, no text — the character's actions carry the message:
//
//   Break    every ~45 min of active use he web-drops in carrying a water bottle and
//            holds it out to you. Step away and he knows; come back and he cheers.
//            Or click the bottle to drink, and he does a stretch dance with you.
//   Play     Ctrl+Alt+G (Cmd+Option+G) drops him at your cursor. Throw him around,
//            poke him, or right-click him for actions: sit, dance, jump, wave,
//            follow my cursor, open the dashboard ("Later" too, during a break).
//   Talk     hold Ctrl+Alt+V and speak (or click the mic in the Ask box): he listens on
//            this laptop, does what you said, and answers out loud.
//   Ask      Ctrl+Alt+Space (or the menu): one box for everything. Bond works out what you
//            mean: log your day, save an idea, do something on the desktop (open apps,
//            sites, folders, media keys, or click/type on screen), explain your screen,
//            or help when you're stuck. Clear commands are handled locally; the rest
//            goes to the AI. Typing goes straight back to your app once you press Enter.
//            Anything powerful (run a command, end a program, delete files) waits in his
//            card for your OK; deleting asks twice.
//   Remind   "remind me in 45 minutes to…": when it's due he drops in with it and says it.
//            He also warns when the battery runs low.
//   Nudge    long stretches of chatting with AI / note-taking without building → "Time to build!"
//   Notice   on his own, at a natural pause: your habits ("you usually open Spotify in
//            VS Code — want it?"), a tip when you copy an error or keep searching while
//            working. Judged by the on-device brain only; how often is up to you
//            (Settings → Suggestions), and a 👎 stops that suggestion.
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
import { Guide, type GuideView } from "./ui/Guide";
import {
  aiGuide,
  aiText,
  approveAction,
  aiPrime,
  clipboardText,
  denyAction,
  giveFeedback,
  guideMouse,
  recordOwn,
  releaseFocus,
  routeCommand,
  runActions,
  screenAsk,
  setLearning,
  snoozeReminder,
  speak,
  isSpeaking,
  stopSpeaking,
  takeFocus,
  voiceListen,
  voiceStatus,
  wakeConfirmYou,
  wakeFollowUp,
  wakeNotYou,
  wakeSet,
  diag,
  noticeAllowed,
  noticeEnable,
  noticeHabits,
  noticeJudge,
  noticeScan,
  noticeShown,
  type Feedback,
  type Habit,
  type Outcome,
  type Reminder,
} from "./ai";
import { saidStop, spokenAnswer, understand, unsavedAnswer, type ScreenMode } from "./assistant/intent";
import { addIdea, dayKey, journalGet, logToJournal } from "./assistant/notes";
import {
  blockedBy,
  errorFallback,
  habitText,
  inQuietHours,
  LEVEL_GAP_MIN,
  LEVEL_KINDS,
  naturalPause,
  Pacer,
  stuckFallback,
  StuckWatch,
  SUGGESTION_TTL_MS,
  type Suggestion,
} from "./assistant/notice";
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
const SCAN_EVERY_MS = 30_000; // looking for an error on screen, during pauses in an editor/terminal
/** Two quick soft notes: "I heard you". Short and wordless, so it never talks over you. */
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

const FOLLOW_UP_SEC = 6; // after he answers a spoken request, a follow-up needs no "Hey Bond"
const CHATTY = /\b(chatgpt|claude|gemini|perplexity|copilot|deepseek|grok|notion|obsidian|onenote|google keep)\b/i;
const POKE_REACTIONS: ClipName[] = ["wave", "nod", "celebrate", "hang"];
const CLIPBOARD_SYSTEM =
  "You are Bond, a friendly desktop companion. The user asks about the text they copied to their clipboard (given below their question). " +
  "Do what they ask with it (summarize, explain, translate, fix, answer). Keep it short: at most 6 sentences, plain text, no markdown.";

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
  /** The request on screen in Bond's experience log, for 👍 / 👎 and refusals. */
  const expRef = useRef("");
  // Bond notices: what's waiting for a natural pause, and the suggestion on screen.
  const stuckRef = useRef(new StuckWatch());
  const pacerRef = useRef(new Pacer());
  const pendingRef = useRef<Suggestion | null>(null);
  const noticeIdRef = useRef("");
  const habitsRef = useRef<{ list: Habit[]; at: number }>({ list: [], at: 0 });
  const scanRef = useRef({ at: 0, last: "" });
  /** The request on screen was spoken: answer out loud even if "read answers aloud" is off. */
  const heardRef = useRef(false);
  const wokeRef = useRef(false); // "Hey Bond" just now: the listening cue says "Yes?"
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
  // Guide mode: he points, you click. guideRun is the running guide's id (0 = none).
  const [guide, setGuide] = useState<GuideView | null>(null);
  const [guideFrom, setGuideFrom] = useState<{ x: number; y: number } | null>(null);
  const guideRun = useRef(0);
  const guideTipRef = useRef<HTMLDivElement>(null);

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
      const tip = guideTipRef.current;
      if (tip) {
        const r = tip.getBoundingClientRect();
        regions.push({ x: r.x, y: r.y, w: r.width, h: r.height });
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
      if (!settingsRef.current.brainstormAlert || coach.inBreak || stage.busy || !stage.visible) return;
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
    let arrived = false; // his first drop-in after loading is done
    const behave = async () => {
      if (!arrived || behaving || stage.busy || Date.now() < playUntilRef.current || Date.now() < manualUntil.current) return;
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
            diag(`hiding: ${c}`);
            await stage.webClimb();
          }
          return;
        }
        // Nothing needs him out of the way: whatever hid him, he comes back.
        if (hiddenByCtx.current || !stage.visible) {
          hiddenByCtx.current = false;
          diag(`coming back (${c})`);
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

    /** Make sure he's on screen (he leaves during meetings and games). */
    const bringIn = async () => {
      manualUntil.current = Date.now() + MANUAL_HOLD_MS;
      if (stage.visible || stage.busy) return;
      hiddenByCtx.current = false;
      setBusy(true);
      await stage.webDrop(homeX());
      setBusy(false);
    };

    // A reminder is due: he comes in with it, says it, and holds the card until you answer.
    const remind = async (r: Reminder) => {
      await bringIn();
      wake(60_000);
      if (!coach.inBreak) stage.setPose("stand");
      stage.play("wave", true);
      if (settingsRef.current.speakAnswers && ctxRef.current !== "meeting") speak(`Reminder: ${r.text}`);
      const current = askRef.current?.step;
      if (current && current !== "answer" && current !== "error" && current !== "reminder") {
        showPop(`⏰ ${r.text}`, 12_000, true); // you're in the middle of something with him
        return;
      }
      clearTimeout(askTimer.current);
      setAsk({ step: "reminder", reminder: r });
    };
    // Evening: today's journal is still empty (Bond's own "log" lines don't count) and you're
    // here, so he asks once. Snoozing brings it back like any reminder.
    let journalChecking = false;
    const checkJournal = async (idleSec: number) => {
      const st = settingsRef.current;
      const day = dayKey();
      if (!st.journalNudge || journalChecking || idleSec >= AWAY_AFTER_SEC || coach.inBreak) return;
      if (new Date().getHours() < st.journalAt || store.get("selfglance.journalNudged") === day) return;
      if (ctxRef.current === "meeting" || ctxRef.current === "game") return;
      journalChecking = true;
      try {
        const text = await journalGet(day);
        store.set("selfglance.journalNudged", day);
        const written = text.split("\n").some((l) => l.trim() && !/^\d{1,2}:\d{2}(\s?[ap]m)? — /i.test(l.trim()));
        if (!written) await remind({ id: "journal", text: "Time to write today's journal. How did the day go?", at: Date.now(), open: "journal" });
      } catch {
        /* try again on the next tick */
      } finally {
        journalChecking = false;
      }
    };
    const applySettings = (st: Settings) => {
      settingsRef.current = st;
      coach.configure({ everyMin: st.breakEveryMin, enabled: st.breaksOn });
      void setLearning(st.learnFromMe);
      void noticeEnable(st.notice !== "off");
      void wakeSet(st.wakeWord, st.voiceMatch).catch(() => {}); // not downloaded yet: Settings says so
      if (st.notice === "off") pendingRef.current = null;
    };
    coachBreakRef.current = () => coach.inBreak;
    applySettings(settingsRef.current);
    const tracker = new Tracker();

    (async () => {
      const { base, manifest } = await loadCharacter();
      await stage.load(base, manifest);
      if (disposed) return;
      await stage.webDrop(homeX());
      arrived = true;
      setBusy(false);
    })().catch((err) => {
      console.error("Failed to load character", err);
      diag(`character failed to load: ${err}`);
      setBusy(false);
    });

    // Without Tauri (plain browser preview) there is no idle signal: assume active use.
    const fakeIdle = inTauri ? undefined : window.setInterval(() => coach.onIdle(0), 2000);

    const unlisten = [
      onTauriEvent<Settings>("settings-changed", applySettings),
      onTauriEvent<null>("ask-open", () => openAsk()),
      // Talking to him: listening → understanding → the same path as a typed request.
      onTauriEvent<string>("voice-state", (state) => {
        diag(`voice-state ${state} (card: ${askRef.current?.step ?? "none"}, on screen: ${!document.hidden})`);
        if (state === "listening") {
          // He may be out of the way (coding, a meeting): you called him, so he comes in.
          void bringIn();
          void aiPrime(); // his brain gets ready while you speak
          stopSpeaking();
          clearTimeout(askTimer.current);
          // A question he asked you stays up: what you're saying may be the answer.
          const asking = askRef.current?.step === "approve" || askRef.current?.step === "unsure";
          if (!asking) setAsk(null);
          wake(25_000);
          stageRef.current?.play("nod", true);
          showPop(wokeRef.current ? "Yes?" : "Listening…", 25_000, true);
          wokeRef.current = false;
        } else if (state === "thinking") {
          setPop(null);
        }
      }),
      onTauriEvent<string>("voice-heard", (text) => {
        setPop(null);
        const said = text.trim();
        diag(`voice-heard “${said}”`);
        if (!said) return showPop("I didn't catch that", 2200, true);
        heardRef.current = true;
        // Answering his question out loud: "yes" / "no", and "delete" for the last check.
        const cur = askRef.current;
        if (cur?.step === "approve" && cur.approval.kind === "unsaved") {
          const reply = unsavedAnswer(said);
          if (reply === "discard") return void approve(cur.approval.id);
          if (reply === "save") return void approve(cur.approval.id, true);
          if (reply === "cancel") return void deny(cur.approval.id);
        } else if (cur?.step === "approve") {
          const reply = spokenAnswer(said, cur.approval.step > 1);
          if (reply === "no") return void deny(cur.approval.id);
          if (reply === "yes") return void approve(cur.approval.id);
        }
        if (saidStop(said)) {
          stopSpeaking();
          if (guideRun.current) return stopGuide("Okay, you've got it from here.");
          return void closeAsk();
        }
        void doAsk(said, false);
      }),
      // Turned away by a little: rather than silence, he asks (and learns if it was you).
      onTauriEvent<number>("wake-unsure", (score) => {
        diag(`wake-unsure ${score.toFixed(2)}: asking`);
        setPop(null);
        clearTimeout(askTimer.current);
        wake(60_000);
        setAsk({ step: "unsure" });
      }),
      // "Hey Bond": a soft chime at once, like Siri, so you know he heard you.
      onTauriEvent<null>("wake", () => {
        wokeRef.current = true;
        void aiPrime();
        chime();
      }),
      // "Hey Bond" and then nothing: he asks, and listens for the answer.
      onTauriEvent<null>("wake-empty", () => {
        diag("wake-empty: saying Yes?");
        setPop(null);
        heardRef.current = true;
        stageRef.current?.play("wave", true);
        showPop("Yes?", 6000, true);
        talkBack("Yes?", true);
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
        tracker.tick(activityRef.current, ctxRef.current, watching || sec < AWAY_AFTER_SEC);
        checkBrainstorm(sec < AWAY_AFTER_SEC);
        // Watching a video is screen time even with no keyboard/mouse input.
        coach.onIdle(ctxRef.current === "watching" ? 0 : sec);
        void behave();
        void deliverSuggestion();
        void scanForError();
        void checkJournal(sec);
      }),
      onTauriEvent<Activity>("activity", (a) => {
        activityRef.current = a;
        stuckRef.current.push(a, classify(a));
        void noticeStuck();
        void noticeHabit(a);
        const c = classify(a);
        if (c === ctxRef.current) return;
        ctxRef.current = c;
        setCtx(c);
        void behave();
      }),
      onTauriEvent<Reminder>("reminder", (r) => void remind(r)),
      onTauriEvent<string>("clipboard-error", (text) => void noticeError(text, "clipboard")),
      onTauriEvent<number>("low-battery", async (pct) => {
        if (!settingsRef.current.batteryAlert) return;
        await bringIn();
        wake(10_000);
        stage.play("wave", true);
        showPop(`Battery ${pct}% — plug in`, 8000, true);
        if (settingsRef.current.speakAnswers && ctxRef.current !== "meeting") speak(`Your battery is at ${pct} percent. Time to plug in.`);
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
    void voiceStatus().then((v) => setCanListen(v.installed));
    // Load his brain (and have it read its instructions) while you type, so the answer doesn't wait.
    void aiPrime();
  }

  const closeAsk = async () => {
    clearTimeout(askTimer.current);
    const cur = askRef.current;
    const wasTyping = cur?.step === "input" || (cur?.step === "approve" && cur.approval.step > 1);
    if (cur?.step === "approve") void denyAction(cur.approval.id); // closing is a no
    if (cur?.step === "suggest") void giveFeedback(noticeIdRef.current, "ignored");
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
    askTimer.current = window.setTimeout(closeWhenQuiet, ms);
  };

  /** Close the card once he has finished speaking (closing it would cut him off). */
  const closeWhenQuiet = () => {
    if (isSpeaking()) askTimer.current = window.setTimeout(closeWhenQuiet, 500);
    else void closeAsk();
  };

  /** An answer worth reading: shown in the card (and spoken if that's on). */
  const answer = (question: string, text: string, done: string[], say: boolean, info: string[] = []) => {
    setAsk({ step: "answer", question, answer: text, done, info });
    if (say && (settingsRef.current.speakAnswers || heardRef.current) && text) talkBack(text);
    stageRef.current?.play("nod", true);
    if (info.length) {
      // Output to read: give it time (it also closes with ×).
      const ms = Math.max(60, settingsRef.current.answerSeconds) * 1000;
      manualUntil.current = Date.now() + ms;
      clearTimeout(askTimer.current);
      askTimer.current = window.setTimeout(closeWhenQuiet, ms);
    } else autoClose();
  };

  /** Show what a plan of actions came to: an approval to give, text to read, or a quick note. */
  const showOutcome = (question: string, o: Outcome, reply = "") => {
    if (o.pending) {
      clearTimeout(askTimer.current);
      manualUntil.current = Date.now() + 10 * 60_000;
      wake(10 * 60_000);
      setAsk({ step: "approve", question, approval: o.pending, done: o.done, info: o.info });
      stageRef.current?.play("nod", true);
      if (o.pending.step === 1 && (settingsRef.current.speakAnswers || heardRef.current)) talkBack(o.pending.title.replace(/\?.*$/, "?"));
      return;
    }
    if (o.info.length) return answer(question, reply, o.done, false, o.info);
    confirm(o.done.join(" · ") || reply || "Done ✓");
  };

  const approve = async (id: string, alt = false) => {
    const cur = askRef.current;
    if (cur?.step !== "approve") return;
    const question = cur.question;
    if (cur.approval.step > 1) await releaseFocus();
    const last = cur.approval.step >= cur.approval.steps;
    setAsk({ step: "thinking", question, looking: false, note: last ? (cur.approval.kind === "command" ? "running…" : "on it…") : undefined });
    try {
      showOutcome(question, await approveAction(id, alt));
    } catch (e) {
      setAsk({ step: "error", question, error: String(e) });
      stageRef.current?.play("annoyed", true);
      autoClose();
    }
  };

  const deny = async (id: string) => {
    const cur = askRef.current;
    void denyAction(id);
    void giveFeedback(expRef.current, "declined");
    if (cur?.step === "approve" && cur.approval.step > 1) await releaseFocus();
    confirm(cur?.step === "approve" && cur.approval.kind === "unsaved" ? "Okay, I left it open." : "Okay, I won't.");
  };

  /** Say it out loud; if you asked by voice, keep listening a few seconds for a follow-up. */
  const talkBack = (text: string, listen = false) => {
    const byVoice = heardRef.current;
    void speak(text).then(() => {
      const st = settingsRef.current;
      if (st.wakeWord && (listen || (byVoice && st.followUp))) void wakeFollowUp(FOLLOW_UP_SEC);
    });
  };

  /** Something done or saved: a short note beside his head, no card to dismiss. */
  const confirm = (text: string) => {
    clearTimeout(askTimer.current);
    setAsk(null);
    wake();
    stageRef.current?.play("nod", true);
    showPop(text.length > 60 ? `${text.slice(0, 57)}…` : text, 2800, true);
    if (heardRef.current) talkBack(text.replace(/✓/g, "").trim()); // you talked to him: he answers out loud
  };

  const lookAtScreen = async (question: string, mode: ScreenMode) => {
    setAsk({ step: "thinking", question, looking: true });
    const res = await screenAsk(question, mode, heardRef.current);
    void aiPrime(); // looking replaced what his brain had read; read it again for the next request
    expRef.current = res.exp_id;
    const o = res.outcome ?? { done: [], info: [], pending: null };
    if (o.pending || (mode === "task" && !res.answer)) return showOutcome(question, o, res.answer);
    answer(question, res.answer, o.done, mode !== "task", o.info);
  };

  // The screen has been read: bring the note back while his brain works out the step.
  useEffect(() => {
    const un = onTauriEvent("guide-looked", () => setGuide((g) => (g ? { ...g, hidden: false } : g)));
    return () => void un.then((f) => f());
  }, []);

  /** End guide mode (no more looking, the cursor and note go away). */
  const stopGuide = (say?: string) => {
    guideRun.current = 0;
    setGuide(null);
    void releaseFocus();
    if (say) showPop(say, 2800, true);
  };

  /**
   * "Walk me through buying a domain": look, point the cursor at the one next thing, wait
   * for you to click it yourself, look again. Nothing is clicked or typed for you.
   */
  const runGuide = async (goal: string) => {
    const id = Date.now();
    guideRun.current = id;
    const alive = () => guideRun.current === id;
    const pause = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
    const shown: string[] = [];
    const say = (text: string) => {
      if (heardRef.current) void speak(text);
    };
    const fail = (text: string) => {
      stopGuide();
      setAsk({ step: "error", question: goal, error: text });
      stageRef.current?.play("annoyed", true);
      autoClose();
    };
    setAsk(null);
    setGuideFrom(await cursorPosition());
    let misses = 0;
    let quiet = 0;
    for (let n = 1; n <= 40 && alive(); ) {
      // Out of the screenshot (the note would be read as part of the page), back once it's taken.
      setGuide((g) => ({ say: "Looking at your screen…", step: "wait", target: null, n: 0, ...g, hidden: true }));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      await pause(60);
      let s;
      try {
        s = await aiGuide(goal, shown);
      } catch (e) {
        return alive() ? fail(String(e)) : undefined;
      }
      if (!alive()) return;
      void aiPrime();
      const target = s.target;
      setGuide({ say: s.say, step: s.step, target, n: target ? n : 0, debug: s.debug });
      if (s.step === "done") {
        say(s.say);
        stageRef.current?.play("celebrate", true);
        window.setTimeout(() => guideRun.current === id && stopGuide(), 6000);
        return;
      }
      say(s.say);
      if (!target) {
        // Nothing to point at yet (a page loading, something to open first): look again shortly.
        if (++misses >= 8) return stopGuide("I can't find the next step — ask me again when you're ready.");
        await pause(5000);
        continue;
      }
      misses = 0;
      // Wait for your click on it (and, for a text box, for you to finish typing).
      const [l, t, r, b] = target.phys;
      const inside = (x: number, y: number) => x >= l - 24 && x <= r + 24 && y >= t - 24 && y <= b + 24;
      const typing = s.step === "type";
      const started = Date.now();
      let pressed = false;
      let clickedAt = 0;
      let typedAfter = false;
      let outcome: "clicked" | "elsewhere" | "timeout" = "timeout";
      while (alive() && Date.now() - started < 60_000) {
        await pause(70);
        const m = await guideMouse().catch(() => null);
        if (!m) continue;
        if (m.down) pressed = true;
        else if (pressed) {
          pressed = false;
          if (inside(m.x, m.y)) {
            if (!typing) {
              outcome = "clicked";
              break;
            }
            clickedAt = Date.now();
          } else if (!clickedAt) {
            outcome = "elsewhere";
            break;
          }
        }
        if (typing && clickedAt) {
          if (Date.now() - clickedAt > 500 && m.idle_ms < 400) typedAfter = true;
          if (typedAfter && m.idle_ms >= 2000) {
            outcome = "clicked";
            break;
          }
        }
      }
      if (!alive()) return;
      if (outcome === "timeout") {
        // Nobody touched anything for a minute: look again once or twice, then stop.
        const m = await guideMouse().catch(() => null);
        quiet = m && m.idle_ms > 50_000 ? quiet + 1 : 0;
        if (quiet >= 3) return stopGuide("Still there? I'll stop pointing — ask me again anytime.");
        continue;
      }
      if (outcome === "clicked") {
        shown.push(s.say);
        n++;
      }
      await pause(outcome === "clicked" ? 1500 : 1200); // let the page react before looking again
    }
    if (alive()) stopGuide("That's as far as I'll go — ask me again if you need more.");
  };

  const doAsk = async (question: string, typed = true) => {
    guideRun.current = 0; // a new request ends the old guide
    setGuide(null);
    setAsk({ step: "thinking", question, looking: false });
    expRef.current = "";
    if (typed) {
      heardRef.current = false;
      // Typing goes back to the app you were in, and the box is gone before any screenshot.
      await releaseFocus();
    }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    try {
      // 1. Bond's own understanding: instant, no AI call.
      const own = understand(question);
      // What he understood on his own is a sure example for the brain to learn from.
      if (own?.kind === "log") {
        await logToJournal(own.text);
        void recordOwn(question, { intent: "log", text: own.text });
        return confirm("Logged in your journal ✓");
      }
      if (own?.kind === "idea") {
        addIdea(own.text);
        void recordOwn(question, { intent: "idea", text: own.text });
        return confirm("Idea saved ✓");
      }
      if (own?.kind === "do") {
        try {
          const outcome = await runActions(own.actions);
          expRef.current = await recordOwn(question, { intent: "task", actions: own.actions });
          return showOutcome(question, outcome);
        } catch {
          /* e.g. no app by that name: let the AI work out what was meant */
        }
      }
      if (own?.kind === "clipboard") {
        const copied = await clipboardText();
        const reply = await aiText(CLIPBOARD_SYSTEM, `${question}\n\n--- Clipboard ---\n${copied.slice(0, 20_000)}`);
        return answer(question, reply, [], true);
      }
      if (own?.kind === "screen" && own.mode === "guide") return await runGuide(question);
      if (own?.kind === "screen") return await lookAtScreen(question, own.mode);

      // 2. Not sure: the AI classifies it (text only), and runs simple tasks right away.
      const r = await routeCommand(question, heardRef.current);
      expRef.current = r.exp_id;
      switch (r.intent) {
        case "log":
          await logToJournal(r.text || question);
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
          return showOutcome(question, r.outcome ?? { done: [], info: [], pending: null }, r.reply);
        default:
          return answer(question, r.reply, [], true);
      }
    } catch (e) {
      setAsk({ step: "error", question, error: String(e) });
      stageRef.current?.play("annoyed", true);
      autoClose();
    }
  };

  // --- Bond notices ------------------------------------------------------------------------
  // Spot a moment (notice*), keep it until a natural pause (deliverSuggestion), then show it
  // in his card. How each one went goes back to his log, which decides whether he makes it
  // again.

  /** Keep a suggestion for the next natural pause, if your settings and his log allow it. */
  const offer = async (s: Suggestion) => {
    const st = settingsRef.current;
    if (!LEVEL_KINDS[st.notice].includes(s.kind)) return;
    if (blockedBy(activityRef.current, st.noticeBlock)) return;
    if (!(await noticeAllowed(s.key, LEVEL_GAP_MIN[st.notice].same))) return;
    pendingRef.current = s; // the newest moment wins
  };

  /** Several searches while working: ask the brain for a tip (it may look at the screen). */
  const noticeStuck = async () => {
    const st = settingsRef.current;
    if (!LEVEL_KINDS[st.notice].includes("stuck")) return;
    const queries = stuckRef.current.stuck(st.notice);
    if (!queries) return;
    stuckRef.current.clear();
    if (!(await noticeAllowed("stuck", LEVEL_GAP_MIN[st.notice].same))) return;
    const details = queries.length
      ? `They searched the web ${queries.length} times in the last few minutes while working: ${queries.map((q) => `"${q}"`).join(", ")}.`
      : "They keep reading Q&A pages (Stack Overflow, GitHub issues) while working.";
    const j = await noticeJudge(details, st.noticeLook, blockList());
    if (j.judged && !j.suggest) return; // the brain had nothing specific: stay quiet
    await offer({
      key: "stuck",
      kind: "stuck",
      text: j.suggest ? j.text : stuckFallback(queries),
      primary: { label: "Look at my screen", does: "look" },
      at: Date.now(),
    });
  };

  /** During a pause in an editor or terminal (at most every 30 s): an error on screen? */
  const scanForError = async () => {
    const st = settingsRef.current;
    const scan = scanRef.current;
    if (!LEVEL_KINDS[st.notice].includes("error") || pendingRef.current || Date.now() - scan.at < SCAN_EVERY_MS) return;
    if (ctxRef.current !== "focus" || !naturalPause({ idleSec: idleRef.current, ctx: ctxRef.current, busy: !!askRef.current, inBreak: coachBreakRef.current() })) return;
    if (blockedBy(activityRef.current, st.noticeBlock)) return;
    scan.at = Date.now();
    const snippet = await noticeScan(blockList());
    if (!snippet || snippet === scan.last) return;
    scan.last = snippet; // the same error stays on screen: say it once
    await noticeError(snippet, "screen");
  };

  /** You copied an error (or one is on screen): a quick explanation, the full one a click away. */
  const noticeError = async (text: string, from: "clipboard" | "screen" = "clipboard") => {
    const st = settingsRef.current;
    if (!LEVEL_KINDS[st.notice].includes("error")) return;
    const app = (activityRef.current?.name ?? "").toLowerCase();
    const key = `error@${app}`;
    if (!(await noticeAllowed(key, LEVEL_GAP_MIN[st.notice].same))) return;
    const what = from === "screen" ? `This error is showing in ${activityRef.current?.name ?? "their window"}` : "They just copied this error";
    const j = await noticeJudge(`${what}:\n${text.slice(0, 3000)}`, false, blockList());
    if (j.judged && !j.suggest) return;
    await offer({ key, kind: "error", text: j.suggest ? j.text : errorFallback, primary: { label: "Explain more", does: "explain" }, clip: text, at: Date.now() });
  };

  /** Something you usually ask for in this app (or at this time), not done yet today. */
  const noticeHabit = async (a: Activity) => {
    if (!LEVEL_KINDS[settingsRef.current.notice].includes("habit")) return;
    const cache = habitsRef.current;
    if (Date.now() - cache.at > 10 * 60_000) habitsRef.current = { list: await noticeHabits(), at: Date.now() };
    const hour = new Date().getHours();
    const h = habitsRef.current.list.find((x) => !x.done_today && (x.app ? x.app === a.name : x.hour === hour));
    if (!h) return;
    await offer({ key: h.key, kind: "habit", text: habitText(h.label, h.app, h.hour), primary: { label: "Yes, do it", does: "actions" }, actions: h.actions, at: Date.now() });
  };

  const blockList = () =>
    settingsRef.current.noticeBlock
      .split(",")
      .map((w) => w.trim())
      .filter(Boolean);

  /** On every idle tick: show what's waiting if this is a good moment. */
  const deliverSuggestion = async () => {
    const s = pendingRef.current;
    if (!s) return;
    const st = settingsRef.current;
    if (Date.now() - s.at > SUGGESTION_TTL_MS || st.notice === "off") {
      pendingRef.current = null;
      return;
    }
    const moment = { idleSec: idleRef.current, ctx: ctxRef.current, busy: !!askRef.current || stageRef.current?.busy === true, inBreak: coachBreakRef.current() };
    if (!naturalPause(moment) || (st.quietOn && inQuietHours(new Date(), st.quietFrom, st.quietTo))) return;
    if (blockedBy(activityRef.current, st.noticeBlock) || !pacerRef.current.canShow(st.notice, st.noticeMaxPerHour)) return;
    pendingRef.current = null;
    pacerRef.current.shown();
    noticeIdRef.current = await noticeShown(s.key, s.text);
    const stage = stageRef.current;
    if (stage && !stage.visible && !stage.busy) await stage.webDrop(homeX());
    wake(25_000);
    stage?.play("wave", true);
    setAsk({ step: "suggest", suggestion: s });
    clearTimeout(askTimer.current);
    askTimer.current = window.setTimeout(() => void closeAsk(), 20_000); // let pass = ignored
  };

  const takeSuggestion = async () => {
    const cur = askRef.current;
    if (cur?.step !== "suggest") return;
    const s = cur.suggestion;
    void giveFeedback(noticeIdRef.current, "good");
    clearTimeout(askTimer.current);
    try {
      if (s.primary.does === "actions" && s.actions) {
        setAsk({ step: "thinking", question: s.text, looking: false });
        const outcome = await runActions(s.actions as Parameters<typeof runActions>[0]);
        void recordOwn(s.text, { intent: "task", actions: s.actions }); // counts as done today
        return showOutcome(s.text, outcome);
      }
      if (s.primary.does === "explain" && s.clip) {
        const question = "Explain this error and how to fix it";
        setAsk({ step: "thinking", question, looking: false });
        const reply = await aiText(CLIPBOARD_SYSTEM, `${question}\n\n--- Clipboard ---\n${s.clip.slice(0, 20_000)}`);
        return answer(question, reply, [], true);
      }
      await lookAtScreen("I seem to be stuck. What's going on, and how do I fix it?", "help");
    } catch (e) {
      setAsk({ step: "error", question: s.text, error: String(e) });
      stageRef.current?.play("annoyed", true);
      autoClose();
    }
  };

  const dismissSuggestion = (never: boolean) => {
    if (askRef.current?.step !== "suggest") return;
    void giveFeedback(noticeIdRef.current, never ? "bad" : "ignored");
    clearTimeout(askTimer.current);
    setAsk(null);
    if (never) confirm("Okay, I won't suggest that again.");
    else wake();
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
  const awake = hover || busy || touched || menu || following || !!ask || !!guide || phase === "arriving" || phase === "offering";
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
            if (inTauri) void invoke("open_dashboard");
          }}
          onApprove={(id, alt) => void approve(id, alt)}
          onDeny={(id) => void deny(id)}
          onWantFocus={() => void takeFocus()}
          onTake={() => void takeSuggestion()}
          onNotNow={() => dismissSuggestion(false)}
          onNever={() => dismissSuggestion(true)}
          onRate={
            ask.step === "answer" && expRef.current
              ? (value: Feedback) => {
                  void giveFeedback(expRef.current, value);
                  setAsk({ ...ask, rated: value });
                  if (value === "bad") stageRef.current?.play("nod", true);
                }
              : null
          }
          onItsMe={async () => {
            setAsk({ step: "thinking", question: "", looking: false });
            heardRef.current = true;
            try {
              await wakeConfirmYou();
            } catch (e) {
              setAsk({ step: "error", question: "", error: String(e) });
            }
          }}
          onNotMe={() => {
            void wakeNotYou();
            void closeAsk();
          }}
          onOpen={(page) => {
            if (inTauri) void invoke("open_dashboard", { page });
            closeAsk();
          }}
          onSnooze={async (r, min) => {
            try {
              await snoozeReminder(r.text, min);
              confirm(`Snoozed for ${min} min`);
            } catch (e) {
              setAsk({ step: "error", question: r.text, error: String(e) });
            }
          }}
        />
      )}
      {guide && <Guide view={guide} origin={guideFrom} showDebug={settingsRef.current.guideDebug} tipRef={guideTipRef} onStop={() => stopGuide()} />}
      {menu && <ActionMenu menuRef={menuRef} sitting={stageRef.current?.currentPose === "sit"} following={following} inBreak={phase !== "idle"} laterMin={settingsRef.current.snoozeMin} onPick={act} />}
    </>
  );
}
