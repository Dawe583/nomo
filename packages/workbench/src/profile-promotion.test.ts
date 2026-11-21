import test, { describe } from "node:test";
import assert from "node:assert/strict";

import type { AgentProfile } from "./agents.ts";
import {
  PROFILE_PROMOTED_EVENT,
  PROFILE_ROLLED_BACK_EVENT,
  RESERVED_PROFILE_IDS,
  containsSecretMaterial,
  describeProfilePromotionReview,
  prepareProfilePromotion,
  prepareProfileRollback,
  replayPromotedProfiles,
  reviewProfilePromotion,
  type HarnessProfileRecord,
  type ParentBound,
  type ProfilePromotionRequest,
} from "./profile-promotion.ts";

const DIGEST = "a".repeat(64);
const OTHER_DIGEST = "b".repeat(64);

const profile = (over: Partial<AgentProfile> = {}): AgentProfile => ({
  id: "reviewer-x",
  name: "Reviewer X",
  systemPrompt: "Read the diff and name the defect.",
  allowedTools: ["fs.read"],
  policyProfile: "default",
  maxTurns: 4,
  maxContextTokens: 8192,
  ...over,
});

const plannerX = profile({ id: "planner-x", name: "Planner X" });
const plannerY = profile({ id: "planner-x", name: "Planner Y" });
const auditorX = profile({ id: "auditor-x", name: "Auditor X" });

const parent = (over: Partial<ParentBound> = {}): ParentBound => ({
  allowedTools: ["fs.write", "fs.read"],
  policyProfile: "default",
  maxTurns: 8,
  maxContextTokens: 32768,
  ...over,
});

const request = (
  over: Partial<ProfilePromotionRequest> = {},
): ProfilePromotionRequest => ({
  digest: DIGEST,
  approvedDigest: DIGEST,
  refinementDigest: DIGEST,
  atSeq: 7,
  chainLength: 7,
  parent: parent(),
  edits: [{ action: "create", profile: profile() }],
  activeProfiles: [],
  builtinProfileIds: ["default", "planner", "reviewer", "implementer"],
  ...over,
});

/** The record that put `plannerX` in the store, so a later record can replay
 * from a state the chain actually carried. */
const createPlanner = (atSeq = 5) =>
  prepareProfilePromotion(
    request({
      atSeq,
      chainLength: atSeq,
      edits: [{ action: "create", profile: plannerX }],
    }),
  );

describe("promotion record construction", () => {
  test("a create carries the digest, the chain position and both snapshots", () => {
    const record = prepareProfilePromotion(request());
    assert.equal(record.digest, DIGEST);
    assert.equal(record.atSeq, 7);
    assert.deepEqual(record.changes, [
      { id: "reviewer-x", before: null, after: profile() },
    ]);
  });

  test("an update carries the active profile as the before snapshot", () => {
    const record = prepareProfilePromotion(
      request({
        activeProfiles: [plannerX],
        edits: [{ action: "update", profile: plannerY }],
      }),
    );
    assert.deepEqual(record.changes, [
      { id: "planner-x", before: plannerX, after: plannerY },
    ]);
  });

  test("a delete carries a null after snapshot and no profile", () => {
    const record = prepareProfilePromotion(
      request({
        activeProfiles: [plannerX],
        edits: [{ action: "delete", id: "planner-x" }],
      }),
    );
    assert.deepEqual(record.changes, [
      { id: "planner-x", before: plannerX, after: null },
    ]);
  });

  test("the parent bound is recorded so the operator can read it later", () => {
    const record = prepareProfilePromotion(request());
    assert.deepEqual(record.parentBound, {
      allowedTools: ["fs.read", "fs.write"],
      policyProfile: "default",
      maxTurns: 8,
      maxContextTokens: 32768,
    });
  });

  test("the recorded parent tools are deduplicated and sorted", () => {
    const record = prepareProfilePromotion(
      request({ parent: parent({ allowedTools: ["fs.write", "fs.read", "fs.read"] }) }),
    );
    assert.deepEqual(record.parentBound?.allowedTools, ["fs.read", "fs.write"]);
  });

  test("several edits keep the order the proposal named", () => {
    const record = prepareProfilePromotion(
      request({
        activeProfiles: [plannerX],
        edits: [
          { action: "update", profile: plannerY },
          { action: "create", profile: profile() },
        ],
      }),
    );
    assert.deepEqual(
      record.changes.map((change) => change.id),
      ["planner-x", "reviewer-x"],
    );
  });

  test("the record is frozen and does not alias the caller's profiles", () => {
    const proposed = profile();
    const record = prepareProfilePromotion(
      request({ edits: [{ action: "create", profile: proposed }] }),
    );
    assert.equal(Object.isFrozen(record), true);
    assert.equal(Object.isFrozen(record.changes), true);
    proposed.name = "mutated after the call";
    assert.equal(record.changes[0]!.after?.name, "Reviewer X");
  });

  test("the promotion and rollback event names are the frozen contract", () => {
    assert.equal(PROFILE_PROMOTED_EVENT, "profile:promoted");
    assert.equal(PROFILE_ROLLED_BACK_EVENT, "profile:rolled-back");
  });
});

