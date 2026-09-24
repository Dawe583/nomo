import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { recoveryMcpServer, type RecoveryErrorCategory, type RecoveryTool } from "./recovery-mcp.ts";
import {
  recoveryRuntime,
  localOperationJournal,
  localRecoveryVault,
  type RecoveryAdapter,
  type Json,
} from "../../runtime/src/index.ts";
import { devKeyProvider } from "../../ledger/src/sign.ts";
import { managedGitAdapter } from "../../connectors/src/git/managed.ts";
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
  assert.equal((await client.listTools()).tools.length, 8);
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
  const second = await call("void_execute", {
    operationId: "second",
    runId: "run",
    mutation: { value: "second-after" },
  });
  assert.equal(payload(second).status, "succeeded");
  const job = "retained-job";
  const request = {
    jobId: job,
    selection: { kind: "operations", operationIds: ["second", "missing"] },
  };
  const stored = payload(await call("void_recovery_plan_job", request));
  assert.equal(stored.jobId, job);
  assert.deepEqual(
    stored.steps.map((step: { operationId: string }) => step.operationId),
    ["second"],
  );
  assert.deepEqual(stored.residuals, [{ operationId: "missing", status: "missing" }]);
  assert.equal(
    payload(await call("void_recovery_status_job", { jobId: job })).digest,
    stored.digest,
  );
  denied.add("void_recovery_apply_job");
  assert.equal(
    (
      await call("void_recovery_apply_job", {
        jobId: job,
        planDigest: stored.digest,
      })
    ).isError,
    true,
  );
  denied.clear();
  const applied = payload(
    await call("void_recovery_apply_job", {
      jobId: job,
      planDigest: stored.digest,
    }),
  );
  assert.equal(applied.status, "partial");
  assert.equal(applied.checkpoint, 1);
  assert.deepEqual(
    applied.residuals,
    [{ operationId: "missing", status: "missing" }],
  );
  assert.deepEqual(
    payload(await call("void_recovery_status_job", { jobId: job })),
    applied,
  );
  const replanned = payload(await call("void_recovery_plan_job", request));
  assert.equal(replanned.digest, stored.digest);
  assert.equal(
    (await call("void_recovery_plan_job", { jobId: job, selection: { kind: "run", runId: "run" } }))
      .isError,
    true,
  );
  assert.equal(
    payload(
      await call("void_recovery_apply_job", {
        jobId: job,
        planDigest: "0".repeat(64),
      }),
    ).status,
    applied.status,
  );
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
  assert.equal((await client.listTools()).tools.length, 8);
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
  assert.equal((await client.listTools()).tools.length, 8);
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
      properties: {
        action: { enum: string[] };
        path: { description?: string };
        to?: { description?: string };
      };
    }>;
  };
  assert.match(execute.description!, /workspace-relative/i);
  assert.match(execute.description!, /1 MiB/i);
  assert.match(execute.description!, /no shell/i);
  for (const schema of mutation.oneOf) {
    assert.match(schema.properties.path.description ?? "", /workspace-relative/i);
    if (schema.properties.to)
      assert.match(schema.properties.to.description ?? "", /workspace-relative/i);
  }
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


