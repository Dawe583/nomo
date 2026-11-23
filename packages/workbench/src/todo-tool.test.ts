/**
 * The `todo_write` tool.
 *
 * Two things have to hold. The arguments are validated at the boundary, so a
 * checklist the rail cannot print is refused instead of repaired. And a
 * successful call becomes a real `todo.updated` event carrying exactly the
 * rows the model sent, because the rail reads that event and nothing may be
 * added to it on the way.
 */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { isolatedWorkbench } from "./test-fixture.ts";
import { TODO_MAX_ITEMS, TODO_WRITE_TOOL, todoWritePlan } from "./todo-tool.ts";

const models = () => Response.json({ data: [{ id: "fixture" }] });

test("a checklist is accepted whole and trimmed", () => {
  const plan = todoWritePlan({
    items: [
      { text: "  read the contract  ", status: "completed" },
      { text: "run the suite", status: "in_progress" },
    ],
  });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.deepEqual(plan.items, [
    { text: "read the contract", status: "completed" },
    { text: "run the suite", status: "in_progress" },
  ]);
  // The bounds themselves are legal: one row and fifty rows.
  assert.equal(todoWritePlan({ items: [{ text: "one", status: "pending" }] }).ok, true);
  assert.equal(
    todoWritePlan({
      items: Array.from({ length: TODO_MAX_ITEMS }, (_, index) => ({
        text: `item ${index}`,
        status: "pending",
      })),
    }).ok,
    true,
  );
});

test("a checklist the rail cannot print is refused", () => {
  const refused = (args: unknown) => {
    const plan = todoWritePlan(args);
    assert.equal(plan.ok, false, `accepted ${JSON.stringify(args)}`);
    return plan.ok ? "" : plan.reason;
  };
  assert.match(refused(undefined), /needs an object/);
  assert.match(refused([]), /needs an object/);
  assert.match(refused({}), /needs an items array/);
  assert.match(refused({ items: "nope" }), /needs an items array/);
  assert.match(refused({ items: [] }), /at least one item/);
  assert.match(
    refused({
      items: Array.from({ length: TODO_MAX_ITEMS + 1 }, (_, index) => ({
        text: `item ${index}`,
        status: "pending",
      })),
    }),
    /at most 50 items/,
  );
  // Unknown fields are refused rather than ignored: a state this tool does not
  // understand must not be dropped from an otherwise accepted list.
  assert.match(
    refused({ items: [{ text: "a", status: "pending" }], extra: true }),
    /does not accept extra/,
  );
  assert.match(
    refused({ items: [{ text: "a", status: "pending", note: "x" }] }),
    /Item 1 does not accept note/,
  );
  assert.match(refused({ items: ["text"] }), /Item 1 must be an object/);
  assert.match(refused({ items: [{ status: "pending" }] }), /needs a text string/);
  assert.match(refused({ items: [{ text: "", status: "pending" }] }), /is empty/);
  assert.match(refused({ items: [{ text: "   ", status: "pending" }] }), /is empty/);
  assert.match(
    refused({ items: [{ text: "x".repeat(201), status: "pending" }] }),
    /limit is 200/,
  );
  assert.match(
    refused({ items: [{ text: "two\nlines", status: "pending" }] }),
    /one printable line/,
  );
  assert.match(refused({ items: [{ text: "a" }] }), /status must be one of/);
  assert.match(
    refused({ items: [{ text: "a", status: "doing" }] }),
    /status must be one of/,
  );
  assert.match(
    refused({ items: [{ text: "a", status: 1 }] }),
    /status must be one of/,
  );
});

test("the registry entry is the shape a provider can call", () => {
  assert.equal(TODO_WRITE_TOOL.name, "todo_write");
  assert.equal(TODO_WRITE_TOOL.inputSchema.additionalProperties, false);
  assert.deepEqual(TODO_WRITE_TOOL.inputSchema.required, ["items"]);
  assert.deepEqual(TODO_WRITE_TOOL.inputSchema.properties.items.items.required, [
    "text",
    "status",
  ]);
  assert.deepEqual(TODO_WRITE_TOOL.inputSchema.properties.items.items.properties.status.enum, [
    "pending",
    "in_progress",
    "completed",
  ]);
});

