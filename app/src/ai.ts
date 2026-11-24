// Frontend side of Bond's brain, voice and small jobs. Every request is made by Rust and answered on
// this laptop (brain.rs, voice.rs): nothing is sent to any cloud service.

import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "./platform";
import { loadSettings } from "./settings";
import type { Action } from "./assistant/intent";
import { sentences, speakable } from "./assistant/speech";

/** What a small job did: short lines, and longer text to read (file search results, laptop status). */
export interface Outcome {
  done: string[];
  info: string[];
}

/** The brain's reading of a request the rules couldn't place. A task has already been done. */
export interface Route {
  intent: "idea" | "task" | "chat";
  outcome: Outcome | null;
}

/** Load the brain and have it read its instructions while you type or speak. */
export const aiPrime = () => (inTauri ? invoke<void>("ai_prime").catch(() => {}) : Promise.resolve());
export const voiceWarm = () => (inTauri ? invoke<void>("voice_warm").catch(() => {}) : Promise.resolve());
export const routeCommand = (text: string, spoken = false) => invoke<Route>("ai_route", { text, spoken });
export const goalJudge = (goals: string[], items: { app: string; label: string }[], blocked: string[]) =>
  inTauri ? invoke<string[]>("goal_judge", { goals, items, blocked }).catch(() => [] as string[]) : Promise.resolve([] as string[]);
export const runActions = (actions: Action[]) => invoke<Outcome>("agent_run", { actions });
export const cancelAgent = () => (inTauri ? invoke<void>("agent_cancel").catch(() => {}) : Promise.resolve());
/** Where your projects live, for "open claude code in …" and file search. Returns the folders kept. */
export const setProjectRoots = (roots: string[]) => (inTauri ? invoke<string[]>("set_project_roots", { roots }).catch(() => [] as string[]) : Promise.resolve([] as string[]));

// --- Memory: About you and the recent conversation (memory.rs) --------------------------------

export const memoryProfile = (text: string) => (inTauri ? invoke<void>("memory_profile", { text }).catch(() => {}) : Promise.resolve());
export const memoryList = () => (inTauri ? invoke<string[]>("memory_list").catch(() => []) : Promise.resolve([]));
export const memoryForget = (fact: string | null) => invoke<void>("memory_forget", { fact });
export interface MemoryUsage {
  facts: number;
  conversations: number;
  bytes: number;
}
export const memoryUsage = () => (inTauri ? invoke<MemoryUsage>("memory_usage").catch(() => null) : Promise.resolve(null));
export const memoryForgetConversations = () => invoke<void>("memory_forget_conversations");
export const memoryKeep = (on: boolean) => (inTauri ? invoke<void>("memory_keep", { on }).catch(() => {}) : Promise.resolve());


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

export const brainStatus = () => invoke<BrainStatus>("brain_status");
export const brainInstall = () => invoke<void>("brain_install");
/** Start loading the model now, so the answer comes quickly. */
export const brainWarm = () => (inTauri ? invoke<void>("brain_warm").catch(() => {}) : Promise.resolve());
export const brainStop = () => invoke<void>("brain_stop");

export const captureHideByDefault = (hide: boolean) => (inTauri ? invoke<boolean>("capture_hide_by_default", { hide }).catch(() => hide) : Promise.resolve(hide));
/** "Include yourself in the screenshot" (show) or hide again. Resolves to whether he is hidden from captures now. */
export const captureShow = (show: boolean) => (inTauri ? invoke<boolean>("capture_show", { show }).catch(() => true) : Promise.resolve(!show));

/** Give the keyboard back to the app you were using. */
export const releaseFocus = () => (inTauri ? invoke<void>("release_focus").catch(() => {}) : Promise.resolve());

let current: HTMLAudioElement | null = null;
let speakToken = 0;
let speaking = false;

/** Whether Bond is still saying something (a card waits for him to finish before closing). */
export const isSpeaking = () => speaking;

