// The dashboard, organised around the questions you actually ask:
//   Today     How did today go? One number, one bar, four stats, the day as a strip,
//             top things + a few insights, and the day in words (AI).
//   Activity  What exactly did I spend time on? One searchable list (projects, videos,
//             sites, apps) and the session-by-session log.
//   Goals     The day's focus, how it's going toward it, and the week in review.
//   Chats     What you asked Bond and his answers, to search and copy.
//   Ideas     Project ideas you told Bond ("idea: …") or added here.
//   Settings  Water breaks, Bond, his brain, voice and privacy, each explained.
// Everything is computed locally from the diary the overlay records.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { inTauri, onTauriEvent } from "../platform";
import {
  aiText,
  brainInstall,
  brainStatus,
  exportLearned,
  forgetLearned,
  learnStats,
  speak,
  voiceInstall,
  memoryForget,
  memoryList,
  wakeEnrollCancel,
  wakeEnrollRecord,
  wakeEnrollSave,
  wakeForgetVoice,
  wakeInstall,
  wakeStatus,
  type WakeStatus,
  voiceStatus,
  type BrainProgress,
  type VoiceStatus,
  type BrainStatus,
  type LearnStats,
} from "../ai";
import { analyzeDay, CATS, catName, clock, fmt, insights, type Cat, type DayStats, type Item, type Kind } from "./analyze";
import { loadDay, type Segment } from "../companion/tracker";
import { glassesToday } from "../break/BreakCoach";
import { loadSettings, saveSettings, type Settings, effective } from "../settings";
import Chats from "./Chats";
import Goals, { GoalTile } from "./Goals";
import Ideas from "./Ideas";
import { Avatar, KindBadge, Toasts, Toggle } from "./ui";
import "./dashboard.css";
import "./design.css";
import "./neo.css";

