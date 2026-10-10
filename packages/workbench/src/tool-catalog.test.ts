import test from 'node:test';
import assert from 'node:assert/strict';
import { toolCatalog } from './tool-catalog.ts';
import { workspaceTools } from './workspace.ts';
import { filterCommands, toolPrompt } from '../../../apps/control-plane/ui/src/commands.ts';

test('tool catalogue never claims Undo for a connector impersonating a built-in tool', () => {
  const tools = toolCatalog([...workspaceTools, { ...workspaceTools[2], connectorId: 'external', token: 'private' } as typeof workspaceTools[2] & { connectorId: string; token: string }]);
  assert.equal(tools[2]!.capturedUndo, true);
  assert.equal(tools[4]!.capturedUndo, false);
  assert.equal(tools[4]!.klass, 'policy');
  assert.equal(new Set(tools.map(tool => tool.id)).size, tools.length);
  assert.doesNotMatch(JSON.stringify(tools), /private|token/);
});
test('slash search filters metadata, does not capture prose, and selection only prepares a request', () => {
  const tools = toolCatalog(workspaceTools);
  assert.equal(filterCommands(tools, '/').length, 4);
  assert.deepEqual(filterCommands(tools, '/read').map(t => t.name), ['nomo_workspace_read']);
  assert.equal(filterCommands(tools, '/unknown').length, 0);
  assert.equal(filterCommands(tools, '/read document').length, 0);
  assert.equal(filterCommands(tools, 'a /read').length, 0);
  assert.match(toolPrompt(tools[2]!), /tool from "workspace"\. Task: $/);
});

test('session tool catalogue uses its snapshot and rejects unknown sessions', async t => {
  const { Workbench } = await import('./index.ts');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'nomo-tools-'));
  const app = new Workbench({ NOMO_DATA_DIR: directory }, async url => String(url).endsWith('/models') ? Response.json({ data: [{ id: 'fixture' }] }) : Response.json({ choices: [{ message: { role: 'assistant', content: 'Ready' } }] }));
  t.after(async () => { await app.shutdown(); await rm(directory, { recursive: true, force: true }); });
  assert.equal(app.availableTools().scope, 'configured');
  assert.throws(() => app.availableTools('missing'), /Session not found/);
  await app.configure({ baseUrl: 'https://fixture.test/v1', apiKey: 'private-key' });
  const session = await app.start('Hello', 'fixture');
  const snapshot = app.availableTools(session.id);
  assert.equal(snapshot.scope, 'session');
  assert.deepEqual(snapshot.tools.map(t => t.name), workspaceTools.map(t => t.name));
  assert.doesNotMatch(JSON.stringify(snapshot), /private-key|messages|baseUrl/);
});

test('catalogue redacts known connector credentials even if echoed in remote schemas', () => {
  const secret = 'private"token';
  const rows = toolCatalog([{ name: 'remote', connectorId: 'server', description: `Echo ${secret}`, inputSchema: { default: secret } }], [secret]);
  assert.equal(rows[0]!.description, 'Echo [redacted]');
  assert.deepEqual(rows[0]!.inputSchema, { default: '[redacted]' });
});
