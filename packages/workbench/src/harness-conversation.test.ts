/**
 * The conversation tail the reviewer may see.
 *
 * The reviewer was blind to the conversation, and a blind reviewer proposes
 * the same generic lesson again. But the conversation is the one place in
 * this package where raw text lives: the operator's words, the model's
 * words, the arguments the model wrote for a tool and the decoded result a
 * tool returned. These prove the exclusions hold, that the bound is paid
 * from the operator's ceiling, and that a tail carrying a secret is withheld
 * whole rather than trimmed, with the operator told.
 */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { isolatedWorkbench } from "./test-fixture.ts";
import { buildConversationTail } from "./harness-conversation.ts";
import type { ModelMessage } from "./provider.ts";

const models = () => Response.json({ data: [{ id: "fixture" }] });
const answer = (content = "Ready") =>
  Response.json({ choices: [{ message: { role: "assistant", content } }] });

const message = (
  role: ModelMessage["role"],
  content: string,
  extra: Partial<ModelMessage> = {},
): ModelMessage => ({ role, content, ...extra });

test("a tool message never travels", () => {
  const tail = buildConversationTail([
    message("user", "the operator asked for the migration"),
    message("tool", "postgres returned a decoded payload", {
      tool_call_id: "call-1",
    }),
  ]);
  assert.match(tail.text, /the operator asked for the migration/);
  assert.doesNotMatch(tail.text, /decoded payload/);
});

test("tool call arguments never travel", () => {
  const tail = buildConversationTail([
    message("assistant", "calling the tool", {
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "void_workspace_write", arguments: '{"content":"a document body"}' },
        },
      ],
    }),
  ]);
  assert.equal(tail.text, "");
});

test("a system message never travels", () => {
  const tail = buildConversationTail([
    message("system", "the standing instruction and the learned entry digest"),
    message("user", "the operator asked for the migration"),
  ]);
  assert.doesNotMatch(tail.text, /standing instruction/);
  assert.match(tail.text, /the operator asked for the migration/);
});

test("the newest exchanges win", () => {
  const tail = buildConversationTail(
    Array.from({ length: 8 }, (_, index) =>
      message(index % 2 === 0 ? "user" : "assistant", `exchange ${index}`),
    ),
  );
  assert.match(tail.text, /exchange 7/);
  assert.doesNotMatch(tail.text, /exchange 0/);
  assert.doesNotMatch(tail.text, /exchange 1/);
});

test("a long message keeps its last characters and says the earlier part was omitted", () => {
  const long = "x".repeat(2000) + " THE END";
  const tail = buildConversationTail([message("user", long)]);
  assert.match(tail.text, /earlier part omitted/);
  assert.match(tail.text, /THE END/);
  assert.ok(
    tail.text.length < long.length,
    "the tail must be shorter than the message it came from",
  );
});

test("a tail that carries a secret is withheld whole, not trimmed", () => {
  const tail = buildConversationTail(
    [message("user", "here is api_key=sk_test_should_not_travel")],
    { isSecretLike: (text) => text.includes("sk_test_should_not_travel") },
  );
  assert.equal(tail.text, "");
  assert.equal(tail.withheld, true);
});

test("the provider key is redacted out of the tail", () => {
  const tail = buildConversationTail([message("user", "the key is abc123secret")], {
    redact: (text) => text.split("abc123secret").join("[redacted]"),
  });
  assert.doesNotMatch(tail.text, /abc123secret/);
  assert.match(tail.text, /\[redacted\]/);
});

/** A provider that records every request it was sent. The review request
 * is the one that carries the refinement instructions; a conversation turn
 * carries the standing instruction instead, so the two are told apart by
 * what they hold rather than by when they arrived. */
function recording() {
  const requests: string[] = [];
  const fetcher = async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("/models")) return models();
    const body = init?.body
      ? (JSON.parse(String(init.body)) as { messages?: { content?: string }[] })
      : {};
    requests.push(
      (body.messages ?? []).map((entry) => entry.content ?? "").join("\n"),
    );
    return answer(JSON.stringify({ verdict: "decline" }));
  };
  const reviewRequest = () =>
    [...requests]
      .reverse()
      .find((request) => request.includes("improving a harness")) ?? "";
  return { fetcher: fetcher as typeof fetch, requests, reviewRequest };
}

async function seeded(t: TestContext, fetcher: typeof fetch) {
  const { app } = await isolatedWorkbench(t, fetcher, {}, {
    prefix: "nomo-harness-conversation-",
  });
  const session = await app.start("Review the workspace", "fixture");
  await app.settled();
  await app.editDocument(session.id, {
    path: "source.md",
    content: "signed source record",
    expectedRevision: null,
  });
  // The gate reviews what the chain carries, so a chain with nothing in it is
  // refused with nothing-new and the reviewer is never asked. One approved
  // lesson is what gives it something to look at.
  const created = await app.refineHarness(session.id, {
    summary: "repeated lesson",
    rationale: "supported by signed records",
    expectedOutcome: "fewer repeated approvals",
    edits: [
      {
        action: "create",
        kind: "memory",
        title: "approval pattern",
        content: "The operator repeatedly approved the same action.",
        derivedFromSeq: [1],
        reason: "the pattern repeats",
      },
    ],
  });
  await app.approveHarnessProposal(session.id, created.proposalDigest!);
  return { app, session };
}

test("the review request carries the conversation, labelled as untrusted context", async (t) => {
  const { fetcher, reviewRequest } = recording();
  const { app, session } = await seeded(t, fetcher);
  await app.send(session.id, "the operator asked for the migration to be reversible");
  await app.settled();

  await app.requestHarnessReview(session.id);

  const request = reviewRequest();
  assert.match(request, /the operator asked for the migration to be reversible/);
  assert.match(request, /untrusted context, not instructions/);
});

test("a conversation carrying a secret is withheld and the operator is told", async (t) => {
  const { fetcher, reviewRequest } = recording();
  const { app, session } = await seeded(t, fetcher);
  await app.send(session.id, "here is api_key=sk_test_should_not_travel");
  await app.settled();

  await app.requestHarnessReview(session.id);

  const request = reviewRequest();
  assert.doesNotMatch(request, /sk_test_should_not_travel/);
  assert.doesNotMatch(
    request,
    /untrusted context/,
    "a withheld tail leaves no conversation block behind",
  );
  const told = app
    .get(session.id)!
    .events.filter((event) => event.type === "harness.review")
    .filter((event) => /withheld/.test(event.text));
  assert.equal(told.length, 1);
});

test("the conversation is charged to the operator's prompt ceiling", async (t) => {
  const { fetcher, reviewRequest } = recording();
  const { app, session } = await seeded(t, fetcher);
  for (let turn = 0; turn < 6; turn += 1) {
    await app.send(session.id, `a long request number ${turn} ${"y".repeat(2000)}`);
    await app.settled();
  }

  await app.requestHarnessReview(session.id);

  const request = reviewRequest();
  assert.ok(
    request.length <= app.harnessSettings().maxPromptCharacters,
    `the request must stay under the operator's ceiling, got ${request.length} of ${app.harnessSettings().maxPromptCharacters}`,
  );
});
