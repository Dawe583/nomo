import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_REFINE_GATES,
  buildReviewRequest,
  cheapGate,
  gateReason,
  resolveRefineGates,
  type GateInput,
} from "./refine-gate.ts";

const AT = "2026-10-07T00:00:00.000Z";

const entry = (tool: string, klass = "r1") => ({
  id: `lesson:${tool}`,
  kind: "lesson" as const,
  scope: "workspace" as const,
  tool,
  klass,
  title: "operator keeps approving this call shape",
  content: "Approved 6 times on the signed ledger.",
  derivedFromSeq: [1, 2, 3],
  repeats: 6,
  createdAt: AT,
});

const input = (over: Partial<GateInput> = {}): GateInput => ({
  gates: DEFAULT_REFINE_GATES,
  pending: true,
  hasPendingReview: false,
  inFlight: false,
  settledTurns: 40,
  msSinceLastReview: null,
  candidates: [entry("fs.write")],
  harnessStateAvailable: true,
  surface: "checkpoint",
  ...over,
});

test("a ready trigger proceeds", () => {
  assert.deepEqual(cheapGate(input()), { proceed: true, instructions: "" });
});

test("an unarmed trigger is declined and reports itself", () => {
  const decision = cheapGate(input({ pending: false }));
  assert.equal(decision.proceed, false);
  // A silent refusal reads as a bug in the caller's next debugging session.
  assert.equal(gateReason(decision).length > 0, true);
});

test("a disabled harness is declined before any arithmetic happens", () => {
  const decision = cheapGate(input({ gates: { ...DEFAULT_REFINE_GATES, enabled: false } }));
  assert.equal(decision.proceed, false);
  assert.equal(decision.proceed === false && decision.reason, "disabled");
});

test("a session that cannot hold harness state never arms", () => {
  // A trigger there would never run, so the gate refuses rather than paying for
  // a review whose result had nowhere to go.
  const decision = cheapGate(input({ harnessStateAvailable: false }));
  assert.equal(decision.proceed, false);
  assert.equal(decision.proceed === false && decision.reason, "no-harness-state");
});

test("a settings refusal clears the trigger, a timing refusal holds it", () => {
  // The difference between a harness that learns eventually and one that
  // silently stops. A cooldown will pass; dropping the trigger on the way would
  // throw away the evidence that something was worth learning.
  const disabled = cheapGate(input({ gates: { ...DEFAULT_REFINE_GATES, enabled: false } }));
  assert.equal(disabled.proceed === false && disabled.held, false);
  const cooled = cheapGate(input({ msSinceLastReview: 1000 }));
  assert.equal(cooled.proceed === false && cooled.held, true);
});

test("an in-flight round is never joined", () => {
  // Two concurrent refinements would derive their entries from a chain the
  // first had already changed.
  const decision = cheapGate(input({ inFlight: true }));
  assert.equal(decision.proceed === false && decision.reason, "in-flight");
});

test("a cooldown holds the trigger rather than dropping it", () => {
  const decision = cheapGate(input({ msSinceLastReview: 1000 }));
  assert.equal(decision.proceed, false);
  assert.equal(decision.proceed === false && decision.held, true);
});

test("a cooldown of zero is a real setting, not a missing one", () => {
  const gates = { ...DEFAULT_REFINE_GATES, cooldownMs: 0 };
  assert.deepEqual(cheapGate(input({ gates, msSinceLastReview: 0 })), {
    proceed: true,
    instructions: "",
  });
});

test("too few settled turns holds the trigger", () => {
  const decision = cheapGate(input({ settledTurns: 3 }));
  assert.equal(decision.proceed === false && decision.reason, "too-soon");
  assert.equal(decision.proceed === false && decision.held, true);
});

test("nothing mined is the refusal that does the most work in practice", () => {
  // Most turns teach nothing. Saying so without a model call is the point of
  // this file.
  const decision = cheapGate(input({ candidates: [] }));
  assert.equal(decision.proceed === false && decision.reason, "nothing-new");
});

test("disposal runs its review even below the turn interval", () => {
  // The session is ending and this is the last boundary there will be. The
  // cooldown still applies above it, so a dispose cannot double up on an
  // attempt that just failed.
  const decision = cheapGate(input({ settledTurns: 0, surface: "dispose" }));
  assert.equal(decision.proceed, true);
});

test("disposal still declines when nothing was mined", () => {
  const decision = cheapGate(input({ candidates: [], surface: "dispose" }));
  assert.equal(decision.proceed, false);
});

test("a retained review proceeds below the turn interval", () => {
  // It was already paid for. Asking again would spend the same tokens twice.
  const decision = cheapGate(
    input({ settledTurns: 0, hasPendingReview: true, surface: "dispose" }),
  );
  assert.equal(decision.proceed, true);
});

test("gates default to the interval and cooldown prime uses", () => {
  // Copied rather than invented, so the two harnesses throttle alike.
  assert.equal(DEFAULT_REFINE_GATES.turnInterval, 25);
  assert.equal(DEFAULT_REFINE_GATES.cooldownMs, 20 * 60 * 1000);
  assert.equal(DEFAULT_REFINE_GATES.enabled, true);
});

test("a partial settings block resolves against the defaults", () => {
  const gates = resolveRefineGates({ enabled: false });
  assert.equal(gates.enabled, false);
  assert.equal(gates.turnInterval, 25);
  assert.equal(gates.cooldownMs, 20 * 60 * 1000);
});

test("an absent settings block is the defaults", () => {
  assert.deepEqual(resolveRefineGates(undefined), DEFAULT_REFINE_GATES);
});

test("the turn interval is clamped, not trusted", () => {
  // An interval of zero would make this a trigger with no interval.
  assert.equal(resolveRefineGates({ turnInterval: 0 }).turnInterval, 1);
  assert.equal(resolveRefineGates({ turnInterval: -5 }).turnInterval, 1);
  assert.equal(resolveRefineGates({ turnInterval: 2.9 }).turnInterval, 2);
});

test("a nonsense interval falls back rather than becoming NaN", () => {
  assert.equal(resolveRefineGates({ turnInterval: Number.NaN }).turnInterval, 25);
  assert.equal(resolveRefineGates({ cooldownMs: Number.NaN }).cooldownMs, 20 * 60 * 1000);
});

test("the review asks for a durable lesson and names what to decline", () => {
  const { question } = buildReviewRequest({
    entries: [entry("fs.write")],
    rules: 1,
    settledTurns: 40,
  });
  // The three refusals are prime's, for the same reasons: a model that hears
  // "learn something" will invent something.
  assert.match(question, /one-off noise/);
  assert.match(question, /unsupported hypotheses/);
  assert.match(question, /transient tool output/);
});

test("the review states that the chain records what, not why", () => {
  // Otherwise an explanation of a cause sounds plausible enough to be kept.
  const { question } = buildReviewRequest({
    entries: [entry("fs.write")],
    rules: 0,
    settledTurns: 40,
  });
  assert.match(question, /does not record why/);
});

test("the review lists the candidates it is being asked about", () => {
  const { candidates } = buildReviewRequest({
    entries: [entry("fs.write"), entry("shell.exec")],
    rules: 0,
    settledTurns: 40,
  });
  assert.equal(candidates.length, 2);
  assert.match(candidates[0] ?? "", /fs\.write/);
});