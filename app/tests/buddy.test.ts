// Run: node --experimental-strip-types --test tests/   (from app/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { cutoutMask, transparentShare } from "../src/stage/buddy.ts";
import { STICKER_ONCE_SECS, stickerMotion } from "../src/stage/sticker.ts";

/** A w x h picture: `paint(x, y)` gives each pixel's colour. */
function picture(w: number, h: number, paint: (x: number, y: number) => [number, number, number, number?]) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b, a = 255] = paint(x, y);
      px.set([r, g, b, a], (y * w + x) * 4);
    }
  return px;
}
const share = (m: Uint8Array) => m.reduce((n, v) => n + v, 0) / m.length;
const inCircle = (x: number, y: number) => (x - 40) ** 2 + (y - 40) ** 2 < 20 ** 2;

test("a subject on a plain background is cut out, and only the subject", () => {
  const px = picture(80, 80, (x, y) => (inCircle(x, y) ? [200, 40, 40] : [245, 245, 240]));
  const m = cutoutMask(px, 80, 80)!;
  assert.ok(m, "cut out");
  assert.equal(m[40 * 80 + 40], 1, "the middle of the subject is kept");
  assert.equal(m[2 * 80 + 2], 0, "the corner is background");
  assert.ok(Math.abs(share(m) - (Math.PI * 400) / 6400) < 0.02, "about the circle's area");
});

test("a person running off the bottom edge keeps their body", () => {
  // A head and a body that reaches the bottom of the photo, on a light wall.
  const px = picture(80, 80, (x, y) => ((x - 40) ** 2 + (y - 30) ** 2 < 12 ** 2 || (y > 44 && Math.abs(x - 40) < 22) ? [60, 70, 110] : [230, 228, 222]));
  const m = cutoutMask(px, 80, 80)!;
  assert.ok(m);
  assert.equal(m[79 * 80 + 40], 1, "the bottom of the body stays");
  assert.equal(m[30 * 80 + 40], 1, "the head stays");
});

test("specks of noise in the background are dropped with the background", () => {
  const px = picture(80, 80, (x, y) => (inCircle(x, y) ? [30, 30, 30] : x === 8 && y === 60 ? [0, 0, 0] : [250, 250, 250]));
  const m = cutoutMask(px, 80, 80)!;
  assert.equal(m[60 * 80 + 8], 0, "a stray dark pixel is not part of the subject");
});

test("a busy background, or nothing but background, is not cut out", () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 255;
  assert.equal(cutoutMask(picture(60, 60, () => [rand(), rand(), rand()]), 60, 60), null, "noise");
  assert.equal(cutoutMask(picture(60, 60, () => [120, 160, 200]), 60, 60), null, "one colour all over");
});

test("a PNG with its background already removed is recognised", () => {
  assert.ok(transparentShare(picture(20, 20, (x) => [10, 10, 10, x < 10 ? 0 : 255])) > 0.4);
  assert.equal(transparentShare(picture(20, 20, () => [10, 10, 10])), 0);
});

test("the sticker breathes when idle, hops to celebrate, and every one-shot ends where idle begins", () => {
  const idle = [0, 0.5, 1, 1.5].map((t) => stickerMotion("idle", t).sy);
  assert.ok(Math.max(...idle) > 1 && Math.min(...idle) < 1.01, "breathing");
  assert.ok(stickerMotion("celebrate", 0.3).y > 20, "in the air mid-hop");
  for (const [clip, dur] of Object.entries(STICKER_ONCE_SECS)) {
    const end = stickerMotion(clip as never, dur!);
    const rest = stickerMotion("idle", dur!);
    for (const k of ["x", "y", "rot", "sx", "sy"] as const) assert.ok(Math.abs(end[k] - rest[k]) < 0.002, `${clip} ends at rest (${k})`);
  }
  assert.ok(stickerMotion("idle", 1, "sit").sy < stickerMotion("idle", 1, "stand").sy, "sitting is shorter");
  assert.ok(stickerMotion("idle", 1, "sleep").rot > 0.05, "dozing leans");
});
