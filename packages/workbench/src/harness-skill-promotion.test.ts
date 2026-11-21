/**
 * Workbench integration for H4b governed markdown skill promotion.
 *
 * `packages/workbench/src/skill-promotion.ts` landed as a pure contract with
 * its own unit tests, and the design record left the write path to a separate
 * slice: `approveHarnessProposal` writes `harnessProfile` and `profile:activated`
 * for a subagent, but a `skill` edit still activates as a lesson entry and the
 * workbench has no way to read a promoted skill back. These tests are the
 * failing-first statement of that missing path, so they name the surface they
 * need instead of waiting for it to exist:
 *
 * - `promotedSkills(workspace)` replays the verified chain into the skills a
 *   conversation reads.
 * - `pendingApprovalsFor(session)` exposes `skillReview`, the before/after diff
 *   an operator approves, in the shape `prepareSkillPromotion` produces.
 * - an approval writes the signed `harnessSkill` record plus `skill:promoted`,
 *   a rollback writes `skill:rolled-back` with `approvedBy: "rollback"`.
 *
 * The narrow local `SkillPromotionSurface` below is why `tsc` passes before
 * `index.ts` grows the method and `node --test` still fails: the type says what
 * the write path must provide, and the runtime call reaches a method the
 * workbench does not have yet.
 *
 * Everything asserted here is behavioural. A skill is guidance: it never
 * becomes a file, never enters the tool catalog, never moves a policy decision,
 * and its prompt block is transient.
 */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

import { loadPolicy } from "../../policy/src/rules.ts";
import { decide } from "../../policy/src/decide.ts";
import type { Workbench } from "./index.ts";
import { DEFAULT_POLICY } from "./policy-profile.ts";
import type { RefinementProposal } from "./refine-pass.ts";
import { isolatedWorkbench } from "./test-fixture.ts";

const SKILL_ID = "check-migrations";
const SKILL_TITLE = "Check migrations before a deploy";
const SKILL_BODY = [
  "## Steps",
  "",
  "1. List the pending migrations with the project's own command.",
  "2. Apply them to a scratch copy before the shared database.",
].join("\n");
const UPDATED_BODY = [
  "## Steps",
  "",
  "1. List the pending migrations with the project's own command.",
  "2. Take a backup of the shared database first.",
  "3. Apply them to a scratch copy, then to the shared database.",
].join("\n");

/** A skill as the review surface and the replay must both describe it. */
type SkillView = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly body: string;
};

type SkillChangeView = {
  readonly id: string;
  readonly before: SkillView | null;
  readonly after: SkillView | null;
};

type SkillReviewView = {
  readonly digest: string;
  readonly atSeq: number;
  readonly changes: readonly SkillChangeView[];
};

/**
 * The part of the workbench this file needs and the write path does not have
 * yet. Declared here so the contract is checked by `tsc` without editing
 * `index.ts`, which belongs to the wiring slice.
 */
type SkillPromotionSurface = {
  promotedSkills(workspace: string): Promise<readonly SkillView[]>;
};

/** A pending approval carrying a skill edit. `skillReview` is the new field. */
type PendingSkillApproval = {
  readonly digest: string;
  readonly atSeq: number;
  readonly skillReview?: SkillReviewView;
};

type LedgerBody = Record<string, any>;

const models = () => Response.json({ data: [{ id: "fixture" }] });
const answer = () =>
  Response.json({
    choices: [
      { message: { role: "assistant", content: "Done" }, finish_reason: "stop" },
    ],
  });

/**
 * A workbench over a temporary root, with every provider request captured.
 * The captured bodies are what a "the prompt carries this" claim rests on, so
 * they are collected rather than inferred from the workbench's own view.
 */
