// Bond's own understanding of clear-cut requests (no AI call).

import { test } from "node:test";
import assert from "node:assert/strict";
import { saidStop, spokenAnswer, understand, unsavedAnswer } from "../src/assistant/intent.ts";

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
