import test from "node:test";
import assert from "node:assert/strict";

import {
  SCORE_GUARDRAILS,
  SCORE_METRICS,
  compareBoards,
  compareSplit,
  measureBoard,
  summariseCases,
  unmeasuredMetrics,
  type SplitSummary,
} from "./harness-scores.ts";

/** One entry as the miner reads it: only the body matters. */
const entry = (body: Record<string, unknown>) => ({ body });

const decided = (decision: string) => entry({ tool: "fs.write", klass: "r1", decision });

test("a summary over one case carries no interval", () => {
  // A single case cannot distinguish from noise, and reporting a half-width
  // would let a verdict be drawn from a sample that has no spread in it.
  const summary = summariseCases([[1, 2, 3]]);
  assert.equal(summary.n, 1);
  assert.equal(summary.mean, 2);
  assert.equal(summary.half, null);
});

test("two cases produce a real interval, and it is not zero", () => {
  const summary = summariseCases([[1], [3]]);
  assert.equal(summary.n, 2);
  assert.equal(summary.mean, 2);
  assert.ok(summary.half !== null && summary.half > 0, "half must be a positive width");
});

test("an empty case list is empty rather than a zero measurement", () => {
  const summary = summariseCases([]);
  assert.equal(summary.n, 0);
  assert.equal(summary.mean, null);
  assert.equal(summary.half, null);
});

test("empty cases inside a run are skipped, not averaged as zero", () => {
  // A case with no attempt is not a case whose score was zero. Folding it in
  // would drag every average down without anything having been measured.
  const summary = summariseCases([[2], [], [4]]);
  assert.equal(summary.n, 2);
  assert.equal(summary.mean, 3);
});

test("non-finite attempts are dropped rather than poisoning the mean", () => {
  const summary = summariseCases([[1, Number.NaN, 3], [Number.POSITIVE_INFINITY]]);
  assert.equal(summary.n, 1);
  assert.equal(summary.mean, 2);
});

test("the interval is over case means, so unequal cases do not outweigh each other", () => {
  // 50 attempts in one case and 1 in another is two pieces of evidence, not
  // 51. Pooling them would report a precision the data does not have.
  const pooled = summariseCases([[1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], [100]]);
  const even = summariseCases([[0], [100]]);
  assert.equal(pooled.n, 2);
  assert.equal(even.n, 2);
});

test("a comparison inside the intervals reads flat", () => {
  const before: SplitSummary = summariseCases([[0.5], [0.55], [0.52]]);
  const after: SplitSummary = summariseCases([[0.53], [0.51], [0.56]]);
  assert.equal(compareSplit(before, after, "lower"), "flat");
});

test("a comparison outside the intervals reads as a direction", () => {
  const before: SplitSummary = summariseCases([[0], [0], [0]]);
  const after: SplitSummary = summariseCases([[1], [1], [1]]);
  assert.equal(compareSplit(before, after, "lower"), "declining");
  assert.equal(compareSplit(before, after, "higher"), "improving");
});

test("a comparison with one case on either side is refused, not guessed", () => {
  const one = summariseCases([[1]]);
  const many = summariseCases([[1], [2], [3]]);
  assert.equal(compareSplit(one, many, "lower"), "insufficient-data");
  assert.equal(compareSplit(many, one, "lower"), "insufficient-data");
});

test("execute:unknown is unmeasured, not a failure", () => {
  // The tool ran and we do not know what happened. That is a gap in our
  // knowledge; counting it as a bad outcome would make an instrumentation
  // failure look like a model that misbehaves.
  const board = measureBoard([[decided("execute:unknown")]], "t0");
  assert.equal(board.metrics.first_pass_rate.n, 0);
  assert.equal(board.metrics.first_pass_rate.mean, null);
  assert.equal(board.metrics.first_pass_rate.unmeasured, 1);
  assert.equal(board.metrics.deny_rate.unmeasured, 1);
});

