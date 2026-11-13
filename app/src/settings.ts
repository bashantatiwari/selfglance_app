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
  /** Read Bond's answers aloud. */
  speakAnswers: boolean;
  /** Whose voice: Bond's own on this laptop, or one of Windows' own voices. */
  voice: "bond" | "system";
  /** Kokoro speaker id for Bond's own voice (18 = Puck). */
  voiceId: number;
  /** 1 = normal speed. */
  voiceSpeed: number;
  /** Listen for "Hey Bond" all the time (the microphone stays on, nothing is recorded). */
  wakeWord: boolean;
  /** Answer only the voice he was taught (needs enrolment). */
  voiceMatch: boolean;
  /** After answering out loud, listen a few seconds for a follow-up without "Hey Bond". */
  followUp: boolean;
  /** The dashboard's look: follow Windows, or always light or dark. */
  theme: "system" | "light" | "dark";
  /**
   * Advanced actions: lets the AI run commands, end programs, type, click and write the clipboard
   * for you. Off by default: without it Bond does only the safe things
   * (see src-tauri/src/policy.rs).
   */
  advancedActions: boolean;
  /**
   * Labs: features that are still experimental ("Hey Bond", suggestions, learning from you, the
   * brainstorm nudge). Off by default; see effective().
   */
  labs: boolean;
  /** Leave Bond out of screenshots and screen recordings (you still see him). "Include yourself" shows him for a few minutes. */
  hideFromCaptures: boolean;
  /** Seconds an answer stays on screen before it closes by itself. */
  answerSeconds: number;
  /** Nudge when you've been brainstorming/chatting with AI a long time without building. */
  brainstormAlert: boolean;
  /** Bond warns when the battery is low and the laptop isn't plugged in. */
  batteryAlert: boolean;
  /** Keep what you ask and how it went, so Bond adapts to you (stays on this computer). */
  learnFromMe: boolean;
  /** Suggestions he makes on his own: off, only when you seem stuck, helpful, chatty. */
  notice: NoticeLevel;
  /** At most this many suggestions an hour. */
  noticeMaxPerHour: number;
  /** He may look at your screen (read on this laptop) when you seem stuck. */
  noticeLook: boolean;
  /** No suggestions between these hours (local time, 0-23). */
  quietOn: boolean;
  quietFrom: number;
  quietTo: number;
  /** Apps or window titles he never comments on (comma-separated words). */
  noticeBlock: string;
  /** Goals: say so when about ten minutes in a row went off today's goal. */
  goalNudge: boolean;
  /** Goals: on Sunday morning, look back on the week. */
  goalReview: boolean;
  /** Keep what you ask Bond and his answers, so you can find them again (Settings → Memory). */
  keepChats: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  breaksOn: true,
  breakEveryMin: 45,
  snoozeMin: 10,
  waterGoal: 8,
  speakAnswers: true,
  voice: "bond",
  voiceId: 18,
  voiceSpeed: 1,
  wakeWord: false,
  voiceMatch: true,
  followUp: true,
  advancedActions: false,
  labs: false,
  theme: "system",
  hideFromCaptures: true,
  answerSeconds: 12,
  brainstormAlert: false,
  batteryAlert: true,
  learnFromMe: false,
  notice: "off",
  noticeMaxPerHour: 3,
  noticeLook: false,
  quietOn: false,
  quietFrom: 22,
  quietTo: 8,
  noticeBlock: "",
  goalNudge: true,
  goalReview: true,
  keepChats: true,
};

const KEY = "selfglance.settings";

/**
 * Settings saved by older versions may still name a cloud brain or Google's voice. There is
 * no cloud any more: drop those choices (Bond's own brain and voice answer instead).
 */
function withoutCloud(s: Settings & Record<string, unknown>): Settings {
  delete s.aiProvider;
  delete s.geminiModel;
  if ((s.voice as string) === "google") s.voice = "bond";
  return s;
}

/**
 * What Bond actually does: the experimental features count only while Labs is on, whatever an
 * older version left saved (a copy updated from before Labs would otherwise keep listening for
 * "Hey Bond" and making suggestions). The dashboard shows and edits the saved values.
 */
export function effective(s: Settings): Settings {
  if (s.labs) return s;
  return { ...s, wakeWord: false, notice: "off", noticeLook: false, learnFromMe: false, brainstormAlert: false };
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? withoutCloud({ ...DEFAULT_SETTINGS, ...JSON.parse(raw) }) : { ...DEFAULT_SETTINGS };
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
