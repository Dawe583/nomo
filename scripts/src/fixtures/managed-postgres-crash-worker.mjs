// Test-only worker killed after PostgreSQL commits but before runtime persistence.
import assert from "node:assert/strict";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { managedPostgresAdapter } from "../../../packages/connectors/src/postgres/managed.ts";
import {
  localOperationJournal,
  recoveryRuntime,
  reservedRecoveryVault,
} from "../../../packages/runtime/src/index.ts";
import { devKeyProvider } from "../../../packages/ledger/src/sign.ts";

assert.equal(process.env.NOMO_RECOVERY_DATABASE_TEST, "1");
const config = JSON.parse(process.env.NOMO_POSTGRES_CRASH_CONFIG ?? "null");
assert.ok(config && process.send, "Crash worker requires IPC configuration.");
const url = new URL(process.env.DATABASE_URL);
assert.equal(url.pathname, "/void_gui_upgrade_preview");
assert.ok(!url.hostname.includes("-pooler"));
neonConfig.webSocketConstructor = WebSocket;
const pool = new Pool({
  connectionString: url.href,
  max: 1,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 1000,
});
const connect = async () => {
  const client = await pool.connect();
  let broken = false;
  const onError = () => {
    broken = true;
  };
  client.on("error", onError);
  return {
    query: async (sql, params) => {
      const rows = (await client.query(sql, params)).rows;
      if (sql === "COMMIT") {
        process.send({ stage: "committed", mode: config.mode });
        await new Promise(() => {});
      }
      return rows;
    },
    close: async () => {
      client.release(broken);
      client.removeListener("error", onError);
    },
  };
};
const signer = await devKeyProvider({ dir: config.keyDir, env: {} });
const runtime = recoveryRuntime({
  journal: localOperationJournal(config.journalDir, signer),
  vault: reservedRecoveryVault(
    config.vaultDir,
    { test: Buffer.from(config.vaultKey, "hex") },
    "test",
  ),
  authorize: async () => true,
  adapters: [
    managedPostgresAdapter({
      workspace: config.workspace,
      schema: config.metadata,
      tables: config.tables,
      connect,
    }),
  ],
});
try {
  if (config.mode === "forward") await runtime.execute(config.request);
  else await runtime.recover(config.plan, async () => true);
  throw new Error("Crash worker returned after the armed commit.");
} finally {
  await pool.end();
}
