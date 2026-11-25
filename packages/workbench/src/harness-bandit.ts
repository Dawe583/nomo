/**
 * Thompson sampling over harness arms (R2).
 *
 * This is a contextual bandit over harness variants, not reinforcement
 * learning: no model is trained and no gradient exists. Each arm keeps a Beta
 * posterior over a reward in [0, 1]; the sampler draws once per arm and picks
 * the largest draw. A search stops when the leading arm's posterior separates
 * from every other arm or when the token budget is spent.
 *
 * State is an append-only JSONL history. The summary is derived by replaying
 * it, so a restart resumes the posterior rather than resetting it, and a reset
 * is itself a recorded event that must name its reason.
 *
 * Exploration guard (R4): an axis marked `guardrail` in `ARM_AXES` is never
 * explored without an approval bound to the exact arms. Without one the
 * history records a refusal and the search is stopped before any sample, so
 * the refusal is visible in the record and no reset can lift it.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalJson } from "../../ledger/src/canonical.ts";
import { ARM_AXES, verifyArm, type ArmAxis, type HarnessArm } from "./harness-arms.ts";

export const BANDIT_SCHEMA = "nomo.bandit.v1";

/** Credible-interval width (normal approximation) used to call separation. */
const SEPARATION_Z = 1.96;

export type BanditArmState = {
  readonly armId: string;
  readonly alpha: number;
  readonly beta: number;
  readonly samples: number;
};

export type BanditStopReason = "budget" | "separated" | "unapproved-guardrail";

/** Who approved exploring a guardrail axis, bound to `armsDigest(arms)`. */
export type BanditApproval = {
  readonly approvedBy: string;
  readonly armsDigest: string;
};

export type BanditState = {
  readonly schema: typeof BANDIT_SCHEMA;
  readonly axis: ArmAxis;
  readonly arms: readonly BanditArmState[];
  readonly budgetTokens: number;
  readonly spentTokens: number;
  readonly stopReason: BanditStopReason | null;
};

type BanditEvent =
  | {
      readonly type: "start";
      readonly schema: typeof BANDIT_SCHEMA;
      readonly arms: readonly HarnessArm[];
      readonly budgetTokens: number;
      readonly approval?: BanditApproval;
    }
  | { readonly type: "refusal"; readonly axis: ArmAxis; readonly reason: string }
  | { readonly type: "observation"; readonly armId: string; readonly reward: number; readonly tokens: number }
  | { readonly type: "stop"; readonly reason: BanditStopReason }
  | { readonly type: "reset"; readonly reason: string };

const prior = (armId: string): BanditArmState => ({ armId, alpha: 1, beta: 1, samples: 0 });

const append = (path: string, event: BanditEvent) => appendFileSync(path, `${canonicalJson(event)}\n`);

function validateStart(arms: readonly HarnessArm[], budgetTokens: number): void {
  if (arms.length === 0) throw new RangeError("bandit: at least one arm is required");
  for (const arm of arms)
    if (!verifyArm(arm)) throw new TypeError(`bandit: arm ${arm.armId} does not verify against its digest`);
  if (new Set(arms.map((arm) => arm.axis)).size !== 1)
    throw new RangeError("bandit: every arm must vary the same one axis");
  if (new Set(arms.map((arm) => arm.armId)).size !== arms.length)
    throw new RangeError("bandit: arm ids must be unique");
  if (!Number.isSafeInteger(budgetTokens) || budgetTokens <= 0)
    throw new RangeError("bandit: budgetTokens must be a positive integer");
}

/** The digest an approval must name: the arms' own digests, in order. */
export function armsDigest(arms: readonly HarnessArm[]): string {
  const text = canonicalJson(arms.map((arm) => arm.digest));
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function validateApproval(approval: unknown): asserts approval is BanditApproval | undefined {
  if (approval === undefined) return;
  const value = approval as Record<string, unknown> | null;
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("bandit: approval must be an object with approvedBy and armsDigest");
  for (const key of Object.keys(value))
    if (key !== "approvedBy" && key !== "armsDigest") throw new TypeError(`bandit: approval has unknown field ${key}`);
  if (typeof value.approvedBy !== "string" || !value.approvedBy.trim())
    throw new TypeError("bandit: approval.approvedBy is required");
  if (typeof value.armsDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.armsDigest))
    throw new TypeError("bandit: approval.armsDigest must be a sha256 digest");
}

