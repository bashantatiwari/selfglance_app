// What Bond says on a break: one short line and one small thing to do with the body, never the same
// tip twice in a row. No counting: the point is to get up and drink something.

export const TIPS = [
  "Look at something far away for 20 seconds.",
  "Roll your shoulders back, three times.",
  "Stand up and reach for the ceiling.",
  "Unclench your jaw and drop your shoulders.",
  "Walk to the window and back.",
  "Neck circles, slowly, both ways.",
  "Take three slow breaths.",
];

const NUDGES = ["Still here with your water.", "Two minutes, then straight back to it.", "Psst. One sip?"];
const CHEERS = ["Nice.", "Good one.", "Back to it."];

let lastTip = -1;
let lastNudge = -1;
let lastCheer = -1;

/** A random index that isn't the previous one. */
function other(n: number, last: number, rand: () => number): number {
  const i = Math.floor(rand() * n) % n;
  return i === last ? (i + 1) % n : i;
}

/** When the bottle arrives. */
export function offerLine(rand: () => number = Math.random): string {
  lastTip = other(TIPS.length, lastTip, rand);
  return `Time to get up and drink some water. ${TIPS[lastTip]}`;
}

export function nudgeLine(rand: () => number = Math.random): string {
  lastNudge = other(NUDGES.length, lastNudge, rand);
  return NUDGES[lastNudge];
}

export function doneLine(rand: () => number = Math.random): string {
  lastCheer = other(CHEERS.length, lastCheer, rand);
  return CHEERS[lastCheer];
}

export const backLine = () => "Welcome back.";

export const REACTIONS = ["celebrate", "nod", "dance", "wave"] as const;
export const reaction = (rand: () => number = Math.random) => REACTIONS[Math.floor(rand() * REACTIONS.length) % REACTIONS.length];
