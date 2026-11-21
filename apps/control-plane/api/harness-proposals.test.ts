import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workbench } from "../../../packages/workbench/src/index.ts";
import { listenControlPlane } from "./server.ts";
import type { RefinementProposal } from "../../../packages/workbench/src/refine-pass.ts";

/**
 * The harness proposals an operator has to decide, over HTTP.
 *
 * The terminal had this path and the web surface did not, so an operator who
 * works in the browser could not approve what the harness learned, which is
 * the one action the learning loop exists for. What these prove: the pending
 * proposals are listable with the digest a decision binds to, an approval
 * activates exactly that digest, a rejection removes the proposal without
 * activating it, and the refusals read as refusals: an unknown session is a
 * 404 and a digest nobody proposed is the workbench's own sentence.
 */

const fetcher = async (url: unknown) =>
  String(url).endsWith("/models")
    ? Response.json({ data: [{ id: "fixture" }] })
    : Response.json({ choices: [{ message: { role: "assistant", content: "Ready" } }] });

const proposal = (title: string): RefinementProposal => ({
  summary: "repeated lesson",
  rationale: "supported by signed records",
  expectedOutcome: "fewer repeated approvals",
  edits: [{
    action: "create",
    kind: "memory",
    title,
    content: "The operator repeatedly approved the same action.",
    derivedFromSeq: [1],
    reason: "the pattern repeats",
  }],
});

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "void-api-harness-proposals-"));
  const app = new Workbench({ NOMO_DATA_DIR: root }, fetcher as typeof fetch);
  await app.configure({ baseUrl: "https://fixture.test/v1", apiKey: "fixture" });
  const session = await app.start("Review the workspace", "fixture");
  await app.settled();
  // The seed record gives the proposal a ledger sequence to cite.
  await app.editDocument(session.id, {
    path: "source.md",
    content: "signed source record",
    expectedRevision: null,
  });
  const server = await listenControlPlane({
    env: { NOMO_DATA_DIR: root },
    workbench: app,
  });
  t.after(async () => {
    await server.close();
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.port}`;
  return {
    app,
    session,
    origin,
    list: async () =>
      (await (
        await fetch(`${origin}/api/sessions/${session.id}/harness/proposals`)
      ).json()) as {
        proposals: { digest: string; summary: string; proposal: RefinementProposal }[];
      },
    decide: (
      digest: string,
      action: "approve" | "reject" | "rollback" | "promote",
      body?: unknown,
    ) =>
      fetch(`${origin}/api/sessions/${session.id}/harness/proposals/${digest}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      }),
  };
}

test("GET lists the pending proposals with the digest a decision binds to", async (t) => {
  const f = await fixture(t);
  const created = await f.app.refineHarness(f.session.id, proposal("approval pattern"));

  const listed = await f.list();

  assert.equal(listed.proposals.length, 1);
  assert.equal(listed.proposals[0]!.digest, created.proposalDigest);
  assert.equal(listed.proposals[0]!.summary, "repeated lesson");
  assert.equal(
    listed.proposals[0]!.proposal.edits[0]!.title,
    "approval pattern",
  );
});

test("POST approve activates the named digest and the proposal stops being pending", async (t) => {
  const f = await fixture(t);
  const created = await f.app.refineHarness(f.session.id, proposal("approval pattern"));

  const approved = await f.decide(created.proposalDigest!, "approve");

  assert.equal(approved.status, 200);
  const body = (await approved.json()) as { applied: unknown[] };
  assert.equal(body.applied.length, 1);
  const listed = await f.list();
  assert.deepEqual(listed.proposals, []);
  const entries = await f.app.harnessEntries(f.session.workspace);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.content, "The operator repeatedly approved the same action.");
});

test("POST reject records the rejection and nothing is activated", async (t) => {
  const f = await fixture(t);
  const created = await f.app.refineHarness(f.session.id, proposal("approval pattern"));

  const rejected = await f.decide(created.proposalDigest!, "reject", {
    reason: "one call is not a pattern",
  });

  assert.equal(rejected.status, 200);
  const listed = await f.list();
  assert.deepEqual(listed.proposals, []);
  assert.deepEqual(await f.app.harnessEntries(f.session.workspace), []);
});

test("an unknown session reads 404 and an unknown digest reads as refused", async (t) => {
  const f = await fixture(t);
  const unknownSession = await fetch(
    `${f.origin}/api/sessions/00000000-0000-4000-8000-000000000000/harness/proposals`,
  );
  assert.equal(unknownSession.status, 404);
  const body = (await unknownSession.json()) as { message?: string };
  assert.equal(body.message, "Session not found.");

  const unknownDigest = await f.decide("a".repeat(64), "approve");
  assert.notEqual(unknownDigest.status, 200);
  const refused = (await unknownDigest.json()) as { message?: string };
  assert.match(refused.message ?? "", /No pending refinement matches that digest\./);
});

test("POST rollback undoes an activation and the lesson stops being read", async (t) => {
  const f = await fixture(t);
  const created = await f.app.refineHarness(f.session.id, proposal("approval pattern"));
  await f.decide(created.proposalDigest!, "approve");
  assert.equal((await f.app.harnessEntries(f.session.workspace)).length, 1);

  const rolled = await f.decide(created.proposalDigest!, "rollback");

  assert.equal(rolled.status, 200);
  const body = (await rolled.json()) as { applied: unknown[] };
  assert.equal(body.applied.length, 1);
  assert.deepEqual(await f.app.harnessEntries(f.session.workspace), []);
});

test("POST rollback of a digest nobody activated reads as refused", async (t) => {
  const f = await fixture(t);
  const rolled = await f.decide("b".repeat(64), "rollback");
  assert.notEqual(rolled.status, 200);
  const refused = (await rolled.json()) as { message?: string };
  assert.match(refused.message ?? "", /No activated refinement matches that digest\./);
});

test("POST promote carries an activation to every conversation and POST demote ends it", async (t) => {
  const f = await fixture(t);
  const created = await f.app.refineHarness(f.session.id, proposal("approval pattern"));
  await f.decide(created.proposalDigest!, "approve");

  const promoted = await f.decide(created.proposalDigest!, "promote");

  assert.equal(promoted.status, 200);
  const body = (await promoted.json()) as { digest: string; entries: unknown[] };
  assert.match(body.digest, /^[a-f0-9]{64}$/);
  assert.equal(body.entries.length, 1);
  const list = async () =>
    (await (await fetch(`${f.origin}/api/harness/promotions`)).json()) as {
      promotions: { digest: string; status: string }[];
      entries: { content: string }[];
    };
  const standing = await list();
  assert.deepEqual(
    standing.promotions.map((item) => [item.digest, item.status]),
    [[body.digest, "promoted"]],
  );
  assert.deepEqual(
    standing.entries.map((entry) => entry.content),
    ["The operator repeatedly approved the same action."],
  );

  const demote = () =>
    fetch(`${f.origin}/api/harness/promotions/${body.digest}/demote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  assert.equal((await demote()).status, 200);
  const after = await list();
  assert.deepEqual(after.promotions.map((item) => item.status), ["demoted"]);
  assert.deepEqual(after.entries, []);
  const twice = await demote();
  assert.notEqual(twice.status, 200);
  assert.match(((await twice.json()) as { message?: string }).message ?? "", /That promotion is already demoted\./);
});