async function fixture(t: TestContext, extraEnv: Record<string, string> = {}) {
  const bodies: Array<Record<string, unknown>> = [];
  const capturing = async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("/models")) return models();
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return answer();
  };
  const f = await isolatedWorkbench(t, capturing as typeof fetch, extraEnv, {
    prefix: "nomo-h4b-skill-promotion-",
  });
  const app = f.app;
  const session = await app.start("Review the migration history", "fixture");
  await app.settled();
  // One signed record for the proposal to cite, so provenance has a real
  // sequence to verify rather than a bare 1.
  await app.editDocument(session.id, {
    path: "source.md",
    content: "signed source record",
    expectedRevision: null,
  });
  return {
    root: f.root,
    app,
    session,
    bodies,
    async closeOriginal() {
      await app.shutdown();
    },
    reopen() {
      return f.restart({ keepOpen: true });
    },
  };
}

function surfaceOf(app: Workbench): SkillPromotionSurface {
  return app as unknown as SkillPromotionSurface;
}

async function lastSeq(app: Workbench, workspace: string): Promise<number> {
  const proof = await app.ledger(workspace);
  assert.ok(proof);
  return proof.entries.at(-1)!.seq;
}

async function lastBody(app: Workbench, workspace: string): Promise<LedgerBody> {
  const proof = await app.ledger(workspace);
  assert.ok(proof);
  return proof.entries.at(-1)!.body as LedgerBody;
}

async function entryCount(app: Workbench, workspace: string): Promise<number> {
  const proof = await app.ledger(workspace);
  assert.ok(proof);
  return proof.entries.length;
}

function skillProposal(
  action: "create" | "update" | "delete",
  derivedFromSeq: number,
  body: string = SKILL_BODY,
): RefinementProposal {
  return {
    summary: `${action} learned skill ${SKILL_ID}`,
    rationale: "the same migration check repeats across signed turns",
    expectedOutcome: "the next deploy checks migrations before the shared database",
    edits: [
      {
        action,
        kind: "skill",
        id: SKILL_ID,
        ...(action === "delete" ? {} : { title: SKILL_TITLE, content: body }),
        derivedFromSeq: [derivedFromSeq],
        reason: "supported by the verified chain",
      },
    ],
  };
}

/** The one pending approval, read through the surface this slice adds. */
async function pendingSkillReview(app: Workbench, sessionId: string) {
  const pending = (await app.pendingApprovalsFor(
    sessionId,
  )) as unknown as readonly PendingSkillApproval[];
  assert.equal(pending.length, 1, "exactly one proposal waits for the operator");
  const review = pending[0]!.skillReview;
  assert.ok(
    review,
    "a pending approval that carries a skill edit must expose skillReview",
  );
  return { digest: pending[0]!.digest, atSeq: pending[0]!.atSeq, review };
}

/** Every file under the workbench root, relative to it. */
async function listFiles(root: string, base: string = root): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(base, { withFileTypes: true })) {
    const full = join(base, entry.name);
    if (entry.isDirectory()) found.push(...(await listFiles(root, full)));
    else found.push(relative(root, full));
  }
  return found;
}

/** The transient suffix is the last message the provider is handed, and it is
 * a system message: it is removed before the conversation is stored. */
function transientSuffix(body: Record<string, unknown>): string {
  const messages = (body.messages ?? []) as Array<{
    role: string;
    content?: unknown;
  }>;
  assert.equal(
    messages.at(-1)?.role,
    "system",
    "the learned context rides a trailing system message",
  );
  return String(messages.at(-1)?.content ?? "");
}

test("a skill proposal is inert: nothing activates, no file is written, and the diff is reviewable", async (t) => {
  const f = await fixture(t);
  const { app, session } = f;
  const surface = surfaceOf(app);
  const seq = await lastSeq(app, session.workspace);

  const created = await app.refineHarness(session.id, skillProposal("create", seq));

  assert.deepEqual(created.applied, [], "a proposal activates nothing on its own");
  assert.equal(created.awaitingApproval.length, 1);
  assert.ok(created.proposalDigest, "the proposal is signed before it is read");
  assert.deepEqual(
    await surface.promotedSkills(session.workspace),
    [],
    "the workspace reads no promoted skill before the digest is approved",
  );
  assert.deepEqual(
    (await listFiles(f.root)).filter(
      (path) => path.includes(SKILL_ID) || path.endsWith("SKILL.md"),
    ),
    [],
    "a learned skill is never written as a file on disk",
  );

  const pending = await pendingSkillReview(app, session.id);
  assert.equal(pending.digest, created.proposalDigest);
  assert.equal(
    typeof pending.review.atSeq,
    "number",
    "the review names the chain position the approval was given at",
  );
  assert.equal(pending.review.digest, created.proposalDigest);
  assert.deepEqual(
    pending.review.changes.map((change) => change.id),
    [SKILL_ID],
    "the review shows the one id the approval covers",
  );
  const change = pending.review.changes[0]!;
  assert.equal(change.before, null, "a create has no earlier snapshot");
  const after = change.after!;
  assert.equal(after.id, SKILL_ID);
  assert.equal(after.title, SKILL_TITLE);
  assert.equal(
    after.body,
    SKILL_BODY,
    "the operator approves the body verbatim, not a rewritten one",
  );
  assert.equal(typeof after.description, "string");
});

