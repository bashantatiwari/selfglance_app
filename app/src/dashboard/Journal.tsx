// Journal: at the end of the day, type about your whole day (laptop or not). It saves as
// you type, one file per day (journal.rs). Past entries are listed below, newest first.
// "log …" to Bond appends a timestamped line; an open Journal picks it up right away.

import { useEffect, useRef, useState } from "react";
import { dayKey, journalGet, journalList, journalSet } from "../assistant/notes";
import { onTauriEvent } from "../platform";

/** Save this long after the last keystroke. */
const SAVE_AFTER_MS = 700;

const pretty = (day: string) =>
  new Date(`${day}T12:00:00`).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" });

type SaveState = "idle" | "saving" | "saved" | "error";

export default function Journal() {
  const today = dayKey();
  const [text, setText] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [past, setPast] = useState<{ day: string; text: string }[]>([]);
  const [state, setState] = useState<SaveState>("idle");
  const savedRef = useRef("");
  const textRef = useRef("");
  textRef.current = text;

  const refreshPast = () => void journalList().then((all) => setPast(all.filter((e) => e.day !== today))).catch(() => {});

  useEffect(() => {
    void journalGet(today)
      .then((t) => {
        savedRef.current = t;
        setText(t);
      })
      .catch(() => setState("error"))
      .finally(() => setLoaded(true));
    refreshPast();
  }, [today]);

  const save = async (value: string) => {
    if (value === savedRef.current) return;
    setState("saving");
    try {
      await journalSet(today, value);
      savedRef.current = value;
      setState("saved");
    } catch {
      setState("error");
    }
  };

  // Save shortly after you stop typing.
  useEffect(() => {
    if (!loaded || text === savedRef.current) return;
    const t = window.setTimeout(() => void save(text), SAVE_AFTER_MS);
    return () => clearTimeout(t);
  }, [text, loaded]);

  // Leaving the page (or hiding the window) saves whatever is left.
  useEffect(() => {
    const flush = () => void save(textRef.current);
    window.addEventListener("blur", flush);
    return () => {
      window.removeEventListener("blur", flush);
      flush();
    };
  }, [loaded]);

  // Bond logged something: take it in, keeping anything you typed that isn't saved yet.
  useEffect(() => {
    const un = onTauriEvent<null>("notes-changed", async () => {
      const fresh = await journalGet(today).catch(() => null);
      if (fresh === null) return;
      const mine = textRef.current;
      const unsaved = mine !== savedRef.current;
      savedRef.current = fresh;
      setText(unsaved && !fresh.includes(mine.trim()) ? `${fresh.trimEnd()}\n${mine}` : fresh);
    });
    return () => void un.then((u) => u());
  }, [today]);

  const status = { idle: "", saving: "Saving…", saved: "✓ Saved", error: "Couldn't save — your text is still here" }[state];

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
          disabled={!loaded}
          placeholder="How did today go? What did you do, on and off the laptop?"
          aria-label="Today's journal entry"
        />
        <div className="journal-actions">
          <span className="muted small" role="status">
            {status || "Saves as you type"}
          </span>
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
