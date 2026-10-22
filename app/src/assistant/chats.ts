// What you asked Bond and what he answered, kept on this laptop so you can find it again
// (dashboard → Chats). Stored locally in the app's storage, newest 400 only; switch it off or
// clear it any time. Nothing here is sent anywhere.

import { loadSettings } from "../settings";

export interface Chat {
  id: string;
  at: number;
  /** What you asked. */
  q: string;
  /** What he answered (a draft: the message; an action: what he did). */
  a: string;
  kind: "answer" | "draft" | "action";
  /** An email draft's subject line. */
  subject?: string;
}

const KEY = "selfglance.chats";
export const MAX_CHATS = 400;

export function loadChats(): Chat[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((c): c is Chat => !!c && typeof c.q === "string" && typeof c.a === "string") : [];
  } catch {
    return [];
  }
}

function save(chats: Chat[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(chats.slice(0, MAX_CHATS)));
    window.dispatchEvent(new Event("selfglance:chats"));
  } catch {
    /* storage full or unavailable */
  }
}

/** Keep one exchange (newest first), unless history is switched off. */
export function addChat(q: string, a: string, kind: Chat["kind"], subject?: string) {
  const answer = a.trim();
  if (!answer || !loadSettings().keepChats) return;
  const chat: Chat = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: Date.now(), q: q.trim().slice(0, 600), a: answer.slice(0, 6000), kind };
  if (subject?.trim()) chat.subject = subject.trim().slice(0, 200);
  save([chat, ...loadChats()]);
}

export function removeChat(id: string) {
  save(loadChats().filter((c) => c.id !== id));
}

export function clearChats() {
  save([]);
}
