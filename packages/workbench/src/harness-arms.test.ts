import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ARM_AXES, MAX_ARMS_PER_AXIS, defineArms, verifyArm } from "./harness-arms.ts";
import { HARNESS_SETTINGS } from "./harness-settings.ts";

test("the arm axes are the three planned ones and only the preamble is a guardrail axis", () => {
  assert.deepEqual(Object.keys(ARM_AXES).sort(), [
    "autoCompactMessages",
    "maxToolResultCharacters",
    "promptPreamble",
  ]);
  assert.equal(ARM_AXES.promptPreamble.guardrail, true);
  assert.equal(ARM_AXES.autoCompactMessages.guardrail, false);
  assert.equal(ARM_AXES.maxToolResultCharacters.guardrail, false);
  assert.equal(MAX_ARMS_PER_AXIS, 4);
});

test("each arm has an id, its value and a digest that recomputes", () => {
  const arms = defineArms("autoCompactMessages", [
    { armId: "compaction-75", value: 75 },
    { armId: "compaction-150", value: 150 },
  ]);
  assert.equal(arms.length, 2);
  assert.deepEqual(Object.keys(arms[0]!).sort(), ["armId", "axis", "digest", "value"]);
  assert.equal(arms[0]!.axis, "autoCompactMessages");
  assert.equal(arms[0]!.value, 75);
  assert.match(arms[0]!.digest, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(arms[0]!.digest, arms[1]!.digest);
  assert.equal(verifyArm(arms[0]!), true);
  assert.equal(verifyArm({ ...arms[0]!, value: 76 }), false);
  assert.equal(verifyArm({ ...arms[0]!, axis: "maxToolResultCharacters" }), false);
  assert.deepEqual(defineArms("autoCompactMessages", [{ armId: "compaction-75", value: 75 }])[0], arms[0]);
});

test("a preamble arm keeps a digest of the text, never the text", () => {
  const [arm] = defineArms("promptPreamble", [{ armId: "terse", value: "be terse" }]);
  const textDigest = `sha256:${createHash("sha256").update("be terse", "utf8").digest("hex")}`;
  assert.equal(arm!.value, textDigest);
  assert.doesNotMatch(JSON.stringify(arm), /be terse/);
  assert.equal(verifyArm(arm!), true);
});

test("more than four arms, duplicates and unknown axes are refused", () => {
  const five = [50, 75, 100, 125, 150].map((value) => ({ armId: `c-${value}`, value }));
  assert.throws(() => defineArms("autoCompactMessages", five), /at most 4 arms/);
  assert.throws(() => defineArms("autoCompactMessages", []), /at least one arm/);
  assert.throws(
    () => defineArms("autoCompactMessages", [{ armId: "a", value: 75 }, { armId: "a", value: 76 }]),
    /duplicate arm id a/,
  );
  assert.throws(
    () => defineArms("autoCompactMessages", [{ armId: "a", value: 75 }, { armId: "b", value: 75 }]),
    /duplicate value/,
  );
  assert.throws(() => defineArms("maxTurns" as never, [{ armId: "a", value: 1 }]), /Unknown arm axis maxTurns/);
  assert.throws(() => defineArms("autoCompactMessages", [{ armId: "bad id", value: 75 }]), /arm id/);
});

test("a numeric arm outside the setting's bounds is refused rather than clamped", () => {
  const { min, max } = HARNESS_SETTINGS.maxToolResultCharacters;
  assert.throws(() => defineArms("maxToolResultCharacters", [{ armId: "low", value: min - 1 }]), /between/);
  assert.throws(() => defineArms("maxToolResultCharacters", [{ armId: "high", value: max + 1 }]), /between/);
  assert.throws(() => defineArms("autoCompactMessages", [{ armId: "frac", value: 7.5 }]), /integer/);
  assert.throws(() => defineArms("autoCompactMessages", [{ armId: "text", value: "75" }]), /integer/);
  assert.throws(() => defineArms("promptPreamble", [{ armId: "num", value: 1 }]), /string/);
});
