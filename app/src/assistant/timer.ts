// Timers you ask Bond for: "start a timer of 10 seconds", "set a 5 minute timer", "timer 1 minute 30 seconds".
// Unlike a reminder, a timer is something you watch: it shows on screen counting down (ui/Timers.tsx), can be
// made small or cancelled, and rings to the second. Pure rules here (tested); the list lives in localStorage
// so a timer survives Bond restarting.

export interface Timer {
  id: string;
  /** ms epoch when it started and when it ends. */
  start: number;
  end: number;
  /** What it is for ("tea"), or "". */
  label: string;
}

const KEY = "selfglance.timers";
const WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, "forty five": 45, "forty-five": 45, sixty: 60, ninety: 90, half: 0.5 };
const NUM = String.raw`(\d+(?:\.\d+)?|an?|one|two|three|four|five|six|ten|fifteen|twenty|thirty|forty[- ]five|forty|sixty|ninety|half an?)`;
const UNIT = String.raw`(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)`;
/** "10 minutes", "1 minute and 30 seconds", "an hour 15 min". */
const SPAN = String.raw`${NUM}[- ]?${UNIT}(?:\s+(?:and\s+)?${NUM}[- ]?${UNIT})?`;
const MAX_MS = 24 * 60 * 60 * 1000;

const unitMs = (u: string) => (/^h/i.test(u) ? 3_600_000 : /^m/i.test(u) ? 60_000 : 1000);
const amount = (n: string) => {
  const w = n.toLowerCase().replace(/^half an?$/, "half");
  return WORDS[w] ?? Number(w);
};

/** A timer in a sentence: how long, and what for. Null when it isn't one. */
export function parseTimer(said: string): { ms: number; label: string } | null {
  const t = said.trim().replace(/[.!?]+$/, "").replace(/\s+/g, " ");
  const lead = String.raw`^(?:please\s+)?(?:(?:can|could|would) you\s+)?(?:(?:sets?|starts?|started|begin|run|put|make|create|give me|i need|i want)\s+)?(?:(?:a|an|the|me a|up a)\s+)?`;
  const what = String.raw`(?:\s+(?:for|to|called|named)\s+(?!\d)(.+))?`;
  const forms = [
    // "start a timer of 10 seconds", "timer for 5 min", "set a timer for 10 minutes for tea"
    new RegExp(String.raw`${lead}(?:count ?down\s+)?timer\s+(?:for|of|to)?\s*${SPAN}${what}$`, "i"),
    // "set a 10 minute timer", "5 min timer for the eggs"
    new RegExp(String.raw`${lead}${SPAN}\s+(?:count ?down\s+)?timer${what}$`, "i"),
    // "start a one minute countdown", "a 5 minute count down"
    new RegExp(String.raw`${lead}${SPAN}\s+count ?down${what}$`, "i"),
    // "count down 30 seconds", "countdown from 10 seconds"
    new RegExp(String.raw`${lead}count ?down\s+(?:for|from|of)?\s*${SPAN}${what}$`, "i"),
  ];
  for (const re of forms) {
    const m = t.match(re);
    if (!m) continue;
    let ms = amount(m[1]) * unitMs(m[2]);
    if (m[3] && m[4]) ms += amount(m[3]) * unitMs(m[4]);
    ms = Math.round(ms);
    if (!Number.isFinite(ms) || ms < 1000 || ms > MAX_MS) return null;
    return { ms, label: (m[5] ?? "").trim().replace(/^(?:the|my)\s+/i, "").slice(0, 40) };
  }
  // Anything else that says "timer" or "countdown" and a length is a timer, however speech heard the rest
  // ("starts to one minute count down", "can you do a countdown, like 2 minutes", "timer 90 seconds please").
  if (/\b(?:timer|count ?down)\b/i.test(t) && !/^(?:what|how|why|is|are|do|does|did|can i|should)\b.*\?$/i.test(said.trim())) {
    const any = t.match(new RegExp(String.raw`\b${SPAN}\b`, "i"));
    if (any) {
      let ms = amount(any[1]) * unitMs(any[2]);
      if (any[3] && any[4]) ms += amount(any[3]) * unitMs(any[4]);
      ms = Math.round(ms);
      if (!Number.isFinite(ms) || ms < 1000 || ms > MAX_MS) return null;
      const label = t.match(/\b(?:for|to)\s+(?!\d|an?\b|one\b|two\b|three\b|five\b|ten\b)((?:[a-z]+\s?){1,4})$/i)?.[1]?.trim().replace(/^(?:the|my)\s+/i, "") ?? "";
      return { ms, label: label.slice(0, 40) };
    }
  }
  return null;
}

/** "0:09", "4:59", "1:02:03": what is left, rounded up so it reaches 0:00 exactly when it rings. */
export function leftText(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const two = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
}

/** "10 seconds", "5 minutes", "1 hour 30 minutes": how long it was set for, to say out loud. */
export function spanText(ms: number): string {
  const s = Math.round(ms / 1000);
  const part = (n: number, w: string) => (n ? `${n} ${w}${n === 1 ? "" : "s"}` : "");
  return [part(Math.floor(s / 3600), "hour"), part(Math.floor((s % 3600) / 60), "minute"), part(s % 60, "second")].filter(Boolean).join(" ");
}

export function loadTimers(): Timer[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((t) => t && typeof t.end === "number" && typeof t.start === "number") : [];
  } catch {
    return [];
  }
}

export function saveTimers(list: Timer[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(-5)));
  } catch {
    /* not kept across a restart */
  }
}

export const newTimer = (ms: number, label: string, now = Date.now()): Timer => ({ id: `${now.toString(36)}${Math.random().toString(36).slice(2, 5)}`, start: now, end: now + ms, label });
