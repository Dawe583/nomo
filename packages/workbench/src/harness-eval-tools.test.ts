import test from "node:test";
import assert from "node:assert/strict";

import {
  EVAL_TOOL_EXECUTION,
  EVAL_TOOL_SCHEMA,
  evalToolRecord,
  type EvalToolInput,
} from "./harness-eval-tools.ts";

const input = (): EvalToolInput => ({
  caseId: "read-existing",
  variantId: "sha256:" + "a".repeat(64),
  run: 1,
  toolName: "void_workspace_read",
  toolClass: "r0",
  ok: true,
  execution: EVAL_TOOL_EXECUTION,
});

test("an eval tool measurement keeps only bounded attribution fields", () => {
  const record = evalToolRecord(input());
  assert.equal(record.schema, EVAL_TOOL_SCHEMA);
  assert.deepEqual(Object.keys(record), [
    "schema",
    "caseId",
    "variantId",
    "run",
    "toolName",
    "toolClass",
    "ok",
    "execution",
  ]);
});

test("hostile or out-of-schema fields are refused without echoing content", () => {
  const canary = "SECRET-PROMPT-CANARY with spaces";
  for (const mutate of [
    (body: EvalToolInput) => ({ ...body, prompt: canary }),
    (body: EvalToolInput) => ({ ...body, caseId: canary }),
    (body: EvalToolInput) => ({ ...body, run: 0 }),
    (body: EvalToolInput) => ({ ...body, ok: "yes" }),
    (body: EvalToolInput) => ({ ...body, execution: "host" }),
  ]) {
    assert.throws(() => evalToolRecord(mutate(input()) as EvalToolInput), (error) => {
      assert.doesNotMatch(String(error), /SECRET-PROMPT-CANARY/);
      return true;
    });
  }
});
