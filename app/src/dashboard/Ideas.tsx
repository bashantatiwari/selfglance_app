// Ideas: capture a thought in one line, then give it a life. The list shows where every idea
// stands; opening one gives it a workbench (IdeaWorkbench) with an action plan, notes and Bond.
// Your original wording is never replaced: a short title is shown above it.

import { useMemo, useState } from "react";
import { addIdea } from "../assistant/notes";
import { byRecent, lastTouched, matches, STATUSES, statusOf, taskProgress, titleOf, withStatus, type Idea, type Status } from "../assistant/ideacore";
import { dropChat, loadChat, patchIdea, removeIdea, restoreIdea, saveChat, useIdeas } from "../assistant/ideas";
import IdeaWorkbench from "./IdeaWorkbench";
import { toast } from "./ui";

const when = (ms: number) => new Date(ms).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });

// Which idea is open survives going to another page and coming back.
let openId: string | null = null;

export default function Ideas() {
  const ideas = useIdeas();
  const [open, setOpenState] = useState<string | null>(openId);
  const setOpen = (id: string | null) => {
    openId = id;
    setOpenState(id);
  };
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [stage, setStage] = useState<Status | "all">("all");
  const [starred, setStarred] = useState(false);

  const shown = useMemo(() => ideas.filter((i) => matches(i, { status: stage, starred, query })).sort(byRecent), [ideas, stage, starred, query]);
  const count = (s: Status | "all") => (s === "all" ? ideas.length : ideas.filter((i) => statusOf(i) === s).length);

  if (open) return <IdeaWorkbench id={open} onBack={() => setOpen(null)} />;

  const add = () => {
    if (!draft.trim()) return;
    addIdea(draft);
    setDraft("");
    window.dispatchEvent(new Event("selfglance:ideas"));
  };

  const filtered = stage !== "all" || starred || query.trim() !== "";

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Ideas</h1>
          <p className="muted">Capture it now. Explore it, plan it, build it when it's ready. Tell Bond “idea: …” anytime.</p>
        </div>
      </header>

      <form
        className="capture"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input className="capture-input" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Capture a thought…" aria-label="New idea" />
        <button className="btn" disabled={!draft.trim()}>
          Add idea
        </button>
      </form>

      {ideas.length > 0 && (
        <div className="idea-filters">
          <div className="tabs" role="tablist" aria-label="Stage">
            {(
              [
                ["all", "All"],
                ...STATUSES.map((s) => [s.id, s.name] as const),
              ] as const
            ).map(([id, name]) => (
              <button key={id} role="tab" aria-selected={stage === id} className={stage === id ? "on" : ""} onClick={() => setStage(id)}>
                {name} <span className="count">{count(id)}</span>
              </button>
            ))}
          </div>
          <button className={`chip star-chip ${starred ? "on" : ""}`} onClick={() => setStarred((s) => !s)} aria-pressed={starred}>
            ★ Starred <span className="count">{ideas.filter((i) => i.starred).length}</span>
          </button>
          <input className="search" placeholder="Search ideas and notes…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search ideas" />
        </div>
      )}

      {ideas.length === 0 && (
        <section className="empty-state">
          <h2>Nothing captured yet</h2>
          <p className="muted">Type above, or just say it: “Hey Bond, idea: an app that sorts my downloads.” Every idea gets its own workbench with notes, a plan and Bond to think it through with.</p>
        </section>
      )}
      {ideas.length > 0 && shown.length === 0 && (
        <section className="empty-state">
          <h2>No idea matches</h2>
          <p className="muted">Nothing fits {query.trim() ? `“${query.trim()}”` : "these filters"}.</p>
          {filtered && (
            <button
              className="btn ghost"
              onClick={() => {
                setStage("all");
                setStarred(false);
                setQuery("");
              }}
            >
              Clear filters
            </button>
          )}
        </section>
      )}

      {shown.length > 0 && (
        <ul className="idea-grid">
          {shown.map((i) => (
            <Card key={i.id} idea={i} onOpen={() => setOpen(i.id)} />
          ))}
        </ul>
      )}
    </>
  );
}

