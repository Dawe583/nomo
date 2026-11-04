import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, linkSync, openSync, closeSync, fsyncSync, unlinkSync, lstatSync, type Stats } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { reservedRecoveryVault } from '../../runtime/src/index.ts';

// One atomic encrypted snapshot commits managed files and their signed history
// together. A failed write cannot expose a changed document without its inverse.
export class LocalStorage {
  private readonly key: Buffer;
  private revision: string | undefined;
  private readonly path: string;
  readonly directory: string;
  recoveryVault() { return reservedRecoveryVault(join(this.directory,'recovery','vault'),{workspace:this.key},'workspace',{maxArtifactBytes:4*1024*1024,maxTotalBytes:1024*1024*1024}); }
  constructor(directory: string, externalKey?: string) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const keyPath = join(directory, 'workspace.key');
    if (externalKey) this.key = Buffer.from(externalKey, "base64");
    else try { this.key = readFileSync(keyPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const candidate = randomBytes(32);
      const temporary = `${keyPath}.${randomBytes(16).toString('hex')}`;
      try {
        writeFileSync(temporary, candidate, { mode: 0o600, flag: 'wx' });
        const keyFd = openSync(temporary, 'r+');
        try { fsyncSync(keyFd); } finally { closeSync(keyFd); }
        try { linkSync(temporary, keyPath); this.key = candidate; }
        catch (linkError) {
          if ((linkError as NodeJS.ErrnoException).code !== 'EEXIST') throw linkError;
          this.key = readFileSync(keyPath);
        }
        if (process.platform !== 'win32') {
          const dirFd = openSync(directory, 'r');
          try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
        }
      } finally {
        try { unlinkSync(temporary); }
        catch (cleanupError) { if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanupError; }
      }
    }
    if (this.key.length !== 32) throw new Error('Invalid workspace encryption key.');
    this.path = join(directory, 'workspace.enc');
  }
  read<T>(): T | undefined {
    let data: Buffer;
    try { data = readFileSync(this.path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    this.revision = createHash('sha256').update(data).digest('hex');
    const cipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12));
    cipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString()) as T;
  }
  save(value: unknown): void {
    withLifecycleLockSync(`${this.path}.lock`, () => this.saveUnlocked(value), true);
  }
  async update<T>(
    mutate: (current: unknown) => Promise<{ value: unknown; result: T }> | { value: unknown; result: T },
    lockPath = `${this.path}.lock`,
    directorySentinel = true,
  ): Promise<T> {
    return withLifecycleLock(lockPath, async () => {
      const current = this.read();
      const updated = await mutate(current);
      this.saveUnlocked(updated.value);
      return updated.result;
    }, directorySentinel);
  }
  private saveUnlocked(value: unknown): void {
    let current: string | undefined;
    try { current = createHash('sha256').update(readFileSync(this.path)).digest('hex'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (current !== this.revision) throw new Error('Workspace changed in another runtime. Restart this app before writing.');
    this.commit(value);
  }
  private commit(value: unknown): void {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    const temporary = `${this.path}.${randomBytes(8).toString('hex')}`;
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      try { writeFileSync(fd, Buffer.concat([iv, cipher.getAuthTag(), bytes])); fsyncSync(fd); }
      finally { closeSync(fd); }
      renameSync(temporary, this.path);
      this.revision = createHash("sha256").update(readFileSync(this.path)).digest("hex");
      // Node cannot flush a Windows directory; file contents were flushed above.
      if (process.platform !== 'win32') {
        const dir = openSync(this.directory, 'r');
        try { fsyncSync(dir); } finally { closeSync(dir); }
      }
    } finally {
      try { unlinkSync(temporary); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
}

export class LifecycleLockBusyError extends Error {
  constructor() { super('Workspace lifecycle is busy in another process.'); }
}

/** Serialize writers with SQLite and optionally keep a directory sentinel for legacy PID locks. */
function openLifecycleDatabase(path: string, directorySentinel: boolean): DatabaseSync {
  let databasePath = path;
  if (directorySentinel) {
    let createdDirectory = false;
    try { mkdirSync(path, { mode: 0o700 }); createdDirectory = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const directory = lstatSync(path);
    if (!directory.isDirectory() || (process.platform !== 'win32' && (directory.mode & 0o077) !== 0))
      throw new Error('Workspace lifecycle lock is legacy or invalid; preserve it and stop all NOMO writers before recovery.');
    if (createdDirectory && process.platform !== 'win32') {
      const parent = openSync(dirname(path), 'r');
      try { fsyncSync(parent); } finally { closeSync(parent); }
    }
    databasePath = join(path, 'lifecycle.sqlite');
    try {
      const fd = openSync(databasePath, 'wx', 0o600);
      closeSync(fd);
      if (process.platform !== 'win32') {
        const directoryFd = openSync(path, 'r');
        try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const file = lstatSync(databasePath);
      if (!file.isFile() || (process.platform !== 'win32' && (file.mode & 0o077) !== 0))
        throw new Error('Workspace lifecycle database is not a private regular file.');
    }
  } else try {
    const fd = openSync(path, 'wx', 0o600);
    closeSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const file = lstatSync(path);
    if (!file.isFile() || (process.platform !== 'win32' && (file.mode & 0o077) !== 0))
      throw new Error('Workspace lifecycle lock is not a private regular file.');
  }
  const database = new DatabaseSync(databasePath);
  try {
    try {
      database.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=FULL;');
      database.exec('CREATE TABLE IF NOT EXISTS lifecycle (id INTEGER PRIMARY KEY CHECK (id = 1));');
      database.exec('BEGIN IMMEDIATE');
    } catch (error) {
      if (error instanceof Error && error.message.toLowerCase().includes('locked'))
        throw new LifecycleLockBusyError();
      if (error instanceof Error && /not a database|encrypted/i.test(error.message))
        throw new Error('Workspace lifecycle lock is legacy or invalid; preserve it and stop all NOMO writers before recovery.');
      throw error;
    }
    return database;
  } catch (error) { database.close(); throw error; }
}

export function withLifecycleLockSync<T>(path: string, action: () => T, directorySentinel = false): T {
  const database = openLifecycleDatabase(path, directorySentinel);
  try { return action(); }
  finally { try { database.exec('ROLLBACK'); } finally { database.close(); } }
}

export async function withLifecycleLock<T>(path: string, action: () => T | Promise<T>, directorySentinel = false): Promise<T> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    let database: DatabaseSync;
    try { database = openLifecycleDatabase(path, directorySentinel); }
    catch (error) {
      if (!(error instanceof LifecycleLockBusyError)) throw error;
      if (Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 25));
      continue;
    }
    try { return await action(); }
    finally { try { database.exec('ROLLBACK'); } finally { database.close(); } }
  }
}
