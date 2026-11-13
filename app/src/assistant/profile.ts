// About you: what you write once in Settings → About you, used everywhere instead of guessed.
//
//   The brain     one short line at the top of every request (memory.rs), so answers fit you.
//   Plan          your hours bound the day; "Where to start" offers time toward your aim and your projects.
//   Goals         your projects' tools count as work, and videos about your aim are not held against you.
//
// Kept in localStorage like the settings (both windows read it); the screens hand the brain's line to
// Rust (ai.ts memoryProfile) on every save. Nothing here is sent anywhere. No Tauri in this file, so the
// tests can load it.

export interface Profile {
  /** What to call you. */
  name: string;
  /** What you do now: "3rd-year CS student". */
  now: string;
  /** Where you're headed: "AI Engineer". */
  aim: string;
  /** Side projects, comma separated: "content creation (YouTube)". */
  projects: string;
  /** Your usual day, "HH:MM". */
  start: string;
  end: string;
  /** How Bond should talk to you. */
  tone: "friendly" | "direct";
  /** Anything else he should know. */
  more: string;
}

export const EMPTY_PROFILE: Profile = { name: "", now: "", aim: "", projects: "", start: "09:00", end: "22:00", tone: "friendly", more: "" };

const KEY = "selfglance.profile";
export const PROFILE_EVENT = "selfglance:profile";
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function loadProfile(): Profile {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (!v || typeof v !== "object") return { ...EMPTY_PROFILE };
    const text = (k: keyof Profile, max: number) => (typeof v[k] === "string" ? (v[k] as string).trim().slice(0, max) : "");
    return {
      name: text("name", 40),
      now: text("now", 120),
      aim: text("aim", 120),
      projects: text("projects", 160),
      start: HHMM.test(v.start) ? v.start : EMPTY_PROFILE.start,
      end: HHMM.test(v.end) ? v.end : EMPTY_PROFILE.end,
      tone: v.tone === "direct" ? "direct" : "friendly",
      more: text("more", 300),
    };
  } catch {
    return { ...EMPTY_PROFILE };
  }
}

/** Save it (then give the brain profileLine(p)). */
export function saveProfile(p: Profile) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* not persisted */
  }
  window.dispatchEvent(new Event(PROFILE_EVENT));
}

export const hasProfile = (p: Profile) => !!(p.name || p.now || p.aim || p.projects || p.more);

/** The projects as a list: "content creation (YouTube), a chess app" → two. */
export const projectList = (p: Profile) =>
  p.projects
    .split(/\s*(?:[,;\n]|\band\b)\s*/i)
    .map((x) => x.trim())
    .filter((x) => x.length >= 3)
    .slice(0, 3);

/** The one line the brain gets: short on purpose, every word costs time on every request. */
export function profileLine(p: Profile): string {
  if (!hasProfile(p)) return "";
  const parts = [
    p.name && `Call them ${p.name}.`,
    p.now && `Now: ${p.now}.`,
    p.aim && `Working toward: ${p.aim}.`,
    p.projects && `Side projects: ${p.projects}.`,
    `Usual hours ${p.start}–${p.end}.`,
    p.tone === "direct" ? "Wants direct, short answers." : "",
    p.more && `Also: ${p.more}`,
  ];
  return parts
    .filter(Boolean)
    .join(" ")
    .replace(/\.\./g, ".")
    .slice(0, 500);
}

export const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/** The day's working hours in minutes since midnight. A night owl's end past midnight is held at 23:59. */
export function dayBounds(p: Profile): { start: number; end: number } {
  const start = minutesOf(p.start);
  const end = minutesOf(p.end);
  return { start, end: end > start ? end : 23 * 60 + 59 };
}

// --- What your aim and projects look like on screen ----------------------------------------

/** Words that point at common aims, so a lecture or a library counts toward "AI Engineer" without the word "engineer" in it. */
const AIM_WORDS: [RegExp, string[]][] = [
  [/\b(ai|ml|machine learning|deep learning|data scien|llm|artificial intelligence)\b/i, ["ai", "machine learning", "deep learning", "neural", "transformer", "llm", "pytorch", "tensorflow", "keras", "huggingface", "hugging face", "gpt", "diffusion", "kaggle", "colab", "jupyter", "numpy", "pandas", "scikit", "langchain", "rag", "fine-tun", "karpathy", "attention", "embedding"]],
  [/\b(web|frontend|front-end|full.?stack|backend|back-end)\b/i, ["javascript", "typescript", "react", "next.js", "node", "css", "html", "django", "flask", "fastapi", "api", "frontend", "backend", "vercel"]],
  [/\b(design|ui|ux)\b/i, ["figma", "design", "ui", "ux", "typography", "dribbble", "behance"]],
  [/\b(game|unity|unreal)\b/i, ["unity", "unreal", "godot", "game dev", "blender", "shader"]],
  [/\b(security|cyber|pentest|hacking)\b/i, ["security", "ctf", "hack the box", "tryhackme", "burp", "nmap", "exploit", "owasp"]],
];

/** Lower-case words that show something is about your aim. */
export function aimWords(p: Profile): string[] {
  if (!p.aim && !p.now) return [];
  // What you do now is part of it: an AI security intern's security reading is work, not a detour.
  const about = `${p.aim} ${p.now}`;
  const own = (p.aim.toLowerCase().match(/[\p{L}\p{N}+#]{3,}/gu) ?? []).filter((w) => !["become", "engineer", "developer", "student", "good", "great", "senior", "junior"].includes(w));
  return [...new Set([...own, ...AIM_WORDS.filter(([re]) => re.test(about)).flatMap(([, w]) => w)])];
}

/** Making videos is your work, not your distraction. */
export const isCreator = (p: Profile) => /\b(content|youtube|video|vlog|stream|tiktok|reels|podcast|creator|channel)\b/i.test(p.projects + " " + p.now + " " + p.aim);

/** The tools of a creator: these windows are work for one. */
export const CREATOR_TOOLS = /\b(youtube studio|studio\.youtube|premiere|after effects|davinci|resolve|capcut|final cut|filmora|obs|audacity|canva|photoshop|lightroom|descript|clipchamp|vegas|kdenlive|shotcut|thumbnail)\b/i;

/** Does `text` (a window title, an app) mention any of `words`? Short words match whole words only ("ai" is not in "rain"). */
export function mentions(text: string, words: string[]): boolean {
  const t = text.toLowerCase();
  return words.some((w) => (w.length <= 3 ? new RegExp(`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\p{L}\\p{N}]|$)`, "u").test(t) : t.includes(w)));
}
