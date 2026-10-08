// Bond notices — the frontend half: spotting moments worth a suggestion, and choosing
// when to speak up so it helps rather than interrupts. Pure rules, no AI, no I/O; the
// overlay (App.tsx) wires them to events, and Rust (notice.rs) finds your habits, asks the
// local brain whether there's something useful to say, and remembers how it went.
//
// When he speaks up matters more than what he says (people accept the same suggestion far
// more often at a natural pause), so a suggestion waits for one: you've stopped typing for
// a few seconds but haven't walked away, and you're not in a meeting, a game or a video.
// On top of that: a per-hour cap, a gap between suggestions that depends on the level you
// chose, quiet hours, and apps he never comments on.

import type { Activity, Context } from "../companion/context";

/** How much he speaks up on his own. */
export type NoticeLevel = "off" | "stuck" | "helpful" | "chatty";

export type NoticeKind = "habit" | "stuck" | "error";

/** Which kinds each level allows. */
export const LEVEL_KINDS: Record<NoticeLevel, NoticeKind[]> = {
  off: [],
  stuck: ["stuck", "error"],
  helpful: ["stuck", "error", "habit"],
  chatty: ["stuck", "error", "habit"],
};

/** Least minutes between any two suggestions, and before the same one comes back. */
export const LEVEL_GAP_MIN: Record<NoticeLevel, { any: number; same: number }> = {
  off: { any: Infinity, same: Infinity },
  stuck: { any: 20, same: 60 },
  helpful: { any: 10, same: 30 },
  chatty: { any: 4, same: 15 },
};

/** Searches within this window that make "stuck" (fewer at the chatty level). */
export const STUCK_WINDOW_MS = 8 * 60_000;
export const stuckSearches = (level: NoticeLevel) => (level === "chatty" ? 2 : 3);

/** A suggestion waiting for the right moment. */
export interface Suggestion {
  /** Identifies it in Bond's log, so he knows how it went before ("stuck@visual studio code"). */
  key: string;
  kind: NoticeKind;
  text: string;
  /** The main button. */
  primary: { label: string; does: "actions" | "explain" | "look" };
  /** For "actions": what to run. */
  actions?: object[];
  /** For "explain": the copied error. */
  clip?: string;
  /** When it was noticed (ms); too old and it's dropped. */
  at: number;
}

/** A suggestion older than this has missed its moment. */
export const SUGGESTION_TTL_MS = 3 * 60_000;

// --- Stuck: searching again and again while working ---------------------------------------

const SEARCH_TITLE = /^(.+?) [-–—] (Google Search|Google-Suche|Recherche Google|Bing|DuckDuckGo|Brave Search|Startpage Search Results|Ecosia)(?: [-–—] .*)?$/i;
const HELP_SITE = /( - Stack Overflow| - Super User| · Issue #\d+| · GitHub| - MDN| \| MDN|Stack Exchange)/i;

/** The query in a search results tab ("rust e0382 - Google Search - Google Chrome"). */
export function searchQuery(title: string): string | null {
  const m = title.match(SEARCH_TITLE);
  return m ? m[1].trim() : null;
}

/** A Q&A or issue page: reading answers to a problem. */
export const isHelpPage = (title: string) => HELP_SITE.test(title);

interface Seen {
  t: number;
  query: string | null;
  help: boolean;
  focus: boolean;
}

/** Remembers recent windows; says when the pattern looks like being stuck on something. */
export class StuckWatch {
  private seen: Seen[] = [];

  push(a: Activity, ctx: Context, now = Date.now()) {
    this.seen.push({ t: now, query: searchQuery(a.title), help: isHelpPage(a.title), focus: ctx === "focus" });
    this.seen = this.seen.filter((s) => now - s.t <= STUCK_WINDOW_MS);
  }

  /**
   * Different searches (or Q&A pages) in the window, while also working in an editor or
   * terminal: the queries, newest last. Null when it doesn't look like being stuck.
   */
  stuck(level: NoticeLevel, now = Date.now()): string[] | null {
    const recent = this.seen.filter((s) => now - s.t <= STUCK_WINDOW_MS);
    if (!recent.some((s) => s.focus)) return null; // not working: just browsing
    const queries = [...new Set(recent.map((s) => s.query).filter((q): q is string => !!q))];
    const helpPages = recent.filter((s) => s.help).length;
    if (queries.length + Math.min(helpPages, 2) < stuckSearches(level)) return null;
    return queries;
  }

  /** Start over (after he has said something about it). */
  clear() {
    this.seen = [];
  }
}

// --- When to speak up ---------------------------------------------------------------------

export interface Moment {
  /** Seconds since the last keyboard/mouse input. */
  idleSec: number;
  ctx: Context;
  /** His card or box is already open. */
  busy: boolean;
  inBreak: boolean;
}

/** You paused (not typing for a few seconds) but are still here, and nothing's in the way. */
export function naturalPause(m: Moment): boolean {
  if (m.busy || m.inBreak) return false;
  if (m.ctx === "meeting" || m.ctx === "game" || m.ctx === "watching") return false;
  return m.idleSec >= 3 && m.idleSec < 90;
}

/** Inside quiet hours (from → to, wrapping past midnight; from === to means none). */
export function inQuietHours(now: Date, from: number, to: number): boolean {
  if (from === to) return false;
  const h = now.getHours();
  return from < to ? h >= from && h < to : h >= from || h < to;
}

/** Apps and windows he never comments on: your list (comma-separated words). */
export function blockedBy(a: Activity | null, list: string): boolean {
  if (!a) return false;
  const words = list
    .split(",")
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);
  const where = `${a.app} ${a.name} ${a.title}`.toLowerCase();
  return words.some((w) => where.includes(w));
}

/** The per-hour cap and the gap between suggestions. */
export class Pacer {
  private times: number[] = [];

  canShow(level: NoticeLevel, maxPerHour: number, now = Date.now()): boolean {
    if (level === "off") return false;
    this.times = this.times.filter((t) => now - t < 3600_000);
    if (this.times.length >= maxPerHour) return false;
    const last = this.times[this.times.length - 1];
    return last === undefined || now - last >= LEVEL_GAP_MIN[level].any * 60_000;
  }

  shown(now = Date.now()) {
    this.times.push(now);
  }
}

// --- Wording ------------------------------------------------------------------------------

/** "Visual Studio Code" → "VS Code" for friendlier cards. */
export function appLabel(name: string): string {
  return name.replace(/^Visual Studio Code.*$/i, "VS Code").replace(/^Google Chrome$/i, "Chrome").replace(/^Microsoft Edge$/i, "Edge");
}

export function habitText(label: string, app: string | null, hour: number | null): string {
  const what = label.charAt(0).toLowerCase() + label.slice(1);
  if (app) return `You usually ${what} when you're in ${appLabel(app)}. Want me to?`;
  const when = hour === null ? "around now" : hour < 12 ? "in the morning" : hour < 17 ? "around this time" : "in the evening";
  return `You usually ${what} ${when}. Want me to?`;
}

/** What he says about searching a lot when the brain has nothing more specific. */
export const stuckFallback = (queries: string[]) =>
  queries.length ? `Stuck on “${queries[queries.length - 1]}”? I can look at your screen and help.` : "Looks like you're hunting for something. Want me to look at your screen?";

export const errorFallback = "Copied an error? I can explain what it means and how to fix it.";
