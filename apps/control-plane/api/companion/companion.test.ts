import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { listenControlPlane, type ListenHandle } from "../server.ts";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { projectDiagnostics } from "./diagnostics.ts";
import { authenticateDevice, readScope, writeScope, type CompanionScope } from "./devices.ts";
import { recordOperation, revokeOperationId } from "./operations.ts";

type Paired = { readonly deviceId: string; readonly deviceToken: string; readonly expiresAt: string; readonly scopes: readonly string[] };
type Diagnostics = { readonly entries: readonly { id: string; status: string; summary?: string }[] };

const pathSentinel = "~/Library/VOID/sentinel-credential";
const tokenSentinel = "9f2c1ab4de705f36c8e1d4b27a5309fe6c1d8b45";

type Harness = {
  readonly origin: string;
  readonly dataDir: string;
  readonly registry: string;
  readonly close: () => Promise<void>;
};

async function startHarness(workspace = "alpha", dataDir?: string, extraEnv: Record<string, string> = {}): Promise<Harness> {
  const directory = dataDir ?? await mkdtemp(join(tmpdir(), "void-companion-"));
  // The write scope is an operator decision, so the harness that exercises it
  // opts in explicitly, the way a host operator would.
  const server: ListenHandle = await listenControlPlane({
    env: { VOID_DATA_DIR: directory, VOID_WORKSPACE: workspace, VOID_COMPANION_WRITE_PAIRING: "1", ...extraEnv },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    dataDir: directory,
    registry: join(directory, "companion", "devices.json"),
    close: async () => {
      await server.close();
      if (dataDir === undefined) await rm(directory, { recursive: true, force: true });
    },
  };
}

function pairRequest(harness: Harness, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${harness.origin}/api/companion/devices`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function pair(harness: Harness, scopes: readonly CompanionScope[] = [readScope], label = "Kitchen iPhone"): Promise<Paired> {
  const response = await pairRequest(harness, { label, scopes });
  assert.equal(response.status, 201);
  return await response.json() as Paired;
}

function authorized(harness: Harness, path: string, token: string): Promise<Response> {
  return fetch(`${harness.origin}${path}`, { headers: { authorization: `Bearer ${token}` } });
}

function revokeRequest(harness: Harness, deviceId: string, token?: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${harness.origin}/api/companion/devices/${deviceId}/revoke`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers, ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
    body: JSON.stringify({ deviceId }),
  });
}

test("pairing issues a one-time device credential and never stores or repeats the plaintext", async t => {
  const harness = await startHarness();
  t.after(() => harness.close());

  const first = await pair(harness);
  assert.deepEqual(Object.keys(first).sort(), ["deviceId", "deviceToken", "expiresAt", "scopes"]);
  assert.deepEqual(first.scopes, [readScope]);
  assert.match(first.deviceId, /^device-[A-Za-z0-9_-]{12}$/);
  assert.equal(first.deviceToken.length, 43);
  assert.equal(new Date(first.expiresAt).getTime() - Date.now() > 14 * 60 * 1000, true);

  const stored = await readFile(harness.registry, "utf8");
  assert.equal(stored.includes(first.deviceToken), false);
  const record = JSON.parse(stored) as { deviceId: string; workspaceId: string; label: string; tokenHash: string; scopes: string[]; createdAt: string; revokedAt: null }[];
  assert.deepEqual(Object.keys(record[0]!).sort(), ["createdAt", "deviceId", "label", "revokedAt", "scopes", "tokenHash", "workspaceId"]);
  assert.equal(record[0]!.workspaceId, "alpha");
  assert.match(record[0]!.tokenHash, /^[a-f0-9]{64}$/);

  const second = await pair(harness, [readScope], "Hallway iPad");
  assert.notEqual(second.deviceId, first.deviceId);
  assert.notEqual(second.deviceToken, first.deviceToken);
  const listed = await authorized(harness, "/api/companion/diagnostics", first.deviceToken);
  const text = await listed.text();
  assert.equal(text.includes(first.deviceToken), false);
  assert.equal(text.includes(second.deviceToken), false);
  assert.equal(await (await pairRequest(harness, { label: "third", scopes: [readScope] })).status, 201);
  assert.equal((await pairRequest(harness, { label: "x", scopes: ["companion:admin"] })).status, 400);
  assert.equal((await pairRequest(harness, { label: "x", unexpected: true })).status, 400);
});

