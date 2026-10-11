import test from "node:test";
import assert from "node:assert/strict";
import { harnessScoreRows } from "./harness-score-rows.ts";

/**
 * The score is descriptive. These tests hold two things: that a real chain
 * produces numbers, and that a metric the chain cannot support is reported as
 * unavailable rather than rendered.
 */
/** One chain record, in the shape the row builder reads. */
type ChainEntry = { readonly body: unknown; readonly seq: number };

const entry = (over: Record<string, unknown>, seq: number): ChainEntry => ({
  body: over,
  seq,
});

const allow = (operationId: string, seq: number): ChainEntry =>
  entry({ operationId, tool: "fixture.write", decision: "execute:ok" }, seq);
const denied = (operationId: string, seq: number): ChainEntry =>
  entry({ operationId, tool: "fixture.write", decision: "deny:policy" }, seq);
const held = (operationId: string, seq: number): ChainEntry =>
  entry({ operationId, tool: "fixture.write", decision: "hold:awaiting" }, seq);

const rowsFor = (entries: readonly ChainEntry[]) =>
  harnessScoreRows(new Map<string, readonly ChainEntry[]>([["workspace-alpha", entries]]));

test("an empty chain produces no row at all", () => {
  assert.deepEqual(harnessScoreRows(new Map([["workspace-alpha", []]])), []);
});

test("a chain with no entries produces no rows", () => {
  assert.deepEqual(harnessScoreRows(new Map()), []);
});

test("one case reports a mean and says why there is no interval", () => {
  const rows = rowsFor([allow("op-1", 1)]);
  assert.equal(rows.length, 1);
  assert.match(rows[0]!.lines.join("\n"), /of 1 case\(s\), no interval below two cases/);
});

test("two cases produce an interval", () => {
  const rows = rowsFor([allow("op-1", 1), denied("op-2", 2)]);
  assert.match(rows[0]!.lines.join("\n"), /over 2 cases/);
});

test("hold rate and deny rate are measured over the decided calls", () => {
  const rows = rowsFor([allow("op-1", 1), allow("op-2", 2), denied("op-3", 3), held("op-4", 4)]);
  const text = rows[0]!.lines.join("\n");
  assert.match(text, /Calls waiting on a human: \d+\.\d%/);
  assert.match(text, /Calls refused: \d+\.\d%/);
});

test("first-pass rate is unavailable when nothing was ever corrected", () => {
  const rows = rowsFor([allow("op-1", 1), allow("op-2", 2), denied("op-3", 3)]);
  assert.match(rows[0]!.lines.join("\n"), /First-pass rate: unavailable/);
});

test("an observed rollback is what makes first-pass rate reportable", () => {
  const rows = rowsFor([
    allow("op-1", 1),
    allow("op-2", 2),
    denied("op-3", 3),
    entry({ operationId: "op-1", tool: "fixture.write", event: "rollback" }, 4),
  ]);
  assert.match(rows[0]!.lines.join("\n"), /First-pass rate: \d+\.\d%/);
});

test("a repeated operation is also a correction signal", () => {
  const rows = rowsFor([
    allow("op-1", 1),
    allow("op-2", 2),
    denied("op-3", 3),
    allow("op-1", 4),
  ]);
  assert.match(rows[0]!.lines.join("\n"), /First-pass rate: \d+\.\d%/);
});

test("a chain of only unmeasured records says it measured nothing", () => {
  const rows = rowsFor([
    entry({ tool: "fixture.write" }, 1),
    entry({ tool: "fixture.write" }, 2),
    entry({ tool: "fixture.write" }, 3),
  ]);
  const text = rows[0]!.lines.join("\n");
  assert.match(text, /not measured/);
  assert.match(text, /no decided call in the chain/);
});

test("refinement records are not counted as tool outcomes", () => {
  // A refinement carries a decision string the tally would otherwise read as
  // an outcome, so a chain that is only refinements has decided nothing.
  const rows = rowsFor([
    entry({ tool: "harness.refinement", decision: "refinement:applied" }, 1),
    entry({ tool: "harness.refinement", decision: "refinement:applied" }, 2),
  ]);
  assert.match(rows[0]!.lines.join("\n"), /no decided call in the chain/);
});

test("each workspace gets its own row, named for the workspace", () => {
  const rows = harnessScoreRows(
    new Map([
      ["workspace-alpha", [allow("op-1", 1), allow("op-2", 2)]],
      ["workspace-beta", [denied("op-9", 1), denied("op-8", 2)]],
    ]),
  );
  assert.equal(rows.length, 2);
  assert.ok(rows[0]!.id.includes("workspace-alpha"));
  assert.ok(rows[1]!.id.includes("workspace-beta"));
});

test("a metric line never claims a number it does not have", () => {
  const rows = rowsFor([allow("op-1", 1)]);
  const text = rows[0]!.lines.join("\n");
  // Every percentage shown must carry a sample count, so a reader can see how
  // much of the chain any figure rests on.
  for (const line of rows[0]!.lines)
    if (line.includes("%")) assert.match(line, /case/, line);
  assert.ok(text.length > 0);
});

test("the row carries no score that could be mistaken for a gate", () => {
  const rows = rowsFor([allow("op-1", 1), denied("op-2", 2)]);
  assert.ok(rows[0]!.id.startsWith("harness-score:"));
  assert.equal(rows[0]!.lines.filter((line) => /verdict|allow|deny the call/i.test(line)).length, 0);
});
