// Bond's own understanding of clear-cut requests (no AI call).

import { test } from "node:test";
import assert from "node:assert/strict";
import { understand } from "../src/assistant/intent.ts";

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
