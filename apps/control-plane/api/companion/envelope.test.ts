import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listenControlPlane, type ListenHandle } from "../server.ts";
import { canonicalJson } from "../../../../packages/ledger/src/canonical.ts";
import { readScope, writeScope, type CompanionScope } from "./devices.ts";
import { recordOperation, revokeOperationId } from "./operations.ts";

// The frozen fixture validator is the acceptance gate for this adapter, and it
// lives in the scripts package as ESM outside this app's TypeScript program, so
// it is loaded through `createRequire` rather than a static import `tsc` cannot
// resolve. The API app source never depends on it; only this contract test does.
const { validateCompanionFixture } = createRequire(import.meta.url)("../../../../scripts/src/companion-fixtures.mjs") as {
  validateCompanionFixture: (value: unknown) => Record<string, unknown>;
};

type Envelope = Record<string, unknown>;
type Paired = { readonly deviceId: string; readonly deviceToken: string; readonly expiresAt: string; readonly scopes: readonly string[] };

const implementation = { server: "pending", apple: "pending", transport: "pending", authority: "not-granted" } as const;

type Harness = { readonly origin: string; readonly dataDir: string; readonly close: () => Promise<void> };

async function startHarness(workspace = "alpha", extraEnv: Record<string, string> = {}): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), "void-envelope-"));
  // The write scope is an operator decision, so the harness that exercises it
  // opts in the way a host operator would.
  const server: ListenHandle = await listenControlPlane({
    env: { VOID_DATA_DIR: directory, VOID_WORKSPACE: workspace, VOID_COMPANION_WRITE_PAIRING: "1", ...extraEnv },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    dataDir: directory,
    close: async () => {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** The frozen digest is lowercase SHA-256 over the canonical body. The frozen
 * validator recomputes it the same way, so a fixture that passes here proves
 * the adapter hashed an identical preimage. */
function digestOf(body: unknown): string {
  return createHash("sha256").update(canonicalJson(body), "utf8").digest("hex");
}

function envelope(body: unknown, overrides: Envelope = {}): Envelope {
  const issuedAt = new Date(Date.now() - 1_000).toISOString();
  return {
    protocol: "void.companion.v1",
    schemaVersion: 1,
    kind: "request",
    requestId: "req-envelope-001",
    operationId: "op-envelope-001",
    operation: "diagnostics.read",
    deviceId: "device-unset",
    workspaceId: "alpha",
    issuedAt,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    bodyDigest: digestOf(body),
    body,
    ...overrides,
  };
}

function post(harness: Harness, request: Envelope | string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${harness.origin}/api/companion/envelope`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof request === "string" ? request : JSON.stringify(request),
  });
}

async function mint(harness: Harness): Promise<string> {
  const response = await fetch(`${harness.origin}/api/companion/invitations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 201);
  return (await response.json() as { invitation: string }).invitation;
}

async function pair(harness: Harness, scopes: readonly CompanionScope[] = [readScope], label = "Kitchen iPhone"): Promise<Paired> {
  const response = await fetch(`${harness.origin}/api/companion/devices`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ invitation: await mint(harness), label, scopes }),
  });
  assert.equal(response.status, 201);
  return await response.json() as Paired;
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/** A refusal must be one of the two refusal outcomes, on a status the frozen
 * outcome table allows for it, with an error that is never retryable and no
 * body a client could read as evidence. */
function assertRefusal(response: Envelope, expected: { readonly httpStatus: number; readonly outcome: string }): void {
  assert.equal(response.protocol, "void.companion.v1", JSON.stringify(response));
  assert.equal(response.schemaVersion, 1);
  assert.equal(response.kind, "response");
  assert.equal(response.httpStatus, expected.httpStatus, JSON.stringify(response));
  assert.equal(response.outcome, expected.outcome, JSON.stringify(response));
  assert.equal(response.body, undefined, JSON.stringify(response));
  const error = response.error as { code: string; message: string; retryable: boolean };
  assert.equal(typeof error.code === "string" && error.code.length > 0, true);
  assert.equal(error.retryable, false);
  assert.ok(error.message.length <= 320, error.message);
}

function fixtureOf(name: string, sourceRoutes: readonly string[], request: Envelope, response: Envelope): Record<string, unknown> {
  return validateCompanionFixture({
    fixture: `void.companion.v1.${name}`,
    protocol: "void.companion.v1",
    schemaVersion: 1,
    implementation: { ...implementation },
    sourceRoutes: [...sourceRoutes],
    request,
    response,
  });
}

