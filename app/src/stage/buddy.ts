// Your own buddy from a photo: a partner, a friend, a pet. The photo is turned into a sticker on this
// laptop (a canvas, no AI service, nothing uploaded) and kept in local storage; the stage shows it in
// place of the 3D robot (see sticker.ts for how it moves).
//
// Three ways to the sticker, best first:
//   1. A PNG that already has a transparent background (Windows Paint → Remove background) is used as is.
//   2. Otherwise the background is cut away from the edges inward, when it is plain enough to tell apart.
//   3. Otherwise, or if you prefer it, a round sticker of the middle of the photo.
// Every sticker gets a white border and a thin dark edge, so it reads on any wallpaper.

export interface Buddy {
  name: string;
  /** The finished sticker, a PNG data URL. */
  url: string;
  /** On-screen height in CSS pixels. */
  height: number;
  /** ms epoch it was made: tells a real change from a repeated event. */
  at: number;
}

export type StickerStyle = "cutout" | "round";

export const BUDDY_KEY = "selfglance.buddy";
export const BUDDY_EVENT = "buddy-changed";
/** The longest side of the stored sticker: sharp at the sizes it is shown, small enough for storage. */
const MAX_SIDE = 420;
const BORDER = 7;

export function loadBuddy(): Buddy | null {
  try {
    const b = JSON.parse(localStorage.getItem(BUDDY_KEY) ?? "null");
    return b && typeof b.url === "string" && b.url.startsWith("data:image/") ? { name: String(b.name || "Buddy"), url: b.url, height: Number(b.height) || 150, at: Number(b.at) || 0 } : null;
  } catch {
    return null;
  }
}

/** Save the buddy, or `null` to go back to Bond the robot. False if storage refused it (full). */
export function saveBuddy(b: Buddy | null): boolean {
  try {
    if (b) localStorage.setItem(BUDDY_KEY, JSON.stringify(b));
    else localStorage.removeItem(BUDDY_KEY);
    return true;
  } catch {
    return false;
  }
}

// --- Finding the background (pure: tested in tests/buddy.test.ts) -------------------------------

/** Share of pixels that are see-through: a PNG with its background already removed. */
export function transparentShare(px: Uint8ClampedArray): number {
  let n = 0;
  for (let i = 3; i < px.length; i += 4) if (px[i] < 200) n++;
  return n / (px.length / 4);
}

const dist = (px: Uint8ClampedArray, a: number, r: number, g: number, b: number) => Math.hypot(px[a] - r, px[a + 1] - g, px[a + 2] - b);

/**
 * Which pixels are the subject (1) and which the background (0), or null when the background is too busy
 * to tell apart. The background is grown from the photo's top and side edges into neighbours of a similar colour that are
 * also close to the edges' average colour; then the big pieces of what is left are kept, the specks dropped.
 */
export function cutoutMask(px: Uint8ClampedArray, w: number, h: number): Uint8Array | null {
  // The edges' colour, and how much it varies: a busy edge (a room, a street) can't be cut this way.
  // Top and sides only: in most photos of a person the body runs off the bottom edge, and it is not background.
  const edge: number[] = [];
  for (let x = 0; x < w; x++) edge.push(x);
  for (let y = 1; y < h; y++) edge.push(y * w, y * w + w - 1);
  let [r, g, b] = [0, 0, 0];
  for (const p of edge) [r, g, b] = [r + px[p * 4], g + px[p * 4 + 1], b + px[p * 4 + 2]];
  [r, g, b] = [r / edge.length, g / edge.length, b / edge.length];
  const spread = Math.sqrt(edge.reduce((s, p) => s + dist(px, p * 4, r, g, b) ** 2, 0) / edge.length);
  if (spread > 48) return null;
  const far = Math.max(55, spread * 2.6);

  const bg = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;
  for (const p of edge) {
    if (!bg[p] && dist(px, p * 4, r, g, b) < far) {
      bg[p] = 1;
      queue[tail++] = p;
    }
  }
  while (head < tail) {
    const p = queue[head++];
    const x = p % w;
    for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
      if (q < 0 || q >= w * h || bg[q]) continue;
      // Similar to the pixel it grows from (no edge crossed) and to the background as a whole.
      if (Math.hypot(px[q * 4] - px[p * 4], px[q * 4 + 1] - px[p * 4 + 1], px[q * 4 + 2] - px[p * 4 + 2]) < 20 && dist(px, q * 4, r, g, b) < far) {
        bg[q] = 1;
        queue[tail++] = q;
      }
    }
  }

  // The pieces left are the subject: every big one (a head and a body, two cats), not the specks and stray islands.
  const label = new Int32Array(w * h);
  const sizes = [0];
  for (let s = 0; s < w * h; s++) {
    if (bg[s] || label[s]) continue;
    const id = sizes.length;
    let size = 0;
    head = tail = 0;
    queue[tail++] = s;
    label[s] = id;
    while (head < tail) {
      const p = queue[head++];
      size++;
      const x = p % w;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
        if (q >= 0 && q < w * h && !bg[q] && !label[q]) {
          label[q] = id;
          queue[tail++] = q;
        }
      }
    }
    sizes.push(size);
  }
  const keep = Math.max(...sizes) * 0.15;
  const mask = new Uint8Array(w * h);
  let kept = 0;
  for (let p = 0; p < w * h; p++) if (label[p] && sizes[label[p]] >= keep) (mask[p] = 1), kept++;
  // Almost nothing left (it ate the subject) or almost everything (it found no background): not a cut-out.
  const share = kept / (w * h);
  if (share < 0.06 || share > 0.92) return null;
  return mask;
}

