// "Ask Bond": a small command box, and the answer card. One box for everything:
// log your day, save an idea, have him do something, ask about your screen, or get help.
//
// The card also asks for approval before anything powerful (a command, ending a program,
// deleting files): it shows exactly what will happen. Deleting needs a second yes, where
// you type "delete".

import { useEffect, useRef, useState, type Ref } from "react";
import type { Approval, Feedback } from "../ai";
import type { Suggestion } from "../assistant/notice";
import "./ask.css";

export type AskState =
  | { step: "input" }
  | { step: "thinking"; question: string; looking: boolean; note?: string }
  | { step: "answer"; question: string; answer: string; done: string[]; info?: string[]; rated?: Feedback }
  | { step: "approve"; question: string; approval: Approval; done: string[]; info: string[] }
  | { step: "suggest"; suggestion: Suggestion }
  /** Goals: the morning question, a nudge about drifting, and the Sunday review. */
  /** A message he wrote for you: read it, change it, copy it or put it in the box you were typing in. */
  | { step: "draft"; question: string; subject: string; message: string; usedScreen: boolean; note?: string; busy?: boolean }
  /** A draft needs one fact first ("What is the channel about?"). */
  | { step: "draftneed"; question: string; need: string }
  | { step: "goalask" }
  | { step: "drift"; text: string }
  | { step: "goalnudge"; text: string }
  | { step: "review"; text: string }
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
          placeholder={props.onMic ? "Tell Bond anything… or hold Ctrl+Alt to talk" : "Tell Bond anything…"}
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
  onApprove: (id: string, alt?: boolean) => void;
  onDeny: (id: string) => void;
  /** The confirmation box wants the keyboard. */
  onWantFocus: () => void;
  /** 👍 / 👎 on an answer, or null when there's nothing to rate. */
  onRate: ((value: Feedback) => void) | null;
  /** A suggestion he made: take it, not now, or never again. */
  onTake: () => void;
  onNotNow: () => void;
  onNever: () => void;
  /** "Was that you?": yes (he learns your voice and does it) or no. */
  onItsMe: () => void;
  onNotMe: () => void;
  /** Today's focus: set it, or skip today. */
  /** Copy text (an answer, a draft). */
  onCopy: (text: string) => void;
  /** Put the draft in the box you were typing in (never sends it). */
  onDraftPut: (text: string) => void;
  /** Write it again. */
  onDraftRetry: () => void;
  onGoalSet: (text: string) => void;
  onGoalSkip: () => void;
  /** Drifting: back to it, "this is on-goal", or leave me alone for a while. */
  onDriftBack: () => void;
  onDriftOk: () => void;
  onGoalDrop: () => void;
  onNeedAnswer: (answer: string) => void;
  onDriftSnooze: () => void;
  /** The Sunday review: open it, or later. */
  onReviewOpen: () => void;
  onReviewLater: () => void;
}

