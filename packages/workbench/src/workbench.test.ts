import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { DEFAULT_MODEL_ID, OPENCODE_ZEN_URL } from './provider-defaults.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Workbench } from './index.ts';
import { CompatibleProvider } from './provider.ts';
import { LocalStorage } from './storage.ts';
import { readLedgerFeed } from '../../ledger/src/feed.ts';

const secret = 'fixture-provider-secret';
const reply = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const root = fileURLToPath(new URL('../../../', import.meta.url));

test('provider rejects direct OpenAI hosts and never echoes upstream error bodies', async () => {
  for (const baseUrl of ['https://openai.com/v1', 'https://api.openai.com/v1', 'https://sandbox.api.openai.com./v1'])
    assert.throws(() => new CompatibleProvider({ baseUrl, apiKey: secret }), /Direct OpenAI provider URLs are not supported/);
  const provider = new CompatibleProvider({ baseUrl: 'https://provider.test/v1', apiKey: secret }, async () => new Response(secret, { status: 401 }));
  await assert.rejects(provider.models(), error => error instanceof Error && !error.message.includes(secret) && error.message.includes('401'));
});

test('migrates legacy generic provider state to compatible and restores the neutral default', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'void-provider-migration-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  new LocalStorage(dir).save({
    preferences: { defaultModel: 'openai-fast' },
    config: { baseUrl: 'https://provider.test/v1', apiKey: secret, kind: 'openai' },
    profiles: { 'https://provider.test/v1': { baseUrl: 'https://provider.test/v1', apiKey: secret, kind: 'openai' } },
    catalog: [{ id: DEFAULT_MODEL_ID, name: DEFAULT_MODEL_ID }],
    connectors: [], documents: {}, evidence: {}, sessions: [],
  });
  const workbench = new Workbench({ VOID_DATA_DIR: dir });
  assert.equal((await workbench.providerState()).kind, 'compatible');
  assert.equal((await workbench.providerState()).defaultModel, DEFAULT_MODEL_ID);
  workbench.close();
  const saved = new LocalStorage(dir).read<{ preferences: { defaultModel: string }; config: { kind: string }; profiles: Record<string, { kind: string }> }>()!;
  assert.equal(saved.preferences.defaultModel, DEFAULT_MODEL_ID);
  assert.equal(saved.config.kind, 'compatible');
  assert.equal(saved.profiles['https://provider.test/v1']?.kind, 'compatible');
  assert.doesNotMatch(JSON.stringify(saved), /"openai"/);
});

test('model tool calls cross a real VOID proxy and produce a ledger', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'void-agent-beta-'));
  let turn = 0;
  const fetcher: typeof fetch = async (url, options) => {
    assert.equal((options?.headers as Record<string, string>).authorization, `Bearer ${secret}`);
    if (String(url).endsWith('/models')) return reply({ data: [{ id: 'fixture-model' }] });
    const request = JSON.parse(String(options?.body));
    turn++;
    if (turn === 1) {
      const tool = request.tools.find((item: { function: { description: string } }) => item.function.description.startsWith('echo:'));
      const document = request.tools.find((item: { function: { description: string } }) => item.function.description.startsWith('void_workspace_write:'));
      return reply({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'document1', type: 'function', function: { name: document.function.name, arguments: JSON.stringify({ path: 'mixed.md', content: 'Managed and stdio in one session.' }) } }, { id: 'call1', type: 'function', function: { name: tool.function.name, arguments: JSON.stringify({ text: 'fixture echo' }) } }] } }] });
    }
    assert.equal(request.messages.at(-1).role, 'tool');
    return reply({ choices: [{ message: { role: 'assistant', content: `Finished ${secret}` } }], usage: { total_tokens: 23 } });
  };
  const workbench = new Workbench({ VOID_LEDGER_DIR: dir, VOID_UPSTREAM_COMMAND: JSON.stringify([process.execPath, join(root, 'fixtures/e2e-server.mjs')]), VOID_POLICY_PATH: join(root, 'fixtures/e2e-policy.yaml') }, fetcher);
  t.after(async () => { workbench.close(); await rm(dir, { recursive: true, force: true }); });
  await workbench.configure({ baseUrl: 'https://provider.test/v1', apiKey: secret });
  const started = await workbench.start('Test echo', 'fixture-model');
  for (let i = 0; i < 200 && workbench.get(started.id)?.status === 'running'; i++) await delay(20);
  const session = workbench.get(started.id)!;
  assert.equal(session.status, 'idle', JSON.stringify(session.events));
  assert.equal(turn, 2);
  assert.ok(!JSON.stringify(session).includes(secret));
  const feed = await readLedgerFeed(join(dir, `${started.workspace}.jsonl`));
  assert.ok(feed.records.some(record => record.tool === 'echo' && record.decision.startsWith('allow')));
  const managed = await workbench.ledger(started.workspace);
  assert.ok(managed?.entries.some(e => (e.body as {tool:string}).tool === 'void_workspace_write'));
  assert.ok(managed?.entries.some(e => { const b = e.body as {tool:string;source?:string;klass:string}; return b.tool === 'echo' && b.source === 'stdio-proxy' && b.klass === feed.records.find(r => r.tool === 'echo')?.klass; }));
  workbench.cancel(started.id);
  assert.equal(workbench.get(started.id)?.status, 'cancelled');
});

