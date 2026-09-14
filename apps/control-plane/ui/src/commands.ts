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
export function toolPrompt(command: Command): string {
  return `Use the ${JSON.stringify(command.name)} tool from ${JSON.stringify(command.source)}. Task: `;
}
