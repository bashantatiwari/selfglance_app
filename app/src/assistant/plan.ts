// The day's plan: your items and Bond's, fitted into one schedule.
//
// A plain merge of two lists is a longer list. Here the rules decide, in code, because a small
// model must not do time arithmetic: items you gave a time are fixed and never move for Bond's;
// one of Bond's that says the same as one of yours is folded into yours; the rest are fitted into
// the free gaps, yours first; what doesn't fit (or would make the day too full) is left out with a
// one-line reason. Whatever changed is reported in plain words so nothing moves silently.

import { mentions } from "./profile.ts";

export interface PlanItem {
  id: string;
  title: string;
  mins: number;
  /** "HH:MM": fixed. Without it the item goes wherever it fits. */
  at?: string;
  by: "you" | "bond";
  /** Why Bond suggested it (shown under his items). */
  why?: string;
  /** Bond's item that should come before the rest (the thing being avoided). */
  first?: boolean;
  /** Offered for your aim or one of your projects (Settings → About you). */
  track?: "aim" | "project";
  done?: boolean;
}

export interface Slot {
  item: PlanItem;
  /** Minutes since midnight. */
  start: number;
  end: number;
}

export interface Schedule {
  slots: Slot[];
  /** What didn't fit or was folded together, one line each. */
  notes: string[];
  /** Items that have no place today. */
  left: PlanItem[];
}

export interface PlanDay {
  items: PlanItem[];
  /** Titles of Bond's suggestions you said "not now" to today. */
  dismissed: string[];
}

export const MAX_ITEMS = 12;
const GAP = 5;
const MIN_MINS = 10;
const MAX_MINS = 240;
const DAY_END = 21 * 60;
/** Focused work in a day, beyond which Bond adds nothing more of his own. */
const FOCUS_CAP = 6 * 60;

const two = (n: number) => String(n).padStart(2, "0");
export const clock = (m: number) => `${two(Math.floor(m / 60))}:${two(m % 60)}`;
const toMins = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m || 0);
};
const id = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// --- Storage --------------------------------------------------------------------------------

const key = (day: string) => `selfglance.plan.${day}`;

export function loadPlan(day: string): PlanDay {
  try {
    const v = JSON.parse(localStorage.getItem(key(day)) ?? "null");
    const items = Array.isArray(v?.items) ? v.items.filter((i: PlanItem) => i && typeof i.title === "string" && typeof i.mins === "number") : [];
    return { items, dismissed: Array.isArray(v?.dismissed) ? v.dismissed.filter((d: unknown) => typeof d === "string") : [] };
  } catch {
    return { items: [], dismissed: [] };
  }
}

export function savePlan(day: string, plan: PlanDay) {
  try {
    localStorage.setItem(key(day), JSON.stringify({ items: plan.items.slice(0, MAX_ITEMS), dismissed: plan.dismissed.slice(-20) }));
    window.dispatchEvent(new Event("selfglance:plan"));
  } catch {
    /* storage full or unavailable */
  }
}

// --- Reading what you said ------------------------------------------------------------------

const NUMBER = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, "2": 2, "3": 3, "4": 4, "5": 5 } as Record<string, number>;
const VERB = "research|study|learn|write|make|edit|post|upload|revise|build|record|practi[cs]e|watch|read|finish|plan|review|create|fix|code|test|publish|film|script|design|call|email|clean|prepare";
const LEAD = /^(?:(?:today|first|then|also|plus)[, ]+)?(?:(?:i|we) (?:have|need|want|got|must|should|plan) to |i['’]?m going to |let['’]?s |to )/i;

/** A rough length from the words: thinking takes less than making. */
function guessMins(t: string): number {
  if (/\b(research|study|learn|revise|read|watch|review|practi[cs]e)\b/i.test(t)) return 45;
  if (/\b(make|create|edit|record|build|write|code|video|content|film|script|design|publish|post|upload)\b/i.test(t)) return 60;
  return 30;
}

