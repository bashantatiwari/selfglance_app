// Run: node --experimental-strip-types --test tests/   (from app/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { blockedBy, habitText, inQuietHours, naturalPause, Pacer, searchQuery, StuckWatch } from "../src/assistant/notice.ts";

const win = (title: string, app = "chrome", name = "Google Chrome") => ({ app, name, title, fullscreen: false });
const MIN = 60_000;

test("reads the query out of a search tab", () => {
  assert.equal(searchQuery("rust e0382 borrow - Google Search - Google Chrome"), "rust e0382 borrow");
  assert.equal(searchQuery("pip not recognized - Bing - Microsoft Edge"), "pip not recognized");
  assert.equal(searchQuery("Inbox - Gmail - Google Chrome"), null);
});

test("several searches while working means stuck; browsing alone doesn't", () => {
  const w = new StuckWatch();
  const t0 = 1_000_000;
  w.push(win("a.rs - api - Visual Studio Code", "code", "Visual Studio Code"), "focus", t0);
  w.push(win("rust e0382 - Google Search - Google Chrome"), "other", t0 + MIN);
  w.push(win("rust moved value closure - Google Search - Google Chrome"), "other", t0 + 2 * MIN);
  assert.equal(w.stuck("helpful", t0 + 2 * MIN), null, "two searches isn't enough at this level");
  assert.deepEqual(w.stuck("chatty", t0 + 2 * MIN), ["rust e0382", "rust moved value closure"]);
  w.push(win("Borrow of moved value - Stack Overflow - Google Chrome"), "other", t0 + 3 * MIN);
  assert.ok(w.stuck("helpful", t0 + 3 * MIN));
  assert.equal(w.stuck("helpful", t0 + 20 * MIN), null, "too long ago");

  const browsing = new StuckWatch();
  for (const [i, q] of ["pizza", "weather", "movies"].entries()) browsing.push(win(`${q} - Google Search - Google Chrome`), "other", t0 + i * MIN);
  assert.equal(browsing.stuck("chatty", t0 + 3 * MIN), null);
});

test("speaks up only at a natural pause", () => {
  const m = { idleSec: 5, ctx: "focus" as const, busy: false, inBreak: false };
  assert.ok(naturalPause(m));
  assert.ok(!naturalPause({ ...m, idleSec: 0 }), "typing");
  assert.ok(!naturalPause({ ...m, idleSec: 200 }), "away");
  assert.ok(!naturalPause({ ...m, ctx: "meeting" }));
  assert.ok(!naturalPause({ ...m, ctx: "watching" }));
  assert.ok(!naturalPause({ ...m, busy: true }));
});

test("quiet hours wrap past midnight", () => {
  const at = (h: number) => new Date(2026, 9, 8, h, 30);
  assert.ok(inQuietHours(at(23), 22, 8));
  assert.ok(inQuietHours(at(3), 22, 8));
  assert.ok(!inQuietHours(at(12), 22, 8));
  assert.ok(inQuietHours(at(13), 12, 14));
  assert.ok(!inQuietHours(at(13), 9, 9), "from = to: none");
});

test("per-hour cap and gap", () => {
  const p = new Pacer();
  const t0 = 10_000_000;
  assert.ok(p.canShow("helpful", 2, t0));
  p.shown(t0);
  assert.ok(!p.canShow("helpful", 2, t0 + 5 * MIN), "10 min gap at helpful");
  assert.ok(p.canShow("chatty", 2, t0 + 5 * MIN));
  p.shown(t0 + 11 * MIN);
  assert.ok(!p.canShow("helpful", 2, t0 + 30 * MIN), "two this hour already");
  assert.ok(p.canShow("helpful", 2, t0 + 61 * MIN));
  assert.ok(!p.canShow("off", 9, t0 + 120 * MIN));
});

test("blocklist and wording", () => {
  assert.ok(blockedBy(win("Payroll 2026 - Excel", "excel", "Excel"), "payroll, slack"));
  assert.ok(!blockedBy(win("main.rs - Visual Studio Code"), "payroll, slack"));
  assert.ok(!blockedBy(win("anything"), " , "));
  assert.equal(habitText("open Spotify", "Visual Studio Code", null), "You usually open Spotify when you're in VS Code. Want me to?");
  assert.equal(habitText("open youtube.com", null, 9), "You usually open youtube.com in the morning. Want me to?");
});
