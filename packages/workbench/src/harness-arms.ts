/**
 * Bandit arms over harness variants (R1).
 *
 * An arm is one value for one variant axis. A policy search over arms is a
 * contextual bandit, not reinforcement learning: nothing here trains a model.
 * Each arm carries a sha256 digest over its canonical axis and value, so a
 * stored arm whose fields were edited no longer verifies. A prompt preamble
 * arm stores a digest of the text, matching `variantIdentity`, so the text
 * itself never enters an arm, a bandit state or a record.
 */

import { createHash } from "node:crypto";
import { canonicalJson } from "../../ledger/src/canonical.ts";
import { HARNESS_SETTINGS } from "./harness-settings.ts";

/** The axes an arm may vary. `guardrail` marks an axis whose change can alter
 * the instructions or limits that keep a run safe; exploring it needs an
 * approval (R4). The preamble carries the run's standing instructions. */
export const ARM_AXES = {
  autoCompactMessages: { kind: "setting", guardrail: false },
  maxToolResultCharacters: { kind: "setting", guardrail: false },
  promptPreamble: { kind: "text", guardrail: true },
} as const;

export type ArmAxis = keyof typeof ARM_AXES;

export const MAX_ARMS_PER_AXIS = 4;

export type HarnessArm = {
  readonly armId: string;
  readonly axis: ArmAxis;
  readonly value: number | string;
  readonly digest: string;
};

const ARM_ID = /^[A-Za-z0-9._-]{1,64}$/;

const sha256 = (text: string): string =>
  `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;

const armDigest = (axis: string, value: unknown): string => sha256(canonicalJson({ axis, value }));

function armValue(axis: ArmAxis, armId: string, value: unknown): number | string {
  if (ARM_AXES[axis].kind === "text") {
    if (typeof value !== "string") throw new TypeError(`${armId}: ${axis} expects a string`);
    return sha256(value);
  }
  const spec = HARNESS_SETTINGS[axis as Exclude<ArmAxis, "promptPreamble">];
  if (typeof value !== "number" || !Number.isInteger(value))
    throw new TypeError(`${armId}: ${axis} expects an integer`);
  if (value < spec.min || value > spec.max)
    throw new RangeError(`${armId}: ${axis} must be between ${spec.min} and ${spec.max}, got ${value}`);
  return value;
}

/** Define the arms for one axis. Refuses rather than clamps: an arm whose
 * value silently changed would be measured as something nobody chose. */
export function defineArms(
  axis: ArmAxis,
  arms: readonly { readonly armId: string; readonly value: unknown }[],
): readonly HarnessArm[] {
  if (!Object.hasOwn(ARM_AXES, axis))
    throw new TypeError(`Unknown arm axis ${String(axis)}. Known: ${Object.keys(ARM_AXES).sort().join(", ")}.`);
  if (arms.length === 0) throw new RangeError(`${axis}: at least one arm is required`);
  if (arms.length > MAX_ARMS_PER_AXIS)
    throw new RangeError(`${axis}: at most ${MAX_ARMS_PER_AXIS} arms per axis, got ${arms.length}`);
  const ids = new Set<string>();
  const values = new Set<number | string>();
  return arms.map(({ armId, value }) => {
    if (typeof armId !== "string" || !ARM_ID.test(armId))
      throw new TypeError(`arm id ${JSON.stringify(armId)} must match ${ARM_ID}`);
    if (ids.has(armId)) throw new RangeError(`${axis}: duplicate arm id ${armId}`);
    const resolved = armValue(axis, armId, value);
    if (values.has(resolved)) throw new RangeError(`${axis}: duplicate value for arm ${armId}`);
    ids.add(armId);
    values.add(resolved);
    return { armId, axis, value: resolved, digest: armDigest(axis, resolved) };
  });
}

/** True when the arm's digest recomputes from its own axis and value. */
export function verifyArm(arm: HarnessArm): boolean {
  return Object.hasOwn(ARM_AXES, arm.axis) && armDigest(arm.axis, arm.value) === arm.digest;
}