function Card({ idea, onOpen }: { idea: Idea; onOpen: () => void }) {
  const status = statusOf(idea);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(titleOf(idea));
  const [text, setText] = useState(idea.text);
  const [confirm, setConfirm] = useState(false);
  const { done, total } = taskProgress(idea);
  const talks = loadChat(idea.id).length;
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

  const saveEdit = () => {
    const nextText = text.trim();
    const nextTitle = title.trim();
    if (!nextText) return;
    patchIdea(idea.id, (i) => ({ ...i, text: nextText, title: nextTitle && nextTitle !== titleOf({ ...i, title: undefined, text: nextText }) ? nextTitle : undefined, updatedAt: Date.now() }));
    setEditing(false);
  };

  const remove = () => {
    const gone = removeIdea(idea.id);
    if (!gone) return;
    const chat = loadChat(idea.id);
    let back = false;
    window.setTimeout(() => {
      if (!back) dropChat(idea.id);
    }, 8000);
    toast("Idea deleted", {
      label: "Undo",
      run: () => {
        back = true;
        restoreIdea(gone.idea, gone.index);
        saveChat(idea.id, chat);
      },
    });
  };

  if (editing) {
    return (
      <li className={`icard editing st-${status}`}>
        <input className="capture-input" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" />
        <textarea className="wb-edit" value={text} rows={Math.min(8, Math.max(3, Math.ceil(text.length / 48)))} onChange={(e) => setText(e.target.value)} aria-label="Original description" autoFocus />
        <div className="assistant-form-row">
          <button
            className="linkish"
            onClick={() => {
              setEditing(false);
              setTitle(titleOf(idea));
              setText(idea.text);
            }}
          >
            Cancel
          </button>
          <button className="btn" onClick={saveEdit} disabled={!text.trim()}>
            Save
          </button>
        </div>
      </li>
    );
  }

  return (
    <li className={`icard st-${status}`} onClick={onOpen}>
      <div className="icard-top" onClick={stop}>
        <select className={`status-select st-${status}`} value={status} onChange={(e) => patchIdea(idea.id, (i) => withStatus(i, e.target.value as Status))} aria-label="Stage">
          {STATUSES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <button className={`icon-btn star ${idea.starred ? "on" : ""}`} onClick={() => patchIdea(idea.id, (i) => ({ ...i, starred: !i.starred, updatedAt: Date.now() }))} aria-pressed={!!idea.starred} aria-label={idea.starred ? "Remove star" : "Star this idea"} title={idea.starred ? "Starred" : "Star"}>
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.9 6.8 19.7l1-5.9L3.5 9.7l5.9-.8z" />
          </svg>
        </button>
      </div>
      <h3 className="icard-title">
        <button className="title-btn" onClick={(e) => (stop(e), onOpen())}>
          {titleOf(idea)}
        </button>
      </h3>
      <p className="icard-text" title={idea.text}>
        {idea.text}
      </p>
      <div className="icard-meta">
        <span>{idea.updatedAt && idea.updatedAt !== idea.at ? `Updated ${when(lastTouched(idea))}` : `Captured ${when(idea.at)}`}</span>
        {total > 0 && (
          <span className="mini-progress" title={`${done} of ${total} steps done`}>
            <i style={{ width: `${(done / total) * 100}%` }} />
            <b>
              {done}/{total} steps
            </b>
          </span>
        )}
        {talks > 0 && <span>{talks} messages with Bond</span>}
      </div>
      <div className="icard-foot" onClick={stop}>
        {confirm ? (
          <span className="confirm-inline">
            Delete this idea?
            <button className="btn danger" onClick={remove}>
              Delete
            </button>
            <button className="btn ghost" onClick={() => setConfirm(false)}>
              Keep
            </button>
          </span>
        ) : (
          <>
            <button className="btn" onClick={onOpen}>
              Open workbench
            </button>
            <div className="row-actions">
              <button className="icon-btn" onClick={() => setEditing(true)} aria-label="Edit idea" title="Edit">
                <svg viewBox="0 0 24 24" aria-hidden>
                  <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z" />
                </svg>
              </button>
              <button className="icon-btn danger" onClick={() => setConfirm(true)} aria-label="Delete idea" title="Delete">
                <svg viewBox="0 0 24 24" aria-hidden>
                  <path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13" />
                </svg>
              </button>
            </div>
          </>
        )}
      </div>
    </li>
  );
}
