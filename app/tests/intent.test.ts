// Bond's own understanding of clear-cut requests (no AI call).

import { test } from "node:test";
import assert from "node:assert/strict";
import { isGuideFollowUp, saidStop, spokenAnswer, understand, unsavedAnswer } from "../src/assistant/intent.ts";

test("clearing out screenshots goes to delete, never straight to a command", () => {
  for (const q of ["delete my screenshots", "delete all my screenshots", "clear the screenshots folder", "remove all of my screenshot images", "get rid of my screenshots"]) {
    assert.deepEqual(understand(q), { kind: "do", actions: [{ do: "delete", paths: ["screenshots/*"] }] }, q);
  }
});

test("the screenshots folder opens like the other folders", () => {
  assert.deepEqual(understand("open my screenshots folder"), { kind: "do", actions: [{ do: "open_folder", name: "screenshots" }] });
});

test("being in a screenshot: hidden unless he is asked", () => {
  for (const q of ["include yourself in the screenshot", "Include yourself in the next screenshot.", "show yourself in the screenshot", "put yourself in my screenshot", "I want you to appear in the screenshot", "take a screenshot with you", "show up in the recording", "leave yourself in the screen recording"]) {
    assert.deepEqual(understand(q), { kind: "capture", show: true }, q);
  }
  for (const q of ["hide yourself from the screenshot", "hide from screenshots", "keep yourself out of the screenshots", "don't show yourself in screenshots", "don't appear in the screenshot", "stop appearing in my screenshots", "remove yourself from the recording"]) {
    assert.deepEqual(understand(q), { kind: "capture", show: false }, q);
  }
});

test("other screenshot requests are not about being in one", () => {
  assert.deepEqual(understand("delete my screenshots"), { kind: "do", actions: [{ do: "delete", paths: ["screenshots/*"] }] });
  assert.deepEqual(understand("open my screenshots folder"), { kind: "do", actions: [{ do: "open_folder", name: "screenshots" }] });
  for (const q of ["what's in this screenshot", "take a screenshot", "where do my screenshots go", "save a picture of my screen"]) {
    assert.notEqual(understand(q)?.kind, "capture", q);
  }
});

test("freeing up RAM", () => {
  for (const q of ["free up ram", "free up some memory", "clear my ram", "reduce ram usage", "save memory"]) {
    assert.deepEqual(understand(q), { kind: "do", actions: [{ do: "free_memory" }] }, q);
  }
  // Asking what uses it still just shows it.
  assert.deepEqual(understand("what's eating my ram"), { kind: "do", actions: [{ do: "top_processes" }] });
});

test("answering his questions out loud", () => {
  assert.equal(spokenAnswer("Yes.", false), "yes");
  assert.equal(spokenAnswer("Yeah, go ahead", false), "yes");
  assert.equal(spokenAnswer("Okay, do it.", false), "yes");
  assert.equal(spokenAnswer("No, don't.", false), "no");
  assert.equal(spokenAnswer("Never mind", true), "no");
  // Anything else is a new request.
  assert.equal(spokenAnswer("open spotify", false), null);
  // Said in a sentence, as people do.
  assert.equal(spokenAnswer("I need you to run this command.", false), "yes");
  assert.equal(spokenAnswer("Go ahead and execute it", false), "yes");
  assert.equal(spokenAnswer("Please don't run it", false), "no");
});

test("a spoken yes is a clear whole answer, never a question or a hedge", () => {
  for (const q of [
    "Okay, what does it do?",
    "Sure, but is it safe?",
    "should I do it?",
    "what happens if I do that",
    "yes?? wait what",
    "Ok so is this going to delete anything",
    "Can you run it with admin?",
    "I'm not sure, maybe go ahead",
    "okay but only the first one",
  ]) {
    assert.equal(spokenAnswer(q, false), null, q);
  }
});

test("the last check before deleting is typed: a voice can say no, never yes", () => {
  for (const q of ["Yes", "Delete them.", "Yes, delete.", "I'm not going to delete anything", "why would it delete them?", "go ahead and delete"]) {
    assert.equal(spokenAnswer(q, true), null, q);
  }
  assert.equal(spokenAnswer("No, cancel that", true), "no");
});

test("'save' by voice is a short plain answer, not a sentence that mentions saving", () => {
  assert.equal(unsavedAnswer("Save it"), "save");
  assert.equal(unsavedAnswer("yes, save"), "save");
  assert.equal(unsavedAnswer("Don't save"), "discard");
  assert.equal(unsavedAnswer("Can you save it first?"), null);
  assert.equal(unsavedAnswer("I forgot whether I need to save this"), null);
});

test("\"run it\" is about something said before, not an app called it", () => {
  for (const q of ["Run it.", "run this", "open it", "run the command", "start that"]) assert.equal(understand(q), null, q);
  assert.deepEqual(understand("open notepad"), { kind: "do", actions: [{ do: "open_app", name: "notepad" }] });
});

