/**
 * Harness capability inventory.
 *
 * `docs/HARNESS-SETTINGS.md` says "a setting with no consumer does not exist",
 * but nothing checked the other direction: a documented setting that the source
 * no longer defines. Merge d7b55f38 removed six keys and edited the test that
 * expected them, so the loss stayed green. This gate makes that class of
 * regression fail locally.
 *
 * A known gap is listed in KNOWN_GAPS with the plan that closes it. A gap that
 * has been closed must be removed from the list, so the allowlist cannot rot.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

/**
 * Documented but absent from source, with the plan that restores it.
 *
 * Empty on 2026-11-24: plan A restored all six keys the merge removed. The
 * stale check below keeps this list honest.
 */
const KNOWN_GAPS = new Map([
  // Documented, still absent from source. Each names the plan that restores it
  // and why it is not restored yet, so the list cannot quietly become a lie.
]);

const documentedKeys = () => {
  const doc = read("docs/HARNESS-SETTINGS.md");
  const keys = new Set();
  for (const line of doc.split("\n")) {
    const row = /^\|\s*`([A-Za-z][A-Za-z0-9]*)`\s*\|/.exec(line);
    if (row) keys.add(row[1]);
  }
  return keys;
};

const sourceKeys = () => {
  const source = read("packages/workbench/src/harness-settings.ts");
  const keys = new Set();
  for (const match of source.matchAll(/"([A-Za-z][A-Za-z0-9]*)"/g))
    keys.add(match[1]);
  return keys;
};

test("every documented harness setting exists in source or is a named gap", () => {
  const documented = documentedKeys();
  const source = sourceKeys();
  assert.ok(documented.size >= 20, `parsed only ${documented.size} doc rows`);
  const missing = [...documented]
    .filter((key) => !source.has(key) && !KNOWN_GAPS.has(key))
    .sort();
  assert.deepEqual(
    missing,
    [],
    `documented settings with no source key: ${missing.join(", ")}`,
  );
});

test("the known-gap list is not stale", () => {
  const source = sourceKeys();
  const stale = [...KNOWN_GAPS.keys()].filter((key) => source.has(key));
  assert.deepEqual(
    stale,
    [],
    `restored settings still listed as gaps: ${stale.join(", ")}`,
  );
});
