import test from "node:test";
import assert from "node:assert/strict";
import { providerMatrix } from "./provider-matrix.ts";

const apiKey = {
  id: "opencode:zen",
  name: "OpenCode Zen",
  source: "OpenCode",
  authMethod: "api-key",
  hostOnly: false,
  available: true,
};

const oauth = {
  id: "prime:anthropic",
  name: "Anthropic",
  source: "Prime",
  authMethod: "oauth",
  hostOnly: false,
  available: false,
  reason: "oauth-expired",
};

const host = {
  id: "prime:openai-codex",
  name: "OpenAI Codex through Prime Agent",
  source: "Prime",
  authMethod: "host-subscription",
  hostOnly: true,
  host: "prime-agent",
  available: true,
};

test("every discovered source keeps its id, auth method and availability", () => {
  const rows = providerMatrix([apiKey, oauth, host]);
  assert.deepEqual(
    rows.map((row) => row.id),
    ["opencode:zen", "prime:anthropic", "prime:openai-codex"],
  );
  assert.deepEqual(
    rows.map((row) => row.authMethod),
    ["api-key", "oauth", "host-subscription"],
  );
  assert.deepEqual(
    rows.map((row) => row.availability),
    ["available", "unavailable: OAuth session expired", "available"],
  );
});

test("a host subscription is host-only and never importable, even when the host probe succeeds", () => {
  const [row] = providerMatrix([host]);
  assert.equal(row.hostOnly, true);
  assert.equal(row.host, "prime-agent");
  // The host owns the credential, so an "available" host must not offer an
  // import the server would reject.
  assert.equal(row.importable, false);
});

test("only an available API-key source is importable", () => {
  const rows = providerMatrix([
    apiKey,
    oauth,
    { ...apiKey, id: "omp:nvidia", available: false },
    host,
  ]);
  assert.deepEqual(
    rows.map((row) => row.importable),
    [true, false, false, false],
  );
});

test("host-only is derived from the auth method when the payload omits the flag", () => {
  const [row] = providerMatrix([
    { id: "claude:claude-code", name: "Claude Code", source: "Claude Code", authMethod: "host-subscription", available: false, reason: "host-login-required" },
  ]);
  assert.equal(row.hostOnly, true);
  assert.equal(row.availability, "unavailable: host login required");
});

test("an older payload without authMethod stays readable", () => {
  const rows = providerMatrix([
    { id: "opencode:zen", name: "OpenCode Zen", source: "OpenCode", available: true },
    { id: "prime:anthropic", name: "Anthropic", source: "Prime", available: false, reason: "oauth-entry-malformed" },
    { id: "omp:nvidia", name: "NVIDIA NIM", source: "OMP", available: false, reason: "api-key-route-unavailable" },
  ]);
  assert.deepEqual(
    rows.map((row) => row.authMethod),
    ["api-key", "oauth", "api-key"],
  );
  assert.deepEqual(
    rows.map((row) => row.availability),
    ["available", "unavailable: OAuth entry malformed", "unavailable: no import route for this API key"],
  );
});

test("a reason that is not a fixed code is never echoed into the row", () => {
  const rows = providerMatrix([
    { id: "prime:anthropic", name: "Anthropic", source: "Prime", available: false, reason: "/Users/operator/.prime/agent/auth.json" },
    { id: "omp:nvidia", name: "NVIDIA NIM", source: "OMP", available: false, reason: "Failed at C:\\Users\\operator\\.omp\\agent.db" },
    { id: "opencode:zen", name: "OpenCode Zen", source: "OpenCode", available: false, reason: "future-code" },
  ]);
  const shown = JSON.stringify(rows);
  assert.ok(!shown.includes("/Users"), "a credential path must never reach a row");
  assert.ok(!shown.includes("agent.db"), "a credential path must never reach a row");
  assert.ok(!shown.includes("operator"));
  assert.deepEqual(
    rows.map((row) => row.availability),
    ["unavailable: unknown reason", "unavailable: unknown reason", "unavailable: future-code"],
  );
});

test("malformed entries are dropped instead of rendered as blank rows", () => {
  const rows = providerMatrix([
    null,
    "not-a-source",
    { name: "no id" },
    { id: "" },
    { ...apiKey, id: 42 },
  ]);
  assert.deepEqual(rows, []);
});
