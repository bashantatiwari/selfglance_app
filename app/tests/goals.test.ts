// Run: node --experimental-strip-types --test tests/   (from app/)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canNudge,
  cleanGoals,
  dayId,
  driftMoment,
  driftRun,
  goalFrom,
  goalWords,
  makeJudge,
  recordNudge,
  reviewDue,
  reviewWeek,
  shouldAsk,
  tally,
  unclear,
  verdict,
  type Fit,
} from "../src/assistant/goals.ts";

const MIN = 60_000;
type Seg = { start: number; end: number; ctx: "focus" | "watching" | "other" | "meeting" | "game"; label: string; app: string };
const seg = (start: number, mins: number, ctx: Seg["ctx"], label: string, app = "Google Chrome"): Seg => ({ start, end: start + mins * MIN - 2000, ctx, label, app });
const judge = (goals: string[], fixes: Record<string, Fit> = {}, cache: Record<string, Fit> = {}) => makeJudge(goals, fixes, cache);

test("goal words keep the specific words and drop filler", () => {
  assert.deepEqual(goalWords(["Finish the micrograd video and write notes"]), ["micrograd", "note"]);
  assert.deepEqual(goalWords(["learning", "work on the project"]), []);
  assert.equal(verdict(seg(0, 5, "other", "Calculus Lecture 4 - MIT"), judge(["Calculus chapter 4"])), "on");
  // generic words in a goal ("tutorial") don't make every tutorial on-goal
  assert.equal(verdict(seg(0, 5, "watching", "Rust ownership explained: a tutorial"), judge(["Finish the micrograd tutorial"])), "unsure");
});

test("goals are cleaned: trimmed, no duplicates, at most three, short", () => {
  assert.deepEqual(cleanGoals(["  a  b ", "A B", "", "two", "three", "four"]), ["a b", "two", "three"]);
  assert.equal(cleanGoals(["x".repeat(500)])[0].length, 120);
});

test("rules: your words are on-goal, entertainment off, meetings neutral, the rest unsure", () => {
  const j = judge(["Finish micrograd"]);
  assert.equal(verdict(seg(0, 5, "focus", "micrograd", "Visual Studio Code"), j), "on");
  assert.equal(verdict(seg(0, 5, "watching", "Andrej Karpathy: micrograd explained", "Google Chrome"), j), "on");
  assert.equal(verdict(seg(0, 5, "watching", "Lofi beats to study to"), j), "off");
  assert.equal(verdict(seg(0, 5, "meeting", "Weekly sync", "Zoom"), j), "neutral");
  assert.equal(verdict(seg(0, 5, "other", "Gmail"), j), "neutral");
  assert.equal(verdict(seg(0, 5, "other", "Family group", "WhatsApp"), j), "neutral");
  assert.equal(verdict(seg(0, 5, "other", "Pinterest boards"), j), "off");
  assert.equal(verdict(seg(0, 5, "other", "Notion"), j), "unsure");
  assert.equal(verdict(seg(0, 5, "focus", "selfglance", "Visual Studio Code"), j), "unsure");
});

test("your corrections and the brain's cached answers come into play", () => {
  const s = seg(0, 5, "other", "Notion");
  const key = "google chrome|notion";
  assert.equal(verdict(s, judge(["Finish micrograd"], { [key]: "on" })), "on");
  const j = judge(["Finish micrograd"]);
  j.cache[`${j.goalsKey}§${key}`] = "neutral";
  assert.equal(verdict(s, j), "neutral");
  // a correction beats a rule
  assert.equal(verdict(seg(0, 5, "watching", "Lofi beats to study to"), judge(["x1"], { "google chrome|lofi beats to study to": "on" })), "on");
});

test("tally splits the time", () => {
  const j = judge(["micrograd"]);
  const t = tally([seg(0, 10, "focus", "micrograd", "Code"), seg(10 * MIN, 5, "watching", "Cat videos"), seg(15 * MIN, 5, "other", "Notion")], j);
  assert.ok(t.on >= 10 * MIN && t.off >= 5 * MIN && t.other >= 5 * MIN);
});

test("unclear lists only what the rules can't judge and is long enough", () => {
  const j = judge(["micrograd"]);
  const u = unclear([seg(0, 5, "other", "Notion"), seg(5 * MIN, 0.2, "other", "Figma", "Figma"), seg(6 * MIN, 5, "focus", "micrograd", "Code")], j);
  assert.deepEqual(u.map((x) => x.label), ["Notion"]);
});

test("ten minutes of off-goal in a row is a drift; a short detour back does not reset it, a real stretch does", () => {
  const j = judge(["micrograd"]);
  const t0 = 10_000_000;
  const now = t0 + 14 * MIN;
  const drift = driftRun([seg(t0, 6, "watching", "Cat videos"), seg(t0 + 6 * MIN, 0.5, "focus", "micrograd", "Code"), seg(t0 + 6.5 * MIN, 7.5, "watching", "Cat videos")], j, now);
  assert.ok(drift && drift.ms >= 10 * MIN);
  assert.equal(drift?.top, "Cat videos");
  // a real stretch of work in between ends the run
  assert.equal(driftRun([seg(t0, 8, "watching", "Cat videos"), seg(t0 + 8 * MIN, 4, "focus", "micrograd", "Code"), seg(t0 + 12 * MIN, 2, "watching", "Cat videos")], j, now), null);
  // not now: you left
  assert.equal(driftRun([seg(t0, 12, "watching", "Cat videos")], j, t0 + 40 * MIN), null);
  // under ten minutes
  assert.equal(driftRun([seg(t0, 8, "watching", "Cat videos")], j, t0 + 8 * MIN), null);
});

