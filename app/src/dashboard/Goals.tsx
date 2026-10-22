// Goals: the day's focus in one line, how the day is going toward it, and the week in review
// (Bond opens it on Sunday morning). Everything is rules over the diary on this laptop; see
// assistant/goals.ts. Few options on purpose: the focus, corrections, two switches.

import { useEffect, useMemo, useState } from "react";
import { loadDay, type Segment } from "../companion/tracker";
import {
  cleanGoals,
  dayId,
  loadFixes,
  loadGoals,
  loadState,
  MAX_GOALS,
  makeJudge,
  patchState,
  reviewDue,
  reviewWeek,
  saveFixes,
  saveGoals,
  tally,
  keyOf,
  verdict,
  type Fit,
  type Verdict,
} from "../assistant/goals";
import { loadSettings, saveSettings, type Settings } from "../settings";
import { fmt } from "./analyze";
import { toast, Toggle } from "./ui";

const VERDICT_NAME: Record<Verdict, string> = { on: "On goal", off: "Off goal", neutral: "Neutral", unsure: "Not sure" };
const FITS: { id: Fit; name: string }[] = [
  { id: "on", name: "On" },
  { id: "off", name: "Off" },
  { id: "neutral", name: "Neutral" },
];

/** Today's diary, re-read every few seconds (the overlay keeps writing it). */
export function useToday() {
  const [segs, setSegs] = useState<Segment[]>(() => loadDay());
  useEffect(() => {
    const read = () => setSegs(loadDay());
    const t = window.setInterval(read, 3000);
    window.addEventListener("focus", read);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", read);
    };
  }, []);
  return segs;
}

/** The goals for today, with a form to change them. */
export function useGoals() {
  const [goals, setGoals] = useState(() => loadGoals());
  useEffect(() => {
    const read = () => setGoals(loadGoals());
    window.addEventListener("focus", read);
    const t = window.setInterval(read, 4000); // Bond may have set it from his card
    return () => {
      window.removeEventListener("focus", read);
      clearInterval(t);
    };
  }, []);
  const update = (next: string[]) => {
    saveGoals(next);
    setGoals(loadGoals());
  };
  return { goals, update };
}

