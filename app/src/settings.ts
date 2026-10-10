// User settings, edited in the dashboard and applied live by the overlay.
// Stored in localStorage, which both windows of the app share.

import { emit } from "@tauri-apps/api/event";
import { inTauri } from "./platform";
import type { NoticeLevel } from "./assistant/notice";

export interface Settings {
  /** Bring water breaks automatically. */
  breaksOn: boolean;
  /** Minutes of active laptop use between breaks. */
  breakEveryMin: number;
  /** "Later" puts the break off by this many minutes; then he comes back with the bottle. */
  snoozeMin: number;
  /** Glasses of water per day. */
  waterGoal: number;
  /** Bond's own brain on this laptop ("local"), or the cloud AI the user's own key is for. */
  aiProvider: "local" | "gemini" | "claude";
  /** Preferred Gemini model, or "auto" (a chain of free models, busy ones skipped). */
  geminiModel: string;
  /** Read Bond's answers aloud. */
  speakAnswers: boolean;
  /** Whose voice: Bond's own on this laptop, Google's (needs the Gemini key), or Windows'. */
  voice: "bond" | "google" | "system";
  /** Kokoro speaker id for Bond's own voice (18 = Puck). */
  voiceId: number;
  /** 1 = normal speed. */
  voiceSpeed: number;
  /** Seconds an answer stays on screen before it closes by itself. */
  answerSeconds: number;
  /** Nudge when you've been brainstorming/chatting with AI a long time without building. */
  brainstormAlert: boolean;
  /** Bond warns when the battery is low and the laptop isn't plugged in. */
  batteryAlert: boolean;
  /** In the evening, if today's journal is still empty, Bond asks you to write it. */
  journalNudge: boolean;
  /** From this hour (local time, 0-23). */
  journalAt: number;
  /** Keep what you ask and how it went, so Bond adapts to you (stays on this computer). */
  learnFromMe: boolean;
  /** Suggestions he makes on his own: off, only when you seem stuck, helpful, chatty. */
  notice: NoticeLevel;
  /** At most this many suggestions an hour. */
  noticeMaxPerHour: number;
  /** He may look at your screen (on-device brain only) when you seem stuck. */
  noticeLook: boolean;
  /** No suggestions between these hours (local time, 0-23). */
  quietOn: boolean;
  quietFrom: number;
  quietTo: number;
  /** Apps or window titles he never comments on (comma-separated words). */
  noticeBlock: string;
}

export const DEFAULT_SETTINGS: Settings = {
  breaksOn: true,
  breakEveryMin: 45,
  snoozeMin: 10,
  waterGoal: 8,
  aiProvider: "local",
  geminiModel: "auto",
  speakAnswers: true,
  voice: "bond",
  voiceId: 18,
  voiceSpeed: 1,
  answerSeconds: 12,
  brainstormAlert: true,
  batteryAlert: true,
  journalNudge: true,
  journalAt: 21,
  learnFromMe: true,
  notice: "helpful",
  noticeMaxPerHour: 3,
  noticeLook: true,
  quietOn: false,
  quietFrom: 22,
  quietTo: 8,
  noticeBlock: "",
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
