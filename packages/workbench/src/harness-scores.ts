/**
 * Scoring over the signed chain: what the harness is worth measuring.
 *
 * The port of the statistical apparatus is deliberate and its limits are not
 * borrowed from a benchmark harness. `omp` keeps the only honest scoring
 * machinery of the three repositories (`omp-src`, `ratchet/ratchet.ts`), and
 * two things from it transfer exactly: a confidence interval over *case means*
 * rather than over individual attempts, and guardrails that may not regress
 * outside noise. What does not transfer is the goal. A ratchet climbs a metric
 * a benchmark chose; this measures decisions that were made about safety, so
 * the guardrails carry more weight than the headline number and the headline
 * number is never the thing anybody reads first.
 *
 * Three properties are load-bearing and all three are enforced here rather
 * than left to the caller, because every one of them has a way of failing
 * quietly:
 *
 * - **Nothing here writes, and nothing here decides.** A score is a report.
 *   It must never reach `decide`, and the type surface is built so it cannot be
 *   passed where a `Rule` is expected: the only thing this module exports is
 *   data and pure functions over it. The same discipline `learned-rules.ts`
 *   uses, stated here because the temptation is stronger for a number that
 *   looks like a verdict.
 * - **A gap in the record is not a good score.** A turn that ended `unknown`,
 *   or was cut off by the run deadline, has no measured outcome. It is counted
 *   as unmeasured, never as a success, which is why `unmeasured` is a first
 *   class field rather than something folded into a denominator.
 * - **Two cases cannot carry an interval.** `half` is `null` below two cases,
 *   not zero. A zero half-width would read as "precisely measured" and would
 *   let a verdict be drawn from a sample too small to distinguish from noise.
 *
 * The Student-t table is the two-sided 95% critical value for df 1..30, copied
 * from the ratchet. Beyond df 30 the normal value is used, which is what that
 * harness does as well and is accurate enough there.
 */

/** A ledger entry, as far as this module reads it. Deliberately structural:
 * the miner does not need the chain type and must not depend on it, so a
 * rolled-back or truncated chain cannot make this module fail to load. */
type Entry = { readonly body: unknown };

export type ScoreDirection = "higher" | "lower";

export type ScoreUnit = "ratio" | "ms" | "count" | "usd";

export type ScoreMetric = {
  readonly key: string;
  /** Operator-facing name, for a surface that shows the board. */
  readonly label: string;
  readonly direction: ScoreDirection;
  readonly unit: ScoreUnit;
};

/**
 * Every metric this module can produce, and the direction that is better.
 *
 * The order is the order a reader should meet them in: what is costing a human
 * their time, then what is going wrong, then what is working. `cost_usd` is
 * last because it is the one metric an operator can act on without anyone
 * else's permission, and it is not the one that decides whether the harness is
 * healthy.
 */
export const SCORE_METRICS: {
  readonly [K in ScoreMetric["key"]]: ScoreMetric;
} = {
  hold_rate: {
    key: "hold_rate",
    label: "Calls waiting on a human",
    direction: "lower",
    unit: "ratio",
  },
  deny_rate: {
    key: "deny_rate",
    label: "Calls refused",
    direction: "lower",
    unit: "ratio",
  },
  unknown_tool_rate: {
    key: "unknown_tool_rate",
    label: "Calls we could not classify",
    direction: "lower",
    unit: "ratio",
  },
  first_pass_rate: {
    key: "first_pass_rate",
    label: "Calls needing no correction",
    direction: "higher",
    unit: "ratio",
  },
  median_approval_ms: {
    key: "median_approval_ms",
    label: "Median operator decision time",
    direction: "lower",
    unit: "ms",
  },
  recovery_success_rate: {
    key: "recovery_success_rate",
    label: "Recoveries that finished",
    direction: "higher",
    unit: "ratio",
  },
  rollback_count: {
    key: "rollback_count",
    label: "Rollbacks needed",
    direction: "lower",
    unit: "count",
  },
  cost_usd: {
    key: "cost_usd",
    label: "Spend",
    direction: "lower",
    unit: "usd",
  },
};

