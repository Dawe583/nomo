import test from "node:test";
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { devKeyProvider } from "../../ledger/src/sign.ts";
import {
  recoveryRuntime,
  localOperationJournal,
  reservedRecoveryVault,
  type RecoveryAdapter,
  type RecoveryPlan,
} from "./index.ts";

const CHILD_MESSAGE_TIMEOUT_MS = process.platform === "win32" ? 90_000 : 15_000;
const TEST_TIMEOUT_MS = process.platform === "win32" ? 180_000 : 25_000;

// The chain worker announces over IPC that its inverse committed and then parks
// so the parent can SIGKILL it there. `before` is the value it restored, which
// the parent asserts to prove the kill landed at the step it selected.
type InverseCommittedMessage = { stage: string; before: string };

for (const durableReceipt of [false, true]) {
  test(
    `SIGKILL after inverse commit ${durableReceipt ? "with" : "without"} an atomic receipt never repeats recovery`,
    { timeout: TEST_TIMEOUT_MS },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), "nomo-killed-recovery-"));
      const key = randomBytes(32);
      let child: ChildProcess | undefined;
      let closeDatabase = () => {};
      t.after(async () => {
        if (child && child.exitCode === null && child.signalCode === null) {
          const exit = once(child, "exit");
          child.kill("SIGKILL");
          await exit;
        }
        closeDatabase();
        await rm(root, { recursive: true, force: true });
      });
      const worker = join(root, "worker.mjs");
      // The fixture commits its value and optional receipt in one SQLite transaction.
      // This certifies runtime restart behavior, not an external provider adapter.
      await writeFile(
        worker,
        `
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { devKeyProvider } from ${JSON.stringify(new URL("../../ledger/src/sign.ts", import.meta.url).href)};
import { recoveryRuntime, localOperationJournal, reservedRecoveryVault } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
const root = process.env.TEST_ROOT;
const db = new DatabaseSync(join(root, 'effect.sqlite'));
db.exec("CREATE TABLE effect(value TEXT, writes INTEGER, inverses INTEGER); INSERT INTO effect VALUES ('before',0,0); CREATE TABLE receipts(id TEXT PRIMARY KEY, value TEXT)");
let plan;
const adapter = {
  id: 'atomic-fixture', version: '1',
  async preflight() { return { effect: 'write', reversibility: 'r1', readiness: 'verified', scope: 'one fixture value', resources: ['value'], revision: 'before', blastRadius: { count: 1, precision: 'exact' } }; },
  async prepare() { return { before: 'before', plan: null }; },
  async execute() { db.exec("UPDATE effect SET value='after', writes=writes+1"); return { result: 'after', evidence: { value: 'after' } }; },
  async release() {},
  async reconcile() { return { status: 'unknown' }; },
  async recover(prepared, outcome, id) {
    db.exec('BEGIN IMMEDIATE');
    const changed = db.prepare('UPDATE effect SET value=?, inverses=inverses+1 WHERE value=?').run(prepared.before, outcome.result);
    if (changed.changes !== 1) throw new Error('Fixture drift');
    if (${durableReceipt}) db.prepare('INSERT INTO receipts VALUES (?,?)').run(id, prepared.before);
    db.exec('COMMIT');
    process.send({ stage: 'inverse-committed', plan, recoveryId: id });
    // A pending promise alone does not keep Node alive after IPC flushes.
    await new Promise(() => setInterval(() => {}, 1000));
  }
};
const signer = await devKeyProvider({ dir: join(root, 'keys'), env: {} });
const runtime = recoveryRuntime({ journal: localOperationJournal(join(root, 'journal'), signer), vault: reservedRecoveryVault(join(root, 'vault'), { test: Buffer.from(process.env.TEST_KEY, 'base64') }, 'test'), adapters: [adapter], authorize: async () => true });
await runtime.execute({ workspace: 'test', agentId: 'agent', runId: 'run', operationId: 'operation', adapterId: adapter.id, arguments: null });
plan = await runtime.planRecovery('test', 'operation');
await runtime.recover(plan, async () => true);
`,
      );
      child = fork(worker, [], {
        env: {
          ...process.env,
          TEST_ROOT: root,
          TEST_KEY: key.toString("base64"),
        },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      const [message] = (await once(child, "message", {
        signal: AbortSignal.timeout(CHILD_MESSAGE_TIMEOUT_MS),
      })) as [{ stage: string; plan: RecoveryPlan; recoveryId: string }];
      assert.equal(message.stage, "inverse-committed");
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      const [, signal] = await exited;
      assert.equal(signal, "SIGKILL");

      const db = new DatabaseSync(join(root, "effect.sqlite"));
      closeDatabase = () => db.close();
      let repeated = 0;
      const forbidden = async (): Promise<never> => {
        repeated++;
        throw new Error("Restart must not dispatch another write or inverse");
      };
      const adapter: RecoveryAdapter = {
        id: "atomic-fixture",
        version: "1",
        preflight: forbidden,
        prepare: forbidden,
        execute: forbidden,
        recover: forbidden,
        async release() {},
        async reconcile() {
          return { status: "unknown" };
        },
        async reconcileRecovery(_prepared, _outcome, recoveryId) {
          assert.equal(recoveryId, message.recoveryId);
          const receipt = db
            .prepare("SELECT value FROM receipts WHERE id=?")
            .get(recoveryId);
          return receipt
            ? { status: "restored", evidence: { value: String(receipt.value) } }
            : { status: "unknown" };
        },
      };
      const signer = await devKeyProvider({ dir: join(root, "keys"), env: {} });
      const journal = localOperationJournal(join(root, "journal"), signer);
      const runtime = recoveryRuntime({
        journal,
        vault: reservedRecoveryVault(
          join(root, "vault"),
          { test: key },
          "test",
        ),
        adapters: [adapter],
        authorize: async () => true,
      });
      assert.equal(
        await runtime.status("test", "operation"),
        "recovery-dispatched",
      );
      assert.deepEqual(await runtime.recover(message.plan, async () => true), {
        status: "unknown",
      });
      const expected = durableReceipt ? "restored" : "unknown";
      assert.equal(
        (await runtime.reconcileRecovery("test", "operation")).status,
        expected,
      );
      assert.equal(
        (await runtime.recover(message.plan, async () => true)).status,
        expected,
      );
      assert.equal(
        (await runtime.reconcileRecovery("test", "operation")).status,
        expected,
      );
      assert.equal(repeated, 0);
      assert.deepEqual(
        { ...db.prepare("SELECT * FROM effect").get() },
        { value: "before", writes: 1, inverses: 1 },
      );
      await journal.transaction("test", async (tx) => {
        assert.equal(
          tx.events.filter((e) => e.stage === "recovery-dispatched").length,
          1,
        );
        assert.equal(
          tx.events.filter((e) => e.stage === "restored").length,
          durableReceipt ? 1 : 0,
        );
      });
    },
  );
}