/** "three 30Cademy contents, research a new channel at 4pm for 45 min" → items. Nothing is invented. */
export function parsePlan(said: string): PlanItem[] {
  const text = said.trim().replace(/[.!]+$/, "");
  if (!text) return [];
  const parts = text
    .split(/\s*(?:[,;\n]|\bthen\b|\band then\b)\s*/i)
    .flatMap((p) => p.split(new RegExp(`\\s+and\\s+(?=(?:${VERB})\\b)`, "i")))
    .map((p) => p.trim().replace(LEAD, "").replace(/^and\s+/i, "").trim())
    .filter((p) => p.length >= 3);
  const out: PlanItem[] = [];
  for (let part of parts) {
    let at: string | undefined;
    const t = part.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
    if (t) {
      let h = Number(t[1]);
      const pm = t[3]?.toLowerCase();
      if (pm === "pm" && h < 12) h += 12;
      if (pm === "am" && h === 12) h = 0;
      if (h < 24 && Number(t[2] ?? 0) < 60) {
        at = `${two(h)}:${two(Number(t[2] ?? 0))}`;
        part = part.replace(t[0], "").trim();
      }
    }
    let mins: number | undefined;
    const d = part.match(/\b(?:for\s+)?(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/i);
    if (d) {
      mins = Math.round(Number(d[1]) * (/^h/i.test(d[2]) ? 60 : 1));
      part = part.replace(d[0], "").trim();
    }
    part = part.replace(/\s{2,}/g, " ").replace(/[\s,-]+$/, "").trim();
    if (part.length < 3) continue;
    // "three 30Cademy contents", "make three videos": a count means that many items.
    const n = part.match(new RegExp(`^((?:${VERB})\\s+)?(a|one|two|three|four|five|[2-5])\\s+(.+)$`, "i"));
    const count = n ? NUMBER[n[2].toLowerCase()] : 1;
    const base = n && count > 1 ? `${n[1] ?? ""}${n[3]}` : part;
    for (let i = 1; i <= count; i++) {
      const title = (count > 1 ? `${base} ${i}/${count}` : base).slice(0, 80);
      out.push({ id: id(), title: title[0].toUpperCase() + title.slice(1), mins: clampMins(mins ?? guessMins(base)), at: i === 1 ? at : undefined, by: "you" });
    }
  }
  return out.slice(0, MAX_ITEMS);
}

const clampMins = (m: number) => Math.max(MIN_MINS, Math.min(MAX_MINS, Math.round(m)));

// --- Fitting them together ------------------------------------------------------------------

const STOP = new Set("the and for with your some new into from that this about work on of to a an my learn study revise review research practice practise look make read watch".split(" "));
const words = (s: string) => new Set((s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !STOP.has(w)).map((w) => w.replace(/s$/, "")));

/** Do two titles say the same thing? Most of the shorter one's words are in the other. */
export function similar(a: string, b: string): boolean {
  const [x, y] = [words(a), words(b)];
  if (!x.size || !y.size) return false;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared >= 1 && shared / Math.min(x.size, y.size) >= 0.6;
}

export interface FitOptions {
  /** Minutes since midnight; nothing is placed before it. */
  now: number;
  end?: number;
  /** The most focused minutes of Bond's own items on top of yours. */
  cap?: number;
}

export function fit(all: PlanItem[], o: FitOptions): Schedule {
  const end = o.end ?? DAY_END;
  const cap = o.cap ?? FOCUS_CAP;
  const notes: string[] = [];
  const left: PlanItem[] = [];
  const open = all.filter((i) => !i.done);

  // 1. Bond's items that repeat yours are folded into yours.
  const yours = open.filter((i) => i.by === "you");
  const bonds = open.filter((i) => i.by === "bond").filter((b) => {
    const twin = yours.find((y) => similar(y.title, b.title));
    if (twin) notes.push(`Folded my “${b.title}” into your “${twin.title}”.`);
    return !twin;
  });

  // 2. What you gave a time is fixed. Two at once: the first stays. One already past is treated as flexible.
  const slots: Slot[] = [];
  const free = (s: number, e: number) => slots.every((x) => e + GAP <= x.start || s >= x.end + GAP);
  const flexible: PlanItem[] = [];
  for (const i of yours.filter((i) => i.at)) {
    const s = toMins(i.at!);
    if (s < o.now) {
      notes.push(`“${i.title}” was for ${i.at}, which has passed, so I found it a new time.`);
      flexible.push(i);
    } else if (s + i.mins > end || !free(s, s + i.mins)) {
      notes.push(`“${i.title}” at ${i.at} overlaps another, so it goes wherever it fits.`);
      flexible.push(i);
    } else slots.push({ item: i, start: s, end: s + i.mins });
  }

  // 3. The rest go into the first gap that holds them: yours, then Bond's (the one to do first leading).
  const queue = [...flexible, ...yours.filter((i) => !i.at), ...bonds.filter((b) => b.first), ...bonds.filter((b) => !b.first)];
  let placed = slots.reduce((n, s) => n + s.item.mins, 0);
  const gapFor = (mins: number) => {
    let at = Math.ceil(o.now / 5) * 5;
    for (const s of [...slots].sort((a, b) => a.start - b.start)) {
      if (at + mins + GAP <= s.start) break;
      if (s.end + GAP > at) at = s.end + GAP;
    }
    return at + mins <= end ? at : -1;
  };
  for (const i of queue) {
    if (i.by === "bond" && placed + i.mins > cap) {
      notes.push(`Left out “${i.title}”: that's already a full day.`);
      left.push(i);
      continue;
    }
    let mins = i.mins;
    let at = gapFor(mins);
    if (at < 0 && i.by === "you" && mins > 20) {
      // Yours is worth shortening before it is dropped.
      for (const m of [Math.floor(mins * 0.75), Math.floor(mins / 2)]) {
        if (m >= 15 && (at = gapFor(m)) >= 0) {
          notes.push(`Shortened “${i.title}” from ${mins} to ${m} minutes to fit.`);
          mins = m;
          break;
        }
      }
    }
    if (at < 0) {
      notes.push(i.by === "you" ? `No room left today for “${i.title}”.` : `Left out “${i.title}”: no room today.`);
      left.push(i);
      continue;
    }
    slots.push({ item: { ...i, mins }, start: at, end: at + mins });
    placed += mins;
  }
  slots.sort((a, b) => a.start - b.start);
  return { slots, notes, left };
}

/** What Bond says out loud and in the card. */
export function planSummary(s: Schedule): string {
  if (!s.slots.length) return "Nothing is planned yet. Say “plan my day: …” and tell me what you want to get done.";
  const list = s.slots.slice(0, 6).map((x) => `${clock(x.start)} ${x.item.title}`).join(" · ");
  return `Here's your day: ${list}${s.slots.length > 6 ? ` · and ${s.slots.length - 6} more` : ""}.`;
}

// --- Bond's own suggestions -----------------------------------------------------------------

export interface Source {
  /** Today's focus goals. */
  goals: string[];
  /** Ideas not ticked off, with when each was written (ms). */
  ideas: { text: string; at: number }[];
  /** What was left undone on earlier days (see `unfinished`). */
  unfinished?: Unfinished[];
  /** Settings → About you: where you're headed, words that show it (profile.ts aimWords), your projects. */
  aim?: string;
  aimWords?: string[];
  projects?: string[];
}

/** Learning is the work toward an aim, whatever the subject. */
const LEARNING = /\b(study|learn|course|lecture|paper|practi[cs]e|revise|tutorial|exercise|leetcode|kaggle)/i;

export interface Unfinished {
  title: string;
  mins: number;
  /** "yesterday", "on Tuesday". */
  when: string;
}

/** Items from earlier days that were never ticked off, newest day first, each said once. Days in, newest first. */
export function unfinished(days: { when: string; plan: PlanDay }[]): Unfinished[] {
  const out: Unfinished[] = [];
  for (const { when, plan } of days) {
    for (const i of plan.items) {
      if (i.done || out.some((o) => similar(o.title, i.title))) continue;
      out.push({ title: i.title, mins: i.mins, when });
    }
  }
  return out;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Most CARRY of what was left undone, then today's focus that isn't in the plan yet, then the ideas that sat longest. */
const CARRY = 3;
/**
 * What you could add, for the moment you open the laptop and don't know where to start: what you left
 * undone on earlier days (yours, so it comes back as yours), today's focus, and ideas waiting for days.
 * Nothing is invented; everything is something you wrote.
 */
export function suggest(day: PlanDay, src: Source, now = Date.now()): PlanItem[] {
  const out: PlanItem[] = [];
  const have = (t: string) => day.items.some((i) => similar(i.title, t)) || day.dismissed.some((d) => similar(d, t)) || out.some((o) => similar(o.title, t));
  for (const u of src.unfinished ?? []) {
    if (out.length >= CARRY) break;
    if (!have(u.title)) out.push({ id: id(), title: u.title, mins: u.mins, by: "you", why: `Not finished ${u.when}.` });
  }
  const goal = src.goals.find((g) => !have(g));
  if (goal) out.push({ id: id(), title: `Work on: ${goal}`.slice(0, 80), mins: 45, by: "bond", first: true, why: "Your focus for today." });
  // Where you're headed: a block of learning, unless something today already works toward it.
  if (src.aim) {
    const title = `${src.aim}: 45 min of learning`.slice(0, 80);
    const toward = (t: string) => similar(t, src.aim!) || mentions(t, src.aimWords ?? []) || LEARNING.test(t);
    if (![...day.items, ...out].some((i) => i.track === "aim" || toward(i.title)) && !have(title))
      out.push({ id: id(), title, mins: 45, by: "bond", track: "aim", why: "Where you're headed. Nothing in today's plan moves you toward it yet." });
  }
  // One of your projects that isn't in the plan yet.
  const project = (src.projects ?? []).find((p) => !have(p) && !have(`Work on ${p}`));
  if (project) out.push({ id: id(), title: `Work on ${project}`.slice(0, 80), mins: 60, by: "bond", track: "project", why: "One of your projects." });
  const waiting = [...src.ideas].sort((a, b) => a.at - b.at).filter((i) => now - i.at > 3 * DAY_MS && !have(i.text));
  for (const idea of waiting.slice(0, 2)) {
    const days = Math.floor((now - idea.at) / DAY_MS);
    out.push({ id: id(), title: `Look at your idea: ${idea.text}`.slice(0, 80), mins: 30, by: "bond", why: `You noted it ${days} days ago and haven't opened it since.` });
  }
  return out;
}

export const minutesNow = (d = new Date()) => d.getHours() * 60 + d.getMinutes();
