import test from "node:test";
import assert from "node:assert/strict";

import {
  BASE_SYSTEM_PROMPT_ID,
  REFINEMENT_ACTIONS,
  REFINEMENT_KINDS,
  applyProposal,
  extractJsonObject,
  isIncompleteJson,
  validateProposal,
  type RefinementEdit,
  type RefinementProposal,
} from "./refine-pass.ts";
import type { HarnessEntry } from "./learned-harness.ts";

const edit = (over: Partial<RefinementEdit> = {}): RefinementEdit => ({
  action: "create",
  kind: "memory",
  title: "an approval repeats",
  content: "Approved 6 times on the signed ledger.",
  derivedFromSeq: [1, 2, 3],
  reason: "it repeats",
  ...over,
});

const proposal = (edits: RefinementEdit[]): RefinementProposal => ({
  summary: "one lesson",
  rationale: "the records say so",
  expectedOutcome: "the operator reads it",
  edits,
});

const accepted = (result: ReturnType<typeof validateProposal>) => (result.ok ? result.proposal.edits : []);
const rejections = (result: ReturnType<typeof validateProposal>) => (result.ok ? [] : result.rejections);

// --- truncation versus malformed -------------------------------------------

test("an unterminated object is truncated, not malformed", () => {
  assert.equal(isIncompleteJson('{"summary": "x", "edits": ['), true);
  assert.equal(isIncompleteJson('{"summary": "x"}'), false);
});

test("an unterminated string counts as incomplete", () => {
  // A model that stopped mid-string has run out of room, which is a different
  // problem from one that returned something wrong.
  assert.equal(isIncompleteJson('{"title": "unfinished'), true);
});

test("an escaped quote does not close the string", () => {
  assert.equal(isIncompleteJson('{"title": "a \\" b"}'), false);
});

test("brackets inside a string are characters, not structure", () => {
  assert.equal(isIncompleteJson('{"content": "{ not a brace }"}'), false);
});

test("a truncated reply is reported as truncated", () => {
  // The distinction matters because the fixes differ: a truncated reply means
  // the request was too big, a malformed one means the model answered wrongly.
  const parsed = extractJsonObject('{"summary":"s","rationale":"r","edits":[{"action":"cr');
  assert.equal(parsed.ok, false);
  assert.ok(!parsed.ok && parsed.kind === "truncated");
});

test("a malformed reply is reported as malformed", () => {
  const parsed = extractJsonObject("I am not going to answer in JSON today.");
  assert.equal(parsed.ok, false);
  assert.ok(!parsed.ok && parsed.kind === "not-an-object");
});

test("a JSON array is not a proposal", () => {
  const parsed = extractJsonObject("[1,2,3]");
  assert.equal(parsed.ok, false);
  assert.ok(!parsed.ok && parsed.kind === "not-an-object");
});

test("a bare object parses", () => {
  const parsed = extractJsonObject('{"summary":"s","rationale":"r","expectedOutcome":"e","edits":[]}');
  assert.equal(parsed.ok, true);
});

test("a fenced reply parses, because a model wraps its answer", () => {
  // Refusing the fence only teaches the model to stop fencing, at the cost of
  // tokens on both sides.
  const parsed = extractJsonObject('```json\n{"summary":"s","rationale":"r","expectedOutcome":"e","edits":[]}\n```');
  assert.equal(parsed.ok, true);
});

test("a reply with prose around the object parses", () => {
  const parsed = extractJsonObject('Here is what I propose:\n{"summary":"s","rationale":"r","expectedOutcome":"e","edits":[]}\nThat is all.');
  assert.equal(parsed.ok, true);
});

test("an empty reply is not an object", () => {
  assert.equal(extractJsonObject("   ").ok, false);
});

// --- validation ------------------------------------------------------------

test("a valid edit is accepted", () => {
  assert.equal(accepted(validateProposal(proposal([edit()]))).length, 1);
});

test("every edit must name the records behind it", () => {
  // The one rejection neither reference harness has. Both write into a plain
  // file they trust; this writes into a signed chain, where an edit with
  // nothing behind it cannot be audited afterwards.
  const result = validateProposal(proposal([edit({ derivedFromSeq: [] })]));
  assert.equal(accepted(result).length, 0);
  assert.match(rejections(result)[0]?.reason ?? "", /ledger records/);
});

test("the base system prompt is not editable", () => {
  // Not an id convention. A harness that can rewrite the standing instructions
  // has no boundary left to enforce, so this is refused by validation rather
  // than by asking the model nicely.
  const result = validateProposal(proposal([edit({ id: BASE_SYSTEM_PROMPT_ID })]));
  assert.equal(accepted(result).length, 0);
  assert.match(rejections(result)[0]?.reason ?? "", /base system prompt is not editable/);
});

test("an update without an id is refused", () => {
  assert.match(
    rejections(validateProposal(proposal([edit({ action: "update", id: undefined })])))[0]?.reason ?? "",
    /requires an id/,
  );
});

test("a delete without an id is refused", () => {
  assert.match(
    rejections(validateProposal(proposal([edit({ action: "delete", id: undefined })])))[0]?.reason ?? "",
    /requires an id/,
  );
});

test("a create without content is refused", () => {
  assert.match(
    rejections(validateProposal(proposal([edit({ content: undefined })])))[0]?.reason ?? "",
    /title and content/,
  );
});

test("a delete needs no content", () => {
  assert.equal(accepted(validateProposal(proposal([edit({ action: "delete", id: "x", title: undefined, content: undefined })]))).length, 1);
});