function record(harness: Harness, operationId: string, deviceId: string, status: string): void {
  recordOperation({ VOID_DATA_DIR: harness.dataDir, VOID_WORKSPACE: "alpha" }, {
    operationId,
    workspaceId: "alpha",
    deviceId,
    operation: "device.revoke",
    status: status as never,
    updatedAt: new Date().toISOString(),
  });
}

test("a live envelope round trip is a frozen fixture for every bound operation", async t => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const device = await pair(harness, [readScope, writeScope]);
  const revokeId = revokeOperationId(device.deviceId);
  record(harness, "op-retained-001", device.deviceId, "succeeded");

  const handshakeBody = {
    client: { name: "VOID Apple companion", version: "0.0.0-fixture", platform: "ios" },
    requestedCapabilities: ["capability.handshake", "operation.status", "device.revoke", "diagnostics.read"],
  };
  const cases: ReadonlyArray<{ readonly name: string; readonly routes: readonly string[]; readonly request: Envelope; readonly response: Envelope }> = [
    {
      name: "envelope.capability-handshake",
      routes: ["GET /api/capabilities"],
      request: envelope(handshakeBody, { operation: "capability.handshake", deviceId: device.deviceId }),
      response: await (await post(harness, envelope(handshakeBody, { operation: "capability.handshake", deviceId: device.deviceId }), bearer(device.deviceToken))).json() as Envelope,
    },
    {
      name: "envelope.operation-status",
      routes: ["GET /api/companion/operations/:operationId"],
      request: envelope({ operationId: "op-retained-001" }, { operation: "operation.status", operationId: "op-retained-001", deviceId: device.deviceId }),
      response: await (await post(harness, envelope({ operationId: "op-retained-001" }, { operation: "operation.status", operationId: "op-retained-001", deviceId: device.deviceId }), bearer(device.deviceToken))).json() as Envelope,
    },
    {
      name: "envelope.diagnostics-read",
      routes: ["GET /api/companion/diagnostics"],
      request: envelope({}, { deviceId: device.deviceId }),
      response: await (await post(harness, envelope({}, { deviceId: device.deviceId }), bearer(device.deviceToken))).json() as Envelope,
    },
    {
      name: "envelope.device-revoke",
      routes: ["POST /api/companion/devices/:deviceId/revoke"],
      request: envelope({ deviceId: device.deviceId }, { operation: "device.revoke", operationId: "op-revoke-001", idempotencyKey: "idem-revoke-001", deviceId: device.deviceId }),
      response: await (await post(harness, envelope({ deviceId: device.deviceId }, { operation: "device.revoke", operationId: "op-revoke-001", idempotencyKey: "idem-revoke-001", deviceId: device.deviceId }), bearer(device.deviceToken))).json() as Envelope,
    },
  ];

  for (const item of cases) {
    assert.equal(item.response.outcome, "succeeded", `${item.name} ${JSON.stringify(item.response)}`);
    assert.equal(item.response.protocol, "void.companion.v1", item.name);
    assert.equal(item.response.requestId, item.request.requestId, item.name);
    assert.equal(item.response.operationId, item.request.operationId, item.name);
    assert.equal(item.response.operation, item.request.operation, item.name);
    assert.equal(item.response.deviceId, item.request.deviceId, item.name);
    assert.equal(item.response.workspaceId, item.request.workspaceId, item.name);
    assert.equal((item.response.body as Envelope).body === undefined, true, item.name);
    fixtureOf(item.name, item.routes, item.request, item.response);
  }
  assert.deepEqual(cases.map(item => item.response.httpStatus), [200, 200, 200, 200]);
});

