import test from "node:test";
import assert from "node:assert/strict";
import {
  activatedEntryIds,
  minePromotions,
  operatorEntries,
  withOperatorScope,
} from "./operator-harness.ts";
import { contentAddressedId, type AppliedEdit } from "./refine-pass.ts";
import type { HarnessEntry } from "./learned-harness.ts";

/**
 * The pure half of the operator scope: which entries an activation produced,
 * how the operator chain replays into the entries every conversation reads,
 * and which entry wins when a conversation holds one with the same id.
 */

const lesson = (
  id: string,
  content: string,
  extra: Partial<HarnessEntry> = {},
): HarnessEntry => ({
  id,
  kind: "lesson",
  scope: "workspace",
  tool: "",
  klass: "",
  title: `title ${id}`,
  content,
  derivedFromSeq: [1],
  repeats: 1,
  createdAt: "2026-11-21T00:00:00.000Z",
  ...extra,
});

const promotion = (seq: number, digest: string, entries: readonly unknown[]) => ({
  seq,
  body: {
    decision: "promotion:activated",
    harnessPromotion: {
      digest,
      status: "promoted",
      sourceWorkspace: "agent-a",
      sourceDigest: "d".repeat(64),
      sourceSeq: 4,
      entries,
      approvedBy: "operator",
    },
  },
});

const demotion = (seq: number, digest: string) => ({
  seq,
  body: {
    decision: "promotion:demoted",
    harnessPromotion: { digest, status: "demoted", approvedBy: "operator" },
  },
});

test("an activation's entries are the ones it created or superseded, never the ones it deleted", () => {
  const applied: AppliedEdit[] = [
    {
      edit: { action: "create", kind: "memory", title: "t", content: "c", derivedFromSeq: [1], reason: "r" },
      kind: "lesson",
      outcome: "created",
      before: null,
    },
    {
      edit: { action: "update", kind: "memory", id: "kept", title: "u", content: "v", derivedFromSeq: [1], reason: "r" },
      kind: "lesson",
      outcome: "superseded",
      before: lesson("kept", "old"),
    },
    {
      edit: { action: "delete", kind: "memory", id: "gone", derivedFromSeq: [1], reason: "r" },
      kind: "lesson",
      outcome: "deleted",
      before: lesson("gone", "x"),
    },
    {
      edit: { action: "create", kind: "prompt", title: "p", promptAddendum: "say less", derivedFromSeq: [1], reason: "r" },
      kind: "lesson",
      outcome: "created",
      before: null,
    },
  ];
  assert.deepEqual(activatedEntryIds(applied), [
    contentAddressedId("memory", "t", "c"),
    "kept",
    contentAddressedId("prompt", "p", "say less"),
  ]);
});

test("promotions replay in order: a demotion ends one, a later promotion stands again", () => {
  const first = "1".repeat(64);
  const second = "2".repeat(64);
  const chain = [
    promotion(1, first, [lesson("a", "alpha")]),
    promotion(2, second, [lesson("b", "beta")]),
    demotion(3, first),
  ];
  const promotions = minePromotions(chain);
  assert.deepEqual(
    promotions.map((item) => [item.digest, item.status, item.promotedSeq, item.demotedSeq]),
    [
      [first, "demoted", 1, 3],
      [second, "promoted", 2, null],
    ],
  );
  assert.deepEqual(
    operatorEntries(promotions).map((entry) => [entry.id, entry.scope, entry.decidedByOperator]),
    [["b", "operator", true]],
  );
  const again = minePromotions([...chain, promotion(4, first, [lesson("a", "alpha")])]);
  assert.deepEqual(operatorEntries(again).map((entry) => entry.id).sort(), ["a", "b"]);
});

test("a malformed promotion record is refused rather than guessed at", () => {
  assert.throws(
    () => minePromotions([promotion(1, "1".repeat(64), [{ id: "", kind: "lesson" }])]),
    /The signed operator promotion is malformed\./,
  );
  assert.throws(
    () => minePromotions([promotion(1, "1".repeat(64), [lesson("a", "alpha", { kind: "rule" })])]),
    /The signed operator promotion is malformed\./,
  );
});

test("a demotion of a digest the chain never promoted is refused", () => {
  assert.throws(
    () => minePromotions([demotion(1, "3".repeat(64))]),
    /The signed operator chain demotes a promotion it never made\./,
  );
});

test("a conversation's own entry wins over an operator entry with the same id", () => {
  const own = [lesson("shared", "own text")];
  const operator = [
    lesson("shared", "operator text", { scope: "operator", decidedByOperator: true }),
    lesson("only", "operator only", { scope: "operator", decidedByOperator: true }),
  ];
  assert.deepEqual(
    withOperatorScope(own, operator).map((entry) => [entry.id, entry.content]),
    [
      ["shared", "own text"],
      ["only", "operator only"],
    ],
  );
});
