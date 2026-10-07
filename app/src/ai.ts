// Frontend side of the AI features. The API key lives in the OS keychain and every
// request is made by Rust (src-tauri/src/ai.rs); this file only asks Rust to run them.

import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "./platform";
import { loadSettings } from "./settings";

export type Provider = "gemini" | "claude";

export interface GuideAnswer {
  answer: string;
  point: [number, number] | null;
  label: string | null;
}

const opts = () => {
  const s = loadSettings();
  return { provider: s.aiProvider, geminiModel: s.geminiModel };
};

export const hasKey = (provider: Provider) => (inTauri ? invoke<boolean>("ai_has_key", { provider }) : Promise.resolve(false));
export const setKey = (provider: Provider, key: string) => invoke<void>("ai_set_key", { provider, key });

export const aiText = (system: string, prompt: string) => invoke<string>("ai_text", { ...opts(), system, prompt });

export const askBond = (question: string) => invoke<GuideAnswer>("ai_guide", { ...opts(), question });

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

/**
 * Speak an answer. Tries Google's natural voice (needs the Gemini key; ~3-5 s to arrive,
 * so the text is already on screen), then falls back to the best voice installed locally.
 */
export async function speak(text: string) {
  stopSpeaking();
  const token = speakToken;
  if (inTauri) {
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
