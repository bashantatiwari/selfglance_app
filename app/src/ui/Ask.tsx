// "Ask Bond": a small question box, the answer card, and a marker on the thing he points at.

import { useEffect, useRef, useState, type Ref } from "react";
import "./ask.css";

export type AskState =
  | { step: "input" }
  | { step: "thinking"; question: string }
  | { step: "answer"; question: string; answer: string; label: string | null; point: [number, number] | null }
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
          placeholder="Ask about anything on your screen…"
          aria-label="Ask Bond"
        />
        <button type="submit" disabled={!q.trim()} aria-label="Ask">
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M5 12h13M13 6l6 6-6 6" />
          </svg>
        </button>
      </form>
      <p className="ask-hint">He looks at your screen only when you ask. Enter to ask · Esc to close</p>
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
        </div>
      )}
      {s.step === "answer" && (
        <>
          <p className="q">{s.question}</p>
          <p className="a">{s.answer}</p>
          {s.label && <p className="pointing">→ {s.label}</p>}
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

/**
 * A pulsing ring on the exact spot Bond is pointing at. If the spot is outside his window
 * (e.g. on the taskbar), the ring sits at the nearest edge with an arrow toward it.
 */
export function PointMarker({ x, y, label }: { x: number; y: number; label: string | null }) {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const cx = Math.min(Math.max(x, 26), W - 26);
  const cy = Math.min(Math.max(y, 26), H - 26);
  const dir = y > H - 4 ? "down" : y < 4 ? "up" : x > W - 4 ? "right" : x < 4 ? "left" : null;
  return (
    <div className="point-marker" style={{ left: cx, top: cy }} aria-hidden>
      <i />
      <i />
      <b className="dot" />
      {dir && <em className={`edge-arrow ${dir}`} />}
      {label && <span className="point-label">{dir === "down" ? `${label} ↓` : label}</span>}
    </div>
  );
}
