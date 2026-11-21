/**
 * The skill promotion contract, written before the module it tests.
 *
 * The claim under test is narrow and every part of it exists because the
 * opposite is easy to build: a promotion is bound to one approved digest and one
 * chain position, the record carries both snapshots so a rollback is a fact
 * rather than a reconstruction, replay reads only signed lifecycle records and
 * refuses anything it cannot place, and a promoted skill reaches a prompt as
 * labelled guidance inside a ceiling and reaches nothing else at all.
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";

import {
  SKILL_PROMOTION_LIMITS,
  describeSkillPromotionReview,
  formatPromotedSkillsForPrompt,
  parseSkillProposalChange,
  prepareSkillPromotion,
  prepareSkillRollback,
  replayPromotedSkills,
} from "./skill-promotion.ts";
import type {
  ParsedSkillChange,
  PromotedSkill,
  SkillChange,
  SkillPromotionRequest,
  SkillRollbackRecord,
} from "./skill-promotion.ts";

const digest = (letter: string) => letter.repeat(64);

const skill = (overrides: Partial<PromotedSkill> = {}): PromotedSkill => ({
  id: "deploy-runbook",
  title: "Ask before deleting a bucket",
  description: "Recurring refusal on bucket deletion.",
  body: "When a request deletes a bucket, ask the operator first.",
  ...overrides,
});

/** A raw change as a model proposal carries it, before parsing. */
const raw = (overrides: Record<string, unknown> = {}) => ({
  action: "create",
  id: "deploy-runbook",
  title: "Ask before deleting a bucket",
  description: "Recurring refusal on bucket deletion.",
  body: "When a request deletes a bucket, ask the operator first.",
  ...overrides,
});

const create = (overrides: Partial<PromotedSkill> = {}): ParsedSkillChange => ({
  action: "create",
  skill: skill(overrides),
});

const update = (overrides: Partial<PromotedSkill> = {}): ParsedSkillChange => ({
  action: "update",
  skill: skill(overrides),
});

const remove = (id: string): ParsedSkillChange => ({ action: "delete", id });

const request = (
  overrides: Partial<SkillPromotionRequest> = {},
): SkillPromotionRequest => ({
  digest: digest("a"),
  approvedDigest: digest("a"),
  atSeq: 12,
  chainLength: 12,
  changes: [create()],
  ...overrides,
});

const manySkills = (count: number): PromotedSkill[] =>
  Array.from({ length: count }, (_, index) => skill({ id: `skill-${index}` }));

const promotedEntry = (seq: number, promotion: SkillPromotionRequest) => ({
  seq,
  body: {
    harnessSkill: prepareSkillPromotion(promotion),
    harnessLifecycle: {
      digest: promotion.digest,
      events: ["skill:promoted"],
      atSeq: promotion.atSeq,
    },
  },
});

const rolledBackEntry = (seq: number, rollback: SkillRollbackRecord) => ({
  seq,
  body: {
    harnessSkill: rollback,
    harnessLifecycle: {
      digest: rollback.digest,
      events: ["skill:rolled-back"],
      atSeq: rollback.atSeq,
    },
  },
});

describe("SKILL_PROMOTION_LIMITS", () => {
  test("names every limit in one constant", () => {
    assert.deepEqual(SKILL_PROMOTION_LIMITS, {
      id: 64,
      title: 120,
      description: 400,
      body: 8_000,
      changesPerProposal: 4,
      activeSkills: 16,
    });
  });
});