describe("digest and chain position are mandatory", () => {
  test("a digest that is not a sha256 is refused", () => {
    assert.throws(
      () =>
        prepareProfilePromotion(
          request({
            digest: "not-a-digest",
            approvedDigest: "not-a-digest",
            refinementDigest: "not-a-digest",
          }),
        ),
      /must be a lowercase hex sha256 digest/,
    );
  });

  test("a digest that differs from the approved proposal is refused", () => {
    assert.throws(
      () => prepareProfilePromotion(request({ approvedDigest: OTHER_DIGEST })),
      /does not match the approved proposal/,
    );
  });

  test("a digest that differs from the refinement is refused", () => {
    assert.throws(
      () => prepareProfilePromotion(request({ refinementDigest: OTHER_DIGEST })),
      /does not match its refinement/,
    );
  });

  test("a chain that advanced after review is refused", () => {
    assert.throws(
      () => prepareProfilePromotion(request({ chainLength: 8 })),
      /The chain moved after the proposal was reviewed/,
    );
  });

  test("a chain that is behind the approval position is refused", () => {
    assert.throws(
      () => prepareProfilePromotion(request({ chainLength: 6 })),
      /The chain moved after the proposal was reviewed/,
    );
  });

  test("an approval position that is not a chain sequence is refused", () => {
    assert.throws(
      () => prepareProfilePromotion(request({ atSeq: -1, chainLength: -1 })),
      /not a chain sequence/,
    );
    assert.throws(
      () => prepareProfilePromotion(request({ atSeq: 7.5, chainLength: 7.5 })),
      /not a chain sequence/,
    );
  });
});

describe("parent scope checks", () => {
  test("a malformed parent bound is refused before any profile is read", () => {
    assert.throws(
      () => prepareProfilePromotion(request({ parent: parent({ maxTurns: 0 }) })),
      /The parent bound is malformed/,
    );
    assert.throws(
      () => prepareProfilePromotion(request({ parent: parent({ policyProfile: "  " }) })),
      /The parent bound is malformed/,
    );
  });

  test("a tool the parent cannot reach is refused", () => {
    assert.throws(
      () =>
        prepareProfilePromotion(
          request({
            edits: [{ action: "create", profile: profile({ allowedTools: ["shell.exec"] }) }],
          }),
        ),
      /exceeds the parent tool scope/,
    );
  });

  test("the parent tool set is a ceiling, so a narrower tool list is allowed", () => {
    const record = prepareProfilePromotion(
      request({ edits: [{ action: "create", profile: profile({ allowedTools: ["fs.read"] }) }] }),
    );
    assert.deepEqual(record.changes[0]!.after?.allowedTools, ["fs.read"]);
  });

  test("a policy profile that differs from the parent's is refused", () => {
    assert.throws(
      () =>
        prepareProfilePromotion(
          request({
            edits: [{ action: "create", profile: profile({ policyProfile: "permissive" }) }],
          }),
        ),
      /exceeds the parent policy profile/,
    );
  });

  test("a narrower policy profile is refused rather than silently rewritten", () => {
    assert.throws(
      () =>
        prepareProfilePromotion(
          request({
            edits: [{ action: "create", profile: profile({ policyProfile: "strict" }) }],
          }),
        ),
      /exceeds the parent policy profile/,
    );
  });

  test("a turn bound above the parent's is refused", () => {
    assert.throws(
      () =>
        prepareProfilePromotion(
          request({ edits: [{ action: "create", profile: profile({ maxTurns: 9 }) }] }),
        ),
      /exceeds the parent turn bound/,
    );
  });

  test("a context bound above the parent's is refused", () => {
    assert.throws(
      () =>
        prepareProfilePromotion(
          request({
            edits: [{ action: "create", profile: profile({ maxContextTokens: 32769 }) }],
          }),
        ),
      /exceeds the parent context bound/,
    );
  });

  test("a profile exactly at the parent bounds is allowed", () => {
    const record = prepareProfilePromotion(
      request({
        edits: [
          { action: "create", profile: profile({ maxTurns: 8, maxContextTokens: 32768 }) },
        ],
      }),
    );
    assert.equal(record.changes[0]!.after?.maxTurns, 8);
    assert.equal(record.changes[0]!.after?.maxContextTokens, 32768);
  });

  test("a profile the agent limits cannot describe is refused by the validator", () => {
    assert.throws(
      () =>
        prepareProfilePromotion(
          request({ edits: [{ action: "create", profile: profile({ maxTurns: 400 }) }] }),
        ),
      /Invalid subagent profile: maxTurns/,
    );
  });
});