test("a delegated proxy decision is not counted as the model's outcome", () => {
  const board = measureBoard([[decided("proxy")]], "t0");
  assert.equal(board.metrics.first_pass_rate.unmeasured, 1);
  assert.equal(board.metrics.first_pass_rate.mean, null);
});

test("a missing decision is unmeasured rather than assumed allowed", () => {
  const board = measureBoard([[entry({ tool: "fs.write", klass: "r1" })]], "t0");
  assert.equal(board.metrics.first_pass_rate.unmeasured, 1);
});

test("an expired hold costs a human but is not a refusal", () => {
  const board = measureBoard(
    [[decided("hold:approved"), decided("hold:expired"), decided("execute:completed")]],
    "t0",
  );
  // Both hold outcomes count as a human's time, and neither is a refusal:
  // an expired hold means nobody answered, not that anyone said no.
  assert.equal(board.metrics.hold_rate.mean, 2 / 3);
  assert.equal(board.metrics.deny_rate.mean, 0);
  assert.equal(board.metrics.first_pass_rate.mean, null);
  assert.equal(board.metrics.first_pass_rate.unmeasured, 3);
});

test("entries that are not records are skipped rather than crashing the board", () => {
  const board = measureBoard(
    [[entry({ decision: "execute:completed" }), { body: null }, { body: [1] }, { body: 7 }]],
    "t0",
  );
  assert.equal(board.metrics.first_pass_rate.mean, null);
});

test("case count remains visible when first-pass outcome data is unavailable", () => {
  const board = measureBoard(
    [[decided("execute:completed")], [entry({ tool: "harness.proposal" })], []],
    "t0",
  );
  assert.equal(board.caseCount, 1);
  assert.equal(board.metrics.first_pass_rate.n, 0);
});

test("unknown_tool_rate is unavailable until classification outcomes are recorded", () => {
  const board = measureBoard(
    [[decided("execute:completed"), decided("deny:policy")]],
    "t0",
  );
  assert.deepEqual(board.metrics.unknown_tool_rate, {
    n: 0,
    mean: null,
    half: null,
    unmeasured: 2,
  });
  assert.ok(unmeasuredMetrics(board).includes("unknown_tool_rate"));
});

test("Harness lifecycle records are not counted as tool attempts", () => {
  const board = measureBoard(
    [[
      entry({ tool: "harness.proposal", decision: "proposal:created" }),
      entry({ tool: "harness.activation", decision: "proposal:activated" }),
      entry({ tool: "harness.rejection", decision: "proposal:rejected" }),
    ]],
    "t0",
  );
  assert.equal(board.metrics.first_pass_rate.unmeasured, 0);
  assert.equal(board.metrics.unknown_tool_rate.unmeasured, 0);
});

test("first_pass_rate is unavailable without observed correction or retry data", () => {
  const board = measureBoard(
    [[decided("execute:completed"), decided("execute:completed")]],
    "t0",
  );
  assert.deepEqual(board.metrics.first_pass_rate, {
    n: 0,
    mean: null,
    half: null,
    unmeasured: 2,
  });
  assert.ok(unmeasuredMetrics(board).includes("first_pass_rate"));
});

test("a chain with nothing decided reports insufficient data and says why", () => {
  const board = measureBoard([[entry({})]], "t0");
  assert.equal(board.verdict, "insufficient-data");
  assert.ok(board.reasons.length > 0, "a verdict without a reason is not reportable");
});

test("guardrails are the three that stop a policy change scoring as progress", () => {
  // hold_rate alone is optimisable to zero by letting everything through, and
  // the metrics that would move if someone did are exactly these.
  assert.deepEqual([...SCORE_GUARDRAILS], ["deny_rate", "rollback_count", "unknown_tool_rate"]);
  for (const key of SCORE_GUARDRAILS) assert.ok(SCORE_METRICS[key], `${key} must be a declared metric`);
});

test("first_pass_rate is not a guardrail, because it is the thing being measured", () => {
  assert.equal(SCORE_GUARDRAILS.includes("first_pass_rate"), false);
});

