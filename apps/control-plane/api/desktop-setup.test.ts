import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, open } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { desktopSetup, importDesktopProvider } from './desktop-setup.ts';
import { listenControlPlane } from './server.ts';
import { Workbench } from '../../../packages/workbench/src/index.ts';
import { assertIsolated } from '../../../packages/workbench/src/test-fixture.ts';

async function fixture(t: TestContext, fetcher: typeof fetch = async () => Response.json({ data: [{ id: 'muse-spark-1.3-contributor-free' }] })) {
  const home = await mkdtemp(join(tmpdir(), 'nomo-setup-'));
  const env = { HOME: home, NOMO_DATA_DIR: join(home, 'nomo'), NOMO_DESKTOP_WEB_ROOT: home };
  const app = new Workbench(env, fetcher);
  assertIsolated(env.NOMO_DATA_DIR, env);
  t.after(async () => {
    try { app.close(); } catch (error) { assert.match(String(error), /Workspace changed in another runtime/); }
    finally { await rm(home, { recursive: true, force: true }); }
  });
  async function save(file: string, data: unknown) {
    const path = join(home, file);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, typeof data === 'string' ? data : JSON.stringify(data), { mode: 0o600 });
    return path;
  }
  return { home, env, app, save };
}
const auth = '.local/share/opencode/auth.json';
const key = 'fixture-private-key-never-expose';
const ompKey = 'fixture-omp-key-never-expose';

/** OMP keeps its API keys in a read-only SQLite table, so the fixture builds
 * one under HOME exactly where the importer resolves it. Only the columns the
 * importer reads are created; a missing column would be a fixture bug, not a
 * product one. */
