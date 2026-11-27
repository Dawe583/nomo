#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { makeConnector } from "../../packages/connectors/src/registry.ts";
import { LocalSnapshotStore } from "../../packages/connectors/src/snapshot/local.ts";
import { postgresExecutor } from "../../packages/cli/src/postgres.ts";
import { readLedgerFeed } from "../../packages/ledger/src/feed.ts";
import { canonicalDigest, keyProviderFromPkcs8 } from "../../packages/ledger/src/sign.ts";
import { jsonlStore } from "../../packages/ledger/src/store.ts";

const execFileAsync = promisify(execFile);

/**
 * Real-service PostgreSQL replay proof for the legacy connector path. It must
 * run inside disposable-postgres.mjs so DATABASE_URL names the isolated
 * loopback-only test database. This is distinct from the managed PostgreSQL
 * recovery verifier: it exercises persisted connector capture plus nomo replay.
 */
export async function verifyPostgresReplayWire() {
  const url = process.env.DATABASE_URL;
  assert.equal(typeof url, "string", "DATABASE_URL must be injected by disposable-postgres.mjs");
  assert.equal(process.env.NOMO_TEST_DATABASE_ISOLATED, "1", "refusing to run outside the disposable isolated database");
  const root = await mkdtemp(join(tmpdir(), "nomo-pg-replay-wire-"));
  const exec = await postgresExecutor(url);
  try {
    await prepareTable(exec);
    const roundTrip = await runScenario({ root, name: "roundtrip", exec, url, drift: false });
    const drift = await runScenario({ root, name: "drift", exec, url, drift: true });
    return { roundTrip, drift };
  } finally {
    await exec.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function prepareTable(exec) {
  await exec.query("drop table if exists public.replay_wire_orders");
  await exec.query("create table public.replay_wire_orders (id integer primary key, status text not null, total integer not null)");
}

async function runScenario({ root, name, exec, url, drift }) {
  const id = name === "roundtrip" ? 1 : 2;
  await exec.query("delete from public.replay_wire_orders where id = $1", [id]);
  await exec.query("insert into public.replay_wire_orders (id, status, total) values ($1, 'draft', 42)", [id]);
  const sql = `update public.replay_wire_orders set status = 'paid' where id = ${id}`;
  const scenario = await captureAndLedger({ root, name, exec, sql });
  await exec.query(sql);
  if (drift) await exec.query("update public.replay_wire_orders set status = 'human' where id = $1", [id]);

  const result = await runReplaySubprocess(scenario, url);
  const rows = await exec.query("select id, status, total from public.replay_wire_orders where id = $1", [id]);
  const ledgerText = await readFile(scenario.ledgerPath, "utf8");
  assert.equal(rows.length, 1);

  if (!drift) {
    assert.equal(result.code, 0, `${name} stderr: ${result.stderr}\nstdout: ${result.stdout}`);
    assert.match(result.stdout, /applied: update-0-public\.replay_wire_orders/);
    assert.match(result.stdout, /reversal: seq 2 records the inversion of seq 1 /);
    assert.equal(rows[0].status, "draft");
    const feed = await readLedgerFeed(scenario.ledgerPath, { publicKey: scenario.publicKeyLookup });
    assert.equal(feed.records.length, 2);
    assert.equal(feed.records[1]?.decision, "execute:reversal");
  } else {
    assert.equal(result.code, 1, `${name} stderr: ${result.stderr}\nstdout: ${result.stdout}`);
    assert.match(result.stdout, /refused update-0-public\.replay_wire_orders: drift/);
    assert.match(result.stdout, /column status changed/);
    assert.equal(rows[0].status, "human");
    assert.equal(ledgerText.trim().split("\n").length, 1, "a refused replay must not append a reversal");
  }

  return {
    name,
    code: result.code,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    finalStatus: rows[0].status,
    ledgerEntries: ledgerText.trim().split("\n").length,
  };
}

async function captureAndLedger({ root, name, exec, sql }) {
  const scenarioRoot = join(root, name);
  const snapshotDir = join(scenarioRoot, "snapshots");
  const ledgerDir = join(scenarioRoot, "ledger");
  await mkdir(snapshotDir, { recursive: true });
  await mkdir(ledgerDir, { recursive: true, mode: 0o700 });

  const store = LocalSnapshotStore(snapshotDir);
  const connector = makeConnector({ store, exec }).postgres;
  const call = {
    tool: "postgres.row.update",
    connector: "postgres",
    arguments: {
      sql,
      schema: { tables: [{ table: "public.replay_wire_orders", primaryKey: ["id"], columns: ["id", "status", "total"] }] },
    },
    workspace: "wire",
  };
  const capture = await connector.capture(call);
  const argsDigest = canonicalDigest(call.arguments);
  await writeFile(join(snapshotDir, "manifest.jsonl"), JSON.stringify({ digest: argsDigest, reference: capture.reference, tool: call.tool }) + "\n");

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pkcs8 = Buffer.from(privateKey.export({ format: "der", type: "pkcs8" }));
  const spki = new Uint8Array(publicKey.export({ format: "der", type: "spki" }));
  const signer = keyProviderFromPkcs8(pkcs8);
  await jsonlStore(signer, { dir: ledgerDir }).append({
    workspace: "wire",
    at: new Date().toISOString(),
    tool: call.tool,
    klass: "r1",
    decision: "execute:completed",
    captureDigest: capture.reference.digest,
    argsDigest,
  });

  return {
    snapshotDir,
    ledgerPath: join(ledgerDir, "wire.jsonl"),
    publicKey: Buffer.from(spki).toString("base64"),
    signingKey: pkcs8.toString("base64"),
    publicKeyLookup: (id) => signer.publicKey(id),
  };
}

async function runReplaySubprocess(scenario, url) {
  const binary = new URL("../../packages/cli/bin/nomo.mjs", import.meta.url);
  const childEnv = {
    PATH: process.env.PATH ?? "",
    NOMO_PG_URL: url,
    NOMO_SIGNING_KEY: scenario.signingKey,
  };
  const args = [
    binary.pathname,
    "replay",
    "--ledger", scenario.ledgerPath,
    "--snapshot-dir", scenario.snapshotDir,
    "--seq", "1",
    "--key", scenario.publicKey,
  ];
  try {
    const result = await execFileAsync(process.execPath, args, { env: childEnv, timeout: 15000 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? String(error),
    };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = await verifyPostgresReplayWire();
    console.log(JSON.stringify({ passed: true, ...result }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  }
}
