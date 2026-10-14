// Bond's own understanding of a command: the clear-cut cases are handled right here,
// instantly and without any API call. Anything else returns null and goes to the AI router.
//
//   "log: finished the login page"      → journal
//   "idea: an app that tracks plants"   → ideas
//   "open spotify", "volume up", "set volume to 30", "search for rust tutorials",
//   "lock my laptop", "change my wallpaper to black" → actions
//   "remind me in 45 minutes to stretch", "remind me at 5pm to call mom", "timer 10 min",
//   "what are my reminders"             → reminders
//   "how's my battery", "why is my laptop slow", "close chrome" → the laptop itself
//   "delete my screenshots"             → delete, after showing them and asking twice
//   "what's on my clipboard", "copy hello to clipboard", "summarize my clipboard"
//   "$ ipconfig", "cmd: git status"     → run a command (you approve first)
//   "what's on my screen?"              → look at the screen and explain
//   "help, I'm stuck"                   → look at the screen and help

export type Action =
  | { do: "open_app"; name: string }
  | { do: "open_url"; url: string }
  | { do: "web_search"; query: string }
  | { do: "open_folder"; name: string }
  | { do: "media"; key: string }
  | { do: "set_volume"; percent: number }
  | { do: "show_desktop" }
  | { do: "lock_screen" }
  | { do: "set_wallpaper"; color: string }
  | { do: "system_status" }
  | { do: "top_processes" }
  | { do: "free_memory" }
  | { do: "clipboard_get" }
  | { do: "clipboard_set"; text: string }
  | { do: "remind"; text: string; in_minutes?: number; at?: string }
  | { do: "list_reminders" }
  | { do: "run_command"; command: string; why: string }
  | { do: "kill_process"; name: string }
  | { do: "close_app"; name: string }
  | { do: "delete"; paths: string[]; permanent?: boolean };

export type ScreenMode = "explain" | "help" | "task" | "guide";

export type Intent =
  | { kind: "log"; text: string }
  | { kind: "idea"; text: string }
  | { kind: "do"; actions: Action[] }
  | { kind: "screen"; mode: ScreenMode }
  | { kind: "clipboard" }
  | null;

const FOLDERS = /^(?:my\s+|the\s+)?(downloads?|documents?|docs|desktop|pictures|photos|screenshots?|music|videos?)(?:\s+folder)?$/i;
const URLISH = /^(?:https?:\/\/)?[\w-]+(\.[\w-]+)+(\/\S*)?$/i;
const CLOCK = /^\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?$/i;

const MEDIA: [RegExp, string][] = [
  [/^(turn (the )?)?volume up|^(make it )?louder|^increase (the )?volume/i, "volume_up"],
  [/^(turn (the )?)?volume down|^(make it )?(quieter|softer)|^(decrease|lower) (the )?volume/i, "volume_down"],
  [/^(mute|unmute)\b/i, "mute"],
  [/^(pause|resume|play|stop)( (the )?(music|song|video|it))?$/i, "play_pause"],
  [/^(next|skip)( (the )?(song|track|video))?$/i, "next"],
  [/^(previous|prev|last)( (song|track|video))?$/i, "previous"],
];

/** "Walk me through buying a domain", "show me how to...", "I'm about to buy a domain, help me", "where do I click?" */
const GUIDE_ME = new RegExp(
  [
    String.raw`^(?:please\s+)?(?:guide|walk|talk|take|lead) me (?:through|to|with|along)\b`,
    String.raw`^(?:please\s+)?(?:show|teach) me (?:how to|where to|where i (?:should |can |have to )?(?:click|go|press|type))\b`,
    String.raw`^(?:please\s+)?point (?:me )?(?:to|at|out)\b`,
    String.raw`^where (?:do|should|can) i (?:click|press|tap|go|type)\b`,
    String.raw`^(?:please\s+)?help me (?:figure out |understand |learn |know )?how (?:to|do i|can i)\b`,
    String.raw`^(?:please\s+)?(?:help|assist) me (?:to |with |in )?(?!(?:write|draft|compose|summari[sz]e|translate|explain|fix|debug|code|solve|decide|choose|think|plan|brainstorm|name|understand|learn|remember|study|check|find out|figure)\b)\w+(?:\s+\S+){2,}`,
    String.raw`\bhelp me (?:how )?to do (?:that|this|it)\b`,
    String.raw`^how (?:do|can|would|should) i .{3,}\b(?:in|on|with|using|from) (?:obs|chrome|edge|brave|firefox|word|excel|powerpoint|outlook|teams|zoom|discord|photoshop|premiere|davinci|vs ?code|settings|windows|the browser)\b`,
    String.raw`^(?:i(?:'m| am) (?:about|going|trying|gonna) to|i want to|i need to|i have to|let'?s) .+\b(?:help|guide|walk|show|point|assist)\b`,
    String.raw`^(?:help|assist) me (?:to |with )?(?:buy|book|register|sign (?:up|in)|set ?up|create|fill|apply|order|install|find|change|reset|pay|renew|transfer|get|open|make|add|enable|disable|turn)\b`,
  ].join("|"),
  "i",
);