async function writeOmpCredentials(home: string, entries: Record<string, string>) {
  const directory = join(home, '.omp', 'agent');
  await mkdir(directory, { recursive: true });
  const database = new DatabaseSync(join(directory, 'agent.db'));
  try {
    database.exec("CREATE TABLE auth_credentials (id TEXT PRIMARY KEY, provider TEXT NOT NULL, credential_type TEXT NOT NULL, disabled_cause TEXT, data TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    const insert = database.prepare("INSERT INTO auth_credentials (id, provider, credential_type, disabled_cause, data, updated_at) VALUES (?, ?, 'api_key', NULL, ?, ?)");
    let stamp = 1_700_000_000_000;
    for (const [provider, apiKey] of Object.entries(entries))
      insert.run(`fixture-${provider}`, provider, JSON.stringify({ key: apiKey }), stamp++);
  } finally { database.close(); }
  return join(directory, 'agent.db');
}

test('local import uses fixed endpoint, hides key, selects valid model and survives restart encrypted', async t => {
  let calls = 0;
  const f = await fixture(t, async (url, init) => {
    calls++;
    assert.equal(String(url), 'https://opencode.ai/zen/v1/models');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${key}`);
    assert.equal(init?.redirect, 'error');
    return Response.json({ data: [{ id: 'zen-test-model' }] });
  });
  const file = await f.save(auth, { opencode: { type: 'api', key } });
  const original = await readFile(file);
  const scan = await desktopSetup(f.env);
  assert.equal(scan.sources.find(s => s.id === 'opencode:zen')?.available, true);
  assert.equal(calls, 0, 'Discovery must not contact providers');
  assert.ok(!JSON.stringify(scan).includes(key));
  const result = await importDesktopProvider('opencode:zen', f.env, f.app);
  assert.equal(calls, 1);
  assert.equal(result.defaultModel, 'zen-test-model');
  assert.ok(!JSON.stringify(result).includes(key));
  assert.deepEqual(await readFile(file), original);
  const restored = new Workbench(f.env);
  assertIsolated(f.env.NOMO_DATA_DIR, f.env);
  try { assert.equal((await restored.providerState()).defaultModel, 'zen-test-model'); }
  finally { restored.close(); }
  assert.ok(!(await readFile(join(f.env.NOMO_DATA_DIR, 'workspace.enc'))).includes(Buffer.from(key)));
});

test('Prime TokenRouter import takes the first validated catalog model when none is configured', async t => {
  const f = await fixture(t, async () => Response.json({ data: [{ id: 'other' }, { id: 'z-ai/glm-5.3-flash' }, { id: 'muse-spark-1.3-contributor-free' }] }));
  await f.save('.prime/agent/models.json', { providers: { tokenrouter: { baseUrl: 'https://api.tokenrouter.com/v1', apiKey: key } } });
  const result = await importDesktopProvider('prime:tokenrouter', f.env, f.app);
  // There is no product default to keep any more, so the import takes the
  // head of the validated catalog. What matters to an operator is that it
  // takes a model the provider actually serves, deterministically.
  assert.equal(result.defaultModel, 'other');
  assert.equal(result.providerId, 'tokenrouter');
});

test('unsupported, malformed, OAuth and command credentials never dispatch', async t => {
  const f = await fixture(t, async () => { assert.fail('Must not send credentials'); });
  for (const input of ['{broken', { opencode: { type: 'oauth', access: key } }, { opencode: { type: 'api', key: '!touch /tmp/not-allowed' } }, { opencode: { type: 'api', key: '${SECRET}' } }, { opencode: { type: 'api', key: '' } }]) {
    await f.save(auth, input);
    assert.equal((await desktopSetup(f.env)).sources.find(s => s.id === 'opencode:zen')?.available, false);
    await assert.rejects(importDesktopProvider('opencode:zen', f.env, f.app), /unavailable/);
  }
  await assert.rejects(importDesktopProvider('../../secrets', f.env, f.app), /Unsupported/);
  await assert.rejects(importDesktopProvider(null, f.env, f.app), /Unsupported/);
});

test('custom credential destinations, oversized files and symlinks fail closed', async t => {
  const f = await fixture(t, async () => { assert.fail('Must not send credentials'); });
  await f.save('.prime/agent/models.json', { providers: { tokenrouter: { baseUrl: 'https://attacker.invalid', apiKey: key } } });
  await assert.rejects(importDesktopProvider('prime:tokenrouter', f.env, f.app), /unavailable/);
  const path = await f.save(auth, ' '.repeat(1_048_577));
  await assert.rejects(importDesktopProvider('opencode:zen', f.env, f.app), /unavailable/);
  await rm(path);
  // A file symlink needs Developer Mode or elevation on Windows, and a junction
  // only works for a directory, so the symlink refusal is asserted where the
  // fixture can actually be built. The destination and size refusals above run
  // everywhere. The product refuses a symlink on every platform; only this test
  // is narrower.
  if (process.platform !== 'win32') {
    const target = await f.save('secret.json', { opencode: { type: 'api', key } });
    await symlink(target, path);
    await assert.rejects(importDesktopProvider('opencode:zen', f.env, f.app), /unavailable/);
  }
});

test('a directory at the credential path is refused without being opened', async t => {
  const f = await fixture(t, async () => { assert.fail('Must not send credentials'); });
  await mkdir(join(f.home, auth), { recursive: true });
  await assert.rejects(importDesktopProvider('opencode:zen', f.env, f.app), /unavailable/);
});

test('rejected credential, empty catalog and network failure keep previous provider', async t => {
  let mode = 'ok';
  const f = await fixture(t, async () => {
    if (mode === 'throw') throw new Error(key);
    return mode === 'denied' ? new Response(key, { status: 401 }) : Response.json({ data: mode === 'empty' ? [] : [{ id: 'prior-model' }] });
  });
  await f.app.configure({ baseUrl: 'https://provider.test/v1', apiKey: 'prior' });
  const before = await f.app.providerState();
  await f.save(auth, { opencode: { type: 'api', key } });
  for (mode of ['denied', 'empty', 'throw']) {
    await assert.rejects(importDesktopProvider('opencode:zen', f.env, f.app), error => {
      assert.ok(error instanceof Error && !error.message.includes(key)); return true;
    });
    assert.deepEqual(await f.app.providerState(), before);
  }
});

test('concurrent workspace writer prevents import and retains prior in-memory provider', async t => {
  const f = await fixture(t);
  await f.app.configure({ baseUrl: 'https://prior.test/v1', apiKey: 'prior' });
  const before = await f.app.providerState();
  const second = new Workbench(f.env, async () => Response.json({ data: [{ id: 'second' }] }));
  assertIsolated(f.env.NOMO_DATA_DIR, f.env);
  try {
    await second.configure({ baseUrl: 'https://second.test/v1', apiKey: 'second' });
    await f.save(auth, { opencode: { type: 'api', key } });
    await assert.rejects(importDesktopProvider('opencode:zen', f.env, f.app), /save failed/);
    assert.deepEqual(await f.app.providerState(), before);
    const restored = new Workbench(f.env);
    assertIsolated(f.env.NOMO_DATA_DIR, f.env);
    try { assert.equal((await restored.providerState()).baseUrl, 'https://second.test/v1'); }
    finally { restored.close(); }
  } finally { assert.throws(() => second.close(), /Workspace changed in another runtime/); }
});

test('desktop detection keeps reading the legacy VOID spelling alone', async t => {
  // The migration rule: a NOMO_* name that is present wins, including an empty
  // value; only an absent NOMO_* name falls back to the legacy VOID_* name.
  const home = await mkdtemp(join(tmpdir(), 'nomo-desktop-legacy-'));
  const env = { HOME: home, NOMO_DATA_DIR: join(home, 'nomo'), VOID_DESKTOP_WEB_ROOT: home };
  const server = await listenControlPlane({ env });
  t.after(async () => {
    await server.close();
    await rm(home, { recursive: true, force: true });
  });
  const response = await fetch(`http://127.0.0.1:${server.port}/api/desktop/setup`);
  assert.equal(response.status, 200);
});

test('desktop API blocks remote mode and hostile origins and rejects extra import parameters', async t => {
  const f = await fixture(t);
  await f.save(auth, { opencode: { type: 'api', key } });
  for (const mode of ['desktop', 'plain', 'remote']) {
    const env = { ...f.env, NOMO_DATA_DIR: join(f.home, mode), ...(mode === 'plain' ? { NOMO_DESKTOP_WEB_ROOT: '' } : {}), ...(mode === 'remote' ? { NOMO_CONTROL_TOKEN: 'a'.repeat(64) } : {}) };
    const server = await listenControlPlane({ env });
    try {
      const url = `http://127.0.0.1:${server.port}/api/desktop/setup`;
      const headers = mode === 'remote' ? { authorization: `Bearer ${env.NOMO_CONTROL_TOKEN}` } : {};
      const response = await fetch(url, { headers });
      assert.equal(response.status, mode === 'desktop' ? 200 : 404);
      assert.ok(!(await response.text()).includes(key));
      if (mode === 'desktop') {
        assert.equal((await fetch(url, { headers: { origin: 'https://evil.test' } })).status, 403);
        assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 400);
        assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'opencode:zen', baseUrl: 'https://evil.test' }) })).status, 400);
        assert.equal((await fetch(url, { method: 'DELETE' })).status, 405);
      }
    } finally { await server.close(); }
  }
});

