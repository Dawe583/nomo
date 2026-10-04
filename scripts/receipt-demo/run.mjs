/**
 * The receipt demo, against a real PostgreSQL server.
 *
 * This is the only artefact that answers the question the product now rests
 * on: after a verified inverse, is there a record a third party can check
 * without running VOID?
 *
 * It is deliberately a throwaway script rather than a test. "VOID can restore
 * a row" is already proved by the suite, against PGlite. What is being claimed
 * here is that the evidence ends up in the customer's own database, and proving
 * that means writing to a real server, breaking it on purpose, repairing it,
 * and then stepping out of the way.
 *
 * Usage:
 *   VOID_PG_URL=postgres://user@127.0.0.1:5432/void_demo node --experimental-strip-types scripts/receipt-demo/run.mjs
 */

import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pg from "pg";

import {
  installManagedPostgres,
  managedPostgresAdapter,
} from "../../packages/connectors/src/postgres/managed.ts";
import {
  localOperationJournal,
  localRecoveryVault,
  recoveryRuntime,
} from "../../packages/runtime/src/index.ts";
import { devKeyProvider } from "../../packages/ledger/src/sign.ts";

const url = process.env.VOID_PG_URL;
if (url === undefined || url === "") {
  console.error("set VOID_PG_URL to a disposable PostgreSQL database");
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: url });
const root = await mkdtemp(join(tmpdir(), "void-receipt-"));

/**
 * One dedicated client per ManagedConnection, never the pool.
 *
 * prepare() opens `BEGIN ISOLATION LEVEL SERIALIZABLE` on this connection and
 * the rest of the transaction has to run in that same session, which a pool
 * handing out a different backend per query cannot give.
 */
const connect = async () => {
  const client = await pool.connect();
  return {
    query: async (sql, params) => (await client.query(sql, params ? [...params] : [])).rows,
    begin: async () => {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    },
    commit: async () => {
      await client.query("COMMIT");
    },
    rollback: async () => {
      await client.query("ROLLBACK");
    },
    close: async () => {
      client.release();
    },
  };
};

const options = {
  workspace: "demo",
  schema: "void_recovery",
  tables: [{ table: "public.account", primaryKey: ["id"], columns: ["balance", "note"] }],
  connect,
};

const show = async (label, sql) => {
  const { rows } = await pool.query(sql);
  console.log(`\n${label}`);
  console.table(rows);
  return rows;
};

// The raw shape, for the recorded run. `show` prints; this returns.
const showRaw = async (sql) => (await pool.query(sql)).rows;

try {
  await pool.query("DROP SCHEMA IF EXISTS void_recovery CASCADE");
  await pool.query("DROP TABLE IF EXISTS account");
  await pool.query(
    "CREATE TABLE account(id integer PRIMARY KEY, balance integer NOT NULL CHECK(balance>=0), note text)",
  );
  await pool.query("INSERT INTO account VALUES(1,10,'opening balance'),(2,90,'team budget')");

  const version = (await pool.query("select version()")).rows[0].version;
  console.log(`server: ${version.split(" ").slice(0, 2).join(" ")}`);
  await show("1. before anything", "select * from account order by id");

  const installed = await installManagedPostgres(options);
  console.log(`\ninstalled: ${JSON.stringify(installed)}`);

  const signer = await devKeyProvider({ dir: join(root, "keys"), env: {} });
  const runtimeOptions = {
    journal: localOperationJournal(join(root, "journal"), signer),
    vault: localRecoveryVault(join(root, "vault"), { first: randomBytes(32) }, "first"),
    adapters: [managedPostgresAdapter(options)],
    authorize: async () => true,
  };

  // The agent's write. It zeroes an account, which the check constraint
  // accepts, because the interesting failure is never the constraint refusing.
  const writer = recoveryRuntime(runtimeOptions);
  const executed = await writer.execute({
    workspace: "demo",
    operationId: "op-agent",
    agentId: "agent-1",
    runId: "run-1",
    adapterId: runtimeOptions.adapters[0].id,
    arguments: {
      table: "public.account",
      action: "update",
      key: { id: 1 },
      values: { balance: 0, note: "spent by agent" },
    },
  });
  console.log(`\nagent write: ${executed.status}`);
  if (executed.status !== "succeeded") {
    console.log(JSON.stringify(executed, null, 2));
    throw new Error("the agent write did not succeed, so there is nothing to invert");
  }

  // A legitimate write that happened after the agent's, from outside VOID
  // entirely. This is the row a point-in-time restore would destroy.
  await pool.query("UPDATE account SET balance = 75, note = 'approved by finance' WHERE id = 2");
  console.log("finance then approved a change to account 2, outside VOID");
  await show("2. after the agent write and the later human write", "select * from account order by id");

  // A fresh runtime, so the repair reaches nothing the writer held.
  const repair = recoveryRuntime({
    ...runtimeOptions,
    adapters: [managedPostgresAdapter(options)],
  });
  const plan = await repair.planRecovery("demo", "op-agent");
  const recovered = await repair.recover(plan, async () => true);
  console.log(`\ninverse: ${recovered.status}`);
  await show("3. after the inverse", "select * from account order by id");
  const receipts = await show(
    "4. the receipt, in the customer's own database",
    "select id, input_digest, format_version, outcome->>'status' as status, outcome->'evidence'->'rows'->0->'row' as restored_row from void_recovery.recoveries order by id",
  );
  await show(
    "5. the audit trail beside it",
    "select id, format_version, outcome->>'status' as status, capture->'statement'->>'operation' as operation from void_recovery.operations order by id",
  );

  console.log("\n--- what a third party runs next ---");
  console.log(
    receipts.length > 0
      ? "psql $VOID_PG_URL -f docs/RECEIPT-VERIFY.sql   (VOID is not involved)"
      : "NO RECEIPT WAS WRITTEN",
  );

  // A recorded run, so the claim can be read rather than taken on trust. This
  // is evidence of one execution against a real server, not a fixture the demo
  // can regenerate to whatever it likes: `check-recorded-receipt.mjs` holds
  // `docs/RECEIPT-VERIFY.sql`'s own conditions against this file.
  await writeFile(
    new URL("./recorded-run.json", import.meta.url),
    `${JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        server: (await showRaw("select version() as v"))[0]?.v.split(" ").slice(0, 2).join(" "),
        receipt:
          (await showRaw(
            "select id, input_digest, format_version, outcome from void_recovery.recoveries order by id",
          ))[0] ?? null,

        rowTheAgentWrote: rowTheAgentWrote ?? null,
        rowsAfterRestore: await showRaw("select id, balance, note from public.account order by id"),
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await pool.end();
  await rm(root, { recursive: true, force: true });
}
