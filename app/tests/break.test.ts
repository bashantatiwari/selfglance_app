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

import { doneLine, expected, nudgeLine, offerLine, TIPS } from "../src/break/lines.ts";

test("a break line fits the moment and never repeats its tip twice running", () => {
  assert.match(offerLine({ glasses: 0, goal: 8, hour: 9 }, () => 0), /^First glass of the day\./);
  assert.match(offerLine({ glasses: 0, goal: 8, hour: 15 }, () => 0), /^No water yet today\./);
  assert.match(offerLine({ glasses: 2, goal: 8, hour: 17 }, () => 0), /2 of 8 so far, a bit behind/);
  assert.match(offerLine({ glasses: 4, goal: 8, hour: 14 }, () => 0), /4 of 8\. You're on pace/);
  assert.match(offerLine({ glasses: 8, goal: 8, hour: 14 }, () => 0), /hit your 8 already/);
  assert.match(offerLine({ glasses: 7, goal: 8, hour: 22 }, () => 0), /Last one for tonight/);
  let last = "";
  for (let i = 0; i < 30; i++) {
    const line = offerLine({ glasses: 3, goal: 8, hour: 13 }, () => 0);
    const tip = TIPS.find((t) => line.endsWith(t))!;
    assert.notEqual(tip, last, "same tip twice in a row");
    last = tip;
  }
  assert.notEqual(nudgeLine(() => 0), nudgeLine(() => 0));
});

test("after a glass: the count, a cheer, and the goal gets its own line", () => {
  assert.match(doneLine({ glasses: 3, goal: 8 }, () => 0), /^3 of 8\. /);
  assert.match(doneLine({ glasses: 8, goal: 8 }), /today's water done/);
  assert.match(doneLine({ glasses: 9, goal: 8 }), /Over the goal/);
  assert.equal(expected(8, 7), 0);
  assert.equal(expected(8, 14), 4);
  assert.equal(expected(8, 23), 8);
});
