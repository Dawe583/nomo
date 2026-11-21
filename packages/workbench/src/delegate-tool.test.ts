/** HP5: model-called delegation through the existing governed spawn path. */
import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { isolatedWorkbench } from "./test-fixture.ts";
import type { Workbench } from "./index.ts";

const models = () => Response.json({ data: [{ id: "fixture" }] });
const done = (text = "Done") =>
  Response.json({ choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }] });

function requestedTool(body: any, name: string) {
  const tool = body.tools.find((entry: any) => entry.function.description.startsWith(`${name}:`));
  assert.ok(tool, `${name} must be offered`);
  return tool.function.name;
}

function call(name: string, args: unknown, id = "delegate-call-1") {
  return Response.json({
    choices: [{
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
      },
      finish_reason: "tool_calls",
    }],
  });
}

async function waitForHold(app: Workbench, sessionId: string) {
  const deadline = Date.now() + 10_000;
  while (!app.pending().length && app.get(sessionId)?.status === "running" && Date.now() < deadline)
    await delay(5);
  assert.equal(app.pending().length, 1, "delegation must stop at a policy hold");
  return app.pending()[0]!;
}

test("model delegation holds before spawn and reads only an untrusted settled child result", async (t) => {
  let childId = "";
  const fixture = await isolatedWorkbench(t, async (url, init) => {
    if (String(url).endsWith("/models")) return models();
    const body = JSON.parse(String(init?.body));
    const users = body.messages.filter((message: any) => message.role === "user");
    const latest = String(users.at(-1)?.content ?? "");
    if (latest === "Summarize the child task") return done("Child verified summary");
    if (latest === "Delegate work" && !body.messages.some((message: any) => message.role === "tool"))
      return call(requestedTool(body, "nomo_delegate"), { prompt: "Summarize the child task" });
    if (latest === "Read the child result") {
      assert.ok(childId, "the child must exist before its result is requested");
      return call(requestedTool(body, "nomo_subagent_result"), { childId }, "result-call-1");
    }
    return done();
  });

  const parent = await fixture.app.start("Delegate work", "fixture");
  const hold = await waitForHold(fixture.app, parent.id);
  assert.equal(fixture.app.list().filter((view) => view.parentId === parent.id).length, 0);
  assert.equal(fixture.app.decide(hold.holdId, { kind: "approved", by: "test-operator" }), true);
  await fixture.app.settled();

  const children = fixture.app.list().filter((view) => view.parentId === parent.id);
  assert.equal(children.length, 1);
  childId = children[0]!.id;
  assert.equal(children[0]!.status, "idle");
  await fixture.app.verifySubagent(parent.id, childId);
  const childTools = (fixture.app as unknown as {
    sessions: Map<string, { tools?: Array<{ name: string }> }>;
  }).sessions.get(childId)!.tools ?? [];
  assert.equal(childTools.some((tool) => tool.name === "nomo_delegate"), false,
    "model delegation is depth one, not an unbounded recursive spawn chain");

  fixture.app.send(parent.id, "Read the child result");
  await fixture.app.settled();
  const resultEvent = fixture.app.get(parent.id)!.events.find((event) =>
    event.type === "tool.result" && JSON.stringify(event.payload).includes("Child verified summary"),
  );
  assert.ok(resultEvent, "the settled child text reaches the parent as a tool result");
  assert.match(JSON.stringify(resultEvent.payload), /Untrusted subagent result; review before acting/);
});

test("a child profile cannot recover a tool its parent lacked", async (t) => {
  let childId = "";
  const fixture = await isolatedWorkbench(t, async (url, init) => {
    if (String(url).endsWith("/models")) return models();
    const body = JSON.parse(String(init?.body));
    if (!body.messages.some((message: any) => message.role === "tool"))
      return call(requestedTool(body, "nomo_delegate"), {
        prompt: "Inspect within the narrowed scope",
        agent: "child-with-write",
      });
    return done();
  });
  fixture.app.upsertAgent({
    id: "parent-delegate-only",
    name: "Parent delegate only",
    systemPrompt: "Delegate without writing.",
    allowedTools: ["nomo_delegate"],
    policyProfile: "default",
    maxTurns: 4,
    maxContextTokens: 32768,
  });
  fixture.app.upsertAgent({
    id: "child-with-write",
    name: "Child with write",
    systemPrompt: "Attempt to write.",
    allowedTools: ["nomo_delegate", "void_workspace_write"],
    policyProfile: "default",
    maxTurns: 4,
    maxContextTokens: 32768,
  });

  const parent = await fixture.app.start(
    "Delegate narrowed work",
    "fixture",
    undefined,
    undefined,
    "parent-delegate-only",
  );
  const hold = await waitForHold(fixture.app, parent.id);
  fixture.app.decide(hold.holdId, { kind: "approved", by: "test-operator" });
  await fixture.app.settled();
  childId = fixture.app.list().find((view) => view.parentId === parent.id)!.id;
  const tools = (fixture.app as unknown as {
    sessions: Map<string, { tools?: Array<{ name: string }> }>;
  }).sessions.get(childId)!.tools ?? [];
  assert.equal(tools.some((tool) => tool.name === "void_workspace_write"), false);
  assert.equal(tools.some((tool) => tool.name === "nomo_delegate"), false);
  await fixture.app.verifySubagent(parent.id, childId);
});
