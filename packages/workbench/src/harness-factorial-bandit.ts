/**
 * Two-axis factorial bandit (H18).
 *
 * Four treatment combinations are explored together, so a reward belongs to a
 * joint setting rather than being misread as two independent one-axis arms.
 * The interaction contrast is reported only when every cell has measured
 * reward; missing cells are unmeasured, never zero. This remains a contextual
 * bandit/policy-search primitive: nothing here trains a model.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalJson } from "../../ledger/src/canonical.ts";
import { ARM_AXES, defineArms, verifyArm, type ArmAxis, type HarnessArm } from "./harness-arms.ts";
import { sampleBetaPosterior, type BanditApproval } from "./harness-bandit.ts";

export const FACTORIAL_BANDIT_SCHEMA = "nomo.factorial-bandit.v1";
const SEPARATION_Z = 1.96;

export type FactorialArm = {
  readonly armId: string;
  readonly axes: readonly [ArmAxis, ArmAxis];
  readonly components: readonly [HarnessArm, HarnessArm];
  readonly digest: string;
};

export type FactorialPosterior = {
  readonly armId: string;
  readonly alpha: number;
  readonly beta: number;
  readonly samples: number;
};

export type FactorialStopReason = "budget" | "separated" | "unapproved-guardrail";

export type FactorialBanditState = {
  readonly schema: typeof FACTORIAL_BANDIT_SCHEMA;
  readonly axes: readonly [ArmAxis, ArmAxis];
  readonly treatments: readonly FactorialArm[];
  readonly arms: readonly FactorialPosterior[];
  readonly budgetTokens: number;
  readonly spentTokens: number;
  readonly stopReason: FactorialStopReason | null;
};

export type FactorialEffects = {
  readonly main: Readonly<Record<string, number | null>>;
  readonly interaction: number | null;
  readonly cellMeans: Readonly<Record<string, number | null>>;
  readonly cellSamples: Readonly<Record<string, number>>;
  readonly unmeasured: readonly string[];
};

type FactorialEvent =
  | {
      readonly type: "start";
      readonly schema: typeof FACTORIAL_BANDIT_SCHEMA;
      readonly treatments: readonly FactorialArm[];
      readonly budgetTokens: number;
      readonly approval?: BanditApproval;
    }
  | { readonly type: "refusal"; readonly axes: readonly [ArmAxis, ArmAxis]; readonly reason: string }
  | { readonly type: "observation"; readonly armId: string; readonly reward: number; readonly tokens: number }
  | { readonly type: "stop"; readonly reason: FactorialStopReason }
  | { readonly type: "reset"; readonly reason: string };

const sha256 = (text: string): string =>
  `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;

function treatmentDigest(components: readonly [HarnessArm, HarnessArm]): string {
  return sha256(canonicalJson(components.map(({ axis, value, digest }) => ({ axis, value, digest }))));
}

/** Digest an approval must name: the four treatment digests, in order. */
export function factorialArmsDigest(treatments: readonly FactorialArm[]): string {
  return sha256(canonicalJson(treatments.map((treatment) => treatment.digest)));
}

function validateTreatments(treatments: readonly FactorialArm[]): void {
  if (treatments.length !== 4) throw new RangeError("factorial bandit: exactly four treatment combinations are required");
  if (new Set(treatments.map((treatment) => treatment.armId)).size !== 4)
    throw new RangeError("factorial bandit: treatment ids must be unique");
  const axes = treatments[0]?.axes;
  if (!axes || axes[0] === axes[1]) throw new TypeError("factorial bandit: two distinct axes are required");
  const combinations = new Set<string>();
  const levels = new Map<ArmAxis, Set<number | string>>([[axes[0], new Set()], [axes[1], new Set()]]);
  for (const treatment of treatments) {
    if (treatment.axes[0] !== axes[0] || treatment.axes[1] !== axes[1])
      throw new TypeError("factorial bandit: every treatment must use the same ordered axes");
    if (
      treatment.components.length !== 2 ||
      treatment.components[0].axis !== axes[0] ||
      treatment.components[1].axis !== axes[1] ||
      !verifyArm(treatment.components[0]) ||
      !verifyArm(treatment.components[1])
    )
      throw new TypeError(`factorial bandit: treatment ${treatment.armId} does not verify`);
    if (treatmentDigest(treatment.components) !== treatment.digest)
      throw new TypeError(`factorial bandit: treatment ${treatment.armId} digest mismatch`);
    levels.get(axes[0])!.add(treatment.components[0].value);
    levels.get(axes[1])!.add(treatment.components[1].value);
    combinations.add(canonicalJson(treatment.components.map((component) => [component.axis, component.value])));
  }
  if (levels.get(axes[0])!.size !== 2 || levels.get(axes[1])!.size !== 2 || combinations.size !== 4)
    throw new TypeError("factorial bandit: treatments must be the complete 2x2 factorial combination set");
}

