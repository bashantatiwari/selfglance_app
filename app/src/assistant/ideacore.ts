// What an idea is, and the rules around it, free of the app so they can be tested on their own.
//
// Ideas are stored as one JSON list (see notes.ts). The first version only had
// { id, text, at, done }. Everything added since is OPTIONAL, so every older idea still loads
// as it was and an older copy of the app can still read the list. `text` is the idea exactly as
// you wrote it and is never rewritten; a shorter `title` is shown on top of it.

export type Status = "inbox" | "exploring" | "planned" | "building" | "completed";

export const STATUSES: { id: Status; name: string; hint: string }[] = [
  { id: "inbox", name: "Inbox", hint: "Just captured. Nothing decided yet." },
  { id: "exploring", name: "Exploring", hint: "Thinking it through. It can stay here as long as it needs." },
  { id: "planned", name: "Planned", hint: "You know what the first steps are." },
  { id: "building", name: "Building", hint: "You are working on it." },
  { id: "completed", name: "Completed", hint: "The idea has become a real thing." },
];

export interface Task {
  id: string;
  text: string;
  /** This step is finished. (Not the same as the idea being completed.) */
  done: boolean;
  at: number;
}

export type SavedKind = "finding" | "decision" | "reference" | "note";

export interface Saved {
  id: string;
  kind: SavedKind;
  text: string;
  at: number;
  /** Where it came from: Bond's answer you chose to keep, or you. */
  from: "bond" | "me";
}

/** A task Bond suggested that you haven't approved yet. */
export interface Proposal {
  id: string;
  text: string;
}

export interface Idea {
  id: string;
  /** The idea, as submitted. */
  text: string;
  /** ms epoch the idea was captured. */
  at: number;
  /** Older versions: ticked when you "started" it. Kept in step with `status` for them. */
  done: boolean;
  title?: string;
  status?: Status;
  starred?: boolean;
  /** ms epoch of the last change. */
  updatedAt?: number;
  /** Your own research notes. */
  notes?: string;
  tasks?: Task[];
  saved?: Saved[];
  proposals?: Proposal[];
}

export const SAVED_KINDS: { id: SavedKind; name: string; plural: string }[] = [
  { id: "finding", name: "Finding", plural: "Findings" },
  { id: "decision", name: "Decision", plural: "Decisions" },
  { id: "reference", name: "Reference", plural: "References" },
  { id: "note", name: "Note", plural: "Notes" },
];

export const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** An idea you ticked as started in an older version counts as Building; anything else starts in the Inbox. */
export const statusOf = (i: Idea): Status => i.status ?? (i.done ? "building" : "inbox");

/** Move an idea to a stage. `done` follows (Building and Completed), so older copies still read it right. */
export function withStatus(i: Idea, status: Status, now = Date.now()): Idea {
  return { ...i, status, done: status === "building" || status === "completed", updatedAt: now };
}

/** A short title from the first sentence or clause of the idea, never from the middle of a word. */
export function deriveTitle(text: string, max = 64): string {
  const flat = text.trim().replace(/\s+/g, " ");
  if (!flat) return "Untitled idea";
  // Up to the first colon / dash / sentence end, if that is a sensible length.
  const m = flat.match(/^(.{8,}?)(?:\s[-–—]\s|:\s|[.!?](?:\s|$))/);
  const head = m ? m[1].trim() : flat;
  if (head.length <= max) return head.replace(/[,;:\s]+$/, "");
  const cut = head.slice(0, max);
  const at = cut.lastIndexOf(" ");
  return `${(at > max * 0.5 ? cut.slice(0, at) : cut).replace(/[,;:\s]+$/, "")}…`;
}

export const titleOf = (i: Idea) => (i.title?.trim() ? i.title.trim() : deriveTitle(i.text));

export const lastTouched = (i: Idea) => i.updatedAt ?? i.at;

export function taskProgress(i: Idea): { done: number; total: number } {
  const t = i.tasks ?? [];
  return { done: t.filter((x) => x.done).length, total: t.length };
}

/**
 * Tasks out of an AI answer: one per line, starting with "-", "*", "•" or "1.". Plain
 * sentences are ignored, so a chatty intro never becomes a task. Duplicates of `existing` and
 * of each other are dropped.
 */
export function parseTasks(raw: string, existing: string[] = [], max = 10): string[] {
  const seen = new Set(existing.map((e) => e.trim().toLowerCase()));
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:[-*•–]|\d{1,2}[.)])\s+(.+?)\s*$/);
    if (!m) continue;
    const text = m[1].replace(/\*\*/g, "").replace(/\s+/g, " ").trim().replace(/[.;]$/, "");
    if (text.length < 3 || text.length > 200 || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

/** Newest activity first. */
export const byRecent = (a: Idea, b: Idea) => lastTouched(b) - lastTouched(a);

export interface IdeaFilter {
  status: Status | "all";
  starred: boolean;
  query: string;
}

export function matches(i: Idea, f: IdeaFilter): boolean {
  if (f.status !== "all" && statusOf(i) !== f.status) return false;
  if (f.starred && !i.starred) return false;
  const q = f.query.trim().toLowerCase();
  return !q || `${i.text} ${i.title ?? ""} ${i.notes ?? ""}`.toLowerCase().includes(q);
}
