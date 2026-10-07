// Thin wrapper over the Tauri bridge so the overlay also runs in a plain
// browser tab (npm run dev) for quick UI work — calls just become no-ops there.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Rect } from "./stage/types";

export const inTauri = "__TAURI_INTERNALS__" in window;

let lastSent = "";
let lastAt = 0;
let trailing: number | undefined;

/** Tell Rust which parts of the overlay should catch the mouse (throttled, last value always sent). */
export function sendHitRegions(rects: Rect[]) {
  if (!inTauri) return;
  const rounded = rects.map((r) => ({
    x: Math.round(r.x),
    y: Math.round(r.y),
    w: Math.round(r.w),
    h: Math.round(r.h),
  }));
  const key = JSON.stringify(rounded);
  if (key === lastSent) return;
  clearTimeout(trailing);
  const wait = 80 - (performance.now() - lastAt);
  if (wait > 0) {
    trailing = window.setTimeout(() => sendHitRegions(rects), wait);
    return;
  }
  lastSent = key;
  lastAt = performance.now();
  invoke("set_hit_regions", { rects: rounded }).catch(() => {});
}

export async function onTauriEvent<T>(name: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  if (!inTauri) return () => {};
  return listen<T>(name, (e) => handler(e.payload));
}

/** Cursor position in overlay CSS pixels, or null where the OS can't report it. */
export async function cursorPosition(): Promise<{ x: number; y: number } | null> {
  if (!inTauri) return null;
  const pos = await invoke<[number, number] | null>("cursor_position").catch(() => null);
  return pos ? { x: pos[0], y: pos[1] } : null;
}
