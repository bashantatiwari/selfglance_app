// Journal: at the end of the day, type about your whole day (laptop or not). It saves as
// you type, one file per day (journal.rs). Past entries are listed below, newest first.
// "log …" to Bond appends a timestamped line; an open Journal picks it up right away.

import { useEffect, useMemo, useRef, useState } from "react";
import { dayKey, JOURNAL_FIRST_WORDS, journalGet, journalList, journalSet, journalSkips, journalWordsAll, journalWritten } from "../assistant/notes";
import { loadSettings } from "../settings";
import { onTauriEvent } from "../platform";

/** Save this long after the last keystroke. */
const SAVE_AFTER_MS = 700;

const pretty = (day: string) =>
  new Date(`${day}T12:00:00`).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" });
const month = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString([], { month: "long", year: "numeric" });
const words = (t: string) => (t.trim() ? t.trim().split(/\s+/).length : 0);

/** Gentle starting points; clicking one adds it to the entry as a heading to write under. */
const PROMPTS = ["What went well today?", "What drained my energy?", "Something I'm grateful for", "What I'll do first tomorrow"];

type SaveState = "idle" | "saving" | "saved" | "error";

export default function Journal() {
  const today = dayKey();
  const [text, setText] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [past, setPast] = useState<{ day: string; text: string }[]>([]);
  const [state, setState] = useState<SaveState>("idle");
  const [find, setFind] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const savedRef = useRef("");
  const textRef = useRef("");
  const areaRef = useRef<HTMLTextAreaElement>(null);
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

  const status = { idle: "", saving: "Saving…", saved: "Saved", error: "Couldn't save — your text is still here" }[state];

  const addPrompt = (p: string) => {
    const base = text.trimEnd();
    setText(`${base}${base ? "\n\n" : ""}${p}\n`);
    requestAnimationFrame(() => {
      const el = areaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  };

  // Your streak: consecutive days with something written, counting back from today (or from
  // yesterday while today is still empty). Skips are the days you chose "Not tonight".
  const { streak, skips } = useMemo(() => {
    const p = (n: number) => String(n).padStart(2, "0");
    const key = (d: Date) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    const written = new Set(past.filter((e) => journalWritten(e.text)).map((e) => e.day));
    if (journalWritten(text)) written.add(today);
    const d = new Date();
    if (!written.has(key(d))) d.setDate(d.getDate() - 1);
    let n = 0;
    while (written.has(key(d))) {
      n++;
      d.setDate(d.getDate() - 1);
    }
    const since = new Date();
    since.setDate(since.getDate() - 14);
    return { streak: n, skips: journalSkips().filter((x) => x >= key(since)).length };
  }, [past, text, today]);
  const st = loadSettings();
  const total = journalWordsAll(text);
  const gateOn = st.journalFirst && new Date().getHours() >= st.journalAt;

  // Earlier entries, filtered by the search box, grouped by month.
  const groups = useMemo(() => {
    const q = find.trim().toLowerCase();
    const shown = past.filter((e) => !q || e.text.toLowerCase().includes(q) || pretty(e.day).toLowerCase().includes(q));
    const out: { month: string; entries: typeof shown }[] = [];
    for (const e of shown) {
      const m = month(e.day);
      const last = out[out.length - 1];
      if (last && last.month === m) last.entries.push(e);
      else out.push({ month: m, entries: [e] });
    }
    return out;
  }, [past, find]);

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Journal</h1>
          <p className="muted">{pretty(today)}</p>
        </div>
        <span className={`save-pill ${state}`} role="status">
          {status && <i aria-hidden />}
          {status}
        </span>
      </header>

      <section className="journal-today">
        <div className="prompt-row" aria-label="Writing prompts">
          {PROMPTS.map((p) => (
            <button key={p} className="chip" onClick={() => addPrompt(p)} disabled={!loaded}>
              {p}
            </button>
          ))}
        </div>
        <textarea
          ref={areaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={!loaded}
          placeholder="How did today go? What did you do, on and off the laptop?"
          aria-label="Today's journal entry"
        />
        <div className="journal-actions">
          {gateOn && (
            <span className={`goal-pill ${total >= JOURNAL_FIRST_WORDS ? "done" : ""}`}>
              {total >= JOURNAL_FIRST_WORDS ? "✓ Done for tonight" : `${total} / ${JOURNAL_FIRST_WORDS} words to finish tonight`}
            </span>
          )}
          <span className="muted small">
            {words(text)} {words(text) === 1 ? "word" : "words"} · saves as you type · stays on this computer
          </span>
          {(streak > 0 || skips > 0) && (
            <span className="muted small grow">
              {streak > 0 ? `${streak}-day streak` : "No streak yet"}
              {skips > 0 ? ` · ${skips} skipped in the last 14 days` : ""}
            </span>
          )}
        </div>
        <p className="muted small dictate">Prefer talking? Say “Hey Bond, log: …” and it's added here. Dictated lines count toward tonight's {JOURNAL_FIRST_WORDS} words.</p>
      </section>

      {past.length > 0 && (
        <section className="journal-past">
          <div className="section-head">
            <h2>Earlier</h2>
            <input className="search" placeholder="Search your entries…" value={find} onChange={(e) => setFind(e.target.value)} aria-label="Search entries" />
          </div>
          {groups.length === 0 && <p className="muted">No entry matches “{find}”.</p>}
          {groups.map((g) => (
            <div key={g.month} className="month">
              <h3 className="month-name">{g.month}</h3>
              {g.entries.map((e) => {
                const long = e.text.length > 280 || e.text.split("\n").length > 4;
                const expanded = open[e.day];
                return (
                  <article key={e.day}>
                    <h4>{pretty(e.day)}</h4>
                    <p className={long && !expanded ? "clamp" : ""}>{e.text}</p>
                    {long && (
                      <button className="linkish" onClick={() => setOpen((o) => ({ ...o, [e.day]: !expanded }))}>
                        {expanded ? "Show less" : "Read more"}
                      </button>
                    )}
                  </article>
                );
              })}
            </div>
          ))}
        </section>
      )}
    </>
  );
}
