import assert from "node:assert/strict";
import test from "node:test";
import { redactToolDetail, toolOutputText } from "./run-activity.ts";

test("tool detail redaction preserves lines and covers private keys and credential fields", () => {
  const redacted = redactToolDetail(
    "before\n-----BEGIN PRIVATE KEY-----\nsecret-material\n-----END PRIVATE KEY-----\ntoken: abc123\ncredential=xyz",
  );
  assert.ok(redacted.includes("before\n"));
  assert.ok(redacted.includes("[redacted private key block]"));
  assert.ok(redacted.includes("token: [redacted]"));
  assert.ok(redacted.includes("credential=[redacted]"));
  assert.ok(!redacted.includes("secret-material"));
  assert.ok(!redacted.includes("abc123"));
});

test("tool output extraction uses only recorded text", () => {
  assert.deepEqual(
    toolOutputText({ content: [{ type: "text", text: "recorded" }] }),
    ["recorded"],
  );
  assert.deepEqual(toolOutputText({ stdout: "out", stderr: "err" }), [
    "out",
    "err",
  ]);
  assert.deepEqual(toolOutputText({}), []);
});
