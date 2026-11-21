/**
 * HP11 integration: the three agent messaging tools as a model reaches them
 * through the Workbench.
 *
 * `agent-messages.ts` decides reachability, framing and redaction from the
 * caller's own family, and its own test pins those rules. The wiring is where
 * the rules can be lost: a tool offered under the wrong class is never held, a
 * sender read from the arguments is a sender the model chose, a mailbox that is
 * not persisted is a message that disappears, and a read that returns the
 * stored bytes unframed is an instruction. So every assertion here is about an
 * effect the operator or the recipient could see: a hold, a signed record on
 * the sender's chain, a framed message in a mailbox, a cursor that moved.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { isolatedWorkbench } from "./test-fixture.ts";
import {
  AGENT_INBOX_TOOL,
  AGENT_LIST_TOOL,
  AGENT_SEND_TOOL,
  UNTRUSTED_AGENT_MESSAGE_END,
  UNTRUSTED_AGENT_MESSAGE_LABEL,
  untrustedAgentMessageLabel,
} from "./agent-messages.ts";
import { workspaceToolClass } from "./workspace.ts";
import type { Workbench } from "./index.ts";

/** The provider key a fixture is configured with, so a secret the Workbench
 * itself knows can be put in a message and looked for afterwards. Long enough
 * to clear the module's four character floor, and shaped like nothing the
 * secret patterns match, so the message is redacted rather than refused. */
const PROVIDER_SECRET = "fixture-provider-secret-value";

type ProviderBody = {
  readonly messages: ReadonlyArray<{
    readonly role: string;
    readonly content?: string | null;
  }>;
  readonly tools: ReadonlyArray<{
    readonly function: { readonly name: string; readonly description: string };
  }>;
};

/** One tool result as the run loop records it for the model. */
type ToolResult = {
  readonly isError?: boolean;
  readonly content: ReadonlyArray<{ readonly text: string }>;
};

type InboxRead = {
  readonly text: string;
  readonly cursor: number;
  readonly delivered: number;
  readonly truncated: boolean;
};

const models = () => Response.json({ data: [{ id: "fixture" }] });
const done = (text = "Done") =>
  Response.json({
    choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
  });

function call(name: string, args: unknown, id: string) {
  return Response.json({
    choices: [{
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        }],
      },
      finish_reason: "tool_calls",
    }],
  });
}

/** The provider names every tool `tool_<index>` and carries the registry name
 * in the description, which is the only place a test can read it. */
function requestedTool(body: ProviderBody, name: string): string {
  const tool = body.tools.find((entry) =>
    entry.function.description.startsWith(`${name}:`),
  );
  assert.ok(tool, `${name} must be offered to the model`);
  return tool.function.name;
}

/**
 * A fresh run's first turn ends with the user prompt; a turn after a tool call
 * ends with the tool message. Routing on the tail rather than on "some tool
 * message exists" keeps two runs of the same session apart.
 */
function followUp(body: ProviderBody): boolean {
  return body.messages.at(-1)?.role === "tool";
}

function latestUser(body: ProviderBody): string {
  const users = body.messages.filter((message) => message.role === "user");
  return users.at(-1)?.content ?? "";
}

/**
 * A provider that answers from `script` and remembers the registry names the
 * last request was offered. The names are captured because a fixture that asks
 * for a tool the Workbench never offers fails inside the provider turn, where
 * the run reports it as a connection failure rather than as the missing tool.
 */
function scriptedFetcher(script: (body: ProviderBody, latest: string) => Response) {
  let offered: readonly string[] = [];
  const fetcher = (async (
    input: unknown,
    init?: { readonly body?: unknown },
  ) => {
    if (String(input).endsWith("/models")) return models();
    const body = JSON.parse(String(init?.body)) as ProviderBody;
    offered = body.tools.map((tool) => tool.function.description.split(":")[0]!);
    return script(body, latestUser(body));
  }) as unknown as typeof fetch;
  return { fetcher, offered: () => offered };
}

function listCall(body: ProviderBody, id: string) {
  if (followUp(body)) return done("Listing handled");
  return call(requestedTool(body, AGENT_LIST_TOOL.name), {}, id);
}

function sendCall(body: ProviderBody, to: string, text: string, id: string) {
  if (followUp(body)) return done("Send handled");
  return call(requestedTool(body, AGENT_SEND_TOOL.name), { to, text }, id);
}