test("a workspace holds at most the protocol's eight active devices", async t => {
  const harness = await startHarness();
  t.after(() => harness.close());
  for (let index = 0; index < 8; index += 1) await pair(harness, [readScope], `device-${index}`);
  const refused = await pairRequest(harness, { label: "ninth", scopes: [readScope] });
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { error: "device_limit" });
});

test("operation status, revocation, and diagnostics answer with the exact contract shapes", async t => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const owner = await pair(harness, [readScope, writeScope], "owner");
  const bystander = await pair(harness, [readScope], "Hallway iPad");

  const revoked = await revokeRequest(harness, owner.deviceId, owner.deviceToken);
  assert.equal(revoked.status, 200);
  const receipt = await revoked.json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(receipt).sort(), ["activeStreamsClosed", "deviceId", "newMutationsAllowed", "revokedAt"]);
  assert.equal(receipt.deviceId, owner.deviceId);
  assert.equal(receipt.newMutationsAllowed, false);
  assert.equal(receipt.activeStreamsClosed, true);
  assert.equal(Number.isFinite(Date.parse(String(receipt.revokedAt))), true);

  const foreign = await authorized(harness, `/api/companion/operations/${revokeOperationId(owner.deviceId)}`, bystander.deviceToken);
  assert.equal(foreign.status, 404);
  const host = await fetch(`${harness.origin}/api/companion/operations/${revokeOperationId(owner.deviceId)}`);
  assert.equal(host.status, 200);
  const hostBody = await host.json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(hostBody).sort(), ["operationId", "status"]);
  assert.equal(hostBody.operationId, revokeOperationId(owner.deviceId));
  assert.equal(hostBody.status, "succeeded");

  const diagnostics = await authorized(harness, "/api/companion/diagnostics", bystander.deviceToken);
  assert.equal(diagnostics.status, 200);
  assert.equal(diagnostics.headers.get("x-frame-options"), "DENY");
  assert.equal(diagnostics.headers.get("content-security-policy"), "frame-ancestors 'none'");
  const body = await diagnostics.json() as Diagnostics;
  assert.deepEqual(Object.keys(body), ["entries"]);
  for (const entry of body.entries) {
    assert.equal(Object.keys(entry).every(key => ["id", "status", "summary"].includes(key)), true);
    assert.equal(["ok", "pending", "failed"].includes(entry.status), true);
    assert.equal((entry.summary ?? "").length <= 320, true);
    assert.equal(entry.id.includes("/"), false);
  }
  assert.ok(body.entries.some(entry => entry.summary === "1 active, 1 revoked"), JSON.stringify(body.entries));
  assert.ok(body.entries.some(entry => entry.summary === "Hallway iPad — active read-only"), JSON.stringify(body.entries));
});

test("an unknown operation identity is a 404 and never a success", async t => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const device = await pair(harness);

  const unknown = await authorized(harness, "/api/companion/operations/op-never-dispatched-001", device.deviceToken);
  assert.equal(unknown.status, 404);
  const text = await unknown.text();
  assert.deepEqual(JSON.parse(text), { error: "operation_not_found" });
  assert.equal(text.includes("body"), false);
  assert.equal(text.includes("payload"), false);
  assert.equal(text.includes("op-never-dispatched-001"), false);
  assert.equal((await fetch(`${harness.origin}/api/companion/operations/op-never-dispatched-001`)).status, 404);
  assert.equal((await authorized(harness, "/api/companion/operations/op%20with%20spaces", device.deviceToken)).status, 400);
});