describe("parseSkillProposalChange", () => {
  test("accepts a create at every limit and keeps the text as written", () => {
    const value = raw({
      id: "a".repeat(SKILL_PROMOTION_LIMITS.id),
      title: "t".repeat(SKILL_PROMOTION_LIMITS.title),
      description: "d".repeat(SKILL_PROMOTION_LIMITS.description),
      body: "b".repeat(SKILL_PROMOTION_LIMITS.body),
    });
    const parsed = parseSkillProposalChange(value);
    assert.deepEqual(parsed, {
      action: "create",
      skill: {
        id: "a".repeat(64),
        title: "t".repeat(120),
        description: "d".repeat(400),
        body: "b".repeat(8000),
      },
    });
  });

  test("accepts markdown body line breaks and tabs and trims the labels", () => {
    const parsed = parseSkillProposalChange(
      raw({ title: "  Ask first  ", body: "# Runbook\n\n\t- step one\n" }),
    );
    assert.deepEqual(parsed, {
      action: "create",
      skill: {
        id: "deploy-runbook",
        title: "Ask first",
        description: "Recurring refusal on bucket deletion.",
        body: "# Runbook\n\n\t- step one\n",
      },
    });
  });

  test("a delete carries only the id it removes", () => {
    assert.deepEqual(parseSkillProposalChange({ action: "delete", id: "deploy-runbook" }), {
      action: "delete",
      id: "deploy-runbook",
    });
  });

  test("refuses an id that is not kebab case or is too long", () => {
    for (const id of [
      "Deploy-Runbook",
      "deploy_runbook",
      "-deploy",
      "deploy-",
      "deploy--runbook",
      "deploy runbook",
      "a".repeat(SKILL_PROMOTION_LIMITS.id + 1),
      "",
    ]) {
      assert.throws(
        () => parseSkillProposalChange(raw({ id })),
        /skill id/i,
        `expected ${JSON.stringify(id)} to be refused`,
      );
    }
  });

  test("refuses a title, description or body over its limit", () => {
    assert.throws(
      () => parseSkillProposalChange(raw({ title: "t".repeat(121) })),
      /title/i,
    );
    assert.throws(
      () => parseSkillProposalChange(raw({ description: "d".repeat(401) })),
      /description/i,
    );
    assert.throws(
      () => parseSkillProposalChange(raw({ body: "b".repeat(8001) })),
      /body/i,
    );
  });

  test("refuses an empty title or body and an unknown action", () => {
    assert.throws(() => parseSkillProposalChange(raw({ title: "   " })), /title/i);
    assert.throws(() => parseSkillProposalChange(raw({ body: "" })), /body/i);
    assert.throws(() => parseSkillProposalChange(raw({ action: "promote" })), /action/i);
    assert.throws(() => parseSkillProposalChange(null), /object/i);
  });

  test("refuses invalid UTF-8 and control characters", () => {
    // A lone surrogate cannot survive a UTF-8 round trip, and a control
    // character would break the one-line review and prompt rendering.
    assert.throws(() => parseSkillProposalChange(raw({ body: "a\ud800b" })), /utf-8/i);
    assert.throws(() => parseSkillProposalChange(raw({ body: "a\u0000b" })), /control/i);
    assert.throws(() => parseSkillProposalChange(raw({ title: "a\nb" })), /control/i);
    assert.throws(() => parseSkillProposalChange(raw({ description: "a\u0007b" })), /control/i);
  });
});