function inboxCall(body: ProviderBody, args: Record<string, unknown>, id: string) {
  if (followUp(body)) return done("Inbox handled");
  return call(requestedTool(body, AGENT_INBOX_TOOL.name), args, id);
}

function toolResults(
  app: Workbench,
  sessionId: string,
  tool: string,
): ToolResult[] {
  return (app.get(sessionId)?.events ?? [])
    .filter((event) => event.type === "tool.result" && event.payload?.tool === tool)
    .map((event) => event.payload?.result as ToolResult);
}

function resultText(result: ToolResult): string {
  return result.content.map((part) => part.text).join("\n");
}

/** The last error a run reported. A missing tool fails inside the provider
 * turn, so an assertion about the missing result would otherwise say only that
 * nothing arrived. */
function lastError(app: Workbench, sessionId: string): string {
  const error = [...(app.get(sessionId)?.events ?? [])]
    .reverse()
    .find((event) => event.kind === "error");
  return error?.text ?? "no error reported";
}

function inboxRead(result: ToolResult | undefined): InboxRead {
  assert.ok(result, "nomo_agent_inbox must return a result");
  assert.notEqual(result.isError, true, `nomo_agent_inbox refused: ${resultText(result)}`);
  const text = resultText(result);
  let parsed: Partial<InboxRead> = {};
  try {
    parsed = JSON.parse(text) as Partial<InboxRead>;
  } catch {
    assert.fail(`nomo_agent_inbox must return its read as JSON, got: ${text}`);
  }
  assert.equal(typeof parsed.text, "string", "the read carries the framed text");
  assert.equal(typeof parsed.cursor, "number", "the read carries the cursor");
  assert.equal(typeof parsed.delivered, "number", "the read carries the delivered count");
  assert.equal(typeof parsed.truncated, "boolean", "the read says whether more remain");
  return parsed as InboxRead;
}

/**
 * The listing as the model reads it. Nested under a key or a bare array, the
 * entries are found the same way, because the family is what is being asserted
 * and not the envelope it arrived in.
 */
function listedEntries(text: string): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (typeof record.id === "string" && typeof record.relation === "string") {
      found.push(record);
      return;
    }
    Object.values(record).forEach(walk);
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    assert.fail(`nomo_agent_list must return its family as JSON, got: ${text}`);
  }
  walk(parsed);
  return found;
}

/**
 * The signed message records on one chain: the entries that name a sender and
 * a recipient. A policy entry for the same tool names neither, and a held or
 * denied call therefore leaves no message record behind.
 */
async function messageRecords(app: Workbench, workspace: string) {
  const proof = await app.ledger(workspace);
  assert.ok(proof, `the chain for ${workspace} must exist`);
  return proof.entries
    .map((entry) => ({
      body: entry.body as Record<string, unknown>,
      signature: entry.signature,
    }))
    .filter(
      (entry) =>
        typeof entry.body.from === "string" && typeof entry.body.to === "string",
    );
}

/** A send is r1, so a run that reaches it stops until the operator answers.
 * The wait ends on the hold, never on the run, because a held run is still
 * running until the decision is made. */
async function waitForHold(app: Workbench, sessionId: string) {
  const deadline = Date.now() + 10_000;
  while (
    !app.pending().length &&
    app.get(sessionId)?.status === "running" &&
    Date.now() < deadline
  )
    await delay(5);
  const hold = app.pending().find((item) => item.holdId.startsWith(`${sessionId}:`));
  assert.ok(
    hold,
    `the send must stop at a policy hold; the run ended as ${app.get(sessionId)?.status}: ${lastError(app, sessionId)}`,
  );
  return hold;
}

/**
 * The hold if the operator is asked for one, and nothing when the call was
 * answered without one. A refusal that resolves the family before the policy
 * runs and a refusal that runs after it are both refusals, and this file is
 * about the refusal, not about which gate came first.
 */
async function holdOrNothing(app: Workbench, sessionId: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const hold = app.pending().find((item) => item.holdId.startsWith(`${sessionId}:`));
    if (hold) return hold;
    if (app.get(sessionId)?.status !== "running" && !app.running()) return undefined;
    await delay(5);
  }
  return undefined;
}

/** Drive one model-called send through the hold the default policy sets and
 * the approval that answers it, and return this run's result. */
