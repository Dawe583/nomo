import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workbench } from "./index.ts";

test("a proposal is created inert and does not activate itself", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "void-hp-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fetcher = (async (url: unknown) =>
    String(url).endsWith("/models")
      ? Response.json({ data: [{ id: "fixture" }] })
      : Response.json({ choices: [{ message: { role: "assistant", content: "Done" } }] })) as typeof fetch;
  const app = new Workbench({ VOID_DATA_DIR: directory }, fetcher);
  await app.configure({ baseUrl: "https://fixture.test/v1", apiKey: "fixture" });

  const internals = app as unknown as {
    evidence: Record<string, unknown[]>;
    proposeHarnessLearning(workspace: string, policyDigest?: string): Promise<unknown>;
    harnessProposalsFor(workspace: string): unknown[];
  };
  const workspace = "w";
  internals.evidence[workspace] = [
    { body: { tool: "void_workspace_delete", klass: "r1", decision: "deny:policy", source: "harness", runId: "run-1" } },
    { body: { tool: "void_workspace_delete", klass: "r1", decision: "deny:policy", source: "harness", runId: "run-1" } },
    { body: { tool: "void_workspace_delete", klass: "r1", decision: "deny:policy", source: "harness", runId: "run-1" } },
  ];
  const proposal = (await internals.proposeHarnessLearning(workspace, "pd-1")) as {
    status: string;
    digest: string;
    workspace: string;
    policyDigest?: string;
  };
  assert.equal(proposal.status, "inert");
  assert.equal(proposal.workspace, workspace);
  assert.equal(proposal.policyDigest, "pd-1");
  assert.ok(proposal.digest.length > 0);
  await app.shutdown();
});

test("approval binds the exact digest", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "void-hp2-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fetcher = (async (url: unknown) =>
    String(url).endsWith("/models")
      ? Response.json({ data: [{ id: "fixture" }] })
      : Response.json({ choices: [{ message: { role: "assistant", content: "Done" } }] })) as typeof fetch;
  const app = new Workbench({ VOID_DATA_DIR: directory }, fetcher);
  await app.configure({ baseUrl: "https://fixture.test/v1", apiKey: "fixture" });
  const internals = app as unknown as {
    evidence: Record<string, unknown[]>;
    proposeHarnessLearning(workspace: string): Promise<{ id: string; digest: string }>;
    approveHarnessProposal(id: string, operator: string, expectedDigest: string): { status: string };
  };
  const workspace = "w";
  internals.evidence[workspace] = [
    { body: { tool: "t", klass: "r1", decision: "deny:policy", source: "harness", runId: "r" } },
    { body: { tool: "t", klass: "r1", decision: "deny:policy", source: "harness", runId: "r" } },
    { body: { tool: "t", klass: "r1", decision: "deny:policy", source: "harness", runId: "r" } },
  ];
  const proposal = await internals.proposeHarnessLearning(workspace);
  // mismatched digest refused
  assert.throws(() => internals.approveHarnessProposal(proposal.id, "op", "wrong"), /digest mismatch/);
  const approved = internals.approveHarnessProposal(proposal.id, "op", proposal.digest);
  assert.equal(approved.status, "approved");
  await app.shutdown();
});

test("activation requires approval", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "void-hp3-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fetcher = (async (url: unknown) =>
    String(url).endsWith("/models")
      ? Response.json({ data: [{ id: "fixture" }] })
      : Response.json({ choices: [{ message: { role: "assistant", content: "Done" } }] })) as typeof fetch;
  const app = new Workbench({ VOID_DATA_DIR: directory }, fetcher);
  await app.configure({ baseUrl: "https://fixture.test/v1", apiKey: "fixture" });
  const internals = app as unknown as {
    evidence: Record<string, unknown[]>;
    proposeHarnessLearning(workspace: string): Promise<{ id: string }>;
    activateHarnessProposal(id: string): { status: string };
  };
  const workspace = "w";
  internals.evidence[workspace] = [
    { body: { tool: "t", klass: "r1", decision: "deny:policy", source: "harness", runId: "r" } },
    { body: { tool: "t", klass: "r1", decision: "deny:policy", source: "harness", runId: "r" } },
    { body: { tool: "t", klass: "r1", decision: "deny:policy", source: "harness", runId: "r" } },
  ];
  const proposal = await internals.proposeHarnessLearning(workspace);
  assert.throws(() => internals.activateHarnessProposal(proposal.id), /not approved/);
  await app.shutdown();
});

test("tombstone marks a proposal", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "void-hp4-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fetcher = (async (url: unknown) =>
    String(url).endsWith("/models")
      ? Response.json({ data: [{ id: "fixture" }] })
      : Response.json({ choices: [{ message: { role: "assistant", content: "Done" } }] })) as typeof fetch;
  const app = new Workbench({ VOID_DATA_DIR: directory }, fetcher);
  await app.configure({ baseUrl: "https://fixture.test/v1", apiKey: "fixture" });
  const internals = app as unknown as {
    evidence: Record<string, unknown[]>;
    proposeHarnessLearning(workspace: string): Promise<{ id: string; digest: string }>;
    approveHarnessProposal(id: string, operator: string, expectedDigest: string): unknown;
    tombstoneHarnessProposal(id: string, reason: string): { status: string };
  };
  const workspace = "w";
  internals.evidence[workspace] = [
    { body: { tool: "t", klass: "r1", decision: "deny:policy", source: "harness", runId: "r" } },
    { body: { tool: "t", klass: "r1", decision: "deny:policy", source: "harness", runId: "r" } },
    { body: { tool: "t", klass: "r1", decision: "deny:policy", source: "harness", runId: "r" } },
  ];
  const proposal = await internals.proposeHarnessLearning(workspace);
  internals.approveHarnessProposal(proposal.id, "op", proposal.digest);
  const tombstoned = internals.tombstoneHarnessProposal(proposal.id, "no longer relevant");
  assert.equal(tombstoned.status, "tombstoned");
  await app.shutdown();
});
