// Frontend side of the AI features. Every request is made by Rust (src-tauri/src/ai.rs):
// Bond's own brain on this laptop (brain.rs), or a cloud AI with the key from the OS
// keychain. What he learns from you is kept by experience.rs.

import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "./platform";
import { loadSettings } from "./settings";
import type { Action, ScreenMode } from "./assistant/intent";
import { sentences } from "./assistant/speech";

export type Provider = "local" | "gemini" | "claude";

/** Something powerful Bond wants to do, shown in full before anything happens. */
export interface Approval {
  id: string;
  kind: "command" | "delete" | "kill";
  /** Which yes this is: deletions (and commands that delete) need a second one. */
  step: number;
  steps: number;
  title: string;
  items: string[];
  why: string;
  button: string;
  /** Thumbnails of the pictures about to be deleted (base64 JPEG). */
  previews: { name: string; jpeg: string }[];
}

/** What a plan of actions did: short lines, longer text to read, maybe a pending approval. */
export interface Outcome {
  done: string[];
  info: string[];
  pending: Approval | null;
}

export interface Route {
  intent: "log" | "idea" | "task" | "screen" | "help" | "chat" | string;
  text: string;
  reply: string;
  needs_screen: boolean;
  /** What the actions did (simple tasks run right away). */
  outcome: Outcome | null;
  /** This request in Bond's experience log, for 👍 / 👎 ("" when learning is off). */
  exp_id: string;
}

export interface ScreenAnswer {
  answer: string;
  outcome: Outcome | null;
  exp_id: string;
}

export interface Reminder {
  id: string;
  text: string;
  /** Due time, ms epoch. */
  at: number;
  /** A dashboard page the card offers to open ("journal"). */
  open?: "journal";
}

const opts = () => {
  const s = loadSettings();
  return { provider: s.aiProvider, geminiModel: s.geminiModel };
};

export const hasKey = (provider: Provider) => (inTauri ? invoke<boolean>("ai_has_key", { provider }) : Promise.resolve(false));
export const setKey = (provider: Provider, key: string) => invoke<void>("ai_set_key", { provider, key });

export const aiText = (system: string, prompt: string) => invoke<string>("ai_text", { ...opts(), system, prompt });

/** Let the AI classify a command Bond couldn't place himself (text only, no screenshot). */
/** `spoken`: it came from the microphone, so words may be misheard. */
export const routeCommand = (text: string, spoken = false) => invoke<Route>("ai_route", { ...opts(), text, spoken });

/** Look at the screen now: explain it, help when stuck, or do a task on it. */
export const screenAsk = (question: string, mode: ScreenMode, spoken = false) => invoke<ScreenAnswer>("ai_screen", { ...opts(), question, mode, spoken });

/** What Bond remembers about you (memory.json), and forgetting it. */
export const memoryList = () => (inTauri ? invoke<string[]>("memory_list").catch(() => []) : Promise.resolve([]));
export const memoryForget = (fact: string | null) => invoke<void>("memory_forget", { fact });

/** Run actions Bond understood on his own. */
export const runActions = (actions: Action[]) => invoke<Outcome>("agent_run", { actions });

/** Yes to a pending approval: the next step (a second confirmation) or the result. */
export const approveAction = (id: string) => invoke<Outcome>("agent_approve", { id });
export const denyAction = (id: string) => (inTauri ? invoke<void>("agent_deny", { id }).catch(() => {}) : Promise.resolve());

/** Let the overlay take the keyboard (typing a confirmation). */
export const takeFocus = () => (inTauri ? invoke<void>("take_focus").catch(() => {}) : Promise.resolve());

export const clipboardText = () => invoke<string>("clipboard_text");

export const listReminders = () => (inTauri ? invoke<Reminder[]>("reminders_list") : Promise.resolve([] as Reminder[]));
export const addReminder = (text: string, at: number) => invoke<Reminder>("reminder_add", { text, at });
export const removeReminder = (id: string) => invoke<void>("reminder_remove", { id });
export const snoozeReminder = (text: string, minutes: number) => invoke<Reminder>("reminder_snooze", { text, minutes });

// --- Bond's own brain ------------------------------------------------------------------------

export interface BrainStatus {
  supported: boolean;
  installed: boolean;
  running: boolean;
  installing: boolean;
  model: string;
}

/** Download progress (`brain-progress` event). */
export interface BrainProgress {
  what: string;
  done: number;
  total: number;
}

export interface LearnStats {
  total: number;
  good: number;
  bad: number;
  trainable: number;
}

