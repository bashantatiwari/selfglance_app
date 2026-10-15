// Bond beside an idea, in three parts:
//   Explore  talk the idea through: feasibility, assumptions, alternatives, risks, or anything.
//   Plan     ask for tasks, an MVP or experiments; nothing is added until you approve it.
//   Saved    what you chose to keep (findings, decisions, references, notes), to come back to.
// It uses the brain chosen in Settings. None of them can browse the web here, and the panel says so.

import { useEffect, useRef, useState } from "react";
import { aiText } from "../ai";
import { newId, parseTasks, SAVED_KINDS, statusOf, titleOf, type Idea, type SavedKind } from "../assistant/ideacore";
import { dropChat, loadChat, patchIdea, saveChat, type Msg } from "../assistant/ideas";
import { loadIdeas } from "../assistant/notes";
import { loadSettings } from "../settings";
import { toast } from "./ui";

type Tab = "explore" | "plan" | "saved";

const BRAIN: Record<string, string> = { local: "the brain on this laptop", gemini: "Google Gemini", claude: "Claude" };

const SYSTEM =
  "You are Bond, a thoughtful thinking partner helping the user develop one idea. " +
  "Be concrete and useful, and say what would make it work or fail. " +
  "You cannot browse the web or look anything up. If something depends on facts, current rules, prices or numbers you aren't sure of, say so plainly and say what to verify; " +
  "never invent statistics, studies, laws or sources. Keep answers under 180 words, end with one question or next step. Plain text, no markdown headings.";

const PLAN_SYSTEM =
  "You are Bond, helping the user turn one idea into doable work. " +
  "Reply with ONLY a list: one task per line, each line starting with '- ', each under 14 words, concrete and doable by one person, between 4 and 8 lines. No introduction, no closing remarks.";

const EXPLORE: { label: string; ask: string }[] = [
  { label: "Is it feasible?", ask: "Assess feasibility: what has to be true for this to work, roughly how much effort it is, and the main obstacles." },
  { label: "Find assumptions", ask: "List the 3 to 5 riskiest assumptions behind this idea and a cheap way to test each one." },
  { label: "Explore alternatives", ask: "Suggest 3 different ways to approach or reshape this idea, with the trade-off of each." },
  { label: "Risks and limits", ask: "List the key risks and limitations (technical, legal or safety, adoption) and what I should verify myself." },
];

const PLAN: { label: string; ask: string }[] = [
  { label: "Next steps", ask: "What are the best next steps, in order, to move this idea forward this week?" },
  { label: "Break into tasks", ask: "Break this idea into small tasks I can tick off." },
  { label: "Define an MVP", ask: "Define the smallest useful version (MVP) as a list of tasks to build it." },
  { label: "Suggest experiments", ask: "Suggest quick experiments that would show whether this idea is worth building." },
];

// What you were doing in each idea's panel survives switching to another idea and back.
const tabMemory = new Map<string, Tab>();
const draftMemory = new Map<string, string>();

const fresh = (idea: Idea) => loadIdeas().find((i) => i.id === idea.id) ?? idea;

/** What Bond is told about the idea. Your personal notes are only included for the brain on this laptop. */
function context(idea: Idea, provider: string): string {
  const i = fresh(idea);
  const out = [`The idea (as the user wrote it): ${i.text}`, `Title: ${titleOf(i)}`, `Stage: ${statusOf(i)}`];
  const tasks = (i.tasks ?? []).map((t) => `${t.done ? "[x]" : "[ ]"} ${t.text}`);
  if (tasks.length) out.push(`Current plan:\n${tasks.join("\n")}`);
  const decisions = (i.saved ?? []).filter((s) => s.kind === "decision").map((s) => `- ${s.text}`);
  if (decisions.length) out.push(`Decisions so far:\n${decisions.join("\n")}`);
  if (provider === "local" && i.notes?.trim()) out.push(`The user's own notes:\n${i.notes.trim().slice(0, 1500)}`);
  return out.join("\n\n");
}

