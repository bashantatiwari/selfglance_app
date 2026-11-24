// "Ask Bond": a small box to type in, and Bond's card: what he heard, that he's thinking, his
// answer, the morning "what's on today?", and a drift nudge.

import { useEffect, useRef, useState, type Ref } from "react";
import "./ask.css";

export type AskState =
  | { step: "input" }
  /** Ctrl+Alt is held: shown from the press until you let go. `ready` once the microphone is on. */
  | { step: "listening"; ready: boolean }
  | { step: "thinking"; question: string; note?: string }
  | { step: "answer"; question: string; answer: string; done: string[]; info?: string[] }
  /** The morning: what's on today? One item per line. */
  | { step: "todoask" }
  | { step: "drift"; text: string }
  /** A question from Bond with a few answers to pick from (the end of the day, a stalled list). */
  | { step: "choice"; title: string; text: string; options: { label: string; primary?: boolean; run: () => void }[] }
  | { step: "error"; question: string; error: string };

export function AskBox(props: { boxRef: Ref<HTMLDivElement>; onAsk: (q: string) => void; onClose: () => void; onMic: (() => void) | null }) {
  const [q, setQ] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
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
          placeholder={props.onMic ? "Tell Bond anything… or hold Ctrl+Alt to talk" : "Tell Bond anything…"}
          aria-label="Ask Bond"
          maxLength={500}
        />
        {props.onMic && !q.trim() && (
          <button type="button" className="mic" onClick={props.onMic} aria-label="Talk to Bond" title="Talk (stops when you go quiet)">
            <svg viewBox="0 0 24 24" aria-hidden>
              <rect x="9" y="3" width="6" height="11" rx="3" />
              <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
            </svg>
          </button>
        )}
        <button type="submit" disabled={!q.trim()} aria-label="Send">
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M5 12h13M13 6l6 6-6 6" />
          </svg>
        </button>
      </form>
    </div>
  );
}

export interface CardActions {
  onClose: () => void;
  onSettings: () => void;
  /** The card's text box wants the keyboard. */
  onWantFocus: () => void;
  onCopy: (text: string) => void;
  /** The morning list: save these items, or skip today. */
  onTodos: (items: string) => void;
  onTodoSkip: () => void;
  /** Drifting: back to it, "this counts", or not now (30 minutes). */
  onDriftBack: () => void;
  onDriftOk: () => void;
  onDriftSnooze: () => void;
}

export function AnswerCard(props: { cardRef: Ref<HTMLDivElement>; state: AskState } & CardActions) {
  const s = props.state;
  return (
    <div ref={props.cardRef} className={`ask-card ${s.step}`} role="status">
      {s.step === "listening" && (
        <div className="thinking listening" aria-label="Listening">
          <i />
          <i />
          <i />
          <span>{s.ready ? "Listening… let go when you're done" : "Getting the mic ready…"}</span>
        </div>
      )}
      {s.step === "thinking" && (
        <>
          {s.question && <p className="q">{s.question}</p>}
          <div className="thinking" aria-label="Thinking">
            <i />
            <i />
            <i />
            <span>{s.note ?? "thinking…"}</span>
          </div>
        </>
      )}
      {s.step === "todoask" && <TodoAsk onSave={props.onTodos} onSkip={props.onTodoSkip} onWantFocus={props.onWantFocus} />}
      {s.step === "choice" && (
        <>
          <p className="q">{s.title}</p>
          <p className="a">{s.text}</p>
          <div className="choices">
            {s.options.map((o) => (
              <button key={o.label} className={o.primary ? "btn-primary" : "btn-ghost"} onClick={o.run}>
                {o.label}
              </button>
            ))}
          </div>
        </>
      )}
      {s.step === "drift" && (
        <>
          <p className="q">Today's list</p>
          <p className="a">{s.text}</p>
          <div className="choices">
            <button className="btn-ghost" onClick={props.onDriftSnooze}>
              Not now
            </button>
            <button className="btn-ghost" onClick={props.onDriftOk}>
              This counts
            </button>
            <button className="btn-primary" onClick={props.onDriftBack}>
              Back to it
            </button>
          </div>
        </>
      )}
      {s.step === "answer" && (
        <>
          <p className="q">{s.question}</p>
          {s.answer && <p className="a">{s.answer}</p>}
          {s.answer && s.answer.length > 40 && (
            <button className="link copy" onClick={() => props.onCopy(s.answer)}>
              Copy
            </button>
          )}
          {s.info?.map((t, i) => (
            <pre key={i} className="out">
              {t}
            </pre>
          ))}
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
          {/Settings/i.test(s.error) && (
            <button className="link" onClick={props.onSettings}>
              Open settings
            </button>
          )}
        </>
      )}
      {s.step !== "thinking" && s.step !== "listening" && (
        <button className="close" onClick={props.onClose} aria-label="Close">
          ×
        </button>
      )}
    </div>
  );
}

/** "What's on today?": a few lines, one thing per line. */
function TodoAsk(props: { onSave: (text: string) => void; onSkip: () => void; onWantFocus: () => void }) {
  const [text, setText] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    props.onWantFocus();
    const t = window.setTimeout(() => area.current?.focus(), 60);
    return () => clearTimeout(t);
  }, []);
  const save = () => text.trim() && props.onSave(text.trim());
  return (
    <>
      <p className="q">Good to see you</p>
      <p className="a">What's on today? One thing per line.</p>
      <textarea
        ref={area}
        className="draft-text"
        value={text}
        rows={4}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") props.onSkip();
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) save();
        }}
        placeholder={"make the video for my channel\nlearn LangGraph\ninternship work"}
        aria-label="Today's list, one thing per line"
        maxLength={800}
        spellCheck={false}
      />
      <div className="choices">
        <button type="button" className="btn-ghost" onClick={props.onSkip}>
          Not today
        </button>
        <button type="button" className="btn-primary" disabled={!text.trim()} onClick={save}>
          Save my day
        </button>
      </div>
    </>
  );
}