type Page = "today" | "activity" | "goals" | "chats" | "ideas" | "settings";
type NavGroup = "analyse" | "personal" | "prefs";
const NAV_GROUPS: { id: NavGroup; name: string }[] = [
  { id: "analyse", name: "Analyse" },
  { id: "personal", name: "Personal" },
  { id: "prefs", name: "Preferences" },
];
const PAGES: { id: Page; name: string; group: NavGroup; icon: ReactNode }[] = [
  { id: "today", name: "Today", group: "analyse", icon: <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z" /> },
  { id: "activity", name: "Activity", group: "analyse", icon: <path d="M4 6h16M4 12h10M4 18h13" /> },
  { id: "goals", name: "Goals", group: "personal", icon: <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM12 12.5a.5.5 0 1 0 0-1 .5.5 0 0 0 0 1z" /> },
  { id: "chats", name: "Chats", group: "personal", icon: <path d="M4 5h16v11H9l-5 4zM8 9h8M8 12.5h5" /> },
  { id: "ideas", name: "Ideas", group: "personal", icon: <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V16h5v-.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z" /> },
  { id: "settings", name: "Settings", group: "prefs", icon: <path d="M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19.4 13a7.5 7.5 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-1.7-1L15 3.5h-4l-.4 2.5a7.6 7.6 0 0 0-1.7 1l-2.4-1-2 3.4L6.6 11a7.5 7.5 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 1.7 1l.4 2.5h4l.4-2.5a7.6 7.6 0 0 0 1.7-1l2.4 1 2-3.4z" /> },
];

/** Follow Windows (no attribute), or force light or dark. */
export function applyTheme(t: Settings["theme"]) {
  const el = document.documentElement;
  if (t === "light" || t === "dark") el.setAttribute("data-theme", t);
  else el.removeAttribute("data-theme");
}

const catVar = (c: Cat) => `var(--cat-${c})`;
const dayDate = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  return d;
};
const dayName = (offset: number) =>
  offset === 0 ? "Today" : offset === 1 ? "Yesterday" : dayDate(offset).toLocaleDateString([], { weekday: "long" });

/** A day's segments; today's are re-read every few seconds (the overlay keeps writing them). */
function useSegments(offset: number) {
  const [segs, setSegs] = useState<Segment[]>(() => loadDay(dayDate(offset)));
  useEffect(() => {
    const read = () => setSegs(loadDay(dayDate(offset)));
    read();
    if (offset !== 0) return;
    const t = window.setInterval(read, 3000);
    window.addEventListener("focus", read);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", read);
    };
  }, [offset]);
  return segs;
}

// --- Tooltip (one, shared) -------------------------------------------------------------
type TipRow = { color?: string; label: string; value: string };
type Tip = { x: number; y: number; title: string; rows: TipRow[] } | null;
let setTipGlobal: (t: Tip) => void = () => {};
const tip = {
  show(e: { clientX: number; clientY: number }, title: string, rows: TipRow[]) {
    setTipGlobal({ x: e.clientX, y: e.clientY, title, rows });
  },
  hide() {
    setTipGlobal(null);
  },
};
function Tooltip() {
  const [t, setT] = useState<Tip>(null);
  setTipGlobal = setT;
  if (!t) return null;
  return (
    <div className="tip" style={{ left: Math.min(t.x + 14, window.innerWidth - 270), top: t.y + 16 }} role="tooltip">
      <div className="tip-title">{t.title}</div>
      {t.rows.map((r) => (
        <div className="tip-row" key={r.label}>
          {r.color && <i style={{ background: r.color }} />}
          <b>{r.value}</b>
          <span>{r.label}</span>
        </div>
      ))}
    </div>
  );
}

// --- Shell -----------------------------------------------------------------------------
export default function Dashboard() {
  const [page, setPage] = useState<Page>("today");
  // Bond can open the dashboard on a page ("time for your journal").
  useEffect(() => {
    const un = onTauriEvent<Page>("dashboard-page", (p) => PAGES.some((n) => n.id === p) && setPage(p));
    return () => void un.then((u) => u());
  }, []);
  // The sidebar folds down to icons; the choice is remembered.
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem("selfglance.sidebar") === "collapsed";
    } catch {
      return false;
    }
  });
  const toggleSide = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem("selfglance.sidebar", c ? "open" : "collapsed");
      } catch {
        /* not remembered */
      }
      return !c;
    });
  const [offset, setOffset] = useState(0);
  const mainRef = useRef<HTMLElement>(null);
  const viewed = useSegments(offset);
  const stats = useMemo(() => analyzeDay(viewed), [viewed]);
  const prev = useMemo(() => {
    const p = loadDay(dayDate(offset + 1));
    return p.length ? analyzeDay(p) : null;
  }, [offset]);

  const dayPicker = (
    <div className="stepper" role="group" aria-label="Day">
      <button onClick={() => setOffset((o) => o + 1)} aria-label="Previous day">
        ‹
      </button>
      <span>{dayName(offset)}</span>
      <button onClick={() => setOffset((o) => Math.max(0, o - 1))} disabled={offset === 0} aria-label="Next day">
        ›
      </button>
    </div>
  );

  useEffect(() => {
    applyTheme(loadSettings().theme);
  }, []);
  const open = (p: Page) => {
    setPage(p);
    mainRef.current?.scrollTo({ top: 0 });
  };

  return (
    <div className={`app${collapsed ? " collapsed" : ""}`}>
      <aside className="side">
        <div className="brand">
          <span className="logo" aria-hidden />
          <span className="brand-name">SelfGlance</span>
          <button className="side-toggle" onClick={toggleSide} aria-label={collapsed ? "Expand the sidebar" : "Collapse the sidebar"} aria-expanded={!collapsed} title={collapsed ? "Expand the sidebar" : "Collapse the sidebar"}>
            <svg viewBox="0 0 24 24" aria-hidden>
              <path d={collapsed ? "M9 6l6 6-6 6" : "M15 6l-6 6 6 6"} />
            </svg>
          </button>
        </div>
        <nav aria-label="Main">
          {NAV_GROUPS.map((g) => (
            <div className="nav-group" key={g.id}>
              <span className="nav-label">{g.name}</span>
              {PAGES.filter((p) => p.group === g.id).map((p) => (
                <button key={p.id} className={page === p.id ? "on" : ""} onClick={() => open(p.id)} aria-current={page === p.id ? "page" : undefined} title={p.name}>
                  <svg viewBox="0 0 24 24" aria-hidden>
                    {p.icon}
                  </svg>
                  <span className="nav-text">{p.name}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="side-bottom">
          <ThemeButton />
        </div>
      </aside>

      <main ref={mainRef} key={page} className="page">
        {page === "today" && <Today stats={stats} segs={viewed} prev={prev} offset={offset} picker={dayPicker} go={open} />}
        {page === "activity" && <Activity stats={stats} offset={offset} picker={dayPicker} />}
        {page === "goals" && <Goals />}
        {page === "chats" && <Chats />}
        {page === "ideas" && <Ideas />}
        {page === "settings" && <SettingsPage />}
      </main>
      <Tooltip />
      <Toasts />
    </div>
  );
}

/** One click between light and dark. It follows Windows until you first click it. */
function ThemeButton() {
  const [theme, setTheme] = useState(() => loadSettings().theme);
  const [os, setOs] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const read = () => {
      setOs(mq.matches);
      setTheme(loadSettings().theme);
    };
    mq.addEventListener("change", read);
    window.addEventListener("focus", read);
    return () => {
      mq.removeEventListener("change", read);
      window.removeEventListener("focus", read);
    };
  }, []);
  const dark = theme === "dark" || (theme === "system" && os);
  const flip = () => {
    const next: Settings["theme"] = dark ? "light" : "dark";
    setTheme(next);
    applyTheme(next);
    void saveSettings({ ...loadSettings(), theme: next });
  };
  return (
    <button className="themebtn" onClick={flip} aria-label={dark ? "Switch to light theme" : "Switch to dark theme"} title={dark ? "Switch to light theme" : "Switch to dark theme"}>
      <svg viewBox="0 0 24 24" aria-hidden>
        {dark ? <path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" /> : <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />}
      </svg>
      <span className="theme-text">{dark ? "Light theme" : "Dark theme"}</span>
    </button>
  );
}

function PageHead(props: { title: string; sub?: string; right?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <h1>{props.title}</h1>
        {props.sub && <p className="muted">{props.sub}</p>}
      </div>
      {props.right}
    </header>
  );
}

function Section(props: { title: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`section ${props.className ?? ""}`}>
      <div className="section-head">
        <h2>{props.title}</h2>
        {props.right}
      </div>
      {props.children}
    </section>
  );
}

// --- Today -----------------------------------------------------------------------------
function Today({ stats, segs, prev, offset, picker, go }: { stats: DayStats; segs: Segment[]; prev: DayStats | null; offset: number; picker: ReactNode; go: (p: Page) => void }) {
  const goal = loadSettings().waterGoal;
  const notes = insights(stats, prev).slice(0, 3);
  const sub = dayDate(offset).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
  if (stats.total === 0) {
    return (
      <>
        <PageHead title={dayName(offset)} sub={sub} right={picker} />
        <div className="bento">
          <GoalTile segs={segs} date={dayDate(offset)} today={offset === 0} open={() => go("goals")} />
        </div>
        <Empty />
      </>
    );
  }
  const present = CATS.filter((c) => stats.byCat[c.id] > 0);
  const glasses = glassesToday();
  const cups = Math.min(Math.max(goal, 1), 15);
  return (
    <>
      <PageHead title={dayName(offset)} sub={sub} right={picker} />

      <div className="bento">
        <section className="tile t-overview">
          <h2 className="tile-label">On the laptop</h2>
          <div className="hero-figure">
            <span className="big">{fmt(stats.total)}</span>
            <span className="muted">
              {clock(stats.first!)} – {clock(stats.last!)}
            </span>
          </div>
          <div className="catbar" role="img" aria-label="Where the time went">
            {present.map((c) => (
              <i
                key={c.id}
                style={{ flexGrow: stats.byCat[c.id], background: catVar(c.id) }}
                onPointerMove={(e) => tip.show(e, c.name, [{ color: catVar(c.id), label: `${Math.round((stats.byCat[c.id] / stats.total) * 100)}% of the day`, value: fmt(stats.byCat[c.id]) }])}
                onPointerLeave={tip.hide}
              />
            ))}
          </div>
          <ul className="catlegend">
            {present.map((c) => (
              <li key={c.id}>
                <i style={{ background: catVar(c.id) }} />
                {c.name} <b>{fmt(stats.byCat[c.id])}</b>
              </li>
            ))}
          </ul>
        </section>

        <section className="tile t-water">
          <h2 className="tile-label">Hydration</h2>
          {offset === 0 ? (
            <>
              <div className="cups" role="img" aria-label={`${glasses} of ${goal} glasses of water`}>
                {Array.from({ length: cups }, (_, n) => (
                  <i key={n} className={n < glasses ? "full" : ""} />
                ))}
              </div>
              <p className="tile-value">
                <b>{glasses}</b> / {goal} <small>glasses</small>
              </p>
            </>
          ) : (
            <p className="muted">Water is only counted for today.</p>
          )}
        </section>

        <section className="tile tone-blue">
          <h2 className="tile-label">Productive</h2>
          <span className="tile-num">{fmt(stats.productive)}</span>
          <span className="stat-delta">
            <Delta now={stats.productive} before={prev?.productive} goodWhenUp />
          </span>
        </section>
        <section className="tile tone-orange">
          <h2 className="tile-label">Entertainment</h2>
          <span className="tile-num">{fmt(stats.distracting)}</span>
          <span className="stat-delta">
            <Delta now={stats.distracting} before={prev?.distracting} goodWhenUp={false} />
          </span>
        </section>
        <section className="tile tone-green">
          <h2 className="tile-label">Longest focus</h2>
          <span className="tile-num">{stats.longestFocus ? fmt(stats.longestFocus.ms) : "–"}</span>
          <span className="stat-delta muted">{stats.longestFocus ? `from ${clock(stats.longestFocus.start)}` : "no focus stretch yet"}</span>
        </section>

        <GoalTile segs={segs} date={dayDate(offset)} today={offset === 0} open={() => go("goals")} />

        <Section title="Your day" className="t-wide">
          <DayStrip stats={stats} />
        </Section>

        <Section
          title="Top of the day"
          className="t-top"
          right={
            <button className="linkish" onClick={() => go("activity")}>
              All activity →
            </button>
          }
        >
          <TopItems items={stats.items.slice(0, 6)} />
        </Section>
        <Section title="Worth knowing" className="t-notes">
          {notes.length ? (
            <ul className="notes">
              {notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          ) : (
            <p className="muted">A few observations appear once there's more of the day to look at.</p>
          )}
        </Section>

        <BondTile full={offset !== 0} go={go} />
      </div>

      <DaySummary stats={stats} />
    </>
  );
}

/** Bond, as a tile: whether he's listening, which brain answers, and a way to ask him now. */
function BondTile({ full, go }: { full: boolean; go: (p: Page) => void }) {
  const [s, setS] = useState(() => effective(loadSettings()));
  useEffect(() => {
    const read = () => setS(effective(loadSettings()));
    window.addEventListener("focus", read);
    const t = window.setInterval(read, 4000);
    return () => {
      window.removeEventListener("focus", read);
      clearInterval(t);
    };
  }, []);
  const brain = "Brain on this laptop";
  return (
    <section className={`tile t-bond ${full ? "full" : ""}`}>
      <div className="bond-head">
        <svg viewBox="0 0 24 24" aria-hidden>
          <rect x="4" y="6" width="16" height="13" rx="4" />
          <circle cx="9.2" cy="12.2" r="1.3" />
          <circle cx="14.8" cy="12.2" r="1.3" />
          <path d="M12 6V3.5M10.5 16.2h3" />
        </svg>
        <div>
          <h2 className="tile-label">Bond</h2>
          <b className="bond-state">
            <i className={s.wakeWord ? "live" : ""} aria-hidden />
            {s.wakeWord ? "Listening for “Hey Bond”" : "“Hey Bond” is off"}
          </b>
          <small>{brain}</small>
        </div>
      </div>
      <p className="muted small">Try: “goal: finish the micrograd tutorial” or “idea: an app that sorts my downloads”.</p>
      <div className="tile-actions">
        <button className="btn" onClick={() => void invoke("ask_bond").catch(() => {})} disabled={!inTauri} title={inTauri ? "Open Bond's ask box" : "Only in the desktop app"}>
          Ask Bond
        </button>
        <button className="btn ghost" onClick={() => go("settings")}>
          Bond settings
        </button>
      </div>
    </section>
  );
}

function Delta({ now, before, goodWhenUp, vs = "yesterday", neutral }: { now: number; before: number | null | undefined; goodWhenUp: boolean; vs?: string; neutral?: boolean }) {
  if (before === null || before === undefined) return <span className="muted">no data {vs}</span>;
  const diff = now - before;
  if (Math.abs(diff) < 60_000) return <span className="muted">same as {vs}</span>;
  const up = diff > 0;
  return (
    <span className={neutral ? "muted" : up === goodWhenUp ? "good" : "bad"}>
      {up ? "▲" : "▼"} {fmt(Math.abs(diff))} <span className="muted">vs {vs}</span>
    </span>
  );
}

function Empty() {
  return (
    <section className="empty">
      <h2>Nothing recorded for this day</h2>
      <p className="muted">Keep Bond running: he notes what's in front of you (the app, the video, the project, the site) while you use the laptop.</p>
    </section>
  );
}

/** The day as one strip: each stretch drawn where it happened, colored by category. */
function DayStrip({ stats }: { stats: DayStats }) {
  const s = new Date(stats.first!);
  s.setMinutes(0, 0, 0);
  const e = new Date(stats.last!);
  e.setHours(e.getHours() + 1, 0, 0, 0);
  const t0 = s.getTime();
  const span = e.getTime() - t0;
  const every = span > 8 * 3_600_000 ? 2 : 1;
  const hours: number[] = [];
  for (let t = t0, i = 0; t <= t0 + span; t += 3_600_000, i++) if (i % every === 0) hours.push(t);
  return (
    <div className="strip">
      <div className="strip-track" role="img" aria-label="Timeline of the day">
        {stats.sessions.map((x, i) => (
          <i
            key={i}
            style={{ left: `${((x.start - t0) / span) * 100}%`, width: `max(2px, ${((x.end - x.start) / span) * 100}%)`, background: catVar(x.cat) }}
            onPointerMove={(ev) =>
              tip.show(ev, x.label, [
                { color: catVar(x.cat), label: `${clock(x.start)} – ${clock(x.end)}`, value: fmt(x.ms) },
                { label: x.app, value: x.kind },
              ])
            }
            onPointerLeave={tip.hide}
          />
        ))}
      </div>
      <div className="strip-hours">
        {hours.map((h) => (
          <span key={h} style={{ left: `${((h - t0) / span) * 100}%` }}>
            {new Date(h).toLocaleTimeString([], { hour: "numeric" })}
          </span>
        ))}
      </div>
    </div>
  );
}

function TopItems({ items }: { items: Item[] }) {
  if (!items.length) return <p className="muted">Nothing yet.</p>;
  const max = items[0].ms;
  return (
    <ol className="toplist">
      {items.map((it) => (
        <li key={it.key}>
          <span className="tl-name" title={`${it.label} — ${it.app}`}>
            <Avatar label={it.label} color={catVar(it.cat)} size={24} />
            <span>{it.label}</span>
          </span>
          <KindBadge kind={it.kind} />
          <span className="tl-val">{fmt(it.ms)}</span>
          <span className="tl-bar">
            <i style={{ width: `${(it.ms / max) * 100}%`, background: catVar(it.cat) }} />
          </span>
        </li>
      ))}
    </ol>
  );
}

/** "Your day in words": an honest written summary generated from the analysis. */
function DaySummary({ stats }: { stats: DayStats }) {
  const day = stats.first ? new Date(stats.first).toDateString() : "";
  const cacheKey = `selfglance.summary.${day}`;
  const [text, setText] = useState<string | null>(() => {
    try {
      return localStorage.getItem(cacheKey);
    } catch {
      return null;
    }
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const write = async () => {
    setBusy(true);
    setErr(null);
    const digest = {
      date: day,
      active: `${clock(stats.first!)} – ${clock(stats.last!)}`,
      screenTime: fmt(stats.total),
      byCategory: Object.fromEntries(CATS.map((c) => [c.name, fmt(stats.byCat[c.id])])),
      focusScore: stats.focusScore,
      longestFocus: stats.longestFocus
        ? { minutes: Math.round(stats.longestFocus.ms / 60000), from: clock(stats.longestFocus.start), on: stats.longestFocus.label }
        : null,
      switchesPerHour: stats.switchesPerHour,
      topItems: stats.items.slice(0, 15).map((i) => ({ what: i.label, type: i.kind, category: catName(i.cat), time: fmt(i.ms), sessions: i.sessions })),
    };
    try {
      const out = await aiText(
        "You are Bond, a warm but honest desktop companion. You write the user's end-of-day summary from their activity data. " +
          "Be specific (name the projects, videos and sites), never invent anything that isn't in the data, and keep it under 170 words. " +
          "Use exactly these four short sections, each a heading line followed by 1-3 sentences: " +
          "What you built / What you watched & learned / Where focus broke / One thing for tomorrow. Plain text, no markdown symbols.",
        JSON.stringify(digest),
      );
      setText(out);
      try {
        localStorage.setItem(cacheKey, out);
      } catch {
        /* not cached */
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="Your day in words"
      className="words"
      right={
        <button className="btn" onClick={write} disabled={busy}>
          {busy ? "Writing…" : text ? "Rewrite" : "Write it"}
        </button>
      }
    >
      {err && <p className="error">{err}</p>}
      {text ? (
        <div className="words-text">
          {text.split(/\n+/).map((line, i) =>
            /^(What you built|What you watched|Where focus broke|One thing for tomorrow)/i.test(line.trim()) ? <h3 key={i}>{line.trim()}</h3> : <p key={i}>{line}</p>,
          )}
        </div>
      ) : (
        !err && <p className="muted">Bond reads the day and writes an honest summary: what you built, what you watched, where focus broke, one thing for tomorrow.</p>
      )}
    </Section>
  );
}

// --- Activity --------------------------------------------------------------------------
type ActTab = "all" | Kind | "sessions";
const ACT_TABS: { id: ActTab; name: string }[] = [
  { id: "all", name: "Everything" },
  { id: "Project", name: "Projects" },
  { id: "Video", name: "Videos" },
  { id: "Site", name: "Sites" },
  { id: "App", name: "Apps" },
  { id: "sessions", name: "Sessions" },
];

type SortKey = "time" | "name" | "category" | "recent" | "sessions";

function Activity({ stats, offset, picker }: { stats: DayStats; offset: number; picker: ReactNode }) {
  const [tab, setTab] = useState<ActTab>("all");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "time", dir: -1 });
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPicked(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const match = (s: string) => s.toLowerCase().includes(q.toLowerCase());
  const head = <PageHead title="Activity" sub={`${dayName(offset)} · everything you spent time on`} right={picker} />;
  if (stats.total === 0)
    return (
      <>
        {head}
        <Empty />
      </>
    );

  const by: Record<SortKey, (a: Item, b: Item) => number> = {
    time: (a, b) => a.ms - b.ms,
    name: (a, b) => a.label.localeCompare(b.label),
    category: (a, b) => catName(a.cat).localeCompare(catName(b.cat)),
    recent: (a, b) => a.last - b.last,
    sessions: (a, b) => a.sessions - b.sessions,
  };
  const items = stats.items
    .filter((i) => (tab === "all" || i.kind === tab) && match(`${i.label} ${i.app} ${i.kind}`))
    .sort((a, b) => by[sort.key](a, b) * sort.dir);
  const max = items.reduce((m, i) => Math.max(m, i.ms), 1);
  const sessions = stats.sessions.filter((x) => x.ms >= 30_000 && match(`${x.label} ${x.app}`)).slice().reverse();
  const sel = tab !== "sessions" ? items.find((i) => i.key === picked) ?? null : null;
  const twin = sel ? stats.items.find((i) => i.label === sel.label && i.kind !== sel.kind) : undefined;

  const th = (key: SortKey, label: string, cls = "", tipText?: string) => (
    <th className={cls} aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"} title={tipText}>
      <button className="th-sort" onClick={() => setSort((p) => (p.key === key ? { key, dir: (-p.dir) as 1 | -1 } : { key, dir: key === "name" || key === "category" ? 1 : -1 }))}>
        {label}
        <span className="arrow" aria-hidden>
          {sort.key === key ? (sort.dir === 1 ? "↑" : "↓") : ""}
        </span>
      </button>
    </th>
  );

  return (
    <>
      {head}
      <div className="toolbar">
        <div className="tabs" role="tablist">
          {ACT_TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "on" : ""} onClick={() => setTab(t.id)}>
              {t.name}
            </button>
          ))}
        </div>
        <input className="search" placeholder="Search apps, sites, projects…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search activity" />
      </div>

      {tab !== "sessions" ? (
        <div className={`explorer ${sel ? "with-detail" : ""}`}>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  {th("name", "What")}
                  {th("category", "Category")}
                  {th("time", "Time", "num")}
                  <th className="share">Share of day</th>
                  {th("sessions", "Sessions", "num", "A session is a stretch on the same thing without a 2-minute gap")}
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr
                    key={i.key}
                    className={`pickable ${sel?.key === i.key ? "picked" : ""}`}
                    tabIndex={0}
                    onClick={() => setPicked(sel?.key === i.key ? null : i.key)}
                    onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setPicked(sel?.key === i.key ? null : i.key))}
                    aria-selected={sel?.key === i.key}
                  >
                    <td className="what">
                      <div className="what-row">
                        <Avatar label={i.label} color={catVar(i.cat)} />
                        <div className="what-text">
                          <span title={i.label}>{i.label}</span>
                          <small className="muted">
                            <KindBadge kind={i.kind} /> {i.app} · {clock(i.first)}–{clock(i.last)}
                          </small>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className="catcell">
                        <i style={{ background: catVar(i.cat) }} />
                        {catName(i.cat)}
                      </span>
                    </td>
                    <td className="num strong">{fmt(i.ms)}</td>
                    <td className="share">
                      <div className="share-in">
                        <span className="sharebar">
                          <i style={{ width: `${(i.ms / max) * 100}%`, background: catVar(i.cat) }} />
                        </span>
                        <span className="muted">{Math.round((i.ms / stats.total) * 100)}%</span>
                      </div>
                    </td>
                    <td className="num">{i.sessions}</td>
                  </tr>
                ))}
                {items.length === 0 && (
                  <tr>
                    <td colSpan={5} className="muted empty-row">
                      Nothing matches{q ? ` “${q}”` : ""}. Try another tab or clear the search.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {sel && (
            <aside className="detail" aria-label={`Details for ${sel.label}`}>
              <div className="detail-head">
                <Avatar label={sel.label} color={catVar(sel.cat)} size={36} />
                <div>
                  <h3 title={sel.label}>{sel.label}</h3>
                  <div className="detail-sub">
                    <KindBadge kind={sel.kind} /> <span className="muted">{sel.app}</span>
                  </div>
                </div>
                <button className="icon-btn" onClick={() => setPicked(null)} aria-label="Close details" title="Close (Esc)">
                  <svg viewBox="0 0 24 24" aria-hidden>
                    <path d="M6 6l12 12M18 6 6 18" />
                  </svg>
                </button>
              </div>
              <dl className="detail-stats">
                <div>
                  <dt>Time</dt>
                  <dd>{fmt(sel.ms)}</dd>
                </div>
                <div>
                  <dt>Share of day</dt>
                  <dd>{Math.round((sel.ms / stats.total) * 100)}%</dd>
                </div>
                <div>
                  <dt>Sessions</dt>
                  <dd>{sel.sessions}</dd>
                </div>
                <div>
                  <dt>Category</dt>
                  <dd>
                    <span className="catcell">
                      <i style={{ background: catVar(sel.cat) }} />
                      {catName(sel.cat)}
                    </span>
                  </dd>
                </div>
              </dl>
              {twin && (
                <p className="detail-note">
                  “{sel.label}” also shows up as a <b>{twin.kind}</b> ({twin.app}, {fmt(twin.ms)}). The {sel.kind.toLowerCase()} and the {twin.kind.toLowerCase()} are tracked separately.
                </p>
              )}
              <h4>Sessions</h4>
              <ul className="detail-sessions">
                {stats.sessions
                  .filter((x) => x.kind === sel.kind && x.label === sel.label)
                  .slice(0, 60)
                  .map((x, k) => (
                    <li key={k}>
                      <span>
                        {clock(x.start)} – {clock(x.end)}
                      </span>
                      <b>{fmt(x.ms)}</b>
                    </li>
                  ))}
              </ul>
            </aside>
          )}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th className="num">Length</th>
                <th>What</th>
                <th>Category</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((x, i) => (
                <tr key={i}>
                  <td className="muted nowrap">
                    {clock(x.start)} – {clock(x.end)}
                  </td>
                  <td className="num strong">{fmt(x.ms)}</td>
                  <td className="what">
                    <div className="what-row">
                      <Avatar label={x.label} color={catVar(x.cat)} />
                      <div className="what-text">
                        <span title={x.label}>{x.label}</span>
                        <small className="muted">
                          <KindBadge kind={x.kind} /> {x.app}
                        </small>
                      </div>
                    </div>
                  </td>
                  <td>
                    <span className="catcell">
                      <i style={{ background: catVar(x.cat) }} />
                      {catName(x.cat)}
                    </span>
                  </td>
                </tr>
              ))}
              {sessions.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted empty-row">
                    No sessions of 30 seconds or more{q ? ` match “${q}”` : ""}.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// --- Settings --------------------------------------------------------------------------
const SECTIONS = [
  { id: "wellness", name: "Wellness", hint: "Water breaks" },
  { id: "assistant", name: "Bond", hint: "How he behaves" },
  { id: "ai", name: "Bond's brain", hint: "Runs on this laptop" },
  { id: "voice", name: "Voice", hint: "Speaking and “Hey Bond”" },
  { id: "suggest", name: "Suggestions", hint: "When he speaks up" },
  { id: "learning", name: "Learning & memory", hint: "What he keeps" },
  { id: "privacy", name: "Privacy", hint: "What's stored, what's sent" },
] as const;
type SecId = (typeof SECTIONS)[number]["id"];

function SettingsPage() {
  const [s, setS] = useState<Settings>(loadSettings);
  const [saved, setSaved] = useState(false);
  const [sec, setSec] = useState<SecId>("wellness");
  useEffect(() => {
    if (!s.labs && (sec === "suggest" || sec === "learning")) setSec("wellness");
  }, [s.labs, sec]);
  const update = (patch: Partial<Settings>) => {
    const next = { ...s, ...patch };
    setS(next);
    void saveSettings(next).then(() => {
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1200);
    });
  };
  return (
    <>
      <PageHead title="Settings" sub="Everything Bond does, and where it runs" right={<span className={`saved ${saved ? "on" : ""}`}>✓ Saved</span>} />

      <div className="settings">
        <div className="subnav" role="tablist" aria-label="Settings sections">
          {SECTIONS.filter((x) => s.labs || (x.id !== "suggest" && x.id !== "learning")).map((x) => (
            <button key={x.id} role="tab" aria-selected={sec === x.id} className={sec === x.id ? "on" : ""} onClick={() => setSec(x.id)}>
              {x.name}
              <small>{x.hint}</small>
            </button>
          ))}
        </div>
        <div className="settings-body">
        {sec === "wellness" && (
          <Group title="Water breaks" desc="Bond brings water after a stretch of active laptop use. Stepping away on your own counts as a break.">
        <Toggle label="Bring me water breaks" checked={s.breaksOn} onChange={(v) => update({ breaksOn: v })} />
        <Slider label="Break every" unit="min of use" min={10} max={120} step={5} value={s.breakEveryMin} disabled={!s.breaksOn} onChange={(v) => update({ breakEveryMin: v })} />
        <Slider label="“Later” waits" unit="min" min={5} max={30} step={5} value={s.snoozeMin} disabled={!s.breaksOn} onChange={(v) => update({ snoozeMin: v })} />
        <Slider label="Daily water goal" unit="glasses" min={4} max={15} step={1} value={s.waterGoal} onChange={(v) => update({ waterGoal: v })} />
      </Group>
        )}
        {sec === "assistant" && (
          <Group title="Bond" desc="How he behaves around you.">
        {s.labs && (
        <Toggle
          label="Nudge me when I'm brainstorming too long"
          hint="About 20 minutes with ChatGPT, Claude or notes and no editor time → “Time to build!”"
          checked={s.brainstormAlert}
          onChange={(v) => update({ brainstormAlert: v })}
        />
        )}
        <Toggle label="Guide mode: show what he picked" hint="Outlines every control he could point at and says which one he chose and why. For finding out why he pointed wrong." checked={s.guideDebug} onChange={(v) => update({ guideDebug: v })} />
        <Toggle
          label="Advanced actions"
          hint="Lets the AI run commands, end programs, type, click and copy for you. Off: Bond points the way (guide mode) and only does the safe things; running a command, ending a program or deleting always asks you first either way."
          checked={s.advancedActions}
          onChange={(v) => update({ advancedActions: v })}
        />
        <Toggle
          label="Labs: experimental features"
          hint="“Hey Bond”, suggestions he makes on his own, learning from you, and the brainstorm nudge. Unfinished, so they are off until you switch this on."
          checked={s.labs}
          onChange={(v) => update({ labs: v })}
        />
        <Toggle
          label="Keep Bond out of screenshots and recordings"
          hint="You still see him; Snipping Tool, Print Screen and screen recorders don't. For a picture with him in it, say “include yourself in the screenshot” or use his tray menu: he appears for 5 minutes."
          checked={s.hideFromCaptures}
          onChange={(v) => update({ hideFromCaptures: v })}
        />
        <Toggle label="Read his answers aloud" checked={s.speakAnswers} onChange={(v) => update({ speakAnswers: v })} />
        <Toggle label="Warn me when the battery is low" hint="At 15% and again at 7%, while unplugged." checked={s.batteryAlert} onChange={(v) => update({ batteryAlert: v })} />
        <Slider label="Answers close after" unit="seconds" min={4} max={60} step={2} value={s.answerSeconds} onChange={(v) => update({ answerSeconds: v })} />
        <Autostart />
      </Group>
        )}
        {sec === "ai" && (
          <Group
        title="Bond's brain"
        desc="What powers “Ask Bond”, the screen, guide mode and “Your day in words”. It runs on this laptop: nothing you ask or show him leaves your computer, and there is no account or key to set up."
      >
        <LocalBrain />
      </Group>
        )}
        {sec === "voice" && (
          <div className={`mic-banner ${s.labs && s.wakeWord ? "live" : ""}`} role="status">
            <i aria-hidden />
            {s.labs && s.wakeWord
              ? "The microphone is open right now, listening for “Hey Bond”. What isn't for him is dropped as it's heard; nothing is recorded or sent."
              : "The microphone is closed. It opens only while you hold Ctrl+Alt+V and talk."}
          </div>
        )}
        {sec === "voice" && (
          <Group
        title="Voice"
        desc="Bond's own voice and ears run on this laptop: hold Ctrl+Alt+V and talk to him (or click the mic in the Ask box), and he answers out loud. The microphone is only open while you talk."
      >
        <div className="tabs" role="radiogroup" aria-label="Voice">
          {(
            [
              ["bond", "Bond's own · private"],
              ["system", "Windows voice (installed on this laptop)"],
            ] as const
          ).map(([v, label]) => (
            <button key={v} className={s.voice === v ? "on" : ""} onClick={() => update({ voice: v })}>
              {label}
            </button>
          ))}
        </div>
        <LocalVoice voiceId={s.voiceId} speed={s.voiceSpeed} onChange={update} />
      </Group>
        )}
        {sec === "voice" && s.labs && (
          <Group
        title="“Hey Bond”"
        desc="Talk to him without a hotkey, like Siri. His ears, on this laptop, listen for “Hey Bond”; what isn't for him is dropped as soon as it's heard, and nothing is recorded or sent anywhere. With voice match he answers only you, not other people, videos or calls."
      >
        <HeyBond s={s} onChange={update} />
      </Group>
        )}
        {sec === "suggest" && (
          <Group
        title="Suggestions"
        desc="Bond speaks up on his own at a natural pause: things you usually do in an app, a tip when you copy an error or keep searching while working. Tips come from the brain on this laptop only — nothing is sent anywhere. 👎 on a suggestion stops it."
      >
        <div className="tabs" role="radiogroup" aria-label="How often">
          {(
            [
              ["off", "Off"],
              ["stuck", "Only when I'm stuck"],
              ["helpful", "Helpful"],
              ["chatty", "Chatty"],
            ] as const
          ).map(([v, label]) => (
            <button key={v} className={s.notice === v ? "on" : ""} onClick={() => update({ notice: v })}>
              {label}
            </button>
          ))}
        </div>
        <Slider label="At most" unit="an hour" min={1} max={6} step={1} value={s.noticeMaxPerHour} disabled={s.notice === "off"} onChange={(v) => update({ noticeMaxPerHour: v })} />
        <Toggle
          label="Let him look at my screen when I seem stuck"
          hint="Read on this laptop and not kept. Never password managers, banking or private windows."
          checked={s.noticeLook}
          onChange={(v) => update({ noticeLook: v })}
        />
        <Toggle label="Quiet hours" checked={s.quietOn} onChange={(v) => update({ quietOn: v })} />
        <Slider label="Quiet from" unit=":00" min={0} max={23} step={1} value={s.quietFrom} disabled={!s.quietOn} onChange={(v) => update({ quietFrom: v })} />
        <Slider label="Until" unit=":00" min={0} max={23} step={1} value={s.quietTo} disabled={!s.quietOn} onChange={(v) => update({ quietTo: v })} />
        <label className="slider">
          <span className="s-label">Never in</span>
          <input className="search" placeholder="e.g. slack, payroll, figma" value={s.noticeBlock} onChange={(e) => update({ noticeBlock: e.target.value })} />
          <span className="s-value muted">apps or window titles, comma-separated</span>
        </label>
      </Group>
        )}
        {sec === "learning" && (
          <Group
        title="Learning"
        desc="Bond keeps what you ask, what he did and your 👍 / 👎, and reuses what worked for similar requests. It stays on this computer, and can later train his own brain on your habits."
      >
        <Toggle label="Learn from me" checked={s.learnFromMe} onChange={(v) => update({ learnFromMe: v })} />
        <Learned />
      </Group>
        )}
        {sec === "learning" && (
          <Group
        title="What Bond remembers about you"
        desc="Things you've told him about yourself (“call me Alex”), used in every conversation. He also keeps the last few minutes of what you talked about, so “close it” or “yes, run it” make sense. All on this computer."
      >
        <Memories />
      </Group>
        )}
        {sec === "privacy" && <PrivacyPanel s={s} go={setSec} />}
        </div>
      </div>
    </>
  );
}

/** What is stored where, and what leaves this computer, from your real settings (read-only). */
function PrivacyPanel({ s: saved, go }: { s: Settings; go: (id: SecId) => void }) {
  const s = effective(saved);
  const rows: { title: string; state: string; calm: boolean; text: string; to: SecId }[] = [
    {
      title: "Where answers come from",
      state: "Stays on this laptop",
      calm: true,
      text: "What you ask Bond and show him is read by the brain on this laptop. There are no cloud services and no API keys. Nothing leaves it.",
      to: "ai",
    },
    {
      title: "Microphone",
      state: s.wakeWord ? "Open: listening for “Hey Bond”" : "Closed",
      calm: !s.wakeWord,
      text: s.wakeWord ? "What isn't for him is dropped as it's heard. Nothing is recorded or sent." : "It opens only while you hold Ctrl+Alt+V and talk.",
      to: "voice",
    },
    {
      title: "Reading your screen",
      state: s.noticeLook ? "Also when you seem stuck" : "Only when you ask",
      calm: !s.noticeLook,
      text: "Never password managers, banking or private windows. A screen he looks at is read on this laptop and not kept.",
      to: "suggest",
    },
    {
      title: "Learning from you",
      state: s.learnFromMe ? "On" : "Off",
      calm: !s.learnFromMe,
      text: s.learnFromMe ? "He keeps what you ask and what worked, on this computer, so he can adapt." : "Nothing new is kept.",
      to: "learning",
    },
  ];
  return (
    <>
      <section className="group">
        <div className="group-info">
          <h2>Right now</h2>
          <p className="muted">The privacy-relevant switches, as they are set. Click one to change it.</p>
        </div>
        <div className="group-body privacy-rows">
          {rows.map((r) => (
            <button key={r.title} className="privacy-row" onClick={() => go(r.to)}>
              <span className="privacy-text">
                <b>{r.title}</b>
                <small>{r.text}</small>
              </span>
              <em className={r.calm ? "calm" : "heads-up"}>{r.state}</em>
            </button>
          ))}
        </div>
      </section>
      <section className="group">
        <div className="group-info">
          <h2>Where things are kept</h2>
          <p className="muted">All on this computer. The only things Bond downloads are his own brain and voice files, once, and the websites you ask him to open.</p>
        </div>
        <ul className="group-body kept">
          <li>
            <b>Activity, ideas, settings</b> In this app's local storage.
          </li>
          <li>
            <b>Learning log and memories</b> In Bond's data folder; Forget deletes them.
          </li>
          <li>
            <b>Models (brain, voice)</b> In your local app data folder.
          </li>
        </ul>
      </section>
    </>
  );
}

function Group(props: { title: string; desc: string; children: ReactNode }) {
  return (
    <section className="group">
      <div className="group-info">
        <h2>{props.title}</h2>
        <p className="muted">{props.desc}</p>
      </div>
      <div className="group-body">{props.children}</div>
    </section>
  );
}

function Slider(props: { label: string; unit: string; min: number; max: number; step: number; value: number; disabled?: boolean; onChange: (v: number) => void }) {
  return (
    <label className={`slider ${props.disabled ? "off" : ""}`}>
      <span className="s-label">{props.label}</span>
      <input type="range" min={props.min} max={props.max} step={props.step} value={props.value} disabled={props.disabled} onChange={(e) => props.onChange(Number(e.target.value))} />
      <span className="s-value">
        <b>{props.value}</b> {props.unit}
      </span>
    </label>
  );
}

function Autostart() {
  const [on, setOn] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    invoke<boolean>("get_autostart").then(setOn).catch(() => {});
  }, []);
  return (
    <Toggle
      label="Start Bond when I log in"
      checked={on}
      note={note}
      onChange={(v) =>
        invoke<boolean>("set_autostart", { enabled: v })
          .then((r) => {
            setOn(r);
            setNote(null);
          })
          .catch((err) => setNote(String(err)))
      }
    />
  );
}

const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(bytes > 1024 ** 3 ? 1 : 2);

/** Download / status of the brain that runs on this laptop. */
function LocalBrain() {
  const [st, setSt] = useState<BrainStatus | null>(null);
  const [progress, setProgress] = useState<BrainProgress | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const refresh = () => brainStatus().then(setSt).catch(() => setSt(null));
  useEffect(() => {
    void refresh();
    const off = onTauriEvent<BrainProgress>("brain-progress", setProgress);
    return () => void off.then((f) => f());
  }, []);
  const install = async () => {
    setMsg(null);
    setSt((x) => (x ? { ...x, installing: true } : x));
    try {
      await brainInstall();
      setMsg("Ready. Ask Bond anything — it all stays on this laptop.");
    } catch (e) {
      setMsg(`${e} You can try again; the download continues where it stopped.`);
    }
    setProgress(null);
    void refresh();
  };
  if (!st) return null;
  if (!st.supported) return <p className="small muted">Bond's own brain runs on Windows for now.</p>;
  if (st.installed)
    return (
      <p className="small good">
        ✓ {st.model} is on this laptop{st.running ? " and awake" : ""}. It wakes when you ask and sleeps after 10 idle minutes to free your GPU. {msg}
      </p>
    );
  const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  return (
    <>
      <p className="small muted">
        {st.model} — understands commands, reads your screen and answers questions without the internet. A one-time 3.4 GB download; it runs best
        with a graphics card (4 GB+).
      </p>
      {st.installing ? (
        <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="bar" style={{ width: `${pct}%` }} />
          <span className="small">
            {progress ? `${progress.what}: ${gb(progress.done)} / ${gb(progress.total)} GB` : "Starting download…"}
          </span>
        </div>
      ) : (
        <button className="btn" onClick={() => void install()}>
          Download Bond's brain
        </button>
      )}
      {msg && <p className="small muted">{msg}</p>}
    </>
  );
}

/** Kokoro voices that suit English (speaker ids in Kokoro v1.0). */
const VOICES: [number, string][] = [
  [18, "Puck — warm, playful"],
  [16, "Michael — calm"],
  [14, "Fenrir — bold"],
  [17, "Onyx — deep"],
  [11, "Adam — bright"],
  [26, "George — British"],
  [24, "Daniel — British, soft"],
  [3, "Heart — warm"],
  [2, "Bella — lively"],
  [6, "Nicole — soft"],
  [21, "Emma — British"],
];

/** Download / choose Bond's own voice. */
function LocalVoice(props: { voiceId: number; speed: number; onChange: (p: Partial<Settings>) => void }) {
  const [st, setSt] = useState<VoiceStatus | null>(null);
  const [progress, setProgress] = useState<BrainProgress | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const refresh = () => voiceStatus().then(setSt);
  useEffect(() => {
    void refresh();
    const off = onTauriEvent<BrainProgress>("brain-progress", setProgress);
    return () => void off.then((f) => f());
  }, []);
  const install = async () => {
    setMsg(null);
    setSt((x) => (x ? { ...x, installing: true } : x));
    try {
      await voiceInstall();
      setMsg("Ready. Hold Ctrl+Alt+V and say hi.");
    } catch (e) {
      setMsg(`${e} You can try again; the download continues where it stopped.`);
    }
    setProgress(null);
    void refresh();
  };
  if (!st) return null;
  if (!st.installed) {
    const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
    return (
      <>
        <p className="small muted">A natural voice (Kokoro) and speech recognition (Parakeet), both on this laptop. A one-time 830 MB download.</p>
        {st.installing ? (
          <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div className="bar" style={{ width: `${pct}%` }} />
            <span className="small">{progress ? `${progress.what}: ${gb(progress.done)} / ${gb(progress.total)} GB` : "Starting download…"}</span>
          </div>
        ) : (
          <button className="btn" onClick={() => void install()}>
            Download Bond's voice
          </button>
        )}
        {msg && <p className="small muted">{msg}</p>}
      </>
    );
  }
  return (
    <>
      <label className="slider">
        <span className="s-label">His voice</span>
        <select className="search" value={props.voiceId} onChange={(e) => props.onChange({ voiceId: Number(e.target.value) })}>
          {VOICES.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        <button className="btn ghost" onClick={() => void speak("Hi, I'm Bond. Hold Control, Alt and V whenever you want to talk to me.")}>
          ▶ Preview
        </button>
      </label>
      <Slider label="Speed" unit="×" min={0.8} max={1.3} step={0.05} value={props.speed} onChange={(v) => props.onChange({ voiceSpeed: v })} />
      <p className="small good">✓ On this laptop. {msg}</p>
    </>
  );
}

/** "Hey Bond": download, teach him your voice, turn it on. */
function HeyBond(props: { s: Settings; onChange: (p: Partial<Settings>) => void }) {
  const { s, onChange } = props;
  const [st, setSt] = useState<WakeStatus | null>(null);
  const [progress, setProgress] = useState<BrainProgress | null>(null);
  const [installing, setInstalling] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // Teaching: which line you're on, and whether the mic is open.
  const [teach, setTeach] = useState<{ line: number; saved: number; recording: boolean; note: string } | null>(null);
  const refresh = () => wakeStatus().then(setSt);
  useEffect(() => {
    void refresh();
    const off = onTauriEvent<BrainProgress>("brain-progress", setProgress);
    const t = window.setInterval(refresh, 4000); // recent voice checks
    return () => {
      clearInterval(t);
      void off.then((f) => f());
      void wakeEnrollCancel();
    };
  }, []);

  const install = async () => {
    setMsg(null);
    setInstalling(true);
    try {
      await wakeInstall();
    } catch (e) {
      setMsg(`${e}`);
    }
    setInstalling(false);
    setProgress(null);
    void refresh();
  };

  const record = async () => {
    if (!teach || !st) return;
    setTeach({ ...teach, recording: true, note: "Listening… read the line, then stop talking." });
    try {
      const r = await wakeEnrollRecord();
      if (!r.heard) return setTeach({ ...teach, recording: false, note: "I didn't hear “Hey Bond” in that. Try the same line again, a little clearer." });
      const line = teach.line + 1;
      if (line < st.lines.length) return setTeach({ line, saved: r.count, recording: false, note: `Got it (${r.count} of ${r.needed}).` });
      await wakeEnrollSave();
      setTeach(null);
      setMsg("✓ He knows your voice now.");
      onChange({ voiceMatch: true });
      void refresh();
    } catch (e) {
      setTeach({ ...teach, recording: false, note: String(e) });
    }
  };

  if (!st) return <p className="small muted">Only in the desktop app.</p>;
  if (!st.installed) {
    const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
    return (
      <>
        <p className="small muted">The wake word and voice match models, on this laptop. A one-time 57 MB download (needs Bond's voice above).</p>
        {installing ? (
          <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div className="bar" style={{ width: `${pct}%` }} />
            <span className="small">{progress ? `${progress.what}: ${Math.round(progress.done / 1e6)} / ${Math.round(progress.total / 1e6)} MB` : "Starting download…"}</span>
          </div>
        ) : (
          <button className="btn" onClick={() => void install()}>
            Download “Hey Bond”
          </button>
        )}
        {msg && <p className="small muted">{msg}</p>}
      </>
    );
  }

  if (teach) {
    return (
      <div className="teach">
        <p className="small muted">
          Line {teach.line + 1} of {st.lines.length}. Read it in your normal voice, where you usually sit.
        </p>
        <p className="teach-line">“{st.lines[teach.line]}”</p>
        <div className="key-row">
          <button className="btn" disabled={teach.recording} onClick={() => void record()}>
            {teach.recording ? "Listening…" : "🎙 Record this line"}
          </button>
          <button
            className="btn ghost"
            disabled={teach.recording}
            onClick={() => {
              void wakeEnrollCancel();
              setTeach(null);
            }}
          >
            Cancel
          </button>
        </div>
        {teach.note && <p className="small muted">{teach.note}</p>}
      </div>
    );
  }

  const recent = st.recent.slice(-4);
  return (
    <>
      <Toggle
        label="Listen for “Hey Bond”"
        hint="Then say what you want in the same breath, or after a pause. The microphone stays on while this is on."
        checked={s.wakeWord}
        onChange={(v) => onChange({ wakeWord: v })}
      />
      <Toggle
        label="Answer only my voice"
        hint={st.enrolled ? "Voice match is set up." : "Teach him your voice first (below)."}
        checked={s.voiceMatch && st.enrolled}
        onChange={(v) => (st.enrolled ? onChange({ voiceMatch: v }) : undefined)}
      />
      <Toggle label="Keep listening after he answers" hint="A few seconds for a follow-up, without saying “Hey Bond” again (still only your voice)." checked={s.followUp} onChange={(v) => onChange({ followUp: v })} />
      <div className="key-row">
        <button className="btn" onClick={() => setTeach({ line: 0, saved: 0, recording: false, note: "" })}>
          {st.enrolled ? "Teach him my voice again" : "Teach him my voice"}
        </button>
        {st.enrolled && (
          <button
            className="btn ghost"
            onClick={async () => {
              await wakeForgetVoice();
              setMsg("Your voiceprint is deleted.");
              void refresh();
            }}
          >
            Forget my voice
          </button>
        )}
      </div>
      {st.enrolled && recent.length > 0 && st.threshold !== null && (
        <p className="small muted">
          Last checks (bar {st.threshold.toFixed(2)}): {recent.map(([score, ok]) => `${score.toFixed(2)} ${ok ? "✓ you" : "✗ not you"}`).join(" · ")}
        </p>
      )}
      {msg && <p className="small muted">{msg}</p>}
    </>
  );
}

/** The facts Bond keeps about you; forget any or all. */
function Memories() {
  const [facts, setFacts] = useState<string[] | null>(null);
  const refresh = () => void memoryList().then(setFacts);
  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, 5000); // he may learn something while this is open
    return () => clearInterval(t);
  }, []);
  if (!facts) return null;
  if (facts.length === 0) return <p className="small muted">Nothing yet. Tell him something like “call me …” or “I study at …”.</p>;
  return (
    <>
      <ul className="memories">
        {facts.map((f) => (
          <li key={f}>
            <span>{f}</span>
            <button className="btn ghost" onClick={() => void memoryForget(f).then(refresh)} aria-label={`Forget: ${f}`}>
              Forget
            </button>
          </li>
        ))}
      </ul>
      <button className="btn ghost" onClick={() => void memoryForget(null).then(refresh)}>
        Forget everything
      </button>
    </>
  );
}

/** What Bond has learned so far, export for training, forget. */
function Learned() {
  const [stats, setStats] = useState<LearnStats | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const refresh = () => learnStats().then(setStats).catch(() => setStats(null));
  useEffect(() => {
    void refresh();
  }, []);
  if (!stats) return null;
  return (
    <>
      <p className="small muted">
        {stats.total === 0
          ? "Nothing yet — he learns as you use him."
          : `${stats.total} requests remembered · ${stats.good} 👍 · ${stats.bad} 👎 or refused · ${stats.trainable} usable to train his brain.`}
      </p>
      <div className="key-row">
        <button
          className="btn ghost"
          disabled={stats.trainable === 0}
          onClick={() =>
            exportLearned()
              .then((path) => setMsg(`Saved the training set to ${path}`))
              .catch((e) => setMsg(String(e)))
          }
        >
          Export training set
        </button>
        <button
          className="btn ghost"
          disabled={stats.total === 0}
          onClick={() => {
            if (!window.confirm("Forget everything Bond has learned from you?")) return;
            void forgetLearned().then(() => {
              setMsg("Forgotten.");
              void refresh();
            });
          }}
        >
          Forget
        </button>
      </div>
      {msg && <p className="small muted">{msg}</p>}
    </>
  );
}
