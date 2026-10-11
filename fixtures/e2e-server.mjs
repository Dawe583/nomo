#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const identityMode = process.argv.includes("--identity");
const identityE2eTools = identityMode
  ? (await import("./identity-e2e-tools.mjs")).identityE2eTools
  : [];
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  write({ jsonrpc: "2.0", id, result: value });
}

function error(id, code, message) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolList() {
  if (identityMode) return { tools: identityE2eTools };
  return {
    tools: [
      {
        name: "echo",
        description: "Returns the text argument unchanged.",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      },
      {
        name: "orders_delete",
        description: "Destructive test tool that deletes matching orders.",
        inputSchema: {
          type: "object",
          properties: { where: { type: "string" } },
          required: ["where"],
        },
      },
      {
        name: "orders_update",
        description: "Writes a status to matching orders.",
        inputSchema: {
          type: "object",
          properties: { where: { type: "string" }, status: { type: "string" } },
          required: ["where", "status"],
        },
      },
    ],
  };
}

function callTool(id, params) {
  if (!isObject(params) || typeof params.name !== "string") {
    error(id, -32602, "tools/call params.name is required");
    return;
  }

  const args = isObject(params.arguments) ? params.arguments : {};
  if (identityMode) {
    if (process.env.NOMO_E2E_TRACE)
      // The disposable trace includes arguments so the E2E can detect credential forwarding.
      appendFileSync(
        process.env.NOMO_E2E_TRACE,
        `${JSON.stringify({ tool: params.name, arguments: args })}\n`,
      );
    if (params.name === "aws.s3.object.put") {
      const key = typeof args.key === "string" ? args.key : "";
      result(id, { content: [{ type: "text", text: `stored ${key}` }] });
      return;
    }
    if (params.name === "aws.s3.bucket.delete") {
      const bucket = typeof args.bucket === "string" ? args.bucket : "";
      result(id, { content: [{ type: "text", text: `deleted ${bucket}` }] });
      return;
    }
    if (params.name === "aws.s3.object.delete") {
      const key = typeof args.key === "string" ? args.key : "";
      result(id, { content: [{ type: "text", text: `deleted ${key}` }] });
      return;
    }
    error(id, -32601, `unknown tool ${params.name}`);
    return;
  }
  if (params.name === "echo") {
    const text = typeof args.text === "string" ? args.text : "";
    result(id, { content: [{ type: "text", text }] });
    return;
  }

  if (params.name === "orders_delete") {
    const where = typeof args.where === "string" ? args.where : "";
    const count = where.includes("status") ? 2 : 1;
    result(id, { content: [{ type: "text", text: `deleted ${count}` }], count });
    return;
  }

  if (params.name === "orders_update") {
    const status = typeof args.status === "string" ? args.status : "";
    result(id, { content: [{ type: "text", text: `updated to ${status}` }] });
    return;
  }

  error(id, -32601, `unknown tool ${params.name}`);
}

function handle(message) {
  if (!isObject(message) || message.jsonrpc !== "2.0") {
    error(null, -32600, "invalid JSON-RPC message");
    return;
  }

  if (!("id" in message)) return;

  if (message.method === "initialize") {
    result(message.id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "void-e2e-fixture", version: "1.0.0" },
    });
    return;
  }

  if (message.method === "tools/list") {
    result(message.id, toolList());
    return;
  }

  if (message.method === "tools/call") {
    callTool(message.id, message.params);
    return;
  }

  error(message.id, -32601, `method not found: ${message.method}`);
}

for await (const line of rl) {
  if (line.trim() === "") continue;
  try {
    handle(JSON.parse(line));
  } catch (err) {
    error(null, -32700, err instanceof Error ? err.message : String(err));
  }
}
