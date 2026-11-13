// Your day, recorded locally: which context (watching / working / ...) and what exactly
// (video title, project name, site) for how long. The dashboard reads this back.
//
// Stored per day in localStorage as a list of time segments. Consecutive ticks on the
// same thing extend the last segment, so a day stays small (hundreds of entries).

import type { Activity, Context } from "./context";

export interface Segment {
  start: number; // ms epoch
  end: number;
  ctx: Context;
  label: string; // "Lofi beats to study to", "selfglance", "Gmail"
  app: string; // "Google Chrome", "Visual Studio Code"
}

const MAX_SEGMENTS = 4000;
const MERGE_GAP_MS = 15_000; // same thing again within this gap = one continuous segment

export const dayKey = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `selfglance.log.${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

export function loadDay(d = new Date()): Segment[] {
  try {
    return JSON.parse(localStorage.getItem(dayKey(d)) ?? "[]");
  } catch {
    return [];
  }
}

export const LOG_EVENT = "selfglance:log";

/** Take stretches out of a day's record because you chose to forget them. Returns what went, for Undo. */
export function forgetSegments(d: Date, match: (s: Segment) => boolean): Segment[] {
  const all = loadDay(d);
  const gone = all.filter(match);
  if (!gone.length) return [];
  try {
    localStorage.setItem(dayKey(d), JSON.stringify(all.filter((s) => !match(s))));
  } catch {
    return [];
  }
  window.dispatchEvent(new Event(LOG_EVENT));
  return gone;
}

/** Put back what forgetSegments took out. */
export function restoreSegments(d: Date, back: Segment[]) {
  try {
    localStorage.setItem(dayKey(d), JSON.stringify([...loadDay(d), ...back].sort((a, b) => a.start - b.start)));
  } catch {
    /* storage full or unavailable */
  }
  window.dispatchEvent(new Event(LOG_EVENT));
}

const BROWSER_SUFFIX = /\s[-–—]\s(Google Chrome|Mozilla Firefox|Firefox|Microsoft​?\s?Edge|Brave|Opera|Vivaldi|Chromium|Arc|Safari)$/i;
const VIDEO_SUFFIX = /\s[-–—]\s(YouTube|Netflix|Prime Video|Disney\+|Hotstar|JioCinema|Twitch|Vimeo)$/i;
const EDITOR_APPS = /^(code|code - insiders|cursor|windsurf|zed|sublime_text|notepad\+\+|devenv)$/i;
const TERMINALS = /^(windowsterminal|wt|cmd|powershell|pwsh|alacritty|wezterm-gui|kitty|iterm2|terminal|gnome-terminal-server|konsole)$/i;

/** A short human label for what's in front of you. */
export function describe(a: Activity, ctx: Context): string {
  const title = a.title.replace(BROWSER_SUFFIX, "").replace(/^\(\d+\)\s*/, "").trim();
  const parts = title.split(/\s[-–—|]\s/).map((s) => s.trim()).filter(Boolean);
  const appName = a.name || a.app;

  if (ctx === "watching") return (title.replace(VIDEO_SUFFIX, "") || appName).slice(0, 90);
  if (EDITOR_APPS.test(a.app)) {
    // "file.ts - project - Visual Studio Code" → "project"
    return (parts.length >= 3 ? parts[parts.length - 2] : parts[0] || appName).replace(/^●\s*/, "");
  }
  if (TERMINALS.test(a.app)) return "Terminal";
  if (ctx === "focus") return appName; // Word, Notion, Figma...
  // Browsers: the site is usually the last part ("Inbox - me@x.com - Gmail" → "Gmail").
  if (BROWSER_SUFFIX.test(a.title)) return (parts[parts.length - 1] || appName).slice(0, 60);
  return appName;
}

export class Tracker {
  private day = dayKey();
  private segments: Segment[] = loadDay();

  constructor() {
    // The dashboard (another window) forgot something: keep what it left, or it would be written straight back.
    window.addEventListener("storage", (e) => {
      if (e.key === this.day) this.segments = loadDay();
    });
  }

  /** Call every few seconds. `active` = you're actually using the laptop (or watching). */
  tick(a: Activity | null, ctx: Context, active: boolean) {
    const now = Date.now();
    if (dayKey() !== this.day) {
      this.day = dayKey();
      this.segments = [];
    }
    if (!active || !a) return;
    const label = describe(a, ctx);
    const app = a.name || a.app;
    const last = this.segments[this.segments.length - 1];
    if (last && last.ctx === ctx && last.label === label && now - last.end < MERGE_GAP_MS) {
      last.end = now;
    } else {
      this.segments.push({ start: now, end: now, ctx, label, app });
      if (this.segments.length > MAX_SEGMENTS) this.segments.shift();
    }
    try {
      localStorage.setItem(this.day, JSON.stringify(this.segments));
    } catch {
      /* storage full or unavailable */
    }
  }
}