/**
 * Metrics that may not regress outside noise.
 *
 * The reason this list exists is a specific failure mode. `hold_rate` alone is
 * trivially optimisable to zero by letting everything through, and a harness
 * that scored well on it while refusals climbed would be scoring a policy
 * change as an improvement. `deny_rate`, `rollback_count` and
 * `unknown_tool_rate` are the three that would move if someone did exactly
 * that, so they are the three a verdict is conditional on.
 *
 * `first_pass_rate` is deliberately absent: it is a genuine objective signal
 * and making it a guardrail would mean optimising the thing being measured.
 */
export const SCORE_GUARDRAILS: readonly ScoreMetric["key"][] = [
  "deny_rate",
  "rollback_count",
  "unknown_tool_rate",
];

export type SplitSummary = {
  /** Cases carrying at least one scored attempt. */
  readonly n: number;
  readonly mean: number | null;
  /** 95% CI half-width over case means. Null below two cases, and null when
   * `mean` is null. Never zero as a stand-in for "not measured". */
  readonly half: number | null;
  /** Attempts that had no measurable outcome. Reported, never averaged in. */
  readonly unmeasured: number;
};

export type ScoreVerdict = "improving" | "declining" | "flat" | "insufficient-data";

export type ScoreBoard = {
  /** Input chains containing at least one recorded, non-Harness tool attempt. */
  readonly caseCount: number;
  readonly metrics: Readonly<Record<string, SplitSummary>>;
  readonly guardrails: Readonly<Record<string, SplitSummary>>;
  readonly verdict: ScoreVerdict;
  /** Why the verdict is what it is. Never empty, because "flat" without a
   * reason is indistinguishable from "not computed". */
  readonly reasons: readonly string[];
  readonly generatedAt: string;
};

/** Two-sided 95% Student-t critical values, df 1..30. */
const T_CRITICAL = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16,
  2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056,
  2.052, 2.048, 2.045, 2.042,
];

const NORMAL_95 = 1.96;

function tCritical(df: number): number {
  return df <= T_CRITICAL.length ? T_CRITICAL[df - 1] : NORMAL_95;
}

const EMPTY: SplitSummary = { n: 0, mean: null, half: null, unmeasured: 0 };

function summary(n: number, mean: number | null, half: number | null, unmeasured: number): SplitSummary {
  return { n, mean, half, unmeasured };
}

/**
 * Summarise per-case means into a summary with an interval.
 *
 * `cases` is one array per case holding that case's attempts. The interval is
 * over the *case means*, not over the pooled attempts, because attempts within
 * a case are not independent: three retries of one call carry far less
 * information than three different calls, and pooling them would report a
 * precision the data does not have. This is the single most important line in
 * the file and it is why the input is grouped rather than flat.
 *
 * An empty case list yields `EMPTY`; a single case yields `half: null`.
 */
export function summariseCases(
  cases: readonly (readonly number[])[],
  unmeasured = 0,
): SplitSummary {
  const means: number[] = [];
  for (const attempts of cases) {
    if (attempts.length === 0) continue;
    let total = 0;
    for (const value of attempts) {
      if (!Number.isFinite(value)) continue;
      total += value;
    }
    const usable = attempts.filter((value) => Number.isFinite(value));
    if (usable.length === 0) continue;
    means.push(total / usable.length);
  }
  if (means.length === 0) return summary(0, null, null, unmeasured);

  let sum = 0;
  for (const mean of means) sum += mean;
  const mean = sum / means.length;

  if (means.length < 2) return summary(means.length, mean, null, unmeasured);

  let ss = 0;
  for (const value of means) ss += (value - mean) ** 2;
  const variance = ss / (means.length - 1);
  const sd = Math.sqrt(variance);
  const half = (tCritical(means.length - 1) * sd) / Math.sqrt(means.length);
  return summary(means.length, mean, half, unmeasured);
}

/** Whether `next` is worse than `before` by more than the interval allows.
 *
 * Two summaries whose intervals overlap are `flat`, which is the only honest
 * reading. Comparing means alone would call a 0.001 move on a noisy metric a
 * regression, and a harness that cries regression on noise gets switched off.
 */
export function compareSplit(
  before: SplitSummary,
  next: SplitSummary,
  direction: ScoreDirection,
): ScoreVerdict {
  if (before.mean === null || next.mean === null) return "insufficient-data";
  if (before.n < 2 || next.n < 2) return "insufficient-data";
  const delta = next.mean - before.mean;
  const slack = (before.half ?? 0) + (next.half ?? 0);
  if (Math.abs(delta) <= slack) return "flat";
  const improved = direction === "higher" ? delta > 0 : delta < 0;
  return improved ? "improving" : "declining";
}

