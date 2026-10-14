// What you tell Bond to remember: day log lines (into the Journal) and project ideas.
// Ideas are kept in localStorage, which the overlay and the dashboard share; a
// "notes-changed" event tells an open dashboard to re-read.

import { invoke } from "@tauri-apps/api/core";
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

// The journal lives in files kept by Rust (journal.rs), one per day. In a plain browser tab
// (npm run dev) it falls back to localStorage, where older versions kept it.

const lsGet = (day: string) => {
  try {
    return localStorage.getItem(JOURNAL_PREFIX + day) ?? "";
  } catch {
    return "";
  }
};

let migrated = false;

/** Move entries older versions kept in localStorage into the journal files (once). */
async function migrate() {
  if (!inTauri || migrated) return;
  migrated = true;
  const keys: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(JOURNAL_PREFIX)) keys.push(k);
    }
  } catch {
    return;
  }
  for (const k of keys) {
    const day = k.slice(JOURNAL_PREFIX.length);
    const old = localStorage.getItem(k) ?? "";
    try {
      const now = await invoke<string>("journal_get", { day });
      if (old.trim() && !now.includes(old.trim())) await invoke("journal_set", { day, text: now.trim() ? `${old.trimEnd()}\n${now}` : old });
      localStorage.removeItem(k);
    } catch {
      /* keep it in localStorage and try again next time */
      migrated = false;
    }
  }
}

export async function journalGet(day: string): Promise<string> {
  if (!inTauri) return lsGet(day);
  await migrate();
  return invoke<string>("journal_get", { day });
}

export async function journalSet(day: string, text: string): Promise<void> {
  if (!inTauri) {
    if (text.trim()) localStorage.setItem(JOURNAL_PREFIX + day, text);
    else localStorage.removeItem(JOURNAL_PREFIX + day);
    return;
  }
  await invoke("journal_set", { day, text });
}

/** Every entry with text, newest first. */
export async function journalList(): Promise<{ day: string; text: string }[]> {
  if (inTauri) {
    await migrate();
    return invoke("journal_list");
  }
  const out: { day: string; text: string }[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith(JOURNAL_PREFIX)) out.push({ day: k.slice(JOURNAL_PREFIX.length), text: localStorage.getItem(k) ?? "" });
  }
  return out.filter((e) => e.text.trim()).sort((a, b) => b.day.localeCompare(a.day));
}

/** Whether an entry holds something you wrote (Bond's own timestamped "log" lines don't count). */
export const journalWritten = (text: string) => text.split("\n").some((l) => l.trim() && !/^\d{1,2}:\d{2}(\s?[ap]m)? — /i.test(l.trim()));

/** How many words you wrote (not counting Bond's timestamped log lines). */
export const journalWords = (text: string) =>
  text
    .split("\n")
    .filter((l) => l.trim() && !/^\d{1,2}:\d{2}(\s?[ap]m)? — /i.test(l.trim()))
    .join(" ")
    .split(/\s+/)
    .filter(Boolean).length;

/** Words in the whole entry, including lines you dictated to Bond ("log: …"): "Journal first" counts them. */
export const journalWordsAll = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** Words a "Journal first" evening needs before Bond stops asking. */
export const JOURNAL_FIRST_WORDS = 20;

const SKIPS_KEY = "selfglance.journalSkips";

/** Days you chose "Not tonight" on (kept on this computer, last 90). */
export function journalSkips(): string[] {
  try {
    return JSON.parse(localStorage.getItem(SKIPS_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function recordJournalSkip(day = dayKey()) {
  try {
    const all = journalSkips().filter((d) => d !== day);
    localStorage.setItem(SKIPS_KEY, JSON.stringify([...all, day].slice(-90)));
  } catch {
    /* not kept */
  }
}

/** Add a timestamped line to today's journal entry. */
export async function logToJournal(text: string): Promise<void> {
  const line = `${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} — ${text.trim()}`;
  if (inTauri) {
    await migrate();
    await invoke("journal_append", { line });
    return;
  }
  const before = lsGet(dayKey()).trimEnd();
  localStorage.setItem(JOURNAL_PREFIX + dayKey(), before ? `${before}\n${line}` : line);
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
