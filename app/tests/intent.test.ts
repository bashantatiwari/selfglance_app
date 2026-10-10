// Bond's own understanding of clear-cut requests (no AI call).

import { test } from "node:test";
import assert from "node:assert/strict";
import { saidStop, spokenAnswer, understand } from "../src/assistant/intent.ts";

test("clearing out screenshots goes to delete, never straight to a command", () => {
  for (const q of ["delete my screenshots", "delete all my screenshots", "clear the screenshots folder", "remove all of my screenshot images", "get rid of my screenshots"]) {
    assert.deepEqual(understand(q), { kind: "do", actions: [{ do: "delete", paths: ["screenshots/*"] }] }, q);
  }
});

test("the screenshots folder opens like the other folders", () => {
  assert.deepEqual(understand("open my screenshots folder"), { kind: "do", actions: [{ do: "open_folder", name: "screenshots" }] });
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
  assert.equal(spokenAnswer("No, don't.", false), "no");
  assert.equal(spokenAnswer("Never mind", true), "no");
  // The last check before deleting needs the word, not just "yes".
  assert.equal(spokenAnswer("Yes", true), null);
  assert.equal(spokenAnswer("Delete them.", true), "yes");
  assert.equal(spokenAnswer("Yes, delete.", true), "yes");
  // Anything else is a new request.
  assert.equal(spokenAnswer("open spotify", false), null);
  // Said in a sentence, as people do.
  assert.equal(spokenAnswer("I need you to run this command.", false), "yes");
  assert.equal(spokenAnswer("Go ahead and execute it", false), "yes");
  assert.equal(spokenAnswer("Please don't run it", false), "no");
  assert.equal(spokenAnswer("I need you to run this command.", true), null); // deleting needs the word
});

test("telling him to stop", () => {
  for (const s of ["Stop.", "be quiet", "Thanks, Bond.", "thank you"]) assert.ok(saidStop(s), s);
  assert.ok(!saidStop("stop the music"));
});
