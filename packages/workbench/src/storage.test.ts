import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createCipheriv } from 'node:crypto';
import { join } from 'node:path';
import { LocalStorage } from './storage.ts';
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

test('storage refuses a stale lock without changing encrypted state', t => {
  const dir = directory(t), store = new LocalStorage(dir), lock = join(dir, 'workspace.enc.lock');
  store.save({ document: 'captured content', evidence: ['signed row'] });
  const ciphertext = readFileSync(join(dir, 'workspace.enc'));
  const owner = deadPid();
  writeFileSync(lock, String(owner));
  assert.throws(() => store.save({ document: 'new content', evidence: ['new row'] }), /stale owner.*stop all NOMO processes.*remove the lock/i);
  assert.equal(readFileSync(lock, 'utf8'), String(owner));
  assert.deepEqual(readFileSync(join(dir, 'workspace.enc')), ciphertext);
  assert.deepEqual(new LocalStorage(dir).read(), { document: 'captured content', evidence: ['signed row'] });
});
test('storage refuses a live or unknown lock owner without changing existing ciphertext', t => {
  const dir = directory(t), store = new LocalStorage(dir), lock = join(dir, 'workspace.enc.lock');
  store.save({ revision: 1 });
  const original = readFileSync(join(dir, 'workspace.enc'));
  for (const owner of [String(process.pid), '', 'not-a-pid', '-1', '2147483648']) {
    writeFileSync(lock, owner);
    assert.throws(() => store.save({ revision: 2 }), /locked|unknown owner/);
    assert.equal(readFileSync(lock, 'utf8'), owner);
    assert.deepEqual(readFileSync(join(dir, 'workspace.enc')), original);
    unlinkSync(lock);
  }
});

test('storage does not remove a lock replaced while its former owner is checked', t => {
  const dir = directory(t), store = new LocalStorage(dir), lock = join(dir, 'workspace.enc.lock');
  const pid = deadPid();
  writeFileSync(lock, String(pid));
  t.mock.method(process, 'kill', () => {
    unlinkSync(lock);
    writeFileSync(lock, String(process.pid));
    throw Object.assign(new Error('Owner exited'), { code: 'ESRCH' });
  });
  assert.throws(() => store.save({ revision: 1 }), /changed during recovery/);
  assert.equal(readFileSync(lock, 'utf8'), String(process.pid));
  assert.equal(existsSync(join(dir, 'workspace.enc')), false);
});

test('storage refuses a stale lock without unlinking it', t => {
  const dir = directory(t), store = new LocalStorage(dir), lock = join(dir, 'workspace.enc.lock');
  store.save({ revision: 1 });
  const ciphertext = readFileSync(join(dir, 'workspace.enc'));
  const owner = deadPid();
  writeFileSync(lock, String(owner));
  assert.throws(() => store.save({ revision: 2 }), /stale owner.*stop all NOMO processes.*remove the lock/i);
  assert.equal(readFileSync(lock, 'utf8'), String(owner));
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
  assert.equal(existsSync(join(dir, 'workspace.enc.lock')), false);
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
  assert.deepEqual(readdirSync(dir).sort(), ['workspace.enc', 'workspace.key']);
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
    assert.deepEqual(readdirSync(dir).sort(), ['workspace.enc', 'workspace.key']);
  } finally { failure.mock.restore(); syncBuiltinESMExports(); }
  store.save({ document: 'after', evidence: ['one', 'two'] });
  assert.deepEqual(new LocalStorage(dir).read(), { document: 'after', evidence: ['one', 'two'] });
});