/** Why exploring these arms is refused, or null when it may proceed. */
function guardrailRefusal(arms: readonly HarnessArm[], approval: BanditApproval | undefined): string | null {
  const axis = arms[0]!.axis;
  if (!ARM_AXES[axis].guardrail) return null;
  if (!approval) return `${axis} changes a guardrail and no approval was given`;
  const expected = armsDigest(arms);
  if (approval.armsDigest !== expected)
    return `${axis} changes a guardrail and the approval names ${approval.armsDigest}, not ${expected}`;
  return null;
}

function replay(events: readonly BanditEvent[]): BanditState {
  const [start, ...rest] = events;
  if (start?.type !== "start" || start.schema !== BANDIT_SCHEMA)
    throw new TypeError(`bandit: history must begin with a ${BANDIT_SCHEMA} start event`);
  validateStart(start.arms, start.budgetTokens);
  validateApproval(start.approval);
  // Derived from the start, not trusted from a later line: a history whose
  // refusal line was deleted is still refused.
  const refused = guardrailRefusal(start.arms, start.approval) !== null;
  let arms = start.arms.map((arm) => prior(arm.armId));
  let spentTokens = 0;
  let stopReason: BanditStopReason | null = refused ? "unapproved-guardrail" : null;
  for (const event of rest) {
    if (event.type === "observation") {
      if (stopReason) throw new TypeError(`bandit: observation recorded after stop (${stopReason})`);
      if (!arms.some((arm) => arm.armId === event.armId))
        throw new TypeError(`bandit: history names unknown arm ${event.armId}`);
      checkObservation(event.reward, event.tokens);
      arms = arms.map((arm) =>
        arm.armId === event.armId
          ? { armId: arm.armId, alpha: arm.alpha + event.reward, beta: arm.beta + 1 - event.reward, samples: arm.samples + 1 }
          : arm,
      );
      spentTokens += event.tokens;
    } else if (event.type === "stop") stopReason = event.reason;
    else if (event.type === "refusal") stopReason = "unapproved-guardrail";
    else if (event.type === "reset") {
      arms = arms.map((arm) => prior(arm.armId));
      stopReason = refused ? "unapproved-guardrail" : spentTokens >= start.budgetTokens ? "budget" : null;
    } else throw new TypeError(`bandit: unknown event ${JSON.stringify(event)}`);
  }
  return {
    schema: BANDIT_SCHEMA,
    axis: start.arms[0]!.axis,
    arms,
    budgetTokens: start.budgetTokens,
    spentTokens,
    stopReason,
  };
}

function checkObservation(reward: number, tokens: number): void {
  if (typeof reward !== "number" || !(reward >= 0 && reward <= 1))
    throw new RangeError("bandit: reward must be a number in [0, 1]");
  if (!Number.isSafeInteger(tokens) || tokens < 0)
    throw new RangeError("bandit: tokens must be a non-negative integer");
}

function readEvents(path: string): BanditEvent[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line) as BanditEvent;
      } catch {
        throw new TypeError(`bandit: ${path} line ${index + 1} is not valid JSON`);
      }
    });
}

/** Replay a bandit history into its summary. Fails closed on any bad line. */
export function readBandit(path: string): BanditState {
  return replay(readEvents(path));
}

/** Start a bandit, or resume the existing history at `path`. Resuming with
 * different arms, budget or approval is refused, so a restart cannot quietly
 * begin a new search over a stale posterior or discard the old one. A
 * guardrail axis without a matching approval starts already stopped, with
 * the refusal recorded; a later approval needs a new history. */