export type Feedback = "good" | "bad" | "declined" | "ignored";

export const brainStatus = () => invoke<BrainStatus>("brain_status");
export const brainInstall = () => invoke<void>("brain_install");
/** Start loading the model now, so the answer comes quickly. */
export const brainWarm = () => (inTauri ? invoke<void>("brain_warm").catch(() => {}) : Promise.resolve());
export const brainStop = () => invoke<void>("brain_stop");

export const setLearning = (on: boolean) => (inTauri ? invoke<void>("brain_set_learning", { on }).catch(() => {}) : Promise.resolve());
export const giveFeedback = (id: string, value: Feedback) =>
  inTauri && id ? invoke<void>("brain_feedback", { id, value }).catch(() => {}) : Promise.resolve();
/** Something Bond understood on his own: a sure example to learn from. Returns its id. */
export const recordOwn = (input: string, output: object, ok = true, error?: string) =>
  inTauri ? invoke<string>("brain_record", { input, output, ok, error: error ?? null }).catch(() => "") : Promise.resolve("");
export const learnStats = () => invoke<LearnStats>("brain_learn_stats");
export const forgetLearned = () => invoke<void>("brain_forget");
/** Write what he learned as a fine-tuning dataset; returns the file path. */
export const exportLearned = () => invoke<string>("brain_export");

// --- Bond notices (suggestions he makes on his own) --------------------------------------

export interface Habit {
  key: string;
  app: string | null;
  hour: number | null;
  actions: Action[];
  label: string;
  days: number;
  done_today: boolean;
}

export interface Judgement {
  /** The local brain looked at it (false: no brain here, private window, low battery). */
  judged: boolean;
  suggest: boolean;
  text: string;
}

export const noticeEnable = (on: boolean) => (inTauri ? invoke<void>("notice_enable", { on }).catch(() => {}) : Promise.resolve());
export const noticeHabits = () => (inTauri ? invoke<Habit[]>("notice_habits").catch(() => [] as Habit[]) : Promise.resolve([] as Habit[]));
export const noticeAllowed = (key: string, minGapMin: number) =>
  inTauri ? invoke<{ allowed: boolean; reason: string }>("notice_allowed", { key, minGapMin }).then((r) => r.allowed).catch(() => false) : Promise.resolve(false);
/** He made a suggestion; returns its id for how it went (giveFeedback). */
export const noticeShown = (key: string, text: string) => (inTauri ? invoke<string>("notice_shown", { key, text }).catch(() => "") : Promise.resolve(""));
/** Ask the on-device brain whether there's something useful to say. */
export const noticeJudge = (details: string, look: boolean, blocked: string[]) =>
  inTauri
    ? invoke<Judgement>("notice_judge", { details, look, blocked }).catch((): Judgement => ({ judged: false, suggest: false, text: "" }))
    : Promise.resolve<Judgement>({ judged: false, suggest: false, text: "" });

/** The error showing in the window you're working in, if any (read on-device). */
export const noticeScan = (blocked: string[]) => (inTauri ? invoke<string | null>("notice_scan", { blocked }).catch(() => null) : Promise.resolve(null));

/** Give the keyboard back to the app you were using. */
export const releaseFocus = () => (inTauri ? invoke<void>("release_focus").catch(() => {}) : Promise.resolve());

let current: HTMLAudioElement | null = null;
let speakToken = 0;

/** Stop whatever Bond is saying. */
export function stopSpeaking() {
  speakToken++;
  current?.pause();
  current = null;
  try {
    window.speechSynthesis.cancel();
  } catch {
    /* no speech engine */
  }
}

// --- Bond's own voice and ears (voice.rs) -----------------------------------------------

export interface VoiceStatus {
  installed: boolean;
  installing: boolean;
  listening: boolean;
}

export const voiceStatus = () =>
  inTauri ? invoke<VoiceStatus>("voice_status").catch((): VoiceStatus => ({ installed: false, installing: false, listening: false })) : Promise.resolve<VoiceStatus>({ installed: false, installing: false, listening: false });
export const voiceInstall = () => invoke<void>("voice_install");
/** Listen until you go quiet; the text arrives as the `voice-heard` event. */
export const voiceListen = () => (inTauri ? invoke<void>("voice_listen").catch(() => {}) : Promise.resolve());
export const voiceListenStop = () => (inTauri ? invoke<void>("voice_listen_stop").catch(() => {}) : Promise.resolve());
const voiceSay = (text: string, voice: number, speed: number) => invoke<string>("voice_say", { text, voice, speed });

