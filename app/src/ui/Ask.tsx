// "Ask Bond": a small command box, and the answer card. One box for everything:
// log your day, save an idea, have him do something, ask about your screen, or get help.

import { useEffect, useRef, useState, type Ref } from "react";
import "./ask.css";

export type AskState =
  | { step: "input" }
  | { step: "thinking"; question: string; looking: boolean }
  | { step: "answer"; question: string; answer: string; done: string[] }
  | { step: "error"; question: string; error: string };

export function AskBox(props: { boxRef: Ref<HTMLDivElement>; onAsk: (q: string) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // The window just received focus from Rust; give the input the caret.
    const t = window.setTimeout(() => input.current?.focus(), 30);
    return () => clearTimeout(t);
  }, []);
  return (
    <div ref={props.boxRef} className="ask-box">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim()) props.onAsk(q.trim());
        }}
      >
        <input
          ref={input}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && props.onClose()}
          placeholder="Tell Bond anything…"
          aria-label="Ask Bond"
        />
        <button type="submit" disabled={!q.trim()} aria-label="Send">
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M5 12h13M13 6l6 6-6 6" />
          </svg>
        </button>
      </form>
    </div>
  );
}

export function AnswerCard(props: { cardRef: Ref<HTMLDivElement>; state: AskState; onClose: () => void; onSettings: () => void }) {
  const s = props.state;
  return (
    <div ref={props.cardRef} className={`ask-card ${s.step}`} role="status">
      {s.step === "thinking" && (
        <div className="thinking" aria-label="Thinking">
          <i />
          <i />
          <i />
          {s.looking && <span>looking at your screen…</span>}
        </div>
      )}
      {s.step === "answer" && (
        <>
          <p className="q">{s.question}</p>
          {s.answer && <p className="a">{s.answer}</p>}
          {s.done.length > 0 && (
            <ul className="done">
              {s.done.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          )}
        </>
      )}
      {s.step === "error" && (
        <>
          <p className="a">{s.error}</p>
          {/key|Settings/i.test(s.error) && (
            <button className="link" onClick={props.onSettings}>
              Open settings
            </button>
          )}
        </>
      )}
      {s.step !== "thinking" && (
        <button className="close" onClick={props.onClose} aria-label="Close">
          ×
        </button>
      )}
    </div>
  );
}
