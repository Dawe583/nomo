import type * as Http2Module from "node:http2";
import type * as HttpModule from "node:http";
import type * as HttpsModule from "node:https";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("Cursor SDK maps the local run to the mediated MCP-only executor", async (t) => {
  const require = createRequire(import.meta.url);
  const http2 = require("node:http2") as typeof Http2Module;
  const http = require("node:http") as typeof HttpModule;
  const https = require("node:https") as typeof HttpsModule;
  const blockedTransportCalls: string[] = [];
  const fetchFixtureCalls: Array<{ host: string; path: string; method: string }> = [];
  const blockNetwork = (kind: string) => {
    blockedTransportCalls.push(kind);
    throw new Error("Network forbidden by the Cursor SDK fixture");
  };
  // Keep guards active until process exit; the SDK may flush telemetry asynchronously.
  http2.connect = blockNetwork.bind(null, "http2.connect") as typeof http2.connect;
  http.request = blockNetwork.bind(null, "http.request") as typeof http.request;
  https.request = blockNetwork.bind(null, "https.request") as typeof https.request;
  globalThis.fetch = async (input, init) => {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(rawUrl);
    fetchFixtureCalls.push({
      host: url.host,
      path: url.pathname,
      method: init?.method ?? "GET",
    });
    return new Response("{}", { status: 503 });
  };

  const { createAgentPlatform, JsonlLocalAgentStore } = await import("@cursor/sdk");
  const root = mkdtempSync(join(tmpdir(), "nomo-cursor-sdk-fixture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const store = new JsonlLocalAgentStore(join(root, "state"));
  const platform = await createAgentPlatform({
    localStore: store,
    stateRoot: join(root, "state"),
    workspaceRef: workspace,
  });

  let executorOptions: unknown;
  let runOptions: unknown;
  let grantActive = true;
  let callbackEffectCount = 0;
  let abortCalled = false;
  const originalResolve = platform.resolveLocalModelSelection;
  platform.resolveLocalModelSelection = async (selection) => selection;
  const originalAcquire = platform.acquireLocalExecutor;
  platform.acquireLocalExecutor = async (options) => {
    executorOptions = options;
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    return {
      handle: {
        run: async (_input, options) => {
          runOptions = options;
          return {
            abort() {
              abortCalled = true;
              resolveDone();
            },
            done,
          };
        },
      },
      cacheMiss: true,
      release: async () => {},
    };
  };
  t.after(() => {
    platform.resolveLocalModelSelection = originalResolve;
    platform.acquireLocalExecutor = originalAcquire;
  });

  const agent = await platform.createAgent({
    model: { id: "fixture-model" },
    apiKey: "synthetic-fixture-key",
    tools: ["mcp"],
    local: {
      cwd: workspace,
      settingSources: [],
      customTools: {
        broker_probe: {
          description: "Workbench-mediated fixture callback",
          execute: async (args) => {
            if (!grantActive) throw new Error("grant revoked");
            callbackEffectCount += 1;
            return args.operation === "status" ? "fixture-ok" : "unexpected operation";
          },
        },
      },
    },
  });
  let agentClosed = false;
  t.after(() => {
    if (!agentClosed) agent.close();
  });

  const run = await agent.send("synthetic local fixture prompt");
  assert.ok(executorOptions);
  assert.ok(runOptions);
  const executor = executorOptions as {
    workingDirectory?: string;
    settingSources?: readonly string[];
  };
  const request = runOptions as {
    allowedTools?: readonly string[];
    apiKey?: string;
    customTools?: Record<
      string,
      {
        execute: (
          args: Record<string, unknown>,
          context: { sessionId?: string },
        ) => unknown | Promise<unknown>;
      }
    >;
    mcpServersOverride?: Record<string, unknown>;
  };

  assert.equal(executor.workingDirectory, workspace);
  assert.deepEqual(executor.settingSources, []);
  assert.deepEqual(request.allowedTools, [
    "mcp_tool_call",
    "get_mcp_tools_tool_call",
    "list_mcp_resources_tool_call",
    "read_mcp_resource_tool_call",
    "mcp_auth_tool_call",
  ]);
  assert.deepEqual(Object.keys(request.customTools ?? {}), ["broker_probe"]);
  assert.deepEqual(Object.keys(request.mcpServersOverride ?? {}), []);
  assert.equal(request.apiKey, "synthetic-fixture-key");

  const callback = request.customTools?.broker_probe;
  assert.ok(callback);
  assert.equal(
    await callback.execute({ operation: "status" }, { sessionId: "fixture" }),
    "fixture-ok",
  );
  grantActive = false;
  await assert.rejects(
    async () => callback.execute({ operation: "apply" }, { sessionId: "fixture" }),
    /grant revoked/,
  );
  assert.equal(callbackEffectCount, 1);
  await run.cancel();
  assert.equal(abortCalled, true);
  assert.equal(run.status, "cancelled");
  agent.close();
  agentClosed = true;

  assert.deepEqual(blockedTransportCalls, []);
  assert.deepEqual(fetchFixtureCalls, []);
});