export function openBandit(
  path: string,
  input: {
    readonly arms: readonly HarnessArm[];
    readonly budgetTokens: number;
    readonly approval?: BanditApproval;
  },
): BanditState {
  validateStart(input.arms, input.budgetTokens);
  validateApproval(input.approval);
  if (existsSync(path)) {
    const events = readEvents(path);
    const start = events[0];
    const state = replay(events);
    if (start?.type === "start" && canonicalJson(start.arms) !== canonicalJson(input.arms))
      throw new RangeError(`bandit: ${path} was started with different arms`);
    if (state.budgetTokens !== input.budgetTokens)
      throw new RangeError(`bandit: ${path} was started with budget ${state.budgetTokens}`);
    if (start?.type === "start" && canonicalJson(start.approval ?? null) !== canonicalJson(input.approval ?? null))
      throw new RangeError(`bandit: ${path} was started with a different approval; start a new history`);
    return state;
  }
  mkdirSync(dirname(path), { recursive: true });
  const start: BanditEvent = {
    type: "start",
    schema: BANDIT_SCHEMA,
    arms: input.arms,
    budgetTokens: input.budgetTokens,
    ...(input.approval ? { approval: { approvedBy: input.approval.approvedBy, armsDigest: input.approval.armsDigest } } : {}),
  };
  const lines: BanditEvent[] = [start];
  const refusal = guardrailRefusal(input.arms, input.approval);
  if (refusal) lines.push({ type: "refusal", axis: input.arms[0]!.axis, reason: refusal });
  writeFileSync(path, lines.map((line) => `${canonicalJson(line)}\n`).join(""), { flag: "wx" });
  return replay(lines);
}

function sampleNormal(random: () => number): number {
  const u = 1 - random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

/** Marsaglia-Tsang gamma sampler; shape below one uses the standard boost. */
function sampleGamma(shape: number, random: () => number): number {
  if (shape < 1) return sampleGamma(shape + 1, random) * (1 - random()) ** (1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = sampleNormal(random);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = 1 - random();
    if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
}

function sampleBeta(alpha: number, beta: number, random: () => number): number {
  const x = sampleGamma(alpha, random);
  return x / (x + sampleGamma(beta, random));
}

/** Shared Beta posterior draw for bandit implementations. */
export function sampleBetaPosterior(alpha: number, beta: number, random: () => number): number {
  return sampleBeta(alpha, beta, random);
}

/** Pick the arm to try next by Thompson sampling, or null once stopped. */
export function sampleArm(state: BanditState, random: () => number = Math.random): string | null {
  if (state.stopReason) return null;
  let best: { armId: string; draw: number } | null = null;
  for (const arm of state.arms) {
    const draw = sampleBeta(arm.alpha, arm.beta, random);
    if (!best || draw > best.draw) best = { armId: arm.armId, draw };
  }
  return best?.armId ?? null;
}

function bounds(arm: BanditArmState): { mean: number; low: number; high: number } {
  const n = arm.alpha + arm.beta;
  const mean = arm.alpha / n;
  const spread = SEPARATION_Z * Math.sqrt((arm.alpha * arm.beta) / (n * n * (n + 1)));
  return { mean, low: mean - spread, high: mean + spread };
}

/** True when the leading arm's lower bound clears every other arm's upper bound. */
function separated(arms: readonly BanditArmState[]): boolean {
  if (arms.length < 2) return false;
  const ranked = arms.map(bounds).sort((a, b) => b.mean - a.mean);
  return ranked.slice(1).every((other) => ranked[0]!.low > other.high);
}

/** Append one observed reward and, if the search is now finished, its stop. */
export function recordReward(
  path: string,
  observation: { readonly armId: string; readonly reward: number; readonly tokens: number },
): BanditState {
  // shortcut: replays the whole history per write; fine for a few hundred observations, index it if histories grow large.
  const state = readBandit(path);
  if (state.stopReason) throw new RangeError(`bandit: search stopped: ${state.stopReason}`);
  if (!state.arms.some((arm) => arm.armId === observation.armId))
    throw new RangeError(`Unknown arm ${observation.armId}. Known: ${state.arms.map((arm) => arm.armId).join(", ")}.`);
  checkObservation(observation.reward, observation.tokens);
  append(path, { type: "observation", ...observation });
  const next = readBandit(path);
  const reason: BanditStopReason | null =
    next.spentTokens >= next.budgetTokens ? "budget" : separated(next.arms) ? "separated" : null;
  if (!reason) return next;
  append(path, { type: "stop", reason });
  return { ...next, stopReason: reason };
}

/** Return every posterior to the prior. Spent tokens stay spent. */
export function resetBandit(path: string, reason: string): BanditState {
  if (typeof reason !== "string" || !reason.trim()) throw new TypeError("bandit: a reset needs a recorded reason");
  readBandit(path);
  append(path, { type: "reset", reason });
  return readBandit(path);
}
