import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { makeConnector } from './registry.ts';
import { LocalSnapshotStore } from './snapshot/local.ts';
import { manifestWriter, manifestReader } from './manifest.ts';
import { applyInverse, type ReplayExecutor } from './postgres/replay.ts';
import { buildInverse } from './postgres/inverse.ts';
import { captureBeforeImage } from './postgres/capture.ts';
import type { S3Client, S3DeleteCall, S3GetObjectResult } from './s3/classify.ts';
import { parseStatement } from './postgres/parse.ts';
import { runProxy, type UpstreamEvents } from '../../proxy/src/bin.ts';
import { interceptCall } from '../../proxy/src/forward/tools.ts';
import { validateLegacyRecoveryEvidence, type LegacyCaptureEvidence, type LegacyOutcomeEvidence } from '../../proxy/src/forward/legacy-binding.ts';
import { legacyBindingRoot, LEGACY_BINDING_NAMES } from '../../proxy/src/legacy-root.ts';
import type { UpstreamProcess } from '../../proxy/src/transport/stdio.ts';
import { jsonlStore } from '../../ledger/src/store.ts';
import { devKeyProvider } from '../../ledger/src/sign.ts';
import { verifyLedgerFile } from '../../ledger/src/verify.ts';

test('40 concurrent independent manifest writers retain every capture', async t => {
  const dir=await mkdtemp(join(tmpdir(),'void-manifest-race-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await Promise.all(Array.from({length:40},(_,i)=>manifestWriter(dir).write({tool:'postgres.row.update',digest:String(i),reference:{namespace:'test',digest:`sha256:${'a'.repeat(64)}`,uri:'file:///test'}})));
  assert.equal((await manifestReader(dir)).length,40);
  await writeFile(join(dir,'manifest.jsonl.lock'),'other-owner');
  await assert.rejects(manifestWriter(dir).write({tool:'test',digest:'blocked',reference:{namespace:'test',digest:`sha256:${'a'.repeat(64)}`,uri:'file:///test'}}),/EEXIST/);
  assert.equal((await manifestReader(dir)).length,40);
});

test('cross-layer fixture: real proxy capture, outcome, restart inverse, signed verification', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'void-reverse-'));
  const db = new PGlite();
  t.after(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
  await db.exec('create table account(id int primary key, balance int);insert into account values(1,10),(2,90)');
  const exec: ReplayExecutor = {
    query: async <T>(sql: string, params?: readonly unknown[]) => (await db.query<T>(sql, params ? [...params] : [])).rows,
    begin: async () => { await db.exec('begin'); },
    commit: async () => { await db.exec('commit'); },
    rollback: async () => { await db.exec('rollback'); },
  };
  const snapshotDir = join(dir, 'snapshots');
  const ledgerDir = join(dir, 'ledger');
  const workspace = 'isolated';
  const tool = 'postgres.row.update';
  const args = {
    sql: 'update public.account set balance = 20 where id = 1',
    schema: { tables: [{ table: 'public.account', primaryKey: ['id'] }] },
  };
  const store = LocalSnapshotStore(snapshotDir);
  const key = await devKeyProvider({ dir: join(dir, 'keys'), env: {} });
  const ledger = jsonlStore(key, { dir: ledgerDir });
  const connector = makeConnector({ store, exec }).postgres;
  const manifest = manifestWriter(snapshotDir);
  // The fixture obtains its binding from the production composition root, the
  // same single exported point a host uses. Hand-rolling a LegacyProxyBinding
  // here would let this test pass against a binding the product never builds.
  // Every assertion below reads the root's own durable output rather than a
  // value captured alongside it, so the root is what is under test.
  const resolver = legacyBindingRoot(tool, {
    async capture(bound) {
      const captured = await connector.capture({
        tool: bound.tool,
        connector: 'postgres',
        workspace: bound.workspace,
        arguments: bound.arguments,
      });
      return {
        digest: captured.digest,
        reference: captured.reference,
        capturedAt: captured.capturedAt,
      };
    },
    manifest: { write: (entry) => manifest.write(entry) },
    ledger: { append: (body) => ledger.append({ ...body, workspace }) },
    workspace,
    completed: isAppliedResult,
  });
  assert.notEqual(
    resolver({ tool, connector: 'postgres', args, workspace }),
    null,
    'the production root must bind postgres.row.update',
  );
  const policyPath = join(dir, 'policy.yml');
  await writeFile(policyPath, 'version: 1\nrules:\n  - match: {}\n    decision: allow\n');
  const output: unknown[] = [];
  const input = testLineQueue();
  let resolveOutput: () => void = () => {};
  const outputReceived = new Promise<void>(resolve => { resolveOutput = resolve; });
  const running = runProxy({
    upstreamCommand: ['fake'],
    policyPath,
    posture: 'fail-closed',
    ledgerDir,
    keyProvider: key,
    workspace,
    input,
    output: line => { output.push(JSON.parse(line) as unknown); resolveOutput(); },
    error: () => {},
    legacyBinding: resolver,
    upstreamSpawn(events) { return postgresUpstream(events, exec); },
  });
  input.push(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: tool, arguments: args } }));
  await outputReceived;
  input.close();
  await running;

  assert.deepEqual(output, [{ jsonrpc: '2.0', id: 7, result: { applied: true } }]);
  assert.deepEqual((await db.query('select * from account order by id')).rows, [{ id: 1, balance: 20 }, { id: 2, balance: 90 }]);
  assert.equal((await verifyLedgerFile(join(ledgerDir, `${workspace}.jsonl`), { publicKey: id => key.publicKey(id) })).ok, true);

  // The capture the root committed is found through the manifest and the
  // signed ledger, not through a value the fixture kept alongside the run.
  // A root that recorded nothing, or recorded a digest the manifest does not
  // carry, leaves this lookup empty and the test red.
  const entries = await manifestReader(snapshotDir);
  const entry = entries.find(candidate => candidate.tool === tool);
  assert.ok(entry !== undefined, 'the root must leave a manifest entry for the bound tool');
  const records = await ledgerBodies(join(ledgerDir, `${workspace}.jsonl`));
  const dispatch = records.find(record => record.decision === 'execute:dispatched' && record.captureDigest === entry.reference.digest);
  const terminal = records.find(record => record.decision === 'execute:completed' && record.captureDigest === entry.reference.digest);
  assert.ok(dispatch !== undefined && terminal !== undefined);
  assert.equal(terminal.status, 'completed');
  const durableCapture = {
    schema: dispatch.schema,
    at: dispatch.at,
    tool: dispatch.tool,
    workspace: dispatch.workspace,
    argsDigest: dispatch.argsDigest,
    captureDigest: dispatch.captureDigest,
    reference: entry.reference,
  } as LegacyCaptureEvidence;
  const durableOutcome = {
    schema: terminal.schema,
    at: terminal.at,
    status: terminal.status,
    tool: terminal.tool,
    workspace: terminal.workspace,
    argsDigest: terminal.argsDigest,
    captureDigest: terminal.captureDigest,
  } as LegacyOutcomeEvidence;
  validateLegacyRecoveryEvidence(durableCapture, durableOutcome);
  assert.throws(
    () => validateLegacyRecoveryEvidence(durableCapture, { ...durableOutcome, status: 'unknown' }),
    /completed/,
  );
  assert.throws(
    () => validateLegacyRecoveryEvidence(durableCapture, { ...durableOutcome, captureDigest: `sha256:${'0'.repeat(64)}` }),
    /capture digest/,
  );

  const fresh = makeConnector({ store, exec }).postgres;
  const plan = await fresh.inverse(entry.reference);
  const report = await fresh.apply(plan);
  assert.deepEqual(report.refused, []);
  assert.deepEqual((await db.query('select * from account order by id')).rows, [{ id: 1, balance: 10 }, { id: 2, balance: 90 }]);

  await db.exec('update account set balance=30 where id=1');
  const drift = await fresh.apply(await fresh.inverse(entry.reference));
  assert.equal(drift.refused[0]?.reason, 'drift');
  assert.deepEqual((await db.query('select * from account where id=1')).rows, [{ id: 1, balance: 30 }]);
});

