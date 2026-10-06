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

test("the hook toggle posts the same hook with the flag flipped", () => {
  // The id ties a hook to its runs, so a toggle is a re-save of the same
  // hook, not a new one and never a delete.
  assert.match(
    code,
    /api\("\/api\/hooks", "POST", \{ \.\.\.row, enabled: !row\.enabled \}\)/,
  );
});

test("the hook form can only name an allowlisted command", () => {
  // validateHook refuses a command that is not on the operator allowlist, so
  // a free-text command field would be a form whose only outcome is a
  // refusal. The field is a select over the catalog's hookCommands, and the
  // form renders only when at least one command is allowlisted.
  assert.match(code, /save\(event, "\/api\/hooks", \(fields\) => \(\{/);
  assert.match(code, /fields\.command,/);
  assert.match(
    code,
    /agents\.data\.hookCommands \?\? \[\]\)\.map\(\(command: string\) => \(/,
  );
  assert.match(
    code,
    /\(agents\.data\.hookCommands\?\.length \?\? 0\) > 0 && \(/,
  );
});

test("the allowlist itself stays out of the form", () => {
  // The operator allowlist is environment-only on purpose: an interface that
  // could add an entry would let a hook author authorise their own command.
  // The form says so next to the command field.
  assert.match(code, /never through this interface/);
});
