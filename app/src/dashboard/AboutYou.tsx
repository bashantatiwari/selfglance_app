// Settings → About you: a few lines you write once, each saying what Bond does with it (assistant/profile.ts).

import { useState } from "react";
import { memoryProfile } from "../ai";
import { loadProfile, profileLine, saveProfile, type Profile } from "../assistant/profile";

const FIELDS: { key: "name" | "now" | "aim" | "projects" | "more"; label: string; example: string; usedFor: string; max: number }[] = [
  { key: "name", label: "Call me", example: "Alex", usedFor: "How he greets you.", max: 40 },
  { key: "now", label: "What I do now", example: "computer science student", usedFor: "How deep his explanations go.", max: 120 },
  { key: "aim", label: "Where I'm headed", example: "AI Engineer", usedFor: "Plan offers time toward it each day; lectures and tools about it count as work in Goals.", max: 120 },
  { key: "projects", label: "Side projects", example: "content creation (YouTube)", usedFor: "Plan offers time for them; their tools (YouTube Studio, editors) count as work, not distraction.", max: 160 },
  { key: "more", label: "Anything else", example: "I learn best from short examples", usedFor: "Every conversation.", max: 300 },
];

export function AboutYouPanel() {
  const [p, setP] = useState<Profile>(loadProfile);
  const [saved, setSaved] = useState(false);
  const commit = (next: Profile) => {
    setP(next);
    saveProfile(next);
    void memoryProfile(profileLine(next));
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1200);
  };
  return (
    <section className="group">
      <div className="group-info">
        <h2>About you</h2>
        <p className="muted">Write it once and Bond fits everything to you: what to work on today, what counts as work, how he answers. Every line is optional.</p>
        <p className="muted small">Kept on this laptop and never sent anywhere. {saved && <b className="about-saved">✓ Saved</b>}</p>
      </div>
      <div className="group-body about">
        {FIELDS.map((f) => (
          <label key={f.key} className="about-field">
            <span className="about-label">{f.label}</span>
            {f.key === "more" ? (
              <textarea rows={2} defaultValue={p[f.key]} maxLength={f.max} placeholder={`e.g. ${f.example}`} onBlur={(e) => e.target.value.trim() !== p[f.key] && commit({ ...p, [f.key]: e.target.value.trim() })} />
            ) : (
              <input className="capture-input" defaultValue={p[f.key]} maxLength={f.max} placeholder={`e.g. ${f.example}`} onBlur={(e) => e.target.value.trim() !== p[f.key] && commit({ ...p, [f.key]: e.target.value.trim() })} />
            )}
            <small className="muted">{f.usedFor}</small>
          </label>
        ))}
        <div className="about-field">
          <span className="about-label">My usual hours</span>
          <span className="about-hours">
            <input type="time" value={p.start} onChange={(e) => e.target.value && commit({ ...p, start: e.target.value })} aria-label="Usually start at" />
            <span>to</span>
            <input type="time" value={p.end} onChange={(e) => e.target.value && commit({ ...p, end: e.target.value })} aria-label="Usually stop at" />
          </span>
          <small className="muted">Today's plan starts and ends inside these hours.</small>
        </div>
        <div className="about-field">
          <span className="about-label">How to talk to me</span>
          <div className="tabs" role="radiogroup" aria-label="How to talk to me">
            {(
              [
                ["friendly", "Friendly"],
                ["direct", "Direct and short"],
              ] as const
            ).map(([id, name]) => (
              <button key={id} role="radio" aria-checked={p.tone === id} className={p.tone === id ? "on" : ""} onClick={() => commit({ ...p, tone: id })}>
                {name}
              </button>
            ))}
          </div>
          <small className="muted">The tone of his replies.</small>
        </div>
      </div>
    </section>
  );
}