test("device authentication fails closed for missing, wrong, expired, and revoked credentials", async t => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const device = await pair(harness);
  const stranger = await pair(harness, [readScope], "stranger");
  const wrong = "not-a-device-token-but-long-enough-to-pass-the-shape-check";

  assert.equal((await fetch(`${harness.origin}/api/companion/diagnostics`)).status, 403);
  assert.equal((await authorized(harness, "/api/companion/diagnostics", wrong)).status, 403);
  assert.equal((await authorized(harness, "/api/companion/operations/op-any", wrong)).status, 403);
  assert.equal((await fetch(`${harness.origin}/api/companion/operations/op-any`, { headers: { authorization: "Bearer" } })).status, 403);
  assert.equal((await revokeRequest(harness, device.deviceId, wrong)).status, 403);

  const env = { VOID_DATA_DIR: harness.dataDir, VOID_WORKSPACE: "alpha" };
  assert.equal(authenticateDevice(env, device.deviceToken, Date.now() + 16 * 60 * 1000), null);
  assert.equal(authenticateDevice(env, device.deviceToken, Date.now())?.deviceId, device.deviceId);
  assert.equal(authenticateDevice(env, stranger.deviceToken, Date.now())?.deviceId, stranger.deviceId);

  assert.equal((await revokeRequest(harness, device.deviceId)).status, 200);
  assert.equal((await authorized(harness, "/api/companion/diagnostics", device.deviceToken)).status, 403);
  assert.equal((await authorized(harness, `/api/companion/operations/${revokeOperationId(device.deviceId)}`, device.deviceToken)).status, 403);
  assert.equal((await revokeRequest(harness, device.deviceId, device.deviceToken)).status, 403);
  assert.equal(authenticateDevice(env, device.deviceToken, Date.now()), null);
});

test("a read-only device cannot mutate and a device cannot revoke another device", async t => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const reader = await pair(harness, [readScope], "reader");
  const writer = await pair(harness, [readScope, writeScope], "writer");

  assert.equal((await revokeRequest(harness, reader.deviceId, reader.deviceToken)).status, 403);
  assert.equal((await revokeRequest(harness, writer.deviceId, reader.deviceToken)).status, 403);
  assert.equal((await revokeRequest(harness, reader.deviceId, writer.deviceToken)).status, 403);
  assert.equal((await authorized(harness, "/api/companion/diagnostics", reader.deviceToken)).status, 200);
  assert.equal((await authorized(harness, "/api/companion/diagnostics", writer.deviceToken)).status, 200);
  assert.equal((await pairRequest(harness, { label: "write only", scopes: [writeScope] })).status, 201);
  const writeOnly = await (await pairRequest(harness, { label: "write only two", scopes: [writeScope] })).json() as Paired;
  assert.deepEqual(writeOnly.scopes, [writeScope]);
  assert.equal((await authorized(harness, "/api/companion/diagnostics", writeOnly.deviceToken)).status, 403);
  assert.equal((await revokeRequest(harness, reader.deviceId)).status, 200);
});

test("revocation is idempotent and keeps the dispatched effect readable", async t => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const device = await pair(harness);
  const first = await revokeRequest(harness, device.deviceId);
  assert.equal(first.status, 200);
  const receipt = await first.text();
  const repeat = await revokeRequest(harness, device.deviceId);
  assert.equal(repeat.status, 200);
  assert.equal(await repeat.text(), receipt);
  const third = await revokeRequest(harness, device.deviceId);
  assert.equal(await third.text(), receipt);
  assert.equal((await revokeRequest(harness, "device-does-not-exist")).status, 404);

  const status = await fetch(`${harness.origin}/api/companion/operations/${revokeOperationId(device.deviceId)}`);
  assert.equal(status.status, 200);
  assert.equal(((await status.json()) as { status: string }).status, "succeeded");
});

test("a device of another workspace sees neither another workspace's data nor its credential", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "void-companion-tenant-"));
  const alpha = await startHarness("alpha", dataDir);
  const beta = await startHarness("beta", dataDir);
  t.after(async () => {
    await alpha.close();
    await beta.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const alphaDevice = await pair(alpha);
  const alphaWriter = await pair(alpha, [readScope, writeScope], "alpha writer");
  assert.equal((await revokeRequest(alpha, alphaWriter.deviceId, alphaWriter.deviceToken)).status, 200);
  const betaDevice = await pair(beta);

  assert.equal((await authorized(beta, "/api/companion/diagnostics", alphaDevice.deviceToken)).status, 403);
  assert.equal((await authorized(alpha, "/api/companion/diagnostics", betaDevice.deviceToken)).status, 403);
  assert.equal((await authorized(beta, `/api/companion/operations/${revokeOperationId(alphaWriter.deviceId)}`, betaDevice.deviceToken)).status, 404);
  assert.equal((await fetch(`${beta.origin}/api/companion/operations/${revokeOperationId(alphaWriter.deviceId)}`)).status, 404);
  assert.equal((await revokeRequest(beta, alphaDevice.deviceId)).status, 404);
  assert.equal((await authorized(alpha, "/api/companion/diagnostics", alphaDevice.deviceToken)).status, 200);
});

