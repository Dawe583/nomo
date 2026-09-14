import { workspaceToolClass } from './workspace.ts';

/** Public metadata only: never expose connection URLs, credentials or model messages. */
export function toolCatalog(tools: readonly { name: string; description?: string; inputSchema?: unknown; connectorId?: string }[]) {
  return tools.map((tool, index) => ({
    id: `${tool.connectorId ?? 'workspace'}:${index}:${tool.name}`,
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema ?? {},
    source: tool.connectorId ?? 'workspace',
    // External tools are classified by their configured policy at execution time.
    klass: tool.connectorId ? 'policy' : workspaceToolClass(tool.name) ?? 'policy',
    capturedUndo: !tool.connectorId && workspaceToolClass(tool.name) === 'r1',
  }));
}