/** Compose a 2x2 factorial design from two already validated two-level axes. */
export function defineFactorialArms(
  firstAxis: ArmAxis,
  firstArms: readonly { readonly armId: string; readonly value: unknown }[],
  secondAxis: ArmAxis,
  secondArms: readonly { readonly armId: string; readonly value: unknown }[],
): readonly FactorialArm[] {
  if (firstAxis === secondAxis) throw new TypeError("factorial bandit: axes must differ");
  const first = defineArms(firstAxis, firstArms);
  const second = defineArms(secondAxis, secondArms);
  if (first.length !== 2 || second.length !== 2)
    throw new RangeError("factorial bandit: interaction terms require exactly two levels per axis");
  return first.flatMap((a) =>
    second.map((b): FactorialArm => {
      const components = [a, b] as const;
      return {
        armId: `${a.armId}__${b.armId}`,
        axes: [firstAxis, secondAxis],
        components,
        digest: treatmentDigest(components),
      };
    }),
  );
}

function guardrailRefusal(treatments: readonly FactorialArm[], approval: BanditApproval | undefined): string | null {
  const axes = treatments[0]!.axes;
  if (!axes.some((axis) => ARM_AXES[axis].guardrail)) return null;
  if (!approval) return `${axes.join(" x ")} includes a guardrail axis and no approval was given`;
  const expected = factorialArmsDigest(treatments);
  if (approval.armsDigest !== expected)
    return `${axes.join(" x ")} includes a guardrail axis and the approval names ${approval.armsDigest}, not ${expected}`;
  return null;
}

function validateApproval(approval: unknown): asserts approval is BanditApproval | undefined {
  if (approval === undefined) return;
  const value = approval as Record<string, unknown> | null;
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("factorial bandit: approval must be an object");
  for (const key of Object.keys(value))
    if (key !== "approvedBy" && key !== "armsDigest")
      throw new TypeError(`factorial bandit: approval has unknown field ${key}`);
  if (typeof value.approvedBy !== "string" || !value.approvedBy.trim())
    throw new TypeError("factorial bandit: approval.approvedBy is required");
  if (typeof value.armsDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.armsDigest))
    throw new TypeError("factorial bandit: approval.armsDigest must be a sha256 digest");
}

