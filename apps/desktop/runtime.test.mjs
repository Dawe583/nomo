import test from 'node:test';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createInterface } from 'node:readline';

import { devKeyProvider } from '../../packages/ledger/src/sign.ts';
import { jsonlStore } from '../../packages/ledger/src/store.ts';

const desktop = fileURLToPath(new URL('./', import.meta.url));
const web = fileURLToPath(new URL('../control-plane/web/', import.meta.url));
const ownedKeys = [
  'OPENCODE_ZEN_API_KEY', 'TOKENROUTER_API_KEY', 'OPENROUTER_API_KEY',
  ...['DATA_DIR', 'DESKTOP_WEB_ROOT', 'LEDGER_DIR', 'WORKSPACE', 'WORKSPACE_KEY',
    'CONTROL_TOKEN', 'CONTROL_HOST', 'PERMISSION_MODE', 'APPROVALS_DIR', 'SNAPSHOT_DIR',
    'SIGNING_KEY', 'VERIFY_KEY', 'PROVIDER_URL', 'UPSTREAM_COMMAND', 'POLICY_PATH']
    .flatMap(name => [`NOMO_${name}`, `VOID_${name}`]),
];

/** The environment with every owned name removed, under either spelling. */
function withoutOwned(env) {
  const kept = { ...env };
  for (const key of ownedKeys) delete kept[key];
  return kept;
}

/**
 * Run the runtime with only the named owned settings present, and hand the
 * test the origin it serves on.
 */
async function withRuntime(env, run) {
  const home = await mkdtemp(join(tmpdir(), 'nomo-desktop-home-'));
  const child = spawn(process.execPath, [join(desktop, 'runtime.mjs')], {
    // Every owned name is dropped from the inherited environment first, so what a
    // test asserts is the setting it declared and nothing the developer exported.
    env: { ...withoutOwned({ ...process.env, HOME: home }), ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  const lines = createInterface({ input: child.stdout });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  try {
    const [line] = await Promise.race([
      once(lines, 'line'),
      exited.then(([code]) => { throw new Error(`Runtime exited with ${code}: ${output}`); }),
    ]);
    const ready = JSON.parse(line);
    try {
      return await run(`http://127.0.0.1:${ready.port}`, () => output);
    } finally {
      child.stdin.end();
      const [code] = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve(['timeout']), 4000))]);
      assert.deepEqual(code, 0, output);
    }
  } finally {
    child.kill('SIGKILL');
    lines.close();
    await rm(home, { recursive: true, force: true });
  }
}