function body(entry: Entry): Record<string, unknown> | null {
  const value = entry.body;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function str(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function num(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Decisions that count towards a rate, split by outcome.
 *
 * `execute:unknown` is unmeasured rather than a failure for the reason
 * `learned-rules.ts` gives: the tool ran and we do not know what happened. That
 * is a gap in our knowledge, and counting it as a bad outcome would make an
 * instrumentation failure look like a model that misbehaves.
 */
type Tally = { allow: number; hold: number; deny: number; attempts: number; unmeasured: number };

function emptyTally(): Tally {
  return { allow: 0, hold: 0, deny: 0, attempts: 0, unmeasured: 0 };
}

function tally(entries: readonly Entry[]): Tally {
  const out = emptyTally();
  for (const entry of entries) {
    const record = body(entry);
    if (record === null) continue;
    const tool = str(record, "tool");
    if (tool.startsWith("harness.")) continue;
    if (tool) out.attempts += 1;
    const decision = str(record, "decision");
    if (!decision) {
      out.unmeasured += 1;
      continue;
    }
    if (decision.startsWith("deny")) {
      out.deny += 1;
      continue;
    }
    if (decision.startsWith("hold")) {
      // An expired hold is a distinct outcome from an operator saying no: it
      // means nobody answered. Both cost a human, neither is a refusal.
      out.hold += 1;
      continue;
    }
    if (decision === "execute:unknown") {
      out.unmeasured += 1;
      continue;
    }
    if (decision === "proxy") {
      out.unmeasured += 1;
      continue;
    }
    if (decision.startsWith("execute")) {
      out.allow += 1;
      continue;
    }
    out.unmeasured += 1;
  }
  return out;
}

function rate(part: number, whole: number): number {
  return whole === 0 ? 0 : part / whole;
}

/**
 * Measure the board over one chain.
 *
 * `cases` groups attempts by case so the interval means what it says. The
 * caller supplies the grouping because only the caller knows what a case is , 
 * a workspace, a model run, a day, and this module must not guess: a wrong
 * grouping produces a confident number about the wrong thing.
 */
export function measureBoard(
  cases: readonly (readonly Entry[])[],
  generatedAt: string,
): ScoreBoard {
  const flat: Entry[] = [];
  for (const entries of cases) flat.push(...entries);

  const totals = tally(flat);
  const decided = totals.allow + totals.hold + totals.deny;

  const holdCases: number[][] = [];
  const denyCases: number[][] = [];
  const approvalCases: number[][] = [];
  const rollbackCases: number[][] = [];
  const recoveryCases: number[][] = [];
  const costCases: number[][] = [];
  const unknownCases: number[][] = [];
  let unknownUnmeasuredTotal = 0;
  let caseCount = 0;

  for (const entries of cases) {
    const local = tally(entries);
    if (local.attempts > 0) caseCount += 1;
    const localDecided = local.allow + local.hold + local.deny;
    // A case contributes a sample only when something in it was decided.
    // `rate(0, 0)` is 0, and a zero is a measurement: `execute:unknown` and
    // `proxy` are unmeasured precisely because nobody proved what happened, so
    // letting them in would report missing evidence as a failed run.
    if (localDecided > 0) {
      holdCases.push([rate(local.hold, localDecided)]);
      denyCases.push([rate(local.deny, localDecided)]);
    }

    const approvals: number[] = [];
    const rollbacks: number[] = [];
    const recoveries: number[] = [];
    const costs: number[] = [];
    let unknownCount = 0;
    let classifiedCount = 0;
    let hasClassification = false;
    let localUnclassifiedUnmeasured = 0;
    for (const entry of entries) {
      const record = body(entry);
      if (record === null) continue;
      const tool = str(record, "tool");
      const isAttempt = tool !== "" && !tool.startsWith("harness.");
      const approval = num(record, "approvalMs");
      if (approval !== undefined) approvals.push(approval);
      if (str(record, "event") === "rollback") rollbacks.push(1);
      if (str(record, "event") === "recovery") {
        const ok = record.ok === true;
        recoveries.push(ok ? 1 : 0);
      }
      const cost = num(record, "costUsd");
      if (cost !== undefined) {
        costs.push(cost);
      }
      if (Object.prototype.hasOwnProperty.call(record, "classification")) {
        hasClassification = true;
        classifiedCount += 1;
        if (str(record, "classification") === "unclassified") unknownCount += 1;
      } else if (isAttempt) {
        localUnclassifiedUnmeasured += 1;
      }
    }
    approvalCases.push(approvals);
    rollbackCases.push(localDecided > 0 ? [rollbacks.length] : []);
    recoveryCases.push(recoveries);
    costCases.push(costs);
    // A case is measured only when at least one record actually carried a
    // classification outcome. Chains written before that field existed, or
    // chains with no connector call, stay unmeasured rather than reporting a
    // measured zero that nobody observed.
    // The metric is a rate, so the sample is a fraction of the calls that were
    // actually classified. Pushing the raw count made a longer chain look
    // worse than a short one, and it put a count where the schema declares a
    // ratio.
    unknownCases.push(
      localDecided > 0 && hasClassification && classifiedCount > 0
        ? [unknownCount / classifiedCount]
        : [],
    );
    unknownUnmeasuredTotal += localUnclassifiedUnmeasured;
  }

  const unmeasured = totals.unmeasured;

  // Decisions alone do not prove either correction history or tool classification.
  const metrics: Record<string, SplitSummary> = {
    hold_rate: summariseCases(holdCases, unmeasured),
    deny_rate: summariseCases(denyCases, unmeasured),
    unknown_tool_rate: summariseCases(unknownCases, unknownUnmeasuredTotal),
    first_pass_rate: summariseCases([], totals.attempts),
    median_approval_ms: summariseCases(approvalCases, unmeasured),
    recovery_success_rate: summariseCases(recoveryCases, 0),
    rollback_count: summariseCases(rollbackCases, unmeasured),
    cost_usd: summariseCases(costCases, unmeasured),
  };

  const guardrails: Record<string, SplitSummary> = {};
  for (const key of SCORE_GUARDRAILS) guardrails[key] = metrics[key];

  const reasons: string[] = [];
  let verdict: ScoreVerdict = "insufficient-data";
  if (decided === 0) {
    reasons.push("no decided call in the chain, so nothing was measured");
  } else if (holdCases.length < 2) {
    reasons.push("fewer than two cases, so no interval can be computed");
  } else {
    verdict = "flat";
    reasons.push("no baseline was supplied, so there is nothing to compare against");
  }

  return { caseCount, metrics, guardrails, verdict, reasons, generatedAt };
}

/**
 * Compare two boards and produce a verdict with its guardrail conditions.
 *
 * The guardrail check runs first and can veto an otherwise improving verdict.
 * That ordering is the whole point: a change that improves `first_pass_rate`
 * while `deny_rate` moves outside noise has not improved the harness, and a
 * verdict that said it had would be the exact failure this module exists to
 * prevent.
 */
export function compareBoards(
  before: ScoreBoard,
  next: ScoreBoard,
): ScoreBoard & { readonly guardrailBreaches: readonly string[] } {
  const breaches: string[] = [];
  for (const key of SCORE_GUARDRAILS) {
    const metric = SCORE_METRICS[key];
    const verdict = compareSplit(before.guardrails[key], next.guardrails[key], metric.direction);
    if (verdict === "declining") breaches.push(`${key} regressed outside noise`);
  }

  const primary = compareSplit(before.metrics.first_pass_rate, next.metrics.first_pass_rate, "higher");
  const reasons = [...next.reasons];
  if (breaches.length) {
    reasons.unshift(`withheld: ${breaches.join("; ")}`);
  }
  if (primary === "insufficient-data") {
    return { ...next, verdict: "insufficient-data", reasons, guardrailBreaches: breaches };
  }
  if (breaches.length) {
    // Not "declining": the headline did not get worse, the conditions under
    // which it counts did. Collapsing the two would hide which one failed.
    return { ...next, verdict: "flat", reasons, guardrailBreaches: breaches };
  }
  return { ...next, verdict: primary, reasons, guardrailBreaches: breaches };
}

/** Metrics that carry no measurement at all, named for a surface to show. */
/**
 * Group a chain's entries by the call shape they name.
 *
 * The board is measured over cases, and only the caller knows what a case is.
 * The CLI reads one ledger (one workspace), so a per-workspace case would
 * leave it with a single sample and no interval. A case here is a call
 * shape, the same tool in the same class, which is the granularity the
 * chain's own records carry and the one that gives a single ledger enough
 * samples to say whether a metric moved.
 */
export function scoreCases(
  entries: readonly { readonly body: unknown }[],
): readonly (readonly { readonly body: unknown }[])[] {
  const byShape = new Map<string, { readonly body: unknown }[]>();
  for (const entry of entries) {
    const record =
      entry.body !== null && typeof entry.body === "object" && !Array.isArray(entry.body)
        ? (entry.body as Record<string, unknown>)
        : null;
    const tool = typeof record?.tool === "string" ? record.tool : "";
    if (!tool) continue;
    const klass = typeof record?.klass === "string" ? record.klass : "";
    const key = `${tool}|${klass}`;
    const list = byShape.get(key) ?? [];
    list.push(entry);
    byShape.set(key, list);
  }
  return [...byShape.values()];
}

export function unmeasuredMetrics(board: ScoreBoard): ScoreMetric["key"][] {
  return (Object.keys(board.metrics) as ScoreMetric["key"][]).filter(
    (key) => board.metrics[key].n === 0,
  );
}

/** A ledger entry with its sequence number, used to partition records across a
 * signed activation boundary without depending on array order. */
export type SequencedEntry = { readonly body: unknown; readonly seq?: number };

export type GuardrailEffect = {
  readonly key: ScoreMetric["key"];
  readonly label: string;
  readonly before: SplitSummary;
  readonly after: SplitSummary;
  readonly verdict: ScoreVerdict;
  readonly regressed: boolean;
  /** True only when both sides of the split carry at least one measured case. */
  readonly measured: boolean;
};

export type RefinementEffect = {
  readonly activationSeq: number;
  /** Inclusive upper sequence bound when the refinement was later rolled back;
   * null while it remains standing at the chain head. */
  readonly untilSeq: number | null;
  readonly before: ScoreBoard;
  readonly after: ScoreBoard & { readonly guardrailBreaches: readonly string[] };
  readonly verdict: ScoreVerdict;
  readonly guardrailBreaches: readonly string[];
  readonly guardrails: readonly GuardrailEffect[];
  /** Guardrails lacking a measurement on either side of the split, named so no
   * consumer mistakes absence of evidence for a pass or a zero. */
  readonly unmeasuredGuardrails: readonly ScoreMetric["key"][];
};

/**
 * Measure the descriptive effect of an activated refinement by splitting the
 * signed chain strictly around its activation sequence (`seq < activationSeq`
 * versus `seq > activationSeq`, capped at `<= untilSeq` when rolled back).
 *
 * Pure, deterministic and order-independent. Strictly disjoint windows prevent
 * pre-activation calls from leaking into post-activation scores, so an
 * activation with no subsequent calls reports every guardrail as unmeasured
 * rather than echoing pre-activation averages. Per decision D1, this never
 * mutates state, gates a proposal, triggers a rollback or enters `decide`.
 */
export function measureRefinementEffect(
  entries: readonly SequencedEntry[],
  activationSeq: number,
  options?: {
    readonly untilSeq?: number | null;
    readonly generatedAt?: string;
  },
): RefinementEffect {
  const ordered = entries
    .filter((entry) => typeof entry.seq === "number" && Number.isInteger(entry.seq))
    .slice()
    .sort((a, b) => a.seq! - b.seq!);
  const untilSeq = options?.untilSeq ?? null;
  const generatedAt = options?.generatedAt ?? "";
  const beforeEntries = ordered.filter((entry) => entry.seq! < activationSeq);
  const afterEntries = ordered.filter(
    (entry) => entry.seq! > activationSeq && (untilSeq === null || entry.seq! <= untilSeq),
  );
  const before = measureBoard(scoreCases(beforeEntries), generatedAt);
  const afterRaw = measureBoard(scoreCases(afterEntries), generatedAt);
  const compared = compareBoards(before, afterRaw);
  const guardrails: GuardrailEffect[] = SCORE_GUARDRAILS.map((key) => {
    const metric = SCORE_METRICS[key];
    const prior = before.guardrails[key];
    const next = afterRaw.guardrails[key];
    const verdict = compareSplit(prior, next, metric.direction);
    return {
      key,
      label: metric.label,
      before: prior,
      after: next,
      verdict,
      regressed: verdict === "declining",
      measured: prior.n > 0 && next.n > 0,
    };
  });
  const unmeasuredGuardrails = guardrails
    .filter((guardrail) => !guardrail.measured)
    .map((guardrail) => guardrail.key);
  return {
    activationSeq,
    untilSeq,
    before,
    after: compared,
    verdict: compared.verdict,
    guardrailBreaches: compared.guardrailBreaches,
    guardrails,
    unmeasuredGuardrails,
  };
}

export type GuardrailCheck = {
  readonly key: ScoreMetric["key"];
  readonly before: number | "unmeasured";
  readonly after: number | "unmeasured";
  readonly status: "held" | "regressed" | "unmeasured";
};

export type GuardrailGate = {
  readonly pass: boolean;
  readonly checks: readonly GuardrailCheck[];
  /** Never empty: a gate without a reason is indistinguishable from unrun. */
  readonly reasons: readonly string[];
};

/**
 * Guardrail regression detector (H8): compare each guardrail's mean with the
 * previous activation's. Unlike `compareBoards`, no noise band is allowed: any
 * worse value blocks, because this gate decides whether a variant may stand,
 * not whether a trend is real. A guardrail unmeasured on either side blocks
 * too; absence of evidence is never a pass.
 */
export function guardrailRegressionGate(
  previous: Readonly<Record<string, SplitSummary | undefined>>,
  current: Readonly<Record<string, SplitSummary | undefined>>,
): GuardrailGate {
  const reasons: string[] = [];
  const checks = SCORE_GUARDRAILS.map((key): GuardrailCheck => {
    const before = previous[key]?.mean ?? "unmeasured";
    const after = current[key]?.mean ?? "unmeasured";
    if (before === "unmeasured" || after === "unmeasured") {
      const side = before === "unmeasured" ? "previous" : "current";
      reasons.push(`${key} unmeasured on the ${side} activation`);
      return { key, before, after, status: "unmeasured" };
    }
    const worse = SCORE_METRICS[key].direction === "lower" ? after > before : after < before;
    if (worse) reasons.push(`${key} regressed: ${before} -> ${after}`);
    return { key, before, after, status: worse ? "regressed" : "held" };
  });
  const pass = reasons.length === 0;
  if (pass) reasons.push("every guardrail measured and none worse than the previous activation");
  return { pass, checks, reasons };
}

/**
 * One reward per evaluated case: the number a policy search may optimise.
 *
 * `reward = passed - breaches*weights.breach - costUsd*weights.cost -
 * latencyMs*weights.latency`, where `breaches` counts measured guardrails above
 * zero. The weights travel with the record, so anyone holding the record can
 * recompute the reward without trusting the writer. A metric with no producer
 * is the string `"unmeasured"`, never `0`, and a weighted term whose input is
 * unmeasured makes the whole reward unmeasured rather than silently free. No
 * prompt or tool output belongs in a record.
 */
export const REWARD_SCHEMA = "nomo.reward.v1";

export type Measured = number | "unmeasured";

export type RewardWeights = {
  readonly breach: number;
  readonly cost: number;
  readonly latency: number;
};

export type RewardRecord = {
  readonly schema: typeof REWARD_SCHEMA;
  readonly caseId: string;
  readonly variantId: string;
  /** The variant this one was measured against, and the one axis that
   * separates them (H2). Both null when no baseline was named. */
  readonly baselineVariantId: string | null;
  readonly changedAxis: string | null;
  readonly passed: boolean;
  readonly guardrails: Readonly<Record<string, Measured>>;
  readonly costUsd: Measured;
  readonly latencyMs: Measured;
  readonly approvalMs: Measured;
  readonly weights: RewardWeights;
  readonly reward: Measured;
};

export type RewardInput = Omit<RewardRecord, "schema" | "reward">;

function measured(name: string, value: unknown): Measured {
  if (value === "unmeasured") return value;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new TypeError(`${name}: expected a non-negative finite number or "unmeasured"`);
  return value;
}

/** Validate operator-supplied weights. There are no default weights: a
 * constant chosen here would be a preference nobody made. */
export function parseRewardWeights(value: unknown): RewardWeights {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("weights: expected an object with breach, cost and latency");
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record))
    if (key !== "breach" && key !== "cost" && key !== "latency")
      throw new TypeError(`weights: unknown weight ${key}`);
  const weight = (key: keyof RewardWeights): number => {
    const raw = record[key];
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0)
      throw new TypeError(`weights.${key}: expected a non-negative finite number`);
    return raw;
  };
  return { breach: weight("breach"), cost: weight("cost"), latency: weight("latency") };
}

