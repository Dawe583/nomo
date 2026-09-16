import { test } from "node:test";
import assert from "node:assert/strict";
import { filterPalette } from "./commands.ts";
const rows = [
  { id: "new", text: "new Nov\u00e1 konverzace New conversation" },
  { id: "runs", text: "runs B\u011bhy a aktivita Runs and activity" },
];
test("empty palette query lists every action", () => {
  assert.deepEqual(
    filterPalette(rows, "  ").map((r) => r.id),
    ["new", "runs"],
  );
});
test("palette match is case insensitive and bilingual", () => {
  assert.deepEqual(
    filterPalette(rows, "KONVERZACE").map((r) => r.id),
    ["new"],
  );
  assert.deepEqual(
    filterPalette(rows, "runs").map((r) => r.id),
    ["runs"],
  );
});
test("palette without a hit returns an empty list", () => {
  assert.deepEqual(filterPalette(rows, "ledgerx"), []);
});
