// Idea lifecycle, titles, task suggestions and filters.

import { test } from "node:test";
import assert from "node:assert/strict";
import { byRecent, deriveTitle, matches, parseTasks, statusOf, taskProgress, titleOf, withStatus, type Idea } from "../src/assistant/ideacore.ts";

const old: Idea = { id: "a", text: "Dataset to Pickle Converter: A tool where providing a raw dataset automatically outputs a ready-to-use pickle file.", at: 1000, done: false };

test("ideas saved by older versions still make sense", () => {
  assert.equal(statusOf(old), "inbox");
  assert.equal(statusOf({ ...old, done: true }), "building"); // ticked as "started"
  assert.equal(statusOf({ ...old, status: "exploring" }), "exploring");
  // Nothing of the original is lost by looking at it.
  assert.equal(titleOf(old), "Dataset to Pickle Converter");
  assert.equal(old.text.startsWith("Dataset to Pickle Converter: A tool"), true);
});

test("changing the stage keeps `done` right for older copies, and a stage can be left again", () => {
  const building = withStatus(old, "building", 5);
  assert.equal(building.done, true);
  assert.equal(building.updatedAt, 5);
  assert.equal(withStatus(building, "exploring", 6).done, false);
  assert.equal(withStatus(old, "exploring").done, false); // Exploring is not "started"
  assert.equal(withStatus(old, "completed").done, true);
});

test("titles come from the idea but never cut a word in half", () => {
  assert.equal(deriveTitle("A tiny app that tells me when my plants need water"), "A tiny app that tells me when my plants need water");
  assert.equal(deriveTitle("   "), "Untitled idea");
  const long = "While doing vibe coding, how do we use our time when Claude Code is generating the task for you and nothing else is going on";
  const t = deriveTitle(long);
  assert.ok(t.length <= 66, t);
  assert.ok(t.endsWith("…"), t);
  assert.ok(!/\s…$/.test(t));
  assert.ok(long.startsWith(t.slice(0, -1)), "a title is always a piece of the idea");
  assert.equal(deriveTitle("Phone airplane mode checker. It detects flight mode and turns it on."), "Phone airplane mode checker");
  assert.equal(titleOf({ ...old, title: "  My title " }), "My title");
});

test("task suggestions: lines that look like tasks, without repeats", () => {
  const raw = ["Here is a plan:", "- Interview three people who fly often", "* Sketch the main screen.", "2) Build a tiny prototype", "3. build a tiny prototype", "", "Hope that helps!"].join("\n");
  assert.deepEqual(parseTasks(raw), ["Interview three people who fly often", "Sketch the main screen", "Build a tiny prototype"]);
  assert.deepEqual(parseTasks(raw, ["sketch the main screen"]), ["Interview three people who fly often", "Build a tiny prototype"]);
  assert.deepEqual(parseTasks("no list here at all"), []);
  assert.equal(parseTasks(Array.from({ length: 30 }, (_, i) => `- task number ${i}`).join("\n")).length, 10);
});

test("task progress counts steps, and is separate from the idea's stage", () => {
  const i: Idea = { ...old, status: "exploring", tasks: [{ id: "1", text: "a", done: true, at: 1 }, { id: "2", text: "b", done: false, at: 2 }] };
  assert.deepEqual(taskProgress(i), { done: 1, total: 2 });
  assert.equal(statusOf(i), "exploring");
  assert.deepEqual(taskProgress(old), { done: 0, total: 0 });
});

test("filters: stage, starred, search", () => {
  const a: Idea = { ...old, id: "1", status: "exploring", starred: true };
  const b: Idea = { ...old, id: "2", text: "A plant app", notes: "soil sensor" };
  const all = { status: "all" as const, starred: false, query: "" };
  assert.equal(matches(a, all) && matches(b, all), true);
  assert.equal(matches(a, { ...all, status: "exploring" }), true);
  assert.equal(matches(b, { ...all, status: "exploring" }), false);
  assert.equal(matches(b, { ...all, status: "inbox" }), true);
  assert.equal(matches(a, { ...all, starred: true }), true);
  assert.equal(matches(b, { ...all, starred: true }), false);
  assert.equal(matches(b, { ...all, query: "SOIL" }), true); // searches your notes too
  assert.equal(matches(a, { ...all, query: "soil" }), false);
});

test("most recently touched first", () => {
  const a: Idea = { ...old, id: "1", at: 100 };
  const b: Idea = { ...old, id: "2", at: 50, updatedAt: 500 };
  assert.deepEqual([a, b].sort(byRecent).map((x) => x.id), ["2", "1"]);
});