test('a destructive model call waits for an operator in its own workspace', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'void-agent-hold-'));
  let turn = 0;
  const workbench = new Workbench({ VOID_LEDGER_DIR: dir, VOID_UPSTREAM_COMMAND: JSON.stringify([process.execPath, join(root, 'fixtures/e2e-server.mjs')]), VOID_POLICY_PATH: join(root, 'fixtures/e2e-policy.yaml') }, async (url, options) => {
    if (String(url).endsWith('/models')) return reply({ data: [{ id: 'fixture-model' }] });
    if (++turn > 1) return reply({ choices: [{ message: { role: 'assistant', content: 'Operator decision received.' } }] });
    const request = JSON.parse(String(options?.body));
    const tool = request.tools.find((item: { function: { description: string } }) => item.function.description.startsWith('orders_delete:'));
    return reply({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'held', type: 'function', function: { name: tool.function.name, arguments: '{"where":"id = 1"}' } }] } }] });
  });
  t.after(async () => { workbench.close(); await rm(dir, { recursive: true, force: true }); });
  await workbench.configure({ baseUrl: 'https://provider.test/v1', apiKey: secret });
  const session = await workbench.start('Request a destructive fixture', 'fixture-model');
  for (let i = 0; i < 100 && !workbench.pending().length; i++) await delay(20);
  const hold = workbench.pending()[0]!;
  assert.ok(hold);
  assert.equal(hold.call.workspace, session.workspace);
  assert.equal(turn, 1, 'model must wait on VOID approval');
  assert.equal(workbench.decide(hold.holdId, { kind: 'denied', by: 'beta-test' }), true);
  for (let i = 0; i < 100 && workbench.get(session.id)?.status === 'running'; i++) await delay(20);
  assert.equal(workbench.get(session.id)?.status, 'idle');
  const feed = await readLedgerFeed(join(dir, `${session.workspace}.jsonl`));
  assert.ok(feed.records.some(record => record.decision === 'hold:denied'));
});

test('denial text names the rule id, the class and the approval path', async t => {
  const { denialText } = await import('./index.ts');
  assert.equal(
    denialText('orders_delete', 'r3', { kind: 'deny', ruleIndex: 2, rationale: 'only fixture tools are allowed' }),
    'VOID denied orders_delete (r3) by policy rule 2. Reason: only fixture tools are allowed. Change the connector policy or ask the operator to approve this class. Do not retry with reworded arguments.',
  );
  assert.match(
    denialText('orders_delete', 'r3', { kind: 'hold', ruleIndex: 1, rationale: 'destructive fixture tool requires approval' }),
    /by policy rule 1.*operator approval before expiry.*Do not retry/,
  );
  assert.match(denialText('x', 'r3', { kind: 'unmatched' }), /no matching policy rule/);
});

test('long sessions keep advancing event cursors and refuse unbounded context', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'void-agent-context-'));
  const fetcher: typeof fetch = async url => String(url).endsWith('/models')
    ? reply({ data: [{ id: 'fixture-model' }] })
    : reply({ choices: [{ message: { role: 'assistant', content: 'Fixture response' } }], usage: { total_tokens: 1 } });
  const workbench = new Workbench({ VOID_LEDGER_DIR: dir, VOID_UPSTREAM_COMMAND: JSON.stringify([process.execPath, join(root, 'fixtures/e2e-server.mjs')]), VOID_POLICY_PATH: join(root, 'fixtures/e2e-policy.yaml') }, fetcher);
  t.after(async () => { workbench.close(); await rm(dir, { recursive: true, force: true }); });
  await workbench.configure({ baseUrl: 'https://provider.test/v1', apiKey: secret });
  const started = await workbench.start('First', 'fixture-model');
  for (let turn = 0; turn < 99; turn++) {
    for (let poll = 0; poll < 200 && workbench.get(started.id)?.status === 'running'; poll++) await delay(10);
    assert.equal(workbench.get(started.id)?.status, 'idle');
    if (turn < 98) workbench.send(started.id, `Follow up ${turn}`);
  }
  const events = workbench.get(started.id)!.events;
  assert.equal(events.filter(e=>e.type !== "run.status").length, 297);
  assert.equal(events[0]!.seq, 1);
  assert.ok(events.at(-1)!.seq > 200);
  assert.throws(() => workbench.send(started.id, 'Too much context'), /context limit/);
});

