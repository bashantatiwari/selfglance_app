// Goals: one line for the day, and whether the day is going toward it.
//
// Each stretch of the diary (an app plus a window or page title) is judged on-goal, off-goal
// or neither. Clear cases are rules (your own words in the goal, entertainment, meetings,
// your corrections). Anything unclear is asked of the local brain once and remembered. Bond
// nudges when about ten minutes in a row went off-goal, and on Sunday morning the week is
// summed up in plain numbers with a few suggestions. All of it is rules over the diary on
// this laptop; the brain only labels what the rules can't.

import type { Segment } from "../companion/tracker";
import { catOf, durOf, fmt } from "../dashboard/analyze.ts";

export type Fit = "on" | "off" | "neutral";
/** A verdict can also be "unsure": the rules can't tell, so the brain may be asked. */
export type Verdict = Fit | "unsure";

export const MAX_GOALS = 3;
export const GOAL_LEN = 120;
/** Minutes of off-goal time in a row before Bond says something. */
export const DRIFT_MIN = 10;
/** Sunday, from this hour. */
export const REVIEW_HOUR = 9;

const MIN = 60_000;

const two = (n: number) => String(n).padStart(2, "0");
export const dayId = (d = new Date()) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;

// --- Storage (localStorage, shared by the overlay and the dashboard) -----------------------

const read = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};
const write = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or unavailable */
  }
};

