// What you tell Bond to remember: project ideas. They are kept in localStorage, which the overlay
// and the dashboard share; a "notes-changed" event tells an open dashboard to re-read.

import { emit } from "@tauri-apps/api/event";
import { inTauri } from "../platform";

const IDEAS_KEY = "selfglance.ideas";

import type { Idea } from "./ideacore";
export type { Idea };

const changed = () => {
  if (inTauri) void emit("notes-changed").catch(() => {});
};

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
