// Bond's own understanding of a request: the clear-cut cases are handled right here, instantly,
// without the AI. Anything else returns null and goes to the AI router (ai.rs), which can only
// pick from the same fixed menu of small jobs (agent.rs).
//
//   "today: make the video, learn LangGraph"   → today's list
//   "idea: an app that tracks plants"           → ideas, saved word for word
//   "start a timer of 10 seconds"               → a countdown on screen
//   "remind me at 5pm to submit the report"     → a reminder
//   "open spotify", "search x", "volume up", "close this tab", "open the d drive"
//   "open claude code in selfglance"            → that project folder, in Claude Code
//   "is there a file called resume"             → file search (names only)

import { goalForTomorrow, goalFrom, splitTodos } from "./goals.ts";
import { parseReminder } from "./remind.ts";
import { parseTimer } from "./timer.ts";

export type Action =
  | { do: "open_app"; name: string }
  | { do: "open_url"; url: string; browser?: string }
  | { do: "web_search"; query: string; browser?: string }
  | { do: "open_folder"; name: string }
  | { do: "tab"; key: "new" | "close" | "next" | "previous" | "reopen" }
  | { do: "media"; key: string }
  | { do: "set_volume"; percent: number }
  | { do: "show_desktop" }
  | { do: "system_status" }
  | { do: "system_specs" }
  | { do: "close_app"; name: string }
  | { do: "find_files"; query: string }
  | { do: "open_project"; name: string; tool: "claude" | "code" | "terminal" | "folder" };

export type Intent =
  | { kind: "idea"; text: string }
  /** Items for today's list (or tomorrow's). */
  | { kind: "todo"; items: string[]; tomorrow?: boolean }
  /** "what's on my list": read today's list out. */
  | { kind: "list" }
  | { kind: "remind"; at: number; text: string }
  | { kind: "timer"; ms: number; label: string }
  | { kind: "do"; actions: Action[] }
  | null;

const FOLDERS = /^(?:my\s+|the\s+)?(downloads?|documents?|docs|desktop|pictures|photos|screenshots?|music|videos?|[a-z] drive|drive [a-z])(?:\s+folder)?$/i;
const URLISH = /^(?:https?:\/\/)?[\w-]+(\.[\w-]+)+(\/\S*)?$/i;

const MEDIA: [RegExp, string][] = [
  [/^(turn (the )?)?volume up|^(make it )?louder|^increase (the )?volume/i, "volume_up"],
  [/^(turn (the )?)?volume down|^(make it )?(quieter|softer)|^(decrease|lower) (the )?volume/i, "volume_down"],
  [/^(mute|unmute)\b/i, "mute"],
  [/^(pause|resume|play|stop)( (the )?(music|song|video|it))?$/i, "play_pause"],
  [/^(next|skip)( (the |this |that |current )?(song|track|video))?$/i, "next"],
  [/^(previous|prev|last)( (song|track|video))?$/i, "previous"],
];

const TABS: [RegExp, "new" | "close" | "next" | "previous" | "reopen"][] = [
  [/^(?:open (?:a )?)?new tab$/i, "new"],
  [/^close (?:this |the |that )?tab$/i, "close"],
  [/^(?:go to (?:the )?)?next tab$/i, "next"],
  [/^(?:go to (?:the )?)?previous tab$/i, "previous"],
  [/^(?:reopen|restore|bring back) (?:the )?(?:last |closed )*tab$/i, "reopen"],
];

/** Words after "close" that are not a program ("close this tab"). */
const NOT_A_PROGRAM = /^(this|it|that|them|tab|tabs|window|windows|apps|programs|all|everything|this tab|this window|the tab|the window)$/i;

/** Tools a project can be opened in, as people say them. */
const TOOL = String.raw`(claude code|claude|vs ?code|visual studio code|code|a terminal|terminal|powershell|file explorer|explorer)`;
const toolOf = (said: string): "claude" | "code" | "terminal" | "folder" => {
  const t = said.toLowerCase();
  if (t.startsWith("claude")) return "claude";
  if (/code/.test(t)) return "code";
  if (/terminal|powershell/.test(t)) return "terminal";
  return "folder";
};

