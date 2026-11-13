// The journal was removed in v0.1 (nobody writes one; the day's activity already says what happened).
// Its leftovers in the browser storage (entries an older version kept there, and its "asked
// tonight" flags) are deleted once, here. The journal FILES are deleted separately (journal.rs is gone).

export function removeJournalLeftovers() {
  try {
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("selfglance.journal")) stale.push(k);
    }
    stale.forEach((k) => localStorage.removeItem(k));
    // The photo buddy was removed too (a flat picture beside a 3D Bond never looked right): its sticker goes.
    localStorage.removeItem("selfglance.buddy");
  } catch {
    /* storage unavailable: nothing to remove */
  }
}