test('TokenRouter JSONC import preserves strings, accepts comments and rejects substituted endpoints', async t => {
  const f = await fixture(t, async () => Response.json({ data: [{ id: 'z-ai/glm-5.3-free' }] }));
  const file = '.config/opencode/opencode.jsonc';
  const content = `// settings\n{"provider":{"tokenrouter":{"options":{/* comment */"baseURL":"https://api.tokenrouter.com/v1","apiKey":"${key}",},},},"literal":"// ,} /* untouched */",}`;
  await f.save(file, content);
  assert.equal((await desktopSetup(f.env)).sources.find(s => s.id === 'opencode:tokenrouter')?.available, true);
  assert.equal((await importDesktopProvider('opencode:tokenrouter', f.env, f.app)).defaultModel, 'z-ai/glm-5.3-free');
  await f.save(file, content.replace('api.tokenrouter.com', 'attacker.example'));
  await assert.rejects(importDesktopProvider('opencode:tokenrouter', f.env, f.app), /unavailable/);
});

test('provider matrix discovers OMP, Prime and OpenCode sources without contacting providers', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return Response.json({ data: [{ id: 'matrix-model' }] }); });
  await f.save(auth, { opencode: { type: 'api', key }, openrouter: { type: 'api', key } });
  await f.save('.prime/agent/auth.json', {
    opencode: { type: 'api_key', key },
    openrouter: { type: 'api_key', key },
    anthropic: { type: 'oauth', access: key, refresh: 'fixture-refresh', expires: 4_102_444_800_000 },
  });
  await writeOmpCredentials(f.home, { nvidia: ompKey, 'opencode-zen': ompKey, 'opencode-go': ompKey, openrouter: ompKey });
  const scan = await desktopSetup(f.env);
  const sources = new Map(scan.sources.map(source => [source.id, source]));
  for (const id of ['omp:nvidia', 'omp:opencode-zen', 'omp:opencode-go', 'prime:anthropic', 'prime:zen', 'prime:openrouter', 'opencode:openrouter'])
    assert.ok(sources.has(id), `discovery must list ${id}`);
  for (const id of ['omp:nvidia', 'omp:opencode-zen', 'omp:opencode-go', 'prime:zen', 'prime:openrouter', 'opencode:openrouter'])
    assert.equal(sources.get(id)?.available, true, `${id} must report its stored key as available`);
  // A subscription entry is offered but explicitly unavailable, never treated
  // as an API key.
  assert.equal(sources.get('prime:anthropic')?.available, false);
  assert.match(String(sources.get('prime:anthropic')?.reason), /^oauth-/);
  assert.equal(calls, 0, 'Discovery must not contact providers');
  const shown = JSON.stringify(scan);
  assert.ok(!shown.includes(key), 'Discovery must never echo an OpenCode or Prime key');
  assert.ok(!shown.includes(ompKey), 'Discovery must never echo an OMP key');
});

