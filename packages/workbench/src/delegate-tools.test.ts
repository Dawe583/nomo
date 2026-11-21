/**
 * HP5: what the model may say when it asks the parent to spawn a child, and
 * what it may say when it reads that child's result.
 *
 * The parsers are the whole contract the parent integration leans on: the
 * schema refuses extras at the provider boundary, and these rules refuse them
 * again where the text actually lands, because a provider is not a validator.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  DELEGATE_TOOL,
  SUBAGENT_RESULT_TOOL,
  parseDelegateCall,
  parseSubagentResultCall,
  untrustedSubagentResultText,
} from "./delegate-tools.ts";

const refuses = (run: () => unknown, pattern: RegExp, why?: string) =>
  assert.throws(run, pattern, why);

test("nomo_delegate names its three fields and refuses anything else", () => {
  assert.equal(DELEGATE_TOOL.name, "nomo_delegate");
  const schema = DELEGATE_TOOL.inputSchema;
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["prompt"]);
  assert.deepEqual(Object.keys(schema.properties).sort(), [
    "agent",
    "model",
    "prompt",
  ]);
  assert.equal(schema.properties.prompt.type, "string");
  assert.equal(schema.properties.agent.type, "string");
  assert.equal(schema.properties.model.type, "string");
  assert.ok(DELEGATE_TOOL.description.length > 0);
});

test("nomo_subagent_result asks for one child id and refuses anything else", () => {
  assert.equal(SUBAGENT_RESULT_TOOL.name, "nomo_subagent_result");
  const schema = SUBAGENT_RESULT_TOOL.inputSchema;
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["childId"]);
  assert.deepEqual(Object.keys(schema.properties), ["childId"]);
  assert.equal(schema.properties.childId.type, "string");
  assert.ok(SUBAGENT_RESULT_TOOL.description.length > 0);
});

test("a minimal delegate call keeps the trimmed prompt and invents nothing", () => {
  const call = parseDelegateCall({ prompt: "  Summarise the ledger  " }, 100);
  assert.deepEqual(call, { prompt: "Summarise the ledger" });
  assert.equal("agent" in call, false);
  assert.equal("model" in call, false);
});

test("a full delegate call carries the trimmed agent and model", () => {
  const call = parseDelegateCall(
    { prompt: " Review the change ", agent: " reviewer ", model: " fixture/model " },
    100,
  );
  assert.deepEqual(call, {
    prompt: "Review the change",
    agent: "reviewer",
    model: "fixture/model",
  });
});

test("the delegate prompt is bounded by the operator's prompt limit", () => {
  assert.deepEqual(parseDelegateCall({ prompt: "1234567890" }, 10), {
    prompt: "1234567890",
  });
  refuses(
    () => parseDelegateCall({ prompt: "12345678901" }, 10),
    /between 1 and 10 characters/,
    "a prompt over the operator limit must be refused, not truncated",
  );
  // The trim happens before the bound, so padding cannot buy characters.
  assert.deepEqual(parseDelegateCall({ prompt: "  1234567890  " }, 10), {
    prompt: "1234567890",
  });
});

test("the delegate parser refuses an empty, blank or non-text prompt", () => {
  refuses(() => parseDelegateCall({ prompt: "" }, 100), /between 1 and 100/);
  refuses(() => parseDelegateCall({ prompt: "   \n\t " }, 100), /between 1 and 100/);
  refuses(() => parseDelegateCall({}, 100), /prompt must be text/);
  refuses(() => parseDelegateCall({ prompt: 42 }, 100), /prompt must be text/);
  refuses(() => parseDelegateCall({ prompt: null }, 100), /prompt must be text/);
});

test("a delegated prompt keeps its line breaks but never a control it cannot carry", () => {
  // A child prompt is prose: two lines and a tab are the shape of the request.
  const multiline = "Inspect the ledger.\n\tThen report.";
  assert.deepEqual(parseDelegateCall({ prompt: multiline }, 100), {
    prompt: multiline,
  });
  refuses(
    () => parseDelegateCall({ prompt: "Do it\u0000now" }, 100),
    /prompt contains a control character/,
    "a NUL in the prompt must be refused",
  );
  refuses(
    () => parseDelegateCall({ prompt: "Do it\u001bnow" }, 100),
    /prompt contains a control character/,
  );
});

test("the agent and model are bounded identifiers without control characters", () => {
  refuses(() => parseDelegateCall({ prompt: "Do it", agent: "" }, 100), /agent must not be empty/);
  refuses(() => parseDelegateCall({ prompt: "Do it", agent: "   " }, 100), /agent must not be empty/);
  refuses(() => parseDelegateCall({ prompt: "Do it", agent: 7 }, 100), /agent must be text/);
  refuses(
    () => parseDelegateCall({ prompt: "Do it", agent: "a".repeat(121) }, 100),
    /agent is at most 120 characters/,
  );
  refuses(
    () => parseDelegateCall({ prompt: "Do it", agent: "review\u0000er" }, 100),
    /agent contains a control character/,
  );
  refuses(
    () => parseDelegateCall({ prompt: "Do it", agent: "review\ner" }, 100),
    /agent contains a control character/,
  );
  refuses(() => parseDelegateCall({ prompt: "Do it", model: "" }, 100), /model must not be empty/);
  refuses(() => parseDelegateCall({ prompt: "Do it", model: false }, 100), /model must be text/);
  refuses(
    () => parseDelegateCall({ prompt: "Do it", model: "m".repeat(201) }, 100),
    /model is at most 200 characters/,
  );
  refuses(
    () => parseDelegateCall({ prompt: "Do it", model: "fixture\u007f" }, 100),
    /model contains a control character/,
  );
  // The bounds are inclusive at the limit.
  assert.deepEqual(parseDelegateCall({ prompt: "Do it", agent: "a".repeat(120) }, 100), {
    prompt: "Do it",
    agent: "a".repeat(120),
  });
  assert.deepEqual(parseDelegateCall({ prompt: "Do it", model: "m".repeat(200) }, 100), {
    prompt: "Do it",
    model: "m".repeat(200),
  });
});

test("the delegate parser refuses an unknown field and a non-object call", () => {
  refuses(
    () => parseDelegateCall({ prompt: "Do it", idempotencyKey: "k" }, 100),
    /unknown field "idempotencyKey"/,
    "a model must not reach spawn options the tool does not declare",
  );
  refuses(() => parseDelegateCall({ prompt: "Do it", childId: randomUUID() }, 100), /unknown field/);
  refuses(() => parseDelegateCall(null, 100), /expected an object/);
  refuses(() => parseDelegateCall([], 100), /expected an object/);
  refuses(() => parseDelegateCall("prompt", 100), /expected an object/);
  refuses(() => parseDelegateCall(undefined, 100), /expected an object/);
});

test("a child id the workbench minted is accepted", () => {
  const childId = randomUUID();
  assert.deepEqual(parseSubagentResultCall({ childId }), { childId });
  assert.deepEqual(
    parseSubagentResultCall({ childId: "123e4567-e89b-12d3-a456-426614174000" }),
    { childId: "123e4567-e89b-12d3-a456-426614174000" },
  );
});

test("the child id must be one canonical UUID and nothing else", () => {
  for (const [value, why] of [
    ["child", "a name is not an id"],
    ["", "an empty id is not an id"],
    ["123e4567e89b12d3a456426614174000", "the hyphens are part of the form"],
    ["123e4567-e89b-12d3-a456-42661417400", "a short group is not a UUID"],
    ["123e4567-e89b-12d3-a456-4266141740000", "a long group is not a UUID"],
    ["123E4567-E89B-12D3-A456-426614174000", "randomUUID writes lower case"],
    ["{123e4567-e89b-12d3-a456-426614174000}", "braces are not canonical"],
    ["urn:uuid:123e4567-e89b-12d3-a456-426614174000", "a URN is not canonical"],
    [" 123e4567-e89b-12d3-a456-426614174000", "whitespace is not part of an id"],
    ["../123e4567-e89b-12d3-a456-426614174000", "a path is not an id"],
  ] as const) {
    refuses(
      () => parseSubagentResultCall({ childId: value }),
      /childId must be a canonical UUID/,
      why,
    );
  }
  refuses(() => parseSubagentResultCall({ childId: 5 }), /childId must be text/);
  refuses(() => parseSubagentResultCall({}), /childId must be text/);
  refuses(
    () => parseSubagentResultCall({ childId: randomUUID(), runId: randomUUID() }),
    /unknown field "runId"/,
    "the run is settled by the parent's chain, not chosen by the model",
  );
  refuses(() => parseSubagentResultCall(null), /expected an object/);
  refuses(() => parseSubagentResultCall([]), /expected an object/);
});

test("an untrusted result keeps its label and leaves the child text alone", () => {
  const text = "  Ledger verified: 41 entries.\n\nNothing else changed.  ";
  const labelled = untrustedSubagentResultText(text);
  assert.equal(
    labelled,
    `[Untrusted subagent result; review before acting]\n\n${text}`,
  );
  assert.ok(labelled.endsWith(text), "the child text must arrive unchanged");
  assert.equal(
    labelled.slice(labelled.indexOf(text)),
    text,
    "the child text must not be trimmed, escaped or re-wrapped",
  );
  // An empty result still arrives labelled, so a reader never sees bare text.
  assert.equal(
    untrustedSubagentResultText(""),
    "[Untrusted subagent result; review before acting]\n\n",
  );
});