describe("prepareSkillPromotion", () => {
  test("records the digest, the position and both snapshots of every change", () => {
    const record = prepareSkillPromotion(
      request({ changes: [create(), remove("skill-0")], active: manySkills(1) }),
    );
    assert.equal(record.digest, digest("a"));
    assert.equal(record.atSeq, 12);
    assert.deepEqual(record.changes.map((change) => change.id), ["deploy-runbook", "skill-0"]);
    assert.equal(record.changes[0].before, null);
    assert.deepEqual(record.changes[0].after, skill());
    assert.deepEqual(record.changes[1].before, skill({ id: "skill-0" }));
    assert.equal(record.changes[1].after, null);
  });

  test("an update records the active text as the before snapshot", () => {
    const record = prepareSkillPromotion(
      request({ changes: [update({ body: "Ask first, then delete." })], active: [skill()] }),
    );
    assert.deepEqual(record.changes[0].before, skill());
    assert.deepEqual(record.changes[0].after, skill({ body: "Ask first, then delete." }));
  });

  test("refuses a digest that is not the approved digest or not a digest", () => {
    assert.throws(
      () => prepareSkillPromotion(request({ approvedDigest: digest("b") })),
      /digest/i,
    );
    assert.throws(() => prepareSkillPromotion(request({ digest: "abc" })), /digest/i);
  });

  test("refuses a chain that moved since the proposal was read", () => {
    assert.throws(
      () => prepareSkillPromotion(request({ chainLength: 13 })),
      /chain/i,
    );
    assert.throws(
      () => prepareSkillPromotion(request({ atSeq: -1, chainLength: -1 })),
      /atSeq|position/i,
    );
  });

  test("refuses no changes, more than four, and a duplicate id", () => {
    assert.throws(() => prepareSkillPromotion(request({ changes: [] })), /at least one/i);
    assert.throws(
      () =>
        prepareSkillPromotion(
          request({
            changes: [
              create(),
              create({ id: "one" }),
              create({ id: "two" }),
              create({ id: "three" }),
              create({ id: "four" }),
            ],
          }),
        ),
      /at most 4/i,
    );
    assert.throws(
      () =>
        prepareSkillPromotion(
          request({ changes: [create(), update({ title: "other" })] }),
        ),
      /duplicate/i,
    );
  });

  test("refuses an id a project skill already holds", () => {
    assert.throws(
      () => prepareSkillPromotion(request({ projectSkillIds: ["deploy-runbook"] })),
      /project skill/i,
    );
  });

  test("refuses secret-shaped text and a known secret value", () => {
    for (const change of [
      create({ title: "token = abc123def" }),
      create({ body: "use sk-abcdefghijklmnop here" }),
      create({ description: "see ghp_abcdefghijklmnopqrst" }),
      create({ body: "-----BEGIN RSA PRIVATE KEY-----" }),
      create({ description: "the value hunter2-not-a-real-secret" }),
    ]) {
      assert.throws(
        () =>
          prepareSkillPromotion(
            request({ changes: [change], knownSecrets: ["hunter2-not-a-real-secret"] }),
          ),
        /secret/i,
      );
    }
  });

  test("refuses secret text in the snapshot a rollback would restore", () => {
    assert.throws(
      () =>
        prepareSkillPromotion(
          request({
            changes: [update({ body: "clean text" })],
            active: [skill({ body: "password: hunter2" })],
          }),
        ),
      /secret/i,
    );
  });

  test("refuses a create of an active id and an update or delete of an inactive one", () => {
    assert.throws(
      () => prepareSkillPromotion(request({ changes: [create()], active: [skill()] })),
      /already/i,
    );
    assert.throws(
      () => prepareSkillPromotion(request({ changes: [update()], active: [] })),
      /not active|no learned skill/i,
    );
    assert.throws(
      () => prepareSkillPromotion(request({ changes: [remove("deploy-runbook")], active: [] })),
      /not active|no learned skill/i,
    );
  });

  test("refuses an update that changes nothing", () => {
    assert.throws(
      () => prepareSkillPromotion(request({ changes: [update()], active: [skill()] })),
      /change/i,
    );
  });

  test("refuses the seventeenth active skill and allows the sixteenth", () => {
    const atCap = prepareSkillPromotion(
      request({ changes: [create({ id: "sixteenth" })], active: manySkills(15) }),
    );
    assert.equal(atCap.changes.length, 1);
    assert.throws(
      () =>
        prepareSkillPromotion(
          request({ changes: [create({ id: "seventeenth" })], active: manySkills(16) }),
        ),
      /at most 16/i,
    );
  });

  test("a delete frees the slot the same proposal spends", () => {
    const record = prepareSkillPromotion(
      request({ changes: [remove("skill-0"), create({ id: "replacement" })], active: manySkills(16) }),
    );
    assert.deepEqual(record.changes.map((change) => change.id), ["skill-0", "replacement"]);
  });

  test("re-checks a change object a caller built by hand", () => {
    assert.throws(
      () =>
        prepareSkillPromotion(
          request({ changes: [{ action: "create", skill: skill({ id: "Not_Kebab" }) }] }),
        ),
      /skill id/i,
    );
  });
});