// The delete half of the postgres surface shares the connector with the update
// above but inverts by re-inserting the captured rows, so it earns its own
// fixture rather than being assumed to follow from the update path.
test('cross-layer fixture: composed root captures a cascading postgres delete, and a restarted connector reinserts the rows', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'void-reverse-delete-'));
  const db = new PGlite();
  t.after(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
  await db.exec('create table account(id int primary key, balance int);create table entry(id int primary key, account_id int references account(id) on delete cascade, memo text);insert into account values(1,10),(2,90);insert into entry values(5,1,\'first\'),(6,1,\'second\')');
  const exec: ReplayExecutor = {
    query: async <T>(sql: string, params?: readonly unknown[]) => (await db.query<T>(sql, params ? [...params] : [])).rows,
    begin: async () => { await db.exec('begin'); },
    commit: async () => { await db.exec('commit'); },
    rollback: async () => { await db.exec('rollback'); },
  };
  const snapshotDir = join(dir, 'snapshots');
  const ledgerDir = join(dir, 'ledger');
  const workspace = 'isolated';
  const tool = 'postgres.row.delete';
  const args = {
    sql: 'delete from public.account where id = 1',
    schema: {
      tables: [
        { table: 'public.account', primaryKey: ['id'] },
        { table: 'public.entry', primaryKey: ['id'] },
      ],
    },
  };
  const store = LocalSnapshotStore(snapshotDir);
  const key = await devKeyProvider({ dir: join(dir, 'keys'), env: {} });
  const ledger = jsonlStore(key, { dir: ledgerDir });
  const manifest = manifestWriter(snapshotDir);
  const connector = makeConnector({ store, exec }).postgres;
  const resolver = legacyBindingRoot(tool, {
    async capture(bound) {
      const captured = await connector.capture({
        tool: bound.tool,
        connector: 'postgres',
        workspace: bound.workspace,
        arguments: bound.arguments,
      });
      return {
        digest: captured.digest,
        reference: captured.reference,
        capturedAt: captured.capturedAt,
      };
    },
    manifest: { write: (entry) => manifest.write(entry) },
    ledger: { append: (body) => ledger.append({ ...body, workspace }) },
    workspace,
    completed: isAppliedResult,
  });
  const policyPath = join(dir, 'policy.yml');
  await writeFile(policyPath, 'version: 1\nrules:\n  - match: {}\n    decision: allow\n');
  const output: unknown[] = [];
  const input = testLineQueue();
  let resolveOutput: () => void = () => {};
  const outputReceived = new Promise<void>(resolve => { resolveOutput = resolve; });
  const running = runProxy({
    upstreamCommand: ['fake'],
    policyPath,
    posture: 'fail-closed',
    ledgerDir,
    keyProvider: key,
    workspace,
    input,
    output: line => { output.push(JSON.parse(line) as unknown); resolveOutput(); },
    error: () => {},
    legacyBinding: resolver,
    upstreamSpawn(events) { return postgresUpstream(events, exec); },
  });
  input.push(JSON.stringify({ jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: tool, arguments: args } }));
  await outputReceived;
  input.close();
  await running;

  assert.deepEqual(output, [{ jsonrpc: '2.0', id: 13, result: { applied: true } }]);
  // The cascade really emptied the child table, so the reinsert below is a
  // restore of captured rows rather than a write over intact data.
  assert.deepEqual((await db.query('select * from account order by id')).rows, [{ id: 2, balance: 90 }]);
  assert.deepEqual((await db.query('select * from entry order by id')).rows, []);

  const entry = (await manifestReader(snapshotDir)).find(candidate => candidate.tool === tool);
  assert.ok(entry !== undefined, 'the root must leave a manifest entry for the bound delete tool');
  const records = await ledgerBodies(join(ledgerDir, `${workspace}.jsonl`));
  const dispatch = records.find(record => record.decision === 'execute:dispatched' && record.captureDigest === entry.reference.digest);
  const terminal = records.find(record => record.decision === 'execute:completed' && record.captureDigest === entry.reference.digest);
  assert.ok(dispatch !== undefined && terminal !== undefined);
  validateLegacyRecoveryEvidence(
    {
      schema: dispatch.schema,
      at: dispatch.at,
      tool: dispatch.tool,
      workspace: dispatch.workspace,
      argsDigest: dispatch.argsDigest,
      captureDigest: dispatch.captureDigest,
      reference: entry.reference,
    } as LegacyCaptureEvidence,
    {
      schema: terminal.schema,
      at: terminal.at,
      status: terminal.status,
      tool: terminal.tool,
      workspace: terminal.workspace,
      argsDigest: terminal.argsDigest,
      captureDigest: terminal.captureDigest,
    } as LegacyOutcomeEvidence,
  );

  const fresh = makeConnector({ store, exec }).postgres;
  const report = await fresh.apply(await fresh.inverse(entry.reference));
  assert.deepEqual(report.refused, []);
  // Child rows come back before the parent they reference, or the reinsert
  // would fail the foreign key rather than restore the state.
  assert.deepEqual((await db.query('select * from account order by id')).rows, [{ id: 1, balance: 10 }, { id: 2, balance: 90 }]);
  assert.deepEqual((await db.query('select * from entry order by id')).rows, [
    { id: 5, account_id: 1, memo: 'first' },
    { id: 6, account_id: 1, memo: 'second' },
  ]);
});


