import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workbench } from "./index.ts";
import { buildHarnessContext } from "./context.ts";
import { decide } from "../../policy/src/decide.ts";
import { loadPolicy } from "../../policy/src/rules.ts";
import type { HarnessEntry } from "./learned-harness.ts";
import type { RefinementProposal } from "./refine-pass.ts";

/**
 * Retrieval is the read half of the learning loop: verified, approved entries
 * reconstructed from the workspace chain, ranked for the next prompt and
 * bounded, reaching only later turns. Nothing here may change `decide`, and a
 * turn that mined the entries must not see them; otherwise the loop would
 * approve its own evidence.
 */

const LESSON = "The operator repeatedly approved the same inventory report.";
const QUERY = "Has the operator approved similar reports before?";

const bodies: unknown[] = [];
const capturing = async (url: unknown, init?: { body?: unknown }) => {
  if (String(url).endsWith("/models"))
    return Response.json({ data: [{ id: "fixture" }] });
  if (typeof init?.body === "string") bodies.push(JSON.parse(init.body));
  return Response.json({
    choices: [{ message: { role: "assistant", content: "Done." } }],
  });
};

const systemTexts = (body: unknown): string => {
  const messages =
    (body as { messages?: Array<{ role?: string; content?: unknown }> })
      .messages ?? [];
  return messages
    .filter((message) => message.role === "system")
    .map((message) => String(message.content ?? ""))
    .join("\n");
};

const lessonProposal = (): RefinementProposal => ({
  summary: "repeated lesson",
  rationale: "supported by signed records",
  expectedOutcome: "fewer repeated approvals",
  edits: [
    {
      action: "create",
      kind: "memory",
      title: "approval pattern",
      content: LESSON,
      derivedFromSeq: [1],
      reason: "the pattern repeats",
    },
  ],
});

const fixture = async (t: { after(fn: () => Promise<void>): void }) => {
  bodies.length = 0;
  const directory = await mkdtemp(join(tmpdir(), "nomo-harness-retrieval-"));
  const app = new Workbench({ NOMO_DATA_DIR: directory }, capturing);
  let appClosed = false;
  await app.configure({
    baseUrl: "https://fixture.test/v1",
    apiKey: "fixture",
  });
  const session = await app.start("Review the inventory", "fixture");
  await app.settled();
  await app.editDocument(session.id, {
    path: "source.md",
    content: "signed source record",
    expectedRevision: null,
  });
  t.after(async () => {
    if (!appClosed) await app.shutdown();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    app,
    session,
    directory,
    async closeOriginal() {
      appClosed = true;
      await app.shutdown();
    },
  };
};

test("a follow-up turn retrieves the approved lesson, the mining turn does not", async (t) => {
  const { app, session } = await fixture(t);
  const firstBodies = [...bodies];
  assert.ok(firstBodies.length > 0);
  assert.ok(
    firstBodies.every(
      (body) => !systemTexts(body).includes("learned-entry digest"),
    ),
    "the turn that produced nothing yet must not carry a digest",
  );

  await app.refineHarness(session.id, lessonProposal());
  bodies.length = 0;
  app.send(session.id, QUERY);
  await app.settled();

  const followup = bodies.map(systemTexts).join("\n");
  assert.ok(
    followup.includes("learned-entry digest"),
    "a later turn in the same workspace must carry the digest",
  );
  assert.ok(
    followup.includes(LESSON),
    "the digest must carry the approved lesson text",
  );
});

test("entries never cross into another workspace", async (t) => {
  const { app, session } = await fixture(t);
  await app.refineHarness(session.id, lessonProposal());

  bodies.length = 0;
  const other = await app.start("Review the inventory", "fixture");
  await app.settled();
  app.send(other.id, QUERY);
  await app.settled();

  const texts = bodies.map(systemTexts).join("\n");
  assert.ok(
    !texts.includes("learned-entry digest"),
    "a different workspace must not see the lesson",
  );
  assert.deepEqual(await app.harnessEntries(other.workspace), []);
});

test("a fresh workspace starts with no context", async (t) => {
  const { app } = await fixture(t);
  assert.equal(
    buildHarnessContext(
      await app.harnessEntries("workspace-that-never-existed"),
      QUERY,
      2000,
    ),
    "",
  );
});

test("retrieval is bounded by the caller-supplied ceiling", async () => {
  const entry: HarnessEntry = {
    id: "lesson:doc.read:r0:long",
    kind: "lesson",
    scope: "workspace",
    tool: "doc.read",
    klass: "r0",
    title: "approval pattern",
    content: `${LESSON} ${LESSON} ${LESSON}`,
    derivedFromSeq: [1],
    repeats: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const full = buildHarnessContext([entry], QUERY, 2000);
  assert.ok(full.includes(LESSON));
  const bounded = buildHarnessContext([entry], QUERY, 64);
  assert.ok(
    bounded.length <= 64,
    `expected at most 64 chars, got ${bounded.length}`,
  );
  assert.equal(buildHarnessContext([], QUERY, 2000), "");
});

test("same-workspace retrieval reconstructs after a restart", async (t) => {
  const { app, session, directory, closeOriginal } = await fixture(t);
  await app.refineHarness(session.id, lessonProposal());
  const before = buildHarnessContext(
    await app.harnessEntries(session.workspace),
    QUERY,
    2000,
  );
  assert.ok(before.includes(LESSON));
  await closeOriginal();

  const reopened = new Workbench({ NOMO_DATA_DIR: directory }, capturing);
  try {
    const after = buildHarnessContext(
      await reopened.harnessEntries(session.workspace),
      QUERY,
      2000,
    );
    assert.ok(
      after.includes(LESSON),
      "reopening over the same directory must rebuild the same context",
    );
  } finally {
    await reopened.shutdown();
  }
});

test("retrieval leaves policy decisions unchanged", async (t) => {
  const { app, session } = await fixture(t);
  const policyText = [
    "version: 1",
    "rules:",
    "  - match: { tool: doc.read }",
    "    decision: allow",
    "  - match: {}",
    "    decision: deny",
  ].join("\n");
  const policy = loadPolicy(policyText);
  assert.equal(policy.ok, true);
  if (!policy.ok) return;
  const call = {
    tool: "doc.read",
    connector: "workspace",
    workspace: session.workspace,
    klass: "r0",
    blastRadius: 1,
  };
  const before = decide(policy, call);

  await app.refineHarness(session.id, lessonProposal());
  const context = buildHarnessContext(
    await app.harnessEntries(session.workspace),
    QUERY,
    2000,
  );
  assert.ok(
    context.includes(LESSON),
    "retrieval must have run for this test to mean anything",
  );

  const after = decide(loadPolicy(policyText), call);
  assert.deepEqual(after, before);
});
