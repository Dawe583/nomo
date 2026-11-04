import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync, statSync, lstatSync, mkdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createCipheriv } from 'node:crypto';
import { join } from 'node:path';
import { LocalStorage, withLifecycleLock } from './storage.ts';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

function directory(t: { after: (fn: () => void) => void }): string {
  const path = mkdtempSync(join(tmpdir(), 'nomo-storage-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
  assert.equal(child.status, 0);
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  return child.pid;
}

test('workspace lock uses a directory sentinel and a private SQLite file', t => {
  const dir = directory(t), lockDirectory = join(dir, 'workspace.enc.lock');
  const store = new LocalStorage(dir);
  store.save({ revision: 1 });
  assert.equal(lstatSync(lockDirectory).isDirectory(), true);
  assert.equal(lstatSync(join(lockDirectory, 'lifecycle.sqlite')).isFile(), true);
  assert.deepEqual(new LocalStorage(dir).read(), { revision: 1 });
});

test('workspace lock sentinel fails closed on an existing legacy PID file', t => {
  const dir = directory(t), lock = join(dir, 'workspace.enc.lock');
  const legacy = String(deadPid());
  writeFileSync(lock, legacy, { mode: 0o600 });
  assert.throws(() => new LocalStorage(dir).save({ revision: 1 }), /legacy or invalid/i);
  assert.equal(readFileSync(lock, 'utf8'), legacy);
  assert.equal(existsSync(join(dir, 'workspace.enc')), false);
});

test('existing encrypted workspace remains readable and writable', t => {
  const dir = directory(t);
  const key = Buffer.alloc(32, 0x3a), iv = Buffer.alloc(12, 0x72);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ revision: 1 })), cipher.final()]);
  writeFileSync(join(dir, 'workspace.key'), key, { mode: 0o600 });
  writeFileSync(join(dir, 'workspace.enc'), Buffer.concat([iv, cipher.getAuthTag(), ciphertext]), { mode: 0o600 });
  const store = new LocalStorage(dir);
  assert.deepEqual(store.read(), { revision: 1 });
  store.save({ revision: 2 });
  assert.deepEqual(new LocalStorage(dir).read(), { revision: 2 });
});

test('concurrent key publication uses the winning key for encryption', t => {
  const dir = directory(t), keyPath = join(dir, 'workspace.key');
  const competingKey = Buffer.alloc(32, 0x41);
  const realLink = fs.linkSync;
  const race = t.mock.method(fs, 'linkSync', (source: fs.PathLike, target: fs.PathLike) => {
    if (target === keyPath) {
      writeFileSync(keyPath, competingKey, { mode: 0o600, flag: 'wx' });
      throw Object.assign(new Error('competing key published'), { code: 'EEXIST' });
    }
    return realLink(source, target);
  });
  syncBuiltinESMExports();
  let store: LocalStorage;
  try {
    store = new LocalStorage(dir);
  } finally {
    race.mock.restore();
    syncBuiltinESMExports();
  }
  store.save({ revision: 1 });
  assert.deepEqual(new LocalStorage(dir).read(), { revision: 1 });
  assert.deepEqual(readFileSync(keyPath), competingKey);
});

test('unsupported hard links fail without publishing or retaining a key', t => {
  const dir = directory(t);
  const failure = t.mock.method(fs, 'linkSync', () => {
    throw Object.assign(new Error('hard links unsupported'), { code: 'ENOTSUP' });
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => new LocalStorage(dir), /hard links unsupported/);
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    failure.mock.restore();
    syncBuiltinESMExports();
  }
});

test('interrupted key creation never publishes a partial encryption key', t => {
  const dir = directory(t), key = join(dir, 'workspace.key');
  const realWrite = fs.writeFileSync;
  const failure = t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof realWrite>) => {
    const [path, data, options] = args;
    if (typeof path === 'string' && (path === key || path.startsWith(`${key}.`))) {
      realWrite(path, Buffer.from('partial'), options);
      throw new Error('injected key write failure');
    }
    return realWrite(path, data, options);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => new LocalStorage(dir), /injected key write failure/);
    assert.equal(existsSync(key), false);
  } finally {
    failure.mock.restore();
    syncBuiltinESMExports();
  }
  const store = new LocalStorage(dir);
  store.save({ revision: 1 });
  assert.deepEqual(new LocalStorage(dir).read(), { revision: 1 });
});