/** What speech puts in front of a request: fillers ("okay, so, um, hey Bond,"). */
const LEAD_NOISE = /^(?:(?:and|so|okay|ok|um+|uh+|hmm+|well|hey|hi|please|bond|bon)\b[,.!]?\s+)+/i;

/** An idea, word for word: what you said minus the words that only say "this is an idea". */
export function ideaText(said: string): string {
  return said
    .trim()
    .replace(LEAD_NOISE, "")
    .replace(/^(?:(?:i (?:just )?(?:got|have|had)|here'?s|got) (?:an |a )?(?:new |random |quick )?idea|(?:save|note|write down|remember|add) (?:this |an |my |a )?(?:new )?idea|(?:new |project |app |random )?idea)\b\s*(?:[:\-–,]|is|for)?\s*/i, "")
    .trim();
}

export function understand(input: string): Intent {
  const raw = input.trim().replace(/[ \t]+/g, " ").replace(LEAD_NOISE, "");
  const t = raw.replace(/[.!]+$/, "");
  let m: RegExpMatchArray | null;

  // An idea: saved exactly as you said it.
  if (/^(?:(?:new |project |app |random )?idea\b\s*[:\-–,]|(?:save|note|write down|remember|add) (?:this |an |my |a )?(?:new )?idea\b|i (?:just )?(?:got|have|had) (?:an |a )?(?:new |random |quick )?idea\b|here'?s (?:an |a )?idea\b)/i.test(t)) {
    const text = ideaText(raw);
    if (text) return { kind: "idea", text };
  }

  // Today's list: "today: make the video, learn LangGraph", "add to my list: …", "I have to … today".
  if ((m = t.match(/^(?:today|today'?s (?:list|tasks|plan)|my (?:list|tasks|plan) (?:for )?today|to-?do(?: list)?)\s*[:\-–]\s*(.+)$/is))) return { kind: "todo", items: splitTodos(m[1]) };
  if ((m = t.match(/^(?:add|put)\s+(?:this\s+|that\s+)?(?:to|on|in|into)\s+(?:my\s+|today'?s\s+)?(?:list|to-?do(?: list)?|tasks|plan)\s*[:\-–]?\s*(.+)$/is))) return { kind: "todo", items: splitTodos(m[1]) };
  if ((m = t.match(/^(?:today )?i (?:have|need|want) to (.+?)(?: today)?$/is)) && /\btoday\b/i.test(t)) return { kind: "todo", items: splitTodos(m[1]) };
  if (/^(?:what(?:'s| is)|show|read(?: out)?|tell me)\s+(?:me\s+)?(?:on\s+)?(?:my\s+|today'?s\s+)(?:list|to-?do(?: list)?|tasks|plan)(?:\s+(?:for\s+)?today)?\??$/i.test(t)) return { kind: "list" };
  const goal = goalFrom(t);
  if (goal) return { kind: "todo", items: [goal] };
  const next = goalForTomorrow(t);
  if (next) return { kind: "todo", items: [next], tomorrow: true };

  // A timer you can watch, then a reminder.
  const timer = parseTimer(t);
  if (timer) return { kind: "timer", ...timer };
  const reminder = parseReminder(t);
  if (reminder) return { kind: "remind", ...reminder };

  // A project in a tool: "open claude code in selfglance", "open selfglance in vs code", "open the portfolio project".
  if ((m = t.match(new RegExp(String.raw`^(?:open|launch|start|run)\s+${TOOL}\s+(?:in|on|for|inside)\s+(?:the\s+|my\s+)?(.+?)(?:\s+(?:project|folder|repo))?$`, "i"))))
    return { kind: "do", actions: [{ do: "open_project", name: m[2], tool: toolOf(m[1]) }] };
  if ((m = t.match(new RegExp(String.raw`^(?:open)\s+(?:the\s+|my\s+)?(.+?)(?:\s+(?:project|folder|repo))?\s+(?:in|with)\s+${TOOL}$`, "i"))))
    return { kind: "do", actions: [{ do: "open_project", name: m[1], tool: toolOf(m[2]) }] };
  if ((m = t.match(/^open\s+(?:the\s+|my\s+)?(.+?)\s+(?:project|repo)$/i))) return { kind: "do", actions: [{ do: "open_project", name: m[1], tool: "folder" }] };

  // Finding a file by name.
  if (
    (m = t.match(/^(?:is there|do i have)\s+(?:a|any)\s+(?:file|folder|document|pdf)s?\s+(?:called|named)\s+(.+?)(?:\s+(?:on|in) (?:my|this) (?:laptop|pc|computer))?\??$/i)) ??
    (m = t.match(/^(?:find|search for|look for|where is|where'?s)\s+(?:the\s+|my\s+)?(?:file|folder|document)s?\s+(?:called|named)?\s*(.+?)\??$/i))
  )
    return { kind: "do", actions: [{ do: "find_files", query: m[1].replace(/^["“']|["”']$/g, "") }] };

  // Browser tabs.
  for (const [re, key] of TABS) if (re.test(t)) return { kind: "do", actions: [{ do: "tab", key }] };

  // Open / search / media / desktop.
  if ((m = t.match(/^play (.+?) on youtube$/i))) return { kind: "do", actions: [{ do: "open_url", url: `https://www.youtube.com/results?search_query=${encodeURIComponent(m[1])}` }] };
  if ((m = t.match(/^search youtube for (.+)$/i))) return { kind: "do", actions: [{ do: "open_url", url: `https://www.youtube.com/results?search_query=${encodeURIComponent(m[1])}` }] };
  const BR = String.raw`(brave|google chrome|chrome|microsoft edge|edge|firefox|opera|vivaldi)(?:\s+browser)?`;
  const inBrowser =
    t.match(new RegExp(String.raw`^(?:search|google|look up)\s+(?:for\s+)?(.+?)\s+(?:in|on|using|with)\s+(?:the\s+)?${BR}$`, "i")) ??
    t.match(new RegExp(String.raw`^(?:open|launch|start)\s+(?:the\s+)?${BR}\s+(?:and|then)\s+(?:search|google|look up)\s+(?:for\s+)?(.+)$`, "i"));
  if (inBrowser) {
    const [, a, b] = inBrowser;
    const named = new RegExp(`^${BR}$`, "i").test(a);
    return { kind: "do", actions: [{ do: "web_search", query: named ? b : a, browser: (named ? a : b).toLowerCase().replace(/^google /, "").replace(/^microsoft /, "") }] };
  }
  if ((m = t.match(/^(?:search|google|look up)\s+(?:for\s+)?(.+)$/i))) return { kind: "do", actions: [{ do: "web_search", query: m[1] }] };
  if ((m = t.match(/^(?:open|launch|start|run)\s+(?:the\s+|my\s+)?(.+?)(?:\s+app)?$/i)) && !NOT_A_PROGRAM.test(m[1])) {
    const target = m[1];
    if (FOLDERS.test(target)) return { kind: "do", actions: [{ do: "open_folder", name: target.match(FOLDERS)![1] }] };
    if (URLISH.test(target)) return { kind: "do", actions: [{ do: "open_url", url: target }] };
    if (target.split(/\s+/).length <= 3) return { kind: "do", actions: [{ do: "open_app", name: target }] };
  }
  if ((m = t.match(/^(?:set |turn |change |put )?(?:the |my )?volume (?:to |at )?(\d{1,3})\s*(?:%|percent)?$/i))) return { kind: "do", actions: [{ do: "set_volume", percent: Math.min(100, Number(m[1])) }] };
  for (const [re, key] of MEDIA) if (re.test(t)) return { kind: "do", actions: [{ do: "media", key }] };
  if (/^(show (the )?desktop|minimi[sz]e (everything|all( windows)?))$/i.test(t)) return { kind: "do", actions: [{ do: "show_desktop" }] };

  // The laptop itself.
  if (/^(?:what(?:'?s| is| are)|show( me)?|tell me|check)?\s*(?:my|this|the)\s+(?:laptop|pc|computer|system|machine)(?:'?s)?\s+(?:specs?|specifications?|configuration|config|hardware|details)\??$|^(?:what|which)\s+(?:gpu|graphics card|processor|cpu)\s+(?:do i have|does (?:my|this) (?:laptop|pc|computer) have)\??$|^(?:laptop|pc|system) (?:specs?|specifications?)\??$/i.test(t))
    return { kind: "do", actions: [{ do: "system_specs" }] };
  if (/^(how'?s|how is|check|show( me)?|what'?s|what is)( my| the)? (battery|laptop|pc|computer|system)( status| health| doing| life| level| percentage)?\??$|^(battery|system status|status)\??$|^how much (battery|ram|memory|disk space|storage|space)( do i have| is)?( left| free| used)?\??$/i.test(t))
    return { kind: "do", actions: [{ do: "system_status" }] };
  if (/^(?:please\s+)?(?:close|quit|exit)\s+(?:it|this|that|this app|that app|the app)(?:\s+please)?$/i.test(t)) return { kind: "do", actions: [{ do: "close_app", name: "it" }] };
  if ((m = t.match(/^(?:close|quit|exit)\s+(?:the\s+)?(?:app\s+|program\s+)?(.+?)(?:\s+(?:app|program|window))?(?:\s+please)?$/i)) && !NOT_A_PROGRAM.test(m[1]) && m[1].split(/\s+/).length <= 3)
    return { kind: "do", actions: [{ do: "close_app", name: m[1] }] };

  // Any other statement that mentions an idea is one to keep ("so this idea came to me, a …", "what if … — just an
  // idea"). Not a question about ideas, and not "no idea" / "any idea".
  const idea = looseIdea(raw);
  if (idea) return { kind: "idea", text: idea };

  return null;
}

/** An idea in a sentence that isn't a question, in your own words: what follows "idea", or the whole sentence. */
export function looseIdea(said: string): string | null {
  const t = said.trim().replace(LEAD_NOISE, "");
  if (!/\bideas?\b/i.test(t) || /\b(?:no|any|some|good|bad|best|better) ideas?\b(?!\s*[:,\-–])|\bidea (?:of|what|why|how|where|when)\b/i.test(t)) return null;
  if (/\?\s*$/.test(t) || /^(?:what|how|why|when|where|who|which|is|are|do|does|did|can|could|should|would|will|any|give me|tell me|suggest|show|list|open|find|search)\b/i.test(t)) return null;
  const after = t.replace(/^.*?\bideas?\b\s*(?:[:,\-–]|\bis\b|\bfor\b|\babout\b|\bthat\b|\bcame to me\b|\bhere\b)*\s*/i, "").replace(/^(?:is|was|:|,|-)\s*/i, "").trim();
  const words = after.split(/\s+/).filter(Boolean).length;
  const text = words >= 3 ? after : t.replace(/\s*[,—-]*\s*(?:just )?(?:an |a )?ideas?\.?$/i, "").trim();
  return text.split(/\s+/).length >= 3 ? text : null;
}

const SAID_STOP = /^(?:(?:ok(?:ay)?,?\s+|hey,?\s+|please,?\s+|bond,?\s+)*(?:stop(?: (?:it|that|this|talking|please))?|please stop|be quiet|quiet|shut up|enough|never ?mind|cancel(?: (?:it|that|this))?|that'?s all|that'?s enough|thanks?,? bond|thank you|wait|hold on|forget it|not now))[.!,]?$/i;

/** "Stop", "be quiet", "thanks Bond": stop talking and close. */
export const saidStop = (said: string) => SAID_STOP.test(said.trim());
