// The dashboard, organised around the questions you actually ask:
//   Today     How did today go? One number, one bar, four stats, the day as a strip,
//             top things + a few insights, and the day in words (AI).
//   Activity  What exactly did I spend time on? One searchable list (projects, videos,
//             sites, apps) and the session-by-session log.
//   Week      Am I getting better? Last 7 days side by side.
//   Journal   Type about your whole day and save it. One entry per day; "log …" to Bond adds a line.
//   Ideas     Project ideas you told Bond ("idea: …") or added here.
//   Reminders What you asked Bond to remind you about, soonest first.
//   Settings  Reminders, Bond, AI — grouped, each explained.
// "Now" lives in the sidebar so it's always visible without taking page space.
// Everything is computed locally from the diary the overlay records.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { onTauriEvent } from "../platform";
import {
  aiText,
  brainInstall,
  brainStatus,
  exportLearned,
  forgetLearned,
  hasKey,
  learnStats,
  setKey,
  speak,
  voiceInstall,
  voiceStatus,
  type BrainProgress,
  type VoiceStatus,
  type BrainStatus,
  type LearnStats,
  type Provider,
} from "../ai";
import { analyzeDay, CATS, catName, catOf, clock, durOf, fmt, insights, kindOf, type Cat, type DayStats, type Item, type Kind } from "./analyze";
import { loadDay, type Segment } from "../companion/tracker";
import { glassesToday } from "../break/BreakCoach";
import { loadSettings, saveSettings, type Settings } from "../settings";
import Journal from "./Journal";
import Ideas from "./Ideas";
import Reminders from "./Reminders";
import "./dashboard.css";