async function approvedSend(
  app: Workbench,
  sessionId: string,
  prompt: string,
): Promise<ToolResult> {
  const before = toolResults(app, sessionId, AGENT_SEND_TOOL.name).length;
  app.send(sessionId, prompt);
  const hold = await waitForHold(app, sessionId);
  assert.equal(
    app.decide(hold.holdId, { kind: "approved", by: "test-operator" }),
    true,
    "the operator approves the held send",
  );
  await app.settled();
  const results = toolResults(app, sessionId, AGENT_SEND_TOOL.name);
  assert.equal(results.length, before + 1, "the send reports one result to the model");
  return results[before]!;
}

/** Drive one model-called send that must be refused, approving the hold when
 * the operator is asked for one. */
async function refusedSend(
  app: Workbench,
  sessionId: string,
  prompt: string,
): Promise<ToolResult> {
  const before = toolResults(app, sessionId, AGENT_SEND_TOOL.name).length;
  app.send(sessionId, prompt);
  const hold = await holdOrNothing(app, sessionId);
  if (hold)
    assert.equal(
      app.decide(hold.holdId, { kind: "approved", by: "test-operator" }),
      true,
      "the operator approves the held send",
    );
  await app.settled();
  const results = toolResults(app, sessionId, AGENT_SEND_TOOL.name);
  assert.equal(results.length, before + 1, "the refused send reports one result");
  return results[before]!;
}

test("a profile-less session's nomo_agent_send is held by default and a denied hold delivers nothing", async (t) => {
  let childId = "";
  const provider = scriptedFetcher((body, latest) => {
    if (latest === "Child task") return done("Child ready");
    if (latest === "Send the plan change")
      return sendCall(body, childId, "The plan changed.", "send-denied");
    if (latest === "Send the approved plan")
      return sendCall(body, childId, "The plan is approved.", "send-approved");
    if (latest === "Read my inbox") return inboxCall(body, {}, "inbox-1");
    return done("Parent ready");
  });
  const fixture = await isolatedWorkbench(t, provider.fetcher);
  const app = fixture.app;

  assert.equal(
    workspaceToolClass(AGENT_SEND_TOOL.name),
    "r1",
    "a send is an effect on another conversation, so it is r1",
  );
  assert.equal(workspaceToolClass(AGENT_LIST_TOOL.name), "r0");
  assert.equal(workspaceToolClass(AGENT_INBOX_TOOL.name), "r0");

  const parent = await app.start("Parent request", "fixture");
  await app.settled();
  assert.ok(
    provider.offered().includes(AGENT_SEND_TOOL.name),
    `${AGENT_SEND_TOOL.name} must be offered to a profile-less session`,
  );
  // No agent profile was named, so the run carries no profile whose policy
  // could be mistaken for the source of the hold.
  const child = await app.spawnSubagent(parent.id, "Child task");
  childId = child.id;
  await app.settled();

  // Nothing runs before the operator answers: no signed record, no result, and
  // therefore no message in the child's mailbox.
  app.send(parent.id, "Send the plan change");
  const denied = await waitForHold(app, parent.id);
  assert.equal(
    toolResults(app, parent.id, AGENT_SEND_TOOL.name).length,
    0,
    "a held send has not executed",
  );
  assert.equal(
    (await messageRecords(app, parent.workspace)).length,
    0,
    "a held send has written no signed message record",
  );
  assert.equal(
    app.decide(denied.holdId, { kind: "denied", by: "test-operator", reason: "not yet" }),
    true,
  );
  await app.settled();

  const refused = toolResults(app, parent.id, AGENT_SEND_TOOL.name)[0];
  assert.ok(refused, "the denied send reports its refusal to the model");
  assert.equal(refused.isError, true);
  assert.match(resultText(refused), /nomo_agent_send/);
  assert.match(resultText(refused), /denied/i);
  assert.equal(
    (await messageRecords(app, parent.workspace)).length,
    0,
    "a denied send writes no signed message record",
  );

  // Approval is what makes a send real, and the record is written before the
  // text reaches the recipient's mailbox.
  const approved = await approvedSend(app, parent.id, "Send the approved plan");
  assert.notEqual(
    approved.isError,
    true,
    `the approved send must not be refused: ${resultText(approved)}`,
  );
  const records = await messageRecords(app, parent.workspace);
  assert.equal(records.length, 1, "the approved send writes exactly one signed record");
  const record = records[0]!;
  assert.equal(record.body.from, parent.id, "the record names the Workbench's sender");
  assert.equal(record.body.to, child.id);
  assert.equal(record.body.relation, "child", "the record names the relation it was sent under");
  assert.equal(typeof record.body.seq, "number", "the record names the mailbox seq");
  assert.equal(
    JSON.stringify(record.body).includes("The plan is approved."),
    false,
    "the record carries no prompt body",
  );
  assert.match(
    JSON.stringify(record.body),
    /[0-9a-f]{64}/,
    "the record binds the delivered text by digest",
  );
  assert.ok(record.signature.length > 0, "the record is signed");

  app.send(child.id, "Read my inbox");
  await app.settled();
  const read = inboxRead(toolResults(app, child.id, AGENT_INBOX_TOOL.name)[0]);
  assert.equal(read.delivered, 1);
  assert.ok(
    read.text.includes(untrustedAgentMessageLabel("child", parent.id)),
    "the delivered text carries the untrusted frame naming the relation and the sender",
  );
  assert.ok(read.text.includes("The plan is approved."));
  assert.equal(
    read.text.includes("The plan changed."),
    false,
    "the denied send never reached the mailbox",
  );
});

