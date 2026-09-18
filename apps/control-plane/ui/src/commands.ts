export type Command = {
  id: string;
  name: string;
  description: string;
  source?: string;
  klass?: string;
  inputSchema?: unknown;
  capturedUndo?: boolean;
  tool?: boolean;
};
export function filterCommands(commands: Command[], draft: string): Command[] {
  if (!draft.startsWith("/") || /\s/.test(draft)) return [];
  const query = draft.slice(1).toLowerCase();
  return commands.filter((item) =>
    `${item.name} ${item.description} ${item.source ?? ""}`
      .toLowerCase()
      .includes(query),
  );
}
/** Fuzzy score: 0 = perfect match, higher = worse match. Recent items get lower score. */
function fuzzyScore(text: string, query: string, recencyWeight = 0.95): number {
  if (!query) return 0;
  const lowered = text.toLowerCase();
  const q = query.toLowerCase();
  if (lowered === q) return 0;
  if (lowered.startsWith(q)) return 1;
  if (lowered.includes(q)) return 2;
  return 10;
}
/** Sort commands by fuzzy match score, then by recency (most recent first). */
export function filterPaletteRecentFirst<T extends { text: string; id?: string }>(
  items: readonly T[],
  query: string,
  recentIds?: readonly string[],
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items].sort((a, b) => (recentIds?.includes(b.id ?? "") ? -1 : recentIds?.includes(a.id ?? "") ? 1 : 0));
  return [...items]
    .map((item) => ({
      item,
      score: fuzzyScore(item.text, q),
      recent: recentIds?.includes(item.id ?? ""),
    }))
    .sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      if (a.recent !== b.recent) return a.recent ? -1 : 1;
      return 0;
    })
    .map(({ item }) => item);
}
// The Cmd+K palette matches against pre-rendered bilingual labels so the
// helper stays pure and locale independent. An empty query lists everything.
export function filterPalette<T extends { text: string }>(
  items: readonly T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  return items.filter((item) => item.text.toLowerCase().includes(q));
}
export function toolPrompt(command: Command): string {
  return `Use the ${JSON.stringify(command.name)} tool from ${JSON.stringify(command.source)}. Task: `;
}
