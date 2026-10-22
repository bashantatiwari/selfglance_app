// Bond's own understanding of a command: the clear-cut cases are handled right here,
// instantly and without any API call. Anything else returns null and goes to the AI router.
//
//   "idea: an app that tracks plants"   → ideas
//   "goal: finish micrograd"            → today's focus
//   "write me a message to my manager…" → a draft he can put in the box you're typing in
//   "open spotify", "volume up", "set volume to 30", "search for rust tutorials",
//   "lock my laptop", "change my wallpaper to black" → actions
//   "how's my battery", "why is my laptop slow", "close chrome" → the laptop itself
//   "delete my screenshots"             → delete, after showing them and asking twice
//   "what's on my clipboard", "copy hello to clipboard", "summarize my clipboard"
//   "$ ipconfig", "cmd: git status"     → run a command (you approve first)
//   "what's on my screen?"              → look at the screen and explain
//   "help, I'm stuck"                   → look at the screen and help
//   "include yourself in the screenshot" → he shows up in captures for 5 minutes

import { goalFrom } from "./goals.ts";

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
  | { do: "run_command"; command: string; why: string }
  | { do: "kill_process"; name: string }
  | { do: "close_app"; name: string }
  | { do: "delete"; paths: string[]; permanent?: boolean };

export type ScreenMode = "explain" | "help" | "task" | "guide";

export type Intent =
  | { kind: "idea"; text: string }
  /** A message to write for you: "write me a message to my manager…", "what should I reply". */
  | { kind: "draft"; request: string }
  /** Today's focus: "goal: finish micrograd". */
  | { kind: "goal"; text: string }
  | { kind: "do"; actions: Action[] }
  | { kind: "screen"; mode: ScreenMode }
  | { kind: "clipboard" }
  /** Show him in screenshots for a few minutes (show), or hide him from them again. */
  | { kind: "capture"; show: boolean }
  | null;

/** "Screenshot", "recording"...: what a request about being in a picture is about. */
const PICTURE = String.raw`(?:screen\s?shots?|screen\s?captures?|screen\s?recordings?|recordings?|captures?|pictures?|photos?|snips?)`;
const BOND = String.raw`(?:yourself|you|bond)`;
const SHOW_IN_PICTURE = new RegExp(
  [
    String.raw`\b(?:include|show|put|keep|leave|add)\s+${BOND}\s+(?:in|on)\b.*\b${PICTURE}`,
    String.raw`\b(?:appear|show up|be (?:visible|seen))\s+in\b.*\b${PICTURE}`,
    String.raw`\b(?:screen\s?shot|screen\s?capture|recording|picture|photo)\s+(?:with|of)\s+(?:you|bond)\b`,
  ].join("|"),
  "i",
);
const HIDE_FROM_PICTURE = new RegExp(
  [
    String.raw`\b(?:hide|remove|exclude|keep|leave)\s+(?:${BOND}\s+)?(?:from|out of|off)\b.*\b${PICTURE}`,
    String.raw`\b(?:don'?t|do not|never|stop)\b.*\b(?:appear(?:ing)?|show(?:ing)?\s+up|be(?:ing)?\s+(?:visible|seen)|show(?:ing)?\s+${BOND}|include|put)\b.*\b${PICTURE}`,
  ].join("|"),
  "i",
);

const FOLDERS = /^(?:my\s+|the\s+)?(downloads?|documents?|docs|desktop|pictures|photos|screenshots?|music|videos?)(?:\s+folder)?$/i;
const URLISH = /^(?:https?:\/\/)?[\w-]+(\.[\w-]+)+(\/\S*)?$/i;