test("a digest approval promotes the skill, replays after restart, and reaches the prompt as labelled guidance", async (t) => {
  const f = await fixture(t);
  const { app, session } = f;
  const surface = surfaceOf(app);
  const seq = await lastSeq(app, session.workspace);
  const created = await app.refineHarness(session.id, skillProposal("create", seq));
  const pending = await pendingSkillReview(app, session.id);
  const promoted = pending.review.changes[0]!.after!;

  // Two observables that must not move when guidance is promoted: the tool
  // catalog with its classifications, and a policy decision over the same
  // loaded rule file. A skill that changed either would be authority.
  const toolsBefore = app.availableTools(session.id);
  const policy = loadPolicy(DEFAULT_POLICY);
  assert.ok(policy.ok);
  const call = {
    tool: "postgres.migration.apply",
    connector: "postgres",
    workspace: session.workspace,
    klass: "r2",
    blastRadius: 1,
  };
  const decisionBefore = decide(policy, call);

  const other = await app.start("Another conversation", "fixture");
  await app.settled();
  assert.notEqual(other.workspace, session.workspace);

  await app.approveHarnessProposal(session.id, created.proposalDigest!);

  const activation = await lastBody(app, session.workspace);
  const events = activation.harnessLifecycle.events as string[];
  assert.ok(
    events.includes("skill:promoted"),
    `the signed lifecycle must name the skill promotion, got ${JSON.stringify(events)}`,
  );
  assert.equal(activation.harnessSkill.digest, created.proposalDigest);
  assert.equal(
    activation.harnessLifecycle.digest,
    activation.harnessSkill.digest,
    "the record and its lifecycle name one digest",
  );
  assert.equal(
    activation.harnessSkill.atSeq,
    pending.atSeq,
    "the record carries the position the approval was given at",
  );
  assert.deepEqual(activation.harnessSkill.changes, [
    { id: SKILL_ID, before: null, after: promoted },
  ]);

  assert.deepEqual(await surface.promotedSkills(session.workspace), [promoted]);
  assert.deepEqual(
    await surface.promotedSkills(other.workspace),
    [],
    "another conversation reads its own chain and sees no skill",
  );
  assert.deepEqual(
    app.availableTools(session.id),
    toolsBefore,
    "a learned skill never changes the tool catalog or its classifications",
  );
  assert.deepEqual(
    decide(policy, call),
    decisionBefore,
    "a learned skill never changes a policy decision",
  );

  f.bodies.length = 0;
  app.send(session.id, "Which migrations are pending?");
  await app.settled();

  const body = f.bodies.at(-1);
  assert.ok(body, "the follow-up turn reached the provider");
  const suffix = transientSuffix(body);
  assert.ok(
    suffix.includes(
      `[Approved learned skill ${SKILL_ID}; not policy or tool authority]`,
    ),
    "the prompt labels the promoted skill as guidance that is not authority",
  );
  assert.equal(
    JSON.stringify(app.get(session.id)!.events).includes("Approved learned skill"),
    false,
    "the block is removed before the conversation is stored",
  );

  await f.closeOriginal();
  const restarted = f.reopen();
  try {
    const reopened = surfaceOf(restarted);
    assert.deepEqual(
      await reopened.promotedSkills(session.workspace),
      [promoted],
      "the promotion is replayed from the verified chain, not from memory",
    );
    assert.deepEqual(await reopened.promotedSkills(other.workspace), []);
  } finally {
    restarted.close();
  }
});

