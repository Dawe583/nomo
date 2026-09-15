import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { recoveryMcpServer, type RecoveryTool } from "./recovery-mcp.ts";
import {
  recoveryRuntime,
  localOperationJournal,
  localRecoveryVault,
  type RecoveryAdapter,
  type Json,
} from "../../runtime/src/index.ts";
import { devKeyProvider } from "../../ledger/src/sign.ts";
import { managedFilesystemAdapter } from "../../connectors/src/filesystem/managed.ts";

test("MCP client executes, previews and restores through signed runtime; policy and workspace cannot be supplied by agent", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "void-mcp-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const signer = await devKeyProvider({ dir: join(dir, "keys"), env: {} });
  let value: Json = { value: "before" },
    writes = 0;
  const adapter: RecoveryAdapter = {
    id: "postgres",
    version: "1",
    async preflight() {
      return {
        effect: "write",
        reversibility: "r1",
        readiness: "verified",
        scope: "fixture",
        resources: ["row"],
        revision: value,
        blastRadius: { count: 1, precision: "exact" },
      };
    },
    async prepare(args) {
      return { before: value, plan: args };
    },
    async execute(args) {
      writes++;
      value = args;
      return { result: value, evidence: null };
    },
    async release() {},
    async reconcile() {
      return { status: "unknown" };
    },
    async recover(prepared) {
      value = prepared.before;
      return { status: "restored", evidence: value };
    },
  };
  const runtime = recoveryRuntime({
    journal: localOperationJournal(join(dir, "journal"), signer),
    vault: localRecoveryVault(
      join(dir, "vault"),
      { key: randomBytes(32) },
      "key",
    ),
    adapters: [adapter],
    authorize: async () => true,
  });
  const denied = new Set<RecoveryTool>();
  const server = recoveryMcpServer({
    runtime,
    workspace: "test",
    agentId: "host",
    adapterId: "postgres",
    permitted: async (name) => !denied.has(name),
  });
  const client = new Client({ name: "integration-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  assert.equal((await client.listTools()).tools.length, 5);
  const call = async (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args });
  const payload = (r: Awaited<ReturnType<typeof call>>) =>
    JSON.parse((r.content as { text: string }[])[0]!.text);
  const input = {
    operationId: "op",
    runId: "run",
    mutation: { value: "after" },
  };
  assert.equal(
    (await call("void_execute", { ...input, workspace: "other" })).isError,
    true,
  );
  assert.equal(writes, 0);
  denied.add("void_execute");
  assert.equal((await call("void_execute", input)).isError, true);
  assert.equal(writes, 0);
  denied.clear();
  assert.equal(payload(await call("void_execute", input)).status, "succeeded");
  assert.equal(payload(await call("void_execute", input)).status, "succeeded");
  assert.equal(writes, 1);
  const plan = payload(await call("void_recovery_plan", { operationId: "op" }));
  assert.equal(
    (
      await call("void_recovery_apply", {
        plan: { ...plan, workspace: "other" },
      })
    ).isError,
    true,
  );
  denied.add("void_recovery_apply");
  assert.equal((await call("void_recovery_apply", { plan })).isError, true);
  assert.deepEqual(value, { value: "after" });
  denied.clear();
  assert.equal(
    payload(await call("void_recovery_apply", { plan })).status,
    "restored",
  );
  assert.deepEqual(value, { value: "before" });
  assert.equal(
    payload(await call("void_recovery_apply", { plan })).status,
    "restored",
  );
  assert.equal(writes, 1);
});
test("actual CLI stdio process remains alive after initialize and denies writes without policy", async (t) => {
  const { writeFile } = await import("node:fs/promises");
  const { StdioClientTransport } =
    await import("@modelcontextprotocol/sdk/client/stdio.js");
  const dir = await mkdtemp(join(tmpdir(), "void-mcp-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = join(dir, "config.json");
  await writeFile(
    config,
    JSON.stringify({
      workspace: "test",
      agentId: "test-agent",
      stateDir: "state",
      encryptionKeyEnv: "TEST_RECOVERY_KEY",
      postgres: {
        urlEnv: "TEST_DATABASE_URL",
        schema: "void_meta",
        tables: [
          { table: "public.account", primaryKey: ["id"], columns: ["balance"] },
        ],
      },
    }),
  );
  const client = new Client({ name: "stdio-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      (await import("node:url")).fileURLToPath(
        new URL("../bin/void.mjs", import.meta.url),
      ),
      "recovery",
      "serve",
      "--config",
      config,
    ],
    env: {
      ...(process.env as Record<string, string>),
      TEST_RECOVERY_KEY: randomBytes(32).toString("base64"),
      TEST_DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
    },
    stderr: "pipe",
  });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 5);
  assert.equal(
    (
      await client.callTool({
        name: "void_execute",
        arguments: {
          operationId: "op",
          runId: "run",
          mutation: {
            table: "public.account",
            action: "delete",
            key: { id: 1 },
          },
        },
      })
    ).isError,
    true,
  );
  assert.equal((await client.listTools()).tools.length, 5);
});

