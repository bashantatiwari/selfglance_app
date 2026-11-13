// Follow-through: what you watched to learn, and whether anything came of it.
//
// Watching a tutorial feels like progress and often isn't. Every lesson you watch for a while (a video or
// page that looks like teaching, or is about your aim) is written down. From the next day on Bond asks, once
// a day and one lesson at a time: "On Monday you watched X. Did you build or try anything from it?" You answer
// used it / I'll do it today / drop it. The week then says plainly how much was watched and how much was used.
//
// Pure rules over the diary (tested); the list lives in localStorage. Nothing is sent anywhere.

import type { Segment } from "../companion/tracker";
import { mentions } from "./profile.ts";

export type LessonState = "open" | "today" | "used" | "dropped";

export interface Lesson {
  /** `${day}|${title}`, lower-case. */
  id: string;
  title: string;
  /** The day it was watched, "YYYY-MM-DD". */
  day: string;
  ms: number;
  state: LessonState;
  /** The day Bond last asked about it. */
  asked?: string;
}

const KEY = "selfglance.lessons";
const MIN = 60_000;
/** Watched at least this long to count as a lesson (a glance at a video is not one). */
export const LESSON_MIN = 10;
/** A lesson nobody answered about is let go after this many days. */
const KEEP_DAYS = 10;
const MAX = 80;

const TEACHING = /\b(tutorial|course|lecture|lesson|crash course|explained|explanation|how to|how i|learn|walkthrough|for beginners|beginner|step by step|from scratch|bootcamp|masterclass|workshop|introduction to|intro to|guide to|build a|build an|building a|let'?s build|deep dive|roadmap)\b/i;

const dur = (s: Segment) => Math.max(0, s.end - s.start);
const dayNumber = (id: string) => {
  const [y, m, d] = id.split("-").map(Number);
  return Math.round(new Date(y, m - 1, d).getTime() / (24 * 60 * MIN));
};

/** Does this stretch look like learning? A video or page that teaches, or anything watched about your aim. */
export function isLesson(s: Segment, aim: string[]): boolean {
  if (s.ctx === "meeting" || s.ctx === "game" || s.ctx === "focus") return false;
  const text = s.label;
  if (TEACHING.test(text)) return true;
  return s.ctx === "watching" && aim.length > 0 && mentions(text, aim);
}

/** The lessons in a day's diary: each title once, with the time spent on it, longest first. */
export function lessonsIn(segs: Segment[], day: string, aim: string[]): Lesson[] {
  const by = new Map<string, Lesson>();
  for (const s of segs) {
    if (!isLesson(s, aim)) continue;
    const id = `${day}|${s.label}`.toLowerCase();
    const l = by.get(id) ?? { id, title: s.label, day, ms: 0, state: "open" as LessonState };
    l.ms += dur(s);
    by.set(id, l);
  }
  return [...by.values()].filter((l) => l.ms >= LESSON_MIN * MIN).sort((a, b) => b.ms - a.ms);
}

/** Put a day's lessons into the list: new ones are added, known ones keep your answer and get the latest time. */
export function merge(list: Lesson[], found: Lesson[], today: string): Lesson[] {
  const out = list.filter((l) => dayNumber(today) - dayNumber(l.day) <= KEEP_DAYS || l.state === "today");
  for (const f of found) {
    const have = out.find((l) => l.id === f.id);
    if (have) have.ms = Math.max(have.ms, f.ms);
    else out.push(f);
  }
  return out.slice(-MAX);
}

/**
 * The one lesson to ask about now: watched on an earlier day, not answered, not asked today. The one you
 * promised to do "today" comes first (the next day), then the oldest open one.
 */
export function due(list: Lesson[], today: string): Lesson | null {
  const waiting = list.filter((l) => (l.state === "open" || l.state === "today") && l.day < today && l.asked !== today);
  if (list.some((l) => l.asked === today)) return null; // one question a day
  return waiting.find((l) => l.state === "today") ?? waiting.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : b.ms - a.ms))[0] ?? null;
}

const weekday = (id: string) => {
  const [y, m, d] = id.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en", { weekday: "long" });
};

/** What Bond asks. */
export function question(l: Lesson, today: string): string {
  const ago = dayNumber(today) - dayNumber(l.day);
  const when = ago === 1 ? "Yesterday" : `On ${weekday(l.day)}`;
  const min = Math.round(l.ms / MIN);
  if (l.state === "today") return `${when} you said you'd use what you learned from “${l.title}”. Did you?`;
  return `${when} you watched “${l.title}” for ${min} minutes. Did you build or try anything from it?`;
}

/** Your answer to the question (or just that it was asked). */
export function answer(list: Lesson[], id: string, to: LessonState | "asked", today: string): Lesson[] {
  return list.map((l) => (l.id !== id ? l : to === "asked" ? { ...l, asked: today } : { ...l, state: to, asked: today }));
}

/** The last seven days in two numbers: lessons watched, and how many you used. */
export function week(list: Lesson[], today: string): { watched: number; used: number; waiting: number; ms: number } {
  const recent = list.filter((l) => dayNumber(today) - dayNumber(l.day) < 7);
  return {
    watched: recent.length,
    used: recent.filter((l) => l.state === "used").length,
    waiting: recent.filter((l) => l.state === "open" || l.state === "today").length,
    ms: recent.reduce((a, l) => a + l.ms, 0),
  };
}

export function loadLessons(): Lesson[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((l) => l && typeof l.id === "string" && typeof l.day === "string") : [];
  } catch {
    return [];
  }
}

export function saveLessons(list: Lesson[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX)));
  } catch {
    /* not kept */
  }
}
