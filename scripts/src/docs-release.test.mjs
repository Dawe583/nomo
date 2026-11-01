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

test("latest Unreleased changelog entry stays user facing", () => {
  const text = readFileSync("CHANGELOG.md", "utf8");
  const unreleased =
    text.split("## Unreleased\n", 2)[1]?.split("\n## ", 1)[0] ?? "";
  const entries = unreleased
    .split(/(?=^- )/mu)
    .filter((entry) => entry.startsWith("- "));
  const prose = (entries[0] ?? "").replace(/https?:\/\/\S+/gu, "");
  assert.notEqual(
    entries.length,
    0,
    "Unreleased must contain a changelog entry",
  );
  assert.doesNotMatch(prose, /WP-[0-9]/);
  assert.doesNotMatch(prose, /packages\//);
  assert.doesNotMatch(prose, /docs\//);
  assert.doesNotMatch(prose, /\btests?\b/iu);
  assert.doesNotMatch(entries[0] ?? "", /[\u2013\u2014]/u);
});