test("Git MCP schema exposes only the closed structured mutation union", async (t) => {
  const server = recoveryMcpServer({ runtime: {} as never, workspace: "test", agentId: "agent", adapterId: "git.managed", permitted: async () => false });
  const client = new Client({ name: "git-schema-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  const execute = (await client.listTools()).tools.find((entry) => entry.name === "void_execute")!;
  assert.match(execute.description!, /cooperative POSIX/);
  assert.match(execute.description!, /dangling blob/);
  const mutation = execute.inputSchema.properties!.mutation as { oneOf: Array<{ required: string[]; properties: { action: { enum: string[] } } }> };
  assert.deepEqual(mutation.oneOf.map((item) => item.properties.action.enum[0]), ["write", "delete", "stage", "unstage", "rename"]);
  assert.equal(mutation.oneOf.some((item) => item.properties.action.enum.includes("create")), false);
});


test("Git MCP validates mutations through the real signed runtime", async (t) => {
  if (process.platform === "win32") return;
  const dir = await mkdtemp(join(tmpdir(), "void-mcp-git-")), root = join(dir, "repo");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.name", "VOID test"]); execFileSync("git", ["-C", root, "config", "user.email", "void@example.invalid"]); await writeFile(join(root, "sentinel"), "unchanged"); execFileSync("git", ["-C", root, "add", "sentinel"]); execFileSync("git", ["-C", root, "commit", "-qm", "initial"]);
  const signer = await devKeyProvider({ dir: join(dir, "keys"), env: {} });
  const runtime = recoveryRuntime({ journal: localOperationJournal(join(dir, "journal"), signer), vault: localRecoveryVault(join(dir, "vault"), { key: randomBytes(32) }, "key"), adapters: [managedGitAdapter({ root, cooperative: true })], authorize: async () => true });
  const server = recoveryMcpServer({ runtime, workspace: "test", agentId: "agent", adapterId: "git.managed", permitted: async () => true });
  const client = new Client({ name: "git-runtime-test", version: "1" }); const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  let id = 0;
  const indexPath = execFileSync("git", ["-C", root, "rev-parse", "--git-path", "index"], { encoding: "utf8" }).trim();
  const snapshot = async () => ({ status: execFileSync("git", ["-C", root, "status", "--porcelain=v2", "-z"], { encoding: "buffer" }), index: await readFile(join(root, indexPath)), sentinel: await readFile(join(root, "sentinel")) });
  for (const mutation of [
    { action: "write", path: "file" }, { action: "write", path: "file", base64: "", to: "other" },
    { action: "delete", path: "file", base64: "" }, { action: "delete", path: "file", to: "other" }, { action: "stage", path: "file", base64: "" }, { action: "stage", path: "file", to: "other" },
    { action: "unstage", path: "file", base64: "" }, { action: "unstage", path: "file", to: "other" }, { action: "rename", path: "file" },
    { action: "rename", path: "file", to: "other", base64: "" }, { action: "unknown", path: "file" },
    { action: "stage", path: 4 },
  ]) {
    const before = await snapshot();
    const result = await client.callTool({ name: "void_execute", arguments: { operationId: `bad-${id++}`, runId: "run", mutation } });
    assert.equal(result.isError === true || JSON.parse((result.content as { text: string }[])[0]!.text).status === "failed", true);
    assert.deepEqual(await snapshot(), before);
  }
  const text = (result: Awaited<ReturnType<typeof client.callTool>>) => JSON.parse((result.content as { text: string }[])[0]!.text);
  const valid = await client.callTool({ name: "void_execute", arguments: { operationId: "valid", runId: "run", mutation: { action: "write", path: "file", base64: "" } } });
  assert.equal(text(valid).status, "succeeded");
  const plan = text(await client.callTool({ name: "void_recovery_plan", arguments: { operationId: "valid" } }));
  assert.equal(text(await client.callTool({ name: "void_recovery_apply", arguments: { plan } })).status, "restored");
  await assert.rejects(readFile(join(root, "file")), { code: "ENOENT" });
});
test("MCP errors expose stable sanitized categories without path or secret disclosure", async (t) => {
  type ToolCallResult = {
    isError?: boolean;
    content: { type: string; text?: string }[];
  };
  type ErrorCase = {
    category: RecoveryErrorCategory;
    failure: string | null;
    tool: "void_execute" | "void_recovery_plan";
    args: Record<string, unknown>;
  };
  let failure = new Error("Required operation evidence is missing at /Users/private/secret.vault");
  let denied = false;
  const runtime = {
    planRecovery: async () => {
      throw failure;
    },
  } as never;
  const server = recoveryMcpServer({
    runtime,
    workspace: "test",
    agentId: "agent",
    adapterId: "filesystem.managed",
    permitted: async () => !denied,
  });
  const client = new Client({ name: "error-category-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const call = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolCallResult> =>
    client.callTool({ name, arguments: args }) as Promise<ToolCallResult>;
  const error = (result: ToolCallResult) =>
    JSON.parse(result.content[0]?.text ?? "") as {
      category: string;
      message: string;
    };
  const cases: readonly ErrorCase[] = [
    {
      category: "invalid_path",
      failure: null,
      tool: "void_execute",
      args: {
        operationId: "invalid-path",
        runId: "run",
        mutation: {
          action: "write",
          path: "/Users/private/secret.txt",
          base64: "",
        },
      },
    },
    {
      category: "missing_artifact",
      failure: "Required operation evidence is missing at /Users/private/secret.vault",
      tool: "void_recovery_plan",
      args: { operationId: "missing" },
    },
    {
      category: "key_unavailable",
      failure: "Recovery key unavailable for /Users/private/keyring",
      tool: "void_recovery_plan",
      args: { operationId: "key" },
    },
    {
      category: "unsupported_recovery",
      failure: "Operation has no verified recovery capability.",
      tool: "void_recovery_plan",
      args: { operationId: "unsupported" },
    },
    {
      category: "unknown",
      failure: "postgres://user:password@db/private and prompt body",
      tool: "void_recovery_plan",
      args: { operationId: "unknown" },
    },
  ];
  for (const testCase of cases) {
    if (testCase.failure) failure = new Error(testCase.failure);
    const result = await call(testCase.tool, testCase.args);
    assert.equal(result.isError, true);
    const payload = error(result);
    assert.equal(payload.category, testCase.category);
    assert.doesNotMatch(
      JSON.stringify(payload),
      /private|secret|password|postgres:\/\//i,
    );
  }
  denied = true;
  const deniedResult = await call("void_recovery_plan", { operationId: "policy" });
  assert.equal(deniedResult.isError, true);
  assert.equal(error(deniedResult).category, "policy_denied");
  assert.doesNotMatch(JSON.stringify(error(deniedResult)), /private|secret|password/i);
});