test("nomo_agent_list is family scoped and a send outside the family or to itself is refused", async (t) => {
  let childAId = "";
  let childBId = "";
  let strangerId = "";
  const provider = scriptedFetcher((body, latest) => {
    if (latest === "Child A task") return done("Child A ready");
    if (latest === "Child B task") return done("Child B ready");
    if (latest === "List the family") return listCall(body, "list-1");
    if (latest === "Message the stranger")
      return sendCall(body, strangerId, "Hello stranger.", "send-stranger");
    if (latest === "Message myself")
      return sendCall(body, childAId, "Note to self.", "send-self");
    if (latest === "Read my inbox") return inboxCall(body, {}, "inbox-1");
    return done();
  });
  const fixture = await isolatedWorkbench(t, provider.fetcher);
  const app = fixture.app;
  // Each approval is a continuation, and the default of three would stop a run
  // before the model could ask a second time.
  await app.patchHarnessSettings({ maxContinuations: 10 });

  const parent = await app.start("Parent request", "fixture");
  await app.settled();
  assert.ok(
    provider.offered().includes(AGENT_LIST_TOOL.name),
    `${AGENT_LIST_TOOL.name} must be offered to a session`,
  );
  const childA = await app.spawnSubagent(parent.id, "Child A task");
  childAId = childA.id;
  await app.settled();
  const childB = await app.spawnSubagent(parent.id, "Child B task");
  childBId = childB.id;
  await app.settled();
  const stranger = await app.start("Stranger request", "fixture");
  strangerId = stranger.id;
  await app.settled();

  // A held r0 call would keep this run open until the 300 second expiry, so a
  // run that settles without a decision is the proof that the listing is r0.
  app.send(childA.id, "List the family");
  await app.settled();
  const listed = toolResults(app, childA.id, AGENT_LIST_TOOL.name)[0];
  assert.ok(
    listed,
    `the listing answers the model; the run ended as ${app.get(childA.id)?.status}: ${lastError(app, childA.id)}`,
  );
  assert.notEqual(listed.isError, true, `the listing was refused: ${resultText(listed)}`);
  const entries = listedEntries(resultText(listed));
  assert.ok(
    entries.some((entry) => entry.id === parent.id && entry.relation === "parent"),
    "childA sees its parent",
  );
  assert.ok(
    entries.some((entry) => entry.id === childBId && entry.relation === "sibling"),
    "childA sees its sibling",
  );
  assert.equal(
    entries.some((entry) => entry.id === strangerId),
    false,
    "an unrelated conversation is not in the family",
  );
  assert.equal(
    resultText(listed).includes(strangerId),
    false,
    "an unrelated conversation is not even named",
  );

  const outside = await refusedSend(app, childA.id, "Message the stranger");
  assert.equal(outside.isError, true, "a send outside the family is refused");
  assert.match(
    resultText(outside),
    /not the direct parent, a direct child or a direct sibling/,
    "the refusal names no relation and confirms no other session",
  );

  const toSelf = await refusedSend(app, childA.id, "Message myself");
  assert.equal(toSelf.isError, true, "a send to itself is refused");
  assert.match(resultText(toSelf), /cannot message itself/);

  app.send(stranger.id, "Read my inbox");
  await app.settled();
  const strangerInbox = inboxRead(toolResults(app, stranger.id, AGENT_INBOX_TOOL.name)[0]);
  assert.equal(strangerInbox.delivered, 0, "the refused send entered no inbox");

  app.send(childA.id, "Read my inbox");
  await app.settled();
  const selfInbox = inboxRead(toolResults(app, childA.id, AGENT_INBOX_TOOL.name)[0]);
  assert.equal(selfInbox.delivered, 0, "the refused send entered no inbox");
});

