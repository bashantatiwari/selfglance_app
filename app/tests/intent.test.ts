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
