// Splitting an answer for speaking: Bond's voice says the first sentence on its own, so he
// starts talking almost at once, then the rest in longer pieces, prepared while one plays.
// Longer pieces keep his intonation flowing; a sentence at a time sounded robotic.

/** Longest piece after the first (characters). */
const PIECE = 220;

/** Text as it should sound: no markdown, symbols or file paths read out letter by letter. */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*|__|^#+\s*|^\s*[-*•]\s+/gm, "")
    .replace(/[A-Za-z]:\\[^\s,;)]*\\([^\\\s,;)]+)/g, "$1") // C:\Users\…\cm.txt → cm.txt
    .replace(/https?:\/\/([^/\s]+)\S*/g, "$1")
    .replace(/[✓✔✗×·→←]/g, " ")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/\s*\n+\s*/g, ". ")
    .replace(/([.!?])\.\s/g, "$1 ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Pieces to speak: the first sentence (short ones joined to the next), then up to PIECE characters each. */
export function sentences(text: string): string[] {
  const parts = text.replace(/\s+/g, " ").match(/[^.!?…]+[.!?…]+["”')\]]*\s*|[^.!?…]+$/g) ?? [text];
  const out: string[] = [];
  for (const p of parts.map((x) => x.trim()).filter(Boolean)) {
    const last = out[out.length - 1];
    const join = last !== undefined && (out.length === 1 ? last.length < 25 : last.length + p.length < PIECE);
    if (join) out[out.length - 1] += ` ${p}`;
    else out.push(p);
  }
  return out;
}