/** The goals for a day: up to three short lines. */
export function cleanGoals(lines: string[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    const t = l.replace(/\s+/g, " ").trim().slice(0, GOAL_LEN);
    if (t && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out.slice(0, MAX_GOALS);
}

export const loadGoals = (d = new Date()): string[] => {
  const v = read<unknown>(`selfglance.goal.${dayId(d)}`, []);
  return Array.isArray(v) ? cleanGoals(v.filter((x): x is string => typeof x === "string")) : [];
};
export const saveGoals = (goals: string[], d = new Date()) => write(`selfglance.goal.${dayId(d)}`, cleanGoals(goals));

/** Your corrections: "this is on-goal", "this is off-goal". Kept until you remove them. */
export const loadFixes = (): Record<string, Fit> => read("selfglance.goalfix", {});
export const saveFixes = (f: Record<string, Fit>) => write("selfglance.goalfix", f);

const CACHE_MAX = 800;
/** What the brain said about an item for a goal, so each is asked once. */
export const loadCache = (): Record<string, Fit> => read("selfglance.goalfit", {});
export function saveCache(c: Record<string, Fit>) {
  const keys = Object.keys(c);
  if (keys.length > CACHE_MAX) for (const k of keys.slice(0, keys.length - CACHE_MAX)) delete c[k];
  write("selfglance.goalfit", c);
}

/** Small bookkeeping: what was asked or shown, so Bond doesn't repeat himself. */
export interface GoalState {
  /** Day the morning question was shown (or answered "not today"). */
  askedDay?: string;
  /** Show no drift nudge before this time (ms). */
  snoozeUntil?: number;
  /** When recent nudges were shown (ms). */
  nudges?: number[];
  /** The Sunday whose review was shown. */
  reviewed?: string;
  /** When the brain was last asked about unclear items (ms). */
  judgedAt?: number;
}
export const loadState = (): GoalState => read("selfglance.goalstate", {});
export const saveState = (s: GoalState) => write("selfglance.goalstate", s);
export const patchState = (p: Partial<GoalState>) => saveState({ ...loadState(), ...p });

// --- Judging one stretch of the diary -------------------------------------------------------

const STOP = new Set(
  (
    "the and for with from into onto about that this those these what when where which while have has had are was were been being will would should could can " +
    "get got make made build building built work working worked finish finished complete completed start started try trying read reading study studying " +
    "learn learning learned write writing wrote watch watching practice practise some more much many new old good best better today tonight morning " +
    "afternoon evening day week thing things stuff task tasks project projects goal goals focus video videos chapter chapters part parts hour hours minutes " +
    "then also just only very really need needs want wants plan planning do doing done " +
    "tutorial tutorials course courses lesson lessons lecture lectures class classes assignment exercise exercises homework revise revision"
  ).split(" "),
);
/** Mail, chat and everyday tools: never counted against you unless you say so (they can be work either way). */
const EVERYDAY = /\b(gmail|inbox|outlook|mail|calendar|whatsapp|telegram|slack|teams|discord|zoom|meet|file explorer|explorer|settings|downloads|notepad|calculator)\b/i;
const WORD = /[\p{L}\p{N}+#]{3,}/gu;

const stem = (w: string) => {
  const s = w.replace(/(ing|ed|s)$/, "");
  return s.length >= 3 ? s : w;
};

/** The words in your goals that can recognise a window ("micrograd", "resume", "calculus"). */
export function goalWords(goals: string[]): string[] {
  const words = (goals.join(" ").toLowerCase().match(WORD) ?? []).filter((w) => !STOP.has(w)).map(stem);
  return [...new Set(words)];
}

const tokens = (text: string) => text.toLowerCase().match(WORD) ?? [];

/** Everything needed to judge a stretch for one day's goals. */
export interface Judge {
  words: string[];
  /** Identifies the goals in the brain's cache. */
  goalsKey: string;
  fixes: Record<string, Fit>;
  cache: Record<string, Fit>;
}

export const keyOf = (s: Pick<Segment, "app" | "label">) => `${s.app}|${s.label}`.toLowerCase();
const goalsKeyOf = (goals: string[]) => goals.map((g) => g.toLowerCase()).join("|");
export const cacheKey = (j: Pick<Judge, "goalsKey">, key: string) => `${j.goalsKey}§${key}`;

export function makeJudge(goals: string[], fixes = loadFixes(), cache = loadCache()): Judge {
  return { words: goalWords(goals), goalsKey: goalsKeyOf(goals), fixes, cache };
}

export function verdict(s: Segment, j: Judge): Verdict {
  const key = keyOf(s);
  const fix = j.fixes[key];
  if (fix) return fix;
  if (j.words.length) {
    const t = tokens(`${s.label} ${s.app}`);
    if (j.words.some((w) => t.some((x) => x.startsWith(w) || (x.length >= 4 && w.startsWith(x))))) return "on";
  }
  if (EVERYDAY.test(`${s.label} ${s.app}`)) return "neutral";
  const cat = catOf(s);
  if (cat === "meetings") return "neutral";
  if (cat === "entertainment") return "off";
  return j.cache[cacheKey(j, key)] ?? "unsure";
}

export interface Tally {
  on: number;
  off: number;
  /** Neither, or unclear. */
  other: number;
}

export function tally(segs: Segment[], j: Judge): Tally {
  const t: Tally = { on: 0, off: 0, other: 0 };
  for (const s of segs) {
    const v = verdict(s, j);
    t[v === "on" ? "on" : v === "off" ? "off" : "other"] += durOf(s);
  }
  return t;
}

/** Items the rules can't judge, longest first: what the brain may be asked. */
export interface Unclear {
  key: string;
  app: string;
  label: string;
  ms: number;
}
export function unclear(segs: Segment[], j: Judge, minMs = MIN): Unclear[] {
  const m = new Map<string, Unclear>();
  for (const s of segs) {
    if (verdict(s, j) !== "unsure") continue;
    const key = keyOf(s);
    const u = m.get(key) ?? { key, app: s.app, label: s.label, ms: 0 };
    u.ms += durOf(s);
    m.set(key, u);
  }
  return [...m.values()].filter((u) => u.ms >= minMs).sort((a, b) => b.ms - a.ms);
}

// --- Drifting -------------------------------------------------------------------------------

export interface Drift {
  /** Off-goal time in the current run (ms). */
  ms: number;
  since: number;
  /** What took most of it, and its key (for "this is on-goal"). */
  top: string;
  topKey: string;
}

const RUN_GAP = 3 * MIN; // away longer than this ends the run
const BLIP = 90_000; // a quick look at something else doesn't end it

/**
 * The current run of off-goal time: walking back from now, off-goal stretches add up, quick
 * glances elsewhere are ignored, and a real stretch of anything else (or leaving) ends it.
 */
export function driftRun(segs: Segment[], j: Judge, now = Date.now()): Drift | null {
  let ms = 0;
  let since = now;
  const by = new Map<string, { label: string; ms: number }>();
  let after = now;
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i];
    if (after - s.end > RUN_GAP) break;
    const len = durOf(s);
    const v = verdict(s, j);
    if (v === "off") {
      ms += len;
      since = s.start;
      const key = keyOf(s);
      by.set(key, { label: s.label, ms: (by.get(key)?.ms ?? 0) + len });
    } else if (len >= BLIP) break;
    after = s.start;
  }
  if (ms < DRIFT_MIN * MIN) return null;
  const [topKey, top] = [...by.entries()].sort((a, b) => b[1].ms - a[1].ms)[0] ?? ["", { label: "", ms: 0 }];
  return { ms, since, top: top.label, topKey };
}

/** At most two nudges an hour, 15 minutes apart, none while snoozed. */
export function canNudge(st: GoalState, now = Date.now()): boolean {
  if (st.snoozeUntil && now < st.snoozeUntil) return false;
  const recent = (st.nudges ?? []).filter((t) => now - t < 60 * MIN);
  if (recent.length >= 2) return false;
  return !recent.length || now - recent[recent.length - 1] >= 15 * MIN;
}

export const recordNudge = (st: GoalState, now = Date.now()): GoalState => ({ ...st, nudges: [...(st.nudges ?? []).filter((t) => now - t < 60 * MIN), now] });

/** Where Bond may speak up about drifting: a video or game is the point, a meeting is not. */
export function driftMoment(m: { idleSec: number; ctx: string; busy: boolean; inBreak: boolean }): boolean {
  if (m.busy || m.inBreak || m.ctx === "meeting") return false;
  if (m.ctx === "watching" || m.ctx === "game") return true;
  return m.idleSec >= 3 && m.idleSec < 90;
}

/** The sentence on the nudge card. */
export function driftText(goal: string, d: Drift): string {
  const min = Math.round(d.ms / MIN);
  return `Your focus today: ${goal}. The last ${min} minutes went to ${d.top ? `“${d.top}”` : "something else"}.`;
}

// --- The morning question and the Sunday review -----------------------------------------------

/** Ask once a day, from 5 am, when no goal is set yet. */
export function shouldAsk(st: GoalState, goals: string[], now = new Date()): boolean {
  return goals.length === 0 && st.askedDay !== dayId(now) && now.getHours() >= 5;
}

/** Pull a goal out of a sentence: "goal: finish micrograd", "my focus today is the resume". */
export function goalFrom(said: string): string | null {
  const t = said.trim().replace(/[.!]+$/, "");
  const m =
    t.match(/^(?:set )?(?:my |today'?s |the )?(?:goal|focus)(?: for today| today)?\s*[:\-–]\s*(.+)$/is) ??
    t.match(/^(?:today )?(?:my |today'?s )?(?:goal|focus)(?: for today| today)? (?:is|will be)\s+(.+)$/is);
  return m ? m[1].trim() : null;
}

export function reviewDue(st: GoalState, now = new Date()): boolean {
  return now.getDay() === 0 && now.getHours() >= REVIEW_HOUR && st.reviewed !== dayId(now);
}

const hourName = (h: number) => new Date(2000, 0, 1, h % 24).toLocaleTimeString([], { hour: "numeric" });

export interface DayRow {
  id: string;
  date: Date;
  goals: string[];
  t: Tally;
  /** Longest on-goal stretch (ms). */
  longestOn: number;
}

export interface Review {
  days: DayRow[];
  goalDays: number;
  t: Tally;
  /** On-goal share of on + off time, 0..100; null with little to go on. */
  share: number | null;
  prevShare: number | null;
  prevOn: number;
  /** Hours of the day with the most on-goal time, best first. */
  bestHours: number[];
  worstHour: number | null;
  pulls: { label: string; ms: number }[];
  longestOn: { ms: number; day: Date } | null;
  suggestions: string[];
  /** Enough tracked time to say something. */
  usable: boolean;
}

/** The longest on-goal stretch in a day (short detours allowed). */
function longestOn(segs: Segment[], j: Judge): number {
  let best = 0;
  let cur = 0;
  let end = 0;
  for (const s of segs) {
    const v = verdict(s, j);
    if (v === "on") {
      cur = cur && s.start - end < 3 * MIN ? cur + durOf(s) : durOf(s);
      end = s.end;
      best = Math.max(best, cur);
    } else if (durOf(s) >= 3 * MIN) cur = 0;
  }
  return best;
}

/** Hour-by-hour split of a segment, as analyze.ts does. */
function addHours(into: number[], s: Segment) {
  let t = s.start;
  const stop = s.start + durOf(s);
  while (t < stop) {
    const d = new Date(t);
    const next = new Date(d);
    next.setMinutes(60, 0, 0);
    const to = Math.min(stop, next.getTime());
    into[d.getHours()] += to - t;
    t = to;
  }
}

/**
 * The seven days up to and including `today`, against the seven before. `segsOf` and `goalsOf`
 * read the diary and the goals for any day; the numbers are rules, the suggestions are the
 * same facts put in words.
 */
export function reviewWeek(
  today: Date,
  segsOf: (d: Date) => Segment[],
  goalsOf: (d: Date) => string[],
  fixes: Record<string, Fit> = loadFixes(),
  cache: Record<string, Fit> = loadCache(),
): Review {
  const dayAt = (back: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() - back);
    return d;
  };
  const onByHour = Array<number>(24).fill(0);
  const offByHour = Array<number>(24).fill(0);
  const pulls = new Map<string, number>();
  const days: DayRow[] = [];
  const total: Tally = { on: 0, off: 0, other: 0 };

  for (let back = 6; back >= 0; back--) {
    const date = dayAt(back);
    const goals = goalsOf(date);
    const segs = segsOf(date);
    const row: DayRow = { id: dayId(date), date, goals, t: { on: 0, off: 0, other: 0 }, longestOn: 0 };
    if (goals.length) {
      const j = makeJudge(goals, fixes, cache);
      row.t = tally(segs, j);
      row.longestOn = longestOn(segs, j);
      for (const s of segs) {
        const v = verdict(s, j);
        if (v === "on") addHours(onByHour, s);
        else if (v === "off") {
          addHours(offByHour, s);
          pulls.set(s.label, (pulls.get(s.label) ?? 0) + durOf(s));
        }
      }
      total.on += row.t.on;
      total.off += row.t.off;
      total.other += row.t.other;
    }
    days.push(row);
  }

  let prevOn = 0;
  let prevOff = 0;
  for (let back = 13; back >= 7; back--) {
    const date = dayAt(back);
    const goals = goalsOf(date);
    if (!goals.length) continue;
    const t = tally(segsOf(date), makeJudge(goals, fixes, cache));
    prevOn += t.on;
    prevOff += t.off;
  }

  const goalDays = days.filter((d) => d.goals.length).length;
  const shareOf = (on: number, off: number) => (on + off >= 30 * MIN ? Math.round((on / (on + off)) * 100) : null);
  const share = shareOf(total.on, total.off);
  const prevShare = shareOf(prevOn, prevOff);
  const usable = goalDays > 0 && total.on + total.off >= 30 * MIN;

  const rank = (a: number[]) =>
    a
      .map((ms, h) => ({ ms, h }))
      .filter((x) => x.ms >= 10 * MIN)
      .sort((x, y) => y.ms - x.ms);
  const bestHours = rank(onByHour).slice(0, 3).map((x) => x.h);
  const worstHour = rank(offByHour)[0]?.h ?? null;
  const pullList = [...pulls.entries()]
    .map(([label, ms]) => ({ label, ms }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 3);
  const best = days.reduce<DayRow | null>((a, d) => (d.longestOn > (a?.longestOn ?? 0) ? d : a), null);

  const r: Review = {
    days,
    goalDays,
    t: total,
    share,
    prevShare,
    prevOn,
    bestHours,
    worstHour,
    pulls: pullList,
    longestOn: best ? { ms: best.longestOn, day: best.date } : null,
    suggestions: [],
    usable,
  };
  r.suggestions = suggest(r);
  return r;
}

/** "9–10 AM" for the best hour, widened by a neighbour that was nearly as good. */
export function hourRange(hours: number[], byHour?: number[]): string {
  if (!hours.length) return "";
  const h = hours[0];
  let from = h;
  let to = h + 1;
  const near = (x: number) => hours.includes(x) && (!byHour || byHour[x] >= 0.6 * byHour[h]);
  if (near(h - 1)) from = h - 1;
  if (near(h + 1)) to = h + 2;
  return `${hourName(from)}–${hourName(to)}`;
}

/** A few concrete things to try, from the week's numbers. At most five, the most useful first. */
export function suggest(r: Review): string[] {
  const out: string[] = [];
  if (r.goalDays === 0) return ["Set one line each morning (it takes ten seconds); it's what lets me tell you when you drift and sum the week up."];
  if (r.goalDays < 5) out.push(`You set a goal on ${r.goalDays} of the last 7 days. Days without one aren't tracked — a line each morning keeps the picture complete.`);
  if (!r.usable) return out;

  if (r.t.other > r.t.on + r.t.off) out.push("Most of your time couldn't be tied to a goal either way. Tap the labels under Today's goal to teach me what counts.");

  const top = r.pulls[0];
  if (top && top.ms >= 30 * MIN) {
    const when = r.worstHour !== null ? `, most around ${hourName(r.worstHour)}` : "";
    out.push(`“${top.label}” took ${fmt(top.ms)} off your goals${when}. Close it before you start, or make it a planned break after a block of work.`);
  }

  if (r.bestHours.length) out.push(`Your most on-goal time was ${hourRange(r.bestHours)}. Put the hardest part of tomorrow's goal there.`);

  if (r.share !== null && r.prevShare !== null && Math.abs(r.share - r.prevShare) >= 5) {
    out.push(`${r.share > r.prevShare ? "Up" : "Down"} from ${r.prevShare}% to ${r.share}% on-goal compared with the week before.`);
  }

  if (r.longestOn && r.longestOn.ms > 0) {
    const day = r.longestOn.day.toLocaleDateString([], { weekday: "long" });
    out.push(
      r.longestOn.ms >= 25 * MIN
        ? `Your longest on-goal stretch was ${fmt(r.longestOn.ms)} on ${day}. Aim to beat it by ten minutes.`
        : `No on-goal stretch passed 25 minutes (best: ${fmt(r.longestOn.ms)} on ${day}). Try one 25-minute block with notifications off.`,
    );
  }
  return out.slice(0, 5);
}