test('desktop runtime serves the shared workbench, rejects foreign origins, and stops with its owner', { timeout: 20000 }, async () => {
  const data = await mkdtemp(join(tmpdir(), 'nomo-desktop-'));
  const packaged = process.env.NOMO_TEST_PACKAGED === '1';
  const executable = packaged ? join(desktop, 'src-tauri/resources/bin/node') : process.execPath;
  const entry = packaged ? join(desktop, 'src-tauri/resources/runtime/runtime.mjs') : join(desktop, 'runtime.mjs');
  const home = await mkdtemp(join(tmpdir(), 'nomo-desktop-home-'));
  const env = { ...process.env, HOME: home, NOMO_DATA_DIR: data, NOMO_DESKTOP_WEB_ROOT: packaged ? join(desktop, 'src-tauri/resources/web') : web, NOMO_CONTROL_TOKEN: 'ignored-cloud-token'.repeat(4), NOMO_WORKSPACE_KEY: randomBytes(32).toString('base64') };
  for (const key of ['OPENCODE_ZEN_API_KEY', 'TOKENROUTER_API_KEY', 'OPENROUTER_API_KEY', 'NOMO_PROVIDER_URL', 'NOMO_UPSTREAM_COMMAND', 'NOMO_POLICY_PATH', 'NOMO_LEDGER_DIR', 'NOMO_SIGNING_KEY', 'NOMO_VERIFY_KEY']) delete env[key];
  const child = spawn(executable, [entry], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  const lines = createInterface({ input: child.stdout });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk.toString(); });
  try {
    const [line] = await Promise.race([once(lines, 'line'), exited.then(() => { throw new Error(`Runtime startup failed: ${errors}`); })]);
    const ready = JSON.parse(line);
    const origin = `http://127.0.0.1:${ready.port}`;
    assert.equal(ready.pid, child.pid);
    const page = await fetch(origin);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /NOMO/);
    if (packaged) {
      const script = html.match(/src="(\/assets\/[^\"]+\.js)"/)?.[1];
      assert.ok(script, 'Packaged desktop contains the shared React build');
      assert.equal((await fetch(origin + script)).status, 200);
      assert.equal((await fetch(origin + '/chat/new')).status, 200);
    }
    const state = await fetch(`${origin}/api/provider`);
    assert.equal(state.status, 200);
    assert.equal((await state.json()).connected, false);
    // The runtime consumes the workspace key from its environment and drops it
    // before the backend starts, so the bytes the operator configured never
    // reach the disk it would otherwise be written to.
    const persistedKey = await readFile(join(data, 'workspace.key'), 'utf8').catch(() => undefined);
    assert.notEqual(persistedKey, env.NOMO_WORKSPACE_KEY);
    const foreign = await fetch(`${origin}/api/provider`, { headers: { origin: 'https://attacker.invalid' } });
    assert.equal(foreign.status, 403);
    if (process.platform !== 'win32') assert.equal((await stat(data)).mode & 0o777, 0o700);
    child.stdin.end();
    const [code] = await exited;
    assert.equal(code, 0, errors);
    await assert.rejects(fetch(origin));
  } finally {
    child.kill('SIGKILL');
    lines.close();
    await rm(data, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('desktop runtime starts from a legacy data directory', { timeout: 20000 }, async () => {
  const data = join(await mkdtemp(join(tmpdir(), 'nomo-desktop-')), 'legacy-data');
  try {
    await withRuntime({ VOID_DATA_DIR: data, NOMO_DESKTOP_WEB_ROOT: web }, async origin => {
      const page = await fetch(origin);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /NOMO/);
      if (process.platform !== 'win32') assert.equal((await stat(data)).mode & 0o777, 0o700);
    });
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

async function seedLedger(dir, workspace, tool) {
  const signer = await devKeyProvider({ dir: join(dir, 'keys'), env: {} });
  const store = jsonlStore(signer, { dir });
  await store.append({ workspace, at: '2026-09-01T00:00:00.000Z', tool, klass: 'r1', decision: 'allow:resolved', argsDigest: '1'.repeat(64) });
}

test('desktop runtime reads the legacy ledger directory and workspace name', { timeout: 20000 }, async () => {
  const data = await mkdtemp(join(tmpdir(), 'nomo-desktop-'));
  const legacyLedger = await mkdtemp(join(tmpdir(), 'nomo-desktop-ledger-'));
  const currentLedger = await mkdtemp(join(tmpdir(), 'nomo-desktop-current-'));
  try {
    await seedLedger(legacyLedger, 'legacy-ws', 'legacy-ws.call');
    await seedLedger(currentLedger, 'current-ws', 'current-ws.call');
    const feed = async origin => {
      const body = await (await fetch(`${origin}/api/feed`)).json();
      return { scope: body.scope, tools: body.entries.map(entry => entry.tool) };
    };
    await withRuntime({ VOID_DATA_DIR: data, NOMO_DESKTOP_WEB_ROOT: web, VOID_LEDGER_DIR: legacyLedger, VOID_WORKSPACE: 'legacy-ws' }, async origin => {
      assert.deepEqual(await feed(origin), { scope: 'legacy-ws', tools: ['legacy-ws.call'] });
    });
    await withRuntime({
      VOID_DATA_DIR: data,
      NOMO_DESKTOP_WEB_ROOT: web,
      NOMO_LEDGER_DIR: currentLedger,
      VOID_LEDGER_DIR: legacyLedger,
      NOMO_WORKSPACE: 'current-ws',
      VOID_WORKSPACE: 'legacy-ws',
    }, async origin => {
      assert.deepEqual(await feed(origin), { scope: 'current-ws', tools: ['current-ws.call'] });
    });
  } finally {
    await rm(data, { recursive: true, force: true });
    await rm(legacyLedger, { recursive: true, force: true });
    await rm(currentLedger, { recursive: true, force: true });
  }
});

test('desktop runtime does not inherit a legacy control token', { timeout: 20000 }, async () => {
  const data = await mkdtemp(join(tmpdir(), 'nomo-desktop-'));
  const token = 'legacy-desktop-token'.repeat(3);
  try {
    await withRuntime({ VOID_DATA_DIR: data, NOMO_DESKTOP_WEB_ROOT: web, VOID_CONTROL_TOKEN: token }, async (origin, output) => {
      // A desktop instance is loopback-only. A token in the environment, under
      // either name, is a cloud credential this process must not adopt, so the
      // local UI keeps working and no value reaches the output.
      assert.equal((await fetch(`${origin}/api/provider`)).status, 200);
      assert.equal((await fetch(`${origin}/api/provider`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
      assert.equal((await fetch(`${origin}/api/provider`, { headers: { origin: 'https://attacker.invalid' } })).status, 403);
      assert.doesNotMatch(output(), new RegExp(token));
    });
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});
