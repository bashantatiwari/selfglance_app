// Ideas: somewhere to write a thought down fast, and nothing more. Newest first; tick it off or
// delete it (with undo). Tell Bond "idea: …" anytime and it lands here.

import { useState } from "react";
import { addIdea } from "../assistant/notes";
import { byRecent, type Idea } from "../assistant/ideacore";
import { patchIdea, removeIdea, restoreIdea, useIdeas } from "../assistant/ideas";
import { toast } from "./ui";

const when = (ms: number) => new Date(ms).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });

export default function Ideas() {
  const ideas = useIdeas();
  const [draft, setDraft] = useState("");
  const shown = [...ideas].sort(byRecent);

  const add = () => {
    if (!draft.trim()) return;
    addIdea(draft);
    setDraft("");
    window.dispatchEvent(new Event("selfglance:ideas"));
  };

  const remove = (idea: Idea) => {
    const gone = removeIdea(idea.id);
    if (gone) toast("Idea deleted", { label: "Undo", run: () => restoreIdea(gone.idea, gone.index) });
  };

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Ideas</h1>
          <p className="muted">Write it down now, think later. Tell Bond “idea: …” anytime and it lands here.</p>
        </div>
      </header>

      <form
        className="capture"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input className="capture-input" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Capture a thought…" aria-label="New idea" autoFocus />
        <button className="btn" disabled={!draft.trim()}>
          Add idea
        </button>
      </form>

      {shown.length === 0 ? (
        <section className="empty-state">
          <h2>Nothing captured yet</h2>
          <p className="muted">Type above, or say “Hey Bond, idea: an app that sorts my downloads.”</p>
        </section>
      ) : (
        <ul className="idea-list">
          {shown.map((i) => (
            <li key={i.id} className={i.done ? "done" : ""}>
              <label className="idea-check">
                <input type="checkbox" checked={i.done} onChange={(e) => patchIdea(i.id, (x) => ({ ...x, done: e.target.checked }))} aria-label="Done" />
              </label>
              <div className="idea-body">
                <p>{i.text}</p>
                <small>{when(i.at)}</small>
              </div>
              <button className="icon-btn danger" onClick={() => remove(i)} aria-label="Delete idea" title="Delete">
                <svg viewBox="0 0 24 24" aria-hidden>
                  <path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