test("every metric declares a direction and a unit", () => {
  for (const metric of Object.values(SCORE_METRICS)) {
    assert.ok(metric.direction === "higher" || metric.direction === "lower", metric.key);
    assert.ok(metric.label.length > 0, metric.key);
    assert.ok(["ratio", "ms", "count", "usd"].includes(metric.unit), metric.key);
  }
});

test("a declared metric cannot silently go missing from a measured board", () => {
  // measureBoard builds its metric record from a literal key list while
  // SCORE_METRICS is the declared table, and nothing tied the two together. A
  // metric added to the table alone would be reported nowhere, and the TUI
  // reads the board by key, so the omission would look like a zero.
  const board = measureBoard(
    [
      [decided("deny:policy"), decided("hold:approved"), decided("execute:completed")],
      [decided("hold:approved"), decided("execute:completed")],
    ],
    "t0",
  );
  for (const key of Object.keys(SCORE_METRICS))
    assert.ok(key in board.metrics, `${key} is declared but never measured`);
  for (const key of Object.keys(board.metrics))
    assert.ok(key in SCORE_METRICS, `${key} is measured but never declared`);
});

test("guardrail regressions are reported while first-pass data is unavailable", () => {
  const busy = (allow: number, hold: number, deny: number) => () =>
    Array.from({ length: allow }, () => decided("execute:completed"))
      .concat(Array.from({ length: hold }, () => decided("hold:approved")))
      .concat(Array.from({ length: deny }, () => decided("deny:policy")));

  const before = measureBoard([busy(2, 6, 2)(), busy(2, 6, 2)()], "before");
  const after = measureBoard([busy(6, 0, 4)(), busy(6, 0, 4)()], "after");
  assert.equal(before.metrics.first_pass_rate.mean, null);
  assert.equal(after.metrics.first_pass_rate.mean, null);
  assert.ok(after.metrics.deny_rate.mean! > before.metrics.deny_rate.mean!);

  const verdict = compareBoards(before, after);
  assert.equal(verdict.verdict, "insufficient-data");
  assert.ok(verdict.guardrailBreaches.some((line) => line.includes("deny_rate")));
  assert.match(verdict.reasons[0] ?? "", /withheld/);
});

test("boards do not claim improvement without observed correction data", () => {
  const before = measureBoard(
    [
      [decided("hold:approved"), decided("execute:completed"), decided("execute:completed")],
      [decided("hold:approved"), decided("execute:completed"), decided("execute:completed")],
    ],
    "before",
  );
  const after = measureBoard(
    [
      [decided("execute:completed"), decided("execute:completed"), decided("execute:completed")],
      [decided("execute:completed"), decided("execute:completed"), decided("execute:completed")],
    ],
    "after",
  );
  const verdict = compareBoards(before, after);
  assert.equal(verdict.verdict, "insufficient-data");
  assert.deepEqual(verdict.guardrailBreaches, []);
});

test("a guardrail breach is retained when the primary metric is unavailable", () => {
  const before = measureBoard([[decided("execute:completed")], [decided("execute:completed")]], "b");
  const after = measureBoard(
    [
      [decided("execute:completed"), entry({ event: "rollback" })],
      [decided("execute:completed"), entry({ event: "rollback" })],
    ],
    "a",
  );
  const verdict = compareBoards(before, after);
  assert.equal(verdict.verdict, "insufficient-data");
  assert.ok(verdict.guardrailBreaches.some((line) => line.includes("rollback_count")));
});

test("metrics with no measurement are named for a surface to show", () => {
  const board = measureBoard([[decided("execute:completed")], [decided("execute:completed")]], "t0");
  const missing = unmeasuredMetrics(board);
  assert.ok(missing.includes("median_approval_ms"));
  assert.ok(missing.includes("cost_usd"));
  assert.ok(missing.includes("first_pass_rate"));
});