describe("prepareSkillRollback", () => {
  test("restores the text the promotion replaced and names the restored id", () => {
    const promotion = prepareSkillPromotion(
      request({ changes: [update({ body: "Ask first, then delete." })], active: [skill()] }),
    );
    const rollback = prepareSkillRollback({
      digest: promotion.digest,
      atSeq: promotion.atSeq,
      changes: promotion.changes,
      active: [skill({ body: "Ask first, then delete." })],
    });
    assert.equal(rollback.approvedBy, "rollback");
    assert.equal(rollback.digest, digest("a"));
    assert.equal(rollback.atSeq, 12);
    assert.deepEqual(rollback.restoredIds, ["deploy-runbook"]);
    assert.deepEqual(rollback.changes, [
      {
        id: "deploy-runbook",
        before: skill({ body: "Ask first, then delete." }),
        after: skill(),
      },
    ]);
  });

  test("a rollback of a create removes the skill and restores nothing", () => {
    const promotion = prepareSkillPromotion(request({ changes: [create()] }));
    const rollback = prepareSkillRollback({
      digest: promotion.digest,
      atSeq: promotion.atSeq,
      changes: promotion.changes,
      active: [skill()],
    });
    assert.deepEqual(rollback.restoredIds, []);
    assert.deepEqual(rollback.changes, [{ id: "deploy-runbook", before: skill(), after: null }]);
  });

  test("refuses when the active skill is not the signed after snapshot", () => {
    const promotion = prepareSkillPromotion(request({ changes: [create()] }));
    assert.throws(
      () =>
        prepareSkillRollback({
          digest: promotion.digest,
          atSeq: promotion.atSeq,
          changes: promotion.changes,
          active: [skill({ body: "edited outside the chain" })],
        }),
      /match/i,
    );
  });

  test("refuses when the skill is no longer active at all", () => {
    const promotion = prepareSkillPromotion(request({ changes: [create()] }));
    assert.throws(
      () =>
        prepareSkillRollback({
          digest: promotion.digest,
          atSeq: promotion.atSeq,
          changes: promotion.changes,
          active: [],
        }),
      /not active|no learned skill/i,
    );
  });

  test("refuses a digest that is not a digest", () => {
    assert.throws(
      () =>
        prepareSkillRollback({
          digest: "not-a-digest",
          atSeq: 1,
          changes: [{ id: "deploy-runbook", before: null, after: skill() }],
        }),
      /digest/i,
    );
  });
});

