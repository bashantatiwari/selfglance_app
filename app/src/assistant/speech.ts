// Splitting an answer for speaking: Bond's voice says it a sentence at a time, preparing
// the next while one plays, so he starts talking almost at once.

/** Sentences, with very short ones joined to the next (they sound choppy alone). */
export function sentences(text: string): string[] {
  const parts = text.replace(/\s+/g, " ").match(/[^.!?…]+[.!?…]+["”')\]]*\s*|[^.!?…]+$/g) ?? [text];
  const out: string[] = [];
  for (const p of parts.map((x) => x.trim()).filter(Boolean)) {
    if (out.length && out[out.length - 1].length < 25) out[out.length - 1] += ` ${p}`;
    else out.push(p);
  }
  return out;
}