describe("collisions with built-in agents and reserved ids", () => {
  test("a profile id that is a built-in preset is refused", () => {
    assert.throws(
      () =>
        prepareProfilePromotion(
          request({ edits: [{ action: "create", profile: profile({ id: "reviewer" }) }] }),
        ),
      /collides with an existing agent/,
    );
  });

  test("a reserved profile id is refused", () => {
    const reserved = RESERVED_PROFILE_IDS[0]!;
    assert.throws(
      () =>
        prepareProfilePromotion(
          request({ edits: [{ action: "create", profile: profile({ id: reserved }) }] }),
        ),
      /is reserved/,
    );
  });

  test("a built-in id offered as a delete is refused as a missing profile", () => {
    assert.throws(
      () => prepareProfilePromotion(request({ edits: [{ action: "delete", id: "implementer" }] })),
      /does not exist/,
    );
  });
});

describe("edit shape and store consistency", () => {
  test("a promotion with no profile edit is refused", () => {
    assert.throws(
      () => prepareProfilePromotion(request({ edits: [] })),
      /no supported edit to activate/,
    );
  });

  test("two edits of the same id are refused", () => {
    assert.throws(
      () =>
        prepareProfilePromotion(
          request({
            edits: [
              { action: "create", profile: profile() },
              { action: "create", profile: profile() },
            ],
          }),
        ),
      /Only one subagent profile edit per id is allowed: reviewer-x/,
    );
  });

  test("a create for an id the store already holds is refused", () => {
    assert.throws(
      () => prepareProfilePromotion(request({ activeProfiles: [profile()] })),
      /already exists/,
    );
  });

  test("an update for an id the store does not hold is refused", () => {
    assert.throws(
      () =>
        prepareProfilePromotion(request({ edits: [{ action: "update", profile: profile() }] })),
      /does not exist/,
    );
  });

  test("an edit id that disagrees with its profile id is refused", () => {
    assert.throws(
      () =>
        prepareProfilePromotion(
          request({ edits: [{ action: "create", id: "other-x", profile: profile() }] }),
        ),
      /must match its profile id/,
    );
  });

  test("an edit with no id at all is refused", () => {
    assert.throws(
      () => prepareProfilePromotion(request({ edits: [{ action: "create" }] })),
      /needs an id/,
    );
  });

  test("a create without a profile is refused", () => {
    assert.throws(
      () => prepareProfilePromotion(request({ edits: [{ action: "create", id: "reviewer-x" }] })),
      /must carry a profile/,
    );
  });

  test("a delete that carries a profile is refused", () => {
    assert.throws(
      () =>
        prepareProfilePromotion(
          request({
            activeProfiles: [plannerX],
            edits: [{ action: "delete", id: "planner-x", profile: plannerX }],
          }),
        ),
      /delete must not carry a profile/,
    );
  });

  test("an action outside the frozen set is refused", () => {
    assert.throws(
      () =>
        prepareProfilePromotion(
          request({ edits: [{ action: "rename" as "create", profile: profile() }] }),
        ),
      /Unsupported subagent profile action/,
    );
  });
});