describe("replayPromotedSkills", () => {
  const first = request({
    changes: [create({ id: "alpha-skill", title: "first" })],
  });
  const second = request({
    digest: digest("b"),
    approvedDigest: digest("b"),
    atSeq: 14,
    chainLength: 14,
    changes: [create({ id: "beta-skill", title: "second" })],
  });

  test("an empty chain holds no skills", () => {
    const replayed = replayPromotedSkills([]);
    assert.equal(replayed.skills.length, 0);
    assert.equal(replayed.byId.size, 0);
  });

  test("reads a promotion in sequence order and returns a map and a list", () => {
    const replayed = replayPromotedSkills([promotedEntry(12, first), promotedEntry(14, second)]);
    assert.deepEqual(replayed.skills.map((item) => item.id), ["alpha-skill", "beta-skill"]);
    assert.deepEqual(replayed.byId.get("beta-skill"), skill({ id: "beta-skill", title: "second" }));
  });

  test("input order does not matter", () => {
    const shuffled = replayPromotedSkills([promotedEntry(14, second), promotedEntry(12, first)]);
    const ordered = replayPromotedSkills([promotedEntry(12, first), promotedEntry(14, second)]);
    assert.deepEqual([...shuffled.byId.keys()], [...ordered.byId.keys()]);
    assert.deepEqual(shuffled.skills, ordered.skills);
  });

  test("a later promotion of the same id wins", () => {
    const base = request({ changes: [create({ title: "first" })] });
    const replacement = request({
      digest: digest("c"),
      approvedDigest: digest("c"),
      atSeq: 16,
      chainLength: 16,
      changes: [update({ title: "third" })],
      active: [skill({ title: "first" })],
    });
    const replayed = replayPromotedSkills([
      promotedEntry(12, base),
      promotedEntry(16, replacement),
    ]);
    assert.equal(replayed.byId.get("deploy-runbook")?.title, "third");
  });

  test("a rollback restores the text the promotion replaced", () => {
    const before = skill({ title: "before" });
    const created = request({
      digest: digest("d"),
      approvedDigest: digest("d"),
      atSeq: 10,
      chainLength: 10,
      changes: [create({ title: "before" })],
    });
    const replacement = request({
      digest: digest("e"),
      approvedDigest: digest("e"),
      atSeq: 12,
      chainLength: 12,
      changes: [update({ title: "after" })],
      active: [before],
    });
    const promotion = prepareSkillPromotion(replacement);
    const rollback = prepareSkillRollback({
      digest: promotion.digest,
      atSeq: promotion.atSeq,
      changes: promotion.changes,
      active: [skill({ title: "after" })],
    });
    const replayed = replayPromotedSkills([
      promotedEntry(10, created),
      promotedEntry(12, replacement),
      rolledBackEntry(14, rollback),
    ]);
    assert.deepEqual(replayed.byId.get("deploy-runbook"), before);
  });

  test("refuses a rollback of a promotion the chain never made", () => {
    const promotion = prepareSkillPromotion(request({ changes: [create()] }));
    const rollback = prepareSkillRollback({
      digest: promotion.digest,
      atSeq: promotion.atSeq,
      changes: promotion.changes,
      active: [skill()],
    });
    assert.throws(() => replayPromotedSkills([rolledBackEntry(14, rollback)]), /never made/i);
  });

  test("refuses a second rollback of the same digest", () => {
    const promotion = prepareSkillPromotion(request({ changes: [create()] }));
    const rollback = prepareSkillRollback({
      digest: promotion.digest,
      atSeq: promotion.atSeq,
      changes: promotion.changes,
      active: [skill()],
    });
    assert.throws(
      () =>
        replayPromotedSkills([
          promotedEntry(12, request({ changes: [create()] })),
          rolledBackEntry(14, rollback),
          rolledBackEntry(16, rollback),
        ]),
      /already/i,
    );
  });

  test("refuses a record with both events, no event, or a disagreeing digest", () => {
    const entry = promotedEntry(12, request({ changes: [create()] }));
    const both = {
      seq: 12,
      body: {
        ...entry.body,
        harnessLifecycle: { digest: digest("a"), events: ["skill:promoted", "skill:rolled-back"] },
      },
    };
    assert.throws(() => replayPromotedSkills([both]), /event|ambiguous/i);
    const none = { seq: 12, body: { ...entry.body, harnessLifecycle: { events: [] } } };
    assert.throws(() => replayPromotedSkills([none]), /event|ambiguous/i);
    const disagreeing = {
      seq: 12,
      body: {
        ...entry.body,
        harnessLifecycle: { digest: digest("b"), events: ["skill:promoted"] },
      },
    };
    assert.throws(() => replayPromotedSkills([disagreeing]), /digest/i);
  });

  test("refuses a change whose before does not match what the chain produced", () => {
    const entry = promotedEntry(12, request({ changes: [create()] }));
    const tampered = {
      seq: 12,
      body: {
        ...entry.body,
        harnessSkill: {
          ...(entry.body.harnessSkill as object),
          changes: [
            {
              id: "deploy-runbook",
              before: skill({ title: "invented" }),
              after: skill(),
            },
          ],
        },
      },
    };
    assert.throws(() => replayPromotedSkills([tampered]), /before|match/i);
  });

  test("refuses a skill record that carries no sequence", () => {
    const entry = promotedEntry(12, request({ changes: [create()] }));
    assert.throws(
      () => replayPromotedSkills([{ body: entry.body }]),
      /sequence|seq/i,
    );
  });

  test("ignores a chain of unrelated records", () => {
    const replayed = replayPromotedSkills([
      { seq: 1, body: { decision: "deny:policy", tool: "aws.s3.bucket.delete", klass: "r3" } },
      { seq: 2, body: { harnessLifecycle: { digest: digest("a"), events: ["proposal:activated"] } } },
    ]);
    assert.equal(replayed.skills.length, 0);
  });
});

