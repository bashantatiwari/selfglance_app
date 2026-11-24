// Right-click menu: a few actions fanned out in an arc around Bond's head.
// Each button pops out from his head in turn; hovering lifts it, rings it with light,
// and shows its name.

import type { CSSProperties, ReactElement, Ref } from "react";
import "./menu.css";

export type ActionId = "ask" | "dashboard" | "later" | "tuck";

const ICONS: Record<ActionId, ReactElement> = {
  ask: (
    <>
      <path d="M4 5h16v11H9l-5 4z" />
      <path d="M10 9.5a2 2 0 1 1 2.5 1.9c-.5.2-.5.6-.5 1.1M12 14.2v.1" />
    </>
  ),
  dashboard: (
    <>
      <rect x="3.5" y="3.5" width="7" height="9" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="5" rx="1.5" />
      <rect x="13.5" y="11.5" width="7" height="9" rx="1.5" />
      <rect x="3.5" y="15.5" width="7" height="5" rx="1.5" />
    </>
  ),
  tuck: (
    <>
      <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
    </>
  ),
  later: (
    <>
      <circle cx="12" cy="13" r="7.5" />
      <path d="M12 9v4l2.5 2M9 2.5h6" />
    </>
  ),
};

/** Geometry of the arc (px). The arc's centre sits on Bond's head. */
export const ARC = { radius: 100, button: 46, pad: 34 };
/** Degrees between two buttons; the group is centred right above his head. */
const GAP = 44;
export const arcBox = () => ({
  w: 2 * (ARC.radius + ARC.button / 2 + ARC.pad),
  h: ARC.radius + ARC.button / 2 + ARC.pad * 2,
});

export function ActionMenu(props: {
  menuRef: Ref<HTMLDivElement>;
  /** A water break is on: offer "Later" (snooze) first. */
  inBreak: boolean;
  laterMin: number;
  onPick: (id: ActionId) => void;
}) {
  const items: { id: ActionId; label: string }[] = [
    ...(props.inBreak ? [{ id: "later" as const, label: `${props.laterMin} min later` }] : []),
    { id: "ask", label: "Ask Bond" },
    { id: "dashboard", label: "Dashboard" },
    { id: "tuck", label: "Tuck away" },
  ];
  const { w, h } = arcBox();
  const cx = w / 2;
  const cy = h - ARC.pad; // arc centre: bottom middle of the box (on his head)
  // A tight group centred above his head (90° = straight up), not spread across the screen.
  const step = GAP;
  const from = 90 + (step * (items.length - 1)) / 2;
  const to = from - step * (items.length - 1);
  const at = (deg: number) => ({ x: cx + ARC.radius * Math.cos((deg * Math.PI) / 180), y: cy - ARC.radius * Math.sin((deg * Math.PI) / 180) });
  const a0 = at(from + 14);
  const a1 = at(to - 14);

  return (
    <div ref={props.menuRef} className="arc-menu" role="menu" style={{ width: w, height: h }}>
      <svg className="arc-guide" width={w} height={h} aria-hidden>
        <path d={`M ${a0.x} ${a0.y} A ${ARC.radius} ${ARC.radius} 0 0 1 ${a1.x} ${a1.y}`} fill="none" />
      </svg>
      {items.map((it, i) => {
        const a = ((from - step * i) * Math.PI) / 180;
        const x = cx + ARC.radius * Math.cos(a);
        const y = cy - ARC.radius * Math.sin(a);
        const style = {
          left: x - ARC.button / 2,
          top: y - ARC.button / 2,
          width: ARC.button,
          height: ARC.button,
          // where it pops out from: Bond's head (the arc centre)
          "--fx": `${cx - x}px`,
          "--fy": `${cy - y}px`,
          "--d": `${i * 35}ms`,
        } as CSSProperties;
        return (
          <button key={it.id} role="menuitem" className="arc-btn" style={style} onClick={() => props.onPick(it.id)} aria-label={it.label}>
            <svg viewBox="0 0 24 24" aria-hidden>
              {ICONS[it.id]}
            </svg>
            <span className="arc-label">{it.label}</span>
          </button>
        );
      })}
    </div>
  );
}