test("a refused envelope is still a frozen fixture, and never a success", async t => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const reader = await pair(harness, [readScope], "Hallway iPad");
  const other = await pair(harness, [readScope], "Kitchen iPhone");

  // A device without the operation's scope, a wrong workspace claim, and a
  // missing credential all keep a well-formed request, so the refusal itself
  // has to satisfy the frozen contract too.
  const withoutScope = envelope({ deviceId: reader.deviceId }, { operation: "device.revoke", idempotencyKey: "idem-scope-001", deviceId: reader.deviceId });
  const scopeResponse = await (await post(harness, withoutScope, bearer(reader.deviceToken))).json() as Envelope;
  assertRefusal(scopeResponse, { httpStatus: 403, outcome: "denied" });
  assert.equal((scopeResponse.error as { code: string }).code, "authorization_denied");
  fixtureOf("envelope.revoked-by-scope", ["POST /api/companion/devices/:deviceId/revoke"], withoutScope, scopeResponse);

  const wrongWorkspace = envelope({}, { deviceId: other.deviceId, workspaceId: "beta" });
  const workspaceResponse = await (await post(harness, wrongWorkspace, bearer(reader.deviceToken))).json() as Envelope;
  assertRefusal(workspaceResponse, { httpStatus: 403, outcome: "denied" });
  assert.equal((workspaceResponse.error as { code: string }).code, "authorization_denied");
  fixtureOf("envelope.workspace-mismatch", ["GET /api/companion/diagnostics"], wrongWorkspace, workspaceResponse);

  const anonymous = envelope({}, { deviceId: reader.deviceId });
  const anonymousResponse = await (await post(harness, anonymous)).json() as Envelope;
  assertRefusal(anonymousResponse, { httpStatus: 403, outcome: "denied" });
  assert.equal((anonymousResponse.error as { code: string }).code, "authentication_required");
  fixtureOf("envelope.missing-credential", ["GET /api/companion/diagnostics"], anonymous, anonymousResponse);

  // A body that no longer matches the digest it was sealed with is refused, and
  // the refusal still echoes the identity the request itself claimed: it is the
  // caller's own value, so it discloses nothing, and it lets a client match the
  // envelope to what it sent without the echo ever granting the claim.
  const tampered = envelope({}, { deviceId: reader.deviceId, bodyDigest: "0".repeat(64) });
  const tamperedResponse = await (await post(harness, tampered, bearer(reader.deviceToken))).json() as Envelope;
  assertRefusal(tamperedResponse, { httpStatus: 403, outcome: "denied" });
  assert.equal(tamperedResponse.deviceId, tampered.deviceId);
  assert.equal(tamperedResponse.workspaceId, tampered.workspaceId);

  const unknown = envelope({}, { operation: "session.unknown", deviceId: reader.deviceId });
  assertRefusal(await (await post(harness, unknown, bearer(reader.deviceToken))).json() as Envelope, { httpStatus: 403, outcome: "denied" });

  const shaped = envelope({ limit: 5 }, { deviceId: reader.deviceId });
  assertRefusal(await (await post(harness, shaped, bearer(reader.deviceToken))).json() as Envelope, { httpStatus: 403, outcome: "denied" });

  const unparsed = await post(harness, "not json", bearer(reader.deviceToken));
  const unparsedResponse = await unparsed.json() as Envelope;
  assertRefusal(unparsedResponse, { httpStatus: 403, outcome: "denied" });
  assert.equal(unparsedResponse.requestId, "unattributed");

  const oversized = envelope({}, { deviceId: reader.deviceId, body: { prompt: "x".repeat(70_000) } });
  assertRefusal(await (await post(harness, oversized, bearer(reader.deviceToken))).json() as Envelope, { httpStatus: 403, outcome: "denied" });

  const wrongVersion = envelope({}, { protocol: "void.companion.v2", deviceId: reader.deviceId });
  const versionResponse = await (await post(harness, wrongVersion, bearer(reader.deviceToken))).json() as Envelope;
  assertRefusal(versionResponse, { httpStatus: 426, outcome: "unsupported_version" });
  assert.deepEqual((versionResponse.error as { supportedVersions: string[] }).supportedVersions, ["void.companion.v1"]);

  // Every refusal above is an envelope, never a 404 or a bare error object.
  assert.equal((reader.deviceToken.length), 43);
});

