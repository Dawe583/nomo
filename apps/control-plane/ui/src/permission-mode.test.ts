import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const source = readFileSync(new URL("./permission-mode.tsx", import.meta.url), "utf8");

test("permission mode requires explicit server authority", () => {
  assert.match(source, /permissionModeAuthority === "server"/);
  assert.match(source, /return \{ mode, source: "server" \}/);
  assert.match(source, /return \{ mode: "read-only", source: "local" \}/);
});

test("plan mode prefix has a Czech built-in translation", () => {
  assert.match(source, /"Plánuj pouze/);
  assert.match(source, /"Plan only/);
});

test("permission switch is visibly read-only because the server controls it", () => {
  assert.match(source, /disabled/);
  assert.match(source, /aria-disabled="true"/);
  assert.match(source, /Server určuje režim|Server controls the mode/);
});
