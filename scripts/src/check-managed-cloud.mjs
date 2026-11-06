// Run against an isolated Neon branch, never the application's DATABASE_URL:
// NOMO_TEST_DATABASE_ISOLATED=1 node --env-file=.env.cloud-test scripts/src/check-managed-cloud.mjs
// .env.cloud-test contains NOMO_TEST_DATABASE_URL. No production settings change.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomBytes, randomUUID, generateKeyPairSync } from 'node:crypto';
import { validateCloudTestEnvironment } from './cloud-test-config.mjs';

const testUrl = process.env.NOMO_TEST_DATABASE_URL;
if (!testUrl || process.env.NOMO_TEST_DATABASE_ISOLATED !== '1') {
  throw new Error('An explicitly isolated NOMO_TEST_DATABASE_URL and NOMO_TEST_DATABASE_ISOLATED=1 are required. The production database is never a fallback.');
}
function target(value) {
  const url = new URL(value);
  return `${url.hostname.replace('-pooler.', '.')}${url.pathname}`;
}
if (process.env.DATABASE_URL && target(testUrl) === target(process.env.DATABASE_URL)) {
  // The CI preload has already selected the disposable loopback service.
  // Identical remote/application targets still fail before any schema mutation.
  validateCloudTestEnvironment(process.env);
}
process.env.DATABASE_URL = testUrl;
process.env.NOMO_CONTROL_TOKEN = randomBytes(32).toString('hex');
process.env.NOMO_SECRET_KEY = randomBytes(32).toString('base64');
process.env.NOMO_SIGNING_KEY = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
process.env.NOMO_LOCAL_TEST = '1';

