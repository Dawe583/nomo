import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { generateKeyPairSync } from "node:crypto";

import { devKeyProvider, keyProviderFromPkcs8, sha256Hex } from "../../ledger/src/sign.ts";
import { jsonlStore } from "../../ledger/src/store.ts";
import { entryHash } from "../../ledger/src/canonical.ts";
import { verifyLedgerFile } from "../../ledger/src/verify.ts";
import {
  PINNED_KEY_FILE_NAME,
  pinVerificationKey,
} from "../../ledger/src/verify-key.ts";

import { VoidClient, createVoidClient, CLIENT_MAX_ERROR_BYTES, CLIENT_MAX_ERROR_LINES } from "./client.ts";
import { legacyBindingRoot } from "../../proxy/src/legacy-root.ts";
import { HoldDeniedError, LedgerVerifyError, RefusedError } from "./errors.ts";
const fixtureServer = fileURLToPath(new URL("../../../fixtures/e2e-server.mjs", import.meta.url));
async function fixturePolicy(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "void-sdk-policy-"));
  const path = join(dir, "policy.yaml");
  await writeFile(path, [
    "version: 1",
    "rules:",
    "  - match:",
    "      tool: echo",
    "      class: unknown",
    "    decision: allow",
    "  - match:",
    "      tool: orders_delete",
    "    decision: hold",
    "    seconds: 5",
    "    notify: [cli]",
    "    rationale: destructive fixture tool requires approval",
    "  - match: {}",
    "    decision: deny",
    "    rationale: only SDK fixture tools are allowed",
    "",
  ].join("\n"));
  return path;
}

async function makeClient(workspace: string): Promise<VoidClient> {
  return new VoidClient({
    ledgerDir: await mkdtemp(join(tmpdir(), "void-sdk-ledger-")),
    workspace,
    policyPath: await fixturePolicy(),
    connect: { upstreamCommand: [process.execPath, fixtureServer] },
    requestTimeoutMs: 5_000,
  });
}

async function waitFor<T>(read: () => T | undefined, label: string): Promise<T> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const value = read();
    if (value !== undefined) return value;
    await delay(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function textFrom(result: unknown): string | undefined {
  const content = (result as { readonly content?: readonly { readonly text?: string }[] }).content;
  return content?.[0]?.text;
}

describe("VoidClient", () => {
  test("forwards a request and resolves the matching id", async () => {
    const client = await makeClient("forward");
    try {
      const result = await client.request("tools/call", { name: "echo", arguments: { text: "hello sdk" } });
      assert.equal(textFrom(result), "hello sdk");
    } finally {
      client.close();
    }
  });

  test("parks a hold and resolves awaitHold after approval", async () => {
    const client = await makeClient("approval");
    try {
      const call = client.request("tools/call", { name: "orders_delete", arguments: { where: "status = stale", rows: 2 } });
      const held = await waitFor(() => client.pendingHolds()[0], "pending hold");
      assert.equal(client.hold(held.holdId).decide({ kind: "approved", by: "tester" }), true);
      const heldResult = await client.awaitHold(held.holdId);
      assert.equal(textFrom(heldResult), "deleted 2");
      assert.equal(await call, heldResult);
    } finally {
      client.close();
    }
  });

  test("rejects awaitHold with HoldDeniedError after denial", async () => {
    const client = await makeClient("denial");
    try {
      const call = client.request("tools/call", { name: "orders_delete", arguments: { where: "status = stale", rows: 2 } });
      const held = await waitFor(() => client.pendingHolds()[0], "pending hold");
      assert.equal(client.hold(held.holdId).decide({ kind: "denied", by: "tester", reason: "fixture denial" }), true);
      await assert.rejects(client.awaitHold(held.holdId), (error: unknown) => {
        assert.ok(error instanceof HoldDeniedError);
        assert.equal(error.code, "VOID_HOLD_DENIED");
        assert.equal(error.holdId, held.holdId);
        return true;
      });
      await assert.rejects(call, HoldDeniedError);
    } finally {
      client.close();
    }
  });


  test("maps invalid policy startup to PolicyStartupError", async () => {
    const dir = await mkdtemp(join(tmpdir(), "void-sdk-invalid-policy-"));
    const policyPath = join(dir, "policy.yaml");
    await writeFile(policyPath, "version: 1\nrules: []\n");
    const client = new VoidClient({
      ledgerDir: await mkdtemp(join(tmpdir(), "void-sdk-ledger-")),
      workspace: "invalid-policy",
      policyPath,
      connect: { upstreamCommand: [process.execPath, fixtureServer] },
      requestTimeoutMs: 1_000,
    });
    try {
      await assert.rejects(client.request("tools/call", { name: "echo", arguments: { text: "never" } }), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, "PolicyStartupError");
        assert.equal((error as { readonly code?: string }).code, "VOID_POLICY_STARTUP");
        return true;
      });
    } finally {
      client.close();
    }
  });

  test("refuses startup when ledger verification fails", async () => {
    const ledgerDir = await mkdtemp(join(tmpdir(), "void-sdk-bad-ledger-"));
    await writeFile(join(ledgerDir, "bad.jsonl"), "not json\n");
    const client = new VoidClient({
      ledgerDir,
      workspace: "bad",
      policyPath: await fixturePolicy(),
      connect: { upstreamCommand: [process.execPath, fixtureServer] },
      requestTimeoutMs: 1_000,
    });
    try {
      await assert.rejects(client.request("tools/call", { name: "echo", arguments: { text: "never" } }), (error: unknown) => {
        assert.ok(error instanceof LedgerVerifyError);
        assert.equal(error.code, "VOID_LEDGER_VERIFY");
        return true;
      });
    } finally {
      client.close();
    }
  });
});

