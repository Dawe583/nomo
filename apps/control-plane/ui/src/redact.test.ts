import test from "node:test";
import assert from "node:assert/strict";

import { REDACTED, isSecretKey, keyParts, redactValue } from "./redact.ts";

test("key names split on separators and case changes", () => {
  assert.deepEqual(keyParts("apiKey"), ["api", "key"]);
  assert.deepEqual(keyParts("client_secret"), ["client", "secret"]);
  assert.deepEqual(keyParts("Authorization"), ["authorization"]);
});

test("secret key names match, lookalikes do not", () => {
  assert.equal(isSecretKey("apiKey"), true);
  assert.equal(isSecretKey("access_token"), true);
  assert.equal(isSecretKey("Authorization"), true);
  assert.equal(isSecretKey("clientSecret"), true);
  assert.equal(isSecretKey("password"), true);
  assert.equal(isSecretKey("keyboard"), false);
  assert.equal(isSecretKey("monkey"), false);
  assert.equal(isSecretKey("author"), false);
  assert.equal(isSecretKey("tool"), false);
  assert.equal(isSecretKey("path"), false);
});

test("fixture: connector payload with fake secrets redacts by key", () => {
  const payload = {
    tool: "http.fetch",
    arguments: {
      url: "https://api.example.test/data",
      headers: {
        Authorization: "Bearer faketoken1234567890",
        "Content-Type": "application/json",
      },
    },
    result: {
      apiKey: "fake-api-key-abcdef123456",
      rows: [{ id: 1, name: "alpha" }],
      nested: { clientSecret: "fake-client-secret-xyz", mode: "read" },
    },
  };
  const redacted = redactValue(payload) as Record<string, any>;
  assert.equal(redacted.arguments.headers.Authorization, REDACTED);
  assert.equal(redacted.arguments.headers["Content-Type"], "application/json");
  assert.equal(redacted.result.apiKey, REDACTED);
  assert.deepEqual(redacted.result.nested, {
    clientSecret: REDACTED,
    mode: "read",
  });
  assert.deepEqual(redacted.result.rows, [{ id: 1, name: "alpha" }]);
  assert.equal(redacted.tool, "http.fetch");
});

test("fixture: bearer token inside free text redacts without a key", () => {
  const out = redactValue({
    log: "call failed with Bearer faketoken1234567890, retrying",
  }) as Record<string, unknown>;
  assert.equal(out.log, "call failed with [redacted], retrying");
});

test("fixture: password in a database URL redacts, user stays", () => {
  const out = redactValue({
    dsn: "postgresql://ops:fakepassword9@db.example.test:5432/app",
  }) as Record<string, unknown>;
  assert.equal(out.dsn, "postgresql://ops:[redacted]@db.example.test:5432/app");
});

test("non secret values pass through and the input is never mutated", () => {
  const input = {
    count: 3,
    enabled: true,
    missing: null,
    tags: ["a", "b"],
    meta: { region: "eu", retries: 2 },
  };
  const snapshot = JSON.parse(JSON.stringify(input));
  const out = redactValue(input);
  assert.deepEqual(out, input);
  assert.deepEqual(input, snapshot);
});

test("arrays redact per item and cycles keep identity", () => {
  const cyclic: Record<string, unknown> = { token: "fake-token-1" };
  cyclic.self = cyclic;
  const out = redactValue({ items: [{ password: "x" }, 1, cyclic] }) as {
    items: unknown[];
  };
  assert.deepEqual(out.items[0], { password: REDACTED });
  assert.equal(out.items[1], 1);
  const node = out.items[2] as Record<string, unknown>;
  assert.equal(node.token, REDACTED);
  assert.equal(node.self, node);
});