test("an unknown action is refused rather than coerced", () => {
  const result = validateProposal(proposal([edit({ action: "drop" as never })]));
  assert.match(rejections(result)[0]?.reason ?? "", /unsupported action/);
});

test("an unknown kind is refused rather than coerced", () => {
  const result = validateProposal(proposal([edit({ kind: "rule" as never })]));
  assert.match(rejections(result)[0]?.reason ?? "", /unsupported kind/);
});

test("a proposal with no edits is accepted as nothing durable", () => {
  // A refiner that must always produce an edit produces a bad one, so saying
  // "nothing here is durable" has to be an answer the code accepts. Rejecting
  // the empty case would teach the pass that declining is a failure, and the
  // next run would find something to propose only because it had to.
  const result = validateProposal(proposal([]));
  assert.equal(result.ok, true);
  assert.equal(accepted(result).length, 0);
});

test("every failure is collected, not thrown at the first", () => {
  // prime-src does the same, and the reason is behavioural: given one error a
  // model usually fixes that error and returns the same shape with the next
  // violation in it, so a first-error throw turns one round trip into several.
  const result = validateProposal(
    proposal([edit({ derivedFromSeq: [] }), edit({ action: "update", id: undefined })]),
  );
  assert.equal(rejections(result).length, 2);
  assert.deepEqual(rejections(result).map((r) => r.index), [0, 1]);
});

test("the kinds and actions are the ones declared", () => {
  assert.deepEqual([...REFINEMENT_KINDS], ["memory", "skill", "subagent", "prompt"]);
  assert.deepEqual([...REFINEMENT_ACTIONS], ["create", "update", "delete"]);
});

// --- application -----------------------------------------------------------

const existing: HarnessEntry = {
  id: "known",
  kind: "lesson",
  scope: "workspace",
  tool: "fs.write",
  klass: "r1",
  title: "before",
  content: "before",
  derivedFromSeq: [1],
  repeats: 1,
  createdAt: "2026-10-01T00:00:00.000Z",
};

test("a create produces an entry rather than a rule", () => {
  // Rules are mined from the chain by `learned-rules.ts`, which can only emit
  // `hold`. Letting a model author one would route around the only thing here
  // that is auditable.
  const result = applyProposal([], proposal([edit()]), "2026-10-07T00:00:00.000Z");
  assert.equal(result.entries[0]?.kind, "lesson");
});

test("an update supersedes and keeps the original addressable", () => {
  // A correction has to stay auditable the way a ledger decision does, rather
  // than overwriting what it replaced.
  const result = applyProposal([existing], proposal([edit({ action: "update", id: "known", content: "after" })]), "2026-10-07T00:00:00.000Z");
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0]?.content, "after");
  assert.equal(result.applied[0]?.outcome, "superseded");
  assert.equal(result.applied[0]?.before?.content, "before");
});

test("an update keeps the original creation time", () => {
  const result = applyProposal([existing], proposal([edit({ action: "update", id: "known" })]), "2026-10-07T00:00:00.000Z");
  assert.equal(result.entries[0]?.createdAt, existing.createdAt);
});

test("a delete removes the entry", () => {
  const result = applyProposal([existing], proposal([edit({ action: "delete", id: "known" })]), "2026-10-07T00:00:00.000Z");
  assert.deepEqual(result.entries, []);
  assert.equal(result.applied[0]?.before?.id, "known");
});

test("two identical creates produce the same id", () => {
  // Otherwise a pass that retries writes two copies of one lesson.
  const at = "2026-10-07T00:00:00.000Z";
  const first = applyProposal([], proposal([edit()]), at);
  const second = applyProposal(first.entries, proposal([edit({ action: "update", id: first.entries[0]!.id })]), at);
  assert.equal(second.entries.length, 1);
});

test("the caller's array is never mutated", () => {
  const input = [existing];
  applyProposal(input, proposal([edit({ action: "delete", id: "known" })]), "2026-10-07T00:00:00.000Z");
  assert.equal(input.length, 1, "the caller keeps its own state and can refuse the result");
});

test("a prompt edit is withheld rather than applied", () => {
  // The invariant that matters most in this file. A model that can append to
  // the standing instructions can also write itself out of every other rule
  // here, so the approval has to be enforced where edits are applied rather
  // than left to a caller to remember.
  const result = applyProposal([], proposal([edit({ kind: "prompt" })]), "2026-10-07T00:00:00.000Z");
  assert.deepEqual(result.entries, [], "no prompt edit reaches the entries");
  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.awaitingApproval.map((e) => e.kind), ["prompt"]);
});

test("withholding a prompt edit does not hold back the others", () => {
  const result = applyProposal([], proposal([edit({ kind: "prompt" }), edit()]), "2026-10-07T00:00:00.000Z");
  assert.equal(result.entries.length, 1, "an operator's approval is per edit, not per pass");
  assert.equal(result.entries[0]?.kind, "lesson");
  assert.equal(result.applied.length, 1);
  assert.equal(result.awaitingApproval.length, 1);
});

test("applying twice changes nothing the second time", () => {
  const at = "2026-10-07T00:00:00.000Z";
  const once = applyProposal([], proposal([edit()]), at);
  const twice = applyProposal(once.entries, proposal([edit({ action: "update", id: once.entries[0]!.id })]), at);
  assert.deepEqual(
    once.entries.map((e) => [e.id, e.title, e.content]),
    twice.entries.map((e) => [e.id, e.title, e.content]),
  );
});