test("nomo_agent_inbox frames untrusted text, advances its cursor and redacts a configured secret", async (t) => {
  let childId = "";
  let cursor = 0;
  const provider = scriptedFetcher((body, latest) => {
    if (latest === "Child task") return done("Child ready");
    if (latest === "Send the first note")
      return sendCall(body, childId, "First note: the child plan is unchanged.", "send-1");
    if (latest === "Send the secret note")
      return sendCall(
        body,
        childId,
        `Second note: the key is ${PROVIDER_SECRET}, do not echo it.`,
        "send-2",
      );
    if (latest === "Send the third note")
      return sendCall(body, childId, "Third note: the plan moved forward.", "send-3");
    if (latest === "Read my inbox") return inboxCall(body, {}, "inbox-1");
    if (latest === "Read my inbox from the cursor")
      return inboxCall(body, { sinceSeq: cursor }, "inbox-2");
    if (latest === "Read my inbox again")
      return inboxCall(body, { sinceSeq: cursor }, "inbox-3");
    return done("Parent ready");
  });
  const fixture = await isolatedWorkbench(t, provider.fetcher, {}, { apiKey: PROVIDER_SECRET });
  const app = fixture.app;
  await app.patchHarnessSettings({ maxContinuations: 10 });

  const parent = await app.start("Parent request", "fixture");
  await app.settled();
  assert.ok(
    provider.offered().includes(AGENT_INBOX_TOOL.name),
    `${AGENT_INBOX_TOOL.name} must be offered to a session`,
  );
  const child = await app.spawnSubagent(parent.id, "Child task");
  childId = child.id;
  await app.settled();

  await approvedSend(app, parent.id, "Send the first note");
  await approvedSend(app, parent.id, "Send the secret note");
  const records = await messageRecords(app, parent.workspace);
  assert.equal(records.length, 2, "each approved send writes one signed record");
  const redactedRecord = records.at(-1)!;
  assert.equal(
    JSON.stringify(redactedRecord.body).includes(PROVIDER_SECRET),
    false,
    "the signed record carries no secret",
  );
  assert.ok(
    Object.entries(redactedRecord.body).some(
      ([key, value]) => value === true && /redact/i.test(key),
    ),
    "the signed record states that a known secret was redacted",
  );

  app.send(child.id, "Read my inbox");
  await app.settled();
  const first = inboxRead(toolResults(app, child.id, AGENT_INBOX_TOOL.name)[0]);
  assert.equal(first.delivered, 2);
  assert.equal(first.truncated, false);
  assert.equal(
    first.text.split(untrustedAgentMessageLabel("child", parent.id)).length - 1,
    2,
    "every delivered message is framed as untrusted",
  );
  assert.ok(first.text.includes(UNTRUSTED_AGENT_MESSAGE_LABEL));
  assert.ok(first.text.includes(UNTRUSTED_AGENT_MESSAGE_END));
  assert.ok(first.text.includes("First note"));
  assert.ok(first.text.includes("Second note"));
  assert.equal(
    first.text.includes(PROVIDER_SECRET),
    false,
    "a configured provider secret never reaches the reader",
  );
  assert.ok(first.text.includes("[redacted]"), "the secret is replaced, not dropped");
  assert.ok(first.cursor > 0, "the read reports where to resume");
  cursor = first.cursor;

  app.send(child.id, "Read my inbox from the cursor");
  await app.settled();
  const empty = inboxRead(toolResults(app, child.id, AGENT_INBOX_TOOL.name)[1]);
  assert.equal(empty.delivered, 0, "sinceSeq is exclusive");
  assert.equal(empty.text, "");
  assert.equal(empty.cursor, cursor, "an empty read keeps the cursor it was given");

  await approvedSend(app, parent.id, "Send the third note");
  app.send(child.id, "Read my inbox again");
  await app.settled();
  const next = inboxRead(toolResults(app, child.id, AGENT_INBOX_TOOL.name)[2]);
  assert.equal(next.delivered, 1, "only the newer message is returned");
  assert.ok(next.text.includes("Third note"));
  assert.equal(next.text.includes("First note"), false);
  assert.equal(next.text.includes("Second note"), false);
  assert.ok(next.cursor > cursor, "the cursor advanced with the delivered message");
});

