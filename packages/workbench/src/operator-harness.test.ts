import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { isolatedWorkbench } from "./test-fixture.ts";
import type { RefinementProposal } from "./refine-pass.ts";

const LESSON = "The operator keeps reopening the same postgres migration after hold.";

const models = () => Response.json({ data: [{ id: "fixture" }] });
const answer = () =>
  Response.json({ choices: [{ message: { role: "assistant", content: "Done" }, finish_reason: "stop" }] });

const proposal = (): RefinementProposal => ({
  summary: "repeated migration hold",
  rationale: "supported by signed records",
  expectedOutcome: "fewer repeated approvals",
  edits: [{
    action: "create",
    kind: "memory",
    title: "migration reopen pattern",
    content: LESSON,
    derivedFromSeq: [1],
    reason: "the pattern repeats",
  }],
});

async function fixture(t: TestContext) {
  const bodies: Array<Record<string, unknown>> = [];
  const capturing = async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("/models")) return models();
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return answer();
  };
  const fixtureHandle = await isolatedWorkbench(t, capturing as typeof fetch, {}, {
    prefix: "nomo-operator-harness-",
  });
  const { app } = fixtureHandle;
  const session = await app.start("Review the migration", "fixture");
  await app.settled();
  await app.editDocument(session.id, {
    path: "source.md",
    content: "signed source record",
    expectedRevision: null,
  });
  return { app, session, bodies, restart: fixtureHandle.restart };
}

function systemTexts(body: Record<string, unknown>): string {
  return ((body.messages ?? []) as Array<{ role: string; content?: unknown }>)
    .filter((message) => message.role === "system")
    .map((message) => String(message.content ?? ""))
    .join("\n");
}

async function activated(app: Awaited<ReturnType<typeof fixture>>["app"], sessionId: string) {
  await app.refineHarness(sessionId, proposal());
  const pending = await app.pendingApprovalsFor(sessionId);
  await app.approveHarnessProposal(sessionId, pending[0]!.digest);
  return pending[0]!.digest;
}

test("a promoted approved entry reaches a new conversation and demotion removes it", async (t) => {
  const { app, session, bodies } = await fixture(t);
  const digest = await activated(app, session.id);

  const promoted = await app.promoteHarnessProposal(session.id, digest);
  assert.equal(promoted.entries, 1);
  const operatorEntries = await app.operatorHarnessEntries();
  assert.equal(operatorEntries.length, 1);
  assert.equal(operatorEntries[0]!.scope, "operator");
  assert.equal(operatorEntries[0]!.decidedByOperator, true);

  bodies.length = 0;
  await app.start("What did we learn about postgres migrations?", "fixture");
  await app.settled();
  const firstTurn = bodies.map(systemTexts).join("\n");
  assert.match(firstTurn, /Operator-approved instructions for every conversation/);
  assert.ok(firstTurn.includes(LESSON));

  await app.demoteHarnessPromotion(digest);
  assert.deepEqual(await app.operatorHarnessEntries(), []);

  bodies.length = 0;
  await app.start("What did we learn about postgres migrations now?", "fixture");
  await app.settled();
  assert.doesNotMatch(bodies.map(systemTexts).join("\n"), new RegExp(LESSON.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("only an activated operator-approved digest can be promoted", async (t) => {
  const { app, session } = await fixture(t);
  await app.refineHarness(session.id, proposal());
  const pending = await app.pendingApprovalsFor(session.id);
  await assert.rejects(
    app.promoteHarnessProposal(session.id, pending[0]!.digest),
    /No activated refinement matches/,
  );
});

test("a rolled-back refinement can no longer be promoted", async (t) => {
  const { app, session } = await fixture(t);
  const digest = await activated(app, session.id);
  await app.rollbackHarnessProposal(session.id, digest);
  await assert.rejects(
    app.promoteHarnessProposal(session.id, digest),
    /rolled back/,
  );
});

test("a promoted operator chain survives restart and a demotion cannot repeat", async (t) => {
  const { app, session, restart } = await fixture(t);
  const digest = await activated(app, session.id);
  await app.promoteHarnessProposal(session.id, digest);
  app.close();
  const reopened = restart({ keepOpen: true });
  assert.equal((await reopened.operatorHarnessEntries()).length, 1);
  await reopened.demoteHarnessPromotion(digest);
  assert.deepEqual(await reopened.operatorHarnessEntries(), []);
  await assert.rejects(reopened.demoteHarnessPromotion(digest), /No active harness promotion/);
});
