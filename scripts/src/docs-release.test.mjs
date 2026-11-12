import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const writtenFiles = [
  "README.md",
  "CHANGELOG.md",
  "docs/OPERATIONS.md",
  "docs/SDK.md",
  "packages/sdk/README.md",
];

test("release docs avoid forbidden dash characters", () => {
  for (const file of writtenFiles) {
    const text = readFileSync(file, "utf8");
    assert.equal(/[\u2013\u2014]/u.test(text), false, file);
  }
});

test("SDK docs match the public barrel", () => {
  const barrel = readFileSync("packages/sdk/src/index.ts", "utf8");
  const docs = readFileSync("docs/SDK.md", "utf8");
  for (const name of [
    "NomoClient",
    "createNomoClient",
    "holdHandle",
    "HoldDeniedError",
    "LedgerVerifyError",
    "PolicyStartupError",
    "RefusedError",
    "McpLikeClient",
    "NomoClientOptions",
    "NomoClock",
    "NomoConnect",
    "HoldHandle",
    "HoldHandleOptions",
    "RefusalReason",
    "NomoErrorCode",
  ]) {
    assert.match(barrel, new RegExp(`\\b${name}\\b`), name);
    assert.match(docs, new RegExp(`\\b${name}\\b`), name);
  }
  assert.doesNotMatch(docs, /ApplyReportLike|ReplayRefusalLike/);
});

test("changelog stays user facing", () => {
  const text = readFileSync("CHANGELOG.md", "utf8");
  const summary = text
    .split("## Unreleased")[1]
    ?.split("## Engineering history")[0];
  assert.ok(summary, "the user-facing Unreleased section is present");
  assert.doesNotMatch(summary, /WP-[0-9]/);
  assert.doesNotMatch(summary, /packages\//);
  assert.doesNotMatch(summary, /docs\//);
  assert.doesNotMatch(summary, / tests?\b/i);
});