// The S3 surface is bindable for the same reason the postgres surface is: the
// connector captures the object body and its ETag before the delete, and the
// inverse writes those bytes back. It runs through the same production root,
// so a second mechanism cannot grow beside the first one.
test('cross-layer fixture: composed root captures an S3 delete, and a restarted connector restores the bytes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'void-reverse-s3-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const client = new MemoryS3Client();
  const body = new TextEncoder().encode('account statement bytes');
  await client.putObject({ bucket: 'statements', key: '2026/09.txt', body });

  const snapshotDir = join(dir, 'snapshots');
  const ledgerDir = join(dir, 'ledger');
  const workspace = 'isolated';
  const tool = 'aws.s3.object.delete';
  const args = { bucket: 'statements', key: '2026/09.txt' };
  const store = LocalSnapshotStore(snapshotDir);
  const key = await devKeyProvider({ dir: join(dir, 'keys'), env: {} });
  const ledger = jsonlStore(key, { dir: ledgerDir });
  const manifest = manifestWriter(snapshotDir);
  const connector = makeConnector({ store, s3: client }).s3;
  const resolver = legacyBindingRoot(tool, {
    async capture(bound) {
      const captured = await connector.capture({
        tool: bound.tool,
        connector: 's3',
        workspace: bound.workspace,
        arguments: bound.arguments,
      });
      return {
        digest: captured.digest,
        reference: captured.reference,
        capturedAt: captured.capturedAt,
      };
    },
    manifest: { write: (entry) => manifest.write(entry) },
    ledger: { append: (body) => ledger.append({ ...body, workspace }) },
    workspace,
    completed: isAppliedResult,
  });
  const policyPath = join(dir, 'policy.yml');
  await writeFile(policyPath, 'version: 1\nrules:\n  - match: {}\n    decision: allow\n');
  const output: unknown[] = [];
  const input = testLineQueue();
  let resolveOutput: () => void = () => {};
  const outputReceived = new Promise<void>(resolve => { resolveOutput = resolve; });
  const running = runProxy({
    upstreamCommand: ['fake'],
    policyPath,
    posture: 'fail-closed',
    ledgerDir,
    keyProvider: key,
    workspace,
    input,
    output: line => { output.push(JSON.parse(line) as unknown); resolveOutput(); },
    error: () => {},
    legacyBinding: resolver,
    upstreamSpawn(events) { return s3Upstream(events, client); },
  });
  input.push(JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: tool, arguments: args } }));
  await outputReceived;
  input.close();
  await running;

  assert.deepEqual(output, [{ jsonrpc: '2.0', id: 11, result: { applied: true } }]);
  // The delete really happened upstream, so the restore below is a restore
  // and not a no-op write.
  assert.equal(client.objects.has('statements/2026/09.txt'), false);
  assert.equal((await verifyLedgerFile(join(ledgerDir, `${workspace}.jsonl`), { publicKey: id => key.publicKey(id) })).ok, true);

  const entry = (await manifestReader(snapshotDir)).find(candidate => candidate.tool === tool);
  assert.ok(entry !== undefined, 'the root must leave a manifest entry for the bound s3 tool');
  const records = await ledgerBodies(join(ledgerDir, `${workspace}.jsonl`));
  const dispatch = records.find(record => record.decision === 'execute:dispatched' && record.captureDigest === entry.reference.digest);
  const terminal = records.find(record => record.decision === 'execute:completed' && record.captureDigest === entry.reference.digest);
  assert.ok(dispatch !== undefined && terminal !== undefined);
  validateLegacyRecoveryEvidence(
    {
      schema: dispatch.schema,
      at: dispatch.at,
      tool: dispatch.tool,
      workspace: dispatch.workspace,
      argsDigest: dispatch.argsDigest,
      captureDigest: dispatch.captureDigest,
      reference: entry.reference,
    } as LegacyCaptureEvidence,
    {
      schema: terminal.schema,
      at: terminal.at,
      status: terminal.status,
      tool: terminal.tool,
      workspace: terminal.workspace,
      argsDigest: terminal.argsDigest,
      captureDigest: terminal.captureDigest,
    } as LegacyOutcomeEvidence,
  );

  const fresh = makeConnector({ store, s3: client }).s3;
  const report = await fresh.apply(await fresh.inverse(entry.reference));
  assert.deepEqual(report.refused, []);
  const restored = await client.getObject({ bucket: 'statements', key: '2026/09.txt' });
  assert.deepEqual([...(restored.body ?? new Uint8Array())], [...body]);
});

