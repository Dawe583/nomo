/** HP4: the model replaces a bounded plan that survives a restart. */
import test from "node:test";
import assert from "node:assert/strict";
import { isolatedWorkbench } from "./test-fixture.ts";
import type { ModelMessage } from "./provider.ts";

const items = [
  { id: "inspect", text: "Inspect the signed records", status: "in_progress" },
  { id: "report", text: "Report the verified result", status: "pending" },
] as const;

test("nomo_plan_update replaces the plan, returns it to the model and persists it", async (t) => {
  const requests: Array<{ messages: ModelMessage[]; tools: Array<{ function: { name: string; description: string } }> }> = [];
  const fixture = await isolatedWorkbench(t, async (url, init) => {
    if (String(url).endsWith("/models"))
      return Response.json({ data: [{ id: "fixture" }] });
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    if (requests.length === 1) {
      const tool = body.tools.find((entry: { function: { description: string } }) =>
        entry.function.description.startsWith("nomo_plan_update:"),
      );
      assert.ok(tool, "nomo_plan_update must be offered to the model");
      return Response.json({
        choices: [{
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call-plan-1",
              type: "function",
              function: { name: tool.function.name, arguments: JSON.stringify({ items }) },
            }],
          },
          finish_reason: "tool_calls",
        }],
      });
    }
    return Response.json({
      choices: [{ message: { role: "assistant", content: "Done" }, finish_reason: "stop" }],
    });
  });

  const session = await fixture.app.start("Plan this work", "fixture");
  await fixture.app.settled();
  assert.deepEqual(fixture.app.get(session.id)!.plan, items);
  assert.equal(requests.length, 2);
  const toolResult = requests[1]!.messages.find((message) => message.role === "tool");
  assert.ok(toolResult);
  assert.match(String(toolResult.content), /Inspect the signed records/);
  assert.match(String(toolResult.content), /in_progress/);

  fixture.restart();
  assert.deepEqual(fixture.app.get(session.id)!.plan, items);
});

test("an invalid replacement returns an error and leaves the previous plan intact", async (t) => {
  let calls = 0;
  const fixture = await isolatedWorkbench(t, async (url, init) => {
    if (String(url).endsWith("/models"))
      return Response.json({ data: [{ id: "fixture" }] });
    calls++;
    const body = JSON.parse(String(init?.body));
    const tool = body.tools.find((entry: { function: { description: string } }) =>
      entry.function.description.startsWith("nomo_plan_update:"),
    );
    assert.ok(tool);
    if (calls <= 2) {
      const plan = calls === 1
        ? [{ id: "valid", text: "Keep this item", status: "pending" }]
        : [{ id: "duplicate", text: "One", status: "pending" }, { id: "duplicate", text: "Two", status: "done" }];
      return Response.json({
        choices: [{
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: `call-plan-${calls}`,
              type: "function",
              function: { name: tool.function.name, arguments: JSON.stringify({ items: plan }) },
            }],
          },
          finish_reason: "tool_calls",
        }],
      });
    }
    return Response.json({
      choices: [{ message: { role: "assistant", content: "Done" }, finish_reason: "stop" }],
    });
  });

  const session = await fixture.app.start("Plan this work", "fixture");
  await fixture.app.settled();
  assert.deepEqual(fixture.app.get(session.id)!.plan, [
    { id: "valid", text: "Keep this item", status: "pending" },
  ]);
  const errors = fixture.app.get(session.id)!.events.filter(
    (event) => event.type === "tool.result" && /duplicate/i.test(JSON.stringify(event.payload)),
  );
  assert.ok(errors.length > 0, "the invalid replacement must surface its refusal");
});