test('every matrix row reports its auth method and whether it is host-only', async t => {
  const f = await fixture(t, async () => { assert.fail('Discovery must not contact providers'); });
  await f.save(auth, { opencode: { type: 'api', key } });
  const scan = await desktopSetup(f.env);
  for (const source of scan.sources) {
    assert.ok(
      ['api-key', 'oauth', 'host-subscription'].includes(source.authMethod),
      `${source.id} must report an auth method`,
    );
    assert.equal(typeof source.hostOnly, 'boolean');
    // A host-only row is exactly the row whose login lives in a host CLI.
    assert.equal(
      source.hostOnly,
      source.authMethod === 'host-subscription',
      `${source.id} host-only must match its auth method`,
    );
  }
  assert.deepEqual(
    scan.sources.filter(source => source.hostOnly).map(source => source.id).sort(),
    ['claude:claude-code', 'prime:openai-codex'],
  );
  assert.equal(scan.sources.find(source => source.id === 'opencode:zen')?.authMethod, 'api-key');
  // The matrix is a report of states: no credential value and no path to a
  // credential file may reach it.
  const shown = JSON.stringify(scan);
  assert.ok(!shown.includes('.prime/agent/auth.json'));
  assert.ok(!shown.includes('.local/share/opencode'));
  assert.ok(!shown.includes(f.home));
});

test('OMP OpenCode Go is importable from the key OMP already stores', async t => {
  // The Go endpoint is its own origin, not the Zen one: provider-defaults.ts
  // exports OPENCODE_GO_URL = https://opencode.ai/zen/go/v1 and desktop-setup.ts
  // resolves it through the preset rather than guessing a URL from disk.
  const f = await fixture(t, async () => Response.json({ data: [{ id: 'matrix-model' }] }));
  await writeOmpCredentials(f.home, { 'opencode-go': ompKey });
  assert.equal(
    (await desktopSetup(f.env)).sources.find(source => source.id === 'omp:opencode-go')?.available,
    true,
    'a stored opencode-go key must be available through its provider endpoint',
  );
  const result = await importDesktopProvider('omp:opencode-go', f.env, f.app);
  assert.equal(result.baseUrl, 'https://opencode.ai/zen/go/v1');
});

test('a Prime OAuth entry is never read as an API key', async t => {
  const f = await fixture(t, async () => Response.json({ data: [{ id: 'anthropic-model' }] }));
  const prime = '.prime/agent/auth.json';
  // An expired OAuth session is not a credential the importer can use.
  await f.save(prime, { anthropic: { type: 'oauth', access: key, refresh: 'fixture-refresh', expires: 1 } });
  assert.equal((await desktopSetup(f.env)).sources.find(source => source.id === 'prime:anthropic')?.available, false);
  await assert.rejects(importDesktopProvider('prime:anthropic', f.env, f.app), /unavailable/);
  // A live OAuth session is either imported explicitly with its type and
  // expiry, or refused with a reason. It is never treated as the `key` of an
  // API key entry.
  await f.save(prime, { anthropic: { type: 'oauth', access: key, refresh: 'fixture-refresh', expires: 4_102_444_800_000 } });
  const source = (await desktopSetup(f.env)).sources.find(candidate => candidate.id === 'prime:anthropic');
  assert.ok(source, 'discovery must list prime:anthropic');
  if (source.available) {
    const result = await importDesktopProvider('prime:anthropic', f.env, f.app);
    assert.equal(result.providerId, 'anthropic');
    assert.equal(result.baseUrl, 'https://api.anthropic.com/v1');
  } else {
    assert.match(String(source.reason), /^oauth-/);
    await assert.rejects(importDesktopProvider('prime:anthropic', f.env, f.app), /OAuth subscription import is unavailable/);
  }
  // A hybrid entry that also carries a `key` field is still an OAuth entry.
  await f.save(prime, { anthropic: { type: 'oauth', key, access: key, expires: 4_102_444_800_000 } });
  const hybrid = (await desktopSetup(f.env)).sources.find(candidate => candidate.id === 'prime:anthropic');
  assert.equal(hybrid?.available, false, 'an OAuth entry must not be read through its key field');
});