test('every advertised tool has a real conformance fixture, and nothing else does', () => {
  // A name may only join LEGACY_BINDING_NAMES together with a cross-layer
  // fixture. The supported set must never advertise a recovery nobody ran.
  const fixtureTools: Record<string, true> = {
    'postgres.row.update': true,
    'postgres.row.delete': true,
    'aws.s3.object.delete': true,
  };
  assert.deepEqual(
    [...LEGACY_BINDING_NAMES].filter(name => fixtureTools[name] !== true),
    [],
    'every bindable tool needs a cross-layer fixture',
  );
});

test('real PostgreSQL constraint failure rolls back all inverse steps; missing transaction refuses before queries',async t=>{
  const db=new PGlite();t.after(()=>db.close());await db.exec('create table sample(id int primary key, value int);insert into sample values(1,10),(2,20)');
  const exec:ReplayExecutor={query:async<T>(sql:string,params?:readonly unknown[])=>(await db.query<T>(sql,params?[...params]:[])).rows,begin:async()=>{await db.exec('begin')},commit:async()=>{await db.exec('commit')},rollback:async()=>{await db.exec('rollback')}};
  const image=await captureBeforeImage(exec,parseStatement('delete from public.sample'),{tables:[{table:'public.sample',primaryKey:['id']}]});await db.exec('delete from sample;alter table sample add constraint forbid_second check(id<>2)');
  const report=await applyInverse(exec,buildInverse(image.statement,image),image);assert.equal(report.refused[0]?.reason,'internal_error');assert.deepEqual((await db.query('select * from sample')).rows,[]);
  let queries=0;const unsafe=await applyInverse({query:async()=>{queries++;return[]}},buildInverse(image.statement,image),image);assert.equal(queries,0);assert.equal(unsafe.refused[0]?.stepId,'transaction');
});

