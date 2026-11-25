import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Workbench } from "../../../workbench/src/index.ts";
import { devKeyProvider } from "../../../ledger/src/sign.ts";
import { jsonlStore, type JsonlEntry } from "../../../ledger/src/store.ts";
import { verifyChain } from "../../../ledger/src/verify.ts";
import { WorkspaceTui } from "./workspace.ts";

/**
 * The ledger tab's CHAIN STATUS summary.
 *
 * A workspace whose chain cannot be verified contributes no entry rows and no
 * learning rows, because the TUI reads proofs through `Workbench.ledger()`,
 * which throws on a failed verification (workspace.ts:1919-1934). What the
 * operator gets instead is a whole-workspace degraded line. That is the state
 * pinned here: one real, signed and verified chain, one workspace that failed,
 * and no evidence rows borrowed from the failure.
 *
 * The chain in this test is appended by the real store with a real key and
 * verified by the real verifier. A hand-written entry with a made-up signature
 * would prove nothing about this tab, because the tab's claim is exactly that
 * it only shows what verification returned.
 */

const assistantFetcher = (content: string) => async (url: unknown) => {
  if (String(url).endsWith("/models"))
    return Response.json({ data: [{ id: "fixture" }] });
  return Response.json({
    choices: [{ message: { role: "assistant", content } }],
  });
};

const WORKSPACE = "chain-ws";
const VERIFIED_SESSION = "chain0001-verified";
const FAILED_SESSION = "deadbeef-failed";

/** The message workspace.ts records when `Workbench.ledger()` throws. */
const DEGRADED_MESSAGE =
  "Signature / integrity ERROR. Recovery and export cannot be considered verified.";

test("the ledger tab reports a failed workspace as degraded, not as missing rows", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-chain-status-"));
  const env = { NOMO_DATA_DIR: root };
  const app = new Workbench(env, assistantFetcher("ok"));
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });

  // One real signed chain: the store signs it with a real key, and the
  // verifier is the same API a third party runs.
  const signer = await devKeyProvider({ dir: join(root, "chain-keys"), env: {} });
  const store = jsonlStore(signer, { dir: join(root, "chain-ledger") });
  await store.append({
    workspace: WORKSPACE,
    at: "2026-10-31T00:00:00.000Z",
    tool: "postgres.row.update",
    klass: "r1",
    decision: "allow:resolved",
    argsDigest: "a".repeat(64),
  });
  const entries: JsonlEntry[] = [];
  for await (const entry of store.read(WORKSPACE)) entries.push(entry);
  const publicKey = await signer.publicKey(await signer.currentKeyId());
  assert.ok(publicKey !== null);
  const verified = await verifyChain(entries, { publicKey });
  assert.equal(verified.ok, true, "the fixture chain must really verify");
  assert.equal(verified.checked, 1);

  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  // Seeded into the same maps a refresh fills from `ledger()` and its catch
  // block, so the tab renders the verified entries it was given and the
  // failure the workbench reported.
  ui.proofs.set(VERIFIED_SESSION, entries);
  ui.proofErrors.set(FAILED_SESSION, DEGRADED_MESSAGE);
  ui.choose("ledger");
  const rows = ui.lines();
  const text = rows.join("\n");

  assert.equal(rows[0], "CHAIN STATUS");
  // One entry across all proofs, and the failure named at workspace level.
  assert.ok(
    rows.includes("Managed 1 · 1 workspace(s) failed verification"),
    `summary is not the degraded one:\n${rows.slice(0, 6).join("\n")}`,
  );
  // The issue is spelled out rather than only counted, because "1 issue" does
  // not tell an operator that recovery cannot be trusted.
  assert.match(text, /1 issue\(s\) · \/verify rechecks/);
  assert.ok(
    text.includes(`Managed ledger: ${DEGRADED_MESSAGE}`),
    "the degraded reason is not rendered in full",
  );

  // Exactly one signed entry row, and it belongs to the verified workspace.
  const entryRows = ui.items().filter((row) => row.kind === "entry");
  assert.equal(entryRows.length, 1);
  assert.equal(entryRows[0]!.sessionId, VERIFIED_SESSION);
  assert.equal(
    entryRows[0]!.label,
    "allow:resolved · [R1] postgres.row.update · chain000 #1",
  );
  ui.filter = "r1";
  assert.equal(ui.items().filter((row) => row.kind === "entry").length, 1);
  ui.filter = "r2";
  assert.equal(ui.items().filter((row) => row.kind === "entry").length, 0);
  ui.filter = "";

  // The failed workspace contributes no record rows of any kind. A row here
  // would be a record the TUI never verified, printed beside records it did.
  assert.equal(
    ui.items().some((row) => row.id.startsWith(`${FAILED_SESSION}:`)),
    false,
    "the failed workspace produced a record row",
  );
  assert.doesNotMatch(text, /deadbeef/);

  // The entry section holds one numbered row and no borrowed evidence.
  const entryHeading = rows.findIndex((row) => row.includes("SIGNED ENTRIES"));
  assert.ok(entryHeading >= 0, "no SIGNED ENTRIES heading");
  const learnedHeading = rows.findIndex((row) =>
    row.includes("LEARNED FROM THE CHAIN"),
  );
  assert.ok(learnedHeading > entryHeading, "learning follows the entries");
  const entrySection = rows.slice(entryHeading + 1, learnedHeading);
  assert.equal(
    entrySection.filter((row) => /^\s*(?:▸\s)?\d+\. /.test(row)).length,
    1,
    `entry section has more than the one verified row:\n${entrySection.join("\n")}`,
  );

  // Learning is derived only from verified entries, so it appears only in its
  // own group, below the heading, never mixed into the entry rows.
  const learnedRows = ui.items().filter((row) => row.kind === "learned");
  assert.equal(learnedRows.length, 1, "one verified workspace, one record");
  const learnedLine = rows.findIndex((row) => row.includes(learnedRows[0]!.label));
  assert.ok(learnedLine > learnedHeading, "learned row is not under its heading");
  const firstLearnedWord = rows.findIndex((row) => /learned [\w-]+ /.test(row));
  assert.equal(firstLearnedWord, learnedLine);
  assert.ok(
    rows
      .slice(0, learnedHeading)
      .every((row) => !/learned [\w-]+ /.test(row)),
    "a learned row was printed above LEARNED FROM THE CHAIN",
  );
});
