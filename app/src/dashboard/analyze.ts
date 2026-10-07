// Turns the raw diary (time segments) into analysis: categories, sessions, focus
// streaks, hour-by-hour usage, top items and plain-language insights.

import type { Segment } from "../companion/tracker";

export type Cat = "working" | "entertainment" | "learning" | "browsing" | "meetings";
export type Kind = "Project" | "Video" | "Site" | "App";

/** Fixed categorical order (CVD-validated as a set, adjacent order matters). */
export const CATS: { id: Cat; name: string; productive: boolean | null }[] = [
  { id: "working", name: "Working", productive: true },
  { id: "entertainment", name: "Entertainment", productive: false },
  { id: "learning", name: "Learning", productive: true },
  { id: "browsing", name: "Browsing", productive: null },
  { id: "meetings", name: "Meetings", productive: true },
];
export const catName = (c: Cat) => CATS.find((x) => x.id === c)!.name;

const LEARNING_TITLE =
  /\b(tutorial|course|lecture|lesson|learn|learning|how to|crash course|explained|bootcamp|guide|for beginners|full course|interview|dsa|leetcode|system design|documentation|walkthrough|masterclass)\b/i;
const PRODUCTIVE_SITES =
  /\b(github|gitlab|stack ?overflow|stackexchange|mdn|docs?|documentation|leetcode|geeksforgeeks|w3schools|chatgpt|claude|gemini|perplexity|notion|jira|confluence|figma|vercel|netlify|npm|pypi|kaggle|colab|coursera|udemy|edx|khan academy|freecodecamp|medium|dev\.to|hashnode|linkedin learning)\b/i;
const DISTRACTING_SITES =
  /\b(instagram|facebook|twitter|x\.com|reddit|tiktok|snapchat|netflix|prime video|hotstar|disney|jiocinema|twitch|9gag|pinterest|tumblr|discord|whatsapp|telegram|spotify|youtube)\b/i;
const EDITORS = /^(code|code - insiders|cursor|windsurf|zed|idea64|idea|pycharm64|pycharm|webstorm64|sublime_text|notepad\+\+|devenv|xcode)$/i;
const BROWSERS = /(chrome|firefox|edge|brave|opera|vivaldi|arc|safari|chromium)/i;

/** Which analysis category a recorded segment belongs to. */
export function catOf(s: Segment): Cat {
  if (s.ctx === "meeting") return "meetings";
  // Older recordings could mark fullscreen system tools (screenshots, Explorer) as games.
  if (s.ctx === "game") return /snipping|screen ?clip|screensketch|explorer|search|lockapp/i.test(s.app) ? "browsing" : "entertainment";
  if (s.ctx === "watching") return LEARNING_TITLE.test(s.label) ? "learning" : "entertainment";
  if (s.ctx === "focus") return "working";
  if (PRODUCTIVE_SITES.test(s.label)) return "learning";
  if (DISTRACTING_SITES.test(s.label)) return "entertainment";
  return "browsing";
}

export function kindOf(s: Segment): Kind {
  if (s.ctx === "watching") return "Video";
  if (EDITORS.test(s.app.replace(/\.exe$/i, "")) || /visual studio code|cursor|zed/i.test(s.app)) return "Project";
  if (BROWSERS.test(s.app)) return "Site";
  return "App";
}

export const durOf = (s: Segment) => Math.max(0, s.end - s.start) + 2000; // a segment covers at least one tick

export interface Session {
  start: number;
  end: number;
  /** Time actually spent (for focus blocks: productive minutes only, not the gaps). */
  ms: number;
  cat: Cat;
  kind: Kind;
  label: string;
  app: string;
}

export interface Item {
  key: string;
  label: string;
  kind: Kind;
  cat: Cat;
  app: string;
  ms: number;
  sessions: number;
  first: number;
  last: number;
}

export interface DayStats {
  total: number;
  byCat: Record<Cat, number>;
  hourly: Record<Cat, number>[]; // 24 entries
  items: Item[];
  apps: { app: string; ms: number; cats: Set<Cat> }[];
  sessions: Session[];
  productive: number;
  distracting: number;
  focusScore: number | null; // productive share of (productive + distracting), 0..100
  longestFocus: Session | null; // longest unbroken productive stretch
  focusBlocks: Session[]; // productive stretches >= 10 min
  switchesPerHour: number;
  first: number | null;
  last: number | null;
}

const emptyCats = (): Record<Cat, number> => ({ working: 0, entertainment: 0, learning: 0, browsing: 0, meetings: 0 });
const SESSION_GAP = 2 * 60_000; // same thing again within 2 min = the same session
const FOCUS_GAP = 3 * 60_000; // a productive stretch survives short detours
const FOCUS_MIN = 10 * 60_000;

