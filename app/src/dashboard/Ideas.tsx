// Ideas: project ideas you told Bond ("idea: …") or typed here. Newest first;
// tick one off when you've started it. Search, filter, edit in place, and remove with Undo.

import { useEffect, useMemo, useState } from "react";
import { addIdea, loadIdeas, saveIdeas, type Idea } from "../assistant/notes";
import { onTauriEvent } from "../platform";
import { toast } from "./ui";
import IdeaChat from "./IdeaChat";

const when = (ms: number) => new Date(ms).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });

type Filter = "all" | "active" | "started";

export default function Ideas() {
  const [ideas, setIdeas] = useState<Idea[]>(loadIdeas);
  const [draft, setDraft] = useState("");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [editing, setEditing] = useState<string | null>(null);
  const [edit, setEdit] = useState("");
  const [chatId, setChatId] = useState<string | null>(null);
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
  const remove = (id: string) => {
    if (chatId === id) setChatId(null);
    const before = ideas;
    update(ideas.filter((i) => i.id !== id));
    toast("Idea removed", { label: "Undo", run: () => update(before) });
  };
  const commitEdit = () => {
    if (editing && edit.trim()) update(ideas.map((i) => (i.id === editing ? { ...i, text: edit.trim() } : i)));
    setEditing(null);
  };

  const chatIdea = ideas.find((i) => i.id === chatId) ?? null;
  const counts = { all: ideas.length, active: ideas.filter((i) => !i.done).length, started: ideas.filter((i) => i.done).length };
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return ideas.filter((i) => (filter === "all" || (filter === "active" ? !i.done : i.done)) && (!needle || i.text.toLowerCase().includes(needle)));
  }, [ideas, q, filter]);

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Ideas</h1>
          <p className="muted">Tell Bond “idea: …” anytime, or add one here.</p>
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
        <div className="toolbar tight">
          <div className="tabs" role="tablist">
            {(
              [
                ["all", "All"],
                ["active", "Active"],
                ["started", "Started"],
              ] as const
            ).map(([id, name]) => (
              <button key={id} role="tab" aria-selected={filter === id} className={filter === id ? "on" : ""} onClick={() => setFilter(id)}>
                {name} <span className="count">{counts[id]}</span>
              </button>
            ))}
          </div>
          <input className="search" placeholder="Search ideas…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search ideas" />
        </div>
      )}

      {ideas.length === 0 && (
        <section className="empty-state">
          <h2>Nothing captured yet</h2>
          <p className="muted">Type above, or just say it: “Hey Bond, idea: an app that sorts my downloads.” Ideas stay on this computer.</p>
        </section>
      )}
      {ideas.length > 0 && shown.length === 0 && <p className="muted">Nothing matches.</p>}

      {shown.length > 0 && (
        <div className={`explorer ${chatIdea ? "with-detail" : ""}`}>
        <ul className="idea-list">
          {shown.map((i) => (
            <li key={i.id} className={i.done ? "done" : ""}>
              <label className="check">
                <input type="checkbox" checked={i.done} onChange={() => update(ideas.map((x) => (x.id === i.id ? { ...x, done: !x.done } : x)))} aria-label={i.done ? "Mark as not started" : "Mark as started"} />
                <span aria-hidden />
              </label>
              <div className="idea-main">
                {editing === i.id ? (
                  <textarea
                    className="idea-edit"
                    value={edit}
                    autoFocus
                    rows={Math.min(6, Math.max(2, Math.ceil(edit.length / 90)))}
                    onChange={(e) => setEdit(e.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setEditing(null);
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        commitEdit();
                      }
                    }}
                  />
                ) : (
                  <p
                    title="Double-click to edit"
                    onDoubleClick={() => {
                      setEditing(i.id);
                      setEdit(i.text);
                    }}
                  >
                    {i.text}
                  </p>
                )}
                <small className="muted">
                  <button className="linkish discuss" onClick={() => setChatId(chatId === i.id ? null : i.id)}>
                    Talk it through
                  </button>
                  {" · "}
                  {when(i.at)}
                  {i.done && " · started"}
                </small>
              </div>
              <div className="row-actions">
                <button className={`icon-btn ${chatId === i.id ? "on" : ""}`} onClick={() => setChatId(chatId === i.id ? null : i.id)} aria-label="Talk this idea through with Bond" title="Talk it through with Bond">
                  <svg viewBox="0 0 24 24" aria-hidden>
                    <path d="M4 5h16v11H9l-5 4z" />
                  </svg>
                </button>
                <button
                  className="icon-btn"
                  onClick={() => {
                    setEditing(i.id);
                    setEdit(i.text);
                  }}
                  aria-label="Edit idea"
                  title="Edit"
                >
                  <svg viewBox="0 0 24 24" aria-hidden>
                    <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z" />
                  </svg>
                </button>
                <button className="icon-btn danger" onClick={() => remove(i.id)} aria-label="Remove idea" title="Remove">
                  <svg viewBox="0 0 24 24" aria-hidden>
                    <path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13" />
                  </svg>
                </button>
              </div>
            </li>
          ))}
        </ul>
        {chatIdea && <IdeaChat idea={chatIdea} onClose={() => setChatId(null)} />}
        </div>
      )}
    </>
  );
}