test('an unknown provider id is unsupported and discovery still resolves', async t => {
  const f = await fixture(t, async () => { assert.fail('Must not send credentials'); });
  await assert.rejects(importDesktopProvider('omp:not-a-provider', f.env, f.app), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Unsupported/);
    return true;
  });
  // Discovery is a report, not an exception: a HOME with nothing in it still
  // yields every source marked unavailable.
  const absent = await desktopSetup({ HOME: join(f.home, 'absent-home'), NOMO_DATA_DIR: join(f.home, 'nomo') });
  assert.ok(absent.sources.length > 0);
  assert.ok(absent.sources.every(source => source.available === false));
});

test('OMP credentials outside HOME, an oversized database and a symlink fail closed', async t => {
  const f = await fixture(t, async () => { assert.fail('Must not send credentials'); });
  const database = await writeOmpCredentials(f.home, { nvidia: ompKey });
  const outside = await mkdtemp(join(tmpdir(), 'nomo-omp-outside-'));
  t.after(async () => { await rm(outside, { recursive: true, force: true }); });
  // A config root the importer is not allowed to follow.
  const escaped = { ...f.env, PI_CODING_AGENT_DIR: outside };
  assert.equal((await desktopSetup(escaped)).sources.find(source => source.id === 'omp:nvidia')?.available, false);
  await assert.rejects(importDesktopProvider('omp:nvidia', escaped, f.app), /unavailable/);
  // A database larger than the importer reads is refused before it is opened.
  const handle = await open(database, 'r+');
  try { await handle.truncate(67_108_865); } finally { await handle.close(); }
  assert.equal((await desktopSetup(f.env)).sources.find(source => source.id === 'omp:nvidia')?.available, false);
  await assert.rejects(importDesktopProvider('omp:nvidia', f.env, f.app), /unavailable/);
  // A planted symlink is refused even when it points at a valid database.
  await rm(database);
  const target = await writeOmpCredentials(join(f.home, 'elsewhere'), { nvidia: ompKey });
  if (process.platform !== 'win32') {
    await symlink(target, database);
    assert.equal((await desktopSetup(f.env)).sources.find(source => source.id === 'omp:nvidia')?.available, false);
    await assert.rejects(importDesktopProvider('omp:nvidia', f.env, f.app), /unavailable/);
  }
});

test('every discovered source imports without echoing its key in results or errors', async t => {
  const f = await fixture(t, async () => Response.json({ data: [{ id: 'matrix-model' }] }));
  await f.save(auth, { opencode: { type: 'api', key }, openrouter: { type: 'api', key } });
  await f.save('.prime/agent/auth.json', { opencode: { type: 'api_key', key }, openrouter: { type: 'api_key', key } });
  await writeOmpCredentials(f.home, { nvidia: ompKey, 'opencode-zen': ompKey, openrouter: ompKey });
  for (const id of ['opencode:zen', 'opencode:openrouter', 'prime:zen', 'prime:openrouter', 'omp:nvidia', 'omp:opencode-zen', 'omp:openrouter']) {
    const shown = JSON.stringify(await importDesktopProvider(id, f.env, f.app));
    assert.ok(!shown.includes(key), `${id} result leaked the OpenCode or Prime key`);
    assert.ok(!shown.includes(ompKey), `${id} result leaked the OMP key`);
  }
  await assert.rejects(importDesktopProvider('prime:anthropic', f.env, f.app), error => {
    assert.ok(!String((error as Error).message).includes(key));
    return true;
  });
});
