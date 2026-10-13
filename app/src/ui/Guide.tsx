// Guide mode, as the user sees it: a ring around the next thing to click, a virtual cursor
// that glides there (starting from your real cursor), and a short note beside it.
// Nothing here clicks: the page under it is untouched, and only the note can be clicked.

import { useEffect, useState, type Ref } from "react";
import type { GuideTarget } from "../ai";
import "./guide.css";

export interface GuideView {
  say: string;
  step: "click" | "type" | "wait" | "done";
  target: GuideTarget | null;
  /** 1, 2, 3… */
  n: number;
  /** Hidden while Bond takes a screenshot, so the note never ends up in what he reads. */
  hidden?: boolean;
}

const TIP_W = 280;

export function Guide(props: { view: GuideView; origin: { x: number; y: number } | null; tipRef: Ref<HTMLDivElement>; onStop: () => void }) {
  const { view, origin } = props;
  const t = view.target;
  // The cursor starts where your real one is, then glides to the target.
  const [pos, setPos] = useState(origin ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 });
  useEffect(() => {
    if (!t) return;
    const id = requestAnimationFrame(() => setPos({ x: t.x + t.w / 2, y: t.y + t.h / 2 }));
    return () => cancelAnimationFrame(id);
  }, [t?.x, t?.y, t?.w, t?.h]);

  if (view.hidden) return null;

  // The note sits clear of the target, below it when there's room, otherwise above.
  let left = window.innerWidth / 2 - TIP_W / 2;
  let top = 24;
  if (t) {
    left = Math.min(Math.max(8, t.x + t.w / 2 - TIP_W / 2), window.innerWidth - TIP_W - 8);
    top = t.y + t.h + 16 + 80 < window.innerHeight ? t.y + t.h + 16 : Math.max(8, t.y - 16 - 64);
  }

  return (
    <>
      {t && (
        <>
          <div className="guide-ring" style={{ transform: `translate(${t.x}px, ${t.y}px)`, width: t.w, height: t.h }} />
          <svg className="guide-cursor" viewBox="0 0 30 36" style={{ transform: `translate(${pos.x}px, ${pos.y}px)` }} aria-hidden>
            <path d="M3 2 L3 29 L10 22.5 L15 33 L20 30.8 L15 20.5 L25 20 Z" fill="#fff" stroke="#1a2230" strokeWidth="2.2" strokeLinejoin="round" />
          </svg>
        </>
      )}
      <div ref={props.tipRef} className="guide-tip" role="status" style={{ transform: `translate(${left}px, ${top}px)` }}>
        {view.step !== "done" && view.n > 0 && <span className="n">{view.n}</span>}
        <p>{view.say || "Looking at your screen…"}</p>
        <button onClick={props.onStop} aria-label="Stop guiding" title="Stop">
          ✕
        </button>
      </div>
    </>
  );
}