describe("formatPromotedSkillsForPrompt", () => {
  test("an empty set renders nothing", () => {
    assert.equal(formatPromotedSkillsForPrompt([]), "");
  });

  test("labels every skill as approved guidance that is not authority", () => {
    const block = formatPromotedSkillsForPrompt([skill()]);
    assert.match(
      block,
      /\[Approved learned skill deploy-runbook; not policy or tool authority\]/,
    );
    assert.match(block, /Ask before deleting a bucket/);
    assert.match(block, /not authority/i);
    assert.match(block, /changes no policy/i);
  });

  test("orders skills by id so two runs over one set agree", () => {
    const block = formatPromotedSkillsForPrompt([
      skill({ id: "zulu-skill" }),
      skill({ id: "alpha-skill" }),
    ]);
    assert.ok(block.indexOf("alpha-skill") < block.indexOf("zulu-skill"));
  });

  test("stays inside the caller budget and says what it dropped", () => {
    const skills = manySkills(3);
    const full = formatPromotedSkillsForPrompt(skills);
    const budget = full.length - 10;
    const block = formatPromotedSkillsForPrompt(skills, budget);
    assert.ok(block.length <= budget, `${block.length} > ${budget}`);
    assert.match(block, /Showing the first 2 of 3/);
    assert.doesNotMatch(block, /skill-2/);
  });

  test("renders nothing rather than a header with no skill under it", () => {
    assert.equal(formatPromotedSkillsForPrompt(manySkills(2), 20), "");
  });
});

describe("describeSkillPromotionReview", () => {
  test("shows the before and after of an update", () => {
    const record = prepareSkillPromotion(
      request({
        changes: [update({ title: "Ask first", body: "Ask the operator, then delete." })],
        active: [skill({ title: "Ask before deleting", body: "Ask first." })],
      }),
    );
    const review = describeSkillPromotionReview(record);
    assert.match(review, /update "deploy-runbook"/);
    assert.match(review, /Ask before deleting/);
    assert.match(review, /Ask first/);
    assert.match(review, /Ask the operator, then delete\./);
    assert.match(review, /changes no policy, permission or tool/i);
  });

  test("shows a create and a delete", () => {
    const record = prepareSkillPromotion(
      request({ changes: [create(), remove("skill-0")], active: manySkills(1) }),
    );
    const review = describeSkillPromotionReview(record);
    assert.match(review, /create "deploy-runbook"/);
    assert.match(review, /delete "skill-0"/);
    assert.match(review, /Recurring refusal on bucket deletion\./);
  });

  test("names the digest and the position it was approved at", () => {
    const review = describeSkillPromotionReview(
      prepareSkillPromotion(request({ changes: [create()] })),
    );
    assert.match(review, /aaaaaaaa/);
    assert.match(review, /seq 12/);
  });

  test("stays inside the caller budget and renders nothing when it cannot fit", () => {
    const record = prepareSkillPromotion(request({ changes: [create()] }));
    const full = describeSkillPromotionReview(record);
    const review = describeSkillPromotionReview(record, full.length - 10);
    assert.ok(review.length <= full.length - 10);
    assert.equal(describeSkillPromotionReview(record, 20), "");
  });

  test("clips a long body preview rather than hiding the change", () => {
    const record = prepareSkillPromotion(
      request({ changes: [create({ body: "x".repeat(2_000) })] }),
    );
    const review = describeSkillPromotionReview(record, 1_200);
    assert.ok(review.length <= 1_200);
    assert.match(review, /clipped/);
    assert.match(review, /2000 characters/);
  });
});

/** A change record built by hand, so a type error cannot hide a runtime gap. */
const handBuilt: SkillChange = { id: "deploy-runbook", before: null, after: skill() };
test("a hand built change keeps the record shape the chain carries", () => {
  assert.deepEqual(Object.keys(handBuilt).sort(), ["after", "before", "id"]);
});