test("an operation identity the server cannot prove is refused and never becomes an unknown success", async t => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const device = await pair(harness, [readScope, writeScope]);

  for (const status of ["running", "succeeded", "denied", "conflict", "unknown", "revoked", "expired"] as const) {
    t.diagnostic(`recorded status: ${status}`);
    record(harness, "op-vocabulary", device.deviceId, status);
    const request = envelope({ operationId: "op-vocabulary" }, { operation: "operation.status", operationId: "op-vocabulary", deviceId: device.deviceId });
    const response = await (await post(harness, request, bearer(device.deviceToken))).json() as Envelope;
    const body = response.body as Envelope | undefined;
    assert.deepEqual(body, { operationId: "op-vocabulary", status: status === "revoked" ? "denied" : status }, status);
    fixtureOf(`envelope.operation-status.${status}`, ["GET /api/companion/operations/:operationId"], request, response);
  }

  const missing = envelope({ operationId: "op-never-dispatched" }, { operation: "operation.status", operationId: "op-never-dispatched", deviceId: device.deviceId });
  const response = await (await post(harness, missing, bearer(device.deviceToken))).json() as Envelope;
  assert.equal(response.outcome, "denied", JSON.stringify(response));
  assert.notEqual(response.outcome, "unknown");
  assert.notEqual(response.httpStatus, 202);
  assert.deepEqual(response.body, { operationId: "op-never-dispatched", status: "denied" });
  assert.equal((response.error as { code: string }).code, "operation_unknown");
  fixtureOf("envelope.operation-status.missing", ["GET /api/companion/operations/:operationId"], missing, response);

  // A body that names a different operation than the envelope is refused rather
  // than resolved in favour of either side.
  const mismatched = envelope({ operationId: "op-other" }, { operation: "operation.status", operationId: "op-vocabulary", deviceId: device.deviceId });
  assertRefusal(await (await post(harness, mismatched, bearer(device.deviceToken))).json() as Envelope, { httpStatus: 403, outcome: "denied" });
});

test("pairing needs no device identity, mints one credential, and then proves it", async t => {
  const harness = await startHarness();
  t.after(() => harness.close());

  // An unpaired device holds no device and no workspace: the request carries
  // neither, and the server derives both.
  const request = envelope({ invitation: await mint(harness), label: "Kitchen iPhone", scopes: [readScope] }, {
    operation: "device.pair",
    operationId: "op-pair-001",
    idempotencyKey: "idem-pair-001",
    deviceId: undefined,
    workspaceId: undefined,
  });
  delete request.deviceId;
  delete request.workspaceId;
  const response = await (await post(harness, request)).json() as Envelope;
  assert.equal(response.outcome, "succeeded", JSON.stringify(response));
  assert.equal(response.httpStatus, 201);
  assert.equal(response.protocol, "void.companion.v1");
  assert.equal(response.requestId, request.requestId);
  assert.equal(response.operation, "device.pair");
  const body = response.body as Envelope;
  assert.deepEqual(Object.keys(body).sort(), ["deviceId", "deviceToken", "expiresAt", "scopes"]);
  assert.equal(response.deviceId, body.deviceId);
  assert.equal(response.workspaceId, "alpha");
  assert.match(String(body.deviceId), /^device-[A-Za-z0-9_-]{12}$/);
  assert.equal((body.deviceToken as string).length, 43);
  assert.equal(Number.isFinite(Date.parse(String(body.expiresAt))), true);

  // The credential the pairing minted is the one the next envelope call proves.
  const read = envelope({}, { deviceId: String(body.deviceId) });
  const readResponse = await (await post(harness, read, bearer(String(body.deviceToken)))).json() as Envelope;
  assert.equal(readResponse.outcome, "succeeded", JSON.stringify(readResponse));
  assert.equal(readResponse.deviceId, body.deviceId);

  // Pairing is the operation that issues authority, so it carries a stable
  // idempotency key and never accepts a device or workspace claim.
  const withoutKey = envelope({ invitation: await mint(harness), label: "x" }, { operation: "device.pair", operationId: "op-pair-002" });
  delete withoutKey.deviceId;
  delete withoutKey.workspaceId;
  assertRefusal(await (await post(harness, withoutKey)).json() as Envelope, { httpStatus: 403, outcome: "denied" });

  const claiming = envelope({ invitation: await mint(harness), label: "x" }, { operation: "device.pair", operationId: "op-pair-003", idempotencyKey: "idem-pair-003", deviceId: "device-already" });
  delete claiming.workspaceId;
  assertRefusal(await (await post(harness, claiming)).json() as Envelope, { httpStatus: 403, outcome: "denied" });

  const unknownScope = envelope({ invitation: await mint(harness), label: "x", scopes: ["companion:admin"] }, { operation: "device.pair", operationId: "op-pair-004", idempotencyKey: "idem-pair-004" });
  delete unknownScope.deviceId;
  delete unknownScope.workspaceId;
  assertRefusal(await (await post(harness, unknownScope)).json() as Envelope, { httpStatus: 403, outcome: "denied" });

  // A pairing with no invitation is refused before it can mint anything. The
  // host authority to create a device is not derivable from the request body.
  const uninvited = envelope({ label: "no invitation" }, { operation: "device.pair", operationId: "op-pair-006", idempotencyKey: "idem-pair-006" });
  delete uninvited.deviceId;
  delete uninvited.workspaceId;
  assertRefusal(await (await post(harness, uninvited)).json() as Envelope, { httpStatus: 403, outcome: "denied" });

  // A workspace holds at most the protocol's eight active devices, and the
  // ninth pairing is a conflict rather than a success without a receipt.
  for (let index = 0; index < 7; index += 1) await pair(harness, [readScope], `device-${index}`);
  const ninth = envelope({ invitation: await mint(harness), label: "ninth" }, { operation: "device.pair", operationId: "op-pair-005", idempotencyKey: "idem-pair-005" });
  delete ninth.deviceId;
  delete ninth.workspaceId;
  const limit = await (await post(harness, ninth)).json() as Envelope;
  assertRefusal(limit, { httpStatus: 409, outcome: "conflict" });
  assert.equal((limit.error as { code: string }).code, "device_limit");
});

