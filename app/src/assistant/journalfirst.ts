// "Journal first": when Bond should ask about today's journal. Kept free of the app so the rule
// can be tested on its own. He asks once when the evening hour comes, then again only when you
// start something entertaining, at most every 15 minutes, and never on a day you said "Not tonight".

export const ASK_AGAIN_MS = 15 * 60_000;

export interface JournalFirstState {
  now: number;
  /** Current hour, 0-23. */
  hour: number;
  /** The evening hour from Settings. */
  at: number;
  /** Today's key ("2026-10-14"). */
  day: string;
  /** The day you last chose "Not tonight" on. */
  skippedDay: string | null;
  /** The day he last asked on, and when (ms). */
  askedDay: string | null;
  lastAsked: number;
  /** You've just started something entertaining (a video). */
  entertaining: boolean;
}

/** "first": ask now; "again": ask again; null: stay quiet. (The caller still checks the word count.) */
export function journalFirstDue(s: JournalFirstState): "first" | "again" | null {
  if (s.hour < s.at || s.skippedDay === s.day) return null;
  if (s.askedDay !== s.day) return "first";
  return s.entertaining && s.now - s.lastAsked > ASK_AGAIN_MS ? "again" : null;
}