test("diagnostics never return a credential, a path, or an unbounded page", async t => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const labelled = await pair(harness, [readScope], pathSentinel);
  const opaque = await pair(harness, [readScope], tokenSentinel);

  const response = await authorized(harness, "/api/companion/diagnostics", labelled.deviceToken);
  const text = await response.text();
  for (const secret of [pathSentinel, tokenSentinel, labelled.deviceToken, opaque.deviceToken, harness.dataDir, homedir()]) {
    assert.equal(text.includes(secret), false, secret);
  }
  const body = JSON.parse(text) as Diagnostics;
  assert.equal(body.entries.length <= 100, true);
  assert.ok(body.entries.some(entry => entry.id === `device:${labelled.deviceId}` && entry.summary === "active read-only"), text);
  const opaqueText = await (await authorized(harness, "/api/companion/diagnostics", opaque.deviceToken)).text();
  assert.ok(opaqueText.includes(`"device:${opaque.deviceId}"`), opaqueText);
  assert.equal(opaqueText.includes(tokenSentinel), false, opaqueText);
  assert.equal(opaqueText.includes("read-only read-only"), false);
  assert.equal(text.includes("read-only read-only"), false);

  const many = projectDiagnostics(Array.from({ length: 101 }, (_, index) => ({ id: `probe-${index}`, status: "ok", summary: "x".repeat(1000) })));
  assert.equal(many.entries.length, 100);
  assert.equal(many.entries[99]!.summary?.length, 320);
  assert.deepEqual(projectDiagnostics([{ id: "a", status: "ok", secret: "nope" }, { id: "b", status: "broken" }, { id: "c" }]).entries, []);
  assert.deepEqual(projectDiagnostics([{ id: "a", status: "ok", summary: " keep " }]).entries, [{ id: "a", status: "ok", summary: "keep" }]);
  assert.deepEqual(projectDiagnostics([{ id: "a", status: "ok", summary: "line\nbreak null" }]).entries, [{ id: "a", status: "ok", summary: "line break null" }]);
});