export function GoalForm(props: { goals: string[]; update: (g: string[]) => void; compact?: boolean }) {
  const [draft, setDraft] = useState("");
  const full = props.goals.length >= MAX_GOALS;
  const add = () => {
    if (!draft.trim() || full) return;
    props.update(cleanGoals([...props.goals, draft]));
    setDraft("");
  };
  return (
    <div className="goal-form">
      {props.goals.length > 0 && (
        <ul className="goal-lines">
          {props.goals.map((g) => (
            <li key={g}>
              <span>{g}</span>
              <button className="icon-btn" onClick={() => props.update(props.goals.filter((x) => x !== g))} aria-label={`Remove “${g}”`} title="Remove">
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {!full && (
        <form
          className="capture"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <input
            className="capture-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={props.goals.length ? "Add another (optional)" : "What's your focus today? e.g. finish the micrograd tutorial"}
            aria-label="Focus for today"
            maxLength={120}
          />
          <button className="btn" disabled={!draft.trim()}>
            {props.goals.length ? "Add" : "Set focus"}
          </button>
        </form>
      )}
    </div>
  );
}

/** On-goal / off-goal / other, as one bar. */
export function GoalBar(props: { on: number; off: number; other: number; scale?: number }) {
  const total = props.on + props.off + props.other;
  if (total <= 0) return <div className="goalbar blank" aria-hidden />;
  return (
    <div className="goalbar" role="img" aria-label={`On goal ${fmt(props.on)}, off goal ${fmt(props.off)}, other ${fmt(props.other)}`} style={props.scale ? { width: `${Math.max(4, (total / props.scale) * 100)}%` } : undefined}>
      {props.on > 0 && <i className="on" style={{ flexGrow: props.on }} />}
      {props.off > 0 && <i className="off" style={{ flexGrow: props.off }} />}
      {props.other > 0 && <i className="other" style={{ flexGrow: props.other }} />}
    </div>
  );
}

/** The Today page's tile: the focus and how the day is going toward it (read-only for past days). */
export function GoalTile(props: { segs: Segment[]; date: Date; today: boolean; open: () => void }) {
  const { goals, update } = useGoals();
  const shown = props.today ? goals : loadGoals(props.date);
  const t = useMemo(() => tally(props.segs, makeJudge(shown)), [props.segs, shown.join("|")]);
  return (
    <section className="section t-wide goal-tile">
      <div className="section-head">
        <h2>{props.today ? "Today's focus" : "That day's focus"}</h2>
        <button className="linkish" onClick={props.open}>
          Goals →
        </button>
      </div>
      {shown.length === 0 && !props.today && <p className="muted">No focus was set.</p>}
      {shown.length === 0 && props.today && <GoalForm goals={goals} update={update} />}
      {shown.length > 0 && (
        <>
          <ul className="goal-lines plain">
            {shown.map((g) => (
              <li key={g}>
                <span>{g}</span>
              </li>
            ))}
          </ul>
          <GoalBar {...t} />
          <p className="goal-numbers">
            <b>{fmt(t.on)}</b> on goal · <b>{fmt(t.off)}</b> off · <b>{fmt(t.other)}</b> other
          </p>
        </>
      )}
    </section>
  );
}

export default function Goals() {
  const segs = useToday();
  const { goals, update } = useGoals();
  const [version, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const set = (p: Partial<Settings>) => {
    const next = { ...loadSettings(), ...p };
    setSettings(next);
    void saveSettings(next);
  };

  const judge = useMemo(() => makeJudge(goals), [goals, version, segs]);
  const t = useMemo(() => tally(segs, judge), [segs, judge]);
  const rows = useMemo(() => {
    const m = new Map<string, { key: string; label: string; app: string; ms: number; v: Verdict }>();
    for (const s of segs) {
      const key = keyOf(s);
      const r = m.get(key) ?? { key, label: s.label, app: s.app, ms: 0, v: verdict(s, judge) };
      r.ms += Math.max(0, s.end - s.start) + 2000;
      m.set(key, r);
    }
    return [...m.values()].sort((a, b) => b.ms - a.ms).slice(0, 8);
  }, [segs, judge]);

  const review = useMemo(() => reviewWeek(new Date(), loadDay, loadGoals), [goals, version, segs.length >> 4]);
  const fixes = loadFixes();
  const fixList = Object.entries(fixes);

  // Opening the review counts as seeing it: Bond won't bring it up again today.
  useEffect(() => {
    if (reviewDue(loadState(), new Date())) patchState({ reviewed: dayId() });
  }, []);

  const correct = (key: string, fit: Fit | null) => {
    const next = { ...loadFixes() };
    if (fit) next[key] = fit;
    else delete next[key];
    saveFixes(next);
    bump();
    if (fit) toast(`Remembered: ${fit === "on" ? "on-goal" : fit === "off" ? "off-goal" : "neutral"}`);
  };

  const maxDay = Math.max(...review.days.map((d) => d.t.on + d.t.off + d.t.other), 1);
  const tracked = t.on + t.off + t.other;

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Goals</h1>
          <p className="muted">One line for the day. Bond tracks how it's going, tells you if you drift, and looks back on Sunday morning.</p>
        </div>
      </header>

      <section className="section">
        <div className="section-head">
          <h2>Today's focus</h2>
        </div>
        <GoalForm goals={goals} update={update} />
        {goals.length > 0 && (
          <div className="goal-today">
            <GoalBar {...t} />
            <p className="goal-numbers">
              <b>{fmt(t.on)}</b> on goal · <b>{fmt(t.off)}</b> off · <b>{fmt(t.other)}</b> other
              {tracked > 0 && t.on + t.off > 5 * 60_000 && <span className="muted"> · {Math.round((t.on / (t.on + t.off)) * 100)}% of the time I could tell</span>}
            </p>
          </div>
        )}
      </section>

      {goals.length > 0 && rows.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2>What counted</h2>
          </div>
          <p className="muted goal-hint">I only see app names and window titles, so this is an estimate. Tap On, Off or Neutral to correct me — I'll remember.</p>
          <ul className="goal-rows">
            {rows.map((r) => (
              <li key={r.key}>
                <div className="gr-main">
                  <span className="gr-label">{r.label}</span>
                  <small className="muted">
                    {r.app} · {fmt(r.ms)}
                  </small>
                </div>
                <span className={`fit fit-${r.v}`}>{VERDICT_NAME[r.v]}</span>
                <span className="fit-pick" role="group" aria-label={`Count “${r.label}” as`}>
                  {FITS.map((f) => (
                    <button key={f.id} className={fixes[r.key] === f.id ? "on" : ""} aria-pressed={fixes[r.key] === f.id} onClick={() => correct(r.key, fixes[r.key] === f.id ? null : f.id)}>
                      {f.name}
                    </button>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="section">
        <div className="section-head">
          <h2>Your week</h2>
        </div>
        {review.goalDays === 0 ? (
          <div className="week-empty">
            <div className="week-dots" aria-hidden>
              {review.days.map((d) => (
                <span key={d.id}>
                  <i />
                  <small>{d.date.toLocaleDateString([], { weekday: "short" })}</small>
                </span>
              ))}
            </div>
            <p>
              <b>No focus set in the last seven days.</b>
            </p>
            <p className="muted">Set one line each morning, at the top of this page or by telling Bond “goal: …”. On Sunday this shows how each day went and what to try next.</p>
          </div>
        ) : (
          <>
            <p className="muted goal-hint">The last seven days. Bond brings this up on Sunday morning with a few ideas for the week ahead.</p>
            <ul className="goal-days">
              {review.days.map((d) => (
                <li key={d.id} className={d.goals.length ? "" : "none"}>
                  <span className="gd-name">{d.date.toLocaleDateString([], { weekday: "short" })}</span>
                  <span className="gd-goal">{d.goals[0] ?? "no focus set"}</span>
                  <span className="gd-track">{d.goals.length > 0 && <GoalBar {...d.t} scale={maxDay} />}</span>
                  <span className="gd-val">{d.goals.length ? fmt(d.t.on) : ""}</span>
                </li>
              ))}
            </ul>
            {review.usable ? (
              <p className="goal-numbers">
                <b>{fmt(review.t.on)}</b> on goal · <b>{fmt(review.t.off)}</b> off
                {review.share !== null && <span> · {review.share}%</span>}
                {review.share !== null && review.prevShare !== null && <span className="muted"> (week before: {review.prevShare}%)</span>}
              </p>
            ) : (
              <p className="muted">Not much tracked time on your focus days yet, so there's little to sum up.</p>
            )}
            {review.suggestions.length > 0 && (
              <>
                <h3 className="goal-sub">Ideas for next week</h3>
                <ul className="notes">
                  {review.suggestions.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </section>

      {fixList.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2>Your corrections</h2>
          </div>
          <ul className="goal-rows">
            {fixList.map(([key, fit]) => (
              <li key={key}>
                <div className="gr-main">
                  <span className="gr-label">{key.split("|").reverse().join(" · ")}</span>
                </div>
                <span className={`fit fit-${fit}`}>{VERDICT_NAME[fit]}</span>
                <button className="btn ghost" onClick={() => correct(key, null)}>
                  Forget
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="section goal-options">
        <Toggle label="Nudge me when I drift" hint="After about 10 minutes in a row off your focus, at most twice an hour. You can snooze it." checked={settings.goalNudge} onChange={(v) => set({ goalNudge: v })} />
        <Toggle label="Sunday morning review" hint="Bond looks back on the week on Sunday from 9:00." checked={settings.goalReview} onChange={(v) => set({ goalReview: v })} />
      </section>
    </>
  );
}
