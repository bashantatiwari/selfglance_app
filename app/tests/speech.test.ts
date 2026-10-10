// Run: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { sentences, speakable } from "../src/assistant/speech.ts";

test("splits an answer into sentences to speak", () => {
  assert.deepEqual(sentences("Your build failed. A value was moved into the closure on line 12! Clone it first?"), [
    "Your build failed. A value was moved into the closure on line 12!",
    "Clone it first?",
  ]);
  assert.deepEqual(sentences("Done."), ["Done."]);
  assert.deepEqual(sentences("No punctuation at the end"), ["No punctuation at the end"]);
  assert.deepEqual(sentences("He said “stop.” Then he left."), ["He said “stop.” Then he left."]);
});

test("speaks the answer, not its formatting", () => {
  assert.equal(speakable("**Done** ✓"), "Done");
  assert.equal(speakable(String.raw`Saved to C:\Users\me\Desktop\cm.txt.`), "Saved to cm.txt.");
  assert.equal(speakable("Two things:\n- one\n- two"), "Two things:. one. two");
});

test("speaks in long pieces after the first sentence", () => {
  const p = sentences("The first sentence is long enough. Then a second. And a third. And a fourth one too.");
  assert.equal(p.length, 2);
  assert.equal(p[0], "The first sentence is long enough.");
});