describe("secret scan at write time", () => {
  test("a secret-shaped value in the proposed snapshot is refused", () => {
    assert.throws(
      () =>
        prepareProfilePromotion(
          request({
            edits: [
              { action: "create", profile: profile({ systemPrompt: "use api_key=sk_live_abcdefabcdef" }) },
            ],
          }),
        ),
      /carries secret-like text and cannot be promoted/,
    );
  });

  test("a known workspace secret in the proposed snapshot is refused", () => {
    assert.throws(
      () =>
        prepareProfilePromotion(
          request({
            knownSecrets: ["sk-shared-workspace-value"],
            edits: [{ action: "create", profile: profile({ name: "Agent sk-shared-workspace-value" }) }],
          }),
        ),
      /carries secret-like text and cannot be promoted/,
    );
  });

  test("a secret in the before snapshot already in the store is refused", () => {
    assert.throws(
      () =>
        prepareProfilePromotion(
          request({
            activeProfiles: [plannerX, profile({ systemPrompt: "Bearer abcdefghijklmnop.qrstuvwx" })],
            edits: [{ action: "delete", id: "reviewer-x" }],
          }),
        ),
      /carries secret-like text and cannot be promoted/,
    );
  });

  test("containsSecretMaterial names the shapes the harness already refuses", () => {
    assert.equal(containsSecretMaterial("api_key: abcdef"), true);
    assert.equal(containsSecretMaterial("Authorization=Bearer abcdef"), true);
    assert.equal(containsSecretMaterial("--token abcdef"), true);
    assert.equal(containsSecretMaterial("postgres://user:pw@host/db"), true);
    assert.equal(containsSecretMaterial("glpat-abcdefghij"), true);
    assert.equal(containsSecretMaterial("-----BEGIN RSA PRIVATE KEY-----"), true);
    assert.equal(
      containsSecretMaterial(
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
      ),
      true,
    );
    assert.equal(containsSecretMaterial("read the diff, name the defect"), false);
  });

  test("containsSecretMaterial matches a known secret of four characters or more", () => {
    assert.equal(containsSecretMaterial("carries hunter2 inside", ["hunter2"]), true);
    assert.equal(containsSecretMaterial("carries abc inside", ["abc"]), false);
  });
});

describe("rollback construction", () => {
  const promoted = () =>
    prepareProfilePromotion(
      request({
        activeProfiles: [plannerX],
        edits: [
          { action: "update", profile: plannerY },
          { action: "create", profile: profile() },
        ],
      }),
    );

  test("the inverse swaps before and after for every changed id", () => {
    const rollback = prepareProfileRollback({
      digest: DIGEST,
      activation: promoted(),
      activeProfiles: [plannerY, profile()],
    });
    assert.deepEqual(rollback.changes, [
      { id: "planner-x", before: plannerY, after: plannerX },
      { id: "reviewer-x", before: profile(), after: null },
    ]);
  });

  test("the rollback names the restored ids and the removed ids", () => {
    const rollback = prepareProfileRollback({
      digest: DIGEST,
      activation: promoted(),
      activeProfiles: [plannerY, profile()],
    });
    assert.deepEqual(rollback.restoredIds, ["planner-x"]);
    assert.deepEqual(rollback.removedIds, ["reviewer-x"]);
  });

  test("the rollback is signed as a rollback and names the digest it undid", () => {
    const rollback = prepareProfileRollback({
      digest: DIGEST,
      activation: promoted(),
      activeProfiles: [plannerY, profile()],
    });
    assert.equal(rollback.approvedBy, "rollback");
    assert.equal(rollback.digest, DIGEST);
    assert.equal(rollback.atSeq, 7);
    assert.equal(Object.isFrozen(rollback), true);
  });

  test("a rollback of a create-only promotion restores nothing and removes the id", () => {
    const rollback = prepareProfileRollback({
      digest: DIGEST,
      activation: prepareProfilePromotion(request()),
      activeProfiles: [profile()],
    });
    assert.deepEqual(rollback.restoredIds, []);
    assert.deepEqual(rollback.removedIds, ["reviewer-x"]);
    assert.deepEqual(rollback.changes, [
      { id: "reviewer-x", before: profile(), after: null },
    ]);
  });

  test("a rollback whose digest does not match the activation is refused", () => {
    assert.throws(
      () =>
        prepareProfileRollback({
          digest: OTHER_DIGEST,
          activation: promoted(),
          activeProfiles: [plannerY, profile()],
        }),
      /does not match the signed profile activation/,
    );
  });

  test("a drift of the active profile after promotion is refused", () => {
    assert.throws(
      () =>
        prepareProfileRollback({
          digest: DIGEST,
          activation: promoted(),
          activeProfiles: [profile({ id: "planner-x", name: "Planner Drifted" }), profile()],
        }),
      /The active profile no longer matches the signed activation/,
    );
  });

  test("a promoted profile that disappeared from the store is refused", () => {
    assert.throws(
      () =>
        prepareProfileRollback({
          digest: DIGEST,
          activation: promoted(),
          activeProfiles: [plannerY],
        }),
      /The active profile no longer matches the signed activation/,
    );
  });

  test("an activation with no profile change is refused", () => {
    assert.throws(
      () =>
        prepareProfileRollback({
          digest: DIGEST,
          activation: { digest: DIGEST, atSeq: 7, changes: [] },
          activeProfiles: [],
        }),
      /carries no profile change to roll back/,
    );
  });

  test("a malformed activation is refused rather than half applied", () => {
    assert.throws(
      () =>
        prepareProfileRollback({
          digest: DIGEST,
          activation: { digest: DIGEST, atSeq: 7 } as unknown as HarnessProfileRecord,
          activeProfiles: [],
        }),
      /The signed profile activation is malformed/,
    );
  });

  test("a secret in a snapshot restored by the rollback is refused", () => {
    assert.throws(
      () =>
        prepareProfileRollback({
          digest: DIGEST,
          activation: {
            digest: DIGEST,
            atSeq: 7,
            changes: [
              {
                id: "reviewer-x",
                before: profile({ systemPrompt: "token=abc123def456" }),
                after: profile(),
              },
            ],
          },
          activeProfiles: [profile()],
        }),
      /carries secret-like text and cannot be recorded/,
    );
  });
});

