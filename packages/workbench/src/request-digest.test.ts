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

/** Total of a per-turn count, for the statements that compare two forms. */
const sum = (perTurn: readonly number[]) => perTurn.reduce((total, n) => total + n, 0);

/** Splits a conversation into the batches one agent turn hands over. */
function batchesOf(messages: readonly unknown[], perTurn: number) {
  return Array.from({ length: messages.length / perTurn }, (_, turn) =>
    messages.slice(turn * perTurn, (turn + 1) * perTurn),
  );
}

/**
 * Counts the messages the canonicaliser reads out of the list it is handed.
 *
 * `canonicalJson` walks a message array with `map`, so a proxy over that array
 * sees one read per message the caller actually serialised. The count is work
 * done rather than time spent, which is the property the chain exists to hold
 * and the one a scheduler pause cannot invert. It also keeps the derivation
 * where it belongs: the count comes from the shipped `conversationRequestDigest`
 * reading what this test passed it, not from a second copy of that derivation
 * in this file, and the copy is what drifted the first time this went wrong.
 */
function countedMessages(messages: readonly unknown[]) {
  const counter = { read: 0 };
  const counted = new Proxy(messages as unknown[], {
    get(target, property, receiver) {
      if (typeof property === "string" && /^(?:0|[1-9][0-9]*)$/.test(property))
        counter.read += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  return { counted, counter };
}

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
  // A conversation already long before the chain's first digest. The prefix is
  // what a form that re-serialises the conversation pays for on every turn, so
  // it is what this test makes expensive.
  const prefix = conversation(1000);
  const turns = 20;
  const perTurn = 10;
  const batches = batchesOf(conversation(turns * perTurn), perTurn);

  const startedWhole = process.hrtime.bigint();
  const wholePerTurn: number[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    const said = [...prefix, ...batches.slice(0, turn + 1).flat()];
    const { counted, counter } = countedMessages(said);
    await wholeHistory(counted);
    wholePerTurn.push(counter.read);
  }
  const wholeNanos = process.hrtime.bigint() - startedWhole;

  const startedChained = process.hrtime.bigint();
  const chainedPerTurn: number[] = [];
  let previous: string | null = null;
  for (const batch of batches) {
    const { counted, counter } = countedMessages(batch);
    previous = await chained(previous, counted);
    chainedPerTurn.push(counter.read);
  }
  const chainedNanos = process.hrtime.bigint() - startedChained;

  // Logged, never asserted on. These two durations are what the comparison used
  // to decide, and they inverted on an idle host with no change to the code:
  // six isolated runs measured the whole-history baseline anywhere from 110ms
  // to 357ms, and one put the chained form at 101ms against that 110ms. The
  // line is worth printing when profiling and worthless as a gate, because
  // what it reports is how busy the machine was, not what the code did.
  console.log(
    `\n  ${prefix.length + turns * perTurn} messages x ${turns} turns: whole-history canonicalised ` +
      `${sum(wholePerTurn)} messages in ${Number(wholeNanos / 1_000_000n)}ms, chained canonicalised ` +
      `${sum(chainedPerTurn)} in ${Number(chainedNanos / 1_000_000n)}ms`,
  );

  // Turn one of the chain sees ten messages and so does turn twenty, with a
  // thousand messages of conversation already behind both. The per-turn input
  // is the batch that arrived since the previous digest and nothing else.
  assert.deepEqual(
    chainedPerTurn,
    Array.from({ length: turns }, () => perTurn),
    "the chained form canonicalised more than the messages added since the previous turn",
  );
  // Which makes the total the conversation's own length rather than its length
  // times its turns: every message is hashed exactly once across the whole run.
  assert.equal(
    sum(chainedPerTurn),
    turns * perTurn,
    "the chain re-serialised the conversation prefix",
  );

  // The contrast, so the counts above are a measurement rather than a
  // tautology. The form this one replaced reads the whole conversation on every
  // turn, prefix included, and grows with the conversation.
  assert.equal(
    wholePerTurn[0],
    prefix.length + perTurn,
    "the whole-history form skipped the prefix, so it is not the contrast it claims to be",
  );
  assert.equal(
    sum(wholePerTurn),
    turns * prefix.length + ((turns * (turns + 1)) / 2) * perTurn,
    "the whole-history form stopped growing with the conversation",
  );
  // The property stated as growth, which is the form the issue names it in:
  // across the run the whole-history form reads a whole extra batch on each
  // later turn on top of the prefix, and the chained form reads exactly as
  // many on its last turn as on its first.
  assert.equal(
    wholePerTurn[turns - 1] - wholePerTurn[0],
    (turns - 1) * perTurn,
    "the whole-history form's per-turn input stopped growing",
  );
  assert.equal(
    chainedPerTurn[turns - 1] - chainedPerTurn[0],
    0,
    "the chained form's per-turn input grew with the conversation",
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
