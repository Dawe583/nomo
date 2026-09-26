import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const source = readFileSync(new URL("./permission-mode.tsx", import.meta.url), "utf8");
/** The prose in this file explains the markup it sits next to, so the source
 * is stripped of comments before it is asserted on. Otherwise a comment
 * mentioning `disabled` would satisfy an assertion about the markup. */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "");

test("permission mode requires explicit server authority", () => {
  assert.match(code, /permissionModeAuthority === "server"/);
  assert.match(code, /return \{ mode, source: "server" \}/);
  assert.match(code, /return \{ mode: "read-only", source: "local" \}/);
});

test("an unanswered capabilities query is pending, not a server refusal", () => {
  // The fail-closed mode is unchanged; only the claim changes. A banner that
  // says "server mode unavailable" while the query is in flight is false
  // against a healthy server, and the banner is the one element a reader has to
  // be able to believe.
  assert.match(code, /if \(data === undefined\)/);
  assert.match(code, /return \{ mode: "read-only", source: answered \? "local" : "pending" \}/);
  assert.match(code, /"režim se ověřuje u serveru", "checking the server"/);
  // An explicit error, and a query that has settled with no data, are the only
  // two cases that license naming the server as the reason.
  assert.match(
    code,
    /const answered = capabilities\.isError === true \|\| capabilities\.isPending === false/,
  );
  // A pending answer never buys privilege: the mode is still the default.
  assert.doesNotMatch(code, /source: "pending"[^}]*mode: "normal"|mode: "normal"[^}]*source: "pending"/);
});

test("plan mode prefix has a Czech built-in translation", () => {
  assert.match(code, /"Plánuj pouze/);
  assert.match(code, /"Plan only/);
});

test("the mode prefix still fails closed while the answer is unknown", () => {
  // The prefix reads only the mode, so it says "read-only" during the flight
  // window. Omitting it would instruct the model that it may act before the
  // server has granted anything, which is the direction this file must never
  // err in. `source` is therefore not a parameter of the prefix.
  assert.match(code, /export function modePrefix\(mode: PermissionMode, t:/);
  assert.doesNotMatch(code, /modePrefix\([^)]*source/);
  assert.doesNotMatch(code, /source === "pending"[\s\S]{0,160}return ""/);
});

test("the mode switch is a control only when the client can change the mode", () => {
  // A radiogroup whose every radio is disabled announces the authoritative
  // mode as unselectable, which is the one thing it actually is not.
  assert.doesNotMatch(code, /\bdisabled\b/);
  assert.doesNotMatch(code, /setMode: \(\) => undefined/);
  assert.match(code, /readonly setMode\?: \(mode: PermissionMode\) => void/);
  // The gallery's real consumer keeps a working onChange path.
  assert.match(code, /onChange\?: \(mode: PermissionMode\) => void/);
  assert.match(code, /\{onChange \? \(/);
  assert.match(code, /onClick=\{\(\) => onChange\(id\)\}/);
  assert.match(code, /role="radiogroup"/);
  assert.match(code, /aria-checked=\{mode === id\}/);
  assert.match(code, /aria-label=\{t\("Režim oprávnění", "Permission mode"\)\}/);
});

test("a non-interactive mode switch states the mode, its authority and the reason", () => {
  assert.match(code, /className="muted permission-authority"/);
  assert.match(code, /\{words\.label\} · \{words\.origin\}/);
  assert.match(code, /Server určuje režim|Server controls the mode/);
  // The banner and the switch share one wording, so the notices region and the
  // settings dialog can never show different sentences for the same state.
  assert.equal((code.match(/vynucuje server/g) ?? []).length, 1);
  assert.equal((code.match(/Režim: plán/g) ?? []).length, 1);
  assert.equal((code.match(/režim se ověřuje u serveru/g) ?? []).length, 1);
  // The source still reaches the markup, so the stylesheet can key on it.
  assert.match(code, /data-source=\{source\}/);
});
