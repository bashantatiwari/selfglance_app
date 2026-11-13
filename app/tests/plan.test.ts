// Run: node --experimental-strip-types --test tests/   (from app/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { clock, fit, parsePlan, similar, suggest, unfinished, type PlanItem } from "../src/assistant/plan.ts";

const item = (title: string, mins: number, by: "you" | "bond" = "you", extra: Partial<PlanItem> = {}): PlanItem => ({ id: title, title, mins, by, ...extra });
const at = (h: number, m = 0) => h * 60 + m;

test("what you say becomes items with times and lengths read from your words", () => {
  const p = parsePlan("I have to make three 30Cademy contents, research a new channel at 4pm for 45 min, and study transformers");
  assert.deepEqual(p.map((i) => i.title), ["Make 30Cademy contents 1/3", "Make 30Cademy contents 2/3", "Make 30Cademy contents 3/3", "Research a new channel", "Study transformers"]);
  assert.deepEqual(p.map((i) => i.mins), [60, 60, 60, 45, 45]);
  assert.equal(p[3].at, "16:00");
  assert.ok(p.every((i) => i.by === "you"));
});

test("times: pm, am, noon, 24-hour, and hours for a length", () => {
  const one = (s: string) => parsePlan(s)[0];
  assert.equal(one("call mum at 12pm").at, "12:00");
  assert.equal(one("gym at 7:30 am").at, "07:30");
  assert.equal(one("review pr at 14:15").at, "14:15");
  assert.equal(one("deep work for 2 hours").mins, 120);
  assert.equal(one("edit the video for 10000 minutes").mins, 240, "capped");
});

test("an empty or tiny plan makes nothing, and the list is capped", () => {
  assert.deepEqual(parsePlan(""), []);
  assert.deepEqual(parsePlan("ok"), []);
  assert.ok(parsePlan(Array.from({ length: 30 }, (_, i) => `task number ${i}`).join(", ")).length <= 12);
});

test("two titles saying the same thing are the same", () => {
  assert.ok(similar("learn attention", "Transformers: attention"));
  assert.ok(similar("Research a new channel", "research new channels"));
  assert.ok(!similar("make 30Cademy video", "study attention"));
  assert.ok(!similar("", "x"));
});

test("fixed times never move for Bond's items, which fill the gaps after yours", () => {
  const s = fit([item("Video", 60, "you", { at: "14:00" }), item("Revise attention", 30, "bond"), item("Write script", 45)], { now: at(13) });
  const slot = (t: string) => s.slots.find((x) => x.item.title === t)!;
  assert.equal(clock(slot("Video").start), "14:00");
  assert.equal(clock(slot("Write script").start), "13:00", "yours first, before the fixed block");
  assert.ok(slot("Revise attention").start >= slot("Video").end + 5 || slot("Revise attention").end + 5 <= slot("Video").start);
  for (const a of s.slots) for (const b of s.slots) if (a !== b) assert.ok(a.end <= b.start || b.end <= a.start, "no overlaps");
});

test("Bond's item that repeats one of yours is folded in, and says so", () => {
  const s = fit([item("Learn attention", 45), item("Transformers: attention", 45, "bond")], { now: at(9) });
  assert.equal(s.slots.length, 1);
  assert.equal(s.slots[0].item.by, "you");
  assert.match(s.notes.join(" "), /Folded my “Transformers: attention” into your “Learn attention”/);
});

test("a full day: Bond's items are left out before yours, with a reason", () => {
  const items = [item("Deep work", 240), item("Edit video", 120), item("Revise", 60, "bond"), item("Idea", 30, "bond")];
  const s = fit(items, { now: at(9), cap: 360 });
  assert.deepEqual(s.slots.map((x) => x.item.title).sort(), ["Deep work", "Edit video"]);
  assert.equal(s.left.length, 2);
  assert.match(s.notes.join(" "), /already a full day/);
});

test("yours is shortened before it is dropped; a time that has passed finds a new one", () => {
  const s = fit([item("Big task", 120), item("Missed", 30, "you", { at: "08:00" })], { now: at(18), end: at(20) });
  const big = s.slots.find((x) => x.item.title === "Big task")!;
  assert.ok(big.item.mins < 120 && big.item.mins >= 15, JSON.stringify(s));
  assert.match(s.notes.join(" "), /Shortened “Big task”/);
  assert.match(s.notes.join(" "), /“Missed” was for 08:00, which has passed/);
});

test("two fixed items at the same time: the first stays, the other is moved", () => {
  const s = fit([item("A", 60, "you", { at: "15:00" }), item("B", 60, "you", { at: "15:30" })], { now: at(9) });
  assert.equal(clock(s.slots.find((x) => x.item.title === "A")!.start), "15:00");
  assert.notEqual(clock(s.slots.find((x) => x.item.title === "B")!.start), "15:30");
  assert.match(s.notes.join(" "), /overlaps another/);
});

test("done items are left alone, and Bond's first item leads his others", () => {
  const s = fit([item("Done thing", 60, "you", { done: true }), item("Later", 30, "bond"), item("Avoided", 45, "bond", { first: true })], { now: at(9) });
  assert.deepEqual(s.slots.map((x) => x.item.title), ["Avoided", "Later"]);
});

test("suggestions: today's focus not yet planned, and one idea untouched for days; nothing twice", () => {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const src = { goals: ["Study diffusion transformers"], ideas: [{ text: "AI funny channel", at: now - 5 * day }, { text: "fresh idea", at: now - day }] };
  const s = suggest({ items: [], dismissed: [] }, src, now);
  assert.equal(s.length, 2);
  assert.match(s[0].title, /Work on: Study diffusion/);
  assert.match(s[1].why!, /5 days ago/);
  assert.equal(suggest({ items: [item("study diffusion transformers", 45)], dismissed: [] }, src, now).length, 1, "already planned");
  assert.equal(suggest({ items: [], dismissed: ["Look at your idea: AI funny channel"] }, src, now).length, 1, "dismissed today");
});

test("what was left undone on earlier days comes back first, as yours, once", () => {
  const now = Date.now();
  const days = [
    { when: "yesterday", plan: { items: [item("Edit the intro video", 60), item("Reply to Ram", 30, "you", { done: true })], dismissed: [] } },
    { when: "on Tuesday", plan: { items: [item("Edit intro video", 60), item("Read the attention paper", 45)], dismissed: [] } },
  ];
  const left = unfinished(days);
  assert.deepEqual(left.map((u) => `${u.title} (${u.when})`), ["Edit the intro video (yesterday)", "Read the attention paper (on Tuesday)"]);
  const s = suggest({ items: [], dismissed: [] }, { goals: ["Read the attention paper"], ideas: [], unfinished: left }, now);
  assert.deepEqual(s.map((x) => x.title), ["Edit the intro video", "Read the attention paper"], "the focus isn't offered twice");
  assert.ok(s.every((x) => x.by === "you"));
  assert.match(s[0].why!, /Not finished yesterday/);
  assert.equal(suggest({ items: [item("edit intro video", 60)], dismissed: [] }, { goals: [], ideas: [], unfinished: left }, now).length, 1, "already back in today's plan");
});