test('ledger failure prevents an allowed proxy call from being forwarded',async()=>{
  const verdict=await interceptCall({tool:'postgres.row.delete',connector:'postgres',args:{}},{classify:()=>({outcome:'classified',tone:'r1'} as never),policy:()=>({kind:'allow'} as never),hold:async()=>{throw new Error('unexpected')},ledger:async()=>{throw new Error('disk unavailable')}});
  assert.equal(verdict.kind,'deny');
});

test('two concurrent Undo attempts sharing a PostgreSQL connection perform one restore',async t=>{
  const db=new PGlite();t.after(()=>db.close());await db.exec('create table item(id int primary key,value int);insert into item values(1,10)');
  const exec:ReplayExecutor={query:async<T>(sql:string,params?:readonly unknown[])=>(await db.query<T>(sql,params?[...params]:[])).rows,begin:async()=>{await db.exec('begin')},commit:async()=>{await db.exec('commit')},rollback:async()=>{await db.exec('rollback')}};
  const image=await captureBeforeImage(exec,parseStatement('update public.item set value = 20 where id = 1'),{tables:[{table:'public.item',primaryKey:['id']}]});await db.exec('update item set value=20 where id=1');
  const results=await Promise.all([applyInverse(exec,buildInverse(image.statement,image),image),applyInverse(exec,buildInverse(image.statement,image),image)]);
  assert.equal(results.filter(r=>r.applied.length===1).length,1);assert.equal(results.filter(r=>r.refused[0]?.reason==='drift').length,1);assert.deepEqual((await db.query('select * from item')).rows,[{id:1,value:10}]);
});

