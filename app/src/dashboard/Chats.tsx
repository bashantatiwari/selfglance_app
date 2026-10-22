// Chats: what you asked Bond and what he answered, newest first, kept on this laptop only.
// Search it, copy an answer or a draft, delete one, or clear it all. Switch it off here too.

import { useEffect, useMemo, useState } from "react";
import { copyText } from "../ai";
import { clearChats, loadChats, removeChat, type Chat } from "../assistant/chats";
import { loadSettings, saveSettings, type Settings } from "../settings";
import { inTauri } from "../platform";
import { toast, Toggle } from "./ui";

const KIND: Record<Chat["kind"], string> = { answer: "Answer", draft: "Draft", action: "Done" };

function useChats() {
  const [chats, setChats] = useState<Chat[]>(() => loadChats());
  useEffect(() => {
    const read = () => setChats(loadChats());
    const onStorage = (e: StorageEvent) => e.key === "selfglance.chats" && read();
    window.addEventListener("storage", onStorage); // Bond's window wrote one
    window.addEventListener("focus", read);
    window.addEventListener("selfglance:chats", read);
    const t = window.setInterval(read, 4000);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", read);
      window.removeEventListener("selfglance:chats", read);
      clearInterval(t);
    };
  }, []);
  return chats;
}

const dayLabel = (ms: number) => {
  const d = new Date(ms);
  const t = new Date();
  const y = new Date(t);
  y.setDate(t.getDate() - 1);
  return d.toDateString() === t.toDateString() ? "Today" : d.toDateString() === y.toDateString() ? "Yesterday" : d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
};
const timeOf = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

async function copy(text: string) {
  try {
    if (inTauri) await copyText(text);
    else await navigator.clipboard.writeText(text);
    toast("Copied");
  } catch {
    toast("Couldn't copy");
  }
}

export default function Chats() {
  const chats = useChats();
  const [q, setQ] = useState("");
  const [sure, setSure] = useState(false);
  const [settings, setSettings] = useState<Settings>(() => loadSettings());

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? chats.filter((c) => `${c.q} ${c.a} ${c.subject ?? ""}`.toLowerCase().includes(needle)) : chats;
  }, [chats, q]);

  const groups = useMemo(() => {
    const out: { day: string; items: Chat[] }[] = [];
    for (const c of shown) {
      const day = dayLabel(c.at);
      const last = out[out.length - 1];
      if (last?.day === day) last.items.push(c);
      else out.push({ day, items: [c] });
    }
    return out;
  }, [shown]);

  const keep = (v: boolean) => {
    const next = { ...loadSettings(), keepChats: v };
    setSettings(next);
    void saveSettings(next);
  };

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Chats</h1>
          <p className="muted">What you asked Bond and what he answered. It stays on this laptop.</p>
        </div>
      </header>

      <section className="section chats-tools">
        <input className="capture-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your chats…" aria-label="Search chats" />
        <Toggle label="Keep my chat history" hint="Off: Bond stops saving new ones. What's saved stays until you clear it." checked={settings.keepChats} onChange={keep} />
        {chats.length > 0 && (
          <div className="chats-clear">
            {sure ? (
              <>
                <span className="muted">Delete all {chats.length} chats?</span>
                <button
                  className="btn"
                  onClick={() => {
                    clearChats();
                    setSure(false);
                    toast("Chats cleared");
                  }}
                >
                  Yes, clear them
                </button>
                <button className="btn ghost" onClick={() => setSure(false)}>
                  Keep
                </button>
              </>
            ) : (
              <button className="btn ghost" onClick={() => setSure(true)}>
                Clear all
              </button>
            )}
          </div>
        )}
      </section>

      {chats.length === 0 ? (
        <section className="empty-state">
          <h2>Nothing here yet</h2>
          <p className="muted">Ask Bond something (Ctrl+Alt+Space) and it shows up here. Try “write me a message to my manager saying …”.</p>
        </section>
      ) : shown.length === 0 ? (
        <p className="muted">Nothing matches “{q}”.</p>
      ) : (
        groups.map((g) => (
          <div className="hist-day" key={g.day}>
            <h2 className="hist-day-name">{g.day}</h2>
            <ul className="hist-list">
              {g.items.map((c) => (
                <li key={c.id} className={`hist hist-${c.kind}`}>
                  <div className="hist-head">
                    <span className="hist-kind">{KIND[c.kind]}</span>
                    <small className="muted">{timeOf(c.at)}</small>
                    <span className="hist-actions">
                      <button className="linkish" onClick={() => void copy(c.a)}>
                        Copy {c.kind === "draft" ? "message" : "answer"}
                      </button>
                      <button className="icon-btn" onClick={() => removeChat(c.id)} aria-label="Delete this chat" title="Delete">
                        ×
                      </button>
                    </span>
                  </div>
                  <p className="hist-q">{c.q}</p>
                  {c.subject && (
                    <p className="hist-subject">
                      <b>Subject:</b> {c.subject}
                    </p>
                  )}
                  <p className="hist-a">{c.a}</p>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </>
  );
}