/** Words after "close"/"end" that are not a program ("close this tab"). */
const NOT_A_PROGRAM = /^(this|it|that|them|tab|window|all|everything|the call|call|meeting|this tab|this window|the tab|the window|everything else)$/i;

/** "45 minutes", "an hour", "half an hour", "90 sec", "2h" → minutes. */
export function minutesIn(s: string): number | null {
  const t = s.trim().toLowerCase();
  if (/^half an? hour$/.test(t)) return 30;
  if (/^an? hour and a half$/.test(t)) return 90;
  if (/^a (couple|few) (of )?minutes$/.test(t)) return 3;
  const m = t.match(/^(\d+(?:\.\d+)?|an?|one)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)$/);
  if (!m) return null;
  const n = /^(an?|one)$/.test(m[1]) ? 1 : Number(m[1]);
  const unit = m[2][0] === "s" ? 1 / 60 : m[2][0] === "m" ? 1 : m[2][0] === "h" ? 60 : 1440;
  const mins = n * unit;
  return mins > 0 ? mins : null;
}

function reminder(t: string): Action | null {
  let m: RegExpMatchArray | null;
  const about = (s: string) => s.replace(/^(to|that|about)\s+/i, "").trim();
  if ((m = t.match(/^(?:set (?:a |an )?)?(?:timer|alarm) (?:for )?(.+)$/i))) {
    const mins = minutesIn(m[1]);
    if (mins) return { do: "remind", text: "Time's up!", in_minutes: mins };
  }
  if (!/^remind me\b/i.test(t)) return null;
  if ((m = t.match(/^remind me (?:in|after) (.+?) (?:to|that|about) (.+)$/i))) {
    const mins = minutesIn(m[1]);
    if (mins) return { do: "remind", text: m[2], in_minutes: mins };
  }
  if ((m = t.match(/^remind me (.+?) (?:in|after) (.+)$/i))) {
    const mins = minutesIn(m[2]);
    if (mins) return { do: "remind", text: about(m[1]), in_minutes: mins };
  }
  if ((m = t.match(/^remind me (?:at|by) (.+?) (?:to|that|about) (.+)$/i)) && CLOCK.test(m[1])) return { do: "remind", text: m[2], at: m[1] };
  if ((m = t.match(/^remind me (.+?) (?:at|by) (.+)$/i)) && CLOCK.test(m[2])) return { do: "remind", text: about(m[1]), at: m[2] };
  return null; // "tomorrow morning", "on Friday": the AI knows today's date
}