// The test above kills a process during one inverse. This kills it between two
// inverses of the same job, which is the window the lineage mechanism exists
// for: the first step committed but was never checkpointed, so the restart has
// to establish that step's outcome from durable evidence before it may use the
// lineage the second step depends on.
test(
  "SIGKILL between two steps of one recovery job resumes without repeating either inverse",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "nomo-killed-chain-"));
    const key = randomBytes(32);
    let child: ChildProcess | undefined;
    let closeDatabase = () => {};
    t.after(async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exit = once(child, "exit");
        child.kill("SIGKILL");
        await exit;
      }
      closeDatabase();
      await rm(root, { recursive: true, force: true });
    });
    const worker = join(root, "worker.mjs");
    // Each row carries its own inverse counter, so a repeated inverse is
    // visible in the data rather than inferred from a log.
    await writeFile(
      worker,
      `
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { devKeyProvider } from ${JSON.stringify(new URL("../../ledger/src/sign.ts", import.meta.url).href)};
import { recoveryRuntime, localOperationJournal, reservedRecoveryVault } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
const root = process.env.TEST_ROOT;
const db = new DatabaseSync(join(root, 'effect.sqlite'));
db.exec("CREATE TABLE effect(id INTEGER PRIMARY KEY, before TEXT, after TEXT, value TEXT, inverses INTEGER); INSERT INTO effect VALUES (1,'one-before','one-after','one-before',0),(2,'two-before','two-after','two-before',0); CREATE TABLE receipts(id TEXT PRIMARY KEY, value TEXT)");
const rows = db.prepare('SELECT * FROM effect WHERE id=?');
const adapter = {
  id: 'chain-fixture', version: '1',
  async preflight(args) { const id = args.id; return { effect: 'write', reversibility: 'r1', readiness: 'verified', scope: 'one fixture row', resources: ['row:' + id], revision: rows.get(id).value, blastRadius: { count: 1, precision: 'exact' } }; },
  async prepare(args) { return { before: rows.get(args.id).before, plan: null }; },
  async execute(args) { db.prepare('UPDATE effect SET value=after WHERE id=?').run(args.id); return { result: args.id, evidence: { id: args.id, after: rows.get(args.id).after } }; },
  async release() {},
  async reconcile() { return { status: 'unknown' }; },
  async recoverWithContinuation(prepared, outcome, id, previous) {
    const receipt = db.prepare('SELECT value FROM receipts WHERE id=?').get(id);
    return receipt ? { status: 'restored', evidence: { value: String(receipt.value) } } : { status: 'conflict', evidence: null };
  },
  async recover(prepared, outcome, id) {
    db.exec('BEGIN IMMEDIATE');
    const changed = db.prepare('UPDATE effect SET value=?, inverses=inverses+1 WHERE value=?').run(prepared.before, outcome.evidence.after);
    if (changed.changes !== 1) throw new Error('Fixture drift');
    db.prepare('INSERT INTO receipts VALUES (?,?)').run(id, prepared.before);
    db.exec('COMMIT');
    // Killed here, after this step's inverse committed with a durable
    // receipt but before the job checkpoint for it was written, so the
    // restart has to establish that outcome from evidence before it may use
    // the lineage the next step depends on. The step is chosen by the parent
    // so every crash point of the chain is covered, not just the first one.
    const killBefore = process.env.TEST_KILL_BEFORE ?? 'two-before';
    if (prepared.before === killBefore) {
      process.send({ stage: 'inverse-committed', before: prepared.before });
      await new Promise(() => setInterval(() => {}, 1000));
    }
    return { status: 'restored', evidence: { value: prepared.before } };
  },
  async reconcileRecovery(prepared, outcome, id) {
    const receipt = db.prepare('SELECT value FROM receipts WHERE id=?').get(id);
    return receipt ? { status: 'restored', evidence: { value: String(receipt.value) } } : { status: 'unknown' };
  },
};
const signer = await devKeyProvider({ dir: join(root, 'keys'), env: {} });
const options = { journal: localOperationJournal(join(root, 'journal'), signer), vault: reservedRecoveryVault(join(root, 'vault'), { test: Buffer.from(process.env.TEST_KEY, 'base64') }, 'test'), adapters: [adapter], authorize: async () => true };
const runtime = recoveryRuntime(options);
for (const id of [1, 2]) await runtime.execute({ workspace: 'test', agentId: 'agent', runId: 'run', operationId: 'op-' + id, adapterId: adapter.id, arguments: { id } });
await runtime.planRecoveryJob({ workspace: 'test', jobId: 'chain', selection: { kind: 'run', runId: 'run' } });
await runtime.runRecoveryJob('test', 'chain', async () => true);
process.send({ stage: 'finished' });
`,
    );
    child = fork(worker, [], {
      env: {
        ...process.env,
        TEST_ROOT: root,
        TEST_KEY: key.toString("base64"),
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    child.stderr?.resume();
    const [message] = (await once(child, "message", {
      signal: AbortSignal.timeout(CHILD_MESSAGE_TIMEOUT_MS),
    })) as [InverseCommittedMessage];
    assert.equal(message.stage, "inverse-committed");
    assert.equal(message.before, "two-before");
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    const [, signal] = await exited;
    assert.equal(signal, "SIGKILL");

    const db = new DatabaseSync(join(root, "effect.sqlite"));
    closeDatabase = () => db.close();
    // A recovery job runs its steps in reverse, so the second operation is the
    // one whose inverse committed before the kill. The first is untouched, and
    // no checkpoint records either outcome.
    assert.deepEqual(
      db
        .prepare("SELECT id, value, inverses FROM effect ORDER BY id")
        .all()
        .map((row) => ({ ...row })),
      [
        { id: 1, value: "one-after", inverses: 0 },
        { id: 2, value: "two-before", inverses: 1 },
      ],
    );

    const signer = await devKeyProvider({ dir: join(root, "keys"), env: {} });
    const runtime = recoveryRuntime({
      journal: localOperationJournal(join(root, "journal"), signer),
      vault: reservedRecoveryVault(join(root, "vault"), { test: key }, "test"),
      adapters: [chainFixture(db)],
      authorize: async () => true,
    });
    // The E0 acceptance is explicit here: a receipt lost between commit and
    // acknowledgement yields `unknown` and demands reconciliation. It must not
    // guess, and above all it must not invert the committed step a second time.
    const interrupted = await runtime.runRecoveryJob(
      "test",
      "chain",
      async () => true,
    );
    assert.deepEqual(interrupted.residuals, [
      { operationId: "op-2", status: "unknown" },
    ]);
    assert.notEqual(interrupted.status, "restored");
    assert.deepEqual(
      db
        .prepare("SELECT id, value, inverses FROM effect ORDER BY id")
        .all()
        .map((row) => ({ ...row })),
      [
        { id: 1, value: "one-after", inverses: 0 },
        { id: 2, value: "two-before", inverses: 1 },
      ],
    );

    // Reconciliation reads the durable receipt and establishes the outcome the
    // checkpoint lost. Only then may the job use that step as lineage.
    assert.equal(
      (await runtime.reconcileRecovery("test", "op-2")).status,
      "restored",
    );
    const resumed = await runtime.runRecoveryJob(
      "test",
      "chain",
      async () => true,
    );
    assert.deepEqual(resumed.residuals, []);
    assert.equal(resumed.status, "restored");
    // Neither inverse ran twice: exactly one per row across the crash.
    assert.deepEqual(
      db
        .prepare("SELECT id, value, inverses FROM effect ORDER BY id")
        .all()
        .map((row) => ({ ...row })),
      [
        { id: 1, value: "one-before", inverses: 1 },
        { id: 2, value: "two-before", inverses: 1 },
      ],
    );
  },
);

test(
  "SIGKILL during the last step of a chain never repeats a checkpointed inverse",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "nomo-killed-chain-last-"));
    const key = randomBytes(32);
    let child: ChildProcess | undefined;
    let closeDatabase = () => {};
    t.after(async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exit = once(child, "exit");
        child.kill("SIGKILL");
        await exit;
      }
      closeDatabase();
      await rm(root, { recursive: true, force: true });
    });
    const worker = join(root, "worker.mjs");
    // Same chain fixture as the first-step kill, but the lethal step is the
    // last one: the first step's inverse is committed and checkpointed, and
    // only then does the kill land in the second inverse's commit window.
    await writeFile(
      worker,
      `
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { devKeyProvider } from ${JSON.stringify(new URL("../../ledger/src/sign.ts", import.meta.url).href)};
import { recoveryRuntime, localOperationJournal, reservedRecoveryVault } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
const root = process.env.TEST_ROOT;
const db = new DatabaseSync(join(root, 'effect.sqlite'));
db.exec("CREATE TABLE effect(id INTEGER PRIMARY KEY, before TEXT, after TEXT, value TEXT, inverses INTEGER); INSERT INTO effect VALUES (1,'one-before','one-after','one-before',0),(2,'two-before','two-after','two-before',0); CREATE TABLE receipts(id TEXT PRIMARY KEY, value TEXT)");
const rows = db.prepare('SELECT * FROM effect WHERE id=?');
const adapter = {
  id: 'chain-fixture', version: '1',
  async preflight(args) { const id = args.id; return { effect: 'write', reversibility: 'r1', readiness: 'verified', scope: 'one fixture row', resources: ['row:' + id], revision: rows.get(id).value, blastRadius: { count: 1, precision: 'exact' } }; },
  async prepare(args) { return { before: rows.get(args.id).before, plan: null }; },
  async execute(args) { db.prepare('UPDATE effect SET value=after WHERE id=?').run(args.id); return { result: args.id, evidence: { id: args.id, after: rows.get(args.id).after } }; },
  async release() {},
  async reconcile() { return { status: 'unknown' }; },
  async recoverWithContinuation(prepared, outcome, id, previous) {
    const receipt = db.prepare('SELECT value FROM receipts WHERE id=?').get(id);
    return receipt ? { status: 'restored', evidence: { value: String(receipt.value) } } : { status: 'conflict', evidence: null };
  },
  async recover(prepared, outcome, id) {
    db.exec('BEGIN IMMEDIATE');
    const changed = db.prepare('UPDATE effect SET value=?, inverses=inverses+1 WHERE value=?').run(prepared.before, outcome.evidence.after);
    if (changed.changes !== 1) throw new Error('Fixture drift');
    db.prepare('INSERT INTO receipts VALUES (?,?)').run(id, prepared.before);
    db.exec('COMMIT');
    const killBefore = process.env.TEST_KILL_BEFORE ?? 'two-before';
    if (prepared.before === killBefore) {
      process.send({ stage: 'inverse-committed', before: prepared.before });
      await new Promise(() => setInterval(() => {}, 1000));
    }
    return { status: 'restored', evidence: { value: prepared.before } };
  },
  async reconcileRecovery(prepared, outcome, id) {
    const receipt = db.prepare('SELECT value FROM receipts WHERE id=?').get(id);
    return receipt ? { status: 'restored', evidence: { value: String(receipt.value) } } : { status: 'unknown' };
  },
};
const signer = await devKeyProvider({ dir: join(root, 'keys'), env: {} });
const options = { journal: localOperationJournal(join(root, 'journal'), signer), vault: reservedRecoveryVault(join(root, 'vault'), { test: Buffer.from(process.env.TEST_KEY, 'base64') }, 'test'), adapters: [adapter], authorize: async () => true };
const runtime = recoveryRuntime(options);
for (const id of [1, 2]) await runtime.execute({ workspace: 'test', agentId: 'agent', runId: 'run', operationId: 'op-' + id, adapterId: adapter.id, arguments: { id } });
await runtime.planRecoveryJob({ workspace: 'test', jobId: 'chain', selection: { kind: 'run', runId: 'run' } });
await runtime.runRecoveryJob('test', 'chain', async () => true);
process.send({ stage: 'finished' });
`,
    );
    child = fork(worker, [], {
      env: {
        ...process.env,
        TEST_ROOT: root,
        TEST_KEY: key.toString("base64"),
        TEST_KILL_BEFORE: "one-before",
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    child.stderr?.resume();
    const [message] = (await once(child, "message", {
      signal: AbortSignal.timeout(CHILD_MESSAGE_TIMEOUT_MS),
    })) as [InverseCommittedMessage];
    assert.equal(message.stage, "inverse-committed");
    assert.equal(message.before, "one-before");
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    const [, signal] = await exited;
    assert.equal(signal, "SIGKILL");

    const db = new DatabaseSync(join(root, "effect.sqlite"));
    closeDatabase = () => db.close();
    // The first step is committed and checkpointed; the last step's inverse
    // committed its receipt but recorded no checkpoint.
    const rows = () =>
      db
        .prepare("SELECT id, value, inverses FROM effect ORDER BY id")
        .all()
        .map((row) => ({ ...row }));
    assert.deepEqual(rows(), [
      { id: 1, value: "one-before", inverses: 1 },
      { id: 2, value: "two-before", inverses: 1 },
    ]);

    const signer = await devKeyProvider({ dir: join(root, "keys"), env: {} });
    const runtime = recoveryRuntime({
      journal: localOperationJournal(join(root, "journal"), signer),
      vault: reservedRecoveryVault(join(root, "vault"), { test: key }, "test"),
      adapters: [chainFixture(db)],
      authorize: async () => true,
    });
    // The checkpointed first step is not reported and never runs again; the
    // interrupted last step is unknown until reconciled.
    const interrupted = await runtime.runRecoveryJob(
      "test",
      "chain",
      async () => true,
    );
    assert.deepEqual(interrupted.residuals, [
      { operationId: "op-1", status: "unknown" },
    ]);
    assert.notEqual(interrupted.status, "restored");
    assert.deepEqual(rows(), [
      { id: 1, value: "one-before", inverses: 1 },
      { id: 2, value: "two-before", inverses: 1 },
    ]);

    assert.equal(
      (await runtime.reconcileRecovery("test", "op-1")).status,
      "restored",
    );
    const resumed = await runtime.runRecoveryJob(
      "test",
      "chain",
      async () => true,
    );
    assert.deepEqual(resumed.residuals, []);
    assert.equal(resumed.status, "restored");
    // Exactly one inverse per row across the crash, including the step whose
    // checkpoint survived it.
    assert.deepEqual(rows(), [
      { id: 1, value: "one-before", inverses: 1 },
      { id: 2, value: "two-before", inverses: 1 },
    ]);
  },
);

// The restarted adapter answers a committed inverse from its durable receipt
// instead of applying it again, and refuses to invent lineage it cannot prove.
function chainFixture(db: DatabaseSync): RecoveryAdapter {
  const receipt = (id: string) =>
    db.prepare("SELECT value FROM receipts WHERE id=?").get(id);
  const restored = (id: string) => {
    const row = receipt(id);
    return row
      ? { status: "restored" as const, evidence: { value: String(row.value) } }
      : ({ status: "unknown" } as const);
  };
  return {
    id: "chain-fixture",
    version: "1",
    async preflight(args) {
      const id = (args as { id: number }).id;
      return {
        effect: "write",
        reversibility: "r1",
        readiness: "verified",
        scope: "one fixture row",
        resources: [`row:${id}`],
        revision: "unknown",
        blastRadius: { count: 1, precision: "exact" },
      };
    },
    async prepare(args) {
      return {
        before: (args as { id: number }).id === 1 ? "one-before" : "two-before",
        plan: null,
      };
    },
    async execute(args) {
      const id = (args as { id: number }).id;
      db.prepare("UPDATE effect SET value=after WHERE id=?").run(id);
      return {
        result: String(id),
        evidence: { id, after: id === 1 ? "one-after" : "two-after" },
      };
    },
    async release() {},
    async reconcile() {
      return { status: "unknown" };
    },
    async recoverWithContinuation(_prepared, _outcome, id) {
      // The receipt is the only proof the earlier inverse already happened.
      // Without one this step has no verified predecessor, so it refuses
      // rather than assuming its way into the chain.
      return receipt(id)
        ? { status: "restored", evidence: { value: String(receipt(id)!.value) } }
        : { status: "conflict", evidence: null };
    },
    async recover(prepared, outcome, id) {
      // The before-image comes from the operation's own capture, never from
      // parsing the recovery id: the id is a runtime detail and this must not
      // depend on its format.
      const before = String(prepared.before);
      db.exec("BEGIN IMMEDIATE");
      const changed = db
        .prepare("UPDATE effect SET value=?, inverses=inverses+1 WHERE value=?")
        .run(before, (outcome.evidence as { after: string }).after);
      if (changed.changes !== 1) throw new Error("Fixture drift");
      db.prepare("INSERT INTO receipts VALUES (?,?)").run(id, before);
      db.exec("COMMIT");
      return { status: "restored", evidence: { value: before } };
    },
    async reconcileRecovery(_prepared, _outcome, id) {
      return restored(id);
    },
  };
}