test("the envelope route stays behind the existing cross-site protections", async t => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const device = await pair(harness, [readScope]);
  const request = envelope({}, { deviceId: device.deviceId });

  const hostile: ReadonlyArray<Record<string, string>> = [
    { origin: "https://hostile.test" },
    { origin: "null" },
    { "sec-fetch-site": "cross-site" },
  ];
  for (const headers of hostile) {
    const label = JSON.stringify(headers);
    const blocked = await post(harness, request, { ...headers, ...bearer(device.deviceToken) });
    assert.equal(blocked.status, 403, label);
    const text = await blocked.text();
    assert.deepEqual(JSON.parse(text), { error: "local_origin_required" }, label);
    assert.equal(text.includes("void.companion.v1"), false, label);
    assert.equal(text.includes(device.deviceId), false, label);
  }

  const allowed = await post(harness, request, { origin: harness.origin, "sec-fetch-site": "same-origin", ...bearer(device.deviceToken) });
  assert.equal(allowed.status, 200);
  assert.equal(((await allowed.json()) as Envelope).outcome, "succeeded");
  assert.equal(allowed.headers.get("x-frame-options"), "DENY");
  assert.equal(allowed.headers.get("content-security-policy"), "frame-ancestors 'none'");

  const wrongMethod = await fetch(`${harness.origin}/api/companion/envelope`, { headers: bearer(device.deviceToken) });
  assertRefusal(await wrongMethod.json() as Envelope, { httpStatus: 403, outcome: "denied" });

  const wrongType = await fetch(`${harness.origin}/api/companion/envelope`, {
    method: "POST",
    headers: { "content-type": "text/plain", ...bearer(device.deviceToken) },
    body: JSON.stringify(request),
  });
  assertRefusal(await wrongType.json() as Envelope, { httpStatus: 403, outcome: "denied" });
});

