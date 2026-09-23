// A disposable, explicitly labeled provider fixture for browser interaction QA.
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createControlPlaneServer } from '../../apps/control-plane/api/server.ts';
const port = Number(process.env.VOID_QA_PORT ?? 8082);
const modelPort = Number(process.env.VOID_QA_MODEL_PORT ?? 8083);
const directory = await mkdtemp(join(tmpdir(), 'void-workspace-preview-'));
const model = createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'qa-fixture', name: 'QA fixture (not a live model)' }] }));
  let raw = ''; for await (const part of req) raw += part;
  const input = JSON.parse(raw), last = input.messages.at(-1);
  const tool = input.tools.find(t => t.function.description.startsWith('void_workspace_write:'));
  const message = last.role === 'tool' ? { role: 'assistant', content: 'QA fixture: plan.md was written through the real VOID document tool. Open Documents & Undo to review the captured change.' }
    : { role: 'assistant', content: 'QA fixture: creating a project plan with captured history.', tool_calls: [{ id: `qa-${Date.now()}`, type: 'function', function: { name: tool.function.name, arguments: JSON.stringify({ path: 'plan.md', content: '# Project plan\n\n1. Define the scope.\n2. Build the smallest useful version.\n3. Verify every write and its inverse.\n' }) } }] };
  res.end(JSON.stringify({ choices: [{ message }] }));
});
await new Promise(resolve => model.listen(modelPort, '127.0.0.1', resolve));
const app = createControlPlaneServer({ env: { VOID_DATA_DIR: directory, VOID_LEDGER_DIR: join(directory, 'ledger') } });
async function close() { await new Promise(resolve => app.close(resolve)); await new Promise(resolve => model.close(resolve)); await rm(directory, { recursive: true, force: true }); }
process.once('SIGINT', () => void close()); process.once('SIGTERM', () => void close());

await new Promise(resolve => app.listen(port, '127.0.0.1', resolve));
try {
  const configured = await fetch(`http://127.0.0.1:${port}/api/provider`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseUrl: `http://127.0.0.1:${modelPort}/v1`, apiKey: 'qa-fixture-key', kind: 'compatible' }),
  });
  if (!configured.ok) throw new Error(`Fixture setup failed: HTTP ${configured.status}`);
  console.log(`Disposable workspace QA: http://127.0.0.1:${port} (local qa-fixture provider)`);
} catch (error) {
  await close();
  throw error;
}
