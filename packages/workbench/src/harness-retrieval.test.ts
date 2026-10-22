import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workbench } from "./index.ts";

async function setup(t: any) {
  const directory = await mkdtemp(join(tmpdir(), "void-hr-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fetcher = (async (url: unknown) =>
    String(url).endsWith("/models")
      ? Response.json({ data: [{ id: "fixture" }] })
      : Response.json({ choices: [{ message: { role: "assistant", content: "Done" } }] })) as typeof fetch;
  const app = new Workbench({ VOID_DATA_DIR: directory }, fetcher);
  await app.configure({ baseUrl: "https://fixture.test/v1", apiKey: "fixture" });
  const internals = app as unknown as {
    evidence: Record<string, unknown[]>;
    proposeHarnessLearning(workspace: string, policyDigest?: string): Promise<{ id: string; digest: string }>;
    approveHarnessProposal(id: string, operator: string, expectedDigest: string): unknown;
    activateHarnessProposal(id: string): unknown;
    retrieveHarnessContext(workspace: string, currentRunId: string | undefined, options?: any): { entries: any[]; truncated: boolean; tokenEstimate: number };
    harnessProposalsFor(workspace: string): { id: string }[];
    canProposeHarnessLearning(workspace: string, cooldownMs?: number, settledTurns?: number, policyDigest?: string): { ok: boolean; reason: string };
    harnessEvaluation(workspace: string): { firstPassRate: string; activatedCount: number };
  };
  const workspace = "w";
  internals.evidence[workspace] = [
    { body: { tool: "t", klass: "r1", decision: "deny:policy", source: "harness", runId: "run-1" } },
    { body: { tool: "t", klass: "r1", decision: "deny:policy", source: "harness", runId: "run-1" } },
    { body: { tool: "t", klass: "r1", decision: "deny:policy", source: "harness", runId: "run-1" } },
  ];
  const proposal = await internals.proposeHarnessLearning(workspace);
  internals.approveHarnessProposal(proposal.id, "op", proposal.digest);
  internals.activateHarnessProposal(proposal.id);
  return { app, internals, workspace, directory };
}

test("retrieval excludes the producing run", async (t) => {
  const { internals, workspace } = await setup(t);
  const ctx = internals.retrieveHarnessContext(workspace, "run-1", {});
  assert.equal(ctx.entries.length, 0);
});

test("retrieval includes activated proposals for other runs", async (t) => {
  const { internals, workspace } = await setup(t);
  const ctx = internals.retrieveHarnessContext(workspace, "other-run", {});
  assert.ok(ctx.entries.length > 0);
});

test("retrieval is bounded by entryBudget", async (t) => {
  const { internals, workspace } = await setup(t);
  const ctx = internals.retrieveHarnessContext(workspace, "other-run", { entryBudget: 0 });
  assert.equal(ctx.entries.length, 0);
  assert.equal(ctx.truncated, true);
});

test("review gate refuses while a run is in flight", async (t) => {
  const { app, internals, workspace } = await setup(t);
  const wi = app as unknown as { harnessRunIds: Set<string> };
  wi.harnessRunIds.add("inflight");
  const gate = internals.canProposeHarnessLearning(workspace, 0);
  assert.equal(gate.ok, false);
  assert.match(gate.reason, /in flight/);
});

test("evaluation reports first_pass_rate as unavailable", async (t) => {
  const { internals, workspace } = await setup(t);
  const ev = internals.harnessEvaluation(workspace);
  assert.equal(ev.firstPassRate, "unavailable");
  assert.ok(ev.activatedCount >= 1);
});


test("review gate refuses without a settled turn", async (t) => {
  const { internals, workspace } = await setup(t);
  const gate = internals.canProposeHarnessLearning(workspace, 0, 0, undefined);
  assert.equal(gate.ok, false);
  assert.match(gate.reason, /settled/);
});

test("review gate refuses on policy version mismatch", async (t) => {
  const { internals, workspace } = await setup(t);
  // store a policy digest by creating a proposal
  await internals.proposeHarnessLearning(workspace, "pd-1");
  const gate = internals.canProposeHarnessLearning(workspace, 0, 1, "pd-2");
  assert.equal(gate.ok, false);
  assert.match(gate.reason, /version/);
});


test("retrieval is deterministic for the same chain", async (t) => {
  const { internals, workspace } = await setup(t);
  const a = internals.retrieveHarnessContext(workspace, "other-run", {});
  const b = internals.retrieveHarnessContext(workspace, "other-run", {});
  assert.deepEqual(a.entries.map((e: any) => e.proposalId), b.entries.map((e: any) => e.proposalId));
  assert.equal(a.tokenEstimate, b.tokenEstimate);
});

test("retrieval does not change policy decisions", async (t) => {
  const { internals, workspace } = await setup(t);
  // Retrieval returns context only; policy stays untouched (no mutation).
  const before = internals.harnessProposalsFor(workspace).length;
  internals.retrieveHarnessContext(workspace, "other-run", {});
  const after = internals.harnessProposalsFor(workspace).length;
  assert.equal(before, after);
});