test("telling him to stop", () => {
  for (const s of ["Stop.", "be quiet", "Thanks, Bond.", "thank you"]) assert.ok(saidStop(s), s);
  assert.ok(!saidStop("stop the music"));
});

test("closing an app asks it nicely; killing ends it", () => {
  for (const q of ["Close it.", "close this app", "quit that"]) assert.deepEqual(understand(q), { kind: "do", actions: [{ do: "close_app", name: "it" }] }, q);
  assert.deepEqual(understand("close notepad"), { kind: "do", actions: [{ do: "close_app", name: "notepad" }] });
  assert.deepEqual(understand("kill chrome"), { kind: "do", actions: [{ do: "kill_process", name: "chrome" }] });
  assert.equal(understand("close this tab"), null);
});

test("answering \"it has unsaved changes\"", () => {
  for (const s of ["Don't save.", "Don't say.", "close it without saving", "discard them"]) assert.equal(unsavedAnswer(s), "discard", s);
  for (const s of ["Save.", "save it", "keep the changes"]) assert.equal(unsavedAnswer(s), "save", s);
  for (const s of ["Cancel", "no", "leave it open"]) assert.equal(unsavedAnswer(s), "cancel", s);
});

test("jobs you want to do yourself start guide mode", () => {
  for (const q of [
    "walk me through buying a domain",
    "guide me through this form",
    "show me how to change my DNS",
    "show me where to click",
    "where do I click?",
    "I'm about to buy a domain, help me out",
    "help me buy a domain name",
    "point me to the checkout button",
    "I want to record my screen as well as my face, help me how to do that",
    "help me how to do that",
    "help me figure out how to share my screen",
    "how do I record my screen in OBS",
    "Help me to record my screen as well as my face using OBS Studio.",
    "help me set up a second monitor",
    "Help me  to record my screen as well as my face in obs studio",
    "Help me to capture my screen as well as my face using obs studio",
  ]) {
    assert.deepEqual(understand(q), { kind: "screen", mode: "guide" }, q);
  }
  // Not these: Bond does them himself, or they're something else.
  assert.deepEqual(understand("open spotify"), { kind: "do", actions: [{ do: "open_app", name: "spotify" }] });
  assert.deepEqual(understand("help"), { kind: "screen", mode: "help" });
  // Help with words is not a walkthrough.
  assert.notDeepEqual(understand("help me write an email to my landlord"), { kind: "screen", mode: "guide" });
  assert.notDeepEqual(understand("help me summarize this article please"), { kind: "screen", mode: "guide" });
});

test("stopping, in the ways people say it", () => {
  for (const q of ["stop", "Stop that.", "okay stop", "Bond, stop", "wait", "hold on", "cancel that", "never mind", "that's enough", "please stop"]) {
    assert.equal(saidStop(q), true, q);
  }
  // A request that merely contains the word is still a request.
  for (const q of ["stop the music", "wait for the download to finish", "open notepad"]) {
    assert.equal(saidStop(q), false, q);
  }
});

test("skipping a song is understood without the AI, with or without 'this'", () => {
  for (const q of ["skip", "next song", "skip this song", "skip the track", "skip that video", "next"]) {
    assert.deepEqual(understand(q), { kind: "do", actions: [{ do: "media", key: "next" }] }, q);
  }
});

test("a goal for the day is understood without the AI", () => {
  assert.deepEqual(understand("goal: finish micrograd"), { kind: "goal", text: "finish micrograd" });
  assert.deepEqual(understand("my focus today is the resume"), { kind: "goal", text: "the resume" });
  assert.equal(understand("what is a goal in football")?.kind ?? null, null);
});

