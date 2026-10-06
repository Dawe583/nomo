import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("./workspace-controls.tsx", import.meta.url),
  "utf8",
);
/** Same pattern as permission-mode.test.ts: assertions are about the markup,
 * so comments are stripped first. Otherwise a comment quoting the old copy
 * would satisfy an assertion about what renders. */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "");

test("hook copy follows the allowlist-derived capability, one state at a time", () => {
  // The defect: the allowlist sentence and the unsupported sentence both
  // rendered unconditionally, so every render contradicted itself. Now they
  // are the two branches of one conditional on the workbench's own derived
  // flag, and exactly one of them can render.
  assert.match(code, /agents\.isPending \? \(/);
  assert.match(
    code,
    /agents\.data\?\.hooksSupported === true \? \([\s\S]*?operator allowlist[\s\S]*?\) : \([\s\S]*?not supported on this host/,
  );
});

test("a pending agents query claims neither support nor refusal", () => {
  // While the catalog is in flight, neither copy may render: an unanswered
  // query is pending, not a refusal, and the unsupported sentence is the one
  // element a reader has to be able to believe.
  assert.match(code, /"Načítání hooků…", "Loading hooks…"/);
});

test("each hook summary names its on/off state", () => {
  assert.match(
    code,
    /row\.enabled \? t\("zapnutý", "on"\) : t\("vypnutý", "off"\)/,
  );
});
