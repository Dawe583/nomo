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