test("a message to write is understood without the AI", () => {
  const kind = (s: string) => understand(s)?.kind ?? null;
  assert.equal(kind("write me a msg stating that the review is taking long"), "draft");
  assert.equal(kind("Write a polite email to my manager asking for leave"), "draft");
  assert.equal(kind("draft a quick slack message to the team"), "draft");
  assert.equal(kind("can you help me write a follow-up email"), "draft");
  assert.equal(kind("what should I reply to this?"), "draft");
  assert.equal(kind("reply to her saying yes, thursday works"), "draft");
  // in the middle of a guided job, these carry on with it
  for (const s of ["Already I am already in Cloudflare dot com, now what's next?", "I'm already in Cloudflare.com, now what's next?", "now what", "what next?", "okay, what do I do now", "As for the instruction I have given you earlier, now what next?", "continue", "I did that"]) assert.ok(isGuideFollowUp(s), s);
  for (const s of ["what should I reply to the terminal", "open notepad", "next week remind me to call Sam", "what is the weather", "I am in a meeting"]) assert.ok(!isGuideFollowUp(s), s);
  // said in a longer sentence: text to put in the terminal's box, not a click-by-click guide
  assert.equal(kind("I want to know what should I reply to the terminal on my right side."), "draft");
  assert.equal(kind("I'm confused what am I supposed to give prompt to the command terminal."), "draft");
  assert.equal(kind("Thank you, what should I type?"), "draft");
  assert.deepEqual(understand("write me a message to Sam saying hi"), { kind: "draft", request: "write me a message to Sam saying hi" });
  // text for a box that isn't a "message"
  assert.equal(kind("Write a prompt in the chatgpt stating that I want logo for selfglance and write it in a professional way"), "draft");
  assert.equal(kind("write a linkedin post about my new job"), "draft");
  assert.equal(kind("write a short caption for my photo"), "draft");
  assert.equal(kind("write this in the chatgpt box: make me a logo"), "draft");
  // not messages
  assert.notEqual(kind("write a function that sorts a list"), "draft");
  assert.notEqual(kind("write a poem about rain"), "draft");
  assert.notEqual(kind("open slack"), "draft");
  assert.notEqual(kind("write a function in rust that reverses a string"), "draft");
});

test("a search can name the browser", () => {
  const act = (s: string) => (understand(s) as { actions: { do: string; query?: string; browser?: string }[] } | null)?.actions[0];
  assert.deepEqual(act("search standing desks in brave"), { do: "web_search", query: "standing desks", browser: "brave" });
  assert.deepEqual(act("google best laptops on Chrome"), { do: "web_search", query: "best laptops", browser: "chrome" });
  assert.deepEqual(act("in firefox, look up rust tutorials"), { do: "web_search", query: "rust tutorials", browser: "firefox" });
  assert.deepEqual(act("open brave and search for lofi mix"), { do: "web_search", query: "lofi mix", browser: "brave" });
  assert.deepEqual(act("search for cheap flights using microsoft edge"), { do: "web_search", query: "cheap flights", browser: "edge" });
  // no browser named: the default one
  assert.deepEqual(act("search for rust tutorials"), { do: "web_search", query: "rust tutorials" });
});

test("laptop specs are read from the machine, not answered with a command to copy", () => {
  const first = (s: string) => (understand(s) as { actions: { do: string }[] } | null)?.actions?.[0]?.do;
  for (const q of ["what are my laptop specs", "my laptop specification", "show me my pc configuration", "which gpu do i have", "what is my computer hardware?"]) {
    assert.equal(first(q), "system_specs", q);
  }
  // how it is doing is the status, not the specs
  assert.equal(first("how is my laptop"), "system_status");
  assert.equal(first("how much battery do i have left"), "system_status");
});

test("Bond understands reminders and timers", async () => {
  const { parseReminder } = await import("../src/assistant/remind.ts");
  const now = new Date(2026, 9, 27, 15, 0, 0); // 3:00 pm
  const mins = (s: string) => {
    const r = parseReminder(s, now);
    return r ? { m: Math.round((r.at - now.getTime()) / 60_000), text: r.text } : null;
  };
  assert.deepEqual(mins("remind me in 10 minutes to call mom"), { m: 10, text: "call mom" });
  assert.deepEqual(mins("Remind me to stretch in 20 min"), { m: 20, text: "stretch" });
  assert.deepEqual(mins("in an hour remind me to check the oven"), { m: 60, text: "check the oven" });
  assert.deepEqual(mins("remind me in half an hour about the call"), { m: 30, text: "the call" });
  assert.deepEqual(mins("set a timer for 5 minutes"), { m: 5, text: "Your timer is up" });
  assert.deepEqual(mins("remind me at 5pm to submit the report"), { m: 120, text: "submit the report" });
  assert.deepEqual(mins("remind me to take a walk at 3:30 pm"), { m: 30, text: "take a walk" });
  // a time that has already passed today means tomorrow
  assert.deepEqual(mins("remind me at 2pm to call Sam"), { m: 23 * 60, text: "call Sam" });
  // not reminders
  assert.equal(parseReminder("what is a reminder", now), null);
  assert.equal(parseReminder("remind me in 10 minutes", now), null);
  assert.equal(parseReminder("open notepad", now), null);
  // a timer is its own kind: it shows on screen and rings to the second
  const { parseTimer, leftText, spanText } = await import("../src/assistant/timer.ts");
  assert.deepEqual(parseTimer("start a timer of 10 seconds"), { ms: 10_000, label: "" });
  assert.deepEqual(parseTimer("Set a timer for 5 minutes."), { ms: 300_000, label: "" });
  assert.deepEqual(parseTimer("set a 10 minute timer for the eggs"), { ms: 600_000, label: "eggs" });
  assert.deepEqual(parseTimer("timer 1 minute and 30 seconds"), { ms: 90_000, label: "" });
  assert.deepEqual(parseTimer("can you start a timer for half an hour"), { ms: 1_800_000, label: "" });
  assert.deepEqual(parseTimer("countdown from 30 sec"), { ms: 30_000, label: "" });
  assert.equal(parseTimer("what is a timer"), null);
  assert.equal(parseTimer("remind me in 10 minutes to stretch"), null);
  assert.equal(parseTimer("set a timer"), null);
  assert.equal(leftText(9_200), "0:10");
  assert.equal(leftText(0), "0:00");
  assert.equal(leftText(3_723_000), "1:02:03");
  assert.equal(spanText(90_000), "1 minute 30 seconds");
  assert.equal(understand("start a timer of 10 seconds")?.kind, "timer");
  assert.equal(understand("set a timer for 5 minutes")?.kind, "timer");
  // through understand(): a reminder is its own kind
  assert.equal(understand("remind me in 10 minutes to stretch")?.kind, "remind");
});

