import test from "node:test";
import assert from "node:assert/strict";
import { BreakCoach } from "../src/break/BreakCoach.ts";

const events = () => {
  const seen: string[] = [];
  return { seen, e: { start: () => seen.push("start"), settle() {}, nudge() {}, away() {}, complete() {} } };
};

test("a break starts after the active minutes, even when ticks arrive far apart", () => {
  const { seen, e } = events();
  const coach = new BreakCoach(e, () => null, 45);
  const realNow = Date.now;
  let t = realNow();
  Date.now = () => t;
  try {
    coach.onIdle(1);
    for (let i = 0; i < 50; i++) {
      t += 60_000; // a throttled webview: one tick a minute
      coach.onIdle(1);
    }
  } finally {
    Date.now = realNow;
  }
  assert.deepEqual(seen, ["start"]);
});

test("a hard block holds the break and says so", () => {
  const { seen, e } = events();
  const lines: string[] = [];
  const coach = new BreakCoach(e, () => "hard", 1, (l) => lines.push(l));
  const realNow = Date.now;
  let t = realNow();
  Date.now = () => t;
  try {
    coach.onIdle(1);
    for (let i = 0; i < 14; i++) {
      t += 30_000;
      coach.onIdle(1);
    }
  } finally {
    Date.now = realNow;
  }
  assert.deepEqual(seen, []);
  assert.ok(lines.some((l) => l.includes("held back (hard)")), lines.join("|"));
});

import { doneLine, nudgeLine, offerLine, TIPS } from "../src/break/lines.ts";

test("a break line asks you to stand up and drink, and never repeats its tip twice running", () => {
  const a = offerLine(() => 0);
  const b = offerLine(() => 0);
  assert.match(a, /water/);
  assert.notEqual(a, b);
  assert.ok(TIPS.some((t) => a.endsWith(t)));
  assert.ok(nudgeLine().length > 0 && doneLine().length > 0);
  assert.doesNotMatch(a, /glass/i, "no counting");
});