test('chat catalog excludes embedding, image and video models', async () => {
  const provider = new CompatibleProvider({baseUrl:'https://provider.test/v1',apiKey:secret}, async () => reply({data:[{id:'chat',type:'language'},{id:'embed',type:'embedding'},{id:'video',type:'video'},{id:'image',type:'image'},{id:'compatible-provider-model'}]}));
  assert.deepEqual((await provider.models()).map(model=>model.id),['chat','compatible-provider-model']);
});

test('OpenCode Zen is the default provider when its key is in the environment', async t => {
  const home = await mkdtemp(join(tmpdir(), 'void-zen-env-home-'));
  const dir = await mkdtemp(join(tmpdir(), 'void-zen-env-data-'));
  const zenKey = 'zen-env-key-fixture';
  let seenUrl = '';
  let seenAuth = '';
  const fetcher: typeof fetch = async (url, options) => {
    seenUrl = String(url);
    seenAuth = (options?.headers as Record<string, string>)?.authorization ?? '';
    return Response.json({ data: [{ id: 'zen-test-model' }] });
  };
  const workbench = new Workbench({ HOME: home, VOID_DATA_DIR: dir, OPENCODE_ZEN_API_KEY: zenKey }, fetcher);
  t.after(async () => { workbench.close(); await rm(home, { recursive: true, force: true }); await rm(dir, { recursive: true, force: true }); });
  const state = await workbench.providerState();
  assert.equal(state.providerId, 'opencode-zen');
  assert.equal(state.connected, true);
  assert.equal(state.defaultModel, 'zen-test-model');
  assert.ok(seenUrl.startsWith(OPENCODE_ZEN_URL), seenUrl);
  assert.ok(seenAuth.includes(zenKey), seenAuth);
  assert.ok(!JSON.stringify(state).includes(zenKey));
});

test('OpenCode Zen falls back to the local opencode auth file for its key', async t => {
  const home = await mkdtemp(join(tmpdir(), 'void-zen-file-home-'));
  const dir = await mkdtemp(join(tmpdir(), 'void-zen-file-data-'));
  const fileKey = 'zen-auth-file-key-fixture';
  await mkdir(join(home, '.local', 'share', 'opencode'), { recursive: true });
  await writeFile(join(home, '.local', 'share', 'opencode', 'auth.json'), JSON.stringify({ opencode: { type: 'api', key: fileKey } }));
  let seenAuth = '';
  const fetcher: typeof fetch = async (_url, options) => {
    seenAuth = (options?.headers as Record<string, string>)?.authorization ?? '';
    return Response.json({ data: [{ id: 'zen-test-model' }] });
  };
  const workbench = new Workbench({ HOME: home, VOID_DATA_DIR: dir }, fetcher);
  t.after(async () => { workbench.close(); await rm(home, { recursive: true, force: true }); await rm(dir, { recursive: true, force: true }); });
  const state = await workbench.providerState();
  assert.equal(state.providerId, 'opencode-zen');
  assert.equal(state.connected, true);
  assert.ok(seenAuth.includes(fileKey), seenAuth);
  assert.ok(!JSON.stringify(state).includes(fileKey));
});

test('without any Zen key the workbench configures no provider and dispatches nothing', async t => {
  const home = await mkdtemp(join(tmpdir(), 'void-zen-empty-home-'));
  const dir = await mkdtemp(join(tmpdir(), 'void-zen-empty-data-'));
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; throw new Error('must not dispatch anything'); };
  const workbench = new Workbench({ HOME: home, VOID_DATA_DIR: dir }, fetcher);
  t.after(async () => { workbench.close(); await rm(home, { recursive: true, force: true }); await rm(dir, { recursive: true, force: true }); });
  const state = await workbench.providerState();
  assert.equal(state.connected, false);
  assert.equal(state.providerId, 'custom');
  assert.equal(calls, 0);
});
