// Right-click menu: actions fanned out in an arc around Bond's head.
// Each button pops out from his head in turn; hovering lifts it, rings it with light,
// and shows its name.

import type { CSSProperties, ReactElement, Ref } from "react";
import "./menu.css";

export type ActionId = "sit" | "dance" | "jump" | "wave" | "follow" | "ask" | "dashboard" | "later";

const ICONS: Record<ActionId, ReactElement> = {
  sit: <path d="M7 3v10h10v7M7 13v7M7 9h8" />,
  dance: (
    <>
      <path d="M9 18V5l10-2v13" />
      <circle cx="6.5" cy="18" r="2.5" />
      <circle cx="16.5" cy="16" r="2.5" />
    </>
  ),
  jump: <path d="M12 20V5M6 11l6-6 6 6" />,
  wave: <path d="M8 13V6.5a1.5 1.5 0 0 1 3 0V12M11 11V5a1.5 1.5 0 0 1 3 0v6M14 11V6.5a1.5 1.5 0 0 1 3 0V14a6 6 0 0 1-6 6h-1a5 5 0 0 1-4.3-2.5L4 13.5a1.5 1.5 0 0 1 2.6-1.5L8 14" />,
  follow: <path d="M5 3l14 7-6 2-2 6z" />,
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
  later: (
    <>
      <circle cx="12" cy="13" r="7.5" />
      <path d="M12 9v4l2.5 2M9 2.5h6" />
    </>
  ),
};

/** Geometry of the arc (px). The arc's centre sits on Bond's head. */
export const ARC = { radius: 112, button: 46, pad: 34 };
export const arcBox = () => ({
  w: 2 * (ARC.radius + ARC.button / 2 + ARC.pad),
  h: ARC.radius + ARC.button / 2 + ARC.pad * 2,
});

export function ActionMenu(props: {
  menuRef: Ref<HTMLDivElement>;
  sitting: boolean;
  following: boolean;
  /** A water break is on: offer "Later" (snooze) first. */
  inBreak: boolean;
  laterMin: number;
  onPick: (id: ActionId) => void;
}) {
  const items: { id: ActionId; label: string; on?: boolean }[] = [
    ...(props.inBreak ? [{ id: "later" as const, label: `${props.laterMin} min later` }] : []),
    { id: "sit", label: props.sitting ? "Stand up" : "Sit", on: props.sitting },
    { id: "dance", label: "Dance" },
    { id: "jump", label: "Jump" },
    { id: "wave", label: "Wave" },
    { id: "follow", label: props.following ? "Stop following" : "Follow me", on: props.following },
    { id: "ask", label: "Ask Bond" },
    { id: "dashboard", label: "Dashboard" },
  ];
  const { w, h } = arcBox();
  const cx = w / 2;
  const cy = h - ARC.pad; // arc centre: bottom middle of the box (on his head)
  // Spread from 172° (left) to 8° (right) over the top.
  const from = 172;
  const to = 8;
  const step = items.length > 1 ? (from - to) / (items.length - 1) : 0;

  return (
    <div ref={props.menuRef} className="arc-menu" role="menu" style={{ width: w, height: h }}>
      <svg className="arc-guide" width={w} height={h} aria-hidden>
        <path d={`M ${cx - ARC.radius} ${cy} A ${ARC.radius} ${ARC.radius} 0 0 1 ${cx + ARC.radius} ${cy}`} fill="none" />
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
          <button key={it.id} role="menuitem" className={`arc-btn ${it.on ? "on" : ""}`} style={style} onClick={() => props.onPick(it.id)} aria-label={it.label}>
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
