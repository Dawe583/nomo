import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workbench } from "../../../packages/workbench/src/index.ts";
import { listenControlPlane } from "./server.ts";

test("GET /api/sessions/:id exposes the model-updated plan", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-plan-api-"));
  let calls = 0;
  const fetcher = async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "fixture" }] });
    calls++;
    const body = JSON.parse(String(init?.body));
    if (calls === 1) {
      const tool = body.tools.find((entry: { function: { description: string } }) =>
        entry.function.description.startsWith("nomo_plan_update:"),
      );
      assert.ok(tool);
      return Response.json({
        choices: [{
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call-plan-api",
              type: "function",
              function: {
                name: tool.function.name,
                arguments: JSON.stringify({ items: [{ id: "verify", text: "Verify the API", status: "pending" }] }),
              },
            }],
          },
          finish_reason: "tool_calls",
        }],
      });
    }
    return Response.json({
      choices: [{ message: { role: "assistant", content: "Done" }, finish_reason: "stop" }],
    });
  };
  const app = new Workbench({ NOMO_DATA_DIR: root }, fetcher as typeof fetch);
  await app.configure({ baseUrl: "https://fixture.test/v1", apiKey: "fixture" });
  const session = await app.start("Plan this work", "fixture");
  await app.settled();
  const server = await listenControlPlane({ env: { NOMO_DATA_DIR: root }, workbench: app });
  t.after(async () => {
    await server.close();
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });

  const response = await fetch(`http://127.0.0.1:${server.port}/api/sessions/${session.id}`);
  assert.equal(response.status, 200);
  const body = await response.json() as { session: { plan?: unknown } };
  assert.deepEqual(body.session.plan, [
    { id: "verify", text: "Verify the API", status: "pending" },
  ]);
});
