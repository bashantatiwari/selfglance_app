// Reminders: what you asked Bond to remind you about ("remind me in 45 minutes to …"),
// grouped by when they're due. Add one here too, or remove one (with Undo). They're kept by
// the app itself, so they fire even when this window is closed (while Bond is running).

import { useEffect, useMemo, useState } from "react";
import { addReminder, listReminders, removeReminder, type Reminder } from "../ai";
import { onTauriEvent } from "../platform";
import { toast } from "./ui";

const clock = (d: Date) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
const dayAfter = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
};

const when = (ms: number) => {
  const d = new Date(ms);
  if (sameDay(d, new Date())) return clock(d);
  if (sameDay(d, dayAfter(1))) return `Tomorrow ${clock(d)}`;
  return `${d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} ${clock(d)}`;
};

/** "in 25 min", "in 3 h", "in 2 days"; "5 min ago" once it's past. */
const rel = (ms: number) => {
  const diff = ms - Date.now();
  const m = Math.round(Math.abs(diff) / 60_000);
  const text = m < 1 ? "now" : m < 60 ? `${m} min` : m < 60 * 36 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`;
  return diff < 0 && m >= 1 ? `${text} ago` : m < 1 ? "now" : `in ${text}`;
};

/** The value a datetime-local input wants. */
const local = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
const inMinutes = (n: number) => {
  const d = new Date(Date.now() + n * 60_000);
  d.setSeconds(0, 0);
  return d;
};
const atHour = (dayOffset: number, h: number) => {
  const d = dayAfter(dayOffset);
  d.setHours(h, 0, 0, 0);
  return d;
};

export default function Reminders() {
  const [list, setList] = useState<Reminder[]>([]);
  const [text, setText] = useState("");
  const [at, setAt] = useState(() => local(inMinutes(60)));
  const [error, setError] = useState("");
  const [, tick] = useState(0);

  useEffect(() => {
    const read = () => void listReminders().then(setList).catch(() => {});
    read();
    const un = onTauriEvent<null>("reminders-changed", read);
    window.addEventListener("focus", read);
    const t = window.setInterval(() => tick((n) => n + 1), 30_000); // keeps "in 5 min" fresh
    return () => {
      un.then((u) => u());
      window.removeEventListener("focus", read);
      clearInterval(t);
    };
  }, []);

  const due = new Date(at).getTime();
  const valid = text.trim() !== "" && !Number.isNaN(due) && due > Date.now();

  const add = async () => {
    if (!text.trim()) return;
    if (Number.isNaN(due)) return setError("That isn't a date and time I can read.");
    if (!(due > Date.now())) return setError("That time has already passed. Pick one in the future.");
    try {
      await addReminder(text.trim(), due);
      setText("");
      setError("");
      setList(await listReminders());
      toast(`Reminder set for ${when(due)}`);
    } catch (e) {
      setError(String(e));
    }
  };

  const remove = async (r: Reminder) => {
    await removeReminder(r.id);
    setList(await listReminders());
    toast("Reminder removed", {
      label: "Undo",
      run: async () => {
        if (r.at > Date.now()) {
          await addReminder(r.text, r.at).catch(() => {});
          setList(await listReminders());
        } else toast("That time has passed, so it can't come back.");
      },
    });
  };

  const presets: { name: string; date: Date }[] = [
    { name: "In 15 min", date: inMinutes(15) },
    { name: "In 1 hour", date: inMinutes(60) },
    { name: "This evening", date: atHour(0, 18) },
    { name: "Tomorrow 9 am", date: atHour(1, 9) },
  ].filter((p) => p.date.getTime() > Date.now() + 60_000);

  const groups = useMemo(() => {
    const now = Date.now();
    const sorted = list.slice().sort((a, b) => a.at - b.at);
    const g: { id: string; name: string; items: Reminder[] }[] = [
      { id: "over", name: "Overdue", items: sorted.filter((r) => r.at < now) },
      { id: "today", name: "Today", items: sorted.filter((r) => r.at >= now && sameDay(new Date(r.at), new Date())) },
      { id: "tomorrow", name: "Tomorrow", items: sorted.filter((r) => r.at >= now && sameDay(new Date(r.at), dayAfter(1))) },
    ];
    const placed = new Set(g.flatMap((x) => x.items.map((r) => r.id)));
    g.push({ id: "later", name: "Later", items: sorted.filter((r) => !placed.has(r.id)) });
    return g.filter((x) => x.items.length);
  }, [list, Date.now() >> 15]);

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Reminders</h1>
          <p className="muted">Tell Bond “remind me in 30 minutes to stretch” or “remind me at 5pm to call mom”, or add one here.</p>
        </div>
      </header>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <div className="composer-row">
          <input className="capture-input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Remind me to…" aria-label="Reminder" />
          <input className="search" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} aria-label="When" />
          <button className="btn" disabled={!valid}>
            Add reminder
          </button>
        </div>
        <div className="composer-row quick">
          <span className="muted small">Quick:</span>
          {presets.map((p) => (
            <button type="button" key={p.name} className={`chip ${local(p.date) === at ? "on" : ""}`} onClick={() => setAt(local(p.date))}>
              {p.name}
            </button>
          ))}
          <span className="muted small grow">{Number.isNaN(due) ? "" : due > Date.now() ? `Will remind you ${when(due)} (${rel(due)})` : "Pick a time in the future"}</span>
        </div>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {list.length === 0 && (
        <section className="empty-state">
          <h2>Nothing coming up</h2>
          <p className="muted">Try “Hey Bond, remind me in 20 minutes to stretch”, or write one above. Bond reminds you out loud when it's time, even with this window closed (while he's running).</p>
        </section>
      )}

      {groups.map((g) => (
        <section key={g.id} className={`rgroup ${g.id}`}>
          <h2 className="rgroup-name">
            {g.name} <span className="count">{g.items.length}</span>
          </h2>
          <ul className="rlist">
            {g.items.map((r) => (
              <li key={r.id}>
                <span className="r-when">
                  <b>{when(r.at)}</b>
                  <small className={g.id === "over" ? "bad" : "muted"}>{rel(r.at)}</small>
                </span>
                <p>{r.text}</p>
                <button className="icon-btn danger" onClick={() => void remove(r)} aria-label="Remove reminder" title="Remove">
                  <svg viewBox="0 0 24 24" aria-hidden>
                    <path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
