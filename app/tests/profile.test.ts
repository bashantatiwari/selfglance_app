// Run: node --experimental-strip-types --test tests/   (from app/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { aimWords, dayBounds, EMPTY_PROFILE, isCreator, mentions, profileLine, projectList, type Profile } from "../src/assistant/profile.ts";
import { makeJudge, verdict } from "../src/assistant/goals.ts";

const alex: Profile = { ...EMPTY_PROFILE, name: "Alex", now: "computer science student", aim: "AI Engineer", projects: "content creation (YouTube)", tone: "direct" };

test("the brain gets one short line, and nothing when the profile is empty", () => {
  assert.equal(profileLine(EMPTY_PROFILE), "");
  const line = profileLine(alex);
  assert.equal(line, "Call them Alex. Now: computer science student. Working toward: AI Engineer. Side projects: content creation (YouTube). Usual hours 09:00–22:00. Wants direct, short answers.");
  assert.ok(profileLine({ ...alex, more: "x".repeat(2000) }).length <= 500);
});

test("aim words recognise the field, and short words match whole words only", () => {
  const w = aimWords(alex);
  assert.ok(w.includes("pytorch") && w.includes("transformer") && w.includes("ai"));
  assert.ok(!w.includes("engineer"), "too common to tell anything");
  assert.ok(mentions("Let's build GPT from scratch - Andrej Karpathy", w));
  assert.ok(mentions("Intro to AI | Lecture 1", w));
  assert.ok(!mentions("Rain sounds for sleeping", w), "'ai' is not in 'rain'");
  assert.deepEqual(projectList({ ...alex, projects: "a chess app, content creation and a blog" }), ["a chess app", "content creation", "a blog"]);
  assert.ok(isCreator(alex));
  assert.ok(!isCreator({ ...alex, projects: "a chess app" }));
});

test("hours bound the day; an end past midnight is held at 23:59", () => {
  assert.deepEqual(dayBounds(alex), { start: 540, end: 1320 });
  assert.deepEqual(dayBounds({ ...alex, start: "18:00", end: "02:00" }), { start: 1080, end: 1439 });
});

type Seg = { start: number; end: number; ctx: "focus" | "watching" | "other" | "meeting" | "game"; label: string; app: string };
const seg = (label: string, ctx: Seg["ctx"] = "watching", app = "Google Chrome"): Seg => ({ start: 0, end: 5 * 60_000, ctx, label, app });

test("for a creator headed for AI: their tools are work, videos about the aim aren't distraction, the rest still is", () => {
  const study = makeJudge(["study transformers"], {}, {}, alex);
  assert.equal(verdict(seg("Channel content - YouTube Studio - Google Chrome"), study), "neutral", "work, but not today's focus");
  assert.equal(verdict(seg("Let's build GPT from scratch - Andrej Karpathy - YouTube"), study), "on", "today's focus is AI work");
  assert.equal(verdict(seg("Funny cat compilation - YouTube"), study), "off");
  const edit = makeJudge(["edit the intro video"], {}, {}, alex);
  assert.equal(verdict(seg("intro_v3 - DaVinci Resolve", "focus", "DaVinci Resolve"), edit), "on");
  assert.equal(verdict(seg("Let's build GPT from scratch - Andrej Karpathy - YouTube"), edit), "neutral", "about the aim, not today's focus");
  // Without a profile nothing changes.
  const plain = makeJudge(["study transformers"], {}, {}, EMPTY_PROFILE);
  assert.notEqual(verdict(seg("Channel content - YouTube Studio - Google Chrome"), plain), "neutral");
});

const item = (title: string, extra: Partial<PlanItem> = {}): PlanItem => ({ id: title, title, mins: 45, by: "you", ...extra });
const src = { goals: [], ideas: [], aim: alex.aim, aimWords: aimWords(alex), projects: projectList(alex) };
