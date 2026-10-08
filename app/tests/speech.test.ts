// Run: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { sentences } from "../src/assistant/speech.ts";

test("splits an answer into sentences to speak", () => {
  assert.deepEqual(sentences("Your build failed. A value was moved into the closure on line 12! Clone it first?"), [
    "Your build failed. A value was moved into the closure on line 12!",
    "Clone it first?",
  ]);
  assert.deepEqual(sentences("Done."), ["Done."]);
  assert.deepEqual(sentences("No punctuation at the end"), ["No punctuation at the end"]);
  assert.deepEqual(sentences("He said “stop.” Then he left."), ["He said “stop.” Then he left."]);
});