test("filesystem MCP advertises platform rename scope and enforces mutation schemas", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "void-mcp-rename-")),
    root = join(dir, "project");
  await mkdir(root);
  await writeFile(join(root, "source"), "before");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const signer = await devKeyProvider({ dir: join(dir, "keys"), env: {} });
  const runtime = recoveryRuntime({
    journal: localOperationJournal(join(dir, "journal"), signer),
    vault: localRecoveryVault(
      join(dir, "vault"),
      { key: randomBytes(32) },
      "key",
    ),
    adapters: [managedFilesystemAdapter({ root, cooperative: true })],
    authorize: async () => true,
  });
  const server = recoveryMcpServer({
    runtime,
    workspace: "test",
    agentId: "agent",
    adapterId: "filesystem.managed",
    permitted: async () => true,
  });
  const client = new Client({ name: "filesystem-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const execute = (await client.listTools()).tools.find(
    (entry) => entry.name === "void_execute",
  )!;
  const mutation = execute.inputSchema.properties!.mutation as {
    oneOf: Array<{
      required: string[];
      properties: { action: { enum: string[] } };
    }>;
  };
  assert.deepEqual(
    mutation.oneOf.map((schema) => ({
      action: schema.properties.action.enum[0],
      required: schema.required,
    })),
    [
      { action: "write", required: ["action", "path", "base64"] },
      { action: "delete", required: ["action", "path"] },
      ...(process.platform === "win32"
        ? []
        : [{ action: "rename", required: ["action", "path", "to"] }]),
    ],
  );
  const call = async (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args });
  const text = (result: Awaited<ReturnType<typeof call>>) =>
    (result.content as { text: string }[])[0]!.text;
  const payload = (result: Awaited<ReturnType<typeof call>>) =>
    JSON.parse(text(result));
  let invalidIndex = 0;
  for (const invalid of [
    { action: "rename", path: "source" },
    { action: "rename", path: "source", to: "moved", base64: "" },
    { action: "delete", path: "source", to: "moved" },
    { action: "write", path: "source" },
  ]) {
    const result = await call("void_execute", {
      operationId: `invalid-${invalidIndex++}`,
      runId: "run",
      mutation: invalid,
    });
    if (result.isError)
      assert.match(text(result), /refused|failed|requires|accepts|Expected/);
    else assert.equal(payload(result).status, "failed");
  }
  if (process.platform === "win32") {
    const refused = await call("void_execute", {
      operationId: "rename",
      runId: "run",
      mutation: { action: "rename", path: "source", to: "moved" },
    });
    assert.equal(payload(refused).status, "failed");
    assert.equal(await readFile(join(root, "source"), "utf8"), "before");
    return;
  }
  assert.equal(
    payload(
      await call("void_execute", {
        operationId: "rename",
        runId: "run",
        mutation: { action: "rename", path: "source", to: "moved" },
      }),
    ).status,
    "succeeded",
  );
  assert.equal(await readFile(join(root, "moved"), "utf8"), "before");
  const plan = payload(
    await call("void_recovery_plan", { operationId: "rename" }),
  );
  assert.equal(
    payload(await call("void_recovery_apply", { plan })).status,
    "restored",
  );
  assert.equal(await readFile(join(root, "source"), "utf8"), "before");
});
