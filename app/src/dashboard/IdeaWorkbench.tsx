// One idea, opened up: the idea as you wrote it, where it stands, an action plan, your own notes,
// and Bond beside it (Explore / Plan / Saved). Everything is saved to the idea as you go.

import { useEffect, useRef, useState } from "react";
import { newId, STATUSES, statusOf, taskProgress, titleOf, withStatus, type Idea, type Status } from "../assistant/ideacore";
import { dropChat, loadChat, patchIdea, removeIdea, restoreIdea, saveChat, useIdeas } from "../assistant/ideas";
import IdeaAssistant from "./IdeaAssistant";
import { toast } from "./ui";

const day = (ms: number) => new Date(ms).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });

export default function IdeaWorkbench({ id, onBack }: { id: string; onBack: () => void }) {
  const idea = useIdeas().find((i) => i.id === id);
  if (!idea) {
    return (
      <section className="empty-state">
        <h2>This idea isn't here any more</h2>
        <p className="muted">It may have been removed in another window.</p>
        <button className="btn" onClick={onBack}>
          Back to all ideas
        </button>
      </section>
    );
  }
  return <Body key={id} idea={idea} onBack={onBack} />;
}

function Body({ idea, onBack }: { idea: Idea; onBack: () => void }) {
  const id = idea.id;
  const status = statusOf(idea);
  const [title, setTitle] = useState(titleOf(idea));
  const [editingText, setEditingText] = useState(false);
  const [text, setText] = useState(idea.text);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [task, setTask] = useState("");
  const [editingTask, setEditingTask] = useState<string | null>(null);
  const [taskText, setTaskText] = useState("");
  const [notes, setNotes] = useState(idea.notes ?? "");
  const [notesState, setNotesState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const notesRef = useRef(notes);
  const savedNotes = useRef(idea.notes ?? "");
  notesRef.current = notes;

  // Back with Escape (unless you're typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.key === "Escape" && !(el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  // Your notes save a moment after you stop typing, and on the way out.
  const flushNotes = () => {
    const value = notesRef.current;
    if (value === savedNotes.current) return;
    setNotesState("saving");
    const ok = patchIdea(id, (i) => ({ ...i, notes: value, updatedAt: Date.now() }));
    if (ok) savedNotes.current = value;
    setNotesState(ok ? "saved" : "error");
  };
  useEffect(() => {
    if (notes === savedNotes.current) return;
    const t = window.setTimeout(flushNotes, 700);
    return () => clearTimeout(t);
  }, [notes]);
  useEffect(
    () => () => {
      // Leaving: write whatever is left (the component is gone, so no state is touched).
      const value = notesRef.current;
      if (value !== savedNotes.current) patchIdea(id, (i) => ({ ...i, notes: value, updatedAt: Date.now() }));
    },
    [id],
  );

  const commitTitle = () => {
    const next = title.trim();
    if (next === titleOf(idea)) return;
    if (!next) return setTitle(titleOf(idea)); // can't be empty: keep the derived one
    patchIdea(id, (i) => ({ ...i, title: next, updatedAt: Date.now() }));
  };

  const saveText = () => {
    const next = text.trim();
    if (!next) return setText(idea.text);
    patchIdea(id, (i) => ({ ...i, text: next, updatedAt: Date.now() }));
    setEditingText(false);
  };

  const setStatus = (s: Status) => patchIdea(id, (i) => withStatus(i, s));

  const remove = () => {
    const gone = removeIdea(id);
    if (!gone) return;
    const chat = loadChat(id);
    let back = false;
    onBack();
    // The conversation goes only after the Undo window has passed.
    window.setTimeout(() => {
      if (!back) dropChat(id);
    }, 8000);
    toast("Idea deleted", {
      label: "Undo",
      run: () => {
        back = true;
        restoreIdea(gone.idea, gone.index);
        saveChat(id, chat);
      },
    });
  };

  const addTask = () => {
    const t = task.trim();
    if (!t) return;
    if (patchIdea(id, (i) => ({ ...i, tasks: [...(i.tasks ?? []), { id: newId(), text: t, done: false, at: Date.now() }], updatedAt: Date.now() }))) setTask("");
    else toast("Couldn't save that. Storage may be full.");
  };
  const toggleTask = (tid: string) => patchIdea(id, (i) => ({ ...i, tasks: (i.tasks ?? []).map((t) => (t.id === tid ? { ...t, done: !t.done } : t)), updatedAt: Date.now() }));
  const commitTask = () => {
    if (editingTask && taskText.trim()) patchIdea(id, (i) => ({ ...i, tasks: (i.tasks ?? []).map((t) => (t.id === editingTask ? { ...t, text: taskText.trim() } : t)) }));
    setEditingTask(null);
  };
  const removeTask = (tid: string) => {
    const before = idea.tasks ?? [];
    patchIdea(id, (i) => ({ ...i, tasks: (i.tasks ?? []).filter((t) => t.id !== tid) }));
    toast("Task removed", { label: "Undo", run: () => void patchIdea(id, (i) => ({ ...i, tasks: before })) });
  };

  const { done, total } = taskProgress(idea);
  const tasks = idea.tasks ?? [];
  const hint = STATUSES.find((s) => s.id === status)!.hint;

  return (
    <div className="workbench">
      <header className="wb-top panel">
        <div className="wb-top-row">
          <button className="linkish back" onClick={onBack}>
            ← All ideas
          </button>
          <div className="wb-top-actions">
            <button className={`icon-btn star ${idea.starred ? "on" : ""}`} onClick={() => patchIdea(id, (i) => ({ ...i, starred: !i.starred, updatedAt: Date.now() }))} aria-pressed={!!idea.starred} aria-label={idea.starred ? "Remove star" : "Star this idea"} title={idea.starred ? "Starred" : "Star"}>
              <svg viewBox="0 0 24 24" aria-hidden>
                <path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.9 6.8 19.7l1-5.9L3.5 9.7l5.9-.8z" />
              </svg>
            </button>
            {confirmDelete ? (
              <span className="confirm-inline">
                Delete this idea?
                <button className="btn danger" onClick={remove}>
                  Delete
                </button>
                <button className="btn ghost" onClick={() => setConfirmDelete(false)}>
                  Keep
                </button>
              </span>
            ) : (
              <button className="icon-btn danger" onClick={() => setConfirmDelete(true)} aria-label="Delete idea" title="Delete">
                <svg viewBox="0 0 24 24" aria-hidden>
                  <path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13" />
                </svg>
              </button>
            )}
          </div>
        </div>
        <input
          className="wb-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") setTitle(titleOf(idea));
          }}
          aria-label="Idea title"
        />
        <div className="stage-row" role="radiogroup" aria-label="Where this idea stands">
          {STATUSES.map((s) => (
            <button key={s.id} role="radio" aria-checked={status === s.id} className={`stage st-${s.id} ${status === s.id ? "on" : ""}`} onClick={() => setStatus(s.id)}>
              {s.name}
            </button>
          ))}
        </div>
        <p className="muted small wb-meta">
          {hint} · Captured {day(idea.at)}
          {idea.updatedAt && idea.updatedAt !== idea.at ? ` · Updated ${day(idea.updatedAt)}` : ""}
        </p>
      </header>

      <div className="wb-grid">
        <div className="wb-main">
          <section className="panel">
            <div className="panel-head">
              <h2>The idea</h2>
              {!editingText && (
                <button className="linkish" onClick={() => (setText(idea.text), setEditingText(true))}>
                  Edit
                </button>
              )}
            </div>
            {editingText ? (
              <>
                <textarea className="wb-edit" value={text} rows={Math.min(10, Math.max(3, Math.ceil(text.length / 90)))} onChange={(e) => setText(e.target.value)} autoFocus aria-label="Idea description" />
                <div className="assistant-form-row">
                  <button className="linkish" onClick={() => setEditingText(false)}>
                    Cancel
                  </button>
                  <button className="btn" onClick={saveText} disabled={!text.trim()}>
                    Save
                  </button>
                </div>
              </>
            ) : (
              <p className="wb-original">{idea.text}</p>
            )}
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Action plan</h2>
              <span className="muted small">{total ? `${done} of ${total} done` : "No steps yet"}</span>
            </div>
            {total > 0 && (
              <div className="progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
                <i style={{ width: `${(done / total) * 100}%` }} />
              </div>
            )}
            {tasks.length === 0 && <p className="muted small">Add the steps yourself, or open Bond's Plan tab and approve the ones you want.</p>}
            <ul className="task-list">
              {tasks.map((t) => (
                <li key={t.id} className={t.done ? "done" : ""}>
                  <label className="check">
                    <input type="checkbox" checked={t.done} onChange={() => toggleTask(t.id)} aria-label={t.done ? "Mark step as not done" : "Mark step as done"} />
                    <span aria-hidden />
                  </label>
                  {editingTask === t.id ? (
                    <input
                      className="task-edit"
                      value={taskText}
                      autoFocus
                      onChange={(e) => setTaskText(e.target.value)}
                      onBlur={commitTask}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitTask();
                        if (e.key === "Escape") setEditingTask(null);
                      }}
                    />
                  ) : (
                    <span
                      className="task-text"
                      title="Double-click to edit"
                      onDoubleClick={() => {
                        setEditingTask(t.id);
                        setTaskText(t.text);
                      }}
                    >
                      {t.text}
                    </span>
                  )}
                  <button className="icon-btn danger" onClick={() => removeTask(t.id)} aria-label="Remove step" title="Remove">
                    <svg viewBox="0 0 24 24" aria-hidden>
                      <path d="M6 6l12 12M18 6 6 18" />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
            <form
              className="task-add"
              onSubmit={(e) => {
                e.preventDefault();
                addTask();
              }}
            >
              <input className="capture-input" value={task} onChange={(e) => setTask(e.target.value)} placeholder="Add a step…" aria-label="New step" />
              <button className="btn" disabled={!task.trim()}>
                Add
              </button>
            </form>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>My notes</h2>
              <span className={`save-pill ${notesState}`} role="status">
                {notesState !== "idle" && <i aria-hidden />}
                {{ idle: "", saving: "Saving…", saved: "Saved", error: "Couldn't save — your text is still here" }[notesState]}
              </span>
            </div>
            <textarea className="wb-notes" value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={flushNotes} placeholder="Your own research, links, thoughts. Only you see this; it isn't sent to a cloud brain." aria-label="My notes" />
          </section>
        </div>

        <IdeaAssistant idea={idea} />
      </div>
    </div>
  );
}