test("nudges: two an hour at most, 15 minutes apart, none while snoozed", () => {
  const now = 50_000_000;
  assert.equal(canNudge({}, now), true);
  const one = recordNudge({}, now);
  assert.equal(canNudge(one, now + 10 * MIN), false);
  assert.equal(canNudge(one, now + 16 * MIN), true);
  const two = recordNudge(one, now + 16 * MIN);
  assert.equal(canNudge(two, now + 40 * MIN), false);
  assert.equal(canNudge(two, now + 70 * MIN), true);
  assert.equal(canNudge({ snoozeUntil: now + 30 * MIN }, now + MIN), false);
  assert.equal(canNudge({ snoozeUntil: now + 30 * MIN }, now + 31 * MIN), true);
});

test("he may speak up over a video or game, never in a meeting", () => {
  const base = { idleSec: 500, busy: false, inBreak: false };
  assert.equal(driftMoment({ ...base, ctx: "watching" }), true);
  assert.equal(driftMoment({ ...base, ctx: "meeting" }), false);
  assert.equal(driftMoment({ ...base, ctx: "other" }), false); // gone for a while
  assert.equal(driftMoment({ ...base, ctx: "other", idleSec: 10 }), true);
  assert.equal(driftMoment({ ...base, ctx: "watching", busy: true }), false);
});

test("the morning question comes once a day, after 5 am, only without a goal", () => {
  const morning = new Date(2026, 9, 20, 9, 0);
  assert.equal(shouldAsk({}, [], morning), true);
  assert.equal(shouldAsk({ askedDay: dayId(morning) }, [], morning), false);
  assert.equal(shouldAsk({}, ["x"], morning), false);
  assert.equal(shouldAsk({}, [], new Date(2026, 9, 20, 3, 0)), false);
});

test("the Sunday review is due from 9 am on Sunday, once", () => {
  const sun = new Date(2026, 9, 25, 9, 30); // 2026-10-25 is a Sunday
  assert.equal(sun.getDay(), 0);
  assert.equal(reviewDue({}, sun), true);
  assert.equal(reviewDue({}, new Date(2026, 9, 25, 8, 59)), false);
  assert.equal(reviewDue({ reviewed: dayId(sun) }, sun), false);
  assert.equal(reviewDue({}, new Date(2026, 9, 24, 12, 0)), false);
});

test("goals are picked out of what you say", () => {
  assert.equal(goalFrom("goal: finish micrograd"), "finish micrograd");
  assert.equal(goalFrom("my goal today is the resume"), "the resume");
  assert.equal(goalFrom("today's focus - write chapter 2"), "write chapter 2");
  assert.equal(goalFrom("set my focus for today: finish the invoice."), "finish the invoice");
  assert.equal(goalFrom("what is a goal in football"), null);
  assert.equal(goalFrom("open spotify"), null);
});

test("the week: numbers, comparison and suggestions", () => {
  const sun = new Date(2026, 9, 25, 9, 30);
  const at = (d: Date, h: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), h).getTime();
  const goalsOf = (d: Date) => (d.getDay() === 1 || d.getDay() === 2 || d.getDay() === 3 ? ["micrograd"] : []);
  const segsOf = (d: Date): Seg[] => {
    if (!goalsOf(d).length) return [seg(at(d, 10), 30, "watching", "Cat videos")];
    return [seg(at(d, 9), 50, "focus", "micrograd", "Code"), seg(at(d, 15), 40, "watching", "Cat videos")];
  };
  const r = reviewWeek(sun, segsOf, goalsOf, {}, {});
  assert.equal(r.goalDays, 3);
  assert.equal(r.days.length, 7);
  assert.ok(r.usable);
  assert.ok(r.t.on > 2 * 60 * MIN && r.t.off > 100 * MIN);
  assert.equal(r.share, Math.round((r.t.on / (r.t.on + r.t.off)) * 100));
  assert.equal(r.bestHours[0], 9);
  assert.equal(r.worstHour, 15);
  assert.equal(r.pulls[0].label, "Cat videos");
  const text = r.suggestions.join("\n");
  assert.match(text, /3 of the last 7 days/);
  assert.match(text, /Cat videos/);
  assert.ok(r.suggestions.length <= 5);
  // days without a goal are not counted as off-goal
  assert.ok(r.days.filter((d) => !d.goals.length).every((d) => d.t.off === 0));
});

test("a week with no goals says how to start, nothing more", () => {
  const r = reviewWeek(new Date(2026, 9, 25), () => [], () => [], {}, {});
  assert.equal(r.usable, false);
  assert.equal(r.suggestions.length, 1);
});
