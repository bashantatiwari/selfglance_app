// Guide mode: after you click, how to tell the page has reacted and stopped moving, so Bond looks
// again as soon as it has instead of after a fixed wait. Pure, so it is tested.

export interface Sig {
  title: string;
  cells: number[];
}

/** Share of the coarse grid whose brightness moved by more than `tol` (0..1). */
export function changedShare(a: number[], b: number[], tol = 24): number {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let moved = 0;
  for (let i = 0; i < n; i++) if (Math.abs(a[i] - b[i]) > tol) moved++;
  return moved / n;
}

/** The screen is showing something new compared with `from`: another window or tab, or enough of it moved. */
export const differs = (from: Sig, now: Sig) => now.title !== from.title || changedShare(from.cells, now.cells) > 0.02;

/** Two looks with nothing moving between them: the page has stopped changing. */
export const still = (a: Sig, b: Sig) => a.title === b.title && changedShare(a.cells, b.cells) < 0.005;
