/**
 * What the chained request digest guarantees, and what it costs.
 *
 * The first version hashed the whole conversation every turn and was replaced
 * by one that hashed only the messages added since the last turn. That was
 * cheaper and wrong: with the prefix dropped from the input and a bare count
 * in its place, two conversations reaching the same tail through different
 * histories produced the same digest, and the comment claiming the prefix was
 * "already inside the previous digest's input" described a value nothing read.
 *
 * The chain keeps the incremental cost and restores the property: each turn
 * hashes its new messages together with the previous turn's digest, so a
 * difference anywhere reaches every later value. These tests call the shipped
 * function rather than a copy of it, because the copy is what drifted.
 */

import test from "node:test";
import assert from "node:assert/strict";
// The hashing helpers live in the ledger package, which is where the workbench
// already imports them from; the paths are relative rather than through the
// package name because this repository runs its TypeScript directly and does
// not build a workspace.
import { canonicalJson } from "../../ledger/src/canonical.ts";
import { sha256Hex } from "../../ledger/src/sign.ts";
import { conversationRequestDigest } from "./index.ts";

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

/** One turn of the shipped chain: the new messages and the previous value. */
async function chained(previous: string | null, messages: readonly unknown[]) {
  return conversationRequestDigest(previous, MODEL, messages, TOOLS);
}

/** Runs the chain the way the agent loop does, one batch per turn. */
async function chain(turns: readonly (readonly unknown[])[]) {
  let previous: string | null = null;
  let hashed = 0;
  const conversation: unknown[] = [];
  for (const batch of turns) {
    conversation.push(...batch);
    previous = await chained(previous, batch);
    hashed += batch.length;
  }
  assert.equal(hashed, conversation.length);
  return previous!;
}

test("the chained digest does not serialise the whole conversation again", async () => {
  const messages = conversation(200);
  const turns = 20;

  const startedWhole = process.hrtime.bigint();
  for (let turn = 0; turn < turns; turn += 1) await wholeHistory(messages);
  const wholeNanos = process.hrtime.bigint() - startedWhole;

  const startedChained = process.hrtime.bigint();
  let hashed = 0;
  let previous: string | null = null;
  for (let turn = 0; turn < turns; turn += 1) {
    previous = await chained(previous, messages.slice(hashed));
    hashed = messages.length;
  }
  const chainedNanos = process.hrtime.bigint() - startedChained;

  console.log(
    `\n  ${messages.length} messages x ${turns} turns: whole-history ${Number(wholeNanos / 1_000_000n)}ms, ` +
      `chained ${Number(chainedNanos / 1_000_000n)}ms`,
  );
  assert.equal(messages.length, 200);
  assert.ok(
    chainedNanos <= wholeNanos,
    `the chained form was slower: ${Number(chainedNanos / 1_000_000n)}ms against ${Number(wholeNanos / 1_000_000n)}ms`,
  );
});

test("a different prefix reaches a later turn that only sees the same tail", async () => {
  // The property the previous derivation failed: the last batch is byte for
  // byte the same in both runs, so only the chain carries the difference.
  const sharedTail = conversation(2);
  const honest = await chain([conversation(2), sharedTail]);
  const forged = await chain([
    conversation(2).map((message, index) => ({
      ...(message as object),
      content: `rewritten ${index} ${"x".repeat(400)}`,
    })),
    sharedTail,
  ]);
  assert.notEqual(
    honest,
    forged,
    "the request digest ignores the conversation before the current turn",
  );
});

test("the same conversation hashed twice gives the same digest", async () => {
  const batches = [conversation(2), conversation(2)];
  assert.equal(await chain(batches), await chain(batches));
});

test("the chained digest changes when the model or the tools change", async () => {
  const messages = conversation(3);
  const base = await chained(null, messages);
  assert.notEqual(
    base,
    await conversationRequestDigest(null, "another-model", messages, TOOLS),
    "the request digest ignores the model",
  );
  assert.notEqual(
    base,
    await conversationRequestDigest(null, MODEL, messages, []),
    "the request digest ignores the tool set",
  );
});