/** Recompute a reward from a record's own fields. Pure and deterministic, so
 * a stored reward that differs from this value was not produced by it. */
export function computeReward(input: RewardInput): Measured {
  const weights = parseRewardWeights(input.weights);
  const guardrails = Object.values(input.guardrails).map((value) => measured("guardrail", value));
  let reward = input.passed ? 1 : 0;
  if (weights.breach !== 0) {
    // No guardrail at all is no evidence of no breach.
    if (guardrails.length === 0 || guardrails.includes("unmeasured")) return "unmeasured";
    reward -= guardrails.filter((value) => (value as number) > 0).length * weights.breach;
  }
  const terms: [Measured, number][] = [
    [measured("costUsd", input.costUsd), weights.cost],
    [measured("latencyMs", input.latencyMs), weights.latency],
  ];
  for (const [value, weight] of terms) {
    if (weight === 0) continue;
    if (value === "unmeasured") return "unmeasured";
    reward -= value * weight;
  }
  return reward;
}

/** Build one record for one evaluated case. */
export function rewardRecord(input: RewardInput): RewardRecord {
  if (typeof input.caseId !== "string" || !input.caseId.trim())
    throw new TypeError("caseId: required");
  if (typeof input.variantId !== "string" || !input.variantId.trim())
    throw new TypeError("variantId: required");
  if (typeof input.passed !== "boolean") throw new TypeError("passed: expected a boolean");
  const nullableText = (name: string, value: unknown): string | null => {
    if (value === null) return null;
    if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name}: expected a string or null`);
    return value;
  };
  const baselineVariantId = nullableText("baselineVariantId", input.baselineVariantId);
  const changedAxis = nullableText("changedAxis", input.changedAxis);
  if (changedAxis !== null && baselineVariantId === null)
    throw new TypeError("changedAxis: needs a baselineVariantId");
  return {
    schema: REWARD_SCHEMA,
    caseId: input.caseId,
    variantId: input.variantId,
    baselineVariantId,
    changedAxis,
    passed: input.passed,
    guardrails: { ...input.guardrails },
    costUsd: measured("costUsd", input.costUsd),
    latencyMs: measured("latencyMs", input.latencyMs),
    approvalMs: measured("approvalMs", input.approvalMs),
    weights: parseRewardWeights(input.weights),
    reward: computeReward(input),
  };
}

export type RewardComparison =
  | {
      readonly comparable: true;
      readonly caseId: string;
      readonly changedAxis: string | null;
      /** candidate minus baseline; unmeasured when either reward is. */
      readonly delta: Measured;
    }
  | { readonly comparable: false; readonly reason: string };

/**
 * Whether "candidate beat baseline on this case" is checkable from the two
 * records alone. The candidate must name the baseline it was measured against
 * (which the eval only writes when the two variants differ in at most one
 * axis), both must use the same weights, and both stored rewards must
 * recompute from their own fields.
 */
export function compareRewardRecords(
  baseline: RewardRecord,
  candidate: RewardRecord,
): RewardComparison {
  if (baseline.caseId !== candidate.caseId)
    return { comparable: false, reason: "records are for different cases" };
  const same = candidate.variantId === baseline.variantId;
  if (!same && candidate.baselineVariantId !== baseline.variantId)
    return { comparable: false, reason: "candidate was not measured against this baseline" };
  if (!same && candidate.changedAxis === null)
    return { comparable: false, reason: "candidate names no changed axis" };
  const weights = (record: RewardRecord) =>
    [record.weights.breach, record.weights.cost, record.weights.latency].join(",");
  if (weights(baseline) !== weights(candidate))
    return { comparable: false, reason: "records use different weights" };
  for (const record of [baseline, candidate])
    if (computeReward(record) !== record.reward)
      return { comparable: false, reason: `stored reward for ${record.variantId} does not recompute` };
  const delta =
    typeof baseline.reward === "number" && typeof candidate.reward === "number"
      ? candidate.reward - baseline.reward
      : "unmeasured";
  return {
    comparable: true,
    caseId: candidate.caseId,
    changedAxis: same ? null : candidate.changedAxis,
    delta,
  };
}
