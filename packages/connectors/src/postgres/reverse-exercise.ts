import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";

import { keyProviderFromPkcs8 } from "../../../ledger/src/sign.ts";
import { verifyLedgerFile } from "../../../ledger/src/verify.ts";
import { localOperationJournal, localRecoveryVault, recoveryRuntime } from "../../../runtime/src/index.ts";
import { installManagedPostgres, managedPostgresAdapter, type ManagedPostgresOptions } from "./managed.ts";

const WORKSPACE = "exercise";

/**
 * The database half of the agentic reverse exercise: the loop this product is
 * actually sold on, against a real database with a real transaction boundary.
 *
 * Recovering a schema and data change means restoring a row VOID captured
 * before it wrote, not reconstructing one from a guess, so the assertion is on
 * the captured values and on a row outside the declared scope staying untouched.
 *
 * PGlite is a real engine running in process. This is a disposable local
 * database and proves nothing about a networked cluster, which is what the R04
 * certification gate is for; it is not a substitute for it.
 */
export async function runDatabaseReverseExercise() {
  const db = new PGlite();
  const steps = [];
  let root;
  try {
    await db.exec(
      "CREATE TABLE ledger_entry(id integer PRIMARY KEY, amount integer NOT NULL, memo text); " +
        "INSERT INTO ledger_entry VALUES(1, 4200, 'original memo'),(2, 900, 'untouched')",
    );
    root = await mkdtemp(join(tmpdir(), "void-reverse-db-"));

    const options: ManagedPostgresOptions = {
      workspace: WORKSPACE,
      schema: "void_recovery",
      tables: [{ table: "public.ledger_entry", primaryKey: ["id"], columns: ["amount", "memo"] }],
      connect: async () => ({
        query: async <T>(sql: string, params?: readonly unknown[]) =>
          (await db.query<T>(sql, params ? [...params] : [])).rows,
        close: async () => {},
      }),
    };
    await installManagedPostgres(options);
    steps.push("a managed table is installed with its own capture metadata");

    const { privateKey } = generateKeyPairSync("ed25519");
    const signer = keyProviderFromPkcs8(privateKey.export({ type: "pkcs8", format: "der" }));
    const adapter = managedPostgresAdapter(options);
    const host = recoveryRuntime({
      journal: localOperationJournal(join(root, "journal"), signer),
      // A fresh 256-bit key per run: the vault key is what makes the capture
      // unreadable without it, so reusing one across runs would prove nothing.
      vault: localRecoveryVault(join(root, "vault"), { exercise: randomBytes(32) }, "exercise"),
      adapters: [adapter],
      // The human approves once. A second ask on the same identity is refused,
      // which is the shape a one-shot approval actually has.
      authorize: async ({ request }) => request.operationId !== "op-db-denied",
    });

    const row = async (id: number) =>
      (await db.query("SELECT amount, memo FROM ledger_entry WHERE id = $1", [id])).rows[0] as
        { amount: number; memo: string } | undefined;

    const before = await row(1);
    if (before?.amount !== 4200 || before.memo !== "original memo") {
      throw new Error(`the fixture row was not seeded: ${JSON.stringify(before)}`);
    }

    // 1. A refused row change, against a real transaction boundary.
    const denied = await host.execute({
      workspace: WORKSPACE,
      operationId: "op-db-denied",
      agentId: "reverse-agent",
      runId: "db-run",
      adapterId: adapter.id,
      arguments: { table: "public.ledger_entry", action: "update", key: { id: 1 }, values: { amount: 0 } },
    });
    if (denied.status !== "denied") throw new Error(`a denied row change reported ${JSON.stringify(denied)}`);
    const afterDenied = await row(1);
    if (afterDenied?.amount !== 4200 || afterDenied.memo !== "original memo") {
      throw new Error("a denied row change altered the row");
    }
    steps.push("a refused row change leaves the row exactly as it was");

    // 2. The approved change, scoped to one row.
    const applied = await host.execute({
      workspace: WORKSPACE,
      operationId: "op-db-write",
      agentId: "reverse-agent",
      runId: "db-run",
      adapterId: adapter.id,
      arguments: { table: "public.ledger_entry", action: "update", key: { id: 1 }, values: { amount: 0, memo: "agent edit" } },
    });
    if (applied.status !== "succeeded") throw new Error(`the approved row change reported ${JSON.stringify(applied)}`);
    const afterWrite = await row(1);
    if (afterWrite?.amount !== 0 || afterWrite.memo !== "agent edit") {
      throw new Error(`the approved row change did not land: ${JSON.stringify(afterWrite)}`);
    }
    const untouched = await row(2);
    if (untouched?.amount !== 900 || untouched.memo !== "untouched") {
      throw new Error("the row change touched a row outside its declared scope");
    }
    steps.push("an approved row change lands and leaves every other row alone");

    // 3. The inverse restores the captured values, not a guess at them.
    const plan = await host.planRecovery(WORKSPACE, "op-db-write");
    if (plan.digest === "") throw new Error("the recovery plan carried no digest");
    const restored = await host.recover(plan, async () => true);
    if (restored.status !== "restored") throw new Error(`the database inverse reported ${JSON.stringify(restored)}`);
    const afterRestore = await row(1);
    if (afterRestore?.amount !== 4200 || afterRestore.memo !== "original memo") {
      throw new Error(`the inverse did not restore the row: ${JSON.stringify(afterRestore)}`);
    }
    steps.push("the confirmed inverse restores the captured row, not a guess at it");

    // 4. The database history is signed like everything else.
    const proof = await verifyLedgerFile(join(root, "journal", `${WORKSPACE}.jsonl`), signer);
    if (!proof.ok) throw new Error(`the database journal did not verify: ${JSON.stringify(proof)}`);
    steps.push(`the signed database journal verifies over ${proof.checked} entries`);

    return { steps };
  } finally {
    await db.close();
    if (root !== undefined && process.env.VOID_KEEP_EXERCISE !== "1") {
      await rm(root, { recursive: true, force: true });
    }
  }
}