test("companion routes stay behind the existing cross-site protections", async t => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const device = await pair(harness);
  const rebound = await new Promise<number | undefined>((resolve, reject) => {
    const probe = httpRequest(`${harness.origin}/api/companion/diagnostics`, { headers: { host: "attacker.example", authorization: `Bearer ${device.deviceToken}` } }, (result) => {
      result.resume();
      result.on("end", () => resolve(result.statusCode));
    });
    probe.on("error", reject);
    probe.end();
  });
  assert.equal(rebound, 403);

  const hostile: ReadonlyArray<Record<string, string>> = [
    { origin: "https://hostile.test" },
    { origin: "null" },
    { "sec-fetch-site": "cross-site" },
  ];
  for (const headers of hostile) {
    const label = JSON.stringify(headers);
    assert.equal((await fetch(`${harness.origin}/api/companion/diagnostics`, { headers: { ...headers, authorization: `Bearer ${device.deviceToken}` } })).status, 403, label);
    assert.equal((await pairRequest(harness, { label: "x" }, headers)).status, 403, label);
    assert.equal((await revokeRequest(harness, device.deviceId, undefined, headers)).status, 403, label);
    assert.equal((await fetch(`${harness.origin}/api/companion/operations/op-any`, { headers: { ...headers, authorization: `Bearer ${device.deviceToken}` } })).status, 403, label);
  }

  const allowed = await fetch(`${harness.origin}/api/companion/diagnostics`, { headers: { origin: harness.origin, "sec-fetch-site": "same-origin", authorization: `Bearer ${device.deviceToken}` } });
  assert.equal(allowed.status, 200);
  assert.equal((await fetch(`${harness.origin}/api/companion/unknown`, { headers: { authorization: `Bearer ${device.deviceToken}` } })).status, 404);
  assert.equal((await fetch(`${harness.origin}/api/companion/diagnostics`, { method: "POST", headers: { authorization: `Bearer ${device.deviceToken}` } })).status, 405);
  assert.equal((await fetch(`${harness.origin}/api/companion/devices`)).status, 405);
  const mismatched = await fetch(`${harness.origin}/api/companion/devices/${device.deviceId}/revoke`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${device.deviceToken}` },
    body: JSON.stringify({ deviceId: "device-other" }),
  });
  assert.equal(mismatched.status, 400);
});

test("operation status speaks the frozen void.companion.v1 outcome vocabulary", async t => {
  // The Apple `CompanionOutcome` enum and the allowlist in
  // `scripts/src/companion-fixtures.mjs` are the contract. A value outside that
  // set would be rejected by the frozen fixture validator, so the store has to
  // refuse it as corrupt rather than serve it.
  const accepted = ["running", "succeeded", "denied", "conflict", "unknown", "revoked", "expired"] as const;
  const rejected = ["failed", "pending", "ok", ""];
  for (const status of accepted) {
    const harness = await startHarness();
    try {
      const device = await pair(harness);
      await recordOperation({ VOID_DATA_DIR: harness.dataDir }, {
        operationId: "op-vocabulary",
        workspaceId: "alpha",
        deviceId: device.deviceId,
        operation: "device.revoke",
        status,
        updatedAt: new Date().toISOString(),
      });
      const response = await authorized(harness, "/api/companion/operations/op-vocabulary", device.deviceToken);
      assert.equal(response.status, 200, status);
      assert.deepEqual(await response.json(), { operationId: "op-vocabulary", status });
    } finally {
      await harness.close();
    }
  }
  for (const status of rejected) {
    const harness = await startHarness();
    t.diagnostic(`rejected status: ${JSON.stringify(status)}`);
    try {
      const device = await pair(harness);
      await recordOperation({ VOID_DATA_DIR: harness.dataDir }, {
        operationId: "op-vocabulary",
        workspaceId: "alpha",
        deviceId: device.deviceId,
        operation: "device.revoke",
        status: status as never,
        updatedAt: new Date().toISOString(),
      });
      const response = await authorized(harness, "/api/companion/operations/op-vocabulary", device.deviceToken);
      assert.notEqual(response.status, 200, `status ${JSON.stringify(status)} must never be served`);
    } finally {
      await harness.close();
    }
  }
});

// The predicates below are transcribed from the frozen validator in
// `scripts/src/companion-fixtures.mjs` (lines 36, 48, 237) so that a live
// response body is checked against the same rules that gate the shared
// fixtures, without coupling the API app to the scripts package.
// The frozen `text` and `boundedString` both call `String.isWellFormed`, which
// needs an es2024 lib; this project targets es2022, so the same property is
// proven by a UTF-8 round trip, because a lone surrogate does not survive one.
const wellFormed = (value: string): boolean => Buffer.from(value, "utf8").toString("utf8") === value;
const frozenText = (value: unknown, max = 160): boolean =>
  typeof value === "string" && wellFormed(value) && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f/]/.test(value);
const frozenBoundedString = (value: unknown, max = 320): boolean =>
  typeof value === "string" && wellFormed(value) && value.length > 0 && value.length <= max && !value.includes("\u0000");
const frozenTimestamp = (value: unknown): boolean =>
  typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
const keysWithin = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(value).every(key => allowed.includes(key));

test("live response bodies satisfy the frozen fixture field, bound, and allowlist rules", async t => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const device = await pair(harness, [readScope, writeScope], "Kitchen iPhone");

  // Pairing is not a frozen fixture operation, but the identity it mints and
  // the expiry it hands out are consumed by the same envelope rules.
  assert.equal(keysWithin(device as unknown as Record<string, unknown>, ["deviceId", "deviceToken", "expiresAt", "scopes"]), true);
  assert.equal(frozenText(device.deviceId), true);
  assert.equal(frozenTimestamp(device.expiresAt), true);
  assert.equal(typeof device.deviceToken === "string" && device.deviceToken.length > 0, true);

  const revoked = await revokeRequest(harness, device.deviceId, device.deviceToken);
  assert.equal(revoked.status, 200);
  const receipt = await revoked.json() as Record<string, unknown>;
  // validateDeviceRevokeResponse: exact four fields, identity, both constants.
  assert.deepEqual(Object.keys(receipt).sort(), ["activeStreamsClosed", "deviceId", "newMutationsAllowed", "revokedAt"]);
  assert.equal(receipt.deviceId, device.deviceId);
  assert.equal(receipt.newMutationsAllowed, false);
  assert.equal(receipt.activeStreamsClosed, true);
  assert.equal(frozenTimestamp(receipt.revokedAt), true);

  const status = await fetch(`${harness.origin}/api/companion/operations/${revokeOperationId(device.deviceId)}`);
  const statusBody = await status.json() as Record<string, unknown>;
  // validateStatusResponse: exact two fields and the outcome allowlist.
  assert.deepEqual(Object.keys(statusBody).sort(), ["operationId", "status"]);
  assert.equal(frozenText(statusBody.operationId), true);
  assert.equal(["running", "succeeded", "denied", "conflict", "unknown", "revoked", "expired"].includes(String(statusBody.status)), true);
  // A request body that disagrees with the path is covered by the dedicated
  // identity test below, because a browser client cannot send a body on GET.

  const reader = await pair(harness, [readScope], "Hallway iPad");
  const diagnostics = await authorized(harness, "/api/companion/diagnostics", reader.deviceToken);
  const body = await diagnostics.json() as Diagnostics;
  // validateDiagnosticsResponse: exact `entries`, the hundred cap, and the
  // per-entry allowlist with the 320 character summary bound.
  assert.deepEqual(Object.keys(body as unknown as Record<string, unknown>), ["entries"]);
  assert.equal(body.entries.length <= 100, true);
  for (const entry of body.entries) {
    const record = entry as unknown as Record<string, unknown>;
    assert.equal(keysWithin(record, ["id", "status", "summary"]), true);
    assert.equal(frozenText(record.id), true);
    assert.equal(["ok", "pending", "failed"].includes(entry.status), true);
    if (entry.summary !== undefined) assert.equal(frozenBoundedString(entry.summary), true);
  }

  // An emoji is two UTF-16 units, so a bound measured per appended unit can
  // overshoot the frozen 320 limit by one when the boundary is odd.
  for (const prefix of ["", "a"]) {
    const astral = projectDiagnostics([{ id: "probe", status: "ok", summary: prefix + "\u{1F600}".repeat(200) }]);
    assert.equal(frozenBoundedString(astral.entries[0]!.summary), true, `prefix ${JSON.stringify(prefix)}`);
    assert.equal((astral.entries[0]!.summary ?? "").length <= 320, true);
  }
  assert.equal(frozenBoundedString(projectDiagnostics([{ id: "probe", status: "ok", summary: "x".repeat(1000) }]).entries[0]!.summary), true);
});

test("minted identities and answers stay inside the Apple client acceptance rules", async t => {
  // `isBoundedID` and the accepted status window transcribed from
  // `apps/apple/CompanionProtocolKit/Sources/CompanionProtocolKit/CompanionHTTPClient.swift`.
  const isBoundedId = (value: string): boolean =>
    value.length > 0 && value.length <= 160 && !/[\u0000-\u001f\u007f/\\]/.test(value);
  const acceptedStatus = (status: number): boolean =>
    status === 200 || status === 201 || status === 202 || (status >= 400 && status < 500);
  const maxResponseBytes = 1_048_576;

  const harness = await startHarness();
  t.after(() => harness.close());
  const device = await pair(harness, [readScope, writeScope]);
  const env = { VOID_DATA_DIR: harness.dataDir, VOID_WORKSPACE: "alpha" };
  recordOperation(env, { operationId: "00123", workspaceId: "alpha", deviceId: device.deviceId, operation: "device.revoke", status: "succeeded", updatedAt: new Date().toISOString() });

  assert.equal(isBoundedId(device.deviceId), true);
  assert.equal(isBoundedId(revokeOperationId(device.deviceId)), true);
  assert.equal(isBoundedId("00123"), true);

  const statuses: number[] = [];
  const numeric = await authorized(harness, "/api/companion/operations/00123", device.deviceToken);
  statuses.push(numeric.status);
  assert.equal(numeric.status, 200);
  assert.equal(((await numeric.json()) as { operationId: string }).operationId, "00123");

  for (const response of [
    await pairRequest(harness, { label: "x", scopes: ["companion:admin"] }),
    await authorized(harness, "/api/companion/diagnostics", "wrong-token-value-that-is-long-enough"),
    await authorized(harness, "/api/companion/operations/op-missing", device.deviceToken),
    await fetch(`${harness.origin}/api/companion/diagnostics`, { method: "POST", headers: { authorization: `Bearer ${device.deviceToken}` } }),
    await fetch(`${harness.origin}/api/companion/devices`),
    await revokeRequest(harness, device.deviceId),
  ]) {
    statuses.push(response.status);
    assert.equal(response.headers.get("content-length") === null || Number(response.headers.get("content-length")) <= maxResponseBytes, true);
  }
  for (const status of statuses) assert.equal(acceptedStatus(status), true, `status ${status} is outside the client window`);

  const diagnostics = await authorized(harness, "/api/companion/diagnostics", device.deviceToken);
  const bytes = Buffer.byteLength(await diagnostics.text(), "utf8");
  assert.equal(bytes <= maxResponseBytes, true);
});

test("operation status refuses a request body that names a different operation", async t => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const device = await pair(harness, [readScope, writeScope]);
  recordOperation({ VOID_DATA_DIR: harness.dataDir, VOID_WORKSPACE: "alpha" }, {
    operationId: "op-bound-identity", workspaceId: "alpha", deviceId: device.deviceId, operation: "device.revoke", status: "succeeded", updatedAt: new Date().toISOString(),
  });
  // `fetch` refuses a body on GET and Node's HTTP client drops it, so the
  // frozen `operation.status` request shape is exercised over a raw socket.
  // The executor form is what this project needs: `Promise.withResolvers` is
  // es2024 and the workspace lib is es2022.
  const statusWith = (payload: string): Promise<number> => new Promise((resolve, reject) => {
    const { port, hostname } = new URL(harness.origin);
    const socket = connect(Number(port), hostname, () => socket.write([
      "GET /api/companion/operations/op-bound-identity HTTP/1.1",
      `Host: ${hostname}:${port}`,
      `Authorization: Bearer ${device.deviceToken}`,
      "Content-Type: application/json",
      `Content-Length: ${Buffer.byteLength(payload)}`,
      "Connection: close",
      "", payload,
    ].join("\r\n")));
    let raw = "";
    socket.on("data", (chunk) => { raw += chunk; });
    socket.on("close", () => resolve(Number(raw.split(" ")[1])));
    socket.on("error", reject);
  });
  assert.equal(await statusWith(JSON.stringify({ operationId: "op-bound-identity" })), 200);
  assert.equal(await statusWith(JSON.stringify({ operationId: "op-other" })), 400);
  assert.equal(await statusWith(JSON.stringify({ operationId: "op-bound-identity", extra: true })), 400);
  assert.equal(await statusWith("not json"), 400);
});

test("a caller cannot grant itself the write scope; the host operator decides", async t => {
  // No VOID_COMPANION_WRITE_PAIRING here: the default is read-only, so a
  // request for the write scope is refused rather than silently downgraded.
  const harness = await startHarness("alpha", undefined, { VOID_COMPANION_WRITE_PAIRING: "0" });
  t.after(() => harness.close());

  const refused = await pairRequest(harness, { label: "self-promoted", scopes: ["companion:read", "companion:write"] });
  assert.equal(refused.status, 400);
  assert.deepEqual(await refused.json(), { error: "invalid_pairing" });

  // The same request for read only is granted, so the refusal is about the
  // write scope and not about pairing.
  const granted = await pair(harness, [readScope], "ordinary device");
  assert.deepEqual(granted.scopes, [readScope]);

  // A read-only device still cannot mutate, which is the property the write
  // scope would otherwise have bought.
  const revoke = await revokeRequest(harness, granted.deviceId, granted.deviceToken);
  assert.equal(revoke.status, 403);
});
