// User settings, edited in the dashboard and applied live by the overlay.
// Stored in localStorage, which both windows of the app share.

import { emit } from "@tauri-apps/api/event";
import { inTauri } from "./platform";

export interface Settings {
  /** Bring a break (stand up, drink water) after about 50 minutes of sitting. */
  breaksOn: boolean;
  /** Read Bond's answers aloud. */
  speakAnswers: boolean;
  /** Whose voice: Bond's own on this laptop, or one of Windows' own voices. */
  voice: "bond" | "system";
  /** Kokoro speaker id for Bond's own voice (18 = Puck). */
  voiceId: number;
  /** 1 = normal speed. */
  voiceSpeed: number;
  /** The dashboard's look: follow Windows, or always light or dark. */
  theme: "system" | "light" | "dark";
  /** Leave Bond out of screenshots and screen recordings (you still see him). */
  hideFromCaptures: boolean;
  /** Seconds an answer stays on screen before it closes by itself. */
  answerSeconds: number;
  /** Say so when about ten minutes in a row went to something not on today's list. */
  goalNudge: boolean;
  /** Keep the recent conversation, so "close it" knows what "it" is (Settings → Memory). */
  keepChats: boolean;
  /** Where your projects are, for "open claude code in …" and finding files. One folder per line. */
  projectFolders: string;
}

export const DEFAULT_SETTINGS: Settings = {
  breaksOn: true,
  speakAnswers: true,
  voice: "bond",
  voiceId: 18,
  voiceSpeed: 1,
  theme: "system",
  hideFromCaptures: true,
  answerSeconds: 12,
  goalNudge: true,
  keepChats: true,
  projectFolders: "D:\\",
};

const KEY = "selfglance.settings";

/** Only the settings that still exist; anything an older version saved is dropped. */
function known(raw: Record<string, unknown>): Settings {
  const out = { ...DEFAULT_SETTINGS } as unknown as Record<string, unknown>;
  for (const k of Object.keys(DEFAULT_SETTINGS)) if (k in raw && typeof raw[k] === typeof out[k]) out[k] = raw[k];
  return out as unknown as Settings;
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? known(JSON.parse(raw)) : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** The project folders as a list. */
export const projectRoots = (s: Settings) =>
  s.projectFolders
    .split(/\r?\n|;/)
    .map((l) => l.trim())
    .filter(Boolean);

/** Save and tell the overlay so the change applies right away. */
export async function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* not persisted */
  }
  if (inTauri) await emit("settings-changed", s);
}