// --- "Hey Bond" and voice match (wake.rs) ------------------------------------------------

export interface WakeStatus {
  installed: boolean;
  enrolled: boolean;
  enabled: boolean;
  listening: boolean;
  /** Your voiceprint's bar (0-1), and the latest checks against it: [score, accepted]. */
  threshold: number | null;
  recent: [number, boolean][];
  /** What to read when teaching him your voice. */
  lines: string[];
}

export interface EnrollStep {
  heard: boolean;
  count: number;
  needed: number;
}

/** A line in Bond's diagnostics log (logs/bond.log in the app data folder). */
export const diag = (line: string) => (inTauri ? void invoke("diag_log", { line }).catch(() => {}) : undefined);

export const wakeStatus = () => (inTauri ? invoke<WakeStatus>("wake_status").catch(() => null) : Promise.resolve(null));
export const wakeInstall = () => invoke<void>("wake_install");
/** Turn "Hey Bond" on or off; voiceMatch: answer only your voice. */
export const wakeSet = (enabled: boolean, voiceMatch: boolean) => (inTauri ? invoke<void>("wake_set", { enabled, voiceMatch }) : Promise.resolve());
/** After answering out loud: take a follow-up without the wake word for a few seconds. */
export const wakeFollowUp = (seconds: number) => (inTauri ? invoke<void>("wake_follow_up", { seconds }).catch(() => {}) : Promise.resolve());
export const wakeEnrollRecord = () => invoke<EnrollStep>("wake_enroll_record");
export const wakeEnrollSave = () => invoke<void>("wake_enroll_save");
export const wakeEnrollCancel = () => (inTauri ? invoke<void>("wake_enroll_cancel").catch(() => {}) : Promise.resolve());
export const wakeForgetVoice = () => invoke<void>("wake_forget_voice");
/** "Was that you?" → yes: he learns that sample and does the request. */
export const wakeConfirmYou = () => invoke<void>("wake_confirm_you");
export const wakeNotYou = () => (inTauri ? invoke<void>("wake_not_you").catch(() => {}) : Promise.resolve());

/** Play base64 WAV; resolves when it ends (or is stopped). */
function play(b64: string, token: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (token !== speakToken) return resolve();
    const audio = new Audio(`data:audio/wav;base64,${b64}`);
    current = audio;
    audio.onended = () => resolve();
    audio.onpause = () => resolve();
    audio.play().catch(reject);
  });
}

/** Bond's own voice: a sentence at a time, the next one prepared while this one plays. */
async function bondVoice(text: string, token: number) {
  const { voiceId, voiceSpeed } = loadSettings();
  const parts = sentences(text);
  let next = voiceSay(parts[0], voiceId, voiceSpeed);
  for (let i = 0; i < parts.length; i++) {
    const wav = await next;
    if (token !== speakToken) return;
    if (i + 1 < parts.length) next = voiceSay(parts[i + 1], voiceId, voiceSpeed);
    await play(wav, token);
  }
}

/**
 * Speak an answer, in the voice chosen in Settings: Bond's own (on this laptop), Google's
 * (needs the Gemini key; ~3-5 s to arrive), or Windows'. Falls back to Windows' voice.
 */
export async function speak(text: string) {
  stopSpeaking();
  const token = speakToken;
  const choice = loadSettings().voice;
  if (inTauri && choice === "bond") {
    try {
      await bondVoice(text, token);
      return;
    } catch {
      if (token !== speakToken) return;
    }
  }
  if (inTauri && (choice === "google" || choice === "bond")) {
    try {
      const b64 = await invoke<string>("ai_speak", { text });
      if (token !== speakToken) return; // closed or replaced meanwhile
      current = new Audio(`data:audio/wav;base64,${b64}`);
      await current.play();
      return;
    } catch {
      if (token !== speakToken) return;
    }
  }
  systemVoice(text);
}

function systemVoice(text: string) {
  try {
    const voices = window.speechSynthesis.getVoices();
    // Prefer neural "Natural"/"Online" voices, then any English voice.
    const pick =
      voices.find((v) => /natural|online/i.test(v.name) && v.lang.startsWith("en")) ??
      voices.find((v) => /aria|jenny|guy|zira|samantha|daniel/i.test(v.name)) ??
      voices.find((v) => v.lang.startsWith("en"));
    const u = new SpeechSynthesisUtterance(text);
    if (pick) u.voice = pick;
    u.rate = 1;
    u.pitch = 1;
    window.speechSynthesis.speak(u);
  } catch {
    /* no speech engine */
  }
}
