import { workspaceToolClass } from './workspace.ts';

/** Public metadata only: never expose connection URLs, credentials or model messages. */
export function toolCatalog(tools: readonly { name: string; description?: string; inputSchema?: unknown; connectorId?: string }[], secrets: readonly (string | undefined)[] = []) {
  const rows = tools.map((tool, index) => ({
    id: `${tool.connectorId ?? 'workspace'}:${index}:${tool.name}`,
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema ?? {},
    source: tool.connectorId ?? 'workspace',
    // External tools are classified by their configured policy at execution time.
    klass: tool.connectorId ? 'policy' : workspaceToolClass(tool.name) ?? 'policy',
    capturedUndo: !tool.connectorId && (tool.name === 'void_workspace_write' || tool.name === 'void_workspace_delete'),
  }));
  let serialized = JSON.stringify(rows);
  for (const secret of secrets) if (secret) serialized = serialized.split(JSON.stringify(secret).slice(1, -1)).join("[redacted]");
  return JSON.parse(serialized) as typeof rows;
}
