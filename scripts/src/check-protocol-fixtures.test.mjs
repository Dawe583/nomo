import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "../../packages/ledger/src/canonical.ts";

const fixtureRoot = join(
  import.meta.dirname,
  "..",
  "..",
  "apps",
  "apple",
  "Fixtures",
  "Protocol",
);
const outcomes = new Set([
  "succeeded",
  "denied",
  "conflict",
  "unknown",
  "running",
  "unsupported_version",
  "revoked",
  "invalid",
  "expired",
  "rate_limited",
]);

test("protocol fixtures preserve envelope identity and canonical body digests", async () => {
  const names = (await readdir(fixtureRoot))
    .filter((name) => name.endsWith(".json"))
    .sort();
  assert.ok(names.length >= 7, "protocol fixture set is incomplete");
  for (const name of names) {
    const fixture = JSON.parse(await readFile(join(fixtureRoot, name), "utf8"));
    assert.equal(fixture.protocol, "void.companion.v1", name);
    assert.equal(fixture.schemaVersion, 1, name);
    assert.equal(fixture.implementation?.server, "pending", name);
    assert.equal(fixture.implementation?.apple, "pending", name);
    assert.equal(fixture.implementation?.authority, "not-granted", name);
    const request = fixture.request;
    assert.equal(typeof request.requestId, "string", name);
    assert.equal(typeof request.operationId, "string", name);
    assert.equal(
      createHash("sha256").update(canonicalJson(request.body)).digest("hex"),
      request.bodyDigest,
      name,
    );
    const response = fixture.response;
    assert.equal(response.requestId, request.requestId, name);
    assert.equal(response.operationId, request.operationId, name);
    assert.ok(outcomes.has(response.outcome), name);
  }
});