test("operator decision time and spend are read when the record carries them", () => {
  const board = measureBoard(
    [
      [entry({ decision: "execute:completed", approvalMs: 100 }), entry({ costUsd: 0.01 })],
      [entry({ decision: "execute:completed", approvalMs: 120 }), entry({ costUsd: 0.03 })],
    ],
    "t0",
  );
  assert.equal(board.metrics.median_approval_ms.mean, 110);
  assert.equal(board.metrics.cost_usd.mean, 0.02);
  assert.equal(unmeasuredMetrics(board).includes("cost_usd"), false);
});

test("recovery is measured per case, and a case without one is not a success", () => {
  // Two cases: the first recovered once and failed once, the second recovered
  // once. Pooled that is 2 of 3 attempts. Per case it is 0.5 and 1.0, because a
  // case with one attempt is a case, not half a case, the same rule that keeps
  // retries from outweighing distinct work everywhere else on the board.
  const board = measureBoard(
    [
      [entry({ event: "recovery", ok: true }), entry({ event: "recovery", ok: false })],
      [entry({ event: "recovery", ok: true })],
    ],
    "t0",
  );
  assert.equal(board.metrics.recovery_success_rate.n, 2);
  assert.equal(board.metrics.recovery_success_rate.mean, 0.75);
});

test("a case with no recovery at all is skipped rather than scored as a failure", () => {
  // The workspace never needed recovering, which is not a failed recovery.
  const board = measureBoard(
    [
      [entry({ event: "recovery", ok: true })],
      [decided("execute:completed"), decided("execute:completed")],
    ],
    "t0",
  );
  assert.equal(board.metrics.recovery_success_rate.n, 1);
  assert.equal(board.metrics.recovery_success_rate.mean, 1);
});

test("the board is reproducible over the same chain", () => {
  const cases = [
    [decided("execute:completed"), decided("hold:approved")],
    [decided("deny:policy"), entry({ event: "rollback" })],
  ];
  assert.deepEqual(measureBoard(cases, "t0"), measureBoard(cases, "t0"));
});

test("the same cases in a different order measure the same thing", () => {
  const first = [decided("execute:completed"), decided("hold:approved")];
  const second = [decided("hold:approved"), decided("execute:completed")];
  assert.deepEqual(
    measureBoard([first, second], "t0").metrics,
    measureBoard([second, first], "t0").metrics,
  );
});

test("empty and non-decision cases do not become zero-valued first-pass samples", () => {
  const board = measureBoard([[], [entry({ tool: "harness.refinement", decision: "refinement:applied" })]], "t0");
  assert.equal(board.metrics.first_pass_rate.n, 0);
  assert.equal(board.metrics.first_pass_rate.mean, null);
  assert.equal(board.metrics.rollback_count.n, 0);
  assert.equal(board.metrics.first_pass_rate.unmeasured, 0);
  assert.equal(board.verdict, "insufficient-data");
});

test("a chain whose outcomes were never proven contributes no sample", () => {
  // `execute:unknown` and `proxy` are unmeasured, not failed. Counting either
  // as a zero first-pass would report missing evidence as a model that
  // misbehaved, and a rollback count of zero would claim a baseline that was
  // never observed.
  const unproven = [decided("execute:unknown"), decided("proxy")];
  const board = measureBoard(
    [unproven, unproven, [decided("execute:completed"), decided("hold:approved")]],
    "t0",
  );
  assert.equal(board.metrics.first_pass_rate.n, 0);
  assert.equal(board.metrics.first_pass_rate.mean, null);
  assert.equal(board.metrics.first_pass_rate.unmeasured, 6);
  assert.equal(board.metrics.rollback_count.n, 1);
  assert.equal(board.verdict, "insufficient-data");
});

test("a chain with nothing decided has no first-pass rate at all", () => {
  const board = measureBoard([[decided("proxy")]], "t0");
  assert.equal(board.metrics.first_pass_rate.mean, null);
  assert.equal(board.metrics.first_pass_rate.n, 0);
  assert.deepEqual(board.reasons, [
    "no decided call in the chain, so nothing was measured",
  ]);
});
