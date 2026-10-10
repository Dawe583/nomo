/** Persistence-call failures with fresh runtime instances, not physical disk faults
 * or process death. The provider fixture deliberately has no duplicate-write guard. */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { devKeyProvider } from "../../ledger/src/sign.ts";
import {
  localOperationJournal,
  reservedRecoveryVault,
  recoveryRuntime,
  type RecoveryAdapter,
  type OperationJournal,
  type RecoveryVault,
  type Stage,
  type VaultSlot,
  type Outcome,
  type RecoveryOutcome,
} from "./index.ts";

type Fault = { boundary: Stage | VaultSlot; timing: "before" | "after" };

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "nomo-persistence-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const signer = await devKeyProvider({ dir: join(dir, "keys"), env: {} });
  const keys = { test: randomBytes(32) };
  const database = <T>(run: (db: DatabaseSync) => T): T => {
    const db = new DatabaseSync(join(dir, "target.sqlite"));
    try {
      return run(db);
    } finally {
      db.close();
    }
  };
  database((db) =>
    db.exec(`CREATE TABLE target(value TEXT, writes INTEGER, inverses INTEGER, forward_receipt TEXT, recovery_receipt TEXT);
    INSERT INTO target VALUES('before',0,0,NULL,NULL)`),
  );
  const read = () =>
    database((db) => db.prepare("SELECT * FROM target").get()!);
  const request = {
    workspace: "test",
    operationId: "operation",
    agentId: "agent",
    runId: "run",
    adapterId: "fixture",
    arguments: "private-after",
  };
  const open = (fault?: Fault) => {
    const journal = localOperationJournal(join(dir, "journal"), signer);
    const vault = reservedRecoveryVault(join(dir, "vault"), keys, "test", {
      maxArtifactBytes: 2048,
      maxTotalBytes: 3 * 2076,
    });
    let injected = false;
    const fail = (boundary: string | undefined, timing: Fault["timing"]) => {
      if (
        !injected &&
        fault &&
        fault.boundary === boundary &&
        fault.timing === timing
      ) {
        injected = true;
        throw new Error("Injected persistence failure");
      }
    };
    const interruptedJournal: OperationJournal = {
      transaction: (workspace, run) =>
        journal.transaction(workspace, (tx) =>
          run({
            events: tx.events,
            append: async (event) => {
              fail(event.stage, "before");
              await tx.append(event);
              fail(event.stage, "after");
            },
          }),
        ),
    };
    const interruptedVault: RecoveryVault = {
      ...vault,
      put: async (...args) => {
        fail(args[2]?.slot, "before");
        const reference = await vault.put(...args);
        fail(args[2]?.slot, "after");
        return reference;
      },
    };
    // A durable fixture receipt, not matching values, proves an effect after restart.
    const adapter: RecoveryAdapter = {
      id: "fixture",
      version: "1",
      async preflight() {
        return {
          effect: "write",
          reversibility: "r1",
          readiness: "verified",
          scope: "one fixture value",
          resources: ["value"],
          revision: read().value as string,
          blastRadius: { count: 1, precision: "exact" },
        };
      },
      async prepare() {
        return { before: read().value as string, plan: null };
      },
      async execute(args) {
        const outcome: Outcome = {
          result: args,
          evidence: { committed: true },
        };
        database((db) =>
          db
            .prepare(
              "UPDATE target SET value=?,writes=writes+1,forward_receipt=?",
            )
            .run(args as string, JSON.stringify(outcome)),
        );
        return outcome;
      },
      async release() {},
      async reconcile() {
        const receipt = read().forward_receipt;
        return receipt
          ? {
              status: "succeeded",
              outcome: JSON.parse(receipt as string) as Outcome,
            }
          : { status: "unknown" };
      },
      async recover(prepared) {
        const receipt: RecoveryOutcome = {
          status: "restored",
          evidence: { committed: true },
        };
        database((db) =>
          db
            .prepare(
              "UPDATE target SET value=?,inverses=inverses+1,recovery_receipt=?",
            )
            .run(prepared.before as string, JSON.stringify(receipt)),
        );
        return receipt;
      },
      async reconcileRecovery() {
        const receipt = read().recovery_receipt;
        return receipt
          ? (JSON.parse(receipt as string) as RecoveryOutcome)
          : { status: "unknown" };
      },
    };
    return {
      journal,
      vault,
      injected: () => injected,
      runtime: recoveryRuntime({
        journal: interruptedJournal,
        vault: interruptedVault,
        adapters: [adapter],
        authorize: async () => true,
      }),
    };
  };
  const verify = async () => {
    const host = open();
    await host.journal.transaction("test", async (tx) => {
      assert.equal(
        tx.events.filter((event) => event.stage === "succeeded").length,
        Number(read().writes),
      );
      assert.equal(
        tx.events.filter((event) => event.stage === "restored").length,
        Number(read().inverses),
      );
    });
    const ledger = await readFile(join(dir, "journal/test.jsonl"), "utf8");
    assert.equal(ledger.includes("private-after"), false);
    if (read().inverses === 1) assert.match(ledger, /"reverses":"operation"/);
  };
  const reservations = () => {
    const db = new DatabaseSync(join(dir, "vault/vault.sqlite"));
    try {
      return db
        .prepare(
          "SELECT slot FROM reservations WHERE workspace='test' AND operation_id='operation' ORDER BY slot",
        )
        .all()
        .map((row) => row.slot);
    } finally {
      db.close();
    }
  };
  return { request, open, read, verify, reservations };
}

