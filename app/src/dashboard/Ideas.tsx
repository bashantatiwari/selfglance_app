// Ideas: write a thought down fast, open it when you want to think about it. A closed idea shows
// only its first lines; clicking opens it in place, where the idea and its notes can be changed
// (saved as you type). Tell Bond "idea: …" anytime and it lands here.

import { useEffect, useRef, useState } from "react";
import { addIdea } from "../assistant/notes";
import { byRecent, type Idea } from "../assistant/ideacore";
import { patchIdea, removeIdea, restoreIdea, useIdeas } from "../assistant/ideas";
import { toast } from "./ui";

const when = (ms: number) => new Date(ms).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });

export default function Ideas() {
  const ideas = useIdeas();
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const shown = [...ideas].sort(byRecent);

  const add = () => {
    if (!draft.trim()) return;
    addIdea(draft);
    setDraft("");
    window.dispatchEvent(new Event("selfglance:ideas"));
  };

  const remove = (idea: Idea) => {
    const gone = removeIdea(idea.id);
    if (!gone) return;
    setOpen(null);
    toast("Idea deleted", { label: "Undo", run: () => restoreIdea(gone.idea, gone.index) });
  };

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Ideas</h1>
          <p className="muted">Write it down now, think later. Click an idea to open it.</p>
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
          <p className="muted">Type above, or say “idea: an app that sorts my downloads.”</p>
        </section>
      ) : (
        <ul className="idea-cards">
          {shown.map((i) => (
            <IdeaCard key={i.id} idea={i} open={open === i.id} onToggle={() => setOpen(open === i.id ? null : i.id)} onDelete={() => remove(i)} />
          ))}
        </ul>
      )}
    </>
  );
}

/** One idea: a closed line, or open with the text and notes to edit. Changes save by themselves. */
function IdeaCard(props: { idea: Idea; open: boolean; onToggle: () => void; onDelete: () => void }) {
  const { idea } = props;
  const [text, setText] = useState(idea.text);
  const [note, setNote] = useState(idea.note ?? "");
  const [saved, setSaved] = useState(false);
  const first = useRef(true);

  // Bond or another window changed it while it is closed: show that.
  useEffect(() => {
    if (!props.open) {
      setText(idea.text);
      setNote(idea.note ?? "");
    }
  }, [idea.text, idea.note, props.open]);

  // Save shortly after typing stops. An empty idea is never saved: the old text stays.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!props.open) return;
    const t = window.setTimeout(() => {
      const clean = text.trim();
      if (!clean) return;
      if (clean === idea.text && note === (idea.note ?? "")) return;
      if (patchIdea(idea.id, (x) => ({ ...x, text: clean, note: note.trim() ? note : undefined }))) {
        setSaved(true);
        window.setTimeout(() => setSaved(false), 1400);
      }
    }, 600);
    return () => clearTimeout(t);
  }, [text, note]);

  return (
    <li className={`${props.open ? "open" : ""} ${idea.done ? "done" : ""}`}>
      <div className="idea-row">
        <input type="checkbox" checked={idea.done} onChange={(e) => patchIdea(idea.id, (x) => ({ ...x, done: e.target.checked }))} aria-label="Done" />
        <button className="idea-head" onClick={props.onToggle} aria-expanded={props.open} title={props.open ? "Close" : "Open"}>
          <span className="idea-text">
            <span className="idea-title">{idea.text}</span>
            <small>
              {when(idea.at)}
              {idea.note ? " · has notes" : ""}
            </small>
          </span>
          <svg className="chev" viewBox="0 0 24 24" aria-hidden>
            <path d="M7 10l5 5 5-5" />
          </svg>
        </button>
      </div>
      {props.open && (
        <div className="idea-open">
          <label>
            <span>The idea</span>
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={600} aria-label="The idea" />
          </label>
          <label>
            <span>Notes</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={5} maxLength={4000} placeholder="What to look up, links, next steps, anything you want to remember about it…" aria-label="Notes" />
          </label>
          <div className="idea-foot">
            <span className={`saved ${saved ? "on" : ""}`}>✓ Saved</span>
            <span className="idea-actions">
              <button className="btn ghost danger" onClick={props.onDelete}>
                Delete
              </button>
              <button className="btn" onClick={props.onToggle}>
                Close
              </button>
            </span>
          </div>
        </div>
      )}
    </li>
  );
}
