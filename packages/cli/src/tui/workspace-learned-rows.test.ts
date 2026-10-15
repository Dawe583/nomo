import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workbench } from "../../../workbench/src/index.ts";
import type { JsonlEntry } from "../../../ledger/src/store.ts";
import { WorkspaceTui } from "./workspace.ts";

/**
 * The ledger tab's learning rows: what identifies them, and what they say
 * when there is nothing to report.
 *
 * The `/learned` view is covered in workspace-parity.test.ts. These tests are
 * about the *rows*, because a row is what an operator scrolls past, a view
 * they have to ask for is a view most operators never open.
 */

const assistantFetcher = (content: string) => async (url: unknown) => {
  if (String(url).endsWith("/models"))
    return Response.json({ data: [{ id: "fixture" }] });
  return Response.json({
    choices: [{ message: { role: "assistant", content } }],
  });
};

async function ledgerRows(t: {
  after(fn: () => Promise<void>): void;
}): Promise<{ ui: WorkspaceTui; app: Workbench; env: Record<string, string> }> {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-learned-rows-"));
  const env = { NOMO_DATA_DIR: root };
  const app = new Workbench(env, assistantFetcher("ok"));
  await app.configure({
    baseUrl: "https://fixture.test/v1",
    apiKey: "fixture-key",
  });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  ui.choose("ledger");
  return { ui, app, env };
}

type Row = { id: string; label: string; lines: string[] };

const rowsOf = (ui: WorkspaceTui): Row[] => ui.items() as unknown as Row[];

/** Only the learning rows, the tab also carries the chain entries themselves. */
const learnedRows = (ui: WorkspaceTui): Row[] =>
  rowsOf(ui).filter((r) => r.id.startsWith("learned:"));

/**
 * One refusal as the miner sees it. `mineLearnedRules` reads nothing but
 * `body`, so the signed fields are left off rather than forged, a fixture
 * that invented a signature would claim a verification it never performed.
 */
const refusal = (tool: string, klass: string) =>
  ({
    body: { tool, klass, decision: "deny:policy" },
  }) as unknown as JsonlEntry;

test("one tool refused under two classes is two rows, and two identities", async (t) => {
  const { ui } = await ledgerRows(t);

  // The same workspace, the same tool, two different classes, both over the
  // repeat threshold. This is the case that breaks a tool-only identity: the
  // miner treats it as two separate patterns, so the rows must too.
  ui.proofs.set("ws-1", [
    refusal("nomo_run", "r1"),
    refusal("nomo_run", "r1"),
    refusal("nomo_run", "r1"),
    refusal("nomo_run", "r3"),
    refusal("nomo_run", "r3"),
    refusal("nomo_run", "r3"),
  ]);

  const learned = learnedRows(ui);
  assert.equal(
    learned.length,
    2,
    "both classes should surface as their own row",
  );

  // The defect: an id built from the tool alone collapses these two rows onto
  // one identity, so selecting one selects the other and the tab cannot tell
  // them apart.
  const ids = learned.map((r) => r.id);
  assert.equal(new Set(ids).size, 2, `row ids collided: ${ids.join(", ")}`);

  // And the class is what tells the operator which pattern they are looking
  // at. The leading glyph is the row icon; the words after it are the
  // contract, so the assertion strips the glyph rather than pinning it here.
  assert.deepEqual(learned.map((r) => r.label.replace(/^\S+\s/, "")).sort(), [
    "learned ws-1 nomo_run [r1] -> hold",
    "learned ws-1 nomo_run [r3] -> hold",
  ]);
});

test("a chain with no recurring refusal still gets a record, and it counts zero", async (t) => {
  const { ui } = await ledgerRows(t);

  // Two refusals is a real observation below the threshold of three. It is
  // not the same as a tab with no record at all, and an operator has to be
  // able to tell those apart: one says "read, found nothing", the other says
  // "nothing was ever read".
  ui.proofs.set("ws-1", [
    refusal("void_workspace_delete", "r1"),
    refusal("void_workspace_delete", "r1"),
  ]);

  const learned = learnedRows(ui);
  assert.equal(learned.length, 1, "the empty case must still produce a row");
  const body = learned[0].lines.join("\n");
  assert.match(body, /0 recurring refusals across 2 verified entries/);
  // Provenance, so it is still visibly derived from the chain.
  assert.match(body, /Mined from the verified chain/);
});

test("no verified entries at all is worded differently from no recurring refusal", async (t) => {
  const withEntries = await ledgerRows(t);
  withEntries.ui.proofs.set("ws-1", [
    refusal("void_workspace_delete", "r1"),
    refusal("void_workspace_delete", "r1"),
  ]);

  const none = await ledgerRows(t);
  assert.equal(none.ui.proofs.size, 0);

  const a = learnedRows(withEntries.ui)[0].lines.join("\n");
  const b = learnedRows(none.ui)[0].lines.join("\n");
  // Collapsing these two into one wording would be the same bug again: a
  // chain that was read and taught nothing is not a chain that was empty.
  assert.notEqual(a, b);
  assert.match(b, /0 verified entries, so no refusal has been observed/);
  assert.doesNotMatch(b, /0 recurring refusals across/);
});

test("a learned rule is never shown without the operator-written marker", async (t) => {
  const { ui } = await ledgerRows(t);
  ui.proofs.set("ws-1", [
    refusal("void_workspace_delete", "r1"),
    refusal("void_workspace_delete", "r1"),
    refusal("void_workspace_delete", "r1"),
  ]);

  const learned = learnedRows(ui);
  assert.equal(learned.length, 1);
  const body = learned[0].lines.join("\n");
  // The marker is written by the miner, not restated here, if the chain ever
  // changes its wording the view must follow rather than assert.
  assert.match(body, /Not written by an operator\./);
  // Evidence, not authority: the precedence guarantee has to be visible where
  // the rule is shown, not only where it is enforced.
  assert.match(body, /evidence, not authority/);
  assert.match(body, /appended after the operator's own rules/);
});

test("/learned empty cases print the same lines as the ledger tab rows", async (t) => {
  // One workspace that taught nothing over two verified entries, and one
  // that has no verified entries at all.
  const withData = await ledgerRows(t);
  withData.ui.proofs.set("ws-1", [
    refusal("void_workspace_delete", "r1"),
    refusal("void_workspace_delete", "r1"),
  ]);
  withData.ui.proofs.set("ws-2", []);
  const tabEmpty = learnedRows(withData.ui)
    .flatMap((r) => r.lines)
    .filter((line) => line.startsWith("0 "));
  assert.deepEqual(
    tabEmpty.sort(),
    [
      "0 recurring refusals across 2 verified entries.",
      "0 verified entries, so no refusal has been observed and no rule was mined.",
    ].sort(),
  );

  await withData.ui.command("/learned");
  const detail = withData.ui.lines();
  for (const line of tabEmpty)
    assert.ok(detail.includes(line), `detail is missing "${line}"`);

  // No proofs anywhere: the tab's learned:none row and the /learned detail
  // must carry the same global nothing-verified line.
  const none = await ledgerRows(t);
  const tabGlobal = learnedRows(none.ui).find((r) => r.id === "learned:none");
  assert.ok(tabGlobal, "no global learned:none row on the tab");
  await none.ui.command("/learned");
  const detailNone = none.ui.lines();
  for (const line of tabGlobal.lines)
    if (line.startsWith("0 "))
      assert.ok(detailNone.includes(line), `detail is missing "${line}"`);
});
