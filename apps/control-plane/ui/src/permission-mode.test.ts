import test from "node:test";
import assert from "node:assert/strict";
import {
  PERMISSION_MODES,
  isPermissionMode,
  modeLabel,
  modePrefix,
  restrictsWrites,
} from "./permission-modes.ts";
import type { Translate } from "./permission-modes.ts";

const english: Translate = (_cs, en) => en;
const czech: Translate = (cs, _en) => cs;

test("every mode produces a distinct, non-empty English instruction", () => {
  const prefixes = PERMISSION_MODES.map((mode) => modePrefix(mode, english));
  for (const prefix of prefixes) assert.ok(prefix.trim().length > 0);
  assert.equal(new Set(prefixes).size, PERMISSION_MODES.length);
  // chat.tsx concatenates the prefix straight onto the draft, so it has to end
  // its own block or it runs into the first word the user typed.
  for (const prefix of prefixes) assert.ok(prefix.endsWith("\n\n"));
});

// The mode is an instruction inside the prompt. Nothing on the server reads it
// and policy decides each write on its own case, so a prefix that announced
// enforcement would be a guarantee the product cannot make.
test("no mode prefix claims server enforcement", () => {
  const claim =
    /enforc|guarantee|server|policy|block|refus|prevent|cannot|will not/i;
  for (const mode of PERMISSION_MODES)
    assert.doesNotMatch(modePrefix(mode, english), claim, mode);
});

test("a restricting mode asks for fewer writes, normal asks for nothing", () => {
  assert.deepEqual(PERMISSION_MODES.filter(restrictsWrites), [
    "plan",
    "read-only",
  ]);
});

test("both locales are filled in and the labels are distinct", () => {
  for (const mode of PERMISSION_MODES) {
    assert.ok(modeLabel(mode, english).length > 0, mode);
    assert.ok(modeLabel(mode, czech).length > 0, mode);
    assert.ok(modePrefix(mode, czech).trim().length > 0, mode);
  }
  assert.equal(
    new Set(PERMISSION_MODES.map((mode) => modeLabel(mode, english))).size,
    PERMISSION_MODES.length,
  );
});

// The capabilities payload calls its deployment mode "mode" and returns
// "local" or "cloud". Reading that as a permission mode would put a value in the
// switch that the server never offered.
test("the deployment mode is not a permission mode", () => {
  assert.equal(isPermissionMode("local"), false);
  assert.equal(isPermissionMode("cloud"), false);
  assert.equal(isPermissionMode("normal"), true);
  assert.equal(isPermissionMode(undefined), false);
  assert.equal(isPermissionMode("write"), false);
});