test("closing every window of a program names the program", () => {
  const first = (s: string) => (understand(s) as { actions: { do: string; name?: string }[] } | null)?.actions?.[0];
  assert.deepEqual(first("close all the notepad windows"), { do: "close_app", name: "notepad" });
  assert.deepEqual(first("shut every chrome window"), { do: "close_app", name: "chrome" });
  assert.deepEqual(first("Close all my notepad windows please"), { do: "close_app", name: "notepad" });
  // not a program
  assert.notEqual(first("close all windows")?.do, "close_app");
  assert.notEqual(first("close everything")?.do, "close_app");
});

test("reminders: whole words, tomorrow, and a time with no am or pm", async () => {
  const { parseReminder, whenText } = await import("../src/assistant/remind.ts");
  const now = new Date(2026, 9, 27, 15, 0, 0); // 3:00 pm
  const hours = (s: string) => {
    const r = parseReminder(s, now);
    return r ? { h: Math.round(((r.at - now.getTime()) / 3_600_000) * 10) / 10, text: r.text } : null;
  };
  // "tomorrow" is a day, not "to" + "morrow"
  assert.deepEqual(hours("remind me at 9am tomorrow to call sam"), { h: 18, text: "call sam" });
  assert.deepEqual(hours("remind me to call sam at 9am tomorrow"), { h: 18, text: "call sam" });
  assert.deepEqual(hours("remind me tomorrow at 9am to call sam"), { h: 18, text: "call sam" });
  // "at 5" at 3 pm means 5 pm today, not 5 am tomorrow
  assert.deepEqual(hours("remind me at 5 to call sam"), { h: 2, text: "call sam" });
  assert.deepEqual(hours("remind me at 2 to call sam"), { h: 23, text: "call sam" });
  assert.equal(whenText(parseReminder("remind me at 9am tomorrow to call sam", now)!.at, now.getTime()), "tomorrow at 9:00 AM");
  assert.equal(whenText(parseReminder("remind me at 5pm to call sam", now)!.at, now.getTime()), "at 5:00 PM");
  // "tomorrow" in a goal sentence is not a reminder and not a focus goal either
  assert.equal(understand("tomorrow I'll be late")?.kind ?? "none", "none");
  assert.notEqual(understand("tomorrow, remind me to call mom")?.kind, "goal");
});

test("planning the day is understood without the AI", () => {
  const plan = (s: string) => understand(s);
  assert.deepEqual(plan("Plan my day: three videos, research a channel"), { kind: "plan", text: "three videos, research a channel" });
  assert.deepEqual(plan("plan my day"), { kind: "plan", text: "" });
  assert.deepEqual(plan("add to my plan: study transformers at 5pm"), { kind: "plan", text: "study transformers at 5pm" });
  assert.deepEqual(plan("what's my plan"), { kind: "plan", text: "" });
  assert.notEqual(plan("how do I plan my day better")?.kind, "plan");
});

test("Windows jobs from today's test go to guide mode, even with speech noise in front", () => {
  const guide = { kind: "screen", mode: "guide" };
  for (const q of [
    "I want to delete an app called Hey Clicky from my laptop",
    "uninstall OBS",
    "help me uninstall Hey Clicky",
    "And help me connect to a Wi-Fi network.",
    "Show me the self glance icon on my desktop.",
    "Ow me the Self Glance icon on my desktop",
    "How do I stop Opera fr from being startup at Windows when open?",
    "where is the bluetooth button",
    "Won't help me turn on dark mode",
  ]) {
    assert.deepEqual(understand(q), guide, q);
  }
  for (const q of ["npm uninstall lodash", "how do I uninstall a pip package", "I want to build a startup", "delete my screenshots", "show me my plan"]) {
    assert.notDeepEqual(understand(q), guide, q);
  }
  assert.deepEqual(understand("Hey Bon, open Zed"), { kind: "do", actions: [{ do: "open_app", name: "Zed" }] });
});