export function AnswerCard(props: { cardRef: Ref<HTMLDivElement>; state: AskState } & CardActions) {
  const s = props.state;
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
      {s.step === "draft" && <DraftBody key={s.question + s.message} s={s} onCopy={props.onCopy} onPut={props.onDraftPut} onRetry={props.onDraftRetry} onWantFocus={props.onWantFocus} />}
      {s.step === "draftneed" && <NeedBody need={s.need} onAnswer={props.onNeedAnswer} onSkip={props.onGoalSkip} onWantFocus={props.onWantFocus} />}
      {s.step === "goalask" && <GoalAsk onSet={props.onGoalSet} onSkip={props.onGoalSkip} onWantFocus={props.onWantFocus} />}
      {s.step === "goalnudge" && (
        <>
          <p className="q">Your focus</p>
          <p className="a">{s.text}</p>
          <div className="choices">
            <button className="btn-ghost" onClick={props.onGoalDrop}>
              Drop it
            </button>
            <button className="btn-ghost" onClick={props.onDriftSnooze}>
              Later · 30 min
            </button>
            <button className="btn-primary" onClick={props.onDriftBack}>
              On it
            </button>
          </div>
        </>
      )}
      {s.step === "drift" && (
        <>
          <p className="q">Your focus</p>
          <p className="a">{s.text}</p>
          <div className="choices">
            <button className="btn-ghost" onClick={props.onDriftSnooze}>
              Not now · 30 min
            </button>
            <button className="btn-ghost" onClick={props.onDriftOk}>
              This is on-goal
            </button>
            <button className="btn-primary" onClick={props.onDriftBack}>
              Back to it
            </button>
          </div>
        </>
      )}
      {s.step === "review" && (
        <>
          <p className="q">Your week</p>
          <p className="a">{s.text}</p>
          <div className="choices">
            <button className="btn-ghost" onClick={props.onReviewLater}>
              Later
            </button>
            <button className="btn-primary" onClick={props.onReviewOpen}>
              See it
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

/** A message he wrote: the text is yours to change before it goes in the box. */
function DraftBody(props: { s: Extract<AskState, { step: "draft" }>; onCopy: (t: string) => void; onPut: (t: string) => void; onRetry: () => void; onWantFocus: () => void }) {
  const [text, setText] = useState(props.s.message);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = area.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
    }
  }, [text]);
  const busy = !!props.s.busy;
  return (
    <>
      <p className="q">{props.s.question}</p>
      {props.s.subject && (
        <p className="draft-subject">
          <b>Subject:</b> {props.s.subject}{" "}
          <button className="link copy" onClick={() => props.onCopy(props.s.subject)}>
            Copy subject
          </button>
        </p>
      )}
      <textarea
        ref={area}
        className="draft-text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={props.onWantFocus}
        aria-label="The message. You can edit it."
        spellCheck
        rows={3}
      />
      <p className="why">
        {props.s.note ?? (props.s.subject ? "Click inside the email's body first, then “Put in the box”." : "Read it, change it if you like. “Put in the box” never sends it.")}
        {props.s.usedScreen && !props.s.note ? " I read the conversation on your screen to write it." : ""}
      </p>
      <div className="choices">
        <button className="btn-ghost" onClick={props.onRetry} disabled={busy}>
          Try again
        </button>
        <button className="btn-ghost" onClick={() => props.onCopy(text)} disabled={busy || !text.trim()}>
          Copy
        </button>
        <button className="btn-primary" onClick={() => props.onPut(text)} disabled={busy || !text.trim()}>
          Put in the box
        </button>
      </div>
    </>
  );
}

/** A draft needs one fact first: a question and a few words in answer. */
function NeedBody(props: { need: string; onAnswer: (a: string) => void; onSkip: () => void; onWantFocus: () => void }) {
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    props.onWantFocus();
    const t = window.setTimeout(() => input.current?.focus(), 60);
    return () => clearTimeout(t);
  }, []);
  return (
    <>
      <p className="q">One thing first</p>
      <p className="a">{props.need}</p>
      <form
        className="choices"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) props.onAnswer(text.trim());
        }}
      >
        <input ref={input} className="confirm" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Escape" && props.onSkip()} placeholder="A few words are enough" aria-label={props.need} maxLength={300} autoComplete="off" spellCheck={false} />
        <button type="button" className="btn-ghost" onClick={props.onSkip}>
          Cancel
        </button>
        <button type="submit" className="btn-primary" disabled={!text.trim()}>
          Write it
        </button>
      </form>
    </>
  );
}

/** "What's your focus today?": one line, or not today. */
function GoalAsk(props: { onSet: (text: string) => void; onSkip: () => void; onWantFocus: () => void }) {
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    props.onWantFocus();
    const t = window.setTimeout(() => input.current?.focus(), 60);
    return () => clearTimeout(t);
  }, []);
  return (
    <>
      <p className="q">Good to see you</p>
      <p className="a">What's your focus today?</p>
      <form
        className="choices"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) props.onSet(text.trim());
        }}
      >
        <input
          ref={input}
          className="confirm"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && props.onSkip()}
          placeholder="e.g. finish the micrograd tutorial"
          aria-label="Your focus for today"
          maxLength={120}
          autoComplete="off"
          spellCheck={false}
        />
        <button type="button" className="btn-ghost" onClick={props.onSkip}>
          Not today
        </button>
        <button type="submit" className="btn-primary" disabled={!text.trim()}>
          Set focus
        </button>
      </form>
    </>
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
        {a.alt && !second && (
          <button type="button" className="btn-primary" onClick={() => props.onApprove(a.id, true)}>
            {a.alt}
          </button>
        )}
        <button type="submit" className={a.kind === "command" && !second ? "btn-primary" : "btn-danger"} disabled={!ok}>
          {second ? (a.kind === "delete" ? "Delete" : "Run it") : a.button}
        </button>
      </form>
    </>
  );
}