describe("replay", () => {
  test("a chain with no profile record replays to an empty store", () => {
    assert.deepEqual(replayPromotedProfiles([]), []);
  });

  test("one activation replays to the promoted store", () => {
    const activation = prepareProfilePromotion(request());
    assert.deepEqual(replayPromotedProfiles([activation]), [profile()]);
  });

  test("an update replays over the profile the chain created", () => {
    const update = prepareProfilePromotion(
      request({
        activeProfiles: [plannerX],
        edits: [{ action: "update", profile: plannerY }],
      }),
    );
    assert.deepEqual(replayPromotedProfiles([createPlanner(), update]), [plannerY]);
  });

  test("a delete replays to a store without the profile", () => {
    const removal = prepareProfilePromotion(
      request({
        activeProfiles: [plannerX],
        edits: [{ action: "delete", id: "planner-x" }],
      }),
    );
    assert.deepEqual(replayPromotedProfiles([createPlanner(), removal]), []);
  });

  test("an activation followed by its rollback replays to the prior store", () => {
    const activation = prepareProfilePromotion(
      request({
        activeProfiles: [plannerX],
        edits: [
          { action: "update", profile: plannerY },
          { action: "create", profile: profile() },
        ],
      }),
    );
    const rollback = prepareProfileRollback({
      digest: DIGEST,
      activation,
      activeProfiles: [plannerY, profile()],
    });
    assert.deepEqual(replayPromotedProfiles([createPlanner(), activation, rollback]), [
      plannerX,
    ]);
  });

  test("a legacy shaped record without a chain position still replays", () => {
    assert.deepEqual(
      replayPromotedProfiles([
        { digest: DIGEST, changes: [{ id: "reviewer-x", before: null, after: profile() }] },
      ]),
      [profile()],
    );
  });

  test("a digest that is not a sha256 refuses the replay", () => {
    assert.throws(
      () =>
        replayPromotedProfiles([
          { digest: "short", changes: [{ id: "reviewer-x", before: null, after: profile() }] },
        ]),
      /The signed profile digest is malformed/,
    );
  });

  test("a record whose changes are not a list refuses the replay", () => {
    assert.throws(
      () => replayPromotedProfiles([{ digest: DIGEST, changes: "nope" }]),
      /The signed profile activation is malformed/,
    );
  });

  test("a change with no id refuses the replay", () => {
    assert.throws(
      () =>
        replayPromotedProfiles([
          { digest: DIGEST, changes: [{ before: null, after: profile() }] },
        ]),
      /The signed profile change has no id/,
    );
  });

  test("a before snapshot that disagrees with the store refuses the replay", () => {
    assert.throws(
      () =>
        replayPromotedProfiles([
          {
            digest: DIGEST,
            changes: [{ id: "reviewer-x", before: profile({ name: "Other" }), after: profile() }],
          },
        ]),
      /does not replay consistently/,
    );
  });

  test("an after snapshot whose id disagrees with the change refuses the replay", () => {
    assert.throws(
      () =>
        replayPromotedProfiles([
          {
            digest: DIGEST,
            changes: [{ id: "reviewer-x", before: null, after: auditorX }],
          },
        ]),
      /does not match its snapshot/,
    );
  });

  test("records handed over out of chain order refuse the replay", () => {
    const later = prepareProfilePromotion(
      request({
        atSeq: 9,
        chainLength: 9,
        activeProfiles: [plannerX],
        edits: [{ action: "create", profile: profile() }],
      }),
    );
    assert.throws(
      () => replayPromotedProfiles([later, createPlanner()]),
      /not in chain order/,
    );
  });

  test("the replay returns copies, not the snapshots the record holds", () => {
    const activation = prepareProfilePromotion(request());
    const replayed = replayPromotedProfiles([activation]);
    replayed[0]!.name = "mutated";
    assert.equal(activation.changes[0]!.after?.name, "Reviewer X");
  });
});

