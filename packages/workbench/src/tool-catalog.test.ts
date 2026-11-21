import test from 'node:test';
import assert from 'node:assert/strict';
import { toolCatalog } from './tool-catalog.ts';
import { workspaceTools } from './workspace.ts';
import { HARNESS_TOOLS } from './harness-tools.ts';
import { filterCommands, toolPrompt } from '../../../apps/control-plane/ui/src/commands.ts';
import { isolatedWorkbench } from './test-fixture.ts';

test('tool catalogue never claims Undo for a connector impersonating a built-in tool', () => {
  const tools = toolCatalog([...workspaceTools, { ...workspaceTools[2], connectorId: 'external', token: 'private' } as typeof workspaceTools[2] & { connectorId: string; token: string }]);
  assert.equal(tools.find(tool => tool.name === 'void_workspace_write')!.capturedUndo, true);
  assert.equal(tools.find(tool => tool.name === 'nomo_delegate')!.capturedUndo, false);
  const impersonator = tools.find(tool => tool.source === 'external')!;
  assert.equal(impersonator.capturedUndo, false);
  assert.equal(impersonator.klass, 'policy');
  assert.equal(new Set(tools.map(tool => tool.id)).size, tools.length);
  assert.doesNotMatch(JSON.stringify(tools), /private|token/);
});
test('slash search filters metadata, does not capture prose, and selection only prepares a request', () => {
  const tools = toolCatalog(workspaceTools);
  assert.equal(filterCommands(tools, '/').length, 9);
  assert.ok(filterCommands(tools, '/').some(tool => tool.name === 'nomo_plan_update'));
  assert.ok(filterCommands(tools, '/').some(tool => tool.name === 'nomo_delegate'));
  assert.ok(filterCommands(tools, '/').some(tool => tool.name === 'nomo_subagent_result'));
  assert.ok(filterCommands(tools, '/').some(tool => tool.name === 'nomo_session_search'));
  assert.deepEqual(filterCommands(tools, '/read').map(t => t.name), ['void_workspace_read', 'nomo_delegate', 'nomo_subagent_result']);
  assert.equal(filterCommands(tools, '/unknown').length, 0);
  assert.equal(filterCommands(tools, '/read document').length, 0);
  assert.equal(filterCommands(tools, 'a /read').length, 0);
  assert.match(toolPrompt(tools[2]!), /tool from "workspace"\. Task: $/);
});

test('session tool catalogue uses its snapshot and rejects unknown sessions', async t => {
  // `configure: false` keeps the deliberate unconfigured window this test
  // asserts against; the operator configure below is what makes it scoped.
  const { app } = await isolatedWorkbench(t, async url => String(url).endsWith('/models') ? Response.json({ data: [{ id: 'fixture' }] }) : Response.json({ choices: [{ message: { role: 'assistant', content: 'Ready' }, finish_reason: 'stop' }] }), {}, { configure: false, prefix: 'nomo-tools-' });
  assert.equal(app.availableTools().scope, 'configured');
  assert.throws(() => app.availableTools('missing'), /Session not found/);
  await app.configure({ baseUrl: 'https://fixture.test/v1', apiKey: 'private-key' });
  const session = await app.start('Hello', 'fixture');
  const snapshot = app.availableTools(session.id);
  assert.equal(snapshot.scope, 'session');
  // The session's snapshot is its own: the workspace tools it runs on, the
  // project tool it may hold, and the harness tools the agent may propose
  // with. A proposal is inert until an operator approves it, so offering the
  // tool does not offer the harness itself.
  assert.deepEqual(
    snapshot.tools.map(t => t.name),
    [
      ...workspaceTools.filter(t => t.name !== 'nomo_project_exec' && t.name !== 'nomo_session_search').map(t => t.name),
      ...HARNESS_TOOLS.map(tool => tool.name),
    ],
  );
  assert.doesNotMatch(JSON.stringify(snapshot), /private-key|messages|baseUrl/);
});

test('catalogue redacts known connector credentials even if echoed in remote schemas', () => {
  const secret = 'private"token';
  const rows = toolCatalog([{ name: 'remote', connectorId: 'server', description: `Echo ${secret}`, inputSchema: { default: secret } }], [secret]);
  assert.equal(rows[0]!.description, 'Echo [redacted]');
  assert.deepEqual(rows[0]!.inputSchema, { default: '[redacted]' });
});