/**
 * A provider that calls the todo tool once, with the given arguments, then
 * answers. The call is found the way the other tool tests find theirs: the
 * provider sees an index name and the real name rides in the description.
 */
function calling(argumentsJson: string, ask = "Plan this") {
  let called = false;
  return async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("/models")) return models();
    const body = init?.body
      ? (JSON.parse(String(init.body)) as {
          tools?: { function?: { name?: string; description?: string } }[];
          messages?: { content?: string }[];
        })
      : {};
    const asked = (body.messages ?? []).some((entry) =>
      String(entry.content ?? "").includes(ask),
    );
    const tool = (body.tools ?? []).find((entry) =>
      entry.function?.description?.startsWith(`${TODO_WRITE_TOOL.name}:`),
    );
    if (tool && asked && !called) {
      called = true;
      return Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "todo-1",
                  type: "function",
                  function: {
                    name: tool.function!.name!,
                    arguments: argumentsJson,
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      });
    }
    return Response.json({
      choices: [
        { message: { role: "assistant", content: "Done" }, finish_reason: "stop" },
      ],
    });
  };
}

async function fixture(t: TestContext, fetcher: typeof fetch) {
  return isolatedWorkbench(t, fetcher, {}, { prefix: "nomo-todo-tool-" });
}

test("a successful call becomes one real todo.updated event", async (t) => {
  const items = [
    { text: "read the contract", status: "completed" },
    { text: "run the suite", status: "in_progress" },
    { text: "record evidence", status: "pending" },
  ];
  const f = await fixture(t, calling(JSON.stringify({ items })));
  const session = await f.app.start("Plan this", "fixture");
  await f.app.settled();

  const view = f.app.get(session.id)!;
  const events = view.events.filter((event) => event.type === "todo.updated");
  assert.equal(events.length, 1, "exactly one checklist event");
  const event = events[0]!;
  assert.equal(event.kind, "tool");
  assert.deepEqual(event.payload, { items });
  assert.equal(event.sessionId, session.id);
  assert.equal(event.runId, view.runId);
  assert.equal(typeof event.seq, "number");
  assert.equal(event.schemaVersion, 1);
  // The event sits between the call and its result, so a reader can tell what
  // the model asked for from what the tool recorded.
  const started = view.events.findIndex((entry) => entry.type === "tool.started");
  const recorded = view.events.findIndex((entry) => entry.type === "todo.updated");
  const result = view.events.findIndex(
    (entry) =>
      entry.kind === "tool" &&
      entry.type === "tool.result" &&
      (entry.payload as { tool?: string }).tool === TODO_WRITE_TOOL.name,
  );
  assert.ok(started >= 0 && recorded > started && result > recorded);
  // No document, no command and no hold: the tool records the plan only.
  assert.deepEqual(f.app.workspace(session.id).files, {});
  assert.deepEqual(await f.app.pendingApprovalsFor(session.id), []);
});

test("a refused call records no checklist and invents no row", async (t) => {
  const f = await fixture(
    t,
    calling(JSON.stringify({ items: [] }), "Plan this badly"),
  );
  const session = await f.app.start("Plan this badly", "fixture");
  await f.app.settled();

  const view = f.app.get(session.id)!;
  assert.equal(
    view.events.filter((event) => event.type === "todo.updated").length,
    0,
    "a refused call must not record a checklist",
  );
  const result = view.events.find(
    (entry) =>
      entry.kind === "tool" &&
      entry.type === "tool.result" &&
      (entry.payload as { tool?: string }).tool === TODO_WRITE_TOOL.name,
  );
  assert.ok(result, "the refusal reached the model as a tool result");
  const payload = result!.payload as {
    result?: { isError?: boolean; content?: { text?: string }[] };
  };
  assert.equal(payload.result?.isError, true);
  assert.match(
    payload.result?.content?.[0]?.text ?? "",
    /at least one item/,
  );
});
