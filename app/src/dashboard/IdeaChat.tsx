// Talk an idea through with Bond's brain: a short back-and-forth about one idea, kept per idea.
// It uses whichever brain you chose (Settings → AI & models). The brain on this laptop can
// structure and challenge an idea but can't look anything up; a cloud brain knows more, and
// the conversation is sent to that service, so the panel says which one is answering.

import { useEffect, useRef, useState } from "react";
import { aiText } from "../ai";
import type { Idea } from "../assistant/notes";
import { loadSettings } from "../settings";

type Msg = { role: "you" | "bond"; text: string };

const key = (id: string) => `selfglance.ideachat.${id}`;
const load = (id: string): Msg[] => {
  try {
    return JSON.parse(localStorage.getItem(key(id)) ?? "[]");
  } catch {
    return [];
  }
};
const save = (id: string, msgs: Msg[]) => {
  try {
    localStorage.setItem(key(id), JSON.stringify(msgs.slice(-40)));
  } catch {
    /* not kept */
  }
};

const SYSTEM =
  "You are Bond, a thoughtful thinking partner helping the user work through one project idea. " +
  "Be concrete and useful: sharpen the goal, say what would make it work or fail, what to check first, a cheap way to test it, and clear next steps. " +
  "You cannot browse the web. If something depends on facts, current events, rules, or numbers you aren't sure of, say so plainly and say what to verify and where; " +
  "never invent statistics, studies, laws or sources. Prefer a short answer (under 170 words) and end with one question or next step. Plain text, no markdown.";

const STARTERS = ["Is this feasible?", "How can I test it quickly?", "What could go wrong?", "Break it into steps"];

const BRAIN: Record<string, string> = { local: "the brain on this laptop", gemini: "Google Gemini", claude: "Claude" };

export default function IdeaChat({ idea, onClose }: { idea: Idea; onClose: () => void }) {
  const [msgs, setMsgs] = useState<Msg[]>(() => load(idea.id));
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const provider = loadSettings().aiProvider;

  useEffect(() => {
    setMsgs(load(idea.id));
    setErr("");
  }, [idea.id]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [msgs, busy]);

  const ask = async (text: string) => {
    const q = text.trim();
    if (!q || busy) return;
    const next: Msg[] = [...msgs, { role: "you", text: q }];
    setMsgs(next);
    save(idea.id, next);
    setDraft("");
    setBusy(true);
    setErr("");
    const history = next
      .slice(-11, -1)
      .map((m) => `${m.role === "you" ? "User" : "Bond"}: ${m.text}`)
      .join("\n");
    try {
      const reply = await aiText(SYSTEM, `The idea: ${idea.text}\n\n${history ? `Conversation so far:\n${history}\n\n` : ""}User: ${q}`);
      const done: Msg[] = [...next, { role: "bond", text: reply.trim() || "I don't have anything useful to add to that." }];
      setMsgs(done);
      save(idea.id, done);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const clear = () => {
    setMsgs([]);
    try {
      localStorage.removeItem(key(idea.id));
    } catch {
      /* nothing to clear */
    }
  };

  return (
    <aside className="detail chat" aria-label="Talk this idea through">
      <div className="detail-head">
        <div>
          <h3>Talk it through</h3>
          <div className="detail-sub muted">With {BRAIN[provider] ?? "Bond's brain"}</div>
        </div>
        {msgs.length > 0 && (
          <button className="linkish" onClick={clear} title="Delete this conversation">
            Clear
          </button>
        )}
        <button className="icon-btn" onClick={onClose} aria-label="Close conversation" title="Close">
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </div>

      <p className="chat-idea" title={idea.text}>
        {idea.text}
      </p>

      <div className="chat-log" role="log" aria-live="polite">
        {msgs.length === 0 && (
          <div className="chat-empty">
            <p className="muted small">
              {provider === "local"
                ? "This brain can sharpen and challenge an idea, but it can't look things up. For facts, pick Gemini or Claude in Settings → AI & models (your messages then go to that service)."
                : `Your messages here are sent to ${BRAIN[provider]}. It can't browse the web either, so check any facts it gives you.`}
            </p>
            <div className="prompt-row">
              {STARTERS.map((s) => (
                <button key={s} className="chip" onClick={() => void ask(s)} disabled={busy}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`bubble ${m.role}`}>
            {m.text}
          </div>
        ))}
        {busy && <div className="bubble bond thinking">Thinking…</div>}
        {err && (
          <p className="error" role="alert">
            {err}
          </p>
        )}
        <div ref={end} />
      </div>

      <form
        className="chat-form"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(draft);
        }}
      >
        <textarea
          value={draft}
          rows={2}
          placeholder="Ask about this idea…"
          aria-label="Message"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void ask(draft);
            }
          }}
        />
        <button className="btn" disabled={busy || !draft.trim()}>
          Send
        </button>
      </form>
    </aside>
  );
}
