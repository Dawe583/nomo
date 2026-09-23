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
import { parseStatement } from './postgres/parse.ts';
import { runProxy, type UpstreamEvents } from '../../proxy/src/bin.ts';
import { interceptCall } from '../../proxy/src/forward/tools.ts';
import { validateLegacyRecoveryEvidence, type LegacyCaptureEvidence, type LegacyProxyBinding, type LegacyOutcomeEvidence } from '../../proxy/src/forward/legacy-binding.ts';
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
  const outcomes: LegacyOutcomeEvidence[] = [];
  let captureEvidence: LegacyCaptureEvidence | null = null;
  const binding: LegacyProxyBinding = {
    tool,
    async capture(call, argsDigest) {
      const captured = await connector.capture({
        tool: call.tool,
        connector: 'postgres',
        workspace: call.workspace,
        arguments: call.args,
      });
      await manifest.write({ tool: call.tool, digest: captured.digest, reference: captured.reference });
      captureEvidence = {
        schema: 'void.legacy.capture.v1',
        at: captured.capturedAt,
        tool: call.tool,
        workspace: call.workspace,
        argsDigest,
        captureDigest: captured.digest,
        reference: captured.reference,
      };
      return captureEvidence;
    },
    async dispatched(evidence) {
      await ledger.append({
        workspace,
        at: new Date().toISOString(),
        tool: evidence.tool,
        schema: evidence.schema,
        decision: 'execute:dispatched',
        argsDigest: evidence.argsDigest,
        captureDigest: evidence.captureDigest,
      });
    },
    async outcome(evidence, response) {
      const status = response === null
        ? 'unknown'
        : 'error' in response
          ? 'failed'
          : isAppliedResult(response.result)
            ? 'completed'
            : 'unknown';
      const outcome: LegacyOutcomeEvidence = {
        schema: 'void.legacy.outcome.v1',
        at: new Date().toISOString(),
        status,
        tool: evidence.tool,
        workspace: evidence.workspace,
        argsDigest: evidence.argsDigest,
        captureDigest: evidence.captureDigest,
      };
      await ledger.append({ ...outcome, workspace, decision: `execute:${status}` });
      outcomes.push(outcome);
      return outcome;
    },
  };
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
    legacyBinding: call => call.tool === tool ? binding : null,
    upstreamSpawn(events) { return postgresUpstream(events, exec); },
  });
  input.push(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: tool, arguments: args } }));
  await outputReceived;
  input.close();
  await running;

  assert.deepEqual(output, [{ jsonrpc: '2.0', id: 7, result: { applied: true } }]);
  assert.equal(outcomes[0]?.status, 'completed');
  assert.deepEqual((await db.query('select * from account order by id')).rows, [{ id: 1, balance: 20 }, { id: 2, balance: 90 }]);
  assert.equal((await verifyLedgerFile(join(ledgerDir, `${workspace}.jsonl`), { publicKey: id => key.publicKey(id) })).ok, true);

  const evidence = captureEvidence as LegacyCaptureEvidence | null;
  assert.ok(evidence !== null);
  const entries = await manifestReader(snapshotDir);
  const entry = entries.find(candidate => candidate.tool === tool && candidate.digest === evidence.captureDigest);
  assert.ok(entry !== undefined);
  const records = await ledgerBodies(join(ledgerDir, `${workspace}.jsonl`));
  const dispatch = records.find(record => record.decision === 'execute:dispatched' && record.captureDigest === evidence.captureDigest);
  const terminal = records.find(record => record.decision === 'execute:completed' && record.captureDigest === evidence.captureDigest);
  assert.ok(dispatch !== undefined && terminal !== undefined);
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
