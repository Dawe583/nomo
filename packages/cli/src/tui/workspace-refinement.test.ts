import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workbench } from "../../../workbench/src/index.ts";
import { WorkspaceTui } from "./workspace.ts";
import type { RefinementProposal } from "../../../workbench/src/refine-pass.ts";

/**
 * The operator reviews a pending prompt proposal before it may activate: the
 * ledger tab shows the exact diff and its provenance, and activation happens
 * only through an explicit approve naming the digest. Inspecting never
 * decides, and an unknown digest is refused rather than guessed.
 */

const fetcher = async (url: unknown) =>
  String(url).endsWith("/models")
    ? Response.json({ data: [{ id: "fixture" }] })
    : Response.json({
        choices: [{ message: { role: "assistant", content: "Ready" } }],
      });

const promptProposal = (): RefinementProposal => ({
  summary: "prompt addendum",
  rationale: "supported by signed records",
  expectedOutcome: "steadier inventory turns",
  edits: [
    {
      action: "create",
      kind: "prompt",
      title: "inventory preamble",
      content: "Summarise inventory before editing.",
      derivedFromSeq: [1],
      reason: "the pattern repeats",
    },
  ],
});

const fixture = async (t: { after(fn: () => Promise<void>): void }) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-refinement-"));
  const env = { NOMO_DATA_DIR: root };
  const app = new Workbench(env, fetcher);
  await app.configure({
    baseUrl: "https://fixture.test/v1",
    apiKey: "fixture",
  });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  await ui.command("/new Review the inventory.");
  await app.settled();
  const sessionId = (ui as unknown as { sessionId?: string }).sessionId;
  assert.ok(sessionId, "a conversation must be selected");
  await app.editDocument(sessionId!, {
    path: "source.md",
    content: "signed source record",
    expectedRevision: null,
  });
  return { app, ui, sessionId: sessionId! };
};

const rowsOf = (ui: WorkspaceTui) =>
  ui.items() as unknown as Array<{ id: string; lines: string[] }>;

test("a pending proposal row shows the exact diff and its provenance", async (t) => {
  const { app, ui, sessionId } = await fixture(t);
  await app.refineHarness(sessionId, promptProposal());
  await ui.refresh(true);
  ui.choose("ledger");

  const row = rowsOf(ui).find((candidate) =>
    candidate.id.startsWith("proposal:"),
  );
  assert.ok(row, "a proposal row must be listed");
  const text = row!.lines.join("\n");
  assert.ok(text.includes("inventory preamble"));
  assert.ok(text.includes("Summarise inventory before editing."));
  assert.ok(text.includes("the pattern repeats"));
  assert.ok(text.includes("chain seq 1"), "provenance must be visible");
  assert.ok(text.includes("Digest: sha256:"));
  assert.ok(text.includes("/refine approve"));

  ui.selected = rowsOf(ui).findIndex((candidate) =>
    candidate.id.startsWith("proposal:"),
  );
  await ui.openSelected();
  const detail = (ui as unknown as { detail: string[] }).detail.join("\n");
  assert.ok(detail.includes("inventory preamble"));
  assert.ok(detail.includes("Digest: sha256:"));
});

test("inspecting a proposal activates nothing", async (t) => {
  const { app, ui, sessionId } = await fixture(t);
  await app.refineHarness(sessionId, promptProposal());
  await ui.refresh(true);
  ui.choose("ledger");
  ui.selected = rowsOf(ui).findIndex((candidate) =>
    candidate.id.startsWith("proposal:"),
  );
  await ui.openSelected();
  const workspace = app.get(sessionId)!.workspace;
  assert.deepEqual(await app.harnessEntries(workspace), []);
  assert.equal((await app.pendingProposals(workspace)).length, 1);
});

test("/refine approve activates exactly the named digest", async (t) => {
  const { app, ui, sessionId } = await fixture(t);
  await app.refineHarness(sessionId, promptProposal());
  const workspace = app.get(sessionId)!.workspace;
  const [pending] = await app.pendingProposals(workspace);

  await ui.command(`/refine approve ${pending!.digest}`);
  assert.match(
    (ui as unknown as { notice: string }).notice,
    /Proposal approved/,
  );
  assert.deepEqual(
    (await app.harnessEntries(workspace)).map((entry) => entry.title),
    ["inventory preamble"],
  );
  assert.deepEqual(await app.pendingProposals(workspace), []);
});

test("/refine reject settles the proposal without activating it", async (t) => {
  const { app, ui, sessionId } = await fixture(t);
  await app.refineHarness(sessionId, promptProposal());
  const workspace = app.get(sessionId)!.workspace;
  const [pending] = await app.pendingProposals(workspace);

  await ui.command(`/refine reject ${pending!.digest} too vague`);
  assert.match((ui as unknown as { notice: string }).notice, /rejected/);
  assert.deepEqual(await app.harnessEntries(workspace), []);
  assert.deepEqual(await app.pendingProposals(workspace), []);
});

test("an unknown digest is refused rather than guessed", async (t) => {
  const { ui } = await fixture(t);
  await assert.rejects(
    ui.command(`/refine approve ${"sha256:0".padEnd(71, "0")}`),
    /No pending proposal/,
  );
  await assert.rejects(
    ui.command(`/refine reject ${"sha256:0".padEnd(71, "0")}`),
    /No pending proposal/,
  );
  await assert.rejects(ui.command("/refine approve"), /\/refine/);
  await ui.command("/refine");
  assert.equal(
    (ui as unknown as { tab: string }).tab,
    "ledger",
    "bare /refine lists proposals on the ledger tab",
  );
});
