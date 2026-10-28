export interface SplitPaneWidths {
  readonly main: number;
  readonly inspector: number;
  readonly gap: number;
}

/** Resolve the OMP-inspired split layout while retaining NOMO's usable widths. */
export function splitPaneWidths(width: number): SplitPaneWidths | undefined {
  const safeWidth = Math.max(0, Math.floor(width));
  if (safeWidth < 120) return undefined;
  const gap = 7;
  const inspector = Math.min(68, Math.floor((safeWidth - gap) * 0.4));
  return { main: safeWidth - gap - inspector, inspector, gap };
}