/** Stop whatever Bond is saying. */
export function stopSpeaking() {
  speakToken++;
  speaking = false;
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

/** A line in Bond's diagnostics log (logs/bond.log in the app data folder). */
export const diag = (line: string) => (inTauri ? void invoke("diag_log", { line }).catch(() => {}) : undefined);

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

/** Bond's own voice: piece by piece (speech.ts), the next one prepared while this one plays. */
async function bondVoice(text: string, token: number) {
  const { voiceId, voiceSpeed } = loadSettings();
  const parts = sentences(text);
  const t0 = Date.now();
  let next = voiceSay(parts[0], voiceId, voiceSpeed);
  for (let i = 0; i < parts.length; i++) {
    const wav = await next;
    if (token !== speakToken) return;
    if (i === 0) diag(`voice: first sound ready ${Date.now() - t0} ms after the answer (${parts[0].length} characters)`);
    if (i + 1 < parts.length) next = voiceSay(parts[i + 1], voiceId, voiceSpeed);
    await play(wav, token);
  }
}

/**
 * Speak an answer, in the voice chosen in Settings: Bond's own (on this laptop) or one of
 * Windows' own voices. Falls back to Windows' voice.
 */
export async function speak(text: string) {
  stopSpeaking();
  const token = speakToken;
  text = speakable(text);
  if (!text) return;
  speaking = true;
  try {
    await speakWith(text, token);
  } finally {
    if (token === speakToken) speaking = false;
  }
}

/** Plain talk: the answer arrives piece by piece as `chat-piece` events (id = this request), then whole. */
export const aiChat = (text: string, spoken: boolean, id: number) => invoke<string>("ai_chat", { text, spoken, id });

/**
 * Speak an answer while it is still being written: each piece is said in order, the next one made
 * ready while one plays. `end()` resolves when the last piece has been said (or he was stopped).
 */
export function speakStream(): { push(text: string): void; end(): Promise<void> } {
  stopSpeaking();
  const token = speakToken;
  speaking = true;
  let made: Promise<unknown> = Promise.resolve(); // one piece is synthesized at a time
  let said: Promise<void> = Promise.resolve();
  return {
    push(piece: string) {
      const text = speakable(piece);
      if (!text || token !== speakToken) return;
      const own = inTauri && loadSettings().voice === "bond";
      const { voiceId, voiceSpeed } = loadSettings();
      const wav = own ? (made = made.then(() => (token === speakToken ? voiceSay(text, voiceId, voiceSpeed) : null)).catch(() => null)) : Promise.resolve(null);
      said = said.then(async () => {
        if (token !== speakToken) return;
        const b64 = (await wav) as string | null;
        if (token !== speakToken) return;
        if (b64) await play(b64, token).catch(() => {});
        else await systemVoice(text);
      });
    },
    async end() {
      await said;
      if (token === speakToken) speaking = false;
    },
  };
}

async function speakWith(text: string, token: number) {
  const choice = loadSettings().voice;
  if (inTauri && choice === "bond") {
    try {
      await bondVoice(text, token);
      return;
    } catch {
      if (token !== speakToken) return;
    }
  }
  await systemVoice(text);
}

function systemVoice(text: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      // Only voices installed on this laptop: the "Online" ones stream the text to Microsoft.
      const voices = window.speechSynthesis.getVoices().filter((v) => v.localService);
      if (!voices.length) return resolve(); // none installed: stay silent rather than send text away
      const pick =
        voices.find((v) => /aria|jenny|guy|zira|samantha|daniel/i.test(v.name) && v.lang.startsWith("en")) ??
        voices.find((v) => v.lang.startsWith("en"));
      const u = new SpeechSynthesisUtterance(text);
      if (pick) u.voice = pick;
      u.rate = 1;
      u.pitch = 1;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      window.speechSynthesis.speak(u);
    } catch {
      resolve(); // no speech engine
    }
  });
}