export function understand(input: string): Intent {
  const raw = input.trim();
  const t = raw.replace(/[.!]+$/, "");
  let m: RegExpMatchArray | null;

  // Remember: day log and ideas (explicit prefixes only; the AI catches the rest).
  if ((m = t.match(/^(?:log|journal|diary|add to (?:my )?(?:journal|diary|log))\s*[:\-–]?\s+(.+)$/is))) return { kind: "log", text: m[1] };
  if ((m = t.match(/^(?:(?:new |project |app )?idea|save (?:this |an |my )?idea|add (?:an |this )?idea)\s*[:\-–]?\s+(.+)$/is))) return { kind: "idea", text: m[1] };

  // Reminders.
  const r = reminder(t);
  if (r) return { kind: "do", actions: [r] };
  if (/^(?:what are |show(?: me)? |list |what'?s )?(?:my |all )?(?:upcoming )?reminders\??$|^what reminders do i have\??$/i.test(t)) return { kind: "do", actions: [{ do: "list_reminders" }] };

  // Clearing out screenshots: Bond shows them (with previews) and asks twice before anything goes.
  if (/^(?:delete|remove|clear|clean up|get rid of|empty)\s+(?:all\s+)?(?:of\s+)?(?:my\s+|the\s+)?screen\s?shots?(?:\s+folder)?(?:\s+(?:images?|pictures?|files?))?$/i.test(t))
    return { kind: "do", actions: [{ do: "delete", paths: ["screenshots/*"] }] };

  // A command, word for word (the raw text: a trailing "." can matter in a command).
  if ((m = raw.match(/^(?:\$|>|cmd:|command:|powershell:|terminal:|shell:|run (?:the )?command:?|execute:?)\s*(.+)$/is))) return { kind: "do", actions: [{ do: "run_command", command: m[1].trim(), why: "You asked me to run it." }] };

  // Do: open / search / media / desktop / lock.
  if ((m = t.match(/^play (.+?) on youtube$/i))) return { kind: "do", actions: [{ do: "open_url", url: `https://www.youtube.com/results?search_query=${encodeURIComponent(m[1])}` }] };
  if ((m = t.match(/^search youtube for (.+)$/i))) return { kind: "do", actions: [{ do: "open_url", url: `https://www.youtube.com/results?search_query=${encodeURIComponent(m[1])}` }] };
  if ((m = t.match(/^(?:search|google|look up)\s+(?:for\s+)?(.+)$/i))) return { kind: "do", actions: [{ do: "web_search", query: m[1] }] };
  if ((m = t.match(/^(?:open|launch|start|run)\s+(?:the\s+|my\s+)?(.+?)(?:\s+app)?$/i)) && !NOT_A_PROGRAM.test(m[1]) && !/^(the |this |that )?(command|script|it again)$/i.test(m[1])) {
    const target = m[1];
    if (FOLDERS.test(target)) return { kind: "do", actions: [{ do: "open_folder", name: target.match(FOLDERS)![1] }] };
    if (URLISH.test(target)) return { kind: "do", actions: [{ do: "open_url", url: target }] };
    if (target.split(/\s+/).length <= 3) return { kind: "do", actions: [{ do: "open_app", name: target }] };
  }
  if ((m = t.match(/^(?:set |turn |change |put )?(?:the |my )?volume (?:to |at )?(\d{1,3})\s*(?:%|percent)?$/i))) return { kind: "do", actions: [{ do: "set_volume", percent: Math.min(100, Number(m[1])) }] };
  for (const [re, key] of MEDIA) if (re.test(t)) return { kind: "do", actions: [{ do: "media", key }] };
  if (/^(show (the )?desktop|minimi[sz]e (everything|all( windows)?))$/i.test(t)) return { kind: "do", actions: [{ do: "show_desktop" }] };
  if ((m = t.match(/^(?:change?|chnage|set|make|turn)\s+(?:my\s+|the\s+)?(?:desktop\s+)?(?:wallpaper|background)(?:\s+(?:to|into))?\s+(?:a\s+|an\s+)?(?:solid\s+)?(#?[0-9a-f]{6}|[a-z]+(?:\s[a-z]+)?)(?:\s+(?:solid\s+)?colou?r)?(?:\s+solid)?$/i)))
    return { kind: "do", actions: [{ do: "set_wallpaper", color: m[1].replace(/\s+(solid|colou?r)$/i, "") }] };
  if (/^lock (my |the )?(screen|computer|laptop|pc)$/i.test(t)) return { kind: "do", actions: [{ do: "lock_screen" }] };

  // The laptop itself.
  if (/^(?:please\s+)?(?:free|clear|save|release)\s+(?:up\s+)?(?:some\s+)?(?:my\s+)?(?:ram|memory)(?:\s+usage)?\??$|^(?:reduce|lower|cut)\s+(?:my\s+)?(?:ram|memory)(?:\s+usage)?\??$/i.test(t))
    return { kind: "do", actions: [{ do: "free_memory" }] };
  if (/\bwhy is (my |the )?(laptop|pc|computer|it|everything) (so |running )?(slow|hot|lagging|laggy|loud|hanging)\b|\bwhat'?s (using|eating|hogging|slowing)\b|\b(top|heavy|busy) (processes|apps|programs)\b|^what'?s (running|slow)\??$/i.test(t))
    return { kind: "do", actions: [{ do: "top_processes" }] };
  if (/^(how'?s|how is|check|show( me)?|what'?s|what is)( my| the)? (battery|laptop|pc|computer|system)( status| health| doing| life| level| percentage)?\??$|^(battery|system status|status)\??$|^how much (battery|ram|memory|disk space|storage|space)( do i have| is)?( left| free| used)?\??$|^(how much )?(free )?(disk|storage) space( left| do i have)?\??$/i.test(t))
    return { kind: "do", actions: [{ do: "system_status" }] };
  // Closing asks the app nicely (it may ask about unsaved work); killing ends it at once.
  if (/^(?:please\s+)?(?:close|quit|exit)\s+(?:it|this|that|this app|that app|the app|this one|that one)(?:\s+please)?[.!]?$/i.test(t))
    return { kind: "do", actions: [{ do: "close_app", name: "it" }] };
  if ((m = t.match(/^(?:close|quit|exit)\s+(?:the\s+)?(?:app\s+|program\s+)?(.+?)(?:\s+(?:app|program|window))?(?:\s+please)?[.!]?$/i)) && !NOT_A_PROGRAM.test(m[1]) && m[1].split(/\s+/).length <= 3)
    return { kind: "do", actions: [{ do: "close_app", name: m[1] }] };
  if ((m = t.match(/^(?:kill|force[- ]?quit|force[- ]?close|end task(?: for)?|end)\s+(?:the\s+)?(?:app\s+|program\s+|process\s+)?(.+?)(?:\s+(?:app|program|process|completely))?$/i)) && !NOT_A_PROGRAM.test(m[1]) && m[1].split(/\s+/).length <= 3)
    return { kind: "do", actions: [{ do: "kill_process", name: m[1] }] };

  // Clipboard.
  if (/^(what'?s|what is|show( me)?|read( me)?)( on| in)? (my |the )?clipboard\??$/i.test(t)) return { kind: "do", actions: [{ do: "clipboard_get" }] };
  if ((m = raw.match(/^copy (.+?) (?:to|into|on) (?:my |the )?clipboard\.?$/is))) return { kind: "do", actions: [{ do: "clipboard_set", text: m[1].replace(/^["“'](.*)["”']$/s, "$1") }] };
  if (/\bclipboard\b|\bwhat i (just )?copied\b|\bthe copied text\b/i.test(t)) return { kind: "clipboard" };

  // Guide: you do it yourself, Bond moves a virtual cursor to each next step.
  if (GUIDE_ME.test(t)) return { kind: "screen", mode: "guide" };

  // Look: explain the screen, or help when stuck.
  if (/\b(stuck|not working|doesn'?t work|isn'?t working|what'?s wrong|what is wrong|can'?t figure|fix (this|it))\b|^help( me)?\??$/i.test(t)) return { kind: "screen", mode: "help" };
  if (/\b(on|in) (my|the) screen\b|\bwhat am i (looking at|seeing)\b|^(explain|summari[sz]e|read) (this|my screen|the page|it)\b/i.test(t)) return { kind: "screen", mode: "explain" };

  return null;
}

// --- Talking back to him (voice) -------------------------------------------------------

const SAID_YES = /^(yes|yeah|yep|yup|sure|ok|okay|do it|go ahead|go for it|please do|confirm)\b/i;
/** "I need you to run this command", "go ahead and execute it": yes, said in a sentence. */
const SAID_YES_ANYWHERE = /\b(run (it|this|that|the command|this command|that command)|execute( it| this| that)?|go ahead|do it|do that|proceed|approve( it)?|yes,? please)\b/i;
const SAID_NO = /^(no|nope|cancel|don'?t|do not|stop|never ?mind|wait)\b/i;
/** The last check before deleting needs the word itself, as typing it does. */
const SAID_CONFIRM = /\b(delete( (it|them|those|these))?|confirm|yes,? (delete|do it))\b/i;
const SAID_STOP = /^(?:(?:ok(?:ay)?,?\s+|hey,?\s+|please,?\s+|bond,?\s+)*(?:stop(?: (?:it|that|this|talking|doing that|please))?|please stop|be quiet|quiet|shut up|enough|never ?mind|cancel(?: (?:it|that|this))?|that'?s all|that'?s enough|thanks?,? bond|thank you|wait|hold on|hold up|forget it|not now|abort))[.!,]?$/i;

/** Answering "Notepad has unsaved changes": don't save / save / cancel. */
export function unsavedAnswer(said: string): "discard" | "save" | "cancel" | null {
  const t = said.trim().toLowerCase();
  if (/\b(don'?t|do not|without|no) sav|^(don'?t|do not) say\b|\bdiscard|\bthrow (it|them) away|\bclose (it )?anyway|\blose (it|them)\b/.test(t)) return "discard";
  if (/\bsave\b|\bkeep (it|them|the changes)\b/.test(t)) return "save";
  if (/^(no|nope|cancel|stop|wait|leave it|never ?mind)\b|\b(cancel|leave it( open)?|keep it open)\b/.test(t)) return "cancel";
  return null;
}

/** He asked "Do this?" and you answered out loud. `lastCheck`: the second check before deleting. */
export function spokenAnswer(said: string, lastCheck: boolean): "yes" | "no" | null {
  const t = said.trim();
  if (SAID_NO.test(t) || /\b(don'?t|do not|never ?mind|cancel)\b/i.test(t)) return "no";
  if (lastCheck ? SAID_CONFIRM.test(t) : SAID_YES.test(t) || SAID_YES_ANYWHERE.test(t)) return "yes";
  return null;
}

/** "Stop", "be quiet", "thanks Bond": stop talking and close. */
export const saidStop = (said: string) => SAID_STOP.test(said.trim());