describe("operator review surface", () => {
  test("the structured review exposes before, after and the parent bound", () => {
    const activation = prepareProfilePromotion(
      request({
        activeProfiles: [plannerX, profile()],
        edits: [
          { action: "update", profile: plannerY },
          { action: "create", profile: auditorX },
          { action: "delete", id: "reviewer-x" },
        ],
      }),
    );
    const review = reviewProfilePromotion(activation);
    assert.equal(review.digest, DIGEST);
    assert.equal(review.atSeq, 7);
    assert.deepEqual(review.parentBound, activation.parentBound);
    assert.deepEqual(
      review.edits.map((edit) => [edit.id, edit.action]),
      [
        ["planner-x", "update"],
        ["auditor-x", "create"],
        ["reviewer-x", "delete"],
      ],
    );
    assert.deepEqual(review.edits[0]!.before, plannerX);
    assert.deepEqual(review.edits[0]!.after, plannerY);
    assert.deepEqual(review.edits[1]!.before, null);
    assert.deepEqual(review.edits[2]!.after, null);
  });

  test("the review names a create as new and a delete as removed", () => {
    const activation = prepareProfilePromotion(
      request({
        activeProfiles: [profile()],
        edits: [{ action: "delete", id: "reviewer-x" }],
      }),
    );
    const text = describeProfilePromotionReview(activation);
    assert.match(text, /after: removed/);
    const created = describeProfilePromotionReview(prepareProfilePromotion(request()));
    assert.match(created, /before: new/);
  });

  test("the text review names the digest, the position, both snapshots and the bound", () => {
    const activation = prepareProfilePromotion(
      request({
        activeProfiles: [plannerX],
        edits: [{ action: "update", profile: plannerY }],
      }),
    );
    const text = describeProfilePromotionReview(activation);
    assert.match(text, new RegExp(DIGEST));
    assert.match(text, /chain position 7/);
    assert.match(text, /parent bound: policy=default turns=8 context tokens=32768/);
    assert.match(text, /before: Planner X/);
    assert.match(text, /after: Planner Y/);
    assert.match(text, /edit 1 update planner-x/);
  });

  test("the text review is plain ASCII", () => {
    const activation = prepareProfilePromotion(
      request({
        edits: [{ action: "create", profile: profile({ systemPrompt: "line one\nline two" }) }],
      }),
    );
    const text = describeProfilePromotionReview(activation);
    assert.match(text, /^[\t\n\x20-\x7e]*$/);
  });

  test("a record without a parent bound reviews with no bound rather than an invented one", () => {
    const legacy: HarnessProfileRecord = {
      digest: DIGEST,
      atSeq: 7,
      changes: [{ id: "reviewer-x", before: null, after: profile() }],
    };
    assert.equal(reviewProfilePromotion(legacy).parentBound, null);
    assert.match(describeProfilePromotionReview(legacy), /parent bound: not recorded/);
  });

  test("a malformed parent bound in a signed record is refused", () => {
    assert.throws(
      () =>
        reviewProfilePromotion({
          digest: DIGEST,
          atSeq: 7,
          parentBound: parent({ maxTurns: 0 }),
          changes: [{ id: "reviewer-x", before: null, after: profile() }],
        }),
      /The parent bound is malformed/,
    );
  });

  test("a review of a malformed record is refused rather than rendered", () => {
    assert.throws(
      () => describeProfilePromotionReview({ digest: DIGEST } as unknown as HarnessProfileRecord),
      /The signed profile activation is malformed/,
    );
  });
});
