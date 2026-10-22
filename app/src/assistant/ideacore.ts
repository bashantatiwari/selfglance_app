// An idea is one line you wrote down fast. Ideas made by older versions may carry extra fields
// (a stage, stars, a plan, notes): they are kept in storage untouched and simply not shown.

export interface Idea {
  id: string;
  /** The idea, as written. */
  text: string;
  /** ms epoch the idea was captured. */
  at: number;
  /** Ticked off (older versions: "started"). */
  done: boolean;
}

/** Newest first. */
export const byRecent = (a: Idea, b: Idea) => b.at - a.at;
