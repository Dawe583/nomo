import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { keyProviderFromPkcs8 } from "../../../ledger/src/sign.ts";
import type { UpstreamEvents } from "../bin.ts";
import type { UpstreamProcess } from "./stdio.ts";
import { startLocalMcpHttpServer } from "./http-server.ts";

const currentMeta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "nomo-test", version: "1" },
};

test("serves current MCP through the grant and existing proxy path", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nomo-inbound-mcp-"));
  const policyPath = join(directory, "policy.yml");
  await writeFile(policyPath, "version: 1\nrules:\n  - match: {}\n    decision: allow\n");
  const ledgerDir = join(directory, "ledger");
  const validToken = "A".repeat(43);
  const wrongAudienceToken = "B".repeat(43);
  const expiredToken = "C".repeat(43);
  const targetMessages: Array<Record<string, unknown>> = [];
  let targetClosed = false;
  const identity = {
    agentId: "registered-agent",
    toolScope: ["aws.s3.bucket.delete"],
    expiresAt: Date.now() + 60_000,
  };
  const proxyOptions = {
    upstreamCommand: ["fixture"],
    policyPath,
    posture: "fail-closed" as const,
    ledgerDir,
    workspace: "test-workspace",
    inboundMaxBytes: 512,
    keyProvider: keyProviderFromPkcs8(
      generateKeyPairSync("ed25519").privateKey.export({
        format: "der",
        type: "pkcs8",
      }),
    ),
    upstreamSpawn(events: UpstreamEvents): UpstreamProcess {
      return {
        send(line) {
          const message = JSON.parse(line) as {
            id?: number | string;
            method?: string;
            params?: { name?: string; arguments?: Record<string, unknown> };
          };
          targetMessages.push(message as Record<string, unknown>);
          if (message.method === "initialize") {
            events.onMessage(JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion: "2025-11-25",
                capabilities: { tools: {} },
                serverInfo: { name: "fixture", version: "1" },
              },
            }));
          } else if (message.method === "tools/list") {
            events.onMessage(JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                tools: [{
                  name: "aws.s3.bucket.delete",
                  description: "Echo the provided value",
                  inputSchema: {
                    type: "object",
                    properties: { value: { type: "string" } },
                    required: ["value"],
                    additionalProperties: false,
                  },
                }],
              },
            }));
          } else if (message.method === "tools/call") {
            events.onMessage(JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                content: [{ type: "text", text: message.params?.arguments?.value }],
              },
            }));
          }
        },
        close() {
          if (targetClosed) return;
          targetClosed = true;
          events.onClose(0, null);
        },
        onStderr() {
          return () => {};
        },
      };
    },
  };
  const server = await startLocalMcpHttpServer({
    upstreamId: "fixture-upstream",
    proxyOptions,
    port: 0,
    resolveGrant(token, upstreamId) {
      if (upstreamId !== "fixture-upstream") return null;
      if (token === expiredToken) return { ...identity, expiresAt: Date.now() - 1 };
      return token === validToken ? identity : null;
    },
    validateGrant(token, upstreamId, toolName) {
      return token === validToken &&
        upstreamId === "fixture-upstream" &&
        toolName === "aws.s3.bucket.delete"
        ? identity
        : null;
    },
  });
  t.after(async () => {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });

  const post = (body: unknown, token = validToken, headers: Record<string, string> = {}) => {
    const message = typeof body === "object" && body !== null
      ? body as { method?: unknown; params?: { name?: unknown; uri?: unknown } }
      : {};
    const method = typeof message.method === "string" ? message.method : undefined;
    const name = typeof message.params?.name === "string"
      ? message.params.name
      : typeof message.params?.uri === "string"
        ? message.params.uri
        : undefined;
    return fetch(server.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2026-07-28",
        ...(method && { "mcp-method": method }),
        ...(name && { "mcp-name": name }),
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  };

  const unauthorized = await post({
    jsonrpc: "2.0",
    id: 1,
    method: "server/discover",
    params: { _meta: currentMeta },
  }, "invalid-grant");
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers.get("www-authenticate") ?? "", /^Bearer/);
  assert.equal(targetMessages.length, 0);

  const wrongAudience = await post({
    jsonrpc: "2.0",
    id: 8,
    method: "server/discover",
    params: { _meta: currentMeta },
  }, wrongAudienceToken);
  assert.equal(wrongAudience.status, 401);
  const expired = await post({
    jsonrpc: "2.0",
    id: 9,
    method: "server/discover",
    params: { _meta: currentMeta },
  }, expiredToken);
  assert.equal(expired.status, 401);
  assert.equal(targetMessages.length, 0);

  const originRejected = await post({
    jsonrpc: "2.0",
    id: 2,
    method: "server/discover",
    params: { _meta: currentMeta },
  }, validToken, { origin: "https://untrusted.example" });
  assert.equal(originRejected.status, 403);
  assert.equal(targetMessages.length, 0);

  const hostRejected = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(server.url, {
      method: "POST",
      headers: {
        host: "attacker.example",
        authorization: `Bearer ${validToken}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "server/discover",
      },
    }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    request.on("error", reject);
    request.end(JSON.stringify({
      jsonrpc: "2.0",
      id: 10,
      method: "server/discover",
      params: { _meta: currentMeta },
    }));
  });
  assert.equal(hostRejected, 403);
  assert.equal(targetMessages.length, 0);

  const malformed = await post("not json");
  assert.ok(malformed.status >= 400);
  assert.equal(targetMessages.length, 0);

  const oversized = await post({
    jsonrpc: "2.0",
    id: 3,
    method: "server/discover",
    params: { _meta: currentMeta, padding: "x".repeat(800) },
  });
  assert.equal(oversized.status, 413);
  assert.equal(targetMessages.length, 0);

  const unsupportedMethod = await fetch(server.url, {
    method: "GET",
    headers: { authorization: `Bearer ${validToken}` },
  });
  assert.equal(unsupportedMethod.status, 405);
  assert.equal(targetMessages.length, 0);

  const discovery = await post({
    jsonrpc: "2.0",
    id: 4,
    method: "server/discover",
    params: { _meta: currentMeta },
  });
  const discoveryText = await discovery.text();
  assert.equal(discovery.status, 200);
  const discovered = JSON.parse(discoveryText) as {
    result?: { supportedVersions?: string[]; capabilities?: { tools?: unknown } };
  };
  assert.ok(discovered.result?.supportedVersions?.includes("2026-07-28"));
  assert.ok(discovered.result?.capabilities?.tools);

  const list = await post({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/list",
    params: { _meta: currentMeta },
  });
  assert.equal(list.status, 200);
  const listed = await list.json() as { result?: { tools?: Array<{ name: string }> } };
  assert.deepEqual(listed.result?.tools?.map((tool) => tool.name), ["aws.s3.bucket.delete"]);

  const call = await post({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: { name: "aws.s3.bucket.delete", arguments: { value: "hello" }, _meta: currentMeta },
  });
  assert.equal(call.status, 200);
  const called = await call.json() as { result?: { content?: Array<{ text?: string }> } };
  assert.equal(called.result?.content?.[0]?.text, "hello");
  assert.equal(targetMessages.filter((message) => message.method === "tools/call").length, 1);
  assert.equal(JSON.stringify(targetMessages).includes(validToken), false);

  const outOfScope = await post({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "fixture.delete", arguments: {}, _meta: currentMeta },
  });
  assert.equal(outOfScope.status, 200);
  assert.equal(targetMessages.filter((message) => message.method === "tools/call").length, 1);
});
test("rechecks a grant after hold approval and before upstream dispatch", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nomo-grant-recheck-"));
  const policyPath = join(directory, "policy.yml");
  await writeFile(policyPath, [
    "version: 1",
    "rules:",
    "  - match: { class: r3 }",
    "    decision: hold",
    "    seconds: 60",
    "    notify: [cli]",
    "  - match: {}",
    "    decision: deny",
  ].join("\n"));
  const token = "D".repeat(43);
  const targetMessages: Array<Record<string, unknown>> = [];
  let grantRevoked = false;
  let validateCalls = 0;
  const identity = {
    agentId: "registered-agent",
    toolScope: ["aws.s3.bucket.delete"],
    expiresAt: Date.now() + 60_000,
  };
  const server = await startLocalMcpHttpServer({
    upstreamId: "fixture-upstream",
    proxyOptions: {
      upstreamCommand: ["fixture"],
      policyPath,
      posture: "fail-closed",
      ledgerDir: join(directory, "ledger"),
      workspace: "grant-recheck",
      keyProvider: keyProviderFromPkcs8(
        generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }),
      ),
      onHold(queue) {
        const decideWhenReady = () => {
          const held = queue.list()[0];
          if (held === undefined) {
            setImmediate(decideWhenReady);
            return;
          }
          grantRevoked = true;
          queue.resolve(held.id, { kind: "approved" });
        };
        setImmediate(decideWhenReady);
      },
      upstreamSpawn(events: UpstreamEvents): UpstreamProcess {
        return {
          send(line) {
            const message = JSON.parse(line) as { id?: number; method?: string; params?: { name?: string } };
            targetMessages.push(message as Record<string, unknown>);
            if (message.method === "initialize") {
              events.onMessage(JSON.stringify({
                jsonrpc: "2.0", id: message.id,
                result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } },
              }));
            } else if (message.method === "tools/list") {
              events.onMessage(JSON.stringify({
                jsonrpc: "2.0", id: message.id,
                result: { tools: [{ name: "aws.s3.bucket.delete", inputSchema: { type: "object" } }] },
              }));
            } else if (message.method === "tools/call") {
              events.onMessage(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [] } }));
            }
          },
          close() { events.onClose(0, null); },
          onStderr() { return () => {}; },
        };
      },
    },
    resolveGrant(candidate, upstreamId) {
      return candidate === token && upstreamId === "fixture-upstream" && !grantRevoked
        ? identity
        : null;
    },
    validateGrant(candidate, upstreamId, toolName) {
      validateCalls += 1;
      return candidate === token && upstreamId === "fixture-upstream" &&
        toolName === "aws.s3.bucket.delete" && !grantRevoked
        ? identity
        : null;
    },
  });
  t.after(async () => {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });

  const response = await fetch(server.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      "mcp-name": "aws.s3.bucket.delete",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "aws.s3.bucket.delete",
        arguments: {},
        _meta: currentMeta,
      },
    }),
  });
  await response.text();
  assert.ok(validateCalls >= 2, "grant must be checked again at dispatch");
  assert.equal(targetMessages.filter((message) => message.method === "tools/call").length, 0);
});

test("keeps the grant token out of the ledger and the upstream request", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nomo-token-containment-"));
  const policyPath = join(directory, "policy.yml");
  await writeFile(policyPath, "version: 1\nrules:\n  - match: {}\n    decision: allow\n");
  const ledgerDir = join(directory, "ledger");
  // A distinctive random value, not a repeated character, so an accidental
  // collision elsewhere in the output cannot make the absence look proven.
  const token = randomBytes(32).toString("base64url");
  const identity = {
    agentId: "registered-agent",
    toolScope: ["aws.s3.bucket.delete"],
    expiresAt: Date.now() + 60_000,
  };
  const targetMessages: Array<Record<string, unknown>> = [];
  const stderr: string[] = [];
  // tsconfig.base.json pins lib es2022, so Promise.withResolvers is unavailable.
  // The executor runs synchronously, so the callback below closes over the real
  // resolver assigned here.
  let noteLogLine: () => void = () => {};
  const logWritten = new Promise<void>((resolve) => {
    noteLogLine = resolve;
  });
  let upstreamEvents: UpstreamEvents | undefined;
  const server = await startLocalMcpHttpServer({
    upstreamId: "fixture-upstream",
    port: 0,
    resolveGrant: (candidate, upstreamId) =>
      candidate === token && upstreamId === "fixture-upstream" ? identity : null,
    validateGrant: (candidate, upstreamId, toolName) =>
      candidate === token && upstreamId === "fixture-upstream" && toolName === "aws.s3.bucket.delete"
        ? identity
        : null,
    proxyOptions: {
      upstreamCommand: ["fixture"],
      policyPath,
      posture: "fail-closed" as const,
      ledgerDir,
      workspace: "token-containment",
      error: (line: string) => {
        stderr.push(line);
        noteLogLine();
      },
      keyProvider: keyProviderFromPkcs8(
        generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }),
      ),
      upstreamSpawn(events: UpstreamEvents): UpstreamProcess {
        upstreamEvents = events;
        return {
          send(line) {
            const message = JSON.parse(line) as {
              id?: number | string;
              method?: string;
            };
            targetMessages.push(message as Record<string, unknown>);
            if (message.method === "initialize") {
              events.onMessage(JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  protocolVersion: "2025-11-25",
                  capabilities: { tools: {} },
                  serverInfo: { name: "fixture", version: "1" },
                },
              }));
            } else if (message.method === "tools/list") {
              events.onMessage(JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  tools: [{
                    name: "aws.s3.bucket.delete",
                    description: "Echo the provided value",
                    inputSchema: {
                      type: "object",
                      properties: { value: { type: "string" } },
                      additionalProperties: false,
                    },
                  }],
                },
              }));
            } else if (message.method === "tools/call") {
              events.onMessage(JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: { content: [{ type: "text", text: "ok" }] },
              }));
            }
          },
          close() {
            events.onClose(0, null);
          },
          onStderr() {
            return () => {};
          },
        };
      },
    },
  });
  t.after(async () => {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });

  const call = await fetch(server.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      "mcp-name": "aws.s3.bucket.delete",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "aws.s3.bucket.delete",
        arguments: { value: "hello" },
        _meta: currentMeta,
      },
    }),
  });
  const responseText = await call.text();
  assert.equal(call.status, 200, "the in-scope call must succeed for this proof to mean anything");

  // The upstream saw the tools/call, so the request really was dispatched.
  assert.equal(targetMessages.filter((message) => message.method === "tools/call").length, 1);
  assert.equal(
    targetMessages.some((message) => JSON.stringify(message).includes(token)),
    false,
    "the grant token must never be forwarded upstream",
  );
  assert.equal(responseText.includes(token), false, "the grant token must never be echoed back");

  const ledgerFiles = await readdir(join(ledgerDir)).catch(() => [] as string[]);
  assert.ok(ledgerFiles.length > 0, "a decided call must leave a ledger record");
  for (const file of ledgerFiles) {
    const contents = await readFile(join(ledgerDir, file), "utf8");
    assert.equal(
      contents.includes(token),
      false,
      `the grant token must never reach durable storage (${file})`,
    );
  }
  // A clean fail-closed allow writes nothing to the error log, so an empty
  // capture would make the assertion below vacuous. Push a malformed upstream
  // line first: bin.ts routes that to writeError, proving the log was really
  // written and the check is looking at real content.
  upstreamEvents?.onMessage("{not json");
  // bin.ts awaits markPendingLegacyUnknown before writeError, so wait for the
  // error callback itself rather than a guessed duration.
  await logWritten;
  assert.ok(stderr.length > 0, "the error log must have been written to for this check to mean anything");
  assert.equal(
    stderr.join("\n").includes(token),
    false,
    "the grant token must never be written to the proxy error log",
  );
});