function replay(events: readonly FactorialEvent[]): FactorialBanditState {
  const [start, ...rest] = events;
  if (start?.type !== "start" || start.schema !== FACTORIAL_BANDIT_SCHEMA)
    throw new TypeError(`factorial bandit: history must begin with a ${FACTORIAL_BANDIT_SCHEMA} start event`);
  validateTreatments(start.treatments);
  validateApproval(start.approval);
  if (!Number.isSafeInteger(start.budgetTokens) || start.budgetTokens <= 0)
    throw new RangeError("factorial bandit: budgetTokens must be a positive integer");
  const refused = guardrailRefusal(start.treatments, start.approval) !== null;
  let arms: FactorialPosterior[] = start.treatments.map((treatment) => ({
    armId: treatment.armId,
    alpha: 1,
    beta: 1,
    samples: 0,
  }));
  let spentTokens = 0;
  let stopReason: FactorialStopReason | null = refused ? "unapproved-guardrail" : null;
  for (const event of rest) {
    if (event.type === "observation") {
      if (stopReason) throw new TypeError(`factorial bandit: observation recorded after stop (${stopReason})`);
      const index = arms.findIndex((arm) => arm.armId === event.armId);
      if (index < 0) throw new RangeError(`factorial bandit: unknown observed arm ${event.armId}`);
      checkObservation(event.reward, event.tokens);
      arms = arms.map((arm, position) =>
        position === index
          ? { ...arm, alpha: arm.alpha + event.reward, beta: arm.beta + 1 - event.reward, samples: arm.samples + 1 }
          : arm,
      );
      spentTokens += event.tokens;
    } else if (event.type === "stop") {
      stopReason = event.reason;
    } else if (event.type === "refusal") {
      stopReason = "unapproved-guardrail";
    } else if (event.type === "reset") {
      arms = arms.map((arm) => ({ ...arm, alpha: 1, beta: 1, samples: 0 }));
      stopReason = refused
        ? "unapproved-guardrail"
        : spentTokens >= start.budgetTokens
          ? "budget"
          : null;
    } else {
      throw new TypeError(`factorial bandit: unknown event ${JSON.stringify(event)}`);
    }
  }
  return {
    schema: FACTORIAL_BANDIT_SCHEMA,
    axes: start.treatments[0]!.axes,
    treatments: start.treatments,
    arms,
    budgetTokens: start.budgetTokens,
    spentTokens,
    stopReason,
  };
}

function readEvents(path: string): FactorialEvent[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as FactorialEvent;
      } catch (error) {
        throw new TypeError(`factorial bandit: invalid JSON at line ${index + 1}`, { cause: error });
      }
    });
}

export function readFactorialBandit(path: string): FactorialBanditState {
  return replay(readEvents(path));
}

const append = (path: string, event: FactorialEvent) => appendFileSync(path, `${canonicalJson(event)}\n`);

/** Open or replay an append-only factorial search. */
export function openFactorialBandit(
  path: string,
  input: {
    readonly treatments: readonly FactorialArm[];
    readonly budgetTokens: number;
    readonly approval?: BanditApproval;
  },
): FactorialBanditState {
  validateTreatments(input.treatments);
  validateApproval(input.approval);
  if (existsSync(path)) {
    const events = readEvents(path);
    const start = events[0];
    const state = replay(events);
    if (start?.type === "start" && canonicalJson(start.treatments) !== canonicalJson(input.treatments))
      throw new RangeError(`factorial bandit: ${path} was started with different treatments`);
    if (state.budgetTokens !== input.budgetTokens)
      throw new RangeError(`factorial bandit: ${path} was started with budget ${state.budgetTokens}`);
    if (start?.type === "start" && canonicalJson(start.approval ?? null) !== canonicalJson(input.approval ?? null))
      throw new RangeError(`factorial bandit: ${path} was started with a different approval; start a new history`);
    return state;
  }
  mkdirSync(dirname(path), { recursive: true });
  const start: FactorialEvent = {
    type: "start",
    schema: FACTORIAL_BANDIT_SCHEMA,
    treatments: input.treatments,
    budgetTokens: input.budgetTokens,
    ...(input.approval ? { approval: { approvedBy: input.approval.approvedBy, armsDigest: input.approval.armsDigest } } : {}),
  };
  const lines: FactorialEvent[] = [start];
  const refusal = guardrailRefusal(input.treatments, input.approval);
  if (refusal) lines.push({ type: "refusal", axes: input.treatments[0]!.axes, reason: refusal });
  writeFileSync(path, lines.map((line) => `${canonicalJson(line)}\n`).join(""), { flag: "wx" });
  return replay(lines);
}

