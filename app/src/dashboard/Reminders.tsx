// Reminders: what you asked Bond to remind you about ("remind me in 45 minutes to …"),
// soonest first. Add one here too, or remove one. They're kept by the app itself, so they
// fire even when this window is closed.

import { useEffect, useState } from "react";
import { addReminder, listReminders, removeReminder, type Reminder } from "../ai";
import { onTauriEvent } from "../platform";

const when = (ms: number) => {
  const d = new Date(ms);
  const today = new Date();
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === today.toDateString()) return `Today ${time}`;
  if (d.toDateString() === tomorrow.toDateString()) return `Tomorrow ${time}`;
  return `${d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} ${time}`;
};

/** The value a datetime-local input wants, for an hour from now. */
const inAnHour = () => {
  const d = new Date(Date.now() + 60 * 60_000);
  d.setSeconds(0, 0);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

export default function Reminders() {
  const [list, setList] = useState<Reminder[]>([]);
  const [text, setText] = useState("");
  const [at, setAt] = useState(inAnHour);
  const [error, setError] = useState("");

  useEffect(() => {
    const read = () => void listReminders().then(setList).catch(() => {});
    read();
    const un = onTauriEvent<null>("reminders-changed", read);
    window.addEventListener("focus", read);
    return () => {
      un.then((u) => u());
      window.removeEventListener("focus", read);
    };
  }, []);

  const add = async () => {
    const due = new Date(at).getTime();
    if (!text.trim()) return;
    if (!(due > Date.now())) return setError("Pick a time in the future.");
    try {
      await addReminder(text, due);
      setText("");
      setError("");
      setList(await listReminders());
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Reminders</h1>
          <p className="muted">Tell Bond “remind me in 30 minutes to stretch” or “remind me at 5pm to call mom”, or add one here.</p>
        </div>
      </header>

      <form
        className="key-row"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <input className="search idea-input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Remind me to…" aria-label="Reminder" />
        <input className="search" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} aria-label="When" />
        <button className="btn" disabled={!text.trim()}>
          Add
        </button>
      </form>
      {error && <p className="muted">{error}</p>}

      {list.length === 0 && <p className="muted">No reminders set.</p>}
      {list.length > 0 && (
        <ul className="ideas">
          {list.map((r) => (
            <li key={r.id}>
              <div>
                <p>{r.text}</p>
                <small className="muted">{when(r.at)}</small>
              </div>
              <button
                className="btn ghost"
                onClick={async () => {
                  await removeReminder(r.id);
                  setList(await listReminders());
                }}
                aria-label="Remove reminder"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
