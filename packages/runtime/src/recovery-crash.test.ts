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

for (const durableReceipt of [false, true]) {
  test(
    `SIGKILL after inverse commit ${durableReceipt ? "with" : "without"} an atomic receipt never repeats recovery`,
    { timeout: TEST_TIMEOUT_MS },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), "void-killed-recovery-"));
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