test("every bound operation answers with the body its internal path returns", async t => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const device = await pair(harness, [readScope, writeScope]);
  record(harness, "op-bound-001", device.deviceId, "running");

  const internalStatus = await (await fetch(`${harness.origin}/api/companion/operations/op-bound-001`, { headers: bearer(device.deviceToken) })).json();
  const boundStatus = await (await post(harness, envelope({ operationId: "op-bound-001" }, { operation: "operation.status", operationId: "op-bound-001", deviceId: device.deviceId }), bearer(device.deviceToken))).json() as Envelope;
  assert.deepEqual(boundStatus.body, internalStatus);

  const internalDiagnostics = await (await fetch(`${harness.origin}/api/companion/diagnostics`, { headers: bearer(device.deviceToken) })).json();
  const boundDiagnostics = await (await post(harness, envelope({}, { deviceId: device.deviceId }), bearer(device.deviceToken))).json() as Envelope;
  assert.deepEqual(boundDiagnostics.body, internalDiagnostics);

  const internalRevoke = await (await fetch(`${harness.origin}/api/companion/devices/${device.deviceId}/revoke`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(device.deviceToken) },
    body: JSON.stringify({ deviceId: device.deviceId }),
  })).json() as Envelope;
  const second = await pair(harness, [readScope, writeScope], "second");
  const boundRevoke = await (await post(harness, envelope({ deviceId: second.deviceId }, { operation: "device.revoke", operationId: "op-revoke-002", idempotencyKey: "idem-revoke-002", deviceId: second.deviceId }), bearer(second.deviceToken))).json() as Envelope;
  assert.deepEqual(Object.keys(boundRevoke.body as Envelope).sort(), Object.keys(internalRevoke).sort());
  assert.equal((boundRevoke.body as Envelope).deviceId, second.deviceId);
  assert.equal((boundRevoke.body as Envelope).newMutationsAllowed, false);
  assert.equal((boundRevoke.body as Envelope).activeStreamsClosed, true);

  // A revoked credential stops the next envelope call, and the dispatched
  // effect stays readable by the host.
  const afterRevoke = await (await post(harness, envelope({}, { deviceId: second.deviceId }), bearer(second.deviceToken))).json() as Envelope;
  assertRefusal(afterRevoke, { httpStatus: 403, outcome: "denied" });
  assert.equal((afterRevoke.error as { code: string }).code, "authentication_required");
  const retained = await (await fetch(`${harness.origin}/api/companion/operations/${revokeOperationId(second.deviceId)}`)).json() as Envelope;
  assert.deepEqual(retained, { operationId: revokeOperationId(second.deviceId), status: "succeeded" });
});

test("operation status stays inside the device that owns the record", async t => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const owner = await pair(harness, [readScope, writeScope], "owner");
  const sibling = await pair(harness, [readScope], "Hallway iPad");
  record(harness, "op-owned-by-owner", owner.deviceId, "succeeded");

  // The owner's own record is readable.
  const mine = await post(
    harness,
    envelope({ operationId: "op-owned-by-owner" }, {
      operation: "operation.status",
      operationId: "op-owned-by-owner",
      deviceId: owner.deviceId,
      workspaceId: "alpha",
    }),
    bearer(owner.deviceToken),
  );
  assert.equal(mine.status, 200, "the owning device must read its own operation");
  const mineBody = await mine.json() as Envelope;
  assert.equal(mineBody.outcome, "succeeded");
  assert.equal((mineBody.body as { status?: string } | undefined)?.status, "succeeded");

  // A sibling device in the same workspace, with a perfectly valid credential,
  // must get the same refusal as an identifier that does not exist. Without the
  // per-device check the bound path answered from the workspace alone and leaked
  // a sibling's record.
  const theirs = await post(
    harness,
    envelope({ operationId: "op-owned-by-owner" }, {
      operation: "operation.status",
      operationId: "op-owned-by-owner",
      deviceId: sibling.deviceId,
      workspaceId: "alpha",
    }),
    bearer(sibling.deviceToken),
  );
  // Exactly the shape a never-dispatched identifier gets, so a sibling's
  // record is indistinguishable from one that does not exist.
  const refusedBody = await theirs.json() as Envelope;
  assert.equal(refusedBody.outcome, "denied", JSON.stringify(refusedBody));
  assert.equal(refusedBody.httpStatus, 403);
  assert.deepEqual(refusedBody.body, { operationId: "op-owned-by-owner", status: "denied" });
  assert.equal((refusedBody.error as { code: string }).code, "operation_unknown");

  // The internal route already refused this, and both must keep agreeing.
  const internal = await fetch(
    `${harness.origin}/api/companion/operations/op-owned-by-owner`,
    { headers: bearer(sibling.deviceToken) },
  );
  assert.equal(internal.status, 404);
});