async function attempt(action: Promise<{ status: string }>, expected: string) {
  if (expected === "rejected") {
    await assert.rejects(
      action,
      /Injected persistence failure|Invalid operation transition/,
    );
  } else assert.equal((await action).status, expected);
}

const forwardCases: [Stage | VaultSlot, string, string][] = [
  ["received", "rejected", "rejected"],
  ["authorized", "failed", "failed"],
  ["prepared", "failed", "failed"],
  ["dispatched", "failed", "failed"],
  ["succeeded", "unknown", "rejected"],
  ["capture", "failed", "failed"],
  ["outcome", "unknown", "unknown"],
];
for (const [boundary, before, after] of forwardCases) {
  for (const timing of ["before", "after"] as const) {
    test(`${timing} ${boundary} persistence failure never repeats a forward effect`, async (t) => {
      const f = await fixture(t),
        host = f.open({ boundary, timing });
      await attempt(
        host.runtime.execute(f.request),
        timing === "before" ? before : after,
      );
      assert.equal(host.injected(), true);
      const committed = boundary === "succeeded" || boundary === "outcome";
      assert.equal(f.read().writes, committed ? 1 : 0);
      assert.equal(f.read().value, committed ? "private-after" : "before");
      if (committed) {
        assert.deepEqual(
          f.reservations(),
          boundary === "outcome" && timing === "before"
            ? ["outcome", "recovery"]
            : ["recovery"],
        );
      }
      const restarted = f.open();
      const retried = await restarted.runtime.execute(f.request);
      const initiallyUnrecorded =
        boundary === "received" && timing === "before";
      assert.equal(f.read().writes, committed || initiallyUnrecorded ? 1 : 0);
      if (committed || initiallyUnrecorded) {
        if (retried.status === "unknown") {
          // Unknown retains room for the outcome and inverse even under quota contention.
          await assert.rejects(
            restarted.vault.reserve!("test", "competitor"),
            /quota/,
          );
          assert.equal(
            (await restarted.runtime.reconcile("test", "operation")).status,
            "succeeded",
          );
        } else assert.equal(retried.status, "succeeded");
        const plan = await restarted.runtime.planRecovery("test", "operation");
        assert.equal(
          (await restarted.runtime.recover(plan, async () => true)).status,
          "restored",
        );
        assert.equal(
          (await f.open().runtime.recover(plan, async () => true)).status,
          "restored",
        );
        assert.equal(f.read().inverses, 1);
      } else {
        assert.ok(["received", "failed"].includes(retried.status));
        await assert.rejects(
          restarted.runtime.planRecovery("test", "operation"),
          /confirmed successful/,
        );
        await restarted.vault.reserve!("test", "competitor", ["recovery"]);
        assert.equal(f.read().inverses, 0);
      }
      assert.equal(f.read().value, "before");
      await f.verify();
    });
  }
}

for (const boundary of [
  "recovery-dispatched",
  "restored",
  "recovery",
] as const) {
  for (const timing of ["before", "after"] as const) {
    test(`${timing} ${boundary} persistence failure never repeats an inverse`, async (t) => {
      const f = await fixture(t),
        initial = f.open();
      assert.equal(
        (await initial.runtime.execute(f.request)).status,
        "succeeded",
      );
      const plan = await initial.runtime.planRecovery("test", "operation");
      const host = f.open({ boundary, timing });
      const expected =
        boundary === "recovery-dispatched" ||
        (boundary === "restored" && timing === "after")
          ? "rejected"
          : "unknown";
      await attempt(
        host.runtime.recover(plan, async () => true),
        expected,
      );
      assert.equal(host.injected(), true);
      const committed = boundary !== "recovery-dispatched";
      assert.equal(f.read().inverses, committed ? 1 : 0);
      assert.equal(f.read().value, committed ? "before" : "private-after");
      assert.deepEqual(
        f.reservations(),
        boundary === "recovery-dispatched" ||
          (boundary === "recovery" && timing === "before")
          ? ["recovery"]
          : [],
      );
      const restarted = f.open();
      await assert.rejects(
        restarted.vault.reserve!("test", "competitor"),
        /quota/,
      );
      const retry = await restarted.runtime.recover(plan, async () => true);
      const undispatched =
        boundary === "recovery-dispatched" && timing === "before";
      assert.equal(f.read().inverses, committed || undispatched ? 1 : 0);
      if (retry.status === "unknown") {
        assert.equal(
          (await restarted.runtime.reconcileRecovery("test", "operation"))
            .status,
          committed ? "restored" : "unknown",
        );
      } else assert.equal(retry.status, "restored");
      assert.equal(
        (await f.open().runtime.recover(plan, async () => true)).status,
        committed || undispatched ? "restored" : "unknown",
      );
      assert.equal(f.read().writes, 1);
      assert.equal(f.read().inverses, committed || undispatched ? 1 : 0);
      if (committed || undispatched) {
        assert.equal(f.read().value, "before");
        await f.verify();
      }
      else {
        await restarted.journal.transaction("test", async (tx) => {
          assert.equal(tx.events.at(-1)?.stage, "recovery-dispatched");
        });
      }
    });
  }
}
