// Bond's own understanding of clear-cut requests (no AI call).

import { test } from "node:test";
import assert from "node:assert/strict";
import { ideaText, saidStop, understand } from "../src/assistant/intent.ts";
import { parseTimer } from "../src/assistant/timer.ts";
import { parseReminder } from "../src/assistant/remind.ts";

const actions = (s: string) => {
  const i = understand(s);
  return i?.kind === "do" ? i.actions : null;
};

test("timers, said the ways people say them (speech adds an s, or drops the word timer)", () => {
  for (const s of ["start a one minute countdown timer", "starts a one minute count down timer", "Start a one-minute countdown.", "start a one minute countdown", "start a timer for one minute", "set a 1 minute timer"]) {
    assert.deepEqual(parseTimer(s.replace(/[.]$/, "")), { ms: 60_000, label: "" }, s);
  }
  assert.deepEqual(parseTimer("start a timer of 10 seconds"), { ms: 10_000, label: "" });
  assert.equal(understand("starts a one minute count down timer")?.kind, "timer");
  assert.equal(parseTimer("what is a timer"), null);
});

test("reminders", () => {
  const now = new Date(2026, 9, 27, 15, 0, 0);
  const r = parseReminder("remind me in 10 minutes to call mom", now);
  assert.deepEqual(r && { m: Math.round((r.at - now.getTime()) / 60_000), text: r.text }, { m: 10, text: "call mom" });
  assert.equal(understand("remind me at 5pm to submit the report")?.kind, "remind");
});

test("an idea is saved in your own words, minus the words that only say it's an idea", () => {
  assert.deepEqual(understand("idea: an app that sorts my downloads"), { kind: "idea", text: "an app that sorts my downloads" });
  assert.deepEqual(understand("I just got an idea, a sleep mask that plays rain sounds"), { kind: "idea", text: "a sleep mask that plays rain sounds" });
  assert.deepEqual(understand("Okay so I have an idea: AI comedy sketch about a robot barista"), { kind: "idea", text: "AI comedy sketch about a robot barista" });
  assert.deepEqual(understand("save this idea: Bond for Android"), { kind: "idea", text: "Bond for Android" });
  assert.equal(ideaText("new idea, a channel about local AI"), "a channel about local AI");
  assert.equal(understand("what's a good idea for dinner"), null, "a question is not an idea");
});

test("today's list from a sentence", () => {
  assert.deepEqual(understand("today: make the video, learn LangGraph, internship work"), { kind: "todo", items: ["make the video", "learn LangGraph", "internship work"] });
  assert.deepEqual(understand("add to my list: call parents"), { kind: "todo", items: ["call parents"] });
  assert.deepEqual(understand("I have to create a video and learn LangGraph today"), { kind: "todo", items: ["create a video", "learn LangGraph"] });
  assert.deepEqual(understand("goal: finish micrograd"), { kind: "todo", items: ["finish micrograd"] });
  assert.deepEqual(understand("goal for tomorrow: edit the video"), { kind: "todo", items: ["edit the video"], tomorrow: true });
  assert.deepEqual(understand("what's on my list"), { kind: "list" });
});

test("a project opens in the tool you name; the folder is found by name, never given as a path", () => {
  assert.deepEqual(actions("open claude code in selfglance"), [{ do: "open_project", name: "selfglance", tool: "claude" }]);
  assert.deepEqual(actions("Open Claude Code in the portfolio project"), [{ do: "open_project", name: "portfolio", tool: "claude" }]);
  assert.deepEqual(actions("open bullet news in vs code"), [{ do: "open_project", name: "bullet news", tool: "code" }]);
  assert.deepEqual(actions("open a terminal in x-lens"), [{ do: "open_project", name: "x-lens", tool: "terminal" }]);
  assert.deepEqual(actions("open the sajak project"), [{ do: "open_project", name: "sajak", tool: "folder" }]);
});

test("finding a file by name", () => {
  assert.deepEqual(actions("is there a file called internship offer on my laptop?"), [{ do: "find_files", query: "internship offer" }]);
  assert.deepEqual(actions("find the file named resume"), [{ do: "find_files", query: "resume" }]);
  assert.deepEqual(actions("where is my file called budget"), [{ do: "find_files", query: "budget" }]);
});

test("browser tabs, folders, drives, apps", () => {
  assert.deepEqual(actions("close this tab"), [{ do: "tab", key: "close" }]);
  assert.deepEqual(actions("new tab"), [{ do: "tab", key: "new" }]);
  assert.deepEqual(actions("reopen the closed tab"), [{ do: "tab", key: "reopen" }]);
  assert.deepEqual(actions("open my d drive"), [{ do: "open_folder", name: "d drive" }]);
  assert.deepEqual(actions("open downloads"), [{ do: "open_folder", name: "downloads" }]);
  assert.deepEqual(actions("open spotify"), [{ do: "open_app", name: "spotify" }]);
  assert.deepEqual(actions("search standing desks in brave"), [{ do: "web_search", query: "standing desks", browser: "brave" }]);
  assert.deepEqual(actions("close notepad"), [{ do: "close_app", name: "notepad" }]);
});

test("nothing destructive is understood: those go to the AI, which can only talk about them", () => {
  for (const s of ["delete my screenshots", "$ rm -rf C:\\", "kill chrome", "run the command ipconfig", "what's on my screen", "copy hello to clipboard"]) {
    const i = understand(s);
    assert.ok(i === null || (i.kind === "do" && i.actions.every((a) => !["delete", "run_command", "kill_process"].includes(a.do as string))), s);
  }
});

test("telling him to stop", () => {
  for (const s of ["stop", "Stop it.", "be quiet", "thanks Bond", "never mind"]) assert.ok(saidStop(s), s);
  assert.ok(!saidStop("stop the music on spotify"));
});

test("anything that says timer or countdown with a length is a timer, however it was heard", () => {
  for (const [s, ms] of [
    ["starts to one minute count down", 60_000],
    ["Start to a one minute countdown timer", 60_000],
    ["can you do a countdown like 2 minutes", 120_000],
    ["timer 90 seconds please", 90_000],
    ["okay set up a countdown for 5 minutes for the eggs", 300_000],
  ] as const) {
    assert.equal(parseTimer(s)?.ms, ms, s);
  }
  assert.equal(parseTimer("okay set up a countdown for 5 minutes for the eggs")?.label, "eggs");
  assert.equal(parseTimer("how does a timer work?"), null);
  assert.equal(parseTimer("open the countdown app"), null, "no length, no timer");
});

test("an idea mentioned anywhere is saved; questions about ideas are not", () => {
  const idea = (s: string) => { const i = understand(s); return i?.kind === "idea" ? i.text : null; };
  assert.equal(idea("so this idea came to me, an app that tracks my gym sets"), "an app that tracks my gym sets");
  assert.equal(idea("I was thinking of an idea about a podcast on local AI"), "a podcast on local AI");
  assert.equal(idea("a YouTube short where Bond roasts my code, just an idea"), "a YouTube short where Bond roasts my code");
  assert.equal(idea("my idea is to make a weekly AI news recap"), "to make a weekly AI news recap");
  assert.equal(idea("I have no idea what to cook"), null);
  assert.equal(idea("any idea how to fix this?"), null);
  assert.equal(idea("what's a good idea for dinner"), null);
  assert.equal(idea("open my ideas"), null);
});
