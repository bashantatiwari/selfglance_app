// "Nothing leaves your laptop", for the screens. The Rust side has the same promise as a test
// (src-tauri/src/egress.rs). Here: no screen code knows an AI service, loads anything from the
// internet, or fetches anything but Bond's own files.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(ts|tsx|css|html)$/.test(name)) out.push(p);
  }
  return out;
}

const sources = [...files("src"), "index.html"].map((p) => [p, readFileSync(p, "utf8")] as const);

test("no screen code knows an AI service", () => {
  for (const [path, text] of sources) {
    for (const host of ["googleapis.com", "api.anthropic.com", "api.openai.com", "api.x.ai", "openrouter.ai", "api.groq.com"]) {
      assert.ok(!text.includes(host), `${path} mentions ${host}`);
    }
  }
});

test("nothing is loaded from the internet, and fetch only reads Bond's own files", () => {
  for (const [path, text] of sources) {
    assert.ok(!/@import\s+url\(\s*["']?https?:/.test(text), `${path} imports a remote stylesheet`);
    assert.ok(!/<(script|link|img)[^>]+(src|href)=["']https?:/.test(text), `${path} loads a remote file`);
    for (const m of text.matchAll(/\bfetch\(\s*([`"'])(.*?)\1/g)) {
      assert.ok(m[2].startsWith("/") || m[2].startsWith("${"), `${path} fetches ${m[2]}`);
    }
  }
});

test("no setting names a cloud brain or key", () => {
  const settings = readFileSync("src/settings.ts", "utf8");
  // Only the clean-up of old saved settings may mention them.
  const outside = settings.replace(/function withoutCloud[\s\S]*?\r?\n}\r?\n/, "");
  assert.ok(!/aiProvider|geminiModel|apiKey/.test(outside));
});
