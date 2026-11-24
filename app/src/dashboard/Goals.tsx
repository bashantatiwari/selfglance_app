// Today's list: what you mean to do today, ticked off as you go, and how much of the laptop time
// went to it. Bond asks for it in the morning; you can add to it here, by typing "today: …" to him,
// or by saying it. Drift is judged against the items not ticked off yet (assistant/goals.ts).

import { useEffect, useMemo, useState } from "react";
import { loadDay, type Segment } from "../companion/tracker";
import { addTodos, loadTodos, makeJudge, saveTodos, splitTodos, tally, TODO_EVENT, tomorrowOf, type Todo } from "../assistant/goals";
import { fmt } from "./analyze";

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

/** A day's list, kept fresh (Bond may add to it from his card). */
function useTodos(day: () => Date) {
  const [list, setList] = useState<Todo[]>(() => loadTodos(day()));
  useEffect(() => {
    const read = () => setList(loadTodos(day()));
    window.addEventListener("focus", read);
    window.addEventListener(TODO_EVENT, read);
    const t = window.setInterval(read, 4000);
    return () => {
      window.removeEventListener("focus", read);
      window.removeEventListener(TODO_EVENT, read);
      clearInterval(t);
    };
  }, []);
  const save = (next: Todo[]) => {
    saveTodos(next, day());
    setList(loadTodos(day()));
  };
  const add = (text: string) => setList(addTodos(splitTodos(text), day()));
  return { list, save, add };
}

/** On the list / not on it / other, as one bar. */
export function GoalBar(props: { on: number; off: number; other: number }) {
  const total = props.on + props.off + props.other;
  if (total <= 0) return <div className="goalbar blank" aria-hidden />;
  return (
    <div className="goalbar" role="img" aria-label={`On the list ${fmt(props.on)}, off it ${fmt(props.off)}, other ${fmt(props.other)}`}>
      {props.on > 0 && <i className="on" style={{ flexGrow: props.on }} />}
      {props.off > 0 && <i className="off" style={{ flexGrow: props.off }} />}
      {props.other > 0 && <i className="other" style={{ flexGrow: props.other }} />}
    </div>
  );
}

function TodoList(props: { list: Todo[]; save: (l: Todo[]) => void; add: (t: string) => void; placeholder: string }) {
  const [draft, setDraft] = useState("");
  const { list, save } = props;
  return (
    <div className="goal-form">
      {list.length > 0 && (
        <ul className="goal-lines todo">
          {list.map((t) => (
            <li key={t.id} className={t.done ? "done" : ""}>
              <label>
                <input type="checkbox" checked={t.done} onChange={() => save(list.map((x) => (x.id === t.id ? { ...x, done: !x.done } : x)))} />
                <span>{t.text}</span>
              </label>
              <button className="icon-btn" onClick={() => save(list.filter((x) => x.id !== t.id))} aria-label={`Remove “${t.text}”`} title="Remove">
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="capture"
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.trim()) return;
          props.add(draft);
          setDraft("");
        }}
      >
        <input className="capture-input" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={props.placeholder} aria-label="Add to the list" maxLength={300} />
        <button className="btn" disabled={!draft.trim()}>
          Add
        </button>
      </form>
    </div>
  );
}

/** The Today page's tile: the list and how the day is going toward it. */
export function GoalTile(props: { segs: Segment[]; open: () => void }) {
  const { list, save, add } = useTodos(() => new Date());
  const open = list.filter((t) => !t.done).map((t) => t.text);
  const t = useMemo(() => tally(props.segs, makeJudge(open)), [props.segs, open.join("|")]);
  return (
    <section className="section t-wide goal-tile">
      <div className="section-head">
        <h2>Today's list</h2>
        <button className="linkish" onClick={props.open}>
          Open →
        </button>
      </div>
      <TodoList list={list} save={save} add={add} placeholder="What's on today? e.g. make the video, learn LangGraph" />
      {open.length > 0 && (
        <>
          <GoalBar {...t} />
          <p className="goal-numbers">
            <b>{fmt(t.on)}</b> on the list · <b>{fmt(t.off)}</b> off it · <b>{fmt(t.other)}</b> other
          </p>
        </>
      )}
    </section>
  );
}

export default function Goals() {
  const segs = useToday();
  const today = useTodos(() => new Date());
  const tomorrow = useTodos(() => tomorrowOf());
  const open = today.list.filter((t) => !t.done).map((t) => t.text);
  const t = useMemo(() => tally(segs, makeJudge(open)), [segs, open.join("|")]);
  const done = today.list.filter((x) => x.done).length;
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Today's list</h1>
          <p className="muted">{today.list.length ? `${done} of ${today.list.length} done` : "Write what you mean to do today. Bond keeps you to it."}</p>
        </div>
      </header>
      <section className="section">
        <TodoList list={today.list} save={today.save} add={today.add} placeholder="Add things, one at a time or separated by commas" />
      </section>
      {open.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2>Laptop time today</h2>
          </div>
          <GoalBar {...t} />
          <p className="goal-numbers">
            <b>{fmt(t.on)}</b> on the list · <b>{fmt(t.off)}</b> off it · <b>{fmt(t.other)}</b> other
          </p>
          <p className="muted">After about ten minutes in a row off the list, Bond says so once. “This counts” teaches him.</p>
        </section>
      )}
      <section className="section">
        <div className="section-head">
          <h2>Tomorrow</h2>
        </div>
        <TodoList list={tomorrow.list} save={tomorrow.save} add={tomorrow.add} placeholder="Something for tomorrow" />
      </section>
    </>
  );
}
