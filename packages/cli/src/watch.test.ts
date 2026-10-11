import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveLedgerPath } from "./watch.ts";

describe("resolveLedgerPath", () => {
  test("a ledger directory resolves to that workspace's ledger file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nomo-watch-ledger-"));
    assert.equal(await resolveLedgerPath(dir, "billing"), join(dir, "billing.jsonl"));
  });

  test("a ledger file is taken as given, so one specific ledger still works", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nomo-watch-ledger-"));
    const file = join(dir, "billing.jsonl");
    await writeFile(file, "");
    assert.equal(await resolveLedgerPath(file, "billing"), file);
  });

  test("a path that does not exist is left alone rather than silently rewritten", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nomo-watch-ledger-"));
    const missing = join(dir, "not-created-yet.jsonl");
    assert.equal(await resolveLedgerPath(missing, "billing"), missing);
  });

  test("with no flag the workspace ledger under NOMO_LEDGER_DIR is used", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nomo-watch-ledger-"));
    const previous = process.env.NOMO_LEDGER_DIR;
    process.env.NOMO_LEDGER_DIR = dir;
    try {
      assert.equal(await resolveLedgerPath(undefined, "billing"), join(dir, "billing.jsonl"));
    } finally {
      if (previous === undefined) delete process.env.NOMO_LEDGER_DIR;
      else process.env.NOMO_LEDGER_DIR = previous;
    }
  });
});
