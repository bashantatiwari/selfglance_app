// Reminders you ask Bond for: "remind me in 10 minutes to stretch", "remind me to call Sam at 5pm".
// There is no page for them: he keeps the list himself, and says it when it is time. Pure rules
// for understanding the sentence (tested); the list lives in localStorage, shared with the overlay.

export interface Reminder {
  id: string;
  /** ms epoch when it is due. */
  at: number;
  text: string;
}

const KEY = "selfglance.remind";
const MIN = 60_000;
/** A reminder this late (Bond was off or asleep) is said with when it was due. */
export const LATE_MS = 5 * MIN;

const UNIT = String.raw`(second|sec|minute|min|hour|hr)s?\b`;
const AMOUNT = String.raw`(\d+(?:\.\d+)?|an?|half an?|one|two|three|five|ten|fifteen|twenty|thirty)`;
/** "to", "that" or "about" in front of what to be reminded of (a whole word: not the start of "tomorrow"). */
const FILL = String.raw`(?:(?:to|that|about)\b)?`;
const WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, five: 5, ten: 10, fifteen: 15, twenty: 20, thirty: 30, "half a": 0.5, "half an": 0.5 };

const toMs = (amount: string, unit: string): number => {
  const n = WORDS[amount.toLowerCase()] ?? Number(amount);
  const u = unit.toLowerCase();
  return Math.round(n * (u.startsWith("h") ? 60 * MIN : u.startsWith("s") ? 1000 : MIN));
};

const clean = (s: string) => s.trim().replace(/^(?:to|that|about)\s+/i, "").replace(/[.!]+$/, "").trim();

/**
 * When the clock next reads `hh:mm`. With am/pm that is plain. Without it ("at 5") it is the next time
 * that happens, morning or evening; for tomorrow, 7 to 11 is the morning and anything else the afternoon.
 */
function atClock(hh: string, mm: string | undefined, ap: string | undefined, now: Date, tomorrow: boolean): number | null {
  let h = Number(hh);
  const m = mm ? Number(mm) : 0;
  if (m > 59 || h > 24) return null;
  const on = (hour: number, dayShift = 0) => {
    const d = new Date(now);
    d.setDate(d.getDate() + dayShift);
    d.setHours(hour, m, 0, 0);
    return d;
  };
  if (ap) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (ap.toLowerCase().startsWith("p") ? 12 : 0);
  } else if (h >= 1 && h <= 12) {
    // Nobody sets a reminder for 2 in the morning: 1 to 6 and 12 mean the afternoon, 7 to 11 either part of the day.
    const am = h % 12;
    const morning = h >= 7 && h <= 11;
    if (tomorrow) return on(morning ? am : am + 12, 1).getTime();
    const tries = morning ? [on(am), on(am + 12), on(am, 1)] : [on(am + 12), on(am + 12, 1)];
    const next = tries.find((d) => d.getTime() > now.getTime());
    return next ? next.getTime() : null;
  }
  const d = on(h % 24, tomorrow ? 1 : 0);
  if (!tomorrow && d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** A reminder in a sentence, or null when it isn't one. */
export function parseReminder(said: string, now = new Date()): { at: number; text: string } | null {
  let t = said.trim().replace(/[.!?]+$/, "");
  const lead = String.raw`^(?:please\s+)?(?:can you |could you )?(?:remind me|set a reminder)`;
  const rel = new RegExp(String.raw`\bin\s+${AMOUNT}\s*${UNIT}`, "i");
  const abs = String.raw`\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?`;
  let m: RegExpMatchArray | null;

  // "at 9am tomorrow": the day word is taken out of the sentence and remembered.
  let tomorrow = false;
  if (/\bat\s+\d/i.test(t) && !rel.test(t)) {
    t = t.replace(/\s*\btomorrow\b/i, () => {
      tomorrow = true;
      return "";
    });
  }

  // A timer: "set a timer for 10 minutes", "timer 5 min".
  if ((m = t.match(new RegExp(String.raw`^(?:set\s+(?:a\s+)?)?timer\s+(?:for\s+)?${AMOUNT}\s*${UNIT}$`, "i")))) return { at: now.getTime() + toMs(m[1], m[2]), text: "Your timer is up" };

  // "remind me in 10 minutes to X" / "remind me in 10 minutes about X"
  if ((m = t.match(new RegExp(`${lead}\\s+in\\s+${AMOUNT}\\s*${UNIT}\\s*(?:,\\s*)?${FILL}\\s*(.+)$`, "i")))) {
    const text = clean(m[3]);
    return text ? { at: now.getTime() + toMs(m[1], m[2]), text } : null;
  }
  // "in 10 minutes remind me to X"
  if ((m = t.match(new RegExp(String.raw`^in\s+${AMOUNT}\s*${UNIT},?\s+(?:please\s+)?remind me\s+${FILL}\s*(.+)$`, "i")))) {
    const text = clean(m[3]);
    return text ? { at: now.getTime() + toMs(m[1], m[2]), text } : null;
  }
  // "remind me at 5pm to X" / "remind me at 17:30 to X"
  if ((m = t.match(new RegExp(`${lead}\\s+${abs}\\s*(?:,\\s*)?${FILL}\\s*(.+)$`, "i")))) {
    const at = atClock(m[1], m[2], m[3], now, tomorrow);
    const text = clean(m[4]);
    return at && text ? { at, text } : null;
  }
  // "remind me to X in 10 minutes" / "remind me to X at 5pm"
  if ((m = t.match(new RegExp(`${lead}\\s+${FILL}\\s*(.+?)\\s+${rel.source}$`, "i")))) {
    const text = clean(m[1]);
    return text ? { at: now.getTime() + toMs(m[2], m[3]), text } : null;
  }
  if ((m = t.match(new RegExp(`${lead}\\s+${FILL}\\s*(.+?)\\s+${abs}$`, "i")))) {
    const at = atClock(m[2], m[3], m[4], now, tomorrow);
    const text = clean(m[1]);
    return at && text ? { at, text } : null;
  }
  return null;
}

// --- The list ------------------------------------------------------------------------------

export function loadReminders(): Reminder[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((r) => r && typeof r.at === "number" && typeof r.text === "string") : [];
  } catch {
    return [];
  }
}

const save = (list: Reminder[]) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(-50)));
  } catch {
    /* storage full or unavailable */
  }
};

export function addReminder(at: number, text: string): Reminder {
  const r: Reminder = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, at, text: text.slice(0, 200) };
  save([...loadReminders(), r].sort((a, b) => a.at - b.at));
  return r;
}

/** Take out and return what is due now. */
export function takeDue(now = Date.now()): Reminder[] {
  const all = loadReminders();
  const due = all.filter((r) => r.at <= now);
  if (!due.length) return [];
  save(all.filter((r) => r.at > now));
  return due;
}

/** "in 10 minutes" / "at 5:30 PM" / "tomorrow at 9:00 AM" for the confirmation. */
export function whenText(at: number, now = Date.now()): string {
  const diff = at - now;
  if (diff < 90 * MIN) {
    const min = Math.max(1, Math.round(diff / MIN));
    return min === 1 ? "in a minute" : `in ${min} minutes`;
  }
  const d = new Date(at);
  const clock = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return `at ${clock}`;
  const next = new Date(now);
  next.setDate(next.getDate() + 1);
  return d.toDateString() === next.toDateString() ? `tomorrow at ${clock}` : `on ${d.toLocaleDateString([], { weekday: "long" })} at ${clock}`;
}
