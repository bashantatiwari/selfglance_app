// A day's plan: yours and Bond's in one schedule. The fitting is code (assistant/plan.ts); this
// only shows it. Type or say what you want to get done; Bond's suggestions wait for a yes.
//
// Opening the laptop with no idea where to start is the case this page is built for: "Where to start"
// lists what you left unfinished on earlier days, today's focus, and ideas that have waited for days,
// each one tap away; with Settings → About you filled in, also time toward your aim and your projects,
// inside your usual hours. Tomorrow can be planned the evening before, as a plain list.

import { useEffect, useMemo, useState } from "react";
import { dayId, loadGoals } from "../assistant/goals";
import { loadIdeas } from "../assistant/notes";
import { aimWords, dayBounds, hasProfile, loadProfile, PROFILE_EVENT, projectList } from "../assistant/profile";
import { clock, fit, loadPlan, MAX_ITEMS, minutesNow, parsePlan, savePlan, suggest, unfinished, type PlanDay, type PlanItem } from "../assistant/plan";

const dayAt = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d;
};

/** Re-render when the plan changes (here, from Bond, or another window), and as the clock moves on. */
function usePlanTick() {
  const [, tick] = useState(0);
  useEffect(() => {
    const again = () => tick((n) => n + 1);
    window.addEventListener("selfglance:plan", again);
    window.addEventListener(PROFILE_EVENT, again);
    window.addEventListener("focus", again);
    const t = window.setInterval(again, 30_000); // the "now" the schedule is fitted from moves on
    return () => {
      window.removeEventListener("selfglance:plan", again);
      window.removeEventListener(PROFILE_EVENT, again);
      window.removeEventListener("focus", again);
      clearInterval(t);
    };
  }, []);
}

function AddBox(props: { onAdd: (items: PlanItem[]) => void; placeholder: string }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const more = parsePlan(draft);
    if (!more.length) return;
    props.onAdd(more);
    setDraft("");
  };
  return (
    <form
      className="plan-add"
      onSubmit={(e) => {
        e.preventDefault();
        add();
      }}
    >
      <input className="capture-input" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={props.placeholder} aria-label="Add to the plan" maxLength={400} />
      <button className="btn" type="submit" disabled={!draft.trim()}>
        Add
      </button>
    </form>
  );
}