test("RefusedError maps connector drift refusal reports", () => {
  const error = RefusedError.fromReport({
    applied: [],
    refused: [{ stepId: "restore-1", reason: "drift", changed: [] }],
  });
  assert.ok(error instanceof RefusedError);
  assert.equal(error.code, "VOID_REFUSED");
  assert.equal(error.reason, "drift");
});


// A pinned public key, provisioned the way an operator does it, is what the
// startup check reads. These cases used to pass because the client derived the
// key from the private key file, which is the substitution a pin is what
// makes detectable, so the pin is what they are asserted against now.
for (const scenario of ["trusted", "rehashed", "foreign-key"] as const) {
  test(`startup authenticates existing ledger: ${scenario}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "void-sdk-signatures-"));
    const workspace = "signed";
    const path = join(dir, `${workspace}.jsonl`);
    const marker = join(dir, "upstream-started");
    const honest = await devKeyProvider({ dir: join(dir, "keys"), env: {} });
    const signer = scenario === "foreign-key"
      ? await devKeyProvider({ dir: join(dir, "foreign-keys"), env: {} })
      : honest;
    const spki = await honest.publicKey(await honest.currentKeyId());
    assert.ok(spki !== null);
    const trust = join(dir, "trust");
    await pinVerificationKey(spki, {
      file: join(trust, PINNED_KEY_FILE_NAME),
      anchoredFrom: "operator-spki",
    });
    await jsonlStore(signer, { dir }).append({ workspace, tool: "echo", decision: "deny" });
    if (scenario === "rehashed") {
      const entry = JSON.parse(await readFile(path, "utf8"));
      entry.body.decision = "allow";
      entry.hash = await entryHash(entry.body, entry.prev_hash, sha256Hex);
      await writeFile(path, `${JSON.stringify(entry)}\n`);
    }
    // A fresh hash chain also passes for forged content and an untrusted signer.
    assert.equal((await verifyLedgerFile(path)).ok, true);
    const client = new VoidClient({
      ledgerDir: dir, workspace, policyPath: await fixturePolicy(),
      env: { VOID_TRUST_DIR: trust },
      connect: { upstreamCommand: scenario === "trusted"
        ? [process.execPath, fixtureServer]
        : [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1], 'started')", marker] },
      requestTimeoutMs: 1_000,
    });
    try {
      const request = client.request("tools/call", { name: "echo", arguments: { text: "authenticated" } });
      if (scenario === "trusted") {
        assert.equal(textFrom(await request), "authenticated");
        // Whatever the source is named, what matters is that it came from the
        // pinned public key and is not degraded.
        assert.equal(client.verification?.degraded, false);
      } else {
        await assert.rejects(request, LedgerVerifyError);
        await assert.rejects(access(marker), { code: "ENOENT" });
      }
    } finally {
      client.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("an existing ledger with no pinned key is refused, not checked with the private key file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "void-sdk-unpinned-"));
  const workspace = "unpinned";
  const home = join(dir, "home");
  const signer = await devKeyProvider({ dir: join(home, ".void", "keys"), env: {} });
  await jsonlStore(signer, { dir }).append({ workspace, tool: "echo", decision: "deny" });
  const marker = join(dir, "upstream-started");
  const client = new VoidClient({
    ledgerDir: dir,
    workspace,
    policyPath: await fixturePolicy(),
    env: { HOME: home },
    connect: {
      upstreamCommand: [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1], 'started')", marker],
    },
    requestTimeoutMs: 1_000,
  });
  try {
    // The signing key sits right there at ~/.void/keys and would verify this
    // chain perfectly. Reading it is the defect: it would also verify a chain
    // an attacker re-signed after replacing that file, so the check is refused
    // and named instead.
    await assert.rejects(
      client.request("tools/call", { name: "echo", arguments: { text: "never" } }),
      (error: unknown) => {
        assert.ok(error instanceof LedgerVerifyError);
        assert.match(error.message, /no verification key is configured/);
        return true;
      },
    );
    await assert.rejects(access(marker), { code: "ENOENT" });
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a signing key named in the environment is a degraded answer, and says so", async () => {
  const dir = await mkdtemp(join(tmpdir(), "void-sdk-degraded-"));
  const workspace = "degraded";
  // Written straight from a generated pair and used only in this process; the
  // value never reaches a log or a fixture file.
  const { privateKey } = generateKeyPairSync("ed25519");
  const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  const signer = keyProviderFromPkcs8(Buffer.from(pkcs8, "base64"));
  await jsonlStore(signer, { dir }).append({ workspace, tool: "echo", decision: "deny" });
  const client = new VoidClient({
    ledgerDir: dir,
    workspace,
    policyPath: await fixturePolicy(),
    env: { VOID_SIGNING_KEY: pkcs8 },
    connect: { upstreamCommand: [process.execPath, fixtureServer] },
    requestTimeoutMs: 5_000,
  });
  try {
    assert.equal(textFrom(await client.request("tools/call", { name: "echo", arguments: { text: "ok" } })), "ok");
    assert.equal(client.verification?.degraded, true);
    assert.equal(client.verification?.source, "signing-key-env");
    assert.match(client.errors.join(" "), /DEGRADED/);
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/** A purpose-built upstream that speaks one bound tool, so the client can be
 * driven end to end without touching the shared e2e fixture. */
async function boundUpstream(dir: string): Promise<string> {
  const path = join(dir, "bound-upstream.mjs");
  await writeFile(path, `
import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-11-25", serverInfo: { name: "bound-fixture", version: "1.0.0" }, capabilities: { tools: {} } } });
    return;
  }
  if (request.method === "tools/list") {
    send({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "postgres.row.update", description: "Updates a row.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } }] } });
    return;
  }
  if (request.method === "tools/call") {
    send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "updated" }] } });
    return;
  }
  send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "no such method" } });
});
`, "utf8");
  return path;
}

async function boundPolicy(dir: string): Promise<string> {
  const path = join(dir, "bound-policy.yaml");
  await writeFile(path, [
    "version: 1",
    "rules:",
    "  - match:",
    "      tool: postgres.row.update",
    "      class: r3",
    "    decision: allow",
    "  - match: {}",
    "    decision: deny",
    "    rationale: only the bound fixture tool is allowed",
    "",
  ].join("\n"));
  return path;
}

test("a legacy binding supplied to the client is what the proxy uses", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "void-sdk-binding-"));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const captured: string[] = [];
  const binding = legacyBindingRoot("postgres.row.update", {
    workspace: "default",
    capture: async (call) => {
      captured.push(call.tool);
      const digest = `sha256:${await sha256Hex(JSON.stringify(call.arguments))}` as const;
      return {
        digest,
        reference: { namespace: "fixture", digest, uri: "pg://fixture/row-1" },
        capturedAt: new Date().toISOString(),
      };
    },
    manifest: { write: async () => undefined },
    ledger: { append: async () => ({}) },
    completed: () => true,
  });
  const client = createVoidClient({
    connect: { upstreamCommand: [process.execPath, await boundUpstream(dir)] },
    policyPath: await boundPolicy(dir),
    ledgerDir: join(dir, "ledger"),
    legacyBinding: binding,
  });
  t.after(() => client.close());

  await client.request("tools/call", { name: "postgres.row.update", arguments: { id: "row-1" } });
  assert.deepEqual(captured, ["postgres.row.update"], "the supplied binding must be the one that captured");

  // The same call with no binding still succeeds, and nothing is recorded for
  // it. That is the honest difference and the reason supplying a binding is not
  // optional decoration: the tool is available either way, but only one of them
  // leaves a capture, an outcome and an undo path behind.
  const bare = createVoidClient({
    connect: { upstreamCommand: [process.execPath, await boundUpstream(dir)] },
    policyPath: await boundPolicy(dir),
    ledgerDir: join(dir, "ledger-bare"),
  });
  t.after(() => bare.close());
  const bareResult = await bare.request("tools/call", { name: "postgres.row.update", arguments: { id: "row-1" } });
  assert.ok(bareResult, "an unbound call is still answered by the upstream");
  assert.deepEqual(captured, ["postgres.row.update"], "the bare call must not reach the binding");
});

test("an unknown binding name is refused at construction", () => {
  assert.throws(
    () => legacyBindingRoot("not.a.bound.tool", {
      workspace: "default",
      capture: async () => ({ digest: "sha256:x" as const, reference: { namespace: "f", digest: "sha256:x" as const, uri: "pg://f/1" }, capturedAt: new Date().toISOString() }),
      manifest: { write: async () => undefined },
      ledger: { append: async () => ({}) },
      completed: () => true,
    }),
    /unknown|not a bound|binding/i,
  );
});

/**
 * An upstream that answers normally and then floods stdout with malformed
 * JSON-RPC lines. Each one becomes a proxy stderr note, so this drives the
 * real retention path in the real client rather than a stubbed one.
 */
async function noisyUpstream(dir: string, noise: number): Promise<string> {
  const path = join(dir, "noisy-upstream.mjs");
  await writeFile(path, `