export function analyzeDay(segs: Segment[]): DayStats {
  const byCat = emptyCats();
  const hourly = Array.from({ length: 24 }, emptyCats);
  const items = new Map<string, Item>();
  const apps = new Map<string, { app: string; ms: number; cats: Set<Cat> }>();
  const sessions: Session[] = [];
  let total = 0;

  for (const s of segs) {
    const cat = catOf(s);
    const kind = kindOf(s);
    const ms = durOf(s);
    total += ms;
    byCat[cat] += ms;

    // Hour-by-hour, splitting a segment across hour boundaries.
    let t = s.start;
    const end = s.start + ms;
    while (t < end) {
      const h = new Date(t);
      const next = new Date(h);
      next.setMinutes(60, 0, 0);
      const stop = Math.min(end, next.getTime());
      hourly[h.getHours()][cat] += stop - t;
      t = stop;
    }

    const key = `${kind}|${s.label}`;
    const it = items.get(key) ?? { key, label: s.label, kind, cat, app: s.app, ms: 0, sessions: 0, first: s.start, last: end };
    it.ms += ms;
    it.last = Math.max(it.last, end);
    items.set(key, it);

    const ap = apps.get(s.app) ?? { app: s.app, ms: 0, cats: new Set<Cat>() };
    ap.ms += ms;
    ap.cats.add(cat);
    apps.set(s.app, ap);

    const prev = sessions[sessions.length - 1];
    if (prev && prev.label === s.label && prev.cat === cat && s.start - prev.end < SESSION_GAP) {
      prev.end = end;
      prev.ms += ms;
    } else sessions.push({ start: s.start, end, ms, cat, kind, label: s.label, app: s.app });
  }
  for (const se of sessions) {
    const it = items.get(`${se.kind}|${se.label}`);
    if (it) it.sessions += 1;
  }

  // Focus blocks: unbroken productive time (working / learning / meetings), short detours allowed.
  const productiveCats = new Set<Cat>(CATS.filter((c) => c.productive).map((c) => c.id));
  const focusBlocks: Session[] = [];
  let cur: Session | null = null;
  for (const se of sessions) {
    if (productiveCats.has(se.cat)) {
      if (cur && se.start - cur.end < FOCUS_GAP) {
        cur.end = se.end;
        cur.ms += se.ms;
      } else {
        if (cur) focusBlocks.push(cur);
        cur = { ...se };
      }
    } else if (cur && se.end - se.start > FOCUS_GAP) {
      focusBlocks.push(cur);
      cur = null;
    }
  }
  if (cur) focusBlocks.push(cur);
  const longestFocus = focusBlocks.reduce<Session | null>((a, b) => (!a || b.ms > a.ms ? b : a), null);

  const productive = byCat.working + byCat.learning + byCat.meetings;
  const distracting = byCat.entertainment;
  const activeHours = Math.max(total / 3_600_000, 1 / 60);

  return {
    total,
    byCat,
    hourly,
    items: [...items.values()].sort((a, b) => b.ms - a.ms),
    apps: [...apps.values()].sort((a, b) => b.ms - a.ms),
    sessions,
    productive,
    distracting,
    focusScore: productive + distracting > 60_000 ? Math.round((productive / (productive + distracting)) * 100) : null,
    longestFocus,
    focusBlocks: focusBlocks.filter((b) => b.ms >= FOCUS_MIN),
    switchesPerHour: Math.round(Math.max(0, sessions.length - 1) / activeHours),
    first: segs[0]?.start ?? null,
    last: segs.length ? segs[segs.length - 1].end : null,
  };
}

export function fmt(ms: number) {
  const min = Math.round(ms / 60_000);
  if (min < 1) return ms > 0 ? "<1m" : "0m";
  const h = Math.floor(min / 60);
  return h ? `${h}h ${min % 60}m` : `${min}m`;
}

export const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const hourName = (h: number) => new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: "numeric" });

/** Plain-language observations, most useful first. */
export function insights(d: DayStats, prev: DayStats | null): string[] {
  const out: string[] = [];
  if (d.total < 5 * 60_000) return out;

  // Most distracting hour.
  let worst = -1;
  let worstMs = 0;
  d.hourly.forEach((h, i) => {
    if (h.entertainment > worstMs) {
      worstMs = h.entertainment;
      worst = i;
    }
  });
  if (worst >= 0 && worstMs >= 10 * 60_000) {
    const top = d.items.find((i) => i.cat === "entertainment");
    out.push(`Most distracted hour: ${hourName(worst)} — ${fmt(worstMs)} of entertainment${top ? `, mostly “${top.label}”` : ""}.`);
  }

  if (d.longestFocus && d.longestFocus.ms >= 10 * 60_000) {
    const lf = d.longestFocus;
    out.push(`Longest focus stretch: ${fmt(lf.ms)} from ${clock(lf.start)}, starting on “${lf.label}”.`);
  } else if (d.productive > 15 * 60_000) {
    out.push(`No focus stretch reached 10 minutes — your productive time was split into short bursts.`);
  }

  const topProject = d.items.find((i) => i.kind === "Project");
  if (topProject) out.push(`Most time on a project: “${topProject.label}” (${fmt(topProject.ms)} across ${topProject.sessions} session${topProject.sessions > 1 ? "s" : ""}).`);

  const videos = d.items.filter((i) => i.kind === "Video");
  if (videos.length) {
    const vt = videos.reduce((a, b) => a + b.ms, 0);
    const learnt = videos.filter((v) => v.cat === "learning").reduce((a, b) => a + b.ms, 0);
    out.push(`Watched ${videos.length} video${videos.length > 1 ? "s" : ""} for ${fmt(vt)}${learnt ? ` — ${fmt(learnt)} of it was learning` : ""}.`);
  }

  if (d.switchesPerHour >= 30) out.push(`You switched what you were doing about ${d.switchesPerHour} times an hour — roughly every ${Math.max(1, Math.round(60 / d.switchesPerHour))} min. Fewer switches usually means deeper work.`);

  if (prev && prev.total > 30 * 60_000) {
    const diff = d.distracting - prev.distracting;
    if (Math.abs(diff) >= 15 * 60_000) out.push(`${diff > 0 ? "More" : "Less"} entertainment than yesterday: ${fmt(Math.abs(diff))} ${diff > 0 ? "more" : "less"} so far.`);
    if (d.focusScore !== null && prev.focusScore !== null && Math.abs(d.focusScore - prev.focusScore) >= 10)
      out.push(`Focus score ${d.focusScore > prev.focusScore ? "up" : "down"} ${Math.abs(d.focusScore - prev.focusScore)} points on yesterday (${prev.focusScore} → ${d.focusScore}).`);
  }
  return out;
}
