// What you tell Bond to remember: day log lines (into the Journal) and project ideas.
// Stored locally in localStorage, which the overlay and the dashboard share; a
// "notes-changed" event tells an open dashboard to re-read.

import { emit } from "@tauri-apps/api/event";
import { inTauri } from "../platform";

export const JOURNAL_PREFIX = "selfglance.journal.";
const IDEAS_KEY = "selfglance.ideas";

export interface Idea {
  id: string;
  text: string;
  at: number; // ms epoch
  done: boolean;
}

export const dayKey = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const changed = () => {
  if (inTauri) void emit("notes-changed").catch(() => {});
};

/** Add a timestamped line to today's journal entry. */
export function logToJournal(text: string) {
  const line = `${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} — ${text.trim()}`;
  const key = JOURNAL_PREFIX + dayKey();
  const before = localStorage.getItem(key)?.trimEnd() ?? "";
  localStorage.setItem(key, before ? `${before}\n${line}` : line);
  changed();
}

export function loadIdeas(): Idea[] {
  try {
    return JSON.parse(localStorage.getItem(IDEAS_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function saveIdeas(ideas: Idea[]) {
  localStorage.setItem(IDEAS_KEY, JSON.stringify(ideas));
  changed();
}

export function addIdea(text: string) {
  const idea: Idea = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, text: text.trim(), at: Date.now(), done: false };
  saveIdeas([idea, ...loadIdeas()]);
}
