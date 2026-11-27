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
import { s3Executor } from "../../packages/cli/src/s3.ts";
import { readLedgerFeed } from "../../packages/ledger/src/feed.ts";
import { canonicalDigest, keyProviderFromPkcs8 } from "../../packages/ledger/src/sign.ts";
import { jsonlStore } from "../../packages/ledger/src/store.ts";
import { startLocalS3Fixture } from "./local-s3-fixture.mjs";

const execFileAsync = promisify(execFile);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Live loopback wire proof for the CLI replay path. This uses the production
 * AWS SDK adapter and a real `nomo` subprocess, but the storage endpoint is
 * the repository's small fixture, so it is protocol evidence rather than
 * independent MinIO/AWS certification.
 */
export async function verifyS3Wire() {
  const fixture = await startLocalS3Fixture({ port: 0 });
  const root = await mkdtemp(join(tmpdir(), "nomo-s3-wire-"));
  try {
    fixture.createBucket("wire-objects");
    const roundTrip = await runScenario({ fixture, root, name: "roundtrip", drift: false });
    const drift = await runScenario({ fixture, root, name: "drift", drift: true });
    return { roundTrip, drift, requests: fixture.requests.length };
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function runScenario({ fixture, root, name, drift }) {
  const key = `${name}/orders.csv`;
  const before = encoder.encode(`${name}-before`);
  const human = encoder.encode(`${name}-human-change`);
  const env = wireEnv(fixture.url);
  const client = s3Executor(env);
  try {
    await client.putObject({ bucket: "wire-objects", key, body: before });
    const scenario = await captureAndLedger({ root, name, client, bucket: "wire-objects", key });
    await client.deleteObject({ bucket: "wire-objects", key });
    if (drift) await client.putObject({ bucket: "wire-objects", key, body: human });

    const result = await runReplaySubprocess(scenario, env);
    const after = await client.getObject({ bucket: "wire-objects", key }).catch((error) => error);
    const ledgerText = await readFile(scenario.ledgerPath, "utf8");

    if (!drift) {
      assert.equal(result.code, 0, `${name} stderr: ${result.stderr}\nstdout: ${result.stdout}`);
      assert.match(result.stdout, /applied: restore-sha256:/);
      assert.match(result.stdout, /reversal: seq 2 records the inversion of seq 1 /);
      assert.equal(after instanceof Error, false);
      assert.deepEqual([...after.body], [...before]);
      const feed = await readLedgerFeed(scenario.ledgerPath, { publicKey: scenario.publicKeyLookup });
      assert.equal(feed.records.length, 2);
      assert.equal(feed.records[1]?.decision, "execute:reversal");
    } else {
      assert.equal(result.code, 1, `${name} stderr: ${result.stderr}\nstdout: ${result.stdout}`);
      assert.match(result.stdout, /refused restore-sha256:.*drift/);
      assert.equal(after instanceof Error, false);
      assert.deepEqual([...after.body], [...human]);
      assert.equal(ledgerText.trim().split("\n").length, 1, "a refused replay must not append a reversal");
    }

    return {
      name,
      code: result.code,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
      objectBytes: after instanceof Error ? undefined : decoder.decode(after.body),
      ledgerEntries: ledgerText.trim().split("\n").length,
    };
  } finally {
    client.close();
  }
}

async function captureAndLedger({ root, name, client, bucket, key }) {
  const scenarioRoot = join(root, name);
  const snapshotDir = join(scenarioRoot, "snapshots");
  const ledgerDir = join(scenarioRoot, "ledger");
  await mkdir(snapshotDir, { recursive: true });
  await mkdir(ledgerDir, { recursive: true, mode: 0o700 });

  const store = LocalSnapshotStore(snapshotDir);
  const connector = makeConnector({ store, s3: client }).s3;
  const call = {
    tool: "aws.s3.object.delete",
    connector: "s3",
    arguments: { bucket, key },
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

async function runReplaySubprocess(scenario, env) {
  const binary = new URL("../../packages/cli/bin/nomo.mjs", import.meta.url);
  const childEnv = {
    PATH: process.env.PATH ?? "",
    ...env,
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

function wireEnv(endpoint) {
  return {
    AWS_REGION: "us-east-1",
    AWS_ACCESS_KEY_ID: "wire-access",
    AWS_SECRET_ACCESS_KEY: "wire-secret",
    NOMO_S3_ENABLED: "1",
    NOMO_S3_ENDPOINT: endpoint,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = await verifyS3Wire();
    console.log(JSON.stringify({ passed: true, ...result }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  }
}
