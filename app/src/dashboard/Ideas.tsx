// Ideas: project ideas you told Bond ("idea: …") or typed here. Newest first;
// tick one off when you've started it, or remove it.

import { useEffect, useState } from "react";
import { addIdea, loadIdeas, saveIdeas, type Idea } from "../assistant/notes";
import { onTauriEvent } from "../platform";

const when = (ms: number) => new Date(ms).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });

export default function Ideas() {
  const [ideas, setIdeas] = useState<Idea[]>(loadIdeas);
  const [draft, setDraft] = useState("");
  useEffect(() => {
    const read = () => setIdeas(loadIdeas());
    const un = onTauriEvent<null>("notes-changed", read);
    window.addEventListener("focus", read);
    return () => {
      un.then((u) => u());
      window.removeEventListener("focus", read);
    };
  }, []);

  const update = (next: Idea[]) => {
    setIdeas(next);
    saveIdeas(next);
  };
  const add = () => {
    if (!draft.trim()) return;
    addIdea(draft);
    setIdeas(loadIdeas());
    setDraft("");
  };
  const open = ideas.filter((i) => !i.done);
  const started = ideas.filter((i) => i.done);

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Ideas</h1>
          <p className="muted">Tell Bond “idea: …” anytime, or add one here.</p>
        </div>
      </header>

      <form
        className="key-row"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input className="search idea-input" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="A project idea…" aria-label="New idea" />
        <button className="btn" disabled={!draft.trim()}>
          Add
        </button>
      </form>

      {ideas.length === 0 && <p className="muted">No ideas yet.</p>}
      <IdeaList ideas={open} onToggle={(id) => update(ideas.map((i) => (i.id === id ? { ...i, done: !i.done } : i)))} onRemove={(id) => update(ideas.filter((i) => i.id !== id))} />
      {started.length > 0 && (
        <section className="journal-past">
          <h2>Started</h2>
          <IdeaList ideas={started} onToggle={(id) => update(ideas.map((i) => (i.id === id ? { ...i, done: !i.done } : i)))} onRemove={(id) => update(ideas.filter((i) => i.id !== id))} />
        </section>
      )}
    </>
  );
}

function IdeaList(props: { ideas: Idea[]; onToggle: (id: string) => void; onRemove: (id: string) => void }) {
  if (!props.ideas.length) return null;
  return (
    <ul className="ideas">
      {props.ideas.map((i) => (
        <li key={i.id} className={i.done ? "done" : ""}>
          <input type="checkbox" checked={i.done} onChange={() => props.onToggle(i.id)} aria-label={i.done ? "Mark as not started" : "Mark as started"} />
          <div>
            <p>{i.text}</p>
            <small className="muted">{when(i.at)}</small>
          </div>
          <button className="btn ghost" onClick={() => props.onRemove(i.id)} aria-label="Remove idea">
            Remove
          </button>
        </li>
      ))}
    </ul>
  );
}
