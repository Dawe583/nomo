/** H4 required audit test: operator-visible before/after snapshots, parent bound, additive harnessProfile and named rollback ids. */
import test from "node:test";
import assert from "node:assert/strict";
import { runHarnessCommand } from "../../cli/src/harness.ts";
import type { AgentProfile } from "./agents.ts";
import type { RefinementProposal } from "./refine-pass.ts";
import { isolatedWorkbench } from "./test-fixture.ts";

const fetcher: typeof fetch = async (url) =>
  String(url).endsWith("/models")
    ? Response.json({ data: [{ id: "fixture" }] })
    : Response.json({
        choices: [{ message: { role: "assistant", content: "Done" }, finish_reason: "stop" }],
      });

const baseProfile: AgentProfile = {
  id: "audit-helper",
  name: "Audit helper",
  systemPrompt: "Inspect the signed workspace.",
  allowedTools: ["void_workspace_list"],
  policyProfile: "default",
  maxTurns: 2,
  maxContextTokens: 4096,
};

function profileProposal(
  action: "create" | "update" | "delete",
  derivedFromSeq: number,
  profile: AgentProfile = baseProfile,
): RefinementProposal {
  return {
    summary: `Profile ${action} for ${profile.id}`,
    rationale: "Repeated narrow reads justify a dedicated helper profile.",
    expectedOutcome: "Operator sees exact before, after and parent bound.",
    edits: [{
      action,
      kind: "subagent",
      ...(action === "create" ? {} : { id: profile.id }),
      ...(action === "delete" ? {} : { profile }),
      derivedFromSeq: [derivedFromSeq],
      reason: "Supported by the verified chain.",
    }] as unknown as RefinementProposal["edits"],
  };
}

test("review surface exposes before, after and parentBound, and signed chain records harnessProfile and restoredIds", async (t) => {
  const { app } = await isolatedWorkbench(t, fetcher, {}, { prefix: "nomo-h4-audit-" });
  app.upsertAgent({
    id: "audit-parent",
    name: "Audit parent",
    systemPrompt: "Work inside narrow bounds.",
    allowedTools: ["void_workspace_list", "void_workspace_read"],
    policyProfile: "default",
    maxTurns: 4,
    maxContextTokens: 8192,
  });
  const session = await app.start("Start", "fixture", undefined, undefined, "audit-parent");
  await app.settled();
  await app.editDocument(session.id, {
    path: "note.md",
    content: "evidence",
    expectedRevision: null,
  });
  const seq1 = (await app.ledger(session.workspace))!.entries.at(-1)!.seq;

  const created = await app.refineHarness(session.id, profileProposal("create", seq1));
  const pendingCreate = (await app.pendingApprovalsFor(session.id))[0] as any;
  assert.ok(pendingCreate?.profileReview, "pending approval must expose profileReview");
  assert.deepEqual(pendingCreate.profileReview.parentBound, {
    allowedTools: ["void_workspace_list", "void_workspace_read"],
    policyProfile: "default",
    maxTurns: 4,
    maxContextTokens: 8192,
  });
  assert.deepEqual(pendingCreate.profileReview.edits, [{
    id: "audit-helper",
    action: "create",
    before: null,
    after: baseProfile,
  }]);

  const out: string[] = [];
  const err: string[] = [];
  const cliCode = await runHarnessCommand(
    ["list", "--session", session.id],
    { stdout: (line) => out.push(line), stderr: (line) => err.push(line) },
    { workbench: async () => app },
  );
  assert.equal(cliCode, 0, err.join("\n"));
  assert.match(out.join("\n"), /parent bound:.*policy=default.*turns=4.*context tokens=8192/);
  assert.match(out.join("\n"), /before: new/);
  assert.match(out.join("\n"), /after: Audit helper/);

  await app.approveHarnessProposal(session.id, created.proposalDigest!);
  const createRecord = (await app.ledger(session.workspace))!.entries.at(-1)!.body as Record<string, any>;
  assert.ok(createRecord.harnessLifecycle.events.includes("profile:promoted"));
  assert.equal(createRecord.harnessProfile.digest, created.proposalDigest);
  assert.equal(typeof createRecord.harnessProfile.atSeq, "number");
  assert.deepEqual(createRecord.harnessProfile.parentBound, {
    allowedTools: ["void_workspace_list", "void_workspace_read"],
    policyProfile: "default",
    maxTurns: 4,
    maxContextTokens: 8192,
  });
  assert.deepEqual(createRecord.harnessProfile.changes, [{
    id: "audit-helper",
    before: null,
    after: baseProfile,
  }]);

  const nextProfile: AgentProfile = {
    ...baseProfile,
    systemPrompt: "Inspect and summarize only.",
  };
  const seq2 = (await app.ledger(session.workspace))!.entries.at(-1)!.seq;
  const updated = await app.refineHarness(session.id, profileProposal("update", seq2, nextProfile));
  const pendingUpdate = (await app.pendingApprovalsFor(session.id))[0] as any;
  assert.deepEqual(pendingUpdate?.profileReview?.edits, [{
    id: "audit-helper",
    action: "update",
    before: baseProfile,
    after: nextProfile,
  }]);

  await app.approveHarnessProposal(session.id, updated.proposalDigest!);
  assert.deepEqual(await app.promotedAgentProfiles(session.workspace), [nextProfile]);

  await app.rollbackHarnessProposal(session.id, updated.proposalDigest!);
  const rollbackRecord = (await app.ledger(session.workspace))!.entries.at(-1)!.body as Record<string, any>;
  assert.ok(rollbackRecord.harnessLifecycle.events.includes("profile:rolled-back"));
  assert.equal(rollbackRecord.harnessProfile.approvedBy, "rollback");
  assert.deepEqual(rollbackRecord.harnessProfile.restoredIds, ["audit-helper"]);
  assert.deepEqual(rollbackRecord.harnessProfile.removedIds, []);
  assert.deepEqual(await app.promotedAgentProfiles(session.workspace), [baseProfile]);
});
