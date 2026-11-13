// Timers on screen: each counts down where you can see it. The – makes it small (just the time), the × cancels
// it. When one reaches zero it stays, ringing, until you dismiss it (or a minute passes).

import { useEffect, useState, type RefObject } from "react";
import { leftText, type Timer } from "../assistant/timer";
import "./timers.css";

export function Timers(props: { timers: Timer[]; boxRef: RefObject<HTMLDivElement | null>; onCancel: (id: string) => void; onDone: (t: Timer) => void }) {
  const [now, setNow] = useState(Date.now());
  const [small, setSmall] = useState<Record<string, boolean>>({});
  const [rung, setRung] = useState<Record<string, boolean>>({});

  // Four looks a second: the seconds change on time without drawing more than that.
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    for (const t of props.timers) {
      if (now >= t.end && !rung[t.id]) {
        setRung((r) => ({ ...r, [t.id]: true }));
        setSmall((s) => ({ ...s, [t.id]: false })); // a finished timer shows itself again
        props.onDone(t);
      }
      // Nobody dismissed it: it goes by itself after a minute.
      if (now - t.end > 60_000) props.onCancel(t.id);
    }
  }, [now, props.timers]);

  return (
    <div ref={props.boxRef} className="timers">
      {props.timers.map((t) => {
        const left = t.end - now;
        const done = left <= 0;
        const part = Math.min(1, Math.max(0, (now - t.start) / Math.max(1, t.end - t.start)));
        const mini = small[t.id] && !done;
        return (
          <div key={t.id} className={`timer${done ? " done" : ""}${mini ? " mini" : ""}`}>
            <button className="timer-time" title={mini ? "Show" : undefined} onClick={() => mini && setSmall((s) => ({ ...s, [t.id]: false }))}>
              {done ? "Time's up" : leftText(left)}
            </button>
            {!mini && (
              <>
                {t.label && <span className="timer-label">{t.label}</span>}
                <span className="timer-bar">
                  <span style={{ width: `${part * 100}%` }} />
                </span>
                {!done && (
                  <button className="timer-btn" title="Make it small" aria-label="Make it small" onClick={() => setSmall((s) => ({ ...s, [t.id]: true }))}>
                    –
                  </button>
                )}
              </>
            )}
            <button className="timer-btn" title={done ? "Dismiss" : "Cancel timer"} aria-label={done ? "Dismiss" : "Cancel timer"} onClick={() => props.onCancel(t.id)}>
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