export default function IdeaAssistant({ idea }: { idea: Idea }) {
  const id = idea.id;
  const provider = loadSettings().aiProvider;
  const [tab, setTab] = useState<Tab>(tabMemory.get(id) ?? "explore");
  const [msgs, setMsgs] = useState<Msg[]>(() => loadChat(id));
  const [draft, setDraft] = useState(draftMemory.get(id) ?? "");
  const [busy, setBusy] = useState<null | "explore" | "plan">(null);
  const [err, setErr] = useState("");
  const [raw, setRaw] = useState("");
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [kind, setKind] = useState<SavedKind>("finding");
  const [entry, setEntry] = useState("");
  const [only, setOnly] = useState<SavedKind | "all">("all");
  const mounted = useRef(true);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    tabMemory.set(id, tab);
  }, [id, tab]);
  useEffect(() => {
    draftMemory.set(id, draft);
  }, [id, draft]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [msgs, busy, tab]);

  const saved = idea.saved ?? [];
  const proposals = idea.proposals ?? [];

  // --- Explore -------------------------------------------------------------------------------
  const explore = async (shown: string, instruction: string) => {
    if (busy || !instruction.trim()) return;
    const asked: Msg[] = [...loadChat(id), { role: "you", text: shown }];
    saveChat(id, asked);
    setMsgs(asked);
    setDraft("");
    setBusy("explore");
    setErr("");
    const history = asked
      .slice(-11, -1)
      .map((m) => `${m.role === "you" ? "User" : "Bond"}: ${m.text}`)
      .join("\n");
    try {
      const reply = await aiText(SYSTEM, `${context(idea, provider)}\n\n${history ? `Conversation so far:\n${history}\n\n` : ""}User: ${instruction}`);
      // Written to storage first, so it is kept even if you have gone to another idea meanwhile.
      const done: Msg[] = [...loadChat(id), { role: "bond", text: reply.trim() || "I don't have anything useful to add to that." }];
      saveChat(id, done);
      if (mounted.current) setMsgs(done);
    } catch (e) {
      if (mounted.current) setErr(String(e));
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const keep = (index: number, as: SavedKind) => {
    const m = msgs[index];
    if (!m || m.role !== "bond" || m.savedAs) return;
    const ok = patchIdea(id, (i) => ({ ...i, saved: [{ id: newId(), kind: as, text: m.text, at: Date.now(), from: "bond" }, ...(i.saved ?? [])], updatedAt: Date.now() }));
    if (!ok) return toast("Couldn't save that. Storage may be full.");
    const next = msgs.map((x, k) => (k === index ? { ...x, savedAs: as } : x));
    setMsgs(next);
    saveChat(id, next);
    toast(`Saved as a ${as}`);
  };

  const clearChat = () => {
    const before = msgs;
    setMsgs([]);
    dropChat(id);
    toast("Conversation cleared", {
      label: "Undo",
      run: () => {
        saveChat(id, before);
        if (mounted.current) setMsgs(before);
      },
    });
  };

  // --- Plan ----------------------------------------------------------------------------------
  const plan = async (instruction: string) => {
    if (busy) return;
    setBusy("plan");
    setErr("");
    setRaw("");
    try {
      const reply = await aiText(PLAN_SYSTEM, `${context(idea, provider)}\n\n${instruction}`);
      const existing = (fresh(idea).tasks ?? []).map((t) => t.text);
      const items = parseTasks(reply, existing);
      if (!items.length) {
        if (mounted.current) {
          setRaw(reply);
          setErr("I couldn't turn that into a task list. Try again, or add tasks yourself.");
        }
      } else {
        patchIdea(id, (i) => ({ ...i, proposals: items.map((text) => ({ id: newId(), text })), updatedAt: Date.now() }));
        if (mounted.current) setSkip(new Set());
      }
    } catch (e) {
      if (mounted.current) setErr(String(e));
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const approve = () => {
    const chosen = proposals.filter((p) => !skip.has(p.id));
    if (!chosen.length) return;
    const ok = patchIdea(id, (i) => ({
      ...i,
      tasks: [...(i.tasks ?? []), ...chosen.map((p) => ({ id: newId(), text: p.text, done: false, at: Date.now() }))],
      proposals: [],
      updatedAt: Date.now(),
    }));
    if (ok) toast(`${chosen.length} task${chosen.length === 1 ? "" : "s"} added to the action plan`);
    else toast("Couldn't save the tasks. Storage may be full.");
  };

  const discard = () => {
    const before = proposals;
    patchIdea(id, (i) => ({ ...i, proposals: [] }));
    toast("Suggestions discarded", { label: "Undo", run: () => void patchIdea(id, (i) => ({ ...i, proposals: before })) });
  };

  // --- Saved ---------------------------------------------------------------------------------
  const addEntry = () => {
    const text = entry.trim();
    if (!text) return;
    const ok = patchIdea(id, (i) => ({ ...i, saved: [{ id: newId(), kind, text, at: Date.now(), from: "me" }, ...(i.saved ?? [])], updatedAt: Date.now() }));
    if (ok) setEntry("");
    else toast("Couldn't save that. Storage may be full.");
  };

  const removeEntry = (sid: string) => {
    const before = saved;
    patchIdea(id, (i) => ({ ...i, saved: (i.saved ?? []).filter((s) => s.id !== sid) }));
    toast("Removed", { label: "Undo", run: () => void patchIdea(id, (i) => ({ ...i, saved: before })) });
  };

  const shown = saved.filter((s) => only === "all" || s.kind === only);
  const when = (ms: number) => new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });

  return (
    <aside className="assistant" aria-label="Bond, for this idea">
      <header className="assistant-head">
        <div>
          <h2>Bond</h2>
          <small className="muted">With {BRAIN[provider] ?? "Bond's brain"}</small>
        </div>
        <div className="tabs" role="tablist" aria-label="Bond">
          {(
            [
              ["explore", "Explore"],
              ["plan", "Plan"],
              ["saved", `Saved${saved.length ? ` ${saved.length}` : ""}`],
            ] as const
          ).map(([t, label]) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
              {label}
            </button>
          ))}
        </div>
      </header>

      <p className="assistant-note">
        {provider === "local" ? "Everything here stays on this laptop. " : `The idea, your tasks and decisions are sent to ${BRAIN[provider]}; your personal notes are not. `}
        Bond can't browse the web, so verify facts yourself and keep what you check under Saved.
      </p>

      {tab === "explore" && (
        <>
          <div className="actions-grid">
            {EXPLORE.map((a) => (
              <button key={a.label} className="chip" disabled={!!busy} onClick={() => void explore(a.label, a.ask)}>
                {a.label}
              </button>
            ))}
          </div>
          <div className="assistant-log" role="log" aria-live="polite">
            {msgs.length === 0 && !busy && <p className="muted small">Pick a question above, or ask your own below. Answers can be saved as findings or decisions.</p>}
            {msgs.map((m, i) => (
              <div key={i} className={`bubble ${m.role}`}>
                {m.text}
                {m.role === "bond" && (
                  <div className="bubble-actions">
                    {m.savedAs ? (
                      <span className="saved-mark">✓ Saved as a {m.savedAs}</span>
                    ) : (
                      <>
                        <button className="linkish" onClick={() => keep(i, "finding")}>
                          Save as finding
                        </button>
                        <button className="linkish" onClick={() => keep(i, "decision")}>
                          Save as decision
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            ))}
            {busy === "explore" && <div className="bubble bond thinking">Thinking…</div>}
            {err && !busy && tab === "explore" && (
              <p className="error" role="alert">
                {err}
              </p>
            )}
            <div ref={end} />
          </div>
          <form
            className="assistant-form"
            onSubmit={(e) => {
              e.preventDefault();
              void explore(draft.trim(), draft.trim());
            }}
          >
            <textarea
              value={draft}
              rows={2}
              placeholder="Ask anything about this idea…"
              aria-label="Message to Bond"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void explore(draft.trim(), draft.trim());
                }
              }}
            />
            <div className="assistant-form-row">
              {msgs.length > 0 ? (
                <button type="button" className="linkish" onClick={clearChat}>
                  Clear conversation
                </button>
              ) : (
                <span />
              )}
              <button className="btn" disabled={!!busy || !draft.trim()}>
                {busy === "explore" ? "Thinking…" : "Send"}
              </button>
            </div>
          </form>
        </>
      )}

      {tab === "plan" && (
        <div className="assistant-plan">
          <div className="actions-grid">
            {PLAN.map((a) => (
              <button key={a.label} className="chip" disabled={!!busy} onClick={() => void plan(a.ask)}>
                {a.label}
              </button>
            ))}
          </div>
          {busy === "plan" && <p className="muted small">Thinking about the steps…</p>}
          {err && !busy && tab === "plan" && (
            <div role="alert">
              <p className="error">{err}</p>
              {raw && <pre className="raw">{raw}</pre>}
            </div>
          )}
          {proposals.length > 0 ? (
            <section className="proposals">
              <h3>Suggested tasks</h3>
              <p className="muted small">Nothing is added until you approve it. Untick what you don't want.</p>
              <ul>
                {proposals.map((p) => (
                  <li key={p.id}>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={!skip.has(p.id)}
                        onChange={() =>
                          setSkip((s) => {
                            const n = new Set(s);
                            n.has(p.id) ? n.delete(p.id) : n.add(p.id);
                            return n;
                          })
                        }
                      />
                      <span aria-hidden />
                    </label>
                    <span>{p.text}</span>
                  </li>
                ))}
              </ul>
              <div className="assistant-form-row">
                <button className="linkish" onClick={discard}>
                  Discard
                </button>
                <button className="btn" onClick={approve} disabled={proposals.every((p) => skip.has(p.id))}>
                  Add {proposals.filter((p) => !skip.has(p.id)).length} to action plan
                </button>
              </div>
            </section>
          ) : (
            !busy && !err && <p className="muted small">Choose what you need. Bond suggests tasks and you decide which ones join the action plan on the left.</p>
          )}
        </div>
      )}

      {tab === "saved" && (
        <div className="assistant-saved">
          <form
            className="saved-add"
            onSubmit={(e) => {
              e.preventDefault();
              addEntry();
            }}
          >
            <div className="saved-add-row">
              <select value={kind} onChange={(e) => setKind(e.target.value as SavedKind)} aria-label="Kind">
                {SAVED_KINDS.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name}
                  </option>
                ))}
              </select>
              <button className="btn" disabled={!entry.trim()}>
                Save
              </button>
            </div>
            <textarea value={entry} rows={2} placeholder="A finding, a decision, a link you checked…" aria-label="New entry" onChange={(e) => setEntry(e.target.value)} />
          </form>
          {saved.length > 0 && (
            <div className="prompt-row">
              {(["all", ...SAVED_KINDS.map((k) => k.id)] as const).map((k) => (
                <button key={k} className={`chip ${only === k ? "on" : ""}`} onClick={() => setOnly(k)}>
                  {k === "all" ? `All ${saved.length}` : `${SAVED_KINDS.find((x) => x.id === k)!.plural} ${saved.filter((s) => s.kind === k).length}`}
                </button>
              ))}
            </div>
          )}
          {saved.length === 0 && <p className="muted small">Nothing saved yet. Keep Bond's useful answers from Explore, or write your own findings, decisions and references here.</p>}
          {saved.length > 0 && shown.length === 0 && <p className="muted small">Nothing of that kind yet.</p>}
          <ul className="saved-list">
            {shown.map((s) => (
              <li key={s.id}>
                <div className="saved-meta">
                  <span className={`kind-tag k-${s.kind}`}>{SAVED_KINDS.find((k) => k.id === s.kind)!.name}</span>
                  <small className="muted">
                    {s.from === "bond" ? "From Bond" : "Yours"} · {when(s.at)}
                  </small>
                  <button className="icon-btn danger" onClick={() => removeEntry(s.id)} aria-label="Remove" title="Remove">
                    <svg viewBox="0 0 24 24" aria-hidden>
                      <path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13" />
                    </svg>
                  </button>
                </div>
                <p>{s.text}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </aside>
  );
}
