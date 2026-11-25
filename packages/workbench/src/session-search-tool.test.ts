/** HP6: opt-in, bounded and redacted search across persisted conversations. */
import test from "node:test";
import assert from "node:assert/strict";
import { isolatedWorkbench } from "./test-fixture.ts";
import type { ModelMessage } from "./provider.ts";

const SECRET = "fixture-search-secret";
const QUERY = "migration-plan-42";
const models = () => Response.json({ data: [{ id: "fixture" }] });
const done = (text = "Done") =>
  Response.json({ choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }] });

function latestUser(messages: readonly ModelMessage[]): string {
  return String([...messages].reverse().find((message) => message.role === "user")?.content ?? "");
}

test("session search is disabled by default and is not offered", async (t) => {
  const requests: any[] = [];
  const fixture = await isolatedWorkbench(t, async (url, init) => {
    if (String(url).endsWith("/models")) return models();
    requests.push(JSON.parse(String(init?.body)));
    return done();
  });
  assert.equal(fixture.app.harnessSettings().sessionSearchEnabled, 0);
  const session = await fixture.app.start("Search old conversations", "fixture");
  await fixture.app.settled();
  const offered = (body: any) => body.tools.some((tool: any) =>
    tool.function.description.startsWith("nomo_session_search:"),
  );
  assert.equal(offered(requests[0]), false);
  assert.equal(
    fixture.app.availableTools(session.id).tools.some((tool) => tool.name === "nomo_session_search"),
    false,
  );
});

test("enabled search survives restart, redacts secrets, bounds hits and excludes the caller", async (t) => {
  const requests: any[] = [];
  const fixture = await isolatedWorkbench(
    t,
    async (url, init) => {
      if (String(url).endsWith("/models")) return models();
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      const latest = latestUser(body.messages);
      if (latest === "Target notes") return done(`${QUERY} uses token ${SECRET}`);
      if (latest === "Other notes") return done(`${QUERY} has another matching record`);
      if (latest === `Search old notes ${QUERY}` && !body.messages.some((message: any) => message.role === "tool")) {
        const tool = body.tools.find((entry: any) =>
          entry.function.description.startsWith("nomo_session_search:"),
        );
        assert.ok(tool, "the enabled tool must be offered");
        return Response.json({
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "session-search-call-1",
                type: "function",
                function: {
                  name: tool.function.name,
                  arguments: JSON.stringify({ query: QUERY, limit: 1 }),
                },
              }],
            },
            finish_reason: "tool_calls",
          }],
        });
      }
      return done();
    },
    {},
    { configure: false },
  );
  await fixture.app.configure({ baseUrl: "https://fixture.test/v1", apiKey: SECRET });
  fixture.app.patchHarnessSettings({ sessionSearchEnabled: 1 });
  const target = await fixture.app.start("Target notes", "fixture");
  await fixture.app.settled();
  fixture.app.patchSession(target.id, { title: "Runbook" });
  await fixture.app.start("Other notes", "fixture");
  await fixture.app.settled();

  fixture.restart();
  assert.equal(fixture.app.harnessSettings().sessionSearchEnabled, 1);
  const caller = await fixture.app.start(`Search old notes ${QUERY}`, "fixture");
  await fixture.app.settled();

  const toolMessage = requests.at(-1).messages.find((message: any) => message.role === "tool");
  assert.ok(toolMessage, "the search result must return to the model");
  const outer = JSON.parse(String(toolMessage.content));
  const payload = JSON.parse(outer.content[0].text);
  assert.equal(payload.results.length, 1);
  assert.equal(payload.truncated, true);
  assert.equal(payload.results[0].sessionId, target.id);
  assert.notEqual(payload.results[0].sessionId, caller.id);
  assert.equal(JSON.stringify(payload).includes(SECRET), false);
  assert.match(JSON.stringify(payload), /\[redacted\]/);
  assert.ok(payload.results[0].excerpt.length <= 240);
});

test("disabling search removes it from a session's later provider requests", async (t) => {
  const requests: any[] = [];
  const fixture = await isolatedWorkbench(t, async (url, init) => {
    if (String(url).endsWith("/models")) return models();
    requests.push(JSON.parse(String(init?.body)));
    return done();
  });
  fixture.app.patchHarnessSettings({ sessionSearchEnabled: 1 });
  const session = await fixture.app.start("First turn", "fixture");
  await fixture.app.settled();
  fixture.app.patchHarnessSettings({ sessionSearchEnabled: 0 });
  fixture.app.send(session.id, "Second turn");
  await fixture.app.settled();
  const offered = (body: any) => body.tools.some((tool: any) =>
    tool.function.description.startsWith("nomo_session_search:"),
  );
  assert.equal(offered(requests[0]), true);
  assert.equal(offered(requests[1]), false);
});