const MEDIA: [RegExp, string][] = [
  [/^(turn (the )?)?volume up|^(make it )?louder|^increase (the )?volume/i, "volume_up"],
  [/^(turn (the )?)?volume down|^(make it )?(quieter|softer)|^(decrease|lower) (the )?volume/i, "volume_down"],
  [/^(mute|unmute)\b/i, "mute"],
  [/^(pause|resume|play|stop)( (the )?(music|song|video|it))?$/i, "play_pause"],
  [/^(next|skip)( (the |this |that |current )?(song|track|video))?$/i, "next"],
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

/**
 * "Write me a polite email…", "draft a reply", "write a prompt in the chatgpt…", "what should I reply
 * to this?": text to write for a box, which he drafts for you to put in it.
 */
const DRAFT = new RegExp(
  [
    String.raw`^(?:please\s+)?(?:(?:can|could|would) you\s+)?(?:help me\s+)?(?:write|draft|compose|prepare)\s+(?:me\s+)?(?:a|an|the|my|one|some)?\s*(?:(?:short|quick|brief|polite|professional|formal|friendly|casual|careful|clear|official|detailed|good|better|follow[- ]?up|slack|email|e-?mail|teams|whatsapp|linkedin|chat|chat ?gpt|text)\s+)*(?:message|msg|mail|e-?mail|reply|response|dm|follow[- ]?up|apology|resignation|leave request|prompt|post|comment|caption|bio|cover letter|paragraph|announcement|status update|testimonial)\b`,
    // "write … in the chatgpt box", "type … into slack": wherever it says where the text goes
    String.raw`^(?:please\s+)?(?:(?:can|could|would) you\s+)?(?:write|draft|compose|type)\s+(?:me\s+)?.{0,80}?\b(?:in|into|on)\s+(?:the\s+|my\s+)?(?:chat ?gpt|claude|gemini|copilot|slack|gmail|outlook|whatsapp|teams|linkedin|message box|text ?box|compose box|box|field)\b`,
    String.raw`^(?:please\s+)?(?:what|how)\s+(?:should|do|can|could)\s+i\s+(?:reply|respond|say|write|answer)\b`,
    String.raw`^(?:please\s+)?(?:help me\s+)?(?:reply|respond)\s+(?:to|with|saying)\b`,
  ].join("|"),
  "i",
);

/** Words after "close"/"end" that are not a program ("close this tab"). */
const NOT_A_PROGRAM = /^(this|it|that|them|tab|window|all|everything|the call|call|meeting|this tab|this window|the tab|the window|everything else)$/i;

export function understand(input: string): Intent {
  const raw = input.trim().replace(/[ \t]+/g, " ");
  const t = raw.replace(/[.!]+$/, "");
  let m: RegExpMatchArray | null;

  // Remember an idea (an explicit prefix only; the AI catches the rest).
  if ((m = t.match(/^(?:(?:new |project |app )?idea|save (?:this |an |my )?idea|add (?:an |this )?idea)\s*[:\-–]?\s+(.+)$/is))) return { kind: "idea", text: m[1] };

  // Today's focus.
  const goal = goalFrom(t);
  if (goal) return { kind: "goal", text: goal };

  // A message to write (checked before the AI: it is a different kind of answer, a draft to use).
  if (DRAFT.test(t)) return { kind: "draft", request: raw };

  // Being in a screenshot or recording: hidden unless you ask (checked first: "don't show yourself in it").
  if (HIDE_FROM_PICTURE.test(t)) return { kind: "capture", show: false };
  if (SHOW_IN_PICTURE.test(t)) return { kind: "capture", show: true };

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

// A spoken "yes" lets something run, so it has to be a clear, whole answer. A sentence that only
// STARTS with "okay" or merely contains "do it" is not one: "Okay, what does it do?" and
// "should I do it?" are questions, and "I'm not going to delete anything" is a no.
/** An opening yes word: "yes", "okay, …". */
const YES_LEAD = /^(?:yes|yeah|yep|yup|sure|ok|okay|alright|fine)\b[,.!]?\s*/;
/** What a yes may be followed by, and nothing else: "go ahead", "do it", "I need you to run this command". */
const YES_PHRASE =
  /^(?:(?:i (?:need|want) you to|you can|just|please)\s+)?(?:go ahead(?: and (?:run|execute|do) (?:it|that|this|the command))?|do it|do that|run (?:it|this|that|the command|this command|that command)|execute(?: (?:it|this|that|the command))?|proceed|confirm|approve(?: it)?|that'?s fine)$/;
/** Anything that makes it a question or a hedge: never a yes. */
const NOT_A_YES = /\?|\b(what|why|how|when|where|which|who|should|could|would|can|is|are|does|do you|will|wait|but|not|no|if|unless|however|maybe|actually)\b|n't/i;
const SAID_NO = /^(no|nope|cancel|don'?t|do not|stop|never ?mind|wait)\b/i;
const SAID_STOP = /^(?:(?:ok(?:ay)?,?\s+|hey,?\s+|please,?\s+|bond,?\s+)*(?:stop(?: (?:it|that|this|talking|doing that|please))?|please stop|be quiet|quiet|shut up|enough|never ?mind|cancel(?: (?:it|that|this))?|that'?s all|that'?s enough|thanks?,? bond|thank you|wait|hold on|hold up|forget it|not now|abort))[.!,]?$/i;

/** Answering "Notepad has unsaved changes": don't save / save / cancel. */
export function unsavedAnswer(said: string): "discard" | "save" | "cancel" | null {
  const t = said.trim().toLowerCase();
  if (/\b(don'?t|do not|without|no) sav|^(don'?t|do not) say\b|\bdiscard|\bthrow (it|them) away|\bclose (it )?anyway|\blose (it|them)\b/.test(t)) return "discard";
  // "Save" presses the program's Save button, so only a short, plain answer counts ("save it",
  // "yes, save"), never a question or a sentence that happens to mention saving.
  if (/\bsave\b|\bkeep (it|them|the changes)\b/.test(t)) return !NOT_A_YES.test(t) && t.split(/\s+/).length <= 4 ? "save" : null;
  if (/^(no|nope|cancel|stop|wait|leave it|never ?mind)\b|\b(cancel|leave it( open)?|keep it open)\b/.test(t)) return "cancel";
  return null;
}

/**
 * He asked "Do this?" and you answered out loud. A "no" can be loose (it errs on the safe side);
 * a "yes" must be a clear whole answer. `lastCheck` is the second check before deleting: that one
 * is typed ("delete"), never spoken, so a voice (or a TV) can't be the final yes.
 */
export function spokenAnswer(said: string, lastCheck: boolean): "yes" | "no" | null {
  const t = said.trim();
  if (SAID_NO.test(t) || /\b(don'?t|do not|never ?mind|cancel)\b/i.test(t)) return "no";
  if (lastCheck || NOT_A_YES.test(t)) return null;
  const plain = t.toLowerCase().replace(/\b(bond|please)\b/g, " ").replace(/[.!,]+/g, " ").replace(/\s+/g, " ").trim();
  const lead = plain.match(YES_LEAD);
  const rest = (lead ? plain.slice(lead[0].length) : plain).trim();
  if (lead && rest === "") return "yes"; // "yes", "okay"
  return YES_PHRASE.test(rest) ? "yes" : null;
}

/** "Stop", "be quiet", "thanks Bond": stop talking and close. */
export const saidStop = (said: string) => SAID_STOP.test(said.trim());
