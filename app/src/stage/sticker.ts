// How a photo buddy moves. A photo has no skeleton, so every animation the app asks for is played
// as a "living sticker": breathing, hopping, wiggling, squashing and stretching, all worked out here
// from the time since the clip began. No DOM and no three.js, so it can be tested on its own.

import type { ClipName } from "./types";

export type StickerPose = "stand" | "sit" | "watch" | "sleep";

/** Offset (px, y up), tilt (radians) and scale, applied around the sticker's bottom centre. */
export interface StickerFrame {
  x: number;
  y: number;
  rot: number;
  sx: number;
  sy: number;
}

/** Clips that play once, and for how long (seconds). The others loop. */
export const STICKER_ONCE_SECS: Partial<Record<ClipName, number>> = {
  wave: 1.4,
  celebrate: 1.2,
  nod: 1.0,
  dance: 2.4,
  annoyed: 0.9,
  determined: 0.8,
};

const TAU = Math.PI * 2;

/** The frame `t` seconds into `clip`, in the resting `pose`. */
export function stickerMotion(clip: ClipName, t: number, pose: StickerPose = "stand"): StickerFrame {
  const dur = STICKER_ONCE_SECS[clip] ?? 1;
  const left = Math.max(0, 1 - t / dur); // fades a one-shot out, so it lands back on the idle frame
  // Breathing, under everything that doesn't replace it.
  const breathe = Math.sin(t * (pose === "sleep" ? 1.4 : 2.4));
  const base: StickerFrame = { x: 0, y: 0, rot: 0.025 * Math.sin(t * 1.2), sx: 1 - 0.012 * breathe, sy: 1 + 0.022 * breathe };
  if (pose === "sleep") Object.assign(base, { rot: 0.1 + 0.02 * Math.sin(t * 0.9), sy: 1 + 0.03 * breathe });
  // Sitting: a little shorter and wider, as if settled down.
  if (pose === "sit" || pose === "watch") Object.assign(base, { sx: base.sx * 1.03, sy: base.sy * 0.92 });

  switch (clip) {
    case "walk": {
      const step = Math.sin(t * 7);
      return { x: 0, y: Math.abs(step) * 7, rot: 0.09 * step, sx: 1, sy: 1 - 0.03 * Math.abs(Math.cos(t * 7)) };
    }
    case "hang":
      return { x: 0, y: 0, rot: 0, sx: 0.97, sy: 1.05 };
    case "wave":
      return { ...base, rot: base.rot + 0.2 * Math.sin(t * TAU * 2.2) * left };
    case "celebrate": {
      const p = (t / 0.6) % 1; // two hops
      const up = Math.sin(Math.PI * p) * left;
      return { ...base, y: 36 * up, sx: base.sx * (1 - 0.07 * up), sy: base.sy * (1 + 0.08 * up) };
    }
    case "nod": {
      const dip = Math.max(0, Math.sin(t * TAU * 2)) * left;
      return { ...base, sy: base.sy * (1 - 0.08 * dip), sx: base.sx * (1 + 0.03 * dip) };
    }
    case "dance": {
      const beat = Math.sin(t * TAU * 1.7);
      return { ...base, y: Math.abs(beat) * 14 * left, rot: base.rot + 0.16 * beat * left, sx: base.sx * (1 + 0.05 * Math.sin(t * TAU * 3.4) * left) };
    }
    case "annoyed":
      return { ...base, x: 9 * Math.sin(t * TAU * 5) * left };
    case "determined": {
      const puff = 0.1 * Math.sin(Math.PI * Math.min(1, t / dur));
      return { ...base, sx: base.sx * (1 + puff), sy: base.sy * (1 + puff) };
    }
    default:
      return base;
  }
}