/** Pick a treatment combination by Thompson sampling, or null once stopped. */
export function sampleFactorialArm(state: FactorialBanditState, random: () => number = Math.random): string | null {
  if (state.stopReason) return null;
  let best: { armId: string; draw: number } | null = null;
  for (const arm of state.arms) {
    const draw = sampleBetaPosterior(arm.alpha, arm.beta, random);
    if (!best || draw > best.draw) best = { armId: arm.armId, draw };
  }
  return best?.armId ?? null;
}

function bounds(arm: FactorialPosterior): { mean: number; low: number; high: number } {
  const n = arm.alpha + arm.beta;
  const mean = arm.alpha / n;
  const spread = SEPARATION_Z * Math.sqrt((arm.alpha * arm.beta) / (n * n * (n + 1)));
  return { mean, low: mean - spread, high: mean + spread };
}

function separated(arms: readonly FactorialPosterior[]): boolean {
  const ranked = arms.map(bounds).sort((a, b) => b.mean - a.mean);
  return ranked.slice(1).every((other) => ranked[0]!.low > other.high);
}

function checkObservation(reward: number, tokens: number): void {
  if (!Number.isFinite(reward) || reward < 0 || reward > 1)
    throw new TypeError("factorial bandit: reward must be in [0, 1]");
  if (!Number.isSafeInteger(tokens) || tokens < 0)
    throw new TypeError("factorial bandit: tokens must be a non-negative integer");
}

/** Append one treatment reward and close the search when separated or spent. */
export function recordFactorialReward(
  path: string,
  observation: { readonly armId: string; readonly reward: number; readonly tokens: number },
): FactorialBanditState {
  const state = readFactorialBandit(path);
  if (state.stopReason) throw new RangeError(`factorial bandit: search stopped: ${state.stopReason}`);
  if (!state.arms.some((arm) => arm.armId === observation.armId))
    throw new RangeError(`Unknown treatment ${observation.armId}. Known: ${state.arms.map((arm) => arm.armId).join(", ")}.`);
  checkObservation(observation.reward, observation.tokens);
  append(path, { type: "observation", ...observation });
  const next = readFactorialBandit(path);
  const reason: FactorialStopReason | null =
    next.spentTokens >= next.budgetTokens ? "budget" : separated(next.arms) ? "separated" : null;
  if (!reason) return next;
  append(path, { type: "stop", reason });
  return { ...next, stopReason: reason };
}

/** Return every posterior to the prior. Spent tokens stay spent. */
export function resetFactorialBandit(path: string, reason: string): FactorialBanditState {
  if (!reason.trim()) throw new TypeError("factorial bandit: a reset needs a recorded reason");
  readFactorialBandit(path);
  append(path, { type: "reset", reason });
  return readFactorialBandit(path);
}

/** Main effects and the 2x2 interaction contrast from measured cells only. */
export function factorialEffects(state: FactorialBanditState): FactorialEffects {
  const posterior = new Map(state.arms.map((arm) => [arm.armId, arm]));
  const ids = state.treatments.map((treatment) => treatment.armId);
  const mean = (armId: string): number | null => {
    const arm = posterior.get(armId);
    return arm && arm.samples > 0 ? (arm.alpha - 1) / arm.samples : null;
  };
  const cellMeans = Object.fromEntries(ids.map((id) => [id, mean(id)]));
  const cellSamples = Object.fromEntries(ids.map((id) => [id, posterior.get(id)?.samples ?? 0]));
  const unmeasured = ids.filter((id) => cellMeans[id] === null);
  const [a0b0, a0b1, a1b0, a1b1] = ids.map((id) => cellMeans[id]);
  const complete = unmeasured.length === 0;
  const [firstAxis, secondAxis] = state.axes;
  return {
    main: {
      [firstAxis]: complete ? (a1b0! + a1b1!) / 2 - (a0b0! + a0b1!) / 2 : null,
      [secondAxis]: complete ? (a0b1! + a1b1!) / 2 - (a0b0! + a1b0!) / 2 : null,
    },
    interaction: complete ? (a1b1! - a1b0!) - (a0b1! - a0b0!) : null,
    cellMeans,
    cellSamples,
    unmeasured,
  };
}