const { transaction, write, read, encrypt, decrypt, ledger, database } = await import('../../cloud/store.mjs');
const { advance } = await import('../../cloud/steps.mjs');
const { OPERATOR_OWNER } = await import('../../cloud/owner.mjs');
const { default: app } = await import('../../cloud/server.mjs');
const { workspaceTools } = await import('../../packages/workbench/src/workspace.ts');
const { canonicalJson } = await import('../../packages/ledger/src/canonical.ts');
const { sha256Hex } = await import('../../packages/ledger/src/sign.ts');
const secret = `fixture-${randomUUID()}`;
let turns = 0;
const fixture = createServer(async (req, res) => {
  try {
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    assert.equal(req.url, '/v1/chat/completions');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw);
    turns++;
    const tool = input.tools.find(item => item.function.description.startsWith('void_workspace_write:'));
    assert.ok(tool);
    const message = input.messages.at(-1).role === 'tool'
      ? { role: 'assistant', content: `No document was created. ${secret}` }
      : { role: 'assistant', content: null, tool_calls: [{ id: 'managed-write', type: 'function', function: { name: tool.function.name, arguments: JSON.stringify({ path: 'notes/plan.md', content: 'Managed cloud document.' }) } }] };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }));
  } catch {
    res.writeHead(500); res.end('Provider fixture assertion failed.');
  }
});
const server = createServer(app);
const listen = instance => new Promise((resolve, reject) => { instance.once('error', reject); instance.listen(0, '127.0.0.1', resolve); });
const close = instance => new Promise(resolve => { instance.close(resolve); instance.closeAllConnections(); });
const id = randomUUID(), workspace = `qa-${id}`;
try {
  await database().query(await readFile(new URL('../../cloud/schema.sql', import.meta.url), 'utf8'));
  await listen(fixture); await listen(server);
  const providerUrl = `http://127.0.0.1:${fixture.address().port}/v1`;
  const origin = `http://127.0.0.1:${server.address().port}`;
  const api = async (path, method = 'GET', body) => {
    const response = await fetch(`${origin}${path}`, { method, headers: { authorization: `Bearer ${process.env.NOMO_CONTROL_TOKEN}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await fetch(`${origin}/api/sessions/${id}/workspace`)).status, 401);
  await write(OPERATOR_OWNER, `session:${id}`, { id, workspace, createdAt: new Date().toISOString(), model: 'fixture-managed', status: 'running', events: [], messages: [{ role: 'user', content: 'Create a managed document.' }], tools: workspaceTools.map(tool => ({ ...tool, builtin: true })), provider: { secret: encrypt({ baseUrl: providerUrl, apiKey: secret }) }, generation: 1, turn: 0, queue: [] });
  assert.equal(await advance(OPERATOR_OWNER, id, 1), 'next');
  assert.equal(await advance(OPERATOR_OWNER, id, 1), 'wait');
  const pending = await read(OPERATOR_OWNER, `session:${id}`);
  assert.equal(await read(OPERATOR_OWNER, `workspace:${id}`), undefined);
  const hold = await read(OPERATOR_OWNER, `hold:${pending.pending.id}`);
  assert.equal((await api(`/api/approvals/${hold.holdId}/decision`, 'POST', {
    kind: 'denied', token: hold.decisionToken,
  })).status, 200);
  assert.equal(await advance(OPERATOR_OWNER, id, 1), 'next');
  assert.equal(await advance(OPERATOR_OWNER, id, 1), 'next');
  const session = await read(OPERATOR_OWNER, `session:${id}`);
  assert.equal(session.status, 'idle');
  assert.equal(turns, 2);
  assert.ok(!JSON.stringify(session).includes(secret), 'Provider credentials must be redacted from persisted model output.');
  assert.equal((await api(`/api/sessions/${id}/documents`, 'PATCH', {
    path: 'notes/plan.md', content: 'Managed cloud document.', expectedRevision: null,
  })).status, 200);
  const sealed = await read(OPERATOR_OWNER, `workspace:${id}`);
  assert.equal(typeof sealed, 'string');
  assert.ok(!sealed.includes('Managed cloud document.'));
  const state = decrypt(sealed), operation = state.operations[0];
  assert.equal(state.files['notes/plan.md'], 'Managed cloud document.');
  const proof = await ledger(OPERATOR_OWNER, workspace);
  assert.equal(proof.result.ok, true);
  assert.ok(proof.entries.some(entry => entry.body.operationId === operation.id && entry.body.captureDigest === undefined) === false);
  const captureDigest = await sha256Hex(canonicalJson(operation));
  assert.ok(proof.entries.some(entry => entry.body.operationId === operation.id && entry.body.captureDigest === captureDigest && entry.body.decision === 'execute:completed'));
  const path = `/api/sessions/${id}/undo/${encodeURIComponent(operation.id)}`;
  const preview = await api(path);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.canApply, true);
  assert.equal(preview.body.after, null);
  assert.equal((await api(path, 'POST', {})).status, 409);

  const forged = structuredClone(state);
  forged.operations[0].before = 'Forged prior content';
  forged.operations[0].digest = captureDigest;
  await transaction(OPERATOR_OWNER, id, c => write(OPERATOR_OWNER, `workspace:${id}`, encrypt(forged), c));
  assert.equal((await api(path)).status, 400, 'Undo must reject a capture that no longer matches signed evidence.');
  const drifted = structuredClone(state);
  drifted.files['notes/plan.md'] = 'Newer independent edit';
  await transaction(OPERATOR_OWNER, id, c => write(OPERATOR_OWNER, `workspace:${id}`, encrypt(drifted), c));
  assert.equal((await api(path, 'POST', { confirm: operation.id })).status, 400);
  assert.equal(decrypt(await read(OPERATOR_OWNER, `workspace:${id}`)).files['notes/plan.md'], 'Newer independent edit');
  await transaction(OPERATOR_OWNER, id, c => write(OPERATOR_OWNER, `workspace:${id}`, sealed, c));
  assert.equal((await api(path, 'POST', { confirm: operation.id })).status, 200);
  assert.deepEqual(decrypt(await read(OPERATOR_OWNER, `workspace:${id}`)).files, {});
  const after = await ledger(OPERATOR_OWNER, workspace);
  assert.equal(after.result.ok, true);
  assert.equal(after.entries.filter(entry => entry.body.tool === 'void_workspace_undo').length, 1);
  assert.equal((await api(path, 'POST', { confirm: operation.id })).status, 200);
  assert.equal((await ledger(OPERATOR_OWNER, workspace)).entries.length, after.entries.length);
  assert.equal((await api(`/api/sessions/${id}/workspace`)).body.workspace.operations.length, 2);
  console.log('PASS isolated cloud: agent write held and denied, operator edit captured, signed binding, drift refusal, forged capture refusal and idempotent undo.');
} finally {
  await close(fixture); await close(server);
  // Evidence is append-only, including test evidence. Only this run's mutable
  // documents and session are cleaned; no provider or connector settings change.
  await database().query('DELETE FROM void_cloud_state WHERE owner=$1 AND key = ANY($2::text[])', [OPERATOR_OWNER, [`session:${id}`, `workspace:${id}`]]).catch(() => {});
  await database().end();
}