test("nomo_agent_send refuses secret shaped text before it reaches a mailbox", async (t) => {
  let childId = "";
  const provider = scriptedFetcher((body, latest) => {
    if (latest === "Child task") return done("Child ready");
    if (latest === "Send a provider key")
      return sendCall(body, childId, "Here it is: sk-abcdefghijklmnop1234", "send-key");
    if (latest === "Send a private key")
      return sendCall(
        body,
        childId,
        "-----BEGIN PRIVATE KEY-----\nMIIEowIBAAKCAQEA",
        "send-private-key",
      );
    if (latest === "Read my inbox") return inboxCall(body, {}, "inbox-1");
    return done("Parent ready");
  });
  const fixture = await isolatedWorkbench(t, provider.fetcher);
  const app = fixture.app;
  await app.patchHarnessSettings({ maxContinuations: 10 });

  const parent = await app.start("Parent request", "fixture");
  await app.settled();
  assert.ok(
    provider.offered().includes(AGENT_SEND_TOOL.name),
    `${AGENT_SEND_TOOL.name} must be offered to a session`,
  );
  const child = await app.spawnSubagent(parent.id, "Child task");
  childId = child.id;
  await app.settled();

  const key = await refusedSend(app, parent.id, "Send a provider key");
  assert.equal(key.isError, true, "a secret shaped payload is refused");
  assert.match(resultText(key), /secret-shaped value/);
  const privateKey = await refusedSend(app, parent.id, "Send a private key");
  assert.equal(privateKey.isError, true, "a private key header is refused");
  assert.match(resultText(privateKey), /secret-shaped value/);

  assert.equal(
    (await messageRecords(app, parent.workspace)).length,
    0,
    "a refused payload writes no signed message record",
  );

  app.send(child.id, "Read my inbox");
  await app.settled();
  const read = inboxRead(toolResults(app, child.id, AGENT_INBOX_TOOL.name)[0]);
  assert.equal(read.delivered, 0, "a refused payload enters no inbox");
  assert.equal(read.text, "");
});

test("a delivered mailbox survives a new Workbench over the same store", async (t) => {
  let childId = "";
  const provider = scriptedFetcher((body, latest) => {
    if (latest === "Child task") return done("Child ready");
    if (latest === "Send the durable note")
      return sendCall(body, childId, "This note survives a restart.", "send-1");
    if (latest === "Read my inbox") return inboxCall(body, {}, "inbox-1");
    return done("Parent ready");
  });
  const fixture = await isolatedWorkbench(t, provider.fetcher, {}, {
    prefix: "nomo-agent-messages-restart-",
  });

  const parent = await fixture.app.start("Parent request", "fixture");
  await fixture.app.settled();
  assert.ok(
    provider.offered().includes(AGENT_INBOX_TOOL.name),
    `${AGENT_INBOX_TOOL.name} must be offered to a session`,
  );
  const child = await fixture.app.spawnSubagent(parent.id, "Child task");
  childId = child.id;
  await fixture.app.settled();
  await approvedSend(fixture.app, parent.id, "Send the durable note");

  // No read happens before the restart, so the message can only be seen again
  // if the mailbox itself was written to the store.
  const reopened = fixture.restart();
  reopened.send(child.id, "Read my inbox");
  await reopened.settled();
  const read = inboxRead(toolResults(reopened, child.id, AGENT_INBOX_TOOL.name)[0]);
  assert.equal(read.delivered, 1, "the mailbox survived the restart");
  assert.ok(read.text.includes("This note survives a restart."));
  assert.ok(read.text.includes(untrustedAgentMessageLabel("child", parent.id)));
});