test("an update records both snapshots and a rollback restores them symmetrically", async (t) => {
  const f = await fixture(t);
  const { app, session } = f;
  const surface = surfaceOf(app);

  const created = await app.refineHarness(
    session.id,
    skillProposal("create", await lastSeq(app, session.workspace)),
  );
  const createReview = await pendingSkillReview(app, session.id);
  const original = createReview.review.changes[0]!.after!;
  await app.approveHarnessProposal(session.id, created.proposalDigest!);
  assert.deepEqual(await surface.promotedSkills(session.workspace), [original]);

  const updated = await app.refineHarness(
    session.id,
    skillProposal("update", await lastSeq(app, session.workspace), UPDATED_BODY),
  );
  const updateReview = await pendingSkillReview(app, session.id);
  const change = updateReview.review.changes[0]!;
  assert.equal(
    change.before?.body,
    original.body,
    "an update shows the text it replaces",
  );
  assert.equal(change.after?.body, UPDATED_BODY);

  await app.approveHarnessProposal(session.id, updated.proposalDigest!);
  const activation = await lastBody(app, session.workspace);
  assert.deepEqual(
    activation.harnessSkill.changes,
    [{ id: SKILL_ID, before: original, after: change.after }],
    "the signed record carries both snapshots",
  );
  assert.deepEqual(await surface.promotedSkills(session.workspace), [change.after]);

  await app.rollbackHarnessProposal(session.id, updated.proposalDigest!);
  const rollback = await lastBody(app, session.workspace);
  assert.ok(
    (rollback.harnessLifecycle.events as string[]).includes("skill:rolled-back"),
    "the rollback is signed as its own lifecycle event",
  );
  assert.equal(
    rollback.harnessSkill.approvedBy,
    "rollback",
    "restored text is not a fresh operator instruction",
  );
  assert.deepEqual(rollback.harnessSkill.restoredIds, [SKILL_ID]);
  assert.deepEqual(
    await surface.promotedSkills(session.workspace),
    [original],
    "the rollback restores the snapshot the promotion signed",
  );

  await app.rollbackHarnessProposal(session.id, created.proposalDigest!);
  const createRollback = await lastBody(app, session.workspace);
  assert.deepEqual(
    createRollback.harnessSkill.restoredIds,
    [],
    "nothing existed before the create, so nothing is restored",
  );
  assert.deepEqual(
    await surface.promotedSkills(session.workspace),
    [],
    "rolling back the create removes the skill",
  );
});

test("a skill body carrying a secret is refused before it reaches the chain", async (t) => {
  // A value the environment configured, not one the model invented: the
  // refusal has to cover a credential the workspace already knows.
  const configured = "hunter2-skill-token-9d1f";
  const f = await fixture(t, { NOMO_WEB_SEARCH_API_KEY: configured });
  const { app, session } = f;
  const surface = surfaceOf(app);
  const seq = await lastSeq(app, session.workspace);
  const before = await entryCount(app, session.workspace);

  await assert.rejects(
    app.refineHarness(
      session.id,
      skillProposal(
        "create",
        seq,
        `## Steps\n\nReach the scratch database with ${configured}.`,
      ),
    ),
    /secret-like/i,
    "a known workspace secret in the body must be refused",
  );
  await assert.rejects(
    app.refineHarness(
      session.id,
      skillProposal(
        "create",
        seq,
        "## Steps\n\nRun the deploy with sk-abcdefabcdefabcdef1234 attached.",
      ),
    ),
    /secret-like/i,
    "a secret-shaped token in the body must be refused",
  );

  assert.equal(
    await entryCount(app, session.workspace),
    before,
    "a refused skill leaves nothing in the chain",
  );
  assert.deepEqual(
    await surface.promotedSkills(session.workspace),
    [],
    "a refused skill is never promoted",
  );
  assert.deepEqual(
    await app.pendingApprovalsFor(session.id),
    [],
    "the operator is never asked to approve text carrying a secret",
  );
});