// --- Making the sticker (canvas) ------------------------------------------------------------------

function canvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/** The smallest box around the non-transparent pixels. */
function bounds(c: HTMLCanvasElement): { x: number; y: number; w: number; h: number } | null {
  const px = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
  let [x0, y0, x1, y1] = [c.width, c.height, -1, -1];
  for (let y = 0; y < c.height; y++)
    for (let x = 0; x < c.width; x++)
      if (px[(y * c.width + x) * 4 + 3] > 24) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** The cut-out with a white border and a thin dark edge around its outline, as a new canvas. */
function withBorder(src: HTMLCanvasElement): HTMLCanvasElement {
  const pad = BORDER + 3;
  const out = canvas(src.width + pad * 2, src.height + pad * 2);
  const ctx = out.getContext("2d")!;
  const silhouette = (color: string) => {
    const s = canvas(src.width, src.height);
    const sc = s.getContext("2d")!;
    sc.drawImage(src, 0, 0);
    sc.globalCompositeOperation = "source-in";
    sc.fillStyle = color;
    sc.fillRect(0, 0, s.width, s.height);
    return s;
  };
  // The outline is the silhouette stamped all around: dark a little wider first, then white on top.
  for (const [color, r] of [["rgba(20,24,32,0.35)", BORDER + 1.6], ["#ffffff", BORDER]] as const) {
    const s = silhouette(color);
    for (let a = 0; a < 24; a++) ctx.drawImage(s, pad + Math.cos((a / 24) * Math.PI * 2) * r, pad + Math.sin((a / 24) * Math.PI * 2) * r);
  }
  ctx.drawImage(src, pad, pad);
  return out;
}

export interface Made {
  /** PNG data URL, or null when that style can't be made from this photo. */
  url: string | null;
  /** Why not, in plain words. */
  why?: string;
}

/** The photo, scaled down to at most MAX_SIDE, on a canvas. */
export async function photoCanvas(file: Blob): Promise<HTMLCanvasElement> {
  const img = await createImageBitmap(file);
  const k = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
  const c = canvas(img.width * k, img.height * k);
  c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
  img.close();
  return c;
}

/** One sticker style from the photo. */
export function makeSticker(photo: HTMLCanvasElement, style: StickerStyle): Made {
  const { width: w, height: h } = photo;
  const ctx = photo.getContext("2d")!;
  const data = ctx.getImageData(0, 0, w, h);
  let cut: HTMLCanvasElement;
  if (style === "round") {
    // The middle of the photo, a little above centre (faces sit high in most photos), in a circle.
    const d = Math.min(w, h);
    cut = canvas(d, d);
    const c = cut.getContext("2d")!;
    c.beginPath();
    c.arc(d / 2, d / 2, d / 2, 0, Math.PI * 2);
    c.clip();
    c.drawImage(photo, (w - d) / 2, Math.max(0, (h - d) * 0.35), d, d, 0, 0, d, d);
  } else if (transparentShare(data.data) > 0.02) {
    cut = photo; // already cut out
  } else {
    const mask = cutoutMask(data.data, w, h);
    if (!mask) return { url: null, why: "The background is too busy for me to cut out. Try the round sticker, or remove the background in Windows Paint first and pick the PNG." };
    // Soft edges: each pixel's opacity is the share of subject pixels around it.
    const out = new ImageData(w, h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let n = 0;
        let m = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const [xx, yy] = [x + dx, y + dy];
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            n++;
            m += mask[yy * w + xx];
          }
        const i = (y * w + x) * 4;
        out.data.set([data.data[i], data.data[i + 1], data.data[i + 2], Math.round((255 * m) / n)], i);
      }
    cut = canvas(w, h);
    cut.getContext("2d")!.putImageData(out, 0, 0);
  }
  const box = bounds(cut);
  if (!box) return { url: null, why: "There's nothing left in that picture once the background is gone." };
  const tight = canvas(box.w, box.h);
  tight.getContext("2d")!.drawImage(cut, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
  return { url: withBorder(tight).toDataURL("image/png") };
}
