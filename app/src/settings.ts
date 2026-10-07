// User settings, edited in the dashboard and applied live by the overlay.
// Stored in localStorage, which both windows of the app share.

import { emit } from "@tauri-apps/api/event";
import { inTauri } from "./platform";

export interface Settings {
  /** Bring water breaks automatically. */
  breaksOn: boolean;
  /** Minutes of active laptop use between breaks. */
  breakEveryMin: number;
  /** "Later" puts the break off by this many minutes; then he comes back with the bottle. */
  snoozeMin: number;
  /** Glasses of water per day. */
  waterGoal: number;
  /** Which AI the user's own key is for. Gemini has a free tier. */
  aiProvider: "gemini" | "claude";
  /** Preferred Gemini model, or "auto" (a chain of free models, busy ones skipped). */
  geminiModel: string;
  /** Read Bond's answers aloud. */
  speakAnswers: boolean;
  /** Seconds an answer stays on screen before it closes by itself. */
  answerSeconds: number;
  /** Nudge when you've been brainstorming/chatting with AI a long time without building. */
  brainstormAlert: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  breaksOn: true,
  breakEveryMin: 45,
  snoozeMin: 10,
  waterGoal: 8,
  aiProvider: "gemini",
  geminiModel: "auto",
  speakAnswers: true,
  answerSeconds: 12,
  brainstormAlert: true,
};

const KEY = "selfglance.settings";

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Save and tell the overlay so the change applies right away. */
export async function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* not persisted */
  }
  if (inTauri) await emit("settings-changed", s);
}