type Page = "today" | "activity" | "week" | "journal" | "ideas" | "reminders" | "settings";
const PAGES: { id: Page; name: string; icon: ReactNode }[] = [
  { id: "today", name: "Today", icon: <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z" /> },
  { id: "activity", name: "Activity", icon: <path d="M4 6h16M4 12h10M4 18h13" /> },
  { id: "week", name: "Week", icon: <path d="M5 20V10M10 20V4M15 20v-7M20 20V8" /> },
  { id: "journal", name: "Journal", icon: <path d="M6 3h11a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6zM6 3v18M9.5 8h5M9.5 12h5" /> },
  { id: "ideas", name: "Ideas", icon: <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V16h5v-.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z" /> },
  { id: "reminders", name: "Reminders", icon: <path d="M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM12 9v4l2.5 2M5 3 2 6M19 3l3 3" /> },
  { id: "settings", name: "Settings", icon: <path d="M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19.4 13a7.5 7.5 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-1.7-1L15 3.5h-4l-.4 2.5a7.6 7.6 0 0 0-1.7 1l-2.4-1-2 3.4L6.6 11a7.5 7.5 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 1.7 1l.4 2.5h4l.4-2.5a7.6 7.6 0 0 0 1.7-1l2.4 1 2-3.4z" /> },
];

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
  const [offset, setOffset] = useState(0);
  const today = useSegments(0);
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

  return (
    <div className="app">
      <aside className="side">
        <div className="brand">
          <span className="logo" aria-hidden />
          SelfGlance
        </div>
        <nav>
          {PAGES.map((p) => (
            <button key={p.id} className={page === p.id ? "on" : ""} onClick={() => setPage(p.id)} aria-current={page === p.id ? "page" : undefined}>
              <svg viewBox="0 0 24 24" aria-hidden>
                {p.icon}
              </svg>
              {p.name}
            </button>
          ))}
        </nav>
        <NowMini segs={today} />
      </aside>

      <main>
        {page === "today" && <Today stats={stats} prev={prev} offset={offset} picker={dayPicker} />}
        {page === "activity" && <Activity stats={stats} offset={offset} picker={dayPicker} />}
        {page === "week" && <Week />}
        {page === "journal" && <Journal />}
        {page === "ideas" && <Ideas />}
        {page === "reminders" && <Reminders />}
        {page === "settings" && <SettingsPage />}
      </main>
      <Tooltip />
    </div>
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

// --- Now (sidebar) ---------------------------------------------------------------------
function NowMini({ segs }: { segs: Segment[] }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const last = segs[segs.length - 1];
  if (!last) return <div className="now muted small">Nothing recorded yet today.</div>;
  let spent = durOf(last);
  let start = last.start;
  for (let i = segs.length - 2; i >= 0; i--) {
    const s = segs[i];
    if (s.label !== last.label || start - s.end > 2 * 60_000) break;
    start = s.start;
    spent += durOf(s);
  }
  const live = Date.now() - last.end < 15_000;
  const cat = catOf(last);
  return (
    <div className="now" title={`${last.label} — ${last.app}`}>
      <span className="now-kicker">
        <i className={live ? "live" : ""} style={{ background: catVar(cat) }} />
        {live ? "Now" : `Last · ${fmt(Date.now() - last.end)} ago`}
      </span>
      <span className="now-what">{last.label}</span>
      <span className="now-meta">
        {kindOf(last)} · {catName(cat)} · <b>{fmt(spent)}</b>
      </span>
    </div>
  );
}

// --- Today -----------------------------------------------------------------------------
function Today({ stats, prev, offset, picker }: { stats: DayStats; prev: DayStats | null; offset: number; picker: ReactNode }) {
  const goal = loadSettings().waterGoal;
  const notes = insights(stats, prev).slice(0, 3);
  const sub = dayDate(offset).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
  if (stats.total === 0) {
    return (
      <>
        <PageHead title={dayName(offset)} sub={sub} right={picker} />
        <Empty />
      </>
    );
  }
  const present = CATS.filter((c) => stats.byCat[c.id] > 0);
  return (
    <>
      <PageHead title={dayName(offset)} sub={sub} right={picker} />

      {/* Hero: the one number, where it went, four stats. */}
      <section className="hero">
        <div className="hero-figure">
          <span className="big">{fmt(stats.total)}</span>
          <span className="muted">
            on the laptop · {clock(stats.first!)} – {clock(stats.last!)}
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
        <div className="stats4">
          <Stat label="Productive" value={fmt(stats.productive)} delta={<Delta now={stats.productive} before={prev?.productive} goodWhenUp />} />
          <Stat label="Entertainment" value={fmt(stats.distracting)} delta={<Delta now={stats.distracting} before={prev?.distracting} goodWhenUp={false} />} />
          <Stat
            label="Longest focus"
            value={stats.longestFocus ? fmt(stats.longestFocus.ms) : "–"}
            delta={<span className="muted">{stats.longestFocus ? `from ${clock(stats.longestFocus.start)}` : "no focus stretch yet"}</span>}
          />
          <Stat label="Water" value={offset === 0 ? `${glassesToday()} / ${goal}` : "–"} delta={<span className="muted">glasses</span>} />
        </div>
      </section>

      <Section title="Your day">
        <DayStrip stats={stats} />
      </Section>

      <div className="cols2">
        <Section title="Top of the day">
          <TopItems items={stats.items.slice(0, 6)} />
        </Section>
        <Section title="Worth knowing">
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
      </div>

      <DaySummary stats={stats} />
    </>
  );
}

function Stat(props: { label: string; value: string; delta: ReactNode }) {
  return (
    <div className="stat">
      <span className="stat-label">{props.label}</span>
      <span className="stat-value">{props.value}</span>
      <span className="stat-delta">{props.delta}</span>
    </div>
  );
}

function Delta({ now, before, goodWhenUp }: { now: number; before: number | null | undefined; goodWhenUp: boolean }) {
  if (before === null || before === undefined) return <span className="muted">no data yesterday</span>;
  const diff = now - before;
  if (Math.abs(diff) < 60_000) return <span className="muted">same as yesterday</span>;
  const up = diff > 0;
  return (
    <span className={up === goodWhenUp ? "good" : "bad"}>
      {up ? "▲" : "▼"} {fmt(Math.abs(diff))} <span className="muted">vs yesterday</span>
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
            {it.label}
          </span>
          <span className="pill">{it.kind}</span>
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

function Activity({ stats, offset, picker }: { stats: DayStats; offset: number; picker: ReactNode }) {
  const [tab, setTab] = useState<ActTab>("all");
  const [q, setQ] = useState("");
  const match = (s: string) => s.toLowerCase().includes(q.toLowerCase());
  const head = <PageHead title="Activity" sub={`${dayName(offset)} · everything you spent time on`} right={picker} />;
  if (stats.total === 0)
    return (
      <>
        {head}
        <Empty />
      </>
    );
  const items = stats.items.filter((i) => (tab === "all" || i.kind === tab) && match(`${i.label} ${i.app}`));
  const max = items[0]?.ms ?? 1;
  const sessions = stats.sessions.filter((x) => x.ms >= 30_000 && match(`${x.label} ${x.app}`)).slice().reverse();

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
        <input className="search" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {tab !== "sessions" ? (
        <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>What</th>
              <th>Category</th>
              <th className="num">Time</th>
              <th className="share">Share of day</th>
              <th className="num">Sessions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.key}>
                <td className="what">
                  <span title={i.label}>{i.label}</span>
                  <small className="muted">
                    {i.kind} · {i.app} · {clock(i.first)}–{clock(i.last)}
                  </small>
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
                <td colSpan={5} className="muted">
                  Nothing matches.
                </td>
              </tr>
            )}
          </tbody>
        </table>
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
                  <span title={x.label}>{x.label}</span>
                  <small className="muted">
                    {x.kind} · {x.app}
                  </small>
                </td>
                <td>
                  <span className="catcell">
                    <i style={{ background: catVar(x.cat) }} />
                    {catName(x.cat)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </>
  );
}

// --- Week ------------------------------------------------------------------------------
function Week() {
  const days = useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) => 6 - i).map((off) => ({
        off,
        st: analyzeDay(loadDay(dayDate(off))),
        label: off === 0 ? "Today" : dayDate(off).toLocaleDateString([], { weekday: "short" }),
      })),
    [],
  );
  const total = days.reduce((a, d) => a + d.st.total, 0);
  const productive = days.reduce((a, d) => a + d.st.productive, 0);
  const ent = days.reduce((a, d) => a + d.st.distracting, 0);
  const active = days.filter((d) => d.st.total > 0).length;
  const max = Math.max(...days.map((d) => d.st.total), 1);
  return (
    <>
      <PageHead title="Week" sub="The last 7 days" />
      <section className="hero">
        <div className="stats4">
          <Stat label="Screen time" value={fmt(total)} delta={<span className="muted">{active} active day{active === 1 ? "" : "s"}</span>} />
          <Stat label="Productive" value={fmt(productive)} delta={<span className="muted">{total ? Math.round((productive / total) * 100) : 0}% of it</span>} />
          <Stat label="Entertainment" value={fmt(ent)} delta={<span className="muted">{total ? Math.round((ent / total) * 100) : 0}% of it</span>} />
          <Stat label="Daily average" value={active ? fmt(total / active) : "–"} delta={<span className="muted">on active days</span>} />
        </div>
      </section>

      <Section title="Day by day">
        <ul className="weekbars">
          {days.map((d) => (
            <li key={d.off}>
              <span className="wb-day">{d.label}</span>
              <span className="wb-track">
                {CATS.filter((c) => d.st.byCat[c.id] > 0).map((c) => (
                  <i
                    key={c.id}
                    style={{ width: `${(d.st.byCat[c.id] / max) * 100}%`, background: catVar(c.id) }}
                    onPointerMove={(e) => tip.show(e, `${d.label} · ${c.name}`, [{ color: catVar(c.id), label: "", value: fmt(d.st.byCat[c.id]) }])}
                    onPointerLeave={tip.hide}
                  />
                ))}
              </span>
              <span className="wb-val">{d.st.total ? fmt(d.st.total) : "–"}</span>
              <span className="wb-focus muted">{d.st.focusScore !== null ? `focus ${d.st.focusScore}` : ""}</span>
            </li>
          ))}
        </ul>
        <ul className="catlegend">
          {CATS.map((c) => (
            <li key={c.id}>
              <i style={{ background: catVar(c.id) }} />
              {c.name}
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}

// --- Settings --------------------------------------------------------------------------
function SettingsPage() {
  const [s, setS] = useState<Settings>(loadSettings);
  const [saved, setSaved] = useState(false);
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
      <PageHead title="Settings" right={<span className={`saved ${saved ? "on" : ""}`}>✓ Saved</span>} />

      <Group title="Water breaks" desc="Bond brings water after a stretch of active laptop use. Stepping away on your own counts as a break.">
        <Toggle label="Bring me water breaks" checked={s.breaksOn} onChange={(v) => update({ breaksOn: v })} />
        <Slider label="Break every" unit="min of use" min={10} max={120} step={5} value={s.breakEveryMin} disabled={!s.breaksOn} onChange={(v) => update({ breakEveryMin: v })} />
        <Slider label="“Later” waits" unit="min" min={5} max={30} step={5} value={s.snoozeMin} disabled={!s.breaksOn} onChange={(v) => update({ snoozeMin: v })} />
        <Slider label="Daily water goal" unit="glasses" min={4} max={15} step={1} value={s.waterGoal} onChange={(v) => update({ waterGoal: v })} />
      </Group>

      <Group title="Bond" desc="How he behaves around you.">
        <Toggle
          label="Nudge me when I'm brainstorming too long"
          hint="About 20 minutes with ChatGPT, Claude or notes and no editor time → “Time to build!”"
          checked={s.brainstormAlert}
          onChange={(v) => update({ brainstormAlert: v })}
        />
        <Toggle label="Read his answers aloud" checked={s.speakAnswers} onChange={(v) => update({ speakAnswers: v })} />
        <Toggle label="Warn me when the battery is low" hint="At 15% and again at 7%, while unplugged." checked={s.batteryAlert} onChange={(v) => update({ batteryAlert: v })} />
        <Slider label="Answers close after" unit="seconds" min={4} max={60} step={2} value={s.answerSeconds} onChange={(v) => update({ answerSeconds: v })} />
        <Autostart />
      </Group>

      <Group
        title="Bond's brain"
        desc="What powers “Ask Bond” and “Your day in words”. On this laptop, nothing you ask or show him leaves your computer. A cloud AI uses your own key, kept in your system keychain."
      >
        <div className="tabs" role="radiogroup" aria-label="Brain">
          <button className={s.aiProvider === "local" ? "on" : ""} onClick={() => update({ aiProvider: "local" })}>
            On this laptop · private
          </button>
          <button className={s.aiProvider === "gemini" ? "on" : ""} onClick={() => update({ aiProvider: "gemini" })}>
            Google Gemini · free
          </button>
          <button className={s.aiProvider === "claude" ? "on" : ""} onClick={() => update({ aiProvider: "claude" })}>
            Claude · paid
          </button>
        </div>
        {s.aiProvider === "local" ? <LocalBrain /> : <AiKey provider={s.aiProvider} geminiModel={s.geminiModel} onChange={update} />}
      </Group>

      <Group
        title="Voice"
        desc="Bond's own voice and ears run on this laptop: hold Ctrl+Alt+V and talk to him (or click the mic in the Ask box), and he answers out loud. The microphone is only open while you talk."
      >
        <div className="tabs" role="radiogroup" aria-label="Voice">
          {(
            [
              ["bond", "Bond's own · private"],
              ["google", "Google · needs Gemini key"],
              ["system", "Windows voice"],
            ] as const
          ).map(([v, label]) => (
            <button key={v} className={s.voice === v ? "on" : ""} onClick={() => update({ voice: v })}>
              {label}
            </button>
          ))}
        </div>
        <LocalVoice voiceId={s.voiceId} speed={s.voiceSpeed} onChange={update} />
      </Group>

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
          hint="Only with the brain on this laptop. Never password managers, banking or private windows."
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

      <Group
        title="Learning"
        desc="Bond keeps what you ask, what he did and your 👍 / 👎, and reuses what worked for similar requests. It stays on this computer, and can later train his own brain on your habits."
      >
        <Toggle label="Learn from me" checked={s.learnFromMe} onChange={(v) => update({ learnFromMe: v })} />
        <Learned />
      </Group>
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

function Toggle(props: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; note?: string | null }) {
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
  if (!st.supported) return <p className="small muted">Bond's own brain runs on Windows for now. Choose a cloud AI instead.</p>;
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

function AiKey(props: { provider: Provider; geminiModel: string; onChange: (p: Partial<Settings>) => void }) {
  const [key, setKeyInput] = useState("");
  const [saved, setSaved] = useState<boolean | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    setSaved(null);
    setMsg(null);
    hasKey(props.provider).then(setSaved).catch(() => setSaved(false));
  }, [props.provider]);
  const save = async (value: string) => {
    try {
      await setKey(props.provider, value);
      setSaved(!!value.trim());
      setKeyInput("");
      setMsg(value.trim() ? "Key saved to your system keychain." : "Key removed.");
    } catch (e) {
      setMsg(String(e));
    }
  };
  return (
    <>
      <div className="key-row">
        <input
          className="search"
          type="password"
          placeholder={saved ? "Key saved — paste a new one to replace it" : "Paste your API key"}
          value={key}
          onChange={(e) => setKeyInput(e.target.value)}
        />
        <button className="btn" disabled={!key.trim()} onClick={() => save(key)}>
          Save
        </button>
        {saved && (
          <button className="btn ghost" onClick={() => save("")}>
            Remove
          </button>
        )}
      </div>
      <p className={`small ${saved ? "good" : "muted"}`}>
        {msg ?? (saved === null ? "" : saved ? "✓ Key saved" : "No key yet.")}{" "}
        {!saved && (props.provider === "gemini" ? "Get a free one at aistudio.google.com → Get API key." : "Get one at console.anthropic.com → API keys.")}
      </p>
      {props.provider === "gemini" && (
        <label className="slider">
          <span className="s-label">Model</span>
          <input className="search" value={props.geminiModel} onChange={(e) => props.onChange({ geminiModel: e.target.value })} />
          <span className="s-value muted">“auto” tries free models in turn, skipping busy ones</span>
        </label>
      )}
    </>
  );
}
