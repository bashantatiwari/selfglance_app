// "Ask Bond": a small command box, and the answer card. One box for everything:
// log your day, save an idea, have him do something, ask about your screen, or get help.
//
// The card also asks for approval before anything powerful (a command, ending a program,
// deleting files): it shows exactly what will happen. Deleting needs a second yes, where
// you type "delete". And it carries reminders when they're due.

import { useEffect, useRef, useState, type Ref } from "react";
import type { Approval, Feedback, Reminder } from "../ai";
import type { Suggestion } from "../assistant/notice";
import "./ask.css";

export type AskState =
  | { step: "input" }
  | { step: "thinking"; question: string; looking: boolean; note?: string }
  | { step: "answer"; question: string; answer: string; done: string[]; info?: string[]; rated?: Feedback }
  | { step: "approve"; question: string; approval: Approval; done: string[]; info: string[] }
  | { step: "reminder"; reminder: Reminder }
  | { step: "suggest"; suggestion: Suggestion }
  | { step: "unsure" }
  | { step: "error"; question: string; error: string };

/** The word typed to confirm a deletion the second time. */
export const CONFIRM_WORD = "delete";

export function AskBox(props: { boxRef: Ref<HTMLDivElement>; onAsk: (q: string) => void; onClose: () => void; onMic: (() => void) | null }) {
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
          placeholder={props.onMic ? "Tell Bond anything… or hold Ctrl+Alt+V to talk" : "Tell Bond anything…"}
          aria-label="Ask Bond"
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
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
  /** The confirmation box wants the keyboard. */
  onWantFocus: () => void;
  onSnooze: (r: Reminder, minutes: number) => void;
  onOpen: (page: "journal") => void;
  /** 👍 / 👎 on an answer, or null when there's nothing to rate. */
  onRate: ((value: Feedback) => void) | null;
  /** A suggestion he made: take it, not now, or never again. */
  onTake: () => void;
  onNotNow: () => void;
  onNever: () => void;
  /** "Was that you?": yes (he learns your voice and does it) or no. */
  onItsMe: () => void;
  onNotMe: () => void;
}

export function AnswerCard(props: { cardRef: Ref<HTMLDivElement>; state: AskState } & CardActions) {
  const s = props.state;
  const when = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <div ref={props.cardRef} className={`ask-card ${s.step}`} role={s.step === "approve" ? "alertdialog" : "status"}>
      {s.step === "thinking" && (
        <div className="thinking" aria-label="Thinking">
          <i />
          <i />
          <i />
          {(s.note || s.looking) && <span>{s.note ?? "looking at your screen…"}</span>}
        </div>
      )}
      {s.step === "approve" && <ApproveBody key={s.approval.id} approval={s.approval} done={s.done} {...props} />}
      {s.step === "reminder" && (
        <>
          <p className="q">Reminder · {when(s.reminder.at)}</p>
          <p className="a reminder-text">{s.reminder.text}</p>
          <div className="choices">
            <button className="btn-ghost" onClick={() => props.onSnooze(s.reminder, 10)}>
              Snooze 10 min
            </button>
            {s.reminder.open ? (
              <button className="btn-primary" onClick={() => props.onOpen(s.reminder.open!)}>
                Write it now
              </button>
            ) : (
              <button className="btn-primary" onClick={props.onClose}>
                Done
              </button>
            )}
          </div>
        </>
      )}
      {s.step === "unsure" && (
        <>
          <p className="q">Voice match</p>
          <p className="a">Was that you? I wasn't sure it was your voice.</p>
          <p className="why">If it was, I'll do what you asked and remember your voice better.</p>
          <div className="choices">
            <button className="btn-ghost" onClick={props.onNotMe}>
              No
            </button>
            <button className="btn-primary" onClick={props.onItsMe}>
              Yes, it was me
            </button>
          </div>
        </>
      )}
      {s.step === "suggest" && (
        <>
          <p className="q">Bond noticed</p>
          <p className="a">{s.suggestion.text}</p>
          <div className="choices">
            <button className="btn-ghost" onClick={props.onNotNow}>
              Not now
            </button>
            <button className="btn-primary" onClick={props.onTake}>
              {s.suggestion.primary.label}
            </button>
          </div>
          <button className="link never" onClick={props.onNever}>
            Don't suggest this again
          </button>
        </>
      )}
      {s.step === "answer" && (
        <>
          <p className="q">{s.question}</p>
          {s.answer && <p className="a">{s.answer}</p>}
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
          {props.onRate && (
            <div className="rate" role="group" aria-label="Was this right?">
              {s.rated ? (
                <span>{s.rated === "good" ? "Thanks — I'll keep doing that." : "Got it — I'll avoid that."}</span>
              ) : (
                <>
                  <button onClick={() => props.onRate?.("good")} aria-label="That was right" title="That was right">
                    👍
                  </button>
                  <button onClick={() => props.onRate?.("bad")} aria-label="That was wrong" title="That was wrong">
                    👎
                  </button>
                </>
              )}
            </div>
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
      {s.step !== "thinking" && s.step !== "approve" && (
        <button className="close" onClick={props.onClose} aria-label="Close">
          ×
        </button>
      )}
    </div>
  );
}

/** Step 1: what will happen, Yes / No. Step 2 (deleting): type the word to confirm. */
function ApproveBody(props: { approval: Approval; done: string[] } & CardActions) {
  const a = props.approval;
  const second = a.step > 1;
  const [typed, setTyped] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const ok = !second || typed.trim().toLowerCase() === CONFIRM_WORD;
  useEffect(() => {
    if (!second) return;
    props.onWantFocus();
    const t = window.setTimeout(() => input.current?.focus(), 60);
    return () => clearTimeout(t);
  }, [second]);
  return (
    <>
      {props.done.length > 0 && (
        <ul className="done">
          {props.done.map((d, i) => (
            <li key={i}>{d}</li>
          ))}
        </ul>
      )}
      <p className="q">{a.steps > 1 ? `Needs your OK · check ${a.step} of ${a.steps}` : "Needs your OK"}</p>
      <p className="a approve-title">{second ? "Are you sure? Last check." : a.title}</p>
      {a.previews.length > 0 && (
        <div className="previews" aria-label="Pictures that will be deleted">
          {a.previews.map((p) => (
            <img key={p.name} src={`data:image/jpeg;base64,${p.jpeg}`} alt={p.name} title={p.name} />
          ))}
          {a.items.length > a.previews.length && <span className="more">+{a.items.length - a.previews.length} more, listed below</span>}
        </div>
      )}
      <pre className={`out items ${a.kind}`}>{a.items.join("\n")}</pre>
      {a.why && <p className="why">{a.why}</p>}
      <form
        className="choices"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) props.onApprove(a.id);
        }}
      >
        {second && (
          <input
            ref={input}
            className="confirm"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && props.onDeny(a.id)}
            placeholder={`Type “${CONFIRM_WORD}”`}
            aria-label={`Type ${CONFIRM_WORD} to confirm`}
            autoComplete="off"
            spellCheck={false}
          />
        )}
        <button type="button" className="btn-ghost" onClick={() => props.onDeny(a.id)}>
          Cancel
        </button>
        <button type="submit" className={a.kind === "command" && !second ? "btn-primary" : "btn-danger"} disabled={!ok}>
          {second ? (a.kind === "delete" ? "Delete" : "Run it") : a.button}
        </button>
      </form>
    </>
  );
}