test("a replayed pairing does not mint a second device and never replays the credential", async t => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const pairing = envelope({ invitation: await mint(harness), label: "Kitchen iPhone", scopes: [readScope] }, {
    operation: "device.pair",
    operationId: "op-pair-idem",
    idempotencyKey: "idem-pair-1",
    deviceId: undefined,
    workspaceId: undefined,
  });
  delete pairing.deviceId;
  delete pairing.workspaceId;

  const first = await (await post(harness, pairing)).json() as Envelope;
  assert.equal(first.outcome, "succeeded", JSON.stringify(first));
  const firstBody = first.body as { deviceId: string; deviceToken: string };
  assert.match(firstBody.deviceToken, /^[A-Za-z0-9_-]{43}$/);

  // A captured envelope replayed inside the window is refused rather than
  // minting device #2, and the one-time credential is never handed out twice.
  const replay = await (await post(harness, pairing)).json() as Envelope;
  assert.equal(replay.outcome, "conflict", JSON.stringify(replay));
  assert.equal(replay.httpStatus, 409);
  assert.equal((replay.error as { code: string }).code, "idempotency_key_reused");
  assert.equal(
    JSON.stringify(replay).includes(firstBody.deviceToken),
    false,
    "a refused replay must not echo the credential it already issued",
  );

  // The workspace has exactly one device from that key, and a fresh key still
  // works, so the refusal is about the replay and not about pairing at all.
  const registry = await readFile(join(harness.dataDir, "companion", "devices.json"), "utf8");
  assert.equal(registry.match(/"deviceId"/g)?.length, 1, `a replayed pairing minted a second device: ${registry}`);
  const freshRequest = envelope({ invitation: await mint(harness), label: "Hallway iPad", scopes: [readScope] }, {
    operation: "device.pair",
    operationId: "op-pair-fresh",
    idempotencyKey: "idem-pair-2",
    deviceId: undefined,
    workspaceId: undefined,
  });
  delete freshRequest.deviceId;
  delete freshRequest.workspaceId;
  const fresh = await (await post(harness, freshRequest)).json() as Envelope;
  assert.equal(fresh.outcome, "succeeded", JSON.stringify(fresh));

  // The same envelope body under a different idempotency key is a different
  // replay, and the invitation is what stops it: the host has one authority to
  // create this device and it has already been spent.
  const replayedBody = envelope({ invitation: (pairing.body as { invitation: string }).invitation, label: "Kitchen iPhone", scopes: [readScope] }, {
    operation: "device.pair",
    operationId: "op-pair-second-key",
    idempotencyKey: "idem-pair-3",
    deviceId: undefined,
    workspaceId: undefined,
  });
  delete replayedBody.deviceId;
  delete replayedBody.workspaceId;
  const second = await (await post(harness, replayedBody)).json() as Envelope;
  assertRefusal(second, { httpStatus: 403, outcome: "denied" });
  assert.equal((second.error as { code: string }).code, "used_invitation");
  assert.equal(
    JSON.stringify(second).includes(firstBody.deviceToken),
    false,
    "a refused duplicate acceptance must not echo the credential it already issued",
  );
  assert.equal((await readFile(join(harness.dataDir, "companion", "devices.json"), "utf8")).match(/"deviceId"/g)?.length, 2);
  assert.notEqual((fresh.body as { deviceId: string }).deviceId, firstBody.deviceId);
});

test("a mutation idempotency key reused for a different body is a conflict", async t => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const device = await pair(harness, [readScope, writeScope], "owner");
  const revoke = envelope({ deviceId: device.deviceId }, {
    operation: "device.revoke",
    operationId: "op-revoke-idem",
    deviceId: device.deviceId,
    idempotencyKey: "idem-revoke-1",
  });
  const first = await (await post(harness, revoke, bearer(device.deviceToken))).json() as Envelope;
  assert.equal(first.outcome, "succeeded", JSON.stringify(first));

  // A revoked device cannot replay anything at all: the credential is dead
  // before the idempotency store is even consulted. That is a stronger property
  // than replaying the first receipt, so it is what the test asserts.
  const replay = await (await post(harness, revoke, bearer(device.deviceToken))).json() as Envelope;
  assert.equal(replay.outcome, "denied", JSON.stringify(replay));
  assert.equal(replay.httpStatus, 403);
  assert.equal((replay.error as { code: string }).code, "authentication_required");

  // A different body under the same key never resolves to the first request.
  const owner = await pair(harness, [readScope, writeScope], "second owner");
  const reused = await (await post(harness, envelope({ deviceId: owner.deviceId }, {
    operation: "device.revoke",
    operationId: "op-revoke-idem-2",
    deviceId: owner.deviceId,
    idempotencyKey: "idem-revoke-1",
  }), bearer(owner.deviceToken))).json() as Envelope;
  assert.equal(reused.outcome, "conflict", JSON.stringify(reused));
  assert.equal(reused.httpStatus, 409);
  assert.equal((reused.error as { code: string }).code, "idempotency_key_reused");
});
