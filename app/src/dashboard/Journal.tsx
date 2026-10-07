// Journal: at the end of the day, type about your whole day (laptop or not) and save it.
// One entry per day, stored locally. Past entries are listed below, newest first.

import { useMemo, useState } from "react";

const PREFIX = "selfglance.journal.";

const dayKey = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

function read(key: string): string {
  try {
    return localStorage.getItem(PREFIX + key) ?? "";
  } catch {
    return "";
  }
}

function allEntries(): { day: string; text: string }[] {
  const out: { day: string; text: string }[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(PREFIX)) out.push({ day: k.slice(PREFIX.length), text: localStorage.getItem(k) ?? "" });
    }
  } catch {
    /* storage unavailable */
  }
  return out.filter((e) => e.text.trim()).sort((a, b) => b.day.localeCompare(a.day));
}

const pretty = (day: string) =>
  new Date(`${day}T12:00:00`).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" });

export default function Journal() {
  const today = dayKey();
  const [text, setText] = useState(() => read(today));
  const [savedText, setSavedText] = useState(() => read(today));
  const [version, setVersion] = useState(0);
  const past = useMemo(() => allEntries().filter((e) => e.day !== today), [version, today]);
  const dirty = text !== savedText;

  const save = () => {
    try {
      if (text.trim()) localStorage.setItem(PREFIX + today, text);
      else localStorage.removeItem(PREFIX + today);
      setSavedText(text);
      setVersion((v) => v + 1);
    } catch {
      /* storage full or unavailable */
    }
  };

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Journal</h1>
          <p className="muted">{pretty(today)}</p>
        </div>
      </header>

      <section className="journal-today">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "s") {
              e.preventDefault();
              save();
            }
          }}
          placeholder="How did today go? What did you do, on and off the laptop?"
          aria-label="Today's journal entry"
        />
        <div className="journal-actions">
          <span className="muted small">{dirty ? "Not saved yet · Ctrl+S" : savedText.trim() ? "✓ Saved" : ""}</span>
          <button className="btn" onClick={save} disabled={!dirty}>
            Save
          </button>
        </div>
      </section>

      {past.length > 0 && (
        <section className="journal-past">
          <h2>Earlier</h2>
          {past.map((e) => (
            <article key={e.day}>
              <h3>{pretty(e.day)}</h3>
              <p>{e.text}</p>
            </article>
          ))}
        </section>
      )}
    </>
  );
}
