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
const OFFER_FOR_MS = 3 * 60_000;
const NUDGE_EVERY_MS = 5 * 60_000;
const SOFT_DEFER_MAX_MIN = 20; // a video can delay the break by at most this much

/** "hard" = never interrupt (meeting, game); "soft" = wait a bit (a video); null = go. */
export type Blocker = () => "hard" | "soft" | null;

const glassesKey = () => `selfglance.water.${new Date().toISOString().slice(0, 10)}`;

export function glassesToday(): number {
  try {
    return Number(localStorage.getItem(glassesKey()) ?? 0);
  } catch {
    return 0;
  }
}

function addGlass() {
  try {
    localStorage.setItem(glassesKey(), String(glassesToday() + 1));
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

  constructor(
    private events: BreakEvents,
    private blocker: Blocker = () => null,
    private everyMin = BREAK_EVERY_MIN,
  ) {}

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
    const dt = Math.min(10_000, now - this.lastTick);
    this.lastTick = now;

    switch (this.phase) {
      case "idle":
        if (idleSec >= NATURAL_BREAK) this.activeMs = 0;
        else if (idleSec < ACTIVE_IF_IDLE_UNDER) this.activeMs += dt;
        if (this.enabled && this.activeMs >= this.everyMin * 60_000 && now >= this.quietUntil) {
          const block = this.blocker();
          const overdue = this.activeMs >= (this.everyMin + SOFT_DEFER_MAX_MIN) * 60_000;
          if (block === null || (block === "soft" && overdue)) this.startNow();
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
    addGlass();
    this.activeMs = 0;
    this.phase = "idle";
    this.events.complete(how);
  }

  private setPhase(phase: BreakPhase) {
    this.phase = phase;
    this.phaseSince = Date.now();
  }
}
