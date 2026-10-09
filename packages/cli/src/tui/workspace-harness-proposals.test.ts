import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workbench } from "../../../workbench/src/index.ts";
import type { RefinementProposal } from "../../../workbench/src/refine-pass.ts";
import { WorkspaceTui } from "./workspace.ts";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "void-tui-harness-proposal-"));
  const env = { VOID_DATA_DIR: root };
  const app = new Workbench(env, async (url) =>
    String(url).endsWith("/models")
      ? Response.json({ data: [{ id: "fixture" }] })
      : Response.json({ choices: [{ message: { role: "assistant", content: "Ready" } }] }),
  );
  await app.configure({ baseUrl: "https://fixture.test/v1", apiKey: "fixture" });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  await ui.command("/new Review the workspace");
  await app.settled();
  const sessionId = ui.sessionId!;
  await app.editDocument(sessionId, {
    path: "source.md",
    content: "signed source record",
    expectedRevision: null,
  });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  return { app, ui, sessionId };
}

const proposal = (): RefinementProposal => ({
  summary: "remember the verified approval pattern",
  rationale: "the operator approved this exact call shape repeatedly",
  expectedOutcome: "later sessions can consider the bounded note",
  edits: [{
    action: "create",
    kind: "memory",
    title: "approval pattern",
    content: "The operator repeatedly approved the same action.",
    derivedFromSeq: [1],
    reason: "the verified records agree",
  }],
});

test("TUI shows the exact proposal before approving it", async (t) => {
  const { app, ui, sessionId } = await fixture(t);
  const created = await app.refineHarness(sessionId, proposal());
  await ui.command("/harness");
  assert.match(ui.detail!.join("\n"), /remember the verified approval pattern/);

  await ui.command(`/harness approve ${created.proposalDigest!.slice(0, 8)}`);
  assert.match(ui.confirmation!.title, /APPROVE HARNESS PROPOSAL/);
  assert.match(ui.confirmation!.lines.join("\n"), /The operator repeatedly approved/);
  assert.equal((await app.harnessEntries(app.get(sessionId)!.workspace)).length, 0);

  await ui.confirm();
  assert.equal((await app.harnessEntries(app.get(sessionId)!.workspace)).length, 1);
});

test("TUI rejection records the decision without activating the proposal", async (t) => {
  const { app, ui, sessionId } = await fixture(t);
  const created = await app.refineHarness(sessionId, proposal());
  await ui.command(`/harness reject ${created.proposalDigest!.slice(0, 8)}`);
  assert.match(ui.confirmation!.title, /REJECT HARNESS PROPOSAL/);
  await ui.confirm();

  const workspace = app.get(sessionId)!.workspace;
  assert.deepEqual(await app.harnessEntries(workspace), []);
  const proof = await app.ledger(workspace);
  assert.equal(
    (proof!.entries.at(-1)!.body as Record<string, unknown>).decision,
    "proposal:rejected",
  );
});

test("TUI requires an explicit digest before showing an approval", async (t) => {
  const { app, ui, sessionId } = await fixture(t);
  await app.refineHarness(sessionId, proposal());

  await assert.rejects(ui.command("/harness approve"), /at least 8 hexadecimal/);
  await assert.rejects(ui.command("/harness approve abc"), /at least 8 hexadecimal/);
  assert.equal(ui.confirmation, undefined);
  assert.equal((await app.pendingApprovalsFor(sessionId)).length, 1);
});

test("TUI confirmation includes every field from each exact edit", async (t) => {
  const { app, ui, sessionId } = await fixture(t);
  const complete: RefinementProposal = {
    summary: "review rollback and prompt fields",
    rationale: "the operator needs the full signed object",
    expectedOutcome: "every field is visible before the decision",
    edits: [
      {
        action: "delete",
        kind: "memory",
        id: "old-entry",
        derivedFromSeq: [1],
        reason: "replace the obsolete note",
        rollbackId: "restore-old-entry",
      },
      {
        action: "create",
        kind: "prompt",
        title: "approved addendum",
        content: "content field remains visible too",
        promptAddendum: "only this is the approved prompt text \u202e \u0085 \u200b",
        derivedFromSeq: [1],
        reason: "the operator chose this exact wording",
        rollbackId: "undo-approved-addendum",
      },
    ],
  };
  const created = await app.refineHarness(sessionId, complete);
  await ui.command(`/harness approve ${created.proposalDigest!.slice(0, 8)}`);
  const shown = ui.confirmation!.lines.join("\n");
  assert.match(shown, /"rollbackId": "restore-old-entry"/);
  assert.match(shown, /"content": "content field remains visible too"/);
  assert.match(shown, /"promptAddendum": "only this is the approved prompt text/);
  assert.ok(shown.includes("\\u202e"));
  assert.ok(shown.includes("\\u0085"));
  assert.ok(shown.includes("\\u200b"));
  assert.ok(!shown.includes("\u202e"));
  assert.ok(!shown.includes("\u0085"));
  assert.ok(!shown.includes("\u200b"));
});
