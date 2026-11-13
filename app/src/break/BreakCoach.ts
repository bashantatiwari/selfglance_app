// The break coach: one combined break (water + eyes off the screen + stretch),
// timed on ACTIVE laptop use and confirmed by what you actually do.
//
//   active use ──45 min──▶ arriving ──▶ offering ──3 min──▶ waiting (nudges every 5 min)
//                              ▲            │                   │
//                              │            └── you step away ──┴─▶ away ──you return──▶ done
//   stepping away for 5+ min on your own also counts as a break (timer resets)
//
// Input: `onIdle(seconds since last keyboard/mouse input)`, fed every ~2 s by Rust.

export type BreakPhase = "idle" | "arriving" | "offering" | "waiting" | "away";
export type BreakEnd = "returned" | "drank";

export interface BreakEvents {
  /** Time for a break: run the entrance with the bottle, then call `arrived()`. */
  start(): void;
  /** Offered for a while and ignored: settle down and wait. */
  settle(): void;
  /** Still waiting: a gentle nudge. */
  nudge(): void;
  /** The user left the keyboard: the break is happening. */
  away(): void;
  /** Break finished (user came back, or clicked the bottle). */
  complete(how: BreakEnd): void;
}

export const BREAK_EVERY_MIN = 45;
export const WATER_GOAL = 8;
const ACTIVE_IF_IDLE_UNDER = 60; // s: counts as "using the laptop"
const NATURAL_BREAK = 300; // s: away this long on your own = a break taken
const AWAY_DURING_BREAK = 40; // s: idle this long during a break = you went for it
const BACK_IF_IDLE_UNDER = 5; // s: input again = you're back
const MAX_TICK_MS = 60_000;
const LOG_EVERY_MS = 5 * 60_000;
const OFFER_FOR_MS = 3 * 60_000;
const NUDGE_EVERY_MS = 5 * 60_000;
const SOFT_DEFER_MAX_MIN = 20; // a video can delay the break by at most this much

/** "hard" = never interrupt (meeting, game); "soft" = wait a bit (a video); null = go. */
export type Blocker = () => "hard" | "soft" | null;

/** The local day: toISOString() is UTC, which rolled the count over at 5:45 in the morning in Nepal, not at midnight. */
const glassesKey = (d = new Date()) => `selfglance.water.${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function glassesToday(): number {
  try {
    return Number(localStorage.getItem(glassesKey()) ?? 0);
  } catch {
    return 0;
  }
}

/** One more glass (or one less, to correct a wrong tap); never below zero. */
export function addGlass(by = 1) {
  try {
    localStorage.setItem(glassesKey(), String(Math.max(0, glassesToday() + by)));
  } catch {
    /* storage unavailable: the count just won't persist */
  }
}

export class BreakCoach {
  phase: BreakPhase = "idle";
  private activeMs = 0;
  private lastTick = Date.now();
  private phaseSince = 0;
  private lastNudge = 0;
  private quietUntil = 0;

  private enabled = true;
  private lastLog = 0;

  private events: BreakEvents;
  private blocker: Blocker;
  private everyMin: number;
  private log: (line: string) => void;

  constructor(events: BreakEvents, blocker: Blocker = () => null, everyMin = BREAK_EVERY_MIN, log: (line: string) => void = () => {}) {
    this.events = events;
    this.blocker = blocker;
    this.everyMin = everyMin;
    this.log = log;
  }

  /** Apply settings from the dashboard. */
  configure(opts: { everyMin: number; enabled: boolean }) {
    this.everyMin = Math.max(1, opts.everyMin);
    this.enabled = opts.enabled;
  }

  get inBreak() {
    return this.phase !== "idle";
  }

  minutesUntil(): number {
    return Math.max(0, Math.ceil((this.everyMin * 60_000 - this.activeMs) / 60_000));
  }

  /** Feed with seconds since the last keyboard/mouse input (pass 0 while a video plays: watching is screen time). */
  onIdle(idleSec: number) {
    const now = Date.now();
    // Ticks come every ~2 s; a long gap (the webview was throttled) is still time at the laptop.
    const dt = Math.min(MAX_TICK_MS, now - this.lastTick);
    this.lastTick = now;

    switch (this.phase) {
      case "idle":
        if (idleSec >= NATURAL_BREAK) this.activeMs = 0;
        else if (idleSec < ACTIVE_IF_IDLE_UNDER) this.activeMs += dt;
        if (this.enabled && this.activeMs >= this.everyMin * 60_000 && now >= this.quietUntil) {
          const block = this.blocker();
          const overdue = this.activeMs >= (this.everyMin + SOFT_DEFER_MAX_MIN) * 60_000;
          if (block === null || (block === "soft" && overdue)) {
            this.startNow();
          } else this.note(now, `break due but held back (${block}), active ${Math.round(this.activeMs / 60_000)} min`);
        } else {
          this.note(now, `break timer ${Math.round(this.activeMs / 60_000)}/${this.everyMin} min active${this.enabled ? "" : " (breaks are off)"}, idle ${idleSec}s`);
        }
        break;
      case "offering":
      case "waiting":
        if (idleSec >= AWAY_DURING_BREAK) {
          this.setPhase("away");
          this.events.away();
        } else if (this.phase === "offering" && now - this.phaseSince > OFFER_FOR_MS) {
          this.setPhase("waiting");
          this.lastNudge = now;
          this.events.settle();
        } else if (this.phase === "waiting" && now - this.lastNudge > NUDGE_EVERY_MS) {
          this.lastNudge = now;
          this.events.nudge();
        }
        break;
      case "away":
        if (idleSec < BACK_IF_IDLE_UNDER) this.finish("returned");
        break;
      case "arriving":
        break;
    }
  }

  startNow() {
    if (this.phase !== "idle") return;
    this.log("break starting");
    this.setPhase("arriving");
    this.events.start();
  }

  /** The entrance finished; the bottle is being offered. */
  arrived() {
    if (this.phase === "arriving") this.setPhase("offering");
  }

  /** The user clicked the bottle. */
  drank() {
    if (this.phase === "offering" || this.phase === "waiting" || this.phase === "away") this.finish("drank");
  }

  /** Quiet for a while; ends a running break without counting it. */
  snooze(min: number) {
    this.quietUntil = Date.now() + min * 60_000;
    this.activeMs = 0;
    this.phase = "idle";
  }

  /** "Later": put the bottle away now and bring it back in `min` minutes (the break isn't lost). */
  later(min: number) {
    if (this.phase === "idle") return;
    this.phase = "idle";
    // activeMs stays past the threshold, so the break fires again once the quiet time ends —
    // unless you take a real break meanwhile (5+ min away resets it, as it should).
    this.activeMs = Math.max(this.activeMs, this.everyMin * 60_000);
    this.quietUntil = Date.now() + min * 60_000;
  }

  /** Abandon a running break without counting it (e.g. a meeting started); it comes back later. */
  cancel() {
    this.phase = "idle";
  }

  private finish(how: BreakEnd) {
    // Only the bottle counts as a glass. Walking away is a break taken, not proof of water; the Today
    // page lets you add the glass you had while you were up.
    if (how === "drank") addGlass();
    this.activeMs = 0;
    this.phase = "idle";
    this.events.complete(how);
  }

  /** At most one line every few minutes, so the log shows why a break did or didn't come. */
  private note(now: number, line: string) {
    if (now - this.lastLog <= LOG_EVERY_MS) return;
    this.lastLog = now;
    this.log(line);
  }

  private setPhase(phase: BreakPhase) {
    this.phase = phase;
    this.phaseSince = Date.now();
  }
}
