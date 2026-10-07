// Bond's own understanding of a command: the clear-cut cases are handled right here,
// instantly and without any API call. Anything else returns null and goes to the AI router.
//
//   "log: finished the login page"      → journal
//   "idea: an app that tracks plants"   → ideas
//   "open spotify", "volume up", "search for rust tutorials", "lock my laptop",
//   "change my wallpaper to black"      → actions
//   "what's on my screen?"              → look at the screen and explain
//   "help, I'm stuck"                   → look at the screen and help

export type Action =
  | { do: "open_app"; name: string }
  | { do: "open_url"; url: string }
  | { do: "web_search"; query: string }
  | { do: "open_folder"; name: string }
  | { do: "media"; key: string }
  | { do: "show_desktop" }
  | { do: "lock_screen" }
  | { do: "set_wallpaper"; color: string };

export type ScreenMode = "explain" | "help" | "task";

export type Intent =
  | { kind: "log"; text: string }
  | { kind: "idea"; text: string }
  | { kind: "do"; actions: Action[] }
  | { kind: "screen"; mode: ScreenMode }
  | null;

const FOLDERS = /^(?:my\s+|the\s+)?(downloads?|documents?|docs|desktop|pictures|photos|music|videos?)(?:\s+folder)?$/i;
const URLISH = /^(?:https?:\/\/)?[\w-]+(\.[\w-]+)+(\/\S*)?$/i;

const MEDIA: [RegExp, string][] = [
  [/^(turn (the )?)?volume up|^(make it )?louder|^increase (the )?volume/i, "volume_up"],
  [/^(turn (the )?)?volume down|^(make it )?(quieter|softer)|^(decrease|lower) (the )?volume/i, "volume_down"],
  [/^(mute|unmute)\b/i, "mute"],
  [/^(pause|resume|play|stop)( (the )?(music|song|video|it))?$/i, "play_pause"],
  [/^(next|skip)( (the )?(song|track|video))?$/i, "next"],
  [/^(previous|prev|last)( (song|track|video))?$/i, "previous"],
];

export function understand(input: string): Intent {
  const t = input.trim().replace(/[.!]+$/, "");
  let m: RegExpMatchArray | null;

  // Remember: day log and ideas (explicit prefixes only; the AI catches the rest).
  if ((m = t.match(/^(?:log|journal|diary|add to (?:my )?(?:journal|diary|log))\s*[:\-–]?\s+(.+)$/is))) return { kind: "log", text: m[1] };
  if ((m = t.match(/^(?:(?:new |project |app )?idea|save (?:this |an |my )?idea|add (?:an |this )?idea)\s*[:\-–]?\s+(.+)$/is))) return { kind: "idea", text: m[1] };

  // Do: open / search / media / desktop / lock.
  if ((m = t.match(/^play (.+?) on youtube$/i))) return { kind: "do", actions: [{ do: "open_url", url: `https://www.youtube.com/results?search_query=${encodeURIComponent(m[1])}` }] };
  if ((m = t.match(/^search youtube for (.+)$/i))) return { kind: "do", actions: [{ do: "open_url", url: `https://www.youtube.com/results?search_query=${encodeURIComponent(m[1])}` }] };
  if ((m = t.match(/^(?:search|google|look up)\s+(?:for\s+)?(.+)$/i))) return { kind: "do", actions: [{ do: "web_search", query: m[1] }] };
  if ((m = t.match(/^(?:open|launch|start|run)\s+(?:the\s+|my\s+)?(.+?)(?:\s+app)?$/i))) {
    const target = m[1];
    if (FOLDERS.test(target)) return { kind: "do", actions: [{ do: "open_folder", name: target.match(FOLDERS)![1] }] };
    if (URLISH.test(target)) return { kind: "do", actions: [{ do: "open_url", url: target }] };
    if (target.split(/\s+/).length <= 3) return { kind: "do", actions: [{ do: "open_app", name: target }] };
  }
  for (const [re, key] of MEDIA) if (re.test(t)) return { kind: "do", actions: [{ do: "media", key }] };
  if (/^(show (the )?desktop|minimi[sz]e (everything|all( windows)?))$/i.test(t)) return { kind: "do", actions: [{ do: "show_desktop" }] };
  if ((m = t.match(/^(?:change?|chnage|set|make|turn)\s+(?:my\s+|the\s+)?(?:desktop\s+)?(?:wallpaper|background)(?:\s+(?:to|into))?\s+(?:a\s+|an\s+)?(?:solid\s+)?(#?[0-9a-f]{6}|[a-z]+(?:\s[a-z]+)?)(?:\s+(?:solid\s+)?colou?r)?(?:\s+solid)?$/i)))
    return { kind: "do", actions: [{ do: "set_wallpaper", color: m[1].replace(/\s+(solid|colou?r)$/i, "") }] };
  if (/^lock (my |the )?(screen|computer|laptop|pc)$/i.test(t)) return { kind: "do", actions: [{ do: "lock_screen" }] };

  // Look: explain the screen, or help when stuck.
  if (/\b(stuck|not working|doesn'?t work|isn'?t working|what'?s wrong|what is wrong|can'?t figure|fix (this|it))\b|^help( me)?\??$/i.test(t)) return { kind: "screen", mode: "help" };
  if (/\b(on|in) (my|the) screen\b|\bwhat am i (looking at|seeing)\b|^(explain|summari[sz]e|read) (this|my screen|the page|it)\b/i.test(t)) return { kind: "screen", mode: "explain" };

  return null;
}
