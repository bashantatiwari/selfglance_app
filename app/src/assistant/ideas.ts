// Reading and changing ideas in storage. Every change reads the list fresh, changes one idea
// and writes it back, so a second window can never overwrite something you just edited.

import { useEffect, useState } from "react";
import { onTauriEvent } from "../platform";
import { loadIdeas, saveIdeas } from "./notes";
import type { Idea } from "./ideacore";

export const IDEAS_EVENT = "selfglance:ideas";
const announce = () => window.dispatchEvent(new Event(IDEAS_EVENT));

/** Change one idea. Returns false if it's gone or the browser refused to store it. */
export function patchIdea(id: string, change: (i: Idea) => Idea): boolean {
  try {
    const all = loadIdeas();
    const at = all.findIndex((i) => i.id === id);
    if (at < 0) return false;
    all[at] = change(all[at]);
    saveIdeas(all);
    announce();
    return true;
  } catch {
    return false;
  }
}

/** Take an idea out, handing back what's needed to put it back exactly where it was. */
export function removeIdea(id: string): { idea: Idea; index: number } | null {
  const all = loadIdeas();
  const index = all.findIndex((i) => i.id === id);
  if (index < 0) return null;
  const [idea] = all.splice(index, 1);
  saveIdeas(all);
  announce();
  return { idea, index };
}

export function restoreIdea(idea: Idea, index: number) {
  const all = loadIdeas().filter((i) => i.id !== idea.id);
  all.splice(Math.min(index, all.length), 0, idea);
  saveIdeas(all);
  announce();
}

/** All ideas, kept current when anything changes them (this window, Bond, or another window). */
export function useIdeas(): Idea[] {
  const [ideas, setIdeas] = useState<Idea[]>(loadIdeas);
  useEffect(() => {
    const read = () => setIdeas(loadIdeas());
    window.addEventListener(IDEAS_EVENT, read);
    window.addEventListener("storage", read);
    window.addEventListener("focus", read);
    // Bond saved an idea ("idea: …") while this window was open.
    const un = onTauriEvent<null>("notes-changed", read);
    return () => {
      window.removeEventListener(IDEAS_EVENT, read);
      window.removeEventListener("storage", read);
      window.removeEventListener("focus", read);
      void un.then((u) => u());
    };
  }, []);
  return ideas;
}
