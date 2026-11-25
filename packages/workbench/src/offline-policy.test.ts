import test from "node:test";
import assert from "node:assert/strict";
import { evaluateOfflinePolicy, OFFLINE_POLICY_SCHEMA } from "./offline-policy.ts";

test("importance weighting scores a candidate without deploying it", () => {
  const report = evaluateOfflinePolicy(
    [
      { armId: "candidate", reward: 1, propensity: 0.5 },
      { armId: "incumbent", reward: 0, propensity: 0.5 },
      { armId: "candidate", reward: 0, propensity: 0.25 },
      { armId: "incumbent", reward: 1, propensity: 0.5 },
    ],
    ["candidate", "incumbent"],
  );
  assert.equal(report.schema, OFFLINE_POLICY_SCHEMA);
  assert.equal(report.rounds, 4);
  assert.equal(report.arms[0]?.armId, "candidate");
  assert.equal(report.arms[0]?.estimate, 0.5);
  assert.equal(report.arms[0]?.matchedRounds, 2);
  assert.equal(report.arms[0]?.coverage, 0.5);
  assert.equal(report.arms[0]?.effectiveSamples, 1.8);
  assert.equal(report.arms[1]?.estimate, 0.5);
  assert.deepEqual(report.unmeasured, []);
});

test("a candidate outside the logging policy support is unmeasured, never zero", () => {
  const report = evaluateOfflinePolicy(
    [{ armId: "incumbent", reward: 1, propensity: 1 }],
    ["new-arm"],
  );
  assert.equal(report.arms[0]?.estimate, null);
  assert.equal(report.arms[0]?.matchedRounds, 0);
  assert.deepEqual(report.unmeasured, ["new-arm"]);
});

test("invalid rewards and propensities are refused", () => {
  assert.throws(
    () => evaluateOfflinePolicy([{ armId: "a", reward: 1.1, propensity: 0.5 }], ["a"]),
    /reward/,
  );
  assert.throws(
    () => evaluateOfflinePolicy([{ armId: "a", reward: 1, propensity: 0 }], ["a"]),
    /propensity/,
  );
});
