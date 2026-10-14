// When "Journal first" asks, and when it leaves you alone.

import { test } from "node:test";
import assert from "node:assert/strict";
import { journalFirstDue, type JournalFirstState } from "../src/assistant/journalfirst.ts";

const base: JournalFirstState = { now: 1_000_000_000, hour: 21, at: 21, day: "2026-10-14", skippedDay: null, askedDay: null, lastAsked: 0, entertaining: false };
const with_ = (p: Partial<JournalFirstState>) => ({ ...base, ...p });

test("quiet before the evening hour", () => {
  assert.equal(journalFirstDue(with_({ hour: 20 })), null);
});

test("asks once when the evening hour comes", () => {
  assert.equal(journalFirstDue(base), "first");
  assert.equal(journalFirstDue(with_({ hour: 23, askedDay: "2026-10-13" })), "first"); // yesterday's ask doesn't count
});

test("after asking, stays quiet while you do other things", () => {
  assert.equal(journalFirstDue(with_({ askedDay: base.day, lastAsked: base.now - 60 * 60_000 })), null);
});

test("asks again when you start something entertaining, but not more than every 15 minutes", () => {
  assert.equal(journalFirstDue(with_({ askedDay: base.day, lastAsked: base.now - 20 * 60_000, entertaining: true })), "again");
  assert.equal(journalFirstDue(with_({ askedDay: base.day, lastAsked: base.now - 5 * 60_000, entertaining: true })), null);
});

test("'Not tonight' silences the whole day, even for entertainment", () => {
  assert.equal(journalFirstDue(with_({ skippedDay: base.day })), null);
  assert.equal(journalFirstDue(with_({ skippedDay: base.day, askedDay: base.day, lastAsked: 0, entertaining: true })), null);
});

test("a skip yesterday does not carry over", () => {
  assert.equal(journalFirstDue(with_({ skippedDay: "2026-10-13" })), "first");
});
