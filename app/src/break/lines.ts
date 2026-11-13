// What Bond says on a break. The same bottle and the same silence every 45 minutes turns into
// wallpaper, so each break gets a line that fits the moment (how many glasses so far, the hour)
// and one small thing to do with the body, never the same tip twice in a row.

export interface BreakFacts {
  /** Glasses drunk today, and the daily goal. */
  glasses: number;
  goal: number;
  /** Hour of the day, 0-23. */
  hour: number;
}

export const TIPS = [
  "Look at something far away for 20 seconds.",
  "Roll your shoulders back, three times.",
  "Stand up and reach for the ceiling.",
  "Unclench your jaw and drop your shoulders.",
  "Blink slowly ten times.",
  "Walk to the window and back.",
  "Refill the bottle while you're up.",
  "Neck circles, slowly, both ways.",
  "Shake out your hands.",
  "Take three slow breaths.",
];

const NUDGES = ["Still here with your water.", "It's getting warm, you know.", "Two minutes, then straight back to it.", "Psst. One sip?", "I'll wait. The water won't."];
const CHEERS = ["Nice.", "Good one.", "Keep it going.", "That's the stuff.", "Back to it."];

let lastTip = -1;
let lastNudge = -1;
let lastCheer = -1;

/** A random index that isn't the previous one. */
function other(n: number, last: number, rand: () => number): number {
  const i = Math.floor(rand() * n) % n;
  return i === last ? (i + 1) % n : i;
}

/** How many glasses a person on pace would have had by now: the goal spread over 8:00 to 20:00. */
export const expected = (goal: number, hour: number) => goal * Math.min(1, Math.max(0, (hour - 8) / 12));

/** The line shown when the bottle is held out. */
export function offerLine(f: BreakFacts, rand: () => number = Math.random): string {
  const { glasses, goal, hour } = f;
  let opener: string;
  if (glasses === 0) opener = hour < 12 ? "First glass of the day." : "No water yet today.";
  else if (glasses >= goal) opener = `You've hit your ${goal} already. One more won't hurt.`;
  else if (glasses + 1 < expected(goal, hour)) opener = `${glasses} of ${goal} so far, a bit behind. Let's catch up.`;
  else if (hour >= 21) opener = "Last one for tonight?";
  else opener = `${glasses} of ${goal}. You're on pace.`;
  lastTip = other(TIPS.length, lastTip, rand);
  return `${opener} ${TIPS[lastTip]}`;
}

/** A reminder when the offer was ignored. */
export function nudgeLine(rand: () => number = Math.random): string {
  lastNudge = other(NUDGES.length, lastNudge, rand);
  return NUDGES[lastNudge];
}

/** After a glass: the count, and a cheer (the goal gets its own). */
export function doneLine(f: Pick<BreakFacts, "glasses" | "goal">, rand: () => number = Math.random): string {
  if (f.glasses === f.goal) return `${f.glasses} of ${f.goal}. That's today's water done!`;
  if (f.glasses > f.goal) return `${f.glasses} glasses today. Over the goal.`;
  lastCheer = other(CHEERS.length, lastCheer, rand);
  return `${f.glasses} of ${f.goal}. ${CHEERS[lastCheer]}`;
}

/** Back from a break you walked away for: no glass is counted unless you say so. */
export function backLine(f: Pick<BreakFacts, "glasses" | "goal">): string {
  return `Welcome back. ${f.glasses} of ${f.goal} glasses today — had one while you were up? Add it on the Today page.`;
}

/** How he celebrates: not always the same move. */
export const REACTIONS = ["celebrate", "nod", "dance", "wave"] as const;
export const reaction = (rand: () => number = Math.random) => REACTIONS[Math.floor(rand() * REACTIONS.length) % REACTIONS.length];
