import test from "node:test";
import assert from "node:assert/strict";
import { overviewState } from "./overview-state.ts";
import type { Row } from "./api.ts";

test("pending decisions take priority over active work", () => {
  assert.deepEqual(
    overviewState({ pendingApprovals: 2, running: 1, failed: 0 }),
    { tone: "attention", count: 2, kind: "decisions" },
  );
});

test("failures remain attention states and running work is active", () => {
  assert.deepEqual(overviewState({ pendingApprovals: 0, failed: 1, running: 2 }), {
    tone: "attention",
    count: 1,
    kind: "failures",
  });
  assert.deepEqual(overviewState({ pendingApprovals: 0, failed: 0, running: 2 }), {
    tone: "active",
    count: 2,
    kind: "running",
  });
});

test("overview reports clear only when the server supplied every decision count", () => {
  assert.deepEqual(overviewState({ pendingApprovals: 0, failed: 0, running: 0 }), {
    tone: "clear",
    count: 0,
    kind: "clear",
  });
  assert.deepEqual(overviewState({ pendingApprovals: 0, running: 0 }), {
    tone: "unknown",
    count: undefined,
    kind: "unknown",
  });
});

test("invalid or fractional counts never masquerade as real work", () => {
  const values = { pendingApprovals: -1, failed: Number.NaN, running: 1.5 };
  assert.deepEqual(overviewState(values), {
    tone: "unknown",
    count: undefined,
    kind: "unknown",
  });
  const source: Row = { overview: { ...values, pendingApprovals: 0 } };
  assert.equal(overviewState(source.overview).tone, "unknown");
});