test('key flush failure does not publish an encryption key', t => {
  const dir = directory(t);
  const failure = t.mock.method(fs, 'fsyncSync', () => { throw new Error('injected key flush failure'); });
  syncBuiltinESMExports();
  try {
    assert.throws(() => new LocalStorage(dir), /injected key flush failure/);
    assert.equal(existsSync(join(dir, 'workspace.key')), false);
  } finally {
    failure.mock.restore();
    syncBuiltinESMExports();
  }
});

test('key directory flush failure is reported without corrupting the published key', { skip: process.platform === 'win32' }, t => {
  const dir = directory(t);
  const realFsync = fs.fsyncSync;
  let calls = 0;
  const failure = t.mock.method(fs, 'fsyncSync', (fd: number) => {
    if (++calls === 2) throw new Error('injected directory flush failure');
    realFsync(fd);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => new LocalStorage(dir), /injected directory flush failure/);
  } finally {
    failure.mock.restore();
    syncBuiltinESMExports();
  }
  const store = new LocalStorage(dir);
  store.save({ revision: 1 });
  assert.deepEqual(new LocalStorage(dir).read(), { revision: 1 });
});

test("auth and workspace directory sentinels use separate lock paths", { timeout: 10_000 }, async t => {
  const dir = directory(t), authLock = join(dir, "accounts.lifecycle.lock");
  const workspace = new LocalStorage(dir);
  const authModule = new URL("./openai-chatgpt-auth.ts", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { withOpenAIChatGPTAuthLock } from ${JSON.stringify(authModule)};
    import { writeFileSync } from "node:fs";
    await withOpenAIChatGPTAuthLock(process.argv[1], async () => {
      writeFileSync(process.argv[2], "entered");
      await new Promise(resolve => setTimeout(resolve, 200));
    });
  `, authLock, join(dir, "child-entered")], { stdio: "ignore" });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  for (let attempt = 0; attempt < 200 && !existsSync(join(dir, "child-entered")); attempt++) {
    if (child.exitCode !== null) assert.fail(`child exited ${child.exitCode}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(existsSync(join(dir, "child-entered")), true);
  workspace.save({ workspaceWrite: true });
  await new Promise<void>((resolve, reject) => child.once("close", code => code === 0 ? resolve() : reject(new Error(`child exited ${code}`))));
  assert.deepEqual(new LocalStorage(dir).read(), { workspaceWrite: true });
  assert.equal(lstatSync(authLock).isDirectory(), true);
  assert.equal(lstatSync(join(dir, "workspace.enc.lock")).isDirectory(), true);
});

test("cold workspace and auth sentinels serialize first-time writers", { timeout: 10_000 }, async t => {
  const dir = directory(t);
  const moduleUrl = new URL("./storage.ts", import.meta.url).href;
  for (const domain of ["workspace", "auth"] as const) {
    const lock = join(dir, `${domain}.lock`);
    const active = join(dir, `${domain}.active`), overlap = join(dir, `${domain}.overlap`);
    const childSource = `
      import { withLifecycleLock } from ${JSON.stringify(moduleUrl)};
      import { writeFileSync, existsSync, unlinkSync } from "node:fs";
      import { setTimeout as delay } from "node:timers/promises";
      const [lock, gate, active, overlap] = process.argv.slice(1);
      writeFileSync(gate, "ready");
      while (!existsSync(gate + ".go")) await delay(5);
      await withLifecycleLock(lock, async () => {
        if (existsSync(active)) writeFileSync(overlap, "overlap");
        writeFileSync(active, "active");
        await delay(100);
        unlinkSync(active);
      }, true);
    `;
    const launch = (n: number) => spawn(process.execPath, ["--input-type=module", "-e", childSource,
      lock, join(dir, `${domain}.ready-${n}`), active, overlap], { stdio: "ignore" });
    const first = launch(1), second = launch(2);
    t.after(() => { if (first.exitCode === null) first.kill(); if (second.exitCode === null) second.kill(); });
    const ready1 = join(dir, `${domain}.ready-1`), ready2 = join(dir, `${domain}.ready-2`);
    for (let attempt = 0; attempt < 300 && (!existsSync(ready1) || !existsSync(ready2)); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(existsSync(ready1) && existsSync(ready2), true);
    writeFileSync(ready1 + ".go", "go");
    writeFileSync(ready2 + ".go", "go");
    const exits = await Promise.all([first, second].map(child => new Promise<number>((resolve, reject) => {
      child.once("error", reject); child.once("close", code => resolve(code ?? -1));
    })));
    assert.deepEqual(exits, [0, 0]);
    assert.equal(existsSync(overlap), false);
    unlinkSync(ready1); unlinkSync(ready2);
  }
});

test('legacy PID writer cannot remove an installed workspace directory sentinel', t => {
  const dir = directory(t), store = new LocalStorage(dir), lock = join(dir, 'workspace.enc.lock');
  store.save({ revision: 1 });
  const marker = join(dir, 'legacy-entered');
  const legacy = `
    import { writeFileSync, readFileSync, lstatSync, unlinkSync } from "node:fs";
    const [path, marker] = process.argv.slice(1);
    try { writeFileSync(path, String(process.pid), { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const stat = lstatSync(path);
      if (!stat.isFile()) process.exit(0);
      const text = readFileSync(path, "utf8");
      const pid = /^[1-9][0-9]{0,9}$/.test(text) ? Number(text) : 0;
      try { process.kill(pid, 0); process.exit(0); }
      catch (ownerError) { if (ownerError.code !== "ESRCH") process.exit(0); }
      if (stat.ino === lstatSync(path).ino && readFileSync(path, "utf8") === text) unlinkSync(path);
    }
    writeFileSync(marker, "entered");
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", legacy, lock, marker], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(marker), false);
  assert.equal(lstatSync(lock).isDirectory(), true);
  store.save({ revision: 2 });
  assert.deepEqual(new LocalStorage(dir).read(), { revision: 2 });
});

test('modeled admitted legacy writer overlaps after a prevalidated stale reaper unlinks its PID path', { timeout: 10_000 }, async t => {
  const dir = directory(t), lock = join(dir, 'workspace.enc.lock');
  const ready = join(dir, 'validated'), releaseUnlink = join(dir, 'release-unlink');
  const gap = join(dir, 'unlink-gap'), allowReacquire = join(dir, 'allow-reacquire');
  const reaperSource = `
    import { writeFileSync, readFileSync, lstatSync, unlinkSync } from "node:fs";
    import { setTimeout as delay } from "node:timers/promises";
    const [path, ready, releaseUnlink, gap, allowReacquire] = process.argv.slice(1);
    const original = lstatSync(path), text = readFileSync(path, "utf8");
    const pid = /^[1-9][0-9]{0,9}$/.test(text) ? Number(text) : 0;
    try { process.kill(pid, 0); process.exit(2); }
    catch (error) { if (error.code !== "ESRCH") process.exit(2); }
    if (original.ino !== lstatSync(path).ino || readFileSync(path, "utf8") !== text) process.exit(3);
    writeFileSync(ready, "validated");
    while (!readFileSync(releaseUnlink, "utf8")) await delay(5);
    unlinkSync(path);
    writeFileSync(gap, "old writer path removed");
    while (!readFileSync(allowReacquire, "utf8")) await delay(5);
    try { writeFileSync(path, String(process.pid), { flag: "wx", mode: 0o600 }); writeFileSync(gap + ".result", "created"); }
    catch (error) { writeFileSync(gap + ".result", error.code ?? "error"); }
  `;
  writeFileSync(lock, String(deadPid()), { mode: 0o600 });
  for (const path of [releaseUnlink, allowReacquire]) writeFileSync(path, '');
  const reaper = spawn(process.execPath, ['--input-type=module', '-e', reaperSource, lock, ready, releaseUnlink, gap, allowReacquire], { stdio: 'ignore' });
  t.after(() => { if (reaper.exitCode === null) reaper.kill(); });
  for (let attempt = 0; attempt < 200 && !existsSync(ready); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(readFileSync(ready, 'utf8'), 'validated');
  unlinkSync(lock);
  const legacyOwner = String(process.pid);
  writeFileSync(lock, legacyOwner, { flag: 'wx', mode: 0o600 });
  const legacyEntered = join(dir, 'legacy-writer-entered');
  writeFileSync(legacyEntered, 'critical section held');
  writeFileSync(releaseUnlink, 'go');
  for (let attempt = 0; attempt < 200 && !existsSync(gap); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(readFileSync(gap, 'utf8'), 'old writer path removed');
  assert.equal(readFileSync(legacyEntered, 'utf8'), 'critical section held');

  let releaseNew!: () => void;
  let signalEntered!: () => void;
  const held = new Promise<void>(resolve => { releaseNew = resolve; });
  const started = new Promise<void>(resolve => { signalEntered = resolve; });
  const currentWriter = withLifecycleLock(lock, async () => { writeFileSync(join(dir, 'new-writer-entered'), 'yes'); signalEntered(); await held; }, true);
  try {
    await started;
    assert.equal(existsSync(join(dir, 'new-writer-entered')), true);
    assert.equal(readFileSync(legacyEntered, 'utf8'), 'critical section held');
    writeFileSync(allowReacquire, 'go');
    await new Promise<void>((resolve, reject) => reaper.once('close', code => code === 0 ? resolve() : reject(new Error(`reaper exited ${code}`))));
    assert.equal(readFileSync(gap + '.result', 'utf8'), 'EEXIST');
    assert.equal(lstatSync(lock).isDirectory(), true);
  } finally {
    releaseNew();
    await currentWriter;
  }
});

test('atomic sentinel wins a legacy stale-reaper reacquire race on an absent path', { timeout: 10_000 }, async t => {
  const dir = directory(t), lock = join(dir, 'workspace.enc.lock');
  const reaperReady = join(dir, 'reaper-ready'), release = join(dir, 'release-reaper');
  const reaperSource = `
    import { writeFileSync, readFileSync, lstatSync, unlinkSync } from "node:fs";
    import { setTimeout as delay } from "node:timers/promises";
    const [path, ready, release] = process.argv.slice(1);
    const original = lstatSync(path), text = readFileSync(path, "utf8");
    const pid = /^[1-9][0-9]{0,9}$/.test(text) ? Number(text) : 0;
    try { process.kill(pid, 0); process.exit(2); }
    catch (error) { if (error.code !== "ESRCH") process.exit(2); }
    if (original.ino !== lstatSync(path).ino || readFileSync(path, "utf8") !== text) process.exit(3);
    unlinkSync(path);
    writeFileSync(ready, "unlinked");
    while (!readFileSync(release, "utf8")) await delay(5);
    try { writeFileSync(path, String(process.pid), { flag: "wx", mode: 0o600 }); writeFileSync(ready + ".result", "created"); }
    catch (error) { writeFileSync(ready + ".result", error.code ?? "error"); }
  `;
  writeFileSync(lock, String(deadPid()), { mode: 0o600 });
  writeFileSync(release, '');
  const reaper = spawn(process.execPath, ['--input-type=module', '-e', reaperSource, lock, reaperReady, release], { stdio: 'ignore' });
  t.after(() => { if (reaper.exitCode === null) reaper.kill(); });
  for (let attempt = 0; attempt < 200 && !existsSync(reaperReady); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(existsSync(reaperReady), true);
  assert.equal(existsSync(lock), false);
  const entered = join(dir, 'writer-entered');
  let releaseWriter!: () => void;
  let signalEntered!: () => void;
  const held = new Promise<void>(resolve => { releaseWriter = resolve; });
  const started = new Promise<void>(resolve => { signalEntered = resolve; });
  const writer = withLifecycleLock(lock, async () => { writeFileSync(entered, 'yes'); signalEntered(); await held; }, true);
  try {
    await started;
    writeFileSync(release, 'go');
    await new Promise<void>((resolve, reject) => reaper.once('close', code => code === 0 ? resolve() : reject(new Error(`reaper exited ${code}`))));
    assert.equal(readFileSync(reaperReady + '.result', 'utf8'), 'EEXIST');
    assert.equal(lstatSync(lock).isDirectory(), true);
    let secondEntered = false;
    const second = withLifecycleLock(lock, async () => { secondEntered = true; }, true);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(secondEntered, false);
    releaseWriter();
    await Promise.all([writer, second]);
    assert.equal(secondEntered, true);
  } finally {
    releaseWriter();
    await writer;
  }
});

test('legacy stale-reaper reacquire winner makes the new sentinel writer fail closed', { timeout: 10_000 }, async t => {
  const dir = directory(t), lock = join(dir, 'workspace.enc.lock');
  const ready = join(dir, 'reaper-ready'), acquire = join(dir, 'acquire'), release = join(dir, 'release-owner');
  const reaperSource = `
    import { writeFileSync, readFileSync, lstatSync, unlinkSync } from "node:fs";
    import { setTimeout as delay } from "node:timers/promises";
    const [path, ready, acquire, release] = process.argv.slice(1);
    const original = lstatSync(path), text = readFileSync(path, "utf8");
    const pid = /^[1-9][0-9]{0,9}$/.test(text) ? Number(text) : 0;
    try { process.kill(pid, 0); process.exit(2); }
    catch (error) { if (error.code !== "ESRCH") process.exit(2); }
    if (original.ino !== lstatSync(path).ino || readFileSync(path, "utf8") !== text) process.exit(3);
    unlinkSync(path);
    writeFileSync(ready, "unlinked");
    while (!readFileSync(acquire, "utf8")) await delay(5);
    try { writeFileSync(path, String(process.pid), { flag: "wx", mode: 0o600 }); }
    catch (error) { process.exit(error.code === "EEXIST" ? 4 : 5); }
    writeFileSync(ready + ".result", "legacy-owner-entered");
    while (!readFileSync(release, "utf8")) await delay(5);
    unlinkSync(path);
  `;
  writeFileSync(lock, String(deadPid()), { mode: 0o600 });
  writeFileSync(acquire, ''); writeFileSync(release, '');
  const reaper = spawn(process.execPath, ['--input-type=module', '-e', reaperSource, lock, ready, acquire, release], { stdio: 'ignore' });
  t.after(() => { if (reaper.exitCode === null) reaper.kill(); });
  for (let attempt = 0; attempt < 200 && !existsSync(ready); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(existsSync(ready), true);
  assert.equal(existsSync(lock), false);
  writeFileSync(acquire, 'go');
  for (let attempt = 0; attempt < 200 && !existsSync(ready + '.result'); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(readFileSync(ready + '.result', 'utf8'), 'legacy-owner-entered');
  await assert.rejects(withLifecycleLock(lock, async () => { throw new Error('must not enter'); }, true), /legacy or invalid/i);
  assert.equal(lstatSync(lock).isFile(), true);
  assert.equal(existsSync(join(dir, 'workspace.enc')), false);
  writeFileSync(release, 'done');
  await new Promise<void>((resolve, reject) => reaper.once('close', code => code === 0 ? resolve() : reject(new Error(`reaper exited ${code}`))));
  assert.equal(existsSync(lock), false);
});

test('workspace sentinel refuses a non-regular inner SQLite pathname without replacing it', t => {
  const dir = directory(t), lock = join(dir, 'workspace.enc.lock');
  const databasePath = join(lock, 'lifecycle.sqlite');
  mkdirSync(lock);
  mkdirSync(databasePath);
  assert.throws(() => new LocalStorage(dir).save({ revision: 1 }), /legacy or invalid/i);
  assert.equal(lstatSync(lock).isDirectory(), true);
  assert.equal(lstatSync(databasePath).isDirectory(), true);
  assert.equal(existsSync(join(dir, 'workspace.enc')), false);
});

test('a paused legacy stale reaper cannot unlink a newly installed sentinel', { timeout: 10_000 }, async t => {
  const dir = directory(t), lock = join(dir, 'workspace.enc.lock');
  const reaperReady = join(dir, 'reaper-ready'), release = join(dir, 'release-reaper');
  const reaperSource = `
    import { writeFileSync, readFileSync, lstatSync, unlinkSync } from "node:fs";
    import { setTimeout as delay } from "node:timers/promises";
    const [path, ready, release] = process.argv.slice(1);
    const original = lstatSync(path);
    const text = readFileSync(path, "utf8");
    const pid = /^[1-9][0-9]{0,9}$/.test(text) ? Number(text) : 0;
    try { process.kill(pid, 0); process.exit(2); }
    catch (error) { if (error.code !== "ESRCH") process.exit(2); }
    if (original.ino !== lstatSync(path).ino || readFileSync(path, "utf8") !== text) process.exit(3);
    writeFileSync(ready, "validated");
    while (!readFileSync(release, "utf8")) await delay(5);
    try { unlinkSync(path); writeFileSync(ready + ".result", "removed"); }
    catch (error) { writeFileSync(ready + ".result", error.code ?? "error"); }
  `;
  writeFileSync(lock, String(deadPid()), { mode: 0o600 });
  writeFileSync(release, '');
  const reaper = spawn(process.execPath, ['--input-type=module', '-e', reaperSource, lock, reaperReady, release], { stdio: 'ignore' });
  t.after(() => { if (reaper.exitCode === null) reaper.kill(); });
  for (let attempt = 0; attempt < 200 && !existsSync(reaperReady); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(existsSync(reaperReady), true);
  unlinkSync(lock);
  const entered = join(dir, 'new-writer-entered');
  let releaseNew!: () => void;
  let signalEntered!: () => void;
  const held = new Promise<void>(resolve => { releaseNew = resolve; });
  const started = new Promise<void>(resolve => { signalEntered = resolve; });
  const newWriter = withLifecycleLock(lock, async () => { writeFileSync(entered, 'yes'); signalEntered(); await held; }, true);
  try {
    await started;
    writeFileSync(release, 'go');
    await new Promise<void>((resolve, reject) => reaper.once('close', code => code === 0 ? resolve() : reject(new Error(`reaper exited ${code}`))));
    assert.ok(['EISDIR', 'EPERM'].includes(readFileSync(reaperReady + '.result', 'utf8')));
    assert.equal(lstatSync(lock).isDirectory(), true);
    let secondEntered = false;
    const second = withLifecycleLock(lock, async () => { secondEntered = true; }, true);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(secondEntered, false);
    releaseNew();
    await Promise.all([newWriter, second]);
    assert.equal(secondEntered, true);
  } finally {
    releaseNew();
    await newWriter;
  }
});

test('workspace lock refuses a legacy PID file without changing encrypted state', t => {
  const dir = directory(t), lock = join(dir, 'workspace.enc.lock');
  writeFileSync(join(dir, 'workspace.enc'), 'existing ciphertext', { mode: 0o600 });
  writeFileSync(lock, String(deadPid()), { mode: 0o600 });
  const ciphertext = readFileSync(join(dir, 'workspace.enc'));
  const owner = readFileSync(lock, 'utf8');
  assert.throws(() => new LocalStorage(dir).save({ document: 'new content', evidence: ['new row'] }), /legacy or invalid.*stop all NOMO writers/i);
  assert.equal(readFileSync(lock, 'utf8'), owner);
  assert.deepEqual(readFileSync(join(dir, 'workspace.enc')), ciphertext);
});

test('storage rejects stale writers and preserves the latest complete snapshot', t => {
  const dir = directory(t), first = new LocalStorage(dir);
  first.save({ document: 'first', evidence: ['one'] });
  const second = new LocalStorage(dir);
  second.read();
  first.save({ document: 'second', evidence: ['one', 'two'] });
  assert.throws(() => second.save({ document: 'stale', evidence: ['one'] }), /changed in another runtime/);
  assert.deepEqual(new LocalStorage(dir).read(), { document: 'second', evidence: ['one', 'two'] });
  assert.equal(lstatSync(join(dir, 'workspace.enc.lock')).isDirectory(), true);
  // POSIX permission bits do not describe Windows ACLs.
  if (process.platform !== 'win32') assert.equal(statSync(join(dir, 'workspace.enc')).mode & 0o077, 0);
});

test('failed serialization leaves the atomic document and evidence snapshot unchanged', t => {
  const dir = directory(t), store = new LocalStorage(dir);
  store.save({ document: 'original', evidence: ['one'] });
  const bytes = readFileSync(join(dir, 'workspace.enc'));
  const circular: Record<string, unknown> = {}; circular.self = circular;
  assert.throws(() => store.save(circular), /circular/);
  assert.deepEqual(readFileSync(join(dir, 'workspace.enc')), bytes);
  assert.deepEqual(readdirSync(dir).sort(), ['workspace.enc', 'workspace.enc.lock', 'workspace.key']);
  assert.deepEqual(store.read(), { document: 'original', evidence: ['one'] });
});

test('failed workspace flush preserves encrypted state and releases the lock for retry', t => {
  const dir = directory(t), store = new LocalStorage(dir);
  store.save({ document: 'before', evidence: ['one'] });
  const bytes = readFileSync(join(dir, 'workspace.enc'));
  const failure = t.mock.method(fs, 'fsyncSync', () => { throw new Error('injected flush failure'); });
  syncBuiltinESMExports();
  try {
    assert.throws(() => store.save({ document: 'after', evidence: ['one', 'two'] }), /injected flush failure/);
    assert.deepEqual(readFileSync(join(dir, 'workspace.enc')), bytes);
    assert.deepEqual(readdirSync(dir).sort(), ['workspace.enc', 'workspace.enc.lock', 'workspace.key']);
  } finally { failure.mock.restore(); syncBuiltinESMExports(); }
  store.save({ document: 'after', evidence: ['one', 'two'] });
  assert.deepEqual(new LocalStorage(dir).read(), { document: 'after', evidence: ['one', 'two'] });
});
