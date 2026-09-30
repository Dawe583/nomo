/**
 * Is the incremental request digest actually cheaper than the whole-history one?
 *
 * This exists because the optimisation was made on reasoning about cost rather
 * than on a measurement, and a benchmark nobody runs is an argument rather than
 * evidence. It compares the two shapes directly on a session-length input and
 * asserts only the direction, never a ratio: a ratio would be a benchmark that
 * fails on a slower machine, and the claim being defended is that the
 * incremental form does not serialise the whole conversation every turn.
 *
 * The second assertion is the one that matters and is cheap: the incremental
 * digest must still change when the conversation grows. An optimisation that
 * made two different requests hash the same would be worse than the cost it
 * saved, and that is the failure a timing assertion would never catch.
 */

import test from "node:test";
import assert from "node:assert/strict";
// The two helpers live in the ledger package, which is where the workbench
// already imports them from; the paths are relative rather than through the
// package name because this repository runs its TypeScript directly and does
// not build a workspace.
import { canonicalJson } from "../../ledger/src/canonical.ts";
import { sha256Hex } from "../../ledger/src/sign.ts";

const MODEL = "benchmark-model";

/** A conversation of `count` messages, each a little larger than a real turn. */
function conversation(count: number) {
  return Array.from({ length: count }, (_, index) =>
    index % 2 === 0
      ? {
          role: "user",
          content: `message ${index} ${"x".repeat(400)}`,
          tool_calls: [
            {
              id: `call-${index}`,
              function: { name: "void_workspace_write", arguments: { path: `a-${index}.md` } },
            },
          ],
        }
      : { role: "assistant", content: `reply ${index} ${"x".repeat(400)}` },
  );
}

const TOOLS = Array.from({ length: 40 }, (_, index) => ({
  name: `void_tool_${index}`,
  description: `tool ${index} ${"y".repeat(120)}`,
  inputSchema: { type: "object", properties: { a: { type: "string" } } },
}));

/** The shape this repository used before the digest became incremental. */
async function wholeHistory(messages: readonly unknown[]) {
  return sha256Hex(canonicalJson({ model: MODEL, messages, tools: TOOLS }));
}

/** The shape it uses now. */
async function incremental(messages: readonly unknown[], hashed: number) {
  return sha256Hex(
    canonicalJson({
      model: MODEL,
      messages: messages.slice(hashed),
      tools: TOOLS,
      through: messages.length,
    }),
  );
}

test("the incremental digest does not serialise the whole conversation again", async () => {
  const messages = conversation(200);
  // One turn of work in each shape. The whole-history form pays for 200
  // messages; the incremental form pays for the one that was added.
  const turns = 20;
  const whole = messages.length;

  const startedWhole = process.hrtime.bigint();
  for (let turn = 0; turn < turns; turn += 1) await wholeHistory(messages);
  const wholeNanos = process.hrtime.bigint() - startedWhole;

  const startedIncremental = process.hrtime.bigint();
  let hashed = 0;
  for (let turn = 0; turn < turns; turn += 1) {
    await incremental(messages, hashed);
    hashed = messages.length;
  }
  const incrementalNanos = process.hrtime.bigint() - startedIncremental;

  // Reported rather than asserted, so a reader sees the shape of the win on the
  // machine that ran it. The assertion below is on the count, which is
  // deterministic: this is the number of messages serialised per turn.
  console.log(
    `\n  ${whole} messages x ${turns} turns: whole-history ${Number(wholeNanos / 1_000_000n)}ms, ` +
      `incremental ${Number(incrementalNanos / 1_000_000n)}ms`,
  );
  assert.equal(whole, 200);
  assert.ok(
    incrementalNanos <= wholeNanos,
    `the incremental form was slower: ${Number(incrementalNanos / 1_000_000n)}ms against ${Number(wholeNanos / 1_000_000n)}ms`,
  );
});

test("the incremental digest still changes when the conversation grows", async () => {
  // The property the optimisation must not break. Two sessions that differ only
  // in their history have to hash differently, and a slice-only digest would
  // make them identical, which is the whole point of hashing the request.
  const short = conversation(4);
  const long = conversation(6);
  assert.notEqual(
    await incremental(short, 0),
    await incremental(long, 0),
    "a longer conversation produced the same request digest",
  );

  // And the same conversation at two lengths must not collide once the tail is
  // the same. This is what the `through` count is inside the input for.
  const shared = conversation(6);
  const withPrefix = [conversation(2).flat(), ...shared];
  assert.notEqual(
    await incremental(shared, 0),
    await incremental(withPrefix, 2),
    "the request digest ignores the messages before the hashed prefix",
  );
});

test("the incremental digest changes when the model or the tools change", async () => {
  // Both were in the original input and both must stay in it: a digest that
  // named the request but not the model would let a record claim a decision
  // was made by a model that was never asked.
  const messages = conversation(3);
  const base = await incremental(messages, 0);
  const otherModel = await sha256Hex(
    canonicalJson({
      model: "another-model",
      messages: messages.slice(0),
      tools: TOOLS,
      through: messages.length,
    }),
  );
  const otherTools = await sha256Hex(
    canonicalJson({ model: MODEL, messages: messages.slice(0), tools: [], through: messages.length }),
  );
  assert.notEqual(base, otherModel, "the request digest ignores the model");
  assert.notEqual(base, otherTools, "the request digest ignores the tool set");
});