import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
let emitted = 0;
// Dripped rather than dumped: a flood written ahead of the answer fills the
// pipe and the reply never gets read, which tests the transport rather than
// the retention the client is responsible for.
const flood = setInterval(() => {
  for (let batch = 0; batch < 100 && emitted < ${noise}; batch += 1) {
    emitted += 1;
    process.stdout.write("this is not json-rpc at all " + emitted + "\\n");
  }
  if (emitted >= ${noise}) clearInterval(flood);
}, 1);
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-11-25", serverInfo: { name: "noisy-fixture", version: "1.0.0" }, capabilities: { tools: {} } } });
    return;
  }
  if (request.method === "tools/list") {
    send({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "echo", description: "Echo.", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] } });
    return;
  }
  if (request.method === "tools/call") {
    send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: request.params?.arguments?.text ?? "answered" }] } });
    return;
  }
  send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "no such method" } });
});
`, "utf8");
  return path;
}

test("error retention is bounded and reports what it dropped", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "void-sdk-error-cap-"));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const client = createVoidClient({
    connect: { upstreamCommand: [process.execPath, await noisyUpstream(dir, 4_000)] },
    policyPath: await fixturePolicy(),
    ledgerDir: join(dir, "ledger"),
    requestTimeoutMs: 30_000,
  });
  t.after(() => client.close());

  const result = await client.request("tools/call", { name: "echo", arguments: { text: "after the flood" } });
  assert.equal(textFrom(result), "after the flood");

  // The flood is concurrent with the answer, so the drops are awaited as a
  // condition rather than after a guessed delay.
  await waitFor(() => (client.errorsDropped > 0 ? true : undefined), "dropped error lines");
  const errors = client.errors;
  assert.ok(
    errors.length <= CLIENT_MAX_ERROR_LINES,
    `retained ${errors.length} error lines, ceiling is ${CLIENT_MAX_ERROR_LINES}`,
  );
  const bytes = errors.reduce((sum, line) => sum + Buffer.byteLength(line), 0);
  assert.ok(
    bytes <= CLIENT_MAX_ERROR_BYTES,
    `retained ${bytes} error bytes, ceiling is ${CLIENT_MAX_ERROR_BYTES}`,
  );
  // A silently truncated list reads as "there were no more errors", so the
  // drops have to be visible next to the lines that survived.
  assert.ok(client.errorsDropped > 0, "the dropped error count must be reported");
  assert.match(client.errors.join(" "), /malformed JSON-RPC/);
});
