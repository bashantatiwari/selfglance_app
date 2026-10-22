// Small shared pieces of the dashboard: toasts (with Undo), the letter avatar, the kind badge, the switch.

import { useEffect, useState } from "react";

// --- Toasts ----------------------------------------------------------------------------
type ToastItem = { id: number; text: string; action?: { label: string; run: () => void } };
let pushToast: (t: Omit<ToastItem, "id">) => void = () => {};

/** A short message at the bottom of the window, optionally with an action (Undo). */
export const toast = (text: string, action?: ToastItem["action"]) => pushToast({ text, action });

export function Toasts() {
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => {
    let n = 0;
    pushToast = (t) => {
      const id = ++n;
      setItems((all) => [...all.slice(-2), { ...t, id }]);
      window.setTimeout(() => setItems((all) => all.filter((x) => x.id !== id)), t.action ? 7000 : 3200);
    };
    return () => {
      pushToast = () => {};
    };
  }, []);
  if (!items.length) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div className="toast" key={t.id}>
          <span>{t.text}</span>
          {t.action && (
            <button
              onClick={() => {
                t.action!.run();
                setItems((all) => all.filter((x) => x.id !== t.id));
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

// --- Avatar & badges -------------------------------------------------------------------
/** The first letter of a name on a soft tint of its category color (real app icons aren't available). */
export function Avatar({ label, color, size = 28 }: { label: string; color: string; size?: number }) {
  const letter = (label.match(/[\p{L}\p{N}]/u)?.[0] ?? "•").toUpperCase();
  return (
    <span className="avatar" aria-hidden style={{ width: size, height: size, fontSize: size * 0.46, color, background: `color-mix(in srgb, ${color} 15%, transparent)` }}>
      {letter}
    </span>
  );
}

/** App / Site / Video / Project, each its own tint so two rows with the same name read apart. */
export function KindBadge({ kind }: { kind: string }) {
  return <span className={`kind kind-${kind.toLowerCase()}`}>{kind}</span>;
}

// --- Switch ----------------------------------------------------------------------------
export function Toggle(props: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; note?: string | null }) {
  return (
    <label className="toggle">
      <input type="checkbox" role="switch" checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} />
      <span className="switch" aria-hidden />
      <span>
        {props.label}
        {props.hint && <small className="muted">{props.hint}</small>}
        {props.note && <small className="muted">{props.note}</small>}
      </span>
    </label>
  );
}
