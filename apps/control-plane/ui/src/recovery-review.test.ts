import test from "node:test";
import assert from "node:assert/strict";
import {
  recoveryReview,
  recoveryApplyBody,
  recoveryStatusPath,
  type RecoveryReview,
} from "./recovery-review.ts";
const plan = {
  jobId: "job-1",
  planDigest: "sha256:reviewed",
  steps: [
    { operationId: "op-2", sequence: 2 },
    { operationId: "op-1", sequence: 1 },
  ],
  residuals: [],
};

test("a recovery preview keeps the exact reviewed digest and operation order", () => {
  const state = recoveryReview(
    { phase: "planning" },
    { type: "planned", plan },
  );
  assert.equal(state.plan, plan);
  assert.deepEqual(recoveryApplyBody(state), {
    jobId: "job-1",
    planDigest: "sha256:reviewed",
    approved: true,
  });
  const poll = recoveryReview(state, {
    type: "observed",
    result: { jobId: "job-1", planDigest: "sha256:different" },
  });
  assert.equal(poll.plan, plan);
  assert.deepEqual(
    poll.plan?.steps.map((step) => step.operationId),
    ["op-2", "op-1"],
  );
});

test("apply starts only once and a timeout cannot automatically retry", () => {
  const ready = recoveryReview(
    { phase: "planning" },
    { type: "planned", plan },
  );
  const applying = recoveryReview(ready, { type: "applying" });
  assert.equal(recoveryApplyBody(applying), null);
  const failed = recoveryReview(applying, { type: "failed" });
  assert.equal(failed.phase, "blocked");
  assert.equal(recoveryApplyBody(failed), null);
  assert.equal(
    recoveryApplyBody(
      recoveryReview(failed, { type: "observed", result: plan }),
    ),
    null,
  );
});

test("only explicit refresh discards stale approval, even for unknown outcomes", () => {
  const blocked: RecoveryReview = {
    phase: "blocked",
    plan,
    result: { status: "unknown" },
  };
  const stale = recoveryReview(blocked, {
    type: "planned",
    plan: { ...plan, planDigest: "sha256:new" },
  });
  assert.equal(stale, blocked);
  const refreshed = recoveryReview(blocked, { type: "refresh" });
  assert.deepEqual(refreshed, { phase: "planning" });
  const ready = recoveryReview(refreshed, {
    type: "planned",
    plan: { ...plan, jobId: "job-2", planDigest: "sha256:new" },
  });
  assert.equal(recoveryApplyBody(ready)?.jobId, "job-2");
});

test("a retained recovery job can be inspected after session reload without a new identity", () => {
  const session = {
    id: "session-1",
    lastRecoveryJob: { jobId: "job-retained" },
  };
  const restored = JSON.parse(JSON.stringify(session));
  const expected = "/api/sessions/session-1/recovery-jobs/job-retained";
  assert.equal(recoveryStatusPath(session), expected);
  assert.equal(recoveryStatusPath(restored), expected);
  assert.deepEqual(session, restored);
});

test("missing or invalid retained job metadata never offers a status request", () => {
  for (const lastRecoveryJob of [
    undefined,
    null,
    "job",
    {},
    { jobId: null },
    { jobId: 1 },
    { jobId: "" },
  ]) {
    assert.equal(
      recoveryStatusPath({ id: "session-1", lastRecoveryJob }),
      undefined,
    );
  }
});

test("status navigation encodes the exact retained session and job IDs", () => {
  assert.equal(
    recoveryStatusPath({
      id: "session/one",
      lastRecoveryJob: { jobId: "job/two?inspect" },
    }),
    "/api/sessions/session%2Fone/recovery-jobs/job%2Ftwo%3Finspect",
  );
});
