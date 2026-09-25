import test from "node:test";
import assert from "node:assert/strict";
import { runAgenticReverseExercise, runDatabaseReverseExercise, runMcpReverseExercise } from "./agentic-reverse-exercise.mjs";

test("the agentic reverse loop holds up end to end against real files", async (t) => {
  const result = await runAgenticReverseExercise();
  t.diagnostic(result.steps.join(" | "));
  // Every step is an assertion inside the exercise; this test exists so the
  // exercise is part of the gate rather than something somebody has to
  // remember to run.
  assert.equal(result.steps.length, 8);
  assert.equal(result.bytes.original, 11);
  assert.equal(result.bytes.patched, 40);
  assert.equal(result.bytes.human, 38);
});

test("the agentic reverse loop holds up against a real database row", async (t) => {
  const result = await runDatabaseReverseExercise();
  t.diagnostic(result.steps.join(" | "));
  assert.equal(result.steps.length, 5);
});

test("the agentic reverse loop holds up over the transport an agent actually uses", async (t) => {
  const result = await runMcpReverseExercise();
  t.diagnostic(result.steps.join(" | "));
  assert.equal(result.steps.length, 6);
});