/** Today's schedule, with "Where to start" when there is something to pick from. */
export default function Plan() {
  usePlanTick();
  const day = dayId();
  const plan = loadPlan(day);
  const now = minutesNow();
  const profile = loadProfile();
  // Your usual hours bound the day: nothing is placed before you start or after you stop.
  const hours = dayBounds(profile);
  const sched = useMemo(() => fit(plan.items, { now: Math.max(now, hours.start), end: hours.end }), [JSON.stringify(plan.items), Math.floor(now / 5), hours.start, hours.end]);
  const ideas = loadIdeas().filter((i) => !i.done);
  const ideasList = useMemo(() => ideas.map((i) => ({ text: i.text, at: i.at })), [ideas.length]);
  // The last three days, newest first: what was planned there and never ticked off.
  const earlier = useMemo(
    () =>
      unfinished(
        [1, 2, 3].map((n) => ({
          when: n === 1 ? "yesterday" : `on ${dayAt(-n).toLocaleDateString([], { weekday: "long" })}`,
          plan: loadPlan(dayId(dayAt(-n))),
        })),
      ),
    [day],
  );
  const asks = suggest(plan, { goals: loadGoals(), ideas: ideasList, unfinished: earlier, aim: profile.aim, aimWords: aimWords(profile), projects: projectList(profile) });
  const done = plan.items.filter((i) => i.done);
  const carried = asks.filter((a) => a.why?.startsWith("Not finished"));

  const change = (items: PlanItem[], dismissed = plan.dismissed) => savePlan(day, { items: items.slice(0, MAX_ITEMS), dismissed });
  const mark = (id: string) => change(plan.items.map((i) => (i.id === id ? { ...i, done: !i.done } : i)));
  const drop = (id: string) => change(plan.items.filter((i) => i.id !== id));
  const full = plan.items.length >= MAX_ITEMS;

  return (
    <section className="section">
      <div className="section-head">
        <h2>Today's plan</h2>
        {sched.slots.length > 0 && <span className="muted small">{sched.slots.reduce((n, s) => n + s.item.mins, 0)} min planned</span>}
      </div>
      <AddBox onAdd={(more) => change([...plan.items, ...more])} placeholder="What do you want to get done? e.g. edit the intro video, study transformers at 4pm for 45 min" />

      {sched.slots.length === 0 && done.length === 0 && asks.length === 0 && (
        <p className="muted small">Nothing planned yet. Type what you want to get done, or say “plan my day: …” to Bond. Unfinished items come back here tomorrow.</p>
      )}
      {sched.slots.length > 0 && (
        <ul className="goal-rows plan-rows">
          {sched.slots.map(({ item, start, end }) => (
            <li key={item.id} className={start <= now && now < end ? "now" : ""}>
              <input type="checkbox" checked={false} onChange={() => mark(item.id)} aria-label={`Done: ${item.title}`} />
              <div className="gr-main">
                <span className="gr-label">{item.title}</span>
                <small className="muted">
                  {start <= now && now < end ? "Now · " : ""}
                  {clock(start)}–{clock(end)} · {item.mins} min
                  {item.by === "bond" ? " · Bond's idea" : item.at ? " · your time" : ""}
                  {item.why ? ` · ${item.why}` : ""}
                </small>
              </div>
              <button className="btn ghost" onClick={() => drop(item.id)} aria-label={`Remove ${item.title}`} title="Remove">
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      {sched.notes.length > 0 && (
        <ul className="plan-notes small muted">
          {sched.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      {done.length > 0 && (
        <p className="small muted plan-done">
          Done: {done.map((i) => i.title).join(" · ")}{" "}
          <button className="btn ghost" onClick={() => change(plan.items.filter((i) => !i.done))}>
            Clear
          </button>
        </p>
      )}

      {asks.length > 0 && !full && (
        <div className="plan-asks">
          <div className="section-head">
            <h3>{plan.items.length ? "More you could do" : "Where to start"}</h3>
            {carried.length > 1 && (
              <button className="btn ghost" onClick={() => change([...plan.items, ...carried])}>
                Bring back all {carried.length} unfinished
              </button>
            )}
          </div>
          <ul className="goal-rows">
            {asks.slice(0, 6).map((a) => (
              <li key={a.id}>
                <div className="gr-main">
                  <span className="gr-label">{a.title}</span>
                  <small className="muted">
                    {a.mins} min · {a.why}
                  </small>
                </div>
                <button className="btn" onClick={() => change([...plan.items, a])}>
                  Add
                </button>
                <button className="btn ghost" onClick={() => change(plan.items, [...plan.dismissed, a.title])}>
                  Not today
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {!profile.aim && (
        <p className="muted small plan-hint">
          {hasProfile(profile) ? "Add where you're headed" : "Tell Bond about yourself"} in <b>Settings → About you</b>, and he'll suggest time toward it here, inside your usual hours.
        </p>
      )}
    </section>
  );
}

/** Tomorrow's list: no times yet, it is fitted when the day comes. Planned the evening before, it is the first thing Bond shows in the morning. */
export function TomorrowPlan() {
  usePlanTick();
  const day = dayId(dayAt(1));
  const plan: PlanDay = loadPlan(day);
  const change = (items: PlanItem[]) =>
    savePlan(day, {
      items: items.slice(0, MAX_ITEMS),
      dismissed: plan.dismissed,
    });
  return (
    <section className="section">
      <div className="section-head">
        <h2>Tomorrow's plan</h2>
      </div>
      <AddBox onAdd={(more) => change([...plan.items, ...more])} placeholder="e.g. finish the thumbnail, call the bank at 10am" />
      {plan.items.length === 0 ? (
        <p className="muted small">Write down tomorrow's work tonight, and the morning starts with a list instead of a blank page.</p>
      ) : (
        <ul className="goal-rows plan-rows">
          {plan.items.map((item) => (
            <li key={item.id}>
              <div className="gr-main">
                <span className="gr-label">{item.title}</span>
                <small className="muted">
                  {item.mins} min{item.at ? ` · at ${item.at}` : ""}
                </small>
              </div>
              <button className="btn ghost" onClick={() => change(plan.items.filter((i) => i.id !== item.id))} aria-label={`Remove ${item.title}`} title="Remove">
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