test('oversized capture refuses without evicting the existing inverse',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'void-capture-budget-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const store=LocalSnapshotStore(dir,{maxBytes:4}),prior=await store.put('isolated',new Uint8Array([1,2,3]));
  await assert.rejects(store.put('isolated',new Uint8Array(5)),/exceeds/);assert.deepEqual([...await store.get(prior.reference)],[1,2,3]);
});

function isAppliedResult(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && (value as { applied?: unknown }).applied === true;
}

type TestLineQueue = AsyncIterable<string> & { push(line: string): void; close(): void };

function testLineQueue(): TestLineQueue {
  const values: string[] = [];
  const waiters: Array<(result: IteratorResult<string>) => void> = [];
  let closed = false;
  return {
    push(line) {
      const waiter = waiters.shift();
      if (waiter === undefined) values.push(line);
      else waiter({ done: false, value: line });
    },
    close() {
      closed = true;
      for (const waiter of waiters.splice(0)) waiter({ done: true, value: undefined });
    },
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          const value = values.shift();
          if (value !== undefined) return { done: false, value };
          if (closed) return { done: true, value: undefined };
          return new Promise<IteratorResult<string>>(resolve => { waiters.push(resolve); });
        },
      };
    },
  };
}

function postgresUpstream(events: UpstreamEvents, exec: ReplayExecutor): UpstreamProcess {
  return {
    send(line) {
      const request = JSON.parse(line) as { id: number; params?: { arguments?: { sql?: unknown } } };
      const sql = request.params?.arguments?.sql;
      void (async () => {
        if (typeof sql !== 'string') throw new Error('missing SQL');
        await exec.query(sql);
        events.onMessage(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { applied: true } }));
      })().catch(error => {
        events.onMessage(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } }));
      });
    },
    close() {},
    onStderr() { return () => {}; },
  };
}

async function ledgerBodies(path: string): Promise<Array<Record<string, unknown>>> {
  const text = await import('node:fs/promises').then(module => module.readFile(path, 'utf8'));
  return text.split('\n').filter(Boolean).map(line => (JSON.parse(line) as { body: Record<string, unknown> }).body);
}

/**
 * In-memory S3 for the conformance fixture. It is a model of the four calls
 * the connector makes, not an AWS emulator: no network, no bucket policy, no
 * versioning history. Conditional put headers are recorded rather than
 * enforced, so this fixture proves the root's evidence path and the
 * connector's bytes round trip, and nothing about real S3 semantics.
 */
class MemoryS3Client implements S3Client {
  readonly objects = new Map<string, { readonly body: Uint8Array; readonly etag: string }>();

  async getObject(input: S3DeleteCall): Promise<S3GetObjectResult> {
    const stored = this.objects.get(`${input.bucket}/${input.key}`);
    if (stored === undefined) {
      const error = new Error('missing key') as Error & { code: string; statusCode: number };
      error.code = 'NoSuchKey';
      error.statusCode = 404;
      throw error;
    }
    return { body: new Uint8Array(stored.body), etag: stored.etag };
  }

  async putObject(input: { readonly bucket: string; readonly key: string; readonly body: Uint8Array }): Promise<{ readonly etag: string }> {
    const etag = `"${Buffer.from(input.body).toString('hex')}"`;
    this.objects.set(`${input.bucket}/${input.key}`, { body: new Uint8Array(input.body), etag });
    return { etag };
  }

  async deleteObject(input: S3DeleteCall): Promise<{ readonly deleteMarker: boolean }> {
    this.objects.delete(`${input.bucket}/${input.key}`);
    return { deleteMarker: true };
  }

  async getBucketVersioning(): Promise<{ readonly status: 'Enabled' }> {
    return { status: 'Enabled' };
  }
}

function s3Upstream(events: UpstreamEvents, client: S3Client): UpstreamProcess {
  return {
    send(line) {
      const request = JSON.parse(line) as { id: number; params?: { arguments?: { bucket?: unknown; key?: unknown } } };
      const args = request.params?.arguments;
      void (async () => {
        if (typeof args?.bucket !== 'string' || typeof args.key !== 'string') {
          throw new Error('missing bucket or key');
        }
        await client.deleteObject({ bucket: args.bucket, key: args.key });
        events.onMessage(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { applied: true } }));
      })().catch(error => {
        events.onMessage(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } }));
      });
    },
    close() {},
    onStderr() { return () => {}; },
  };
}
