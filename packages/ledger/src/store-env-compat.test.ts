import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { dataDir } from "./paths.ts";
import { ledgerDir } from "./store.ts";

test("the ledger directory falls back to the legacy name", () => {
  assert.equal(
    ledgerDir({ VOID_LEDGER_DIR: "/legacy/ledger" } as NodeJS.ProcessEnv),
    "/legacy/ledger",
  );
});

test("the current ledger directory wins over the legacy one", () => {
  assert.equal(
    ledgerDir({ NOMO_LEDGER_DIR: "/current", VOID_LEDGER_DIR: "/legacy" } as NodeJS.ProcessEnv),
    "/current",
  );
});

test("an explicitly empty current directory is honoured rather than falling back", () => {
  assert.equal(
    ledgerDir({ NOMO_LEDGER_DIR: "", VOID_LEDGER_DIR: "/legacy" } as NodeJS.ProcessEnv),
    "",
  );
});

test("with neither name set the directory sits under the resolved data directory", () => {
  assert.equal(ledgerDir({} as NodeJS.ProcessEnv), join(dataDir(homedir()), "ledger"));
});