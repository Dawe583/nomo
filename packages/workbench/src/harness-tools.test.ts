/**
 * The harness tools an agent can call.
 *
 * The tool writes a proposal, never a change. These prove the rule that
 * matters: the agent's call lands in the chain as an inert proposal, the
 * harness reads nothing new until an operator approves that exact digest,
 * and the refusals name what is missing rather than failing quietly.
 */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { isolatedWorkbench } from "./test-fixture.ts";
import {
  HARNESS_ADD_TOOL,
  HARNESS_FORGET_TOOL,
  harnessToolPlan,
} from "./harness-tools.ts";

const models = () => Response.json({ data: [{ id: "fixture" }] });

test("a lesson needs a title, a content and a reason", () => {
  const noText = harnessToolPlan(
    HARNESS_ADD_TOOL,
    { title: "t", reason: "r" },
    [1],
  );
  assert.equal(noText.ok, false);
  assert.match(noText.ok ? "" : noText.reason, /needs a title and a content/);
  const noReason = harnessToolPlan(
    HARNESS_ADD_TOOL,
    { title: "t", content: "c" },
    [1],
  );
  assert.equal(noReason.ok, false);
  assert.match(noReason.ok ? "" : noReason.reason, /needs a reason/);
});

test("a proposal with no record to cite is refused", () => {
  const plan = harnessToolPlan(
    HARNESS_ADD_TOOL,
    { title: "t", content: "c", reason: "r" },
    [],
  );
  assert.equal(plan.ok, false);
  assert.match(plan.ok ? "" : plan.reason, /no record to cite/);
});

test("a lesson cites the record it was derived from", () => {
  const plan = harnessToolPlan(
    HARNESS_ADD_TOOL,
    { title: "approval pattern", content: "the operator asked three times", reason: "it repeats" },
    [7],
  );
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.proposal.edits[0]!.action, "create");
  assert.equal(plan.proposal.edits[0]!.kind, "memory");
  assert.equal(plan.proposal.edits[0]!.content, "the operator asked three times");
  assert.deepEqual(plan.proposal.edits[0]!.derivedFromSeq, [7]);
});

test("a forgotten lesson is named by its id", () => {
  const plan = harnessToolPlan(
    HARNESS_FORGET_TOOL,
    { id: "lesson-1", reason: "it no longer holds" },
    [3],
  );
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.proposal.edits[0]!.action, "delete");
  assert.equal(plan.proposal.edits[0]!.id, "lesson-1");
  const noId = harnessToolPlan(HARNESS_FORGET_TOOL, { reason: "r" }, [3]);
  assert.equal(noId.ok, false);
  assert.match(noId.ok ? "" : noId.reason, /only be forgotten by its id/);
});

/** A provider that calls the harness tool once, then answers. */
function calling(fetcher: typeof fetch) {
  let called = false;
  return async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("/models")) return models();
    const body = init?.body
      ? (JSON.parse(String(init.body)) as {
          tools?: { function?: { name?: string; description?: string } }[];
          messages?: { content?: string }[];
        })
      : {};
    // The provider sees the tools under an index name, and the real name
    // rides in the description, so the harness tool is found the way the
    // other tool tests find theirs. The call waits for the turn that asks
    // for it: before the workspace chain holds a record there is nothing a
    // proposal could rest on, and the tool says so.
    const asked = (body.messages ?? []).some((entry) =>
      String(entry.content ?? "").includes("please remember"),
    );
    const harness = (body.tools ?? []).find((tool) =>
      tool.function?.description?.startsWith(`${HARNESS_ADD_TOOL}:`),
    );
    if (harness && asked && !called) {
      called = true;
      return Response.json({ choices: [{ message: { role: "assistant",
      content: null, tool_calls: [
        {
          id: "harness1",
          type: "function",
          function: {
            name: harness.function!.name!,
            arguments: JSON.stringify({
              title: "the operator asked three times",
              content: "the operator asked for the same migration three times",
              reason: "it repeats, and the pattern is worth keeping",
            }),
          },
        },
      ] }, finish_reason: "tool_calls" }] });
    }
    return Response.json({ choices: [{ message: { role: "assistant", content: "Done" }, finish_reason: "stop" }] });
  };
}

test("the agent's proposal is inert until an operator approves it", async (t: TestContext) => {
  const fetcher = calling((undefined as unknown) as typeof fetch);
  const { app } = await isolatedWorkbench(t, fetcher, {}, {
    prefix: "nomo-harness-tools-",
  });
  const session = await app.start("Remember this", "fixture");
  await app.settled();
  // The chain needs a record to cite, so the agent has something to rest the
  // proposal on.
  await app.editDocument(session.id, {
    path: "source.md",
    content: "signed source record",
    expectedRevision: null,
  });
  await app.send(session.id, "please remember the repeated request");
  await app.settled();

  const pending = await app.pendingApprovalsFor(session.id);
  assert.equal(pending.length, 1);
  assert.equal(
    pending[0]!.proposal.edits[0]!.content,
    "the operator asked for the same migration three times",
  );
  // Nothing is in force: the harness reads the same entries as before.
  assert.deepEqual(await app.harnessEntries(session.workspace), []);

  await app.approveHarnessProposal(session.id, pending[0]!.digest);

  const entries = await app.harnessEntries(session.workspace);
  assert.equal(entries.length, 1);
  assert.equal(
    entries[0]!.content,
    "the operator asked for the same migration three times",
  );
});
