import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import { once } from "node:events";
import test from "node:test";
import type { AgentRunEvent } from "./agent-runner.ts";
import { PROJECT_CHANGES_TOOL } from "../project-workspace.ts";
import { ClaudeAgentSdkRunner } from "@nomo/workbench/agent-runners/claude-agent-sdk";

function deferred<T>() {
  let settle!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, rejectPromise) => {
    settle = resolve;
    reject = rejectPromise;
  });
  return {
    promise,
    resolve: (value?: T) => settle(value as T),
    reject,
  };
}
function sse(res: ServerResponse, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

test("Claude SDK rejects non-Anthropic remote endpoints", () => {
  for (const endpoint of [
    "https://example.com",
    "https://api.anthropic.com:8443",
    "http://api.anthropic.com",
  ]) {
    assert.throws(
      () => new ClaudeAgentSdkRunner({ apiKey: "synthetic-local-key", endpoint }),
      /endpoint is not allowed/,
    );
  }
});

test("Claude SDK streams only broker tools through the local fixture and leaves no transcript", async (t) => {
  const requests: Array<{ headers: IncomingHttpHeaders; body: Record<string, unknown> }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    requests.push({ headers: req.headers, body });
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    if (requests.length === 1) {
      sse(res, "message_start", { type: "message_start", message: { id: "msg_fixture_1", type: "message", role: "assistant", model: "claude-fixture", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
      sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_fixture_1", name: "mcp__nomo_workbench__nomo_project_changes", input: {} } });
      sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"operation\":\"status\"}" } });
      sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
      sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } });
    } else {
      sse(res, "message_start", { type: "message_start", message: { id: "msg_fixture_2", type: "message", role: "assistant", model: "claude-fixture", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
      sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "fixture answer" } });
      sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
      sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } });
    }
    sse(res, "message_stop", { type: "message_stop" });
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { promise: closed, resolve, reject } = deferred<void>();
  t.after(() => {
    server.close((error) => error ? reject(error) : resolve());
    return closed;
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const tempBefore = new Set(await readdir(tmpdir()));
  const runner = new ClaudeAgentSdkRunner({ apiKey: "synthetic-local-key", endpoint: `http://127.0.0.1:${address.port}` });
  const input = {
    task: "fixture task",
    systemPrompt: "fixture system",
    workspace: { id: "grant-fixture", rootDigest: `sha256:${"a".repeat(64)}` as `sha256:${string}`, allowedTools: ["nomo_project_changes"] },
    tools: [PROJECT_CHANGES_TOOL],
    signal: new AbortController().signal,
  };
  await assert.rejects(
    runner.start({ ...input, workspace: { ...input.workspace, allowedTools: [] } }),
    /exceed the Workbench grant/,
  );
  assert.equal(requests.length, 0);
  const run = await runner.start(input);
  const events: AgentRunEvent[] = [];
  for await (const event of run.events) {
    events.push(event);
    if (event.type === "tool-request") {
      assert.equal(event.toolName, "nomo_project_changes");
      assert.deepEqual(JSON.parse(event.argsJson), { operation: "status" });
      await run.respondToTool(event.requestId, { kind: "result", resultJson: JSON.stringify({ status: "clean" }) });
    }
  }

  assert.equal(requests.length, 2);
  assert.equal(requests.every(({ headers }) => headers["x-api-key"] === "synthetic-local-key"), true);
  assert.equal(JSON.stringify(requests).includes("fixture task"), true);
  assert.deepEqual(events.filter((event) => event.type === "status").map((event) => event.status), ["starting", "running"]);
  const providerTools = requests[0]!.body.tools as Array<{
    name: string;
    input_schema: { properties: Record<string, { enum?: readonly string[] }>; required?: string[] };
  }>;
  assert.deepEqual(providerTools.map(({ name }) => name), ["mcp__nomo_workbench__nomo_project_changes"]);
  assert.deepEqual(providerTools[0]!.input_schema.properties.operation!.enum, ["status", "diff"]);
  assert.equal(providerTools[0]!.input_schema.properties.path !== undefined, true);
  assert.deepEqual(providerTools[0]!.input_schema.required, ["operation"]);
  assert.equal(events.some((event) => event.type === "assistant-message" && event.text === "fixture answer"), true);
  const terminal = events.at(-1);
  assert.equal(terminal?.type, "terminal");
  if (terminal?.type === "terminal") assert.equal(terminal.status, "completed");
  assert.ok(events.some((event) => event.type === "tool-result" && event.resultJson.includes("clean")), JSON.stringify(events));
  assert.deepEqual(
    (await readdir(tmpdir())).filter((name) => name.startsWith("nomo-claude-agent-") && !tempBefore.has(name)),
    [],
  );
});

test("Claude SDK cancellation reports confirmed only after the local session exits", async (t) => {
  const requestStarted = deferred<void>();
  const server = createServer((req) => {
    req.resume();
    requestStarted.resolve();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { promise: closed, resolve, reject } = deferred<void>();
  t.after(() => {
    server.close((error) => error ? reject(error) : resolve());
    return closed;
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const runner = new ClaudeAgentSdkRunner({ apiKey: "synthetic-local-key", endpoint: `http://127.0.0.1:${address.port}` });
  const run = await runner.start({
    task: "wait for the local fixture",
    systemPrompt: "Do not call tools.",
    workspace: { id: "grant-fixture", rootDigest: `sha256:${"b".repeat(64)}` as `sha256:${string}`, allowedTools: [] },
    tools: [],
    signal: new AbortController().signal,
  });
  await requestStarted.promise;
  assert.equal(await runner.cancel(run.id), "confirmed");
  const events: AgentRunEvent[] = [];
  for await (const event of run.events) events.push(event);
  const terminal = events.at(-1);
  assert.equal(terminal?.type, "terminal");
  if (terminal?.type === "terminal") assert.equal(terminal.status, "cancelled");
});
