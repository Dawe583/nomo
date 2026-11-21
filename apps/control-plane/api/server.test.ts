import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm, mkdir, truncate } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { dataDir } from "../../../packages/ledger/src/paths.ts";
import { devKeyProvider, sha256Hex } from "../../../packages/ledger/src/sign.ts";
import { entryHash } from "../../../packages/ledger/src/canonical.ts";
import { jsonlStore } from "../../../packages/ledger/src/store.ts";
import { listenControlPlane, type ApprovalBroker, type PendingApproval } from "./server.ts";
import { Workbench } from "../../../packages/workbench/src/index.ts";
import { OpenAIChatGPTAuthStore } from "../../../packages/workbench/src/openai-chatgpt-auth.ts";
import type { AgentRunner } from "../../../packages/workbench/src/agent-runners/agent-runner.ts";
import { PROJECT_WORKSPACE_LIMITS } from "../../../packages/workbench/src/project-workspace.ts";
import {
  assertProviderDescriptorInManifest,
  CONFIGURABLE_PROVIDER_DESCRIPTORS,
  PROVIDER_MODEL_MANIFEST,
} from "../../../packages/workbench/src/provider-catalog.ts";
import type { ProviderAdapterConfig } from "../../../packages/workbench/src/provider-adapters/types.ts";

type FeedBody = {
  readonly workspace: string;
  readonly at: string;
  readonly tool: string;
  readonly klass: string;
  readonly decision: string;
  readonly argsDigest: string;
  readonly payload?: string;
};

const workspace = "default";

async function seedLedger(count = 2): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "void-control-plane-api-"));
  const signer = await devKeyProvider({ dir: join(dir, "keys"), env: {} });
  const store = jsonlStore(signer, { dir });
  for (let index = 1; index <= count; index += 1) {
    const body: FeedBody = {
      workspace,
      at: `2026-09-0${index}T00:00:00.000Z`,
      tool: `postgres.row.update.${index}`,
      klass: index === 1 ? "r1" : "r3",
      decision: index === 1 ? "allow:resolved" : "hold:pending",
      argsDigest: `${index}`.repeat(64),
      payload: "not for the API feed",
    };
    await store.append(body);
  }
  return join(dir, `${workspace}.jsonl`);
}

type WithServerOptions = {
  readonly approvals?: ApprovalBroker;
  readonly env?: Readonly<NodeJS.ProcessEnv>;
  readonly workbench?: Workbench;
  readonly agentRunners?: readonly AgentRunner[];
};

async function isolatedWorkbenchDataDirectory(
  t: { after: (fn: () => void | Promise<void>) => void },
  prefix: string,
): Promise<string> {
  if (process.platform !== "win32") return mkdtemp(join(tmpdir(), prefix));
  const dataRoot = join(dataDir(homedir()), "test-workspaces");
  await mkdir(dataRoot, { recursive: true });
  return mkdtemp(join(dataRoot, prefix));
}

async function withServer<T>(
  ledgerPath: string,
  run: (origin: string) => Promise<T>,
  options: WithServerOptions = {},
): Promise<T> {
  const serverDataDirectory = await mkdtemp(join(tmpdir(), "void-api-workbench-"));
  const home = process.platform === "win32"
    ? join(dataDir(homedir()), "test-control-plane-home")
    : await mkdtemp(join(tmpdir(), "void-fleet-home-"));
  const handle = await listenControlPlane({
    ledgerPath,
    webRoot: join(import.meta.dirname, '../web'),
    approvals: options.approvals,
    workbench: options.workbench,
    agentRunners: options.agentRunners,
    env: { VOID_DATA_DIR: serverDataDirectory, ...options.env },
  });
  try {
    return await run(`http://127.0.0.1:${handle.port}`);
  } finally {
    await handle.close();
    await rm(serverDataDirectory, { recursive: true, force: true });
    if (process.platform !== "win32") await rm(home, { recursive: true, force: true });
  }
}

test("project workspace API reviews and applies one exact local file change", async (t) => {
  const dataDirectory = await isolatedWorkbenchDataDirectory(t, "nomo-project-api-data-");
  const projectRoot = await mkdtemp(join(tmpdir(), "nomo-project-api-root-"));
  await mkdir(join(projectRoot, "src"));
  await writeFile(join(projectRoot, "src/main.ts"), "before\n");
  await writeFile(join(projectRoot, "src/other.ts"), "untouched\n");
  await writeFile(join(projectRoot, "AGENTS.md"), "Read the project plan first.\n");
  execFileSync("git", ["init", "--quiet"], { cwd: projectRoot, stdio: "ignore" });
  t.after(async () => {
    await workbench.shutdown();
    await rm(dataDirectory, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });
  const workbench = new Workbench({ NOMO_DATA_DIR: dataDirectory });
  await withServer(
    "unused.jsonl",
    async (origin) => {
      const local = {
        origin,
        authorization: "Bearer workspace-api-token-0123456789abcdef",
        "content-type": "application/json",
      };
      const access = await fetch(`${origin}/api/project-workspace/access`, {
        method: "POST",
        headers: local,
        body: JSON.stringify({ path: projectRoot }),
      });
      assert.equal(access.status, 201);
      const confirmed = await access.json() as {
        project: { rootDigest: string };
        workspace: { fileCount: number };
        context: {
          files: Array<{ path: string; sha256: string; size: number }>;
          refused: Array<{ path: string; reason: string }>;
        };
      };
      assert.equal(confirmed.workspace.fileCount, 3);
      assert.deepEqual(confirmed.context.files.map(({ path }) => path), ["AGENTS.md"]);
      assert.equal(confirmed.context.files[0]!.sha256.length, 64);
      assert.deepEqual(confirmed.context.refused, []);
      const summaryResponse = await fetch(`${origin}/api/project-workspace`, { headers: local });
      assert.equal(summaryResponse.status, 200);
      const summary = await summaryResponse.json() as {
        project: { rootDigest: string } | null;
      };
      assert.equal(summary.project?.rootDigest, confirmed.project.rootDigest);
      const unsupportedMethod = await fetch(`${origin}/api/project-workspace`, {
        method: "PUT",
        headers: local,
      });
      assert.equal(unsupportedMethod.status, 405);

      const sourcePath = join(
        dataDirectory,
        "project-workspaces",
        confirmed.project.rootDigest.slice("sha256:".length),
        "source",
        "src/main.ts",
      );
      const secondSourcePath = join(
        dataDirectory,
        "project-workspaces",
        confirmed.project.rootDigest.slice("sha256:".length),
        "source",
        "src/other.ts",
      );
      await writeFile(secondSourcePath, "second change\n");
      await writeFile(sourcePath, "after\n");
      const page = await fetch(`${origin}/api/project-workspace/diff?limit=1`, { headers: local });
      assert.equal(page.status, 200);
      const pageBody = await page.json() as {
        files: Array<{ path: string; operation: string; digest: string }>;
        snapshotDigest: string;
        nextCursor: string | null;
      };
      assert.equal(pageBody.snapshotDigest.length, 64);
      assert.match(pageBody.files[0]?.digest ?? "", /^[a-f0-9]{64}$/);
      assert.deepEqual(pageBody.files.map(({ path, operation }) => ({ path, operation })), [
        { path: "src/main.ts", operation: "update" },
      ]);
      assert.ok(pageBody.nextCursor);
      await writeFile(secondSourcePath, "newer second change\n");
      const stalePage = await fetch(
        `${origin}/api/project-workspace/diff?limit=1&cursor=${encodeURIComponent(pageBody.nextCursor!)}`,
        { headers: local },
      );
      assert.equal(stalePage.status, 409);
      for (const protectedPath of [
        "packages/cli/src/tui/workspace.ts",
        "secrets/token",
        ".env.production",
      ]) {
        const protectedDiff = await fetch(
          `${origin}/api/project-workspace/diff?path=${encodeURIComponent(protectedPath)}`,
          { headers: local },
        );
        assert.equal(protectedDiff.status, 400, protectedPath);
      }
      const diff = await fetch(
        `${origin}/api/project-workspace/diff?path=${encodeURIComponent("src/main.ts")}`,
        { headers: local },
      );
      assert.equal(diff.status, 200);
      const diffBody = await diff.json() as {
        digest: string;
        file: { path: string; diff: string };
      };
      assert.equal(diffBody.file.path, "src/main.ts");
      assert.match(diffBody.file.diff, /-before\n\+after/);
      const applied = await fetch(`${origin}/api/project-workspace/apply`, {
        method: "POST",
        headers: local,
        body: JSON.stringify({ path: "src/main.ts", digest: diffBody.digest }),
      });
      assert.equal(applied.status, 200);
      const missingDigest = await fetch(`${origin}/api/project-workspace/apply`, {
        method: "POST",
        headers: local,
        body: JSON.stringify({ path: "src/main.ts" }),
      });
      assert.equal(missingDigest.status, 400);
      const staleApply = await fetch(`${origin}/api/project-workspace/apply`, {
        method: "POST",
        headers: local,
        body: JSON.stringify({ path: "src/main.ts", digest: "0".repeat(64) }),
      });
      assert.equal(staleApply.status, 409);
      assert.equal(await readFile(join(projectRoot, "src/main.ts"), "utf8"), "after\n");
      const revoked = await fetch(`${origin}/api/project-workspace`, {
        method: "DELETE",
        headers: local,
      });
      assert.equal(revoked.status, 200);
      const retained = await fetch(`${origin}/api/project-workspace`, { headers: local });
      const retainedBody = await retained.json() as {
        project: null;
        savedWorkspaces: Array<{ requiresConfirmation: boolean; hasChanges: boolean }>;
      };
      assert.equal(retainedBody.project, null);
      assert.equal(retainedBody.savedWorkspaces[0]?.requiresConfirmation, true);
      assert.equal(retainedBody.savedWorkspaces[0]?.hasChanges, true);
      assert.doesNotMatch(JSON.stringify(retainedBody), new RegExp(projectRoot));
      const deleted = await fetch(`${origin}/api/project-workspace/workspace`, {
        method: "DELETE",
        headers: local,
        body: JSON.stringify({ rootDigest: confirmed.project.rootDigest }),
      });
      assert.equal(deleted.status, 200);
      const catalog = await fetch(`${origin}/api/project-workspace`, { headers: local });
      assert.deepEqual(
        (await catalog.json() as { savedWorkspaces: unknown[] }).savedWorkspaces,
        [],
      );
      const badContentType = await fetch(`${origin}/api/project-workspace/access`, {
        method: "POST",
        headers: {
          origin,
          authorization: "Bearer workspace-api-token-0123456789abcdef",
          "content-type": "text/plain",
        },
        body: JSON.stringify({ path: projectRoot }),
      });
      assert.equal(badContentType.status, 415);
    },
    { workbench, env: { NOMO_CONTROL_TOKEN: "workspace-api-token-0123456789abcdef" } },
  );
});

test("project workspace API rejects invalid roots and file limits without activation", async (t) => {
  const dataDirectory = await isolatedWorkbenchDataDirectory(t, "nomo-project-api-limit-data-");
  const nonGitRoot = await mkdtemp(join(tmpdir(), "nomo-project-api-nongit-"));
  const largeRoot = await mkdtemp(join(tmpdir(), "nomo-project-api-large-"));
  const largeFile = join(largeRoot, "large.bin");
  await writeFile(largeFile, "");
  await truncate(largeFile, PROJECT_WORKSPACE_LIMITS.fileBytes + 1);
  execFileSync("git", ["init", "--quiet"], { cwd: largeRoot, stdio: "ignore" });
  t.after(async () => {
    await workbench.shutdown();
    await rm(dataDirectory, { recursive: true, force: true });
    await rm(nonGitRoot, { recursive: true, force: true });
    await rm(largeRoot, { recursive: true, force: true });
  });
  const workbench = new Workbench({ NOMO_DATA_DIR: dataDirectory });
  await withServer(
    "unused.jsonl",
    async (origin) => {
      const request = (path: string) => fetch(`${origin}/api/project-workspace/access`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ path }),
      });
      assert.equal((await request("relative/path")).status, 400);
      assert.equal((await request(nonGitRoot)).status, 400);
      assert.equal((await request(largeRoot)).status, 413);
      const response = await fetch(`${origin}/api/project-workspace`, { headers: { origin } });
      const summary = await response.json() as {
        project: unknown;
        savedWorkspaces: unknown[];
      };
      assert.equal(summary.project, null);
      assert.deepEqual(summary.savedWorkspaces, []);
    },
    { workbench },
  );
});

test("project workspace routes reject a hostile origin even with the control token", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "nomo-project-api-auth-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const workbench = new Workbench({ NOMO_DATA_DIR: dataDirectory });
  await withServer(
    "unused.jsonl",
    async (origin) => {
      for (const [path, method, body] of [
        ["/api/project-workspace", "GET", undefined],
        ["/api/project-workspace/access", "POST", JSON.stringify({ path: "/tmp" })],
        ["/api/project-workspace/diff?limit=50", "GET", undefined],
        ["/api/project-workspace/apply", "POST", JSON.stringify({})],
        ["/api/project-workspace", "DELETE", undefined],
        ["/api/project-workspace/workspace", "DELETE", JSON.stringify({})],
      ] as const) {
        const response = await fetch(origin + path, {
          method,
          headers: {
            authorization: "Bearer workspace-api-token-0123456789abcdef",
            origin: "https://attacker.invalid",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body }),
        });
        assert.equal(response.status, 403, `${method} ${path}`);
      }
    },
    { workbench, env: { NOMO_CONTROL_TOKEN: "workspace-api-token-0123456789abcdef" } },
  );
});

test("remote API auth recognizes NOMO_CONTROL_TOKEN with a non-local Host", async () => {
  const token = "nomo-control-token-0123456789abcdef";
  await withServer(
    "unused.jsonl",
    async (origin) => {
      const response = await fetch(`${origin}/api/not-a-route`, {
        headers: {
          host: "harness.remote.test",
          authorization: `Bearer ${token}`,
        },
      });
      assert.equal(response.status, 404);
    },
    { env: { NOMO_CONTROL_TOKEN: token } },
  );
});

test("session image routes remain local when remote token auth is enabled", async () => {
  const token = "nomo-control-token-0123456789abcdef";
  await withServer(
    "unused.jsonl",
    async (origin) => {
      const response = await fetch(
        `${origin}/api/sessions/00000000-0000-0000-0000-000000000000/images/00000000-0000-0000-0000-000000000000`,
        {
          headers: {
            host: "harness.remote.test",
            "sec-fetch-site": "cross-site",
            authorization: `Bearer ${token}`,
          },
        },
      );
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: "local_origin_required" });
      const endpoint = new URL(origin);
      const absolute = await new Promise<{ status: number; body: string }>(
        (resolve, reject) => {
          const request = httpRequest(
            {
              hostname: endpoint.hostname,
              port: Number(endpoint.port),
              method: "GET",
              path: "http://harness.remote.test/api/sessions/00000000-0000-0000-0000-000000000000/images/00000000-0000-0000-0000-000000000000",
              headers: {
                host: "harness.remote.test",
                "sec-fetch-site": "cross-site",
                authorization: `Bearer ${token}`,
              },
            },
            (response) => {
              let body = "";
              response.setEncoding("utf8");
              response.on("data", (chunk) => { body += chunk; });
              response.on("end", () =>
                resolve({ status: response.statusCode ?? 0, body }),
              );
            },
          );
          request.on("error", reject);
          request.end();
        },
      );
      assert.equal(absolute.status, 403, absolute.body);
      assert.deepEqual(JSON.parse(absolute.body), { error: "local_origin_required" });
      const local = await fetch(
        `${origin}/api/sessions/00000000-0000-0000-0000-000000000000/images/00000000-0000-0000-0000-000000000000`,
      );
      assert.equal(local.status, 404);
      assert.deepEqual(await local.json(), { error: "session_image_not_found" });
    },
    { env: { NOMO_CONTROL_TOKEN: token } },
  );
});

describe("control plane API", () => {
  test("serves built assets on every host and refuses Windows path separators", async () => {
    const dir = await mkdtemp(join(tmpdir(), "void-built-assets-"));
    const webRoot = join(dir, "web");
    await mkdir(join(webRoot, "assets"), { recursive: true });
    await writeFile(join(webRoot, "index.html"), '<script src="/assets/app-123.js"></script>');
    await writeFile(join(webRoot, "assets", "app-123.js"), 'console.log("fixture")');
    await writeFile(join(webRoot, "assets", "app-123.css"), 'body{color:red}');
    const handle = await listenControlPlane({ webRoot, env: { VOID_DATA_DIR: join(dir, "data") } });
    try {
      const origin = `http://127.0.0.1:${handle.port}`;
      for (const [path, mime] of [["/", "text/html"], ["/chat/new", "text/html"],
        ["/project-workspace", "text/html"],
        ["/assets/app-123.js", "application/javascript"], ["/assets/app-123.css", "text/css"]]) {
        const response = await fetch(origin + path);
        assert.equal(response.status, 200, path);
        assert.ok(response.headers.get("content-type")?.startsWith(mime), path);
      }
      for (const path of ["/assets%5capp-123.js", "/assets/%5c..%5cindex.html", "/assets/app-123.js%00"])
        assert.equal((await fetch(origin + path)).status, 404, path);
    } finally { await handle.close(); await rm(dir, { recursive: true, force: true }); }
  });
  test("reports local agents and unavailable cloud-only surfaces without 404s", async () => {
    await withServer("unused.jsonl", async (origin) => {
      const expected = new Map<string, unknown>([
        ["/api/integrations", { supported: false, integrations: [] }],
        ["/api/demo/status", { supported: false, available: false }],
      ]);
      for (const [path, body] of expected) {
        const response = await fetch(origin + path);
        assert.equal(response.status, 200, path);
        assert.deepEqual(await response.json(), body, path);
      }
      const agents = await (await fetch(origin + "/api/agents")).json() as { supported: boolean; agents: { id: string }[] };
      assert.equal(agents.supported, true);
      assert.ok(agents.agents.some(agent => agent.id === "reviewer"));
      assert.equal(
        (await fetch(origin + "/api/integrations", { method: "POST" })).status,
        404,
      );
    });
  });
  test("OpenAI ChatGPT account routes reject nonlocal Host requests even with the control token", async () => {
    const data = await mkdtemp(join(tmpdir(), "nomo-siwc-api-boundary-data-"));
    const auth = await mkdtemp(join(tmpdir(), "nomo-siwc-api-boundary-auth-"));
    const workbench = new Workbench(
      { NOMO_DATA_DIR: data },
      fetch,
      { openAIChatGPTAuthStore: new OpenAIChatGPTAuthStore(auth) },
    );
    try {
      await withServer("unused.jsonl", async origin => {
        const endpoint = new URL(origin);
        const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
          const request = httpRequest({
            hostname: endpoint.hostname,
            port: Number(endpoint.port),
            method: "POST",
            path: "/api/provider/openai-chatgpt/auth",
            headers: {
              host: "remote.example",
              authorization: "Bearer fixture-control-token",
              "content-type": "application/json",
            },
          }, result => {
            let body = "";
            result.setEncoding("utf8");
            result.on("data", chunk => { body += chunk; });
            result.on("end", () => resolve({ status: result.statusCode ?? 0, body }));
          });
          request.on("error", reject);
          request.end("{}");
        });
        assert.equal(response.status, 403, response.body);
        assert.deepEqual(JSON.parse(response.body), { error: "local_origin_required" });
        assert.deepEqual(workbench.openAIChatGPTAccounts(), []);
      }, {
        workbench,
        env: { NOMO_CONTROL_TOKEN: "fixture-control-token" },
      });
    } finally {
      await rm(data, { recursive: true, force: true });
      await rm(auth, { recursive: true, force: true });
    }
  });

  test("OpenAI ChatGPT auth API returns a one-shot URL without account hints and tracks consent decline", async () => {
    const data = await mkdtemp(join(tmpdir(), "nomo-siwc-api-data-"));
    const auth = await mkdtemp(join(tmpdir(), "nomo-siwc-api-auth-"));
    const workbench = new Workbench(
      { NOMO_DATA_DIR: data },
      fetch,
      { openAIChatGPTAuthStore: new OpenAIChatGPTAuthStore(auth) },
    );
    try {
      await withServer("unused.jsonl", async origin => {
        const accountsResponse = await fetch(`${origin}/api/provider/openai-chatgpt`);
        assert.equal(accountsResponse.status, 200);
        assert.deepEqual(await accountsResponse.json(), { accounts: [] });

        const started = await fetch(`${origin}/api/provider/openai-chatgpt/auth`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        assert.equal(started.status, 201);
        const attempt = await started.json() as { id: string; authorizationUrl: string };
        const authorization = new URL(attempt.authorizationUrl);
        assert.equal(authorization.searchParams.has("id_token_hint"), false);
        assert.equal(authorization.searchParams.has("login_hint"), false);
        const callback = new URL(authorization.searchParams.get("redirect_uri")!);
        callback.searchParams.set("state", authorization.searchParams.get("state")!);
        callback.searchParams.set("error", "access_denied");
        assert.equal((await fetch(callback)).status, 200);
        const status = await fetch(`${origin}/api/provider/openai-chatgpt/auth/${attempt.id}`);
        assert.equal(status.status, 200);
        assert.equal((await status.json() as { status: string }).status, "declined");
      }, { workbench });
    } finally {
      await rm(data, { recursive: true, force: true });
      await rm(auth, { recursive: true, force: true });
    }
  });

  test("provider API exposes per-API availability reasons through the existing read endpoint", async () => {
    await withServer("unused.jsonl", async (origin) => {
      const response = await fetch(origin + "/api/provider");
      assert.equal(response.status, 200);
      const expected = PROVIDER_MODEL_MANIFEST.apiTransports
        .filter(item => item.status !== "implemented")
        .map(item => ({ ...item, disabled: true }));
      const state = await response.json() as {
        unavailableProviders: typeof expected;
        unavailableModelTransports: Array<{
          source: string;
          providerId: string;
          transportId: string;
          status: string;
          modelIds: string[];
          disabled: boolean;
        }>;
        unavailableProviderModels?: Array<{
          source: string;
          providerId: string;
          transportId: string;
          status: string;
          modelIds: string[];
          reason: string;
          evidence: string;
          disabled: boolean;
        }>;
      };
      assert.deepEqual(state.unavailableProviders, expected);
      const unavailableModels = state.unavailableModelTransports;
      assert.deepEqual(
        unavailableModels?.map(({ source, providerId, transportId, status, modelIds, disabled }) =>
          [source, providerId, transportId, status, modelIds, disabled],
        ),
        [[
          "omp",
          "local",
          "local-inference",
          "blocked",
          [
            "falcon-h1-90m",
            "gemma-3-1b",
            "lfm2-1.2b",
            "lfm2.5-230m",
            "lfm2.5-350m",
            "llama3.2:3b",
            "qwen2.5-1.5b",
            "qwen3-1.7b",
          ],
          true,
        ]],
      );
      const blockedModelGroups = state.unavailableProviderModels;
      assert.deepEqual(
        blockedModelGroups
          ?.map(
            ({ source, providerId, transportId, status, modelIds, disabled }) =>
              `${source}:${providerId}/${transportId}:${status}:${modelIds.length}:${disabled}`,
          )
          .sort(),
        [
          "omp:google-vertex/anthropic-messages:blocked:13:true",
          "omp:google-vertex/openai-completions:blocked:7:true",
          "omp:kimi-code/openai-completions:blocked:3:true",
          "omp:muse-code/openai-responses:blocked:5:true",
        ].sort(),
      );
      assert.equal(
        blockedModelGroups?.reduce(
          (sum, group) => sum + group.modelIds.length,
          0,
        ),
        28,
      );
      assert.ok(
        blockedModelGroups?.every(group => group.reason.length > 0 && group.evidence.length > 0),
      );
      for (const apiId of [
        "cursor-agent", "factory-droid-agent", "gitlab-duo-agent",
        "devin-agent", "apple-foundation-models", "openai-codex-responses",
      ]) {
        assert.ok(
          state.unavailableProviders.some(item => item.apiId === apiId && item.disabled),
          `${apiId} is explicitly unavailable in the real provider-state response`,
        );
      }
    }, { env: { NVIDIA_API_KEY: "", DASHSCOPE_API_KEY: "" } });
  });
  test("provider status stays passive until the environment check is requested", async () => {
    const directory = await mkdtemp(join(tmpdir(), "void-provider-probe-api-"));
    const requests: string[] = [];
    const workbench = new Workbench(
      {
        NOMO_DATA_DIR: directory,
        NVIDIA_API_KEY: "fixture-provider-key",
        DASHSCOPE_API_KEY: "",
      },
      async (input) => {
        requests.push(String(input));
        return Response.json({ data: [{ id: "fixture-model" }] });
      },
    );
    let workbenchClosed = false;
    try {
      await withServer("unused.jsonl", async (origin) => {
        const passive = await fetch(origin + "/api/provider");
        assert.equal(passive.status, 200);
        const passiveBody = await passive.text();
        assert.doesNotMatch(passiveBody, /fixture-provider-key/);
        const status = JSON.parse(passiveBody) as {
          connected: boolean;
          status: string;
          detail: string | null;
          environmentProbePending: boolean;
        };
        assert.equal(status.connected, false);
        assert.equal(status.status, "unavailable");
        assert.equal(status.detail, "Environment provider has not been checked.");
        assert.equal(status.environmentProbePending, true);
        assert.equal(requests.length, 0);

        const wrongMethod = await fetch(origin + "/api/provider/probe-environment");
        assert.equal(wrongMethod.status, 405);
        assert.equal(requests.length, 0);

        const checked = await fetch(origin + "/api/provider/probe-environment", {
          method: "POST",
        });
        assert.equal(checked.status, 200);
        const body = await checked.text();
        assert.doesNotMatch(body, /fixture-provider-key/);
        const result = JSON.parse(body) as {
          connected: boolean;
          providerId: string | null;
        };
        assert.equal(result.connected, true);
        assert.equal(result.providerId, "nvidia");
        assert.equal(requests.length, 1);

        const afterCheck = await fetch(origin + "/api/provider");
        assert.equal(afterCheck.status, 200);
        assert.equal((await afterCheck.json() as { connected: boolean }).connected, true);
        assert.equal(requests.length, 1);
      }, { workbench });
      workbench.close();
      workbenchClosed = true;
    } finally {
      if (!workbenchClosed) workbench.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("provider API persists typed manifest descriptors without exposing auth", async () => {
    const directory = await mkdtemp(join(tmpdir(), "void-typed-provider-"));
    const secret = "typed-provider-secret-never-return";
    const calls: string[] = [];
    const env = {
      NOMO_DATA_DIR: directory,
      NVIDIA_API_KEY: "",
      DASHSCOPE_API_KEY: "",
    };
    const request: typeof fetch = async (input) => {
      calls.push(String(input));
      return Response.json({ data: [{ id: "gpt-5.4" }] });
    };
    const workbench = new Workbench(env, request);
    let workbenchClosed = false;
    let restarted: Workbench | undefined;
    try {
      await withServer("unused.jsonl", async (origin) => {
        const connected = await fetch(origin + "/api/provider", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            providerId: "openai",
            transport: "openai-responses",
            endpoint: "https://api.openai.com/v1",
            model: "gpt-5.4",
            auth: { kind: "api-key", apiKey: secret },
          }),
        });
        assert.equal(connected.status, 200);
        assert.doesNotMatch(await connected.text(), /typed-provider-secret-never-return/);

        const response = await fetch(origin + "/api/provider");
        assert.equal(response.status, 200);
        const state = await response.json() as Record<string, unknown>;
        assert.equal(state.connected, true);
        assert.equal(state.providerId, "openai");
        assert.equal(state.transport, "openai-responses");
        assert.equal(state.defaultModel, "gpt-5.4");
        assert.equal(state.authKind, "api-key");
        assert.equal(state.keyStorage, "encrypted-local");
        const descriptors = state.availableProviderDescriptors as
          | { providerId: string; transport: string; authKind: string; endpoint: string | null }[]
          | undefined;
        assert.ok(descriptors?.length);
        const implemented = new Set(
          PROVIDER_MODEL_MANIFEST.apiTransports
            .filter((api) => api.status === "implemented")
            .map((api) => api.apiId),
        );
        assert.ok(descriptors.every((descriptor) => implemented.has(descriptor.transport)));
        assert.ok(
          descriptors.every(
            (descriptor) =>
              ["api-key", "aws-credential-chain", "none"].includes(descriptor.authKind) &&
              (descriptor.endpoint === null || !/[<>{}]/.test(descriptor.endpoint)),
          ),
        );
        assert.ok(
          descriptors.some(
            (descriptor) =>
              descriptor.providerId === "amazon-bedrock" &&
              descriptor.authKind === "aws-credential-chain",
          ),
        );
        assert.ok(
          descriptors.some(
            (descriptor) =>
              descriptor.providerId === "ollama-cloud" &&
              descriptor.transport === "ollama-chat" &&
              descriptor.authKind === "api-key" &&
              descriptor.endpoint === "https://ollama.com",
          ),
        );
        assert.ok(
          descriptors.some(
            (descriptor) =>
              descriptor.providerId === "kimi-code" &&
              descriptor.transport === "openai-completions" &&
              descriptor.authKind === "api-key" &&
              descriptor.endpoint === "https://api.kimi.com/coding/v1",
          ),
        );
        for (const providerId of ["muse-code"]) {
          assert.ok(
            !descriptors.some(
              (descriptor) => descriptor.providerId === providerId,
            ),
            `${providerId} does not satisfy this setup's manifest auth contract`,
          );
        }
        assert.doesNotMatch(JSON.stringify(state), /typed-provider-secret-never-return/);
        const cloudConnected = await fetch(origin + "/api/provider", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            providerId: "ollama-cloud",
            transport: "ollama-chat",
            endpoint: "https://ollama.com",
            model: "gpt-oss:120b",
            auth: { kind: "api-key", apiKey: secret },
          }),
        });
        assert.equal(cloudConnected.status, 200);
        assert.doesNotMatch(await cloudConnected.text(), /typed-provider-secret-never-return/);
        const cloudResponse = await fetch(origin + "/api/provider");
        const cloudState = await cloudResponse.json() as Record<string, unknown>;
        assert.equal(cloudState.providerId, "ollama-cloud");
        assert.equal(cloudState.transport, "ollama-chat");
        assert.equal(cloudState.defaultModel, "gpt-oss:120b");
        assert.equal(cloudState.authKind, "api-key");
        assert.equal(cloudState.keyStorage, "encrypted-local");
        assert.doesNotMatch(JSON.stringify(cloudState), /typed-provider-secret-never-return/);
        const invalidBodies = [
          { providerId: "openai", transport: "openai-responses", endpoint: "https://api.openai.com/v1", model: "unknown-model", auth: { kind: "api-key", apiKey: secret } },
          { providerId: "openai", transport: "openai-responses", endpoint: "https://api.openai.com/v1", model: "gpt-5.4", auth: { kind: "none" } },
          { providerId: "openai", transport: "openai-responses", endpoint: "https://api.openai.com/v1", model: "gpt-5.4", auth: { kind: "api-key", apiKey: secret, unexpected: true } },
          { providerId: "azure", transport: "azure-openai-responses", endpoint: "https://attacker.example", model: "gpt-4o", auth: { kind: "api-key", apiKey: secret } },
          { providerId: "amazon-bedrock", transport: "bedrock-converse-stream", endpoint: "https://bedrock-runtime.us-west-2.amazonaws.com/", model: "amazon.nova-2-lite-v1:0", auth: { kind: "aws-credentials", accessKeyId: secret, secretAccessKey: secret } },
          { providerId: "ollama-cloud", transport: "ollama-chat", endpoint: "https://ollama.com", model: "nemotron-3-ultra", auth: { kind: "none" } },
        ];
        for (const invalidBody of invalidBodies) {
          const rejected = await fetch(origin + "/api/provider", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(invalidBody),
          });
          assert.equal(rejected.status, 400);
          assert.doesNotMatch(await rejected.text(), /typed-provider-secret-never-return/);
        }
        const retained = await fetch(origin + "/api/provider");
        const retainedState = await retained.json() as Record<string, unknown>;
        assert.equal(retainedState.providerId, "ollama-cloud");
        assert.equal(retainedState.defaultModel, "gpt-oss:120b");
        assert.equal(retainedState.transport, "ollama-chat");
        assert.deepEqual(calls, ["https://api.openai.com/v1/models"]);
      }, { workbench });

      const encrypted = await readFile(join(directory, "workspace.enc"));
      assert.equal(encrypted.includes(Buffer.from(secret)), false);
      workbench.close();
      workbenchClosed = true;
      restarted = new Workbench(env, async () => {
        throw new Error("restart must not make a provider request");
      });
      const state = await restarted.providerState();
      assert.equal(state.connected, true);
      assert.equal(state.providerId, "ollama-cloud");
      assert.equal(state.transport, "ollama-chat");
      assert.equal(state.defaultModel, "gpt-oss:120b");
    } finally {
      if (!workbenchClosed) workbench.close();
      restarted?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  test("provider API uses the Bedrock host credential chain without exposing credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "void-bedrock-chain-"));
    let credentialCalls = 0;
    let providerRequests = 0;
    let credentialChainAvailable = false;
    const awsCredentialProvider = async () => {
      credentialCalls += 1;
      if (!credentialChainAvailable) throw new Error("SYNTHETIC_CHAIN_ERROR");
      return {
        accessKeyId: "SYNTHETIC_ACCESS_KEY",
        secretAccessKey: "SYNTHETIC_SECRET_KEY",
        sessionToken: "SYNTHETIC_SESSION_TOKEN",
      };
    };
    const env = {
      NOMO_DATA_DIR: directory,
      NVIDIA_API_KEY: "",
      DASHSCOPE_API_KEY: "",
    };
    const workbench = new Workbench(
      env,
      async () => {
        providerRequests += 1;
        return Response.json({ data: [{ id: "gpt-5.4" }] });
      },
      {},
      { awsCredentialProvider },
    );
    let workbenchClosed = false;
    let restarted: Workbench | undefined;
    try {
      await workbench.configure({
        baseUrl: "https://fixture.test/v1",
        apiKey: "fixture-openai",
        model: "gpt-5.4",
      });
      await withServer(
        "unused.jsonl",
        async (origin) => {
          const bedrockConfiguration = {
            providerId: "amazon-bedrock",
            transport: "bedrock-converse-stream",
            endpoint: "https://bedrock-runtime.us-west-2.amazonaws.com/",
            model: "amazon.nova-2-lite-v1:0",
            auth: { kind: "aws-credential-chain" },
          };
          const rejected = await fetch(origin + "/api/provider", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(bedrockConfiguration),
          });
          const rejectionBody = await rejected.text();
          assert.equal(rejected.status, 400);
          assert.doesNotMatch(
            rejectionBody,
            /SYNTHETIC_CHAIN_ERROR|SYNTHETIC_(ACCESS_KEY|SECRET_KEY|SESSION_TOKEN)/,
          );
          const previous = await fetch(origin + "/api/provider");
          const previousState = await previous.json() as Record<string, unknown>;
          assert.equal(previousState.connected, true);
          assert.equal(previousState.baseUrl, "https://fixture.test/v1");
          assert.equal(previousState.defaultModel, "gpt-5.4");
          credentialChainAvailable = true;
          const connected = await fetch(origin + "/api/provider", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(bedrockConfiguration),
          });
          const connectedBody = await connected.text();
          assert.equal(connected.status, 200);
          assert.doesNotMatch(
            connectedBody,
            /SYNTHETIC_(ACCESS_KEY|SECRET_KEY|SESSION_TOKEN)|accessKeyId|secretAccessKey|sessionToken/,
          );
          const response = await fetch(origin + "/api/provider");
          assert.equal(response.status, 200);
          const state = await response.json() as Record<string, unknown>;
          assert.equal(state.connected, true);
          assert.equal(state.providerId, "amazon-bedrock");
          assert.equal(state.transport, "bedrock-converse-stream");
          assert.equal(state.authKind, "aws-credential-chain");
          assert.equal(state.defaultModel, "amazon.nova-2-lite-v1:0");
          assert.doesNotMatch(
            JSON.stringify(state),
            /SYNTHETIC_(ACCESS_KEY|SECRET_KEY|SESSION_TOKEN)|accessKeyId|secretAccessKey|sessionToken/,
          );
          const staticKeys = await fetch(origin + "/api/provider", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              providerId: "amazon-bedrock",
              transport: "bedrock-converse-stream",
              endpoint: "https://bedrock-runtime.us-west-2.amazonaws.com/",
              model: "amazon.nova-2-lite-v1:0",
              auth: {
                kind: "aws-credentials",
                accessKeyId: "SYNTHETIC_ACCESS_KEY",
                secretAccessKey: "SYNTHETIC_SECRET_KEY",
              },
            }),
          });
          assert.equal(staticKeys.status, 400);
          const retained = await fetch(origin + "/api/provider");
          const retainedState = await retained.json() as Record<string, unknown>;
          assert.equal(retainedState.providerId, "amazon-bedrock");
          assert.equal(retainedState.authKind, "aws-credential-chain");
          assert.equal(credentialCalls, 2);
          assert.equal(providerRequests, 1);
        },
        { workbench },
      );
      const encrypted = await readFile(join(directory, "workspace.enc"));
      for (const secret of [
        "SYNTHETIC_ACCESS_KEY",
        "SYNTHETIC_SECRET_KEY",
        "SYNTHETIC_SESSION_TOKEN",
      ]) {
        assert.equal(encrypted.includes(Buffer.from(secret)), false);
      }
      workbench.close();
      workbenchClosed = true;
      restarted = new Workbench(env, async () => {
        throw new Error("Restoring a credential-chain profile must not request the provider.");
      }, {}, { awsCredentialProvider });
      const restored = await restarted.providerState();
      assert.equal(restored.connected, true);
      assert.equal(restored.authKind, "aws-credential-chain");
      assert.equal(credentialCalls, 2);
    } finally {
      if (!workbenchClosed) workbench.close();
      restarted?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  test("provider API configures Standard Vertex without leaking its key and restores encrypted config", async () => {
    const directory = await mkdtemp(join(tmpdir(), "void-vertex-provider-"));
    const secret = "vertex-fixture-secret-never-return";
    const calls: string[] = [];
    const env = {
      NOMO_DATA_DIR: directory,
      NVIDIA_API_KEY: "",
      DASHSCOPE_API_KEY: "",
    };
    const request: typeof fetch = async (input) => {
      calls.push(String(input));
      throw new Error("Vertex setup must use the pinned catalog without provider requests.");
    };
    const workbench = new Workbench(env, request);
    let workbenchClosed = false;
    let restarted: Workbench | undefined;
    const descriptor = {
      providerId: "google-vertex",
      transport: "google-vertex",
      vertexOptions: {
        mode: "standard",
        projectId: "nomo-test-12345",
        location: "us-central1",
      },
      model: "gemini-2.5-flash",
      auth: { kind: "api-key", apiKey: secret },
    };
    try {
      await withServer("unused.jsonl", async (origin) => {
        const connected = await fetch(origin + "/api/provider", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(descriptor),
        });
        assert.equal(connected.status, 200);
        assert.doesNotMatch(await connected.text(), /vertex-fixture-secret-never-return/);

        const response = await fetch(origin + "/api/provider");
        assert.equal(response.status, 200);
        const state = await response.json() as Record<string, unknown>;
        assert.equal(state.connected, true);
        assert.equal(state.providerId, "google-vertex");
        assert.equal(state.transport, "google-vertex");
        assert.equal(state.defaultModel, "gemini-2.5-flash");
        assert.equal(state.keyStorage, "encrypted-local");
        assert.deepEqual(state.vertexOptions, descriptor.vertexOptions);
        assert.doesNotMatch(JSON.stringify(state), /vertex-fixture-secret-never-return/);

        for (const vertexOptions of [
          { ...descriptor.vertexOptions, projectId: "bad" },
          { ...descriptor.vertexOptions, location: "us-central1/attacker" },
          { ...descriptor.vertexOptions, extra: true },
        ]) {
          const rejected = await fetch(origin + "/api/provider", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...descriptor, vertexOptions }),
          });
          assert.equal(rejected.status, 400);
          assert.doesNotMatch(await rejected.text(), /vertex-fixture-secret-never-return/);
        }
        const retained = await (await fetch(origin + "/api/provider")).json() as Record<string, unknown>;
        assert.equal(retained.providerId, "google-vertex");
        assert.deepEqual(retained.vertexOptions, descriptor.vertexOptions);
        assert.deepEqual(calls, []);
      }, { workbench });

      const encrypted = await readFile(join(directory, "workspace.enc"));
      assert.equal(encrypted.includes(Buffer.from(secret)), false);
      workbench.close();
      workbenchClosed = true;
      restarted = new Workbench(env, async () => {
        throw new Error("restoring Vertex config must not make a provider request");
      });
      const state = await restarted.providerState();
      assert.equal(state.connected, true);
      assert.equal(state.providerId, "google-vertex");
      assert.deepEqual(state.vertexOptions, descriptor.vertexOptions);
      assert.deepEqual(calls, []);
    } finally {
      if (!workbenchClosed) workbench.close();
      restarted?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  test("provider API accepts regional Bedrock Mantle Responses without leaking its key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nomo-mantle-provider-"));
    const secret = "mantle-fixture-secret-never-return";
    const endpoint = "https://bedrock-mantle.us-east-1.api.aws/openai/v1";
    const calls: Array<{ url: string; authorization: string }> = [];
    const env = {
      NOMO_DATA_DIR: directory,
      NVIDIA_API_KEY: "",
      DASHSCOPE_API_KEY: "",
    };
    const request: typeof fetch = async (input, init) => {
      calls.push({
        url: String(input instanceof Request ? input.url : input),
        authorization: new Headers(init?.headers).get("authorization") ?? "",
      });
      return Response.json({ data: [{ id: "openai.gpt-5.6-terra" }] });
    };
    const workbench = new Workbench(env, request);
    try {
      await withServer("unused.jsonl", async (origin) => {
        const descriptor = {
          providerId: "bedrock-mantle",
          transport: "openai-responses",
          endpoint,
          model: "openai.gpt-5.6-terra",
          auth: { kind: "api-key", apiKey: secret },
        };
        const connected = await fetch(origin + "/api/provider", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(descriptor),
        });
        assert.equal(connected.status, 200);
        assert.doesNotMatch(await connected.text(), /mantle-fixture-secret-never-return/);

        const state = await (await fetch(origin + "/api/provider")).json() as Record<string, unknown>;
        assert.equal(state.connected, true);
        assert.equal(state.providerId, "bedrock-mantle");
        assert.equal(state.transport, "openai-responses");
        assert.equal(state.defaultModel, "openai.gpt-5.6-terra");
        assert.equal(state.authKind, "api-key");
        assert.equal(state.keyStorage, "encrypted-local");
        assert.doesNotMatch(JSON.stringify(state), /mantle-fixture-secret-never-return/);

        for (const invalidEndpoint of [
          "https://bedrock-mantle.attacker.test/openai/v1",
          "https://bedrock-mantle.us-east-1.api.aws/v1",
          "https://bedrock-mantle.us-east-1.api.aws/openai/v1?x=1",
        ]) {
          const rejected = await fetch(origin + "/api/provider", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...descriptor, endpoint: invalidEndpoint }),
          });
          assert.equal(rejected.status, 400, invalidEndpoint);
        }
      }, { workbench });
      assert.deepEqual(calls, [{
        url: `${endpoint}/models`,
        authorization: `Bearer ${secret}`,
      }]);
      const encrypted = await readFile(join(directory, "workspace.enc"));
      assert.equal(encrypted.includes(Buffer.from(secret)), false);
    } finally {
      workbench.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  test("provider API accepts Mantle host credentials without probing credentials or the endpoint", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nomo-mantle-chain-provider-"));
    let credentialCalls = 0;
    let providerRequests = 0;
    const env = {
      NOMO_DATA_DIR: directory,
      NVIDIA_API_KEY: "",
      DASHSCOPE_API_KEY: "",
    };
    const workbench = new Workbench(env, async () => {
      providerRequests++;
      throw new Error("provider request must not run while reading provider state");
    }, {}, {
      awsCredentialProvider: async () => {
        credentialCalls++;
        return {
          accessKeyId: "SYNTHETIC_ACCESS_KEY",
          secretAccessKey: "SYNTHETIC_SECRET_KEY",
          sessionToken: "SYNTHETIC_SESSION_TOKEN",
        };
      },
    });
    try {
      await withServer("unused.jsonl", async origin => {
        const descriptor = {
          providerId: "bedrock-mantle",
          transport: "openai-responses",
          endpoint: "https://bedrock-mantle.us-east-1.api.aws/openai/v1",
          model: "openai.gpt-5.4",
          auth: { kind: "aws-credential-chain" },
        };
        const configured = await fetch(origin + "/api/provider", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(descriptor),
        });
        assert.equal(configured.status, 200);
        assert.doesNotMatch(await configured.text(), /SYNTHETIC_(ACCESS_KEY|SECRET_KEY|SESSION_TOKEN)/);

        const state = await (await fetch(origin + "/api/provider")).json() as Record<string, unknown>;
        assert.equal(state.connected, true);
        assert.equal(state.providerId, "bedrock-mantle");
        assert.equal(state.transport, "openai-responses");
        assert.equal(state.defaultModel, "openai.gpt-5.4");
        assert.equal(state.authKind, "aws-credential-chain");
        assert.doesNotMatch(JSON.stringify(state), /SYNTHETIC_(ACCESS_KEY|SECRET_KEY|SESSION_TOKEN)/);
      }, { workbench });
      assert.equal(credentialCalls, 0);
      assert.equal(providerRequests, 0);
    } finally {
      workbench.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("provider API configures manifest-backed Cloudflare Gateway routes without probing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nomo-cloudflare-provider-"));
    const secret = "cloudflare-fixture-secret-never-return";
    let providerRequests = 0;
    const env = {
      NOMO_DATA_DIR: directory,
      NVIDIA_API_KEY: "",
      DASHSCOPE_API_KEY: "",
    };
    const request: typeof fetch = async () => {
      providerRequests++;
      throw new Error("Cloudflare setup must not probe provider catalogs.");
    };
    const workbench = new Workbench(env, request);
    const routes = {
      "anthropic-messages": "anthropic",
      "openai-completions": "compat",
      "openai-responses": "openai",
    } as const;
    try {
      await withServer("unused.jsonl", async (origin) => {
        for (const descriptor of CONFIGURABLE_PROVIDER_DESCRIPTORS.filter(
          (item) => item.providerId === "cloudflare-ai-gateway",
        )) {
          const route = routes[descriptor.transport as keyof typeof routes];
          assert.ok(route);
          const config = {
            providerId: descriptor.providerId,
            transport: descriptor.transport,
            endpoint: `https://gateway.ai.cloudflare.com/v1/account-id/default/${route}`,
            model: descriptor.model,
            auth: { kind: "api-key", apiKey: secret },
          };
          const connected = await fetch(origin + "/api/provider", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(config),
          });
          assert.equal(connected.status, 200);
          assert.doesNotMatch(await connected.text(), /cloudflare-fixture-secret-never-return/);

          const state = await (await fetch(origin + "/api/provider")).json() as Record<string, unknown>;
          assert.equal(state.connected, true);
          assert.equal(state.providerId, descriptor.providerId);
          assert.equal(state.transport, descriptor.transport);
          assert.equal(state.defaultModel, descriptor.model);
          assert.equal(state.authKind, "api-key");
          assert.equal(state.keyStorage, "encrypted-local");
          assert.doesNotMatch(JSON.stringify(state), /cloudflare-fixture-secret-never-return/);

          const rejected = await fetch(origin + "/api/provider", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              ...config,
              endpoint: `https://gateway.ai.cloudflare.com/v1/account-id/default/wrong`,
            }),
          });
          assert.equal(rejected.status, 400);
          assert.doesNotMatch(await rejected.text(), /cloudflare-fixture-secret-never-return/);
        }
      }, { workbench });
      assert.equal(providerRequests, 0);
      const encrypted = await readFile(join(directory, "workspace.enc"));
      assert.equal(encrypted.includes(Buffer.from(secret)), false);
    } finally {
      workbench.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("provider API configures Cloudflare Workers AI with its account-scoped route without discovery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nomo-cloudflare-workers-ai-"));
    const secret = "cloudflare-workers-fixture-secret-never-return";
    const accountId = "a".repeat(32);
    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`;
    let providerRequests = 0;
    const env = {
      NOMO_DATA_DIR: directory,
      NVIDIA_API_KEY: "",
      DASHSCOPE_API_KEY: "",
    };
    const workbench = new Workbench(env, async () => {
      providerRequests++;
      throw new Error("Workers AI setup must not probe a model catalog.");
    });
    const model = "@cf/deepseek-ai/deepseek-v4-flash-0731";
    const config = {
      providerId: "cloudflare-workers-ai",
      transport: "openai-completions",
      endpoint,
      model,
      auth: { kind: "api-key", apiKey: secret },
    };
    try {
      await withServer("unused.jsonl", async (origin) => {
        const connected = await fetch(origin + "/api/provider", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(config),
        });
        assert.equal(connected.status, 200);
        assert.doesNotMatch(await connected.text(), /cloudflare-workers-fixture-secret-never-return/);

        const state = await (await fetch(origin + "/api/provider")).json() as Record<string, unknown>;
        assert.equal(state.connected, true);
        assert.equal(state.providerId, "cloudflare-workers-ai");
        assert.equal(state.transport, "openai-completions");
        assert.equal(state.defaultModel, model);
        assert.equal(state.authKind, "api-key");
        assert.equal(state.keyStorage, "encrypted-local");
        assert.doesNotMatch(JSON.stringify(state), /cloudflare-workers-fixture-secret-never-return/);

        for (const invalidEndpoint of [
          `https://attacker.example/client/v4/accounts/${accountId}/ai/v1`,
          `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1?x=1`,
          `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/extra`,
          `https://api.cloudflare.com/client/v4/accounts/${accountId}%2Fother/ai/v1`,
        ]) {
          const rejected = await fetch(origin + "/api/provider", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...config, endpoint: invalidEndpoint }),
          });
          assert.equal(rejected.status, 400, invalidEndpoint);
          assert.doesNotMatch(await rejected.text(), /cloudflare-workers-fixture-secret-never-return/);
        }
      }, { workbench });
      assert.equal(providerRequests, 0);
      const encrypted = await readFile(join(directory, "workspace.enc"));
      assert.equal(encrypted.includes(Buffer.from(secret)), false);
    } finally {
      workbench.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  test("manifest descriptor validation confines Azure endpoints and rejects unsupported Bedrock auth", () => {
    const descriptor: ProviderAdapterConfig = {
      providerId: "azure",
      transport: "azure-openai-responses",
      baseUrl: "https://attacker.example",
      model: "gpt-4o",
      auth: { kind: "api-key", apiKey: "fixture-only" },
    };
    assert.throws(
      () => assertProviderDescriptorInManifest(descriptor),
      /endpoint/,
    );
    assert.doesNotThrow(() =>
      assertProviderDescriptorInManifest({
        ...descriptor,
        baseUrl: "https://fixture-resource.openai.azure.com/openai/v1",
      }),
    );
    const bedrock: ProviderAdapterConfig = {
      providerId: "amazon-bedrock",
      transport: "bedrock-converse-stream",
      baseUrl: "https://bedrock-runtime.us-west-2.amazonaws.com/",
      model: "amazon.nova-2-lite-v1:0",
      auth: { kind: "none" },
    };
    assert.throws(
      () => assertProviderDescriptorInManifest(bedrock),
      /requires aws-credential-chain authentication/,
    );
  });

  test("rejects direct provider hosts before an upstream request", async () => {
    await withServer("unused.jsonl", async (origin) => {
      for (const baseUrl of ["https://api.openai.com/v1", "https://sandbox.api.openai.com./v1"]) {
        const response = await fetch(origin + "/api/provider", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ baseUrl, apiKey: "smoke-key", kind: "compatible" }),
        });
        assert.equal(response.status, 400, baseUrl);
        assert.deepEqual(await response.json(), {
          error: "provider_unavailable",
          message: "Direct OpenAI provider URLs are not supported.",
        });
      }
    });
  });

  test("returns a limited ledger feed with verified chain fields", async () => {
    const ledgerPath = await seedLedger(2);
    await withServer(ledgerPath, async (origin) => {
      const response = await fetch(`${origin}/api/feed?workspace=default&limit=1`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
      const body = await response.json() as { entries: Array<Record<string, unknown>>; verified: boolean; signed: boolean };
      assert.equal(body.verified, false);
      assert.equal(body.signed, false);
      assert.equal(body.entries.length, 1);
      assert.deepEqual(Object.keys(body.entries[0]!).sort(), [
        "argsDigest",
        "at",
        "decision",
        "digest",
        "hash",
        "klass",
        "prev_hash",
        "seq",
        "tool",
        "workspace",
      ].sort());
      assert.equal(body.entries[0]!["seq"], 2);
      assert.equal(body.entries[0]!["hash"], body.entries[0]!["digest"]);
    });
  });

  test("returns an explicit empty feed when no ledger exists yet", async () => {
    const dir = await mkdtemp(join(tmpdir(), "void-control-plane-api-empty-"));
    try {
      await withServer(join(dir, "default.jsonl"), async (origin) => {
        // The ledger file was never created, so this is a fresh workspace.
        // An empty ledger is a valid state, not a failed request: the feed
        // keeps its page shape and reports zero checked records.
        const response = await fetch(`${origin}/api/feed?workspace=default`);
        assert.equal(response.status, 200);
        const body = await response.json() as { entries: unknown[]; items: unknown[]; verified: boolean; signed: boolean; integrity: boolean; checked: number };
        assert.deepEqual(body.entries, []);
        assert.deepEqual(body.items, []);
        assert.equal(body.verified, false);
        assert.equal(body.signed, false);
        assert.equal(body.integrity, false);
        assert.equal(body.checked, 0);
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reports chain verification status", async () => {
    const ledgerPath = await seedLedger(3);
    await withServer(ledgerPath, async (origin) => {
      const response = await fetch(`${origin}/api/ledger/verify`);
      assert.equal(response.status, 200);
      const body = await response.json() as { ok: boolean; verified: boolean; integrity: boolean; signed: boolean; checked: number; head: string };
      assert.equal(body.ok, true);
      // Without a configured key the server has checked the hash chain, and
      // it must not claim that as authenticated verification.
      assert.equal(body.verified, false);
      assert.equal(body.integrity, true);
      assert.equal(body.signed, false);
      assert.equal(body.checked, 3);
      assert.match(body.head, /^[0-9a-f]{64}$/);
    });
  });

  test("verifies signatures when the signing key is in the environment", async () => {
    const ledgerPath = await seedLedger(2);
    const keyMaterial = await readFile(join(dirname(ledgerPath), "keys", "dev-ed25519.pkcs8"));
    await withServer(ledgerPath, async (origin) => {
      const feedResponse = await fetch(`${origin}/api/feed?workspace=default`);
      assert.equal(feedResponse.status, 200);
      const feedBody = await feedResponse.json() as { verified: boolean; signed: boolean };
      assert.equal(feedBody.verified, true);
      assert.equal(feedBody.signed, true);
      const verifyResponse = await fetch(`${origin}/api/ledger/verify`);
      const verifyBody = await verifyResponse.json() as { ok: boolean; verified: boolean; integrity: boolean; signed: boolean };
      assert.equal(verifyBody.ok, true);
      assert.equal(verifyBody.verified, true);
      assert.equal(verifyBody.integrity, true);
      assert.equal(verifyBody.signed, true);
    }, { env: { VOID_SIGNING_KEY: keyMaterial.toString("base64") } });
  });

  test("a rewritten and rehashed ledger fails verification when a key is configured", async () => {
    // The S08 attack: rewrite an entry, recompute the whole hash chain so
    // chain integrity alone sees nothing wrong, and keep the original
    // signature bytes on the forged entry. Only signature checking can see
    // this, which is why verified means signed, not just chained.
    const ledgerPath = await seedLedger(2);
    const lines = (await readFile(ledgerPath, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const forged = JSON.parse(JSON.stringify(lines[1]!)) as Record<string, unknown>;
    (forged["body"] as Record<string, unknown>)["tool"] = "aws.s3.object.put";
    let prev = String(lines[0]!["hash"]);
    forged["prev_hash"] = prev;
    forged["hash"] = await entryHash(forged["body"], prev, sha256Hex);
    const keyMaterial = await readFile(join(dirname(ledgerPath), "keys", "dev-ed25519.pkcs8"));
    await writeFile(ledgerPath, `${JSON.stringify(lines[0])}\n${JSON.stringify(forged)}\n`);
    await withServer(ledgerPath, async (origin) => {
      const response = await fetch(`${origin}/api/ledger/verify`);
      const body = await response.json() as { ok: boolean; verified: boolean; reason?: string };
      assert.equal(body.ok, false);
      assert.equal(body.verified, false);
      assert.match(body.reason ?? "", /signature/);
    }, { env: { VOID_SIGNING_KEY: keyMaterial.toString("base64") } });
    // Without a key the same forged file reports integrity only, and the
    // response must say verified false rather than pass it as checked.
    await withServer(ledgerPath, async (origin) => {
      const response = await fetch(`${origin}/api/ledger/verify`);
      const body = await response.json() as { ok: boolean; verified: boolean; integrity?: boolean; signed?: boolean };
      assert.equal(body.ok, true);
      assert.equal(body.verified, false);
      assert.equal(body.integrity, true);
      assert.equal(body.signed, false);
    });
  });

  test("serves the control plane pages with html content type", async () => {
    const ledgerPath = await seedLedger(1);
    await withServer(ledgerPath, async (origin) => {
      const response = await fetch(`${origin}/feed.html`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /^text\/html/);
      assert.match(await response.text(), /VOID Call Feed/);
    });
  });

  test("exports complete signed envelopes for offline verification", async () => {
    const ledgerPath = await seedLedger(2);
    await withServer(ledgerPath, async origin => {
      const response = await fetch(`${origin}/api/ledger/export`);
      assert.equal(response.status, 200);
      const body = await response.json() as { format: string; entries: Array<{ signature: string; body: unknown; hash: string }> };
      assert.equal(body.format, 'void.signed-ledger.v1');
      assert.equal(body.entries.length, 2);
      assert.ok(body.entries.every(entry => typeof entry.signature === 'string' && entry.body && /^[a-f0-9]{64}$/.test(entry.hash)));
    });
  });

  test("returns a clear 503 when no ApprovalBroker is wired", async () => {
    const ledgerPath = await seedLedger(1);
    await withServer(ledgerPath, async (origin) => {
      const response = await fetch(`${origin}/api/approvals/hold-1/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "approved", by: "operator" }),
      });
      assert.equal(response.status, 503);
      const body = await response.json() as { error: string };
      assert.equal(body.error, "approvals_not_wired");
    });
  });

  test("rejects decision posts without an application/json content type", async () => {
    // A hostile page cannot send application/json from a form, so the content
    // type check is what keeps cross-site posts off the decision endpoint.
    const ledgerPath = await seedLedger(1);
    const decideCalls: unknown[] = [];
    const approvals = {
      pending: () => [],
      decide: async (holdId: string, decision: unknown) => {
        decideCalls.push({ holdId, decision });
        return { ok: true };
      },
    };
    await withServer(ledgerPath, async (origin) => {
      const response = await fetch(`${origin}/api/approvals/hold-1/decision`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ kind: "approved", by: "attacker" }),
      });
      assert.equal(response.status, 400);
      const body = await response.json() as { error: string };
      assert.equal(body.error, "invalid_decision");
      assert.deepEqual(decideCalls, []);
    }, { approvals: approvals as ApprovalBroker });
  });

  test("uses an injected ApprovalBroker for pending holds and decisions", async () => {
    const ledgerPath = await seedLedger(1);
    const pending: PendingApproval[] = [{
      holdId: "hold-1",
      call: { tool: "postgres.row.delete" },
      expiresAt: "2026-09-08T00:00:00.000Z",
      status: "pending",
    }];
    const decisions: unknown[] = [];
    const approvals: ApprovalBroker = {
      pending: () => pending,
      decide(holdId, decision) {
        decisions.push({ holdId, decision });
        return { status: "approved" };
      },
    };
    await withServer(ledgerPath, async (origin) => {
      const list = await fetch(`${origin}/api/approvals`);
      assert.equal(list.status, 200);
      assert.deepEqual(await list.json(), { approvals: pending });

      const response = await fetch(`${origin}/api/approvals/hold-1/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "approved", by: "operator", reason: "reviewed blast radius" }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true, result: { status: "approved" } });
      assert.deepEqual(decisions, [{
        holdId: "hold-1",
        decision: { kind: "approved", by: "operator", reason: "reviewed blast radius" },
      }]);
    }, { approvals });
  });
});

test("local API rejects rebinding and cross-origin reads and decisions", async () => {
  let decisions = 0;
  await withServer("unused.jsonl", async (origin) => {
    for (const headers of [
      { host: "attacker.example" },
      { origin: "https://attacker.example" },
      { origin: "null" },
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
    ]) {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = httpRequest(`${origin}/api/approvals`, { headers }, (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        });
        req.on("error", reject);
        req.end();
      });
      assert.equal(status, 403, JSON.stringify(headers));
      const writeStatus = await new Promise<number | undefined>((resolve, reject) => {
        const req = httpRequest(`${origin}/api/approvals/h1/decision`, {
          method: "POST", headers: { ...headers, "content-type": "application/json" },
        }, (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        });
        req.on("error", reject);
        req.end(JSON.stringify({ kind: "approved", by: "attacker" }));
      });
      assert.equal(writeStatus, 403, JSON.stringify(headers));
    }
    assert.equal(decisions, 0);
    const allowed = await fetch(`${origin}/api/approvals/h1/decision`, {
      method: "POST", headers: { origin, "sec-fetch-site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify({ kind: "denied", by: "local operator" }),
    });
    assert.equal(allowed.status, 200);
    assert.equal(decisions, 1);
  }, { approvals: { pending: () => [], decide: () => { decisions += 1; } } });
});

test("internal API failures do not echo dependency secrets", async () => {
  await withServer("unused.jsonl", async (origin) => {
    const response = await fetch(`${origin}/api/approvals`);
    assert.equal(response.status, 500);
    assert.doesNotMatch(await response.text(), /SENTINEL_PRIVATE_VALUE/);
  }, { approvals: { pending: () => { throw new Error("SENTINEL_PRIVATE_VALUE"); }, decide: () => {} } });
});

test("fleet events are metadata-only, cursor-paginated and carry this-process scope", async () => {
  await withServer("unused.jsonl", async (origin) => {
    const first = (await fetch(origin + "/api/fleet/events").then((r) => r.json())) as { items: unknown[]; scope: string; stopAck: string };
    assert.deepEqual(first.items, [], "a fresh server has recorded nothing");
    assert.equal(first.scope, "this process only");
    assert.equal(first.stopAck, "unknown");

    const stop = await fetch(origin + "/api/runs/missing-session/stop", { method: "POST" });
    assert.equal(stop.status, 404, "an unknown session is a 404, not an ack");
  });
});

test("a stop records request and acknowledgement and reports the ack state", async () => {
  const fetcher: typeof fetch = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://fixture.test/v1/models")
      return Response.json({ data: [{ id: "fixture-model" }] });
    throw new Error(`fixture fetcher must not be called for ${url}`);
  };
  const workbench = new Workbench(
    { VOID_DATA_DIR: await mkdtemp(join(tmpdir(), "void-fleet-wb-")) },
    fetcher,
  );
  await workbench.configure({ baseUrl: "https://fixture.test/v1", apiKey: "fixture-private-key-never-expose" });
  await withServer("unused.jsonl", async (origin) => {
    // Seed a session through the injected workbench so /stop has a target.
    const start = await fetch(origin + "/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "not a prompt leak: metadata only" }),
    });
    const created = (await start.json()) as { session?: { id?: string } };
    const id = created?.session?.id;
    assert.equal(start.status, 201, "the fixture created a session");

    const response = await fetch(origin + `/api/runs/${id}/stop`, { method: "POST" });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { ok: boolean; ack: string; scope: string };
    assert.equal(body.ok, true);
    assert.equal(body.ack, "acknowledged");
    assert.equal(body.scope, "this process only");

    const feed = (await fetch(origin + `/api/fleet/events?sessionId=${id}`).then((r) => r.json())) as { items: Array<Record<string, unknown>>; stopAck: string };
    assert.equal(feed.stopAck, "acknowledged");
    const kinds = feed.items.map((e: { kind: string }) => e.kind);
    assert.ok(kinds.includes("stop_requested"), "the stop request is in the feed");
    assert.ok(kinds.includes("stop_acknowledged"), "the ack is in the feed");
    for (const event of feed.items) {
      const flat = JSON.stringify(event);
      assert.doesNotMatch(flat, /not a prompt leak/, "no prompt text in the fleet feed");
      assert.doesNotMatch(flat, /bearer/i, "no credential text in the fleet feed");
    }
  }, { workbench });
});

test("the overview carries the fleet view fields for one registered agent", async () => {
  const fetcher: typeof fetch = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://fixture.test/v1/models")
      return Response.json({ data: [{ id: "fixture-model" }] });
    throw new Error(`fixture fetcher must not be called for ${url}`);
  };
  const workbench = new Workbench({ VOID_DATA_DIR: await mkdtemp(join(tmpdir(), "void-fleet-wb-")) }, fetcher);
  await workbench.configure({ baseUrl: "https://fixture.test/v1", apiKey: "fixture-private-key-never-expose" });
  await withServer("unused.jsonl", async (origin) => {
    // The overview names a run only when one exists, so seed a session first.
    const start = await fetch(origin + "/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "overview seed" }),
    });
    assert.equal(start.status, 201, "the fixture created a session");
    const overview = (await fetch(origin + "/api/overview").then((r) => r.json())) as Record<string, unknown> & { latestEvents: unknown[]; stopAck: string };
    assert.ok(typeof overview.agentId === "string", "the overview names the registered agent's run");
    assert.ok("runState" in overview, "the overview names the run state");
    assert.ok("stopAck" in overview, "the overview names the stop acknowledgement");
    assert.ok("inFlight" in overview, "the overview counts unconfirmed in-flight calls");
    assert.ok(Array.isArray(overview.latestEvents), "the overview carries the latest fleet events");
    assert.equal(overview.stopAck, "unknown", "no stop has been requested yet");
  }, { workbench });
});

test("a decided approval records the approval event with its verdict", async () => {
  const decisions: Array<Record<string, unknown>> = [];
  await withServer("unused.jsonl", async (origin) => {
    const decision = await fetch(origin + "/api/approvals/hold-fixture-1/decision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "approved", by: "fixture-operator" }),
    });
    assert.equal(decision.status, 200, "the fixture broker accepted the decision");
    const feed = (await fetch(origin + "/api/fleet/events").then((r) => r.json())) as { items: Array<Record<string, unknown>> };
    const recorded = feed.items.find((event) => event.kind === "approval");
    assert.ok(recorded, "the approval decision is in the feed");
    assert.equal(recorded?.agentId, "hold-fixture-1", "the feed names the hold");
    assert.equal(recorded?.verdict, "approved", "the feed carries the verdict");
  }, {
    approvals: {
      decide: (holdId, decision) => {
        decisions.push({ holdId, decision });
        return { ok: true };
      },
    },
  });
  assert.equal(decisions.length, 1, "the broker saw exactly one decision");
});

test("a started run and a decided approval land in the fleet feed", async () => {
  const fetcher: typeof fetch = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://fixture.test/v1/models")
      return Response.json({ data: [{ id: "fixture-model" }] });
    throw new Error(`fixture fetcher must not be called for ${url}`);
  };
  const workbench = new Workbench(
    { VOID_DATA_DIR: await mkdtemp(join(tmpdir(), "void-fleet-wb-")) },
    fetcher,
  );
  await workbench.configure({ baseUrl: "https://fixture.test/v1", apiKey: "fixture-private-key-never-expose" });
  await withServer("unused.jsonl", async (origin) => {
    const start = await fetch(origin + "/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "leak-probe-prompt-xyz" }),
    });
    assert.equal(start.status, 201, "the fixture created a session");
    const created = (await start.json()) as { session?: { id?: string } };
    const id = created?.session?.id;
    assert.ok(typeof id === "string", "the session response names the run");

    const feed = (await fetch(origin + "/api/fleet/events").then((r) => r.json())) as { items: Array<Record<string, unknown>> };
    assert.ok(feed.items.some((event) => event.kind === "run_started"), "the run start is in the feed");
    for (const event of feed.items) {
      const flat = JSON.stringify(event);
      assert.doesNotMatch(flat, /leak-probe-prompt-xyz/, "no prompt text in the fleet feed");
    }
  }, { workbench });
});

test("registering an agent emits agent_started", async () => {
  await withServer("unused.jsonl", async (origin) => {
    const response = await fetch(origin + "/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "fleet-fixture-agent",
        name: "FleetFixture",
        systemPrompt: "fixture",
        allowedTools: ["void_workspace_list"],
        policyProfile: "default",
        maxTurns: 5,
        maxContextTokens: 4096,
      }),
    });
    assert.equal(response.status, 200, "the fixture registered an agent");

    const feed = (await fetch(origin + "/api/fleet/events").then((r) => r.json())) as { items: Array<Record<string, unknown>> };
    const started = feed.items.find((event) => event.kind === "agent_started");
    assert.ok(started, "the registration is in the feed");
    assert.equal(started?.agentId, "fleet-fixture-agent", "the feed names the upserted agent");
  });
});

test("oversized JSON request bodies return 413 across API error handlers", async () => {
  await withServer("unused.jsonl", async (origin) => {
    const generalBody = JSON.stringify({
      name: "oversized",
      payload: "x".repeat(70 * 1024),
    });
    const oversizedSessionBody = JSON.stringify({
      payload: "x".repeat(2 * 1024 * 1024),
    });
    for (const [pathname, body] of [
      ["/api/agents", generalBody],
      ["/api/provider", generalBody],
      ["/api/sessions", oversizedSessionBody],
    ] as const) {
      const response = await fetch(origin + pathname, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      assert.equal(response.status, 413, pathname);
      assert.deepEqual(
        await response.json(),
        { error: "body_too_large" },
        pathname,
      );
    }
  });
});

test("provider model capability lookup is manifest-bound and fails closed on source conflicts", async () => {
  const openai = CONFIGURABLE_PROVIDER_DESCRIPTORS.find(
    descriptor =>
      descriptor.providerId === "openai" &&
      descriptor.transport === "openai-responses" &&
      descriptor.models.includes("gpt-5.4"),
  );
  const cerebras = CONFIGURABLE_PROVIDER_DESCRIPTORS.find(
    descriptor =>
      descriptor.providerId === "cerebras" &&
      descriptor.transport === "openai-completions" &&
      descriptor.models.includes("gemma-4-31b"),
  );
  assert.ok(openai);
  assert.ok(cerebras);

  let providerRequests = 0;
  const directory = await mkdtemp(join(tmpdir(), "void-provider-capabilities-"));
  const workbench = new Workbench(
    { NOMO_DATA_DIR: directory, NVIDIA_API_KEY: "", DASHSCOPE_API_KEY: "" },
    async () => {
      providerRequests++;
      throw new Error("manifest capability lookup must not call a provider");
    },
  );
  try {
    await withServer("unused.jsonl", async origin => {
      const lookup = (descriptorId: string, modelId: string) =>
        fetch(
          `${origin}/api/provider/model-capabilities?${new URLSearchParams({ descriptorId, modelId })}`,
        );
      const known = await lookup(openai.id, "gpt-5.4");
      assert.equal(known.status, 200);
      assert.deepEqual(await known.json(), {
        status: "known",
        modelId: "gpt-5.4",
        input: ["text", "image"],
        reasoning: true,
        tools: true,
        contextWindow: 1_050_000,
        maxTokens: 128_000,
      });

      const conflicting = await lookup(cerebras.id, "gemma-4-31b");
      assert.equal(conflicting.status, 200);
      assert.deepEqual(await conflicting.json(), {
        status: "conflict",
        modelId: "gemma-4-31b",
      });

      const unknown = await lookup(openai.id, "not-in-manifest");
      assert.equal(unknown.status, 404);
      assert.deepEqual(await unknown.json(), {
        error: "model_capabilities_unavailable",
      });
      assert.equal(providerRequests, 0);
    }, { workbench });
  } finally {
    workbench.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("AgentRunner API exposes safe metadata and enforces one exact consent before start", async (t) => {
  const dataDirectory = await isolatedWorkbenchDataDirectory(t, "nomo-agent-runner-api-");
  const projectRoot = await mkdtemp(join(tmpdir(), "nomo-agent-runner-api-project-"));
  await mkdir(join(projectRoot, "src"));
  await writeFile(join(projectRoot, "src/main.ts"), "export const value = 1;\n");
  execFileSync("git", ["init", "--quiet"], { cwd: projectRoot, stdio: "ignore" });

  let startCount = 0;
  const runner: AgentRunner = {
    describe: () => ({
      id: "fixture-runner",
      displayName: "Local API fixture",
      provider: "fixture",
      endpoint: "https://fixture.invalid/v1",
      dataTransfer: "remote",
      dataSent: ["task", "system-prompt"],
      profiles: ["safe"],
      execution: "local",
      toolAccess: "mediated",
      workspaceMode: "approved-copy",
      cancellation: "confirmed",
    }),
    async start() {
      startCount++;
      return {
        id: "fixture-run",
        events: (async function* () {
          yield {
            type: "assistant-message",
            runId: "fixture-run",
            sequence: 1,
            text: "Synthetic runner completed the task.",
          } as const;
          yield {
            type: "terminal",
            runId: "fixture-run",
            sequence: 2,
            status: "completed",
            message: "Synthetic terminal summary.",
          } as const;
        })(),
        async respondToTool() {},
      };
    },
    async cancel() {
      return "confirmed";
    },
  };
  const workbench = new Workbench(
    { NOMO_DATA_DIR: dataDirectory, NOMO_PERMISSION_MODE: "normal" },
    undefined,
    { agentRunners: [runner] },
  );
  t.after(async () => {
    await workbench.shutdown();
    await rm(dataDirectory, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });
  workbench.upsertAgent({
    id: "project-reader",
    name: "Project reader",
    systemPrompt: "Read the approved copy only.",
    allowedTools: [],
    policyProfile: "default",
    maxTurns: 2,
    maxContextTokens: 8192,
  });
  await workbench.confirmProjectAccess(projectRoot, []);

  await withServer(
    "unused.jsonl",
    async (origin) => {
      const catalogResponse = await fetch(`${origin}/api/agent-runners`);
      assert.equal(catalogResponse.status, 200);
      const catalog = await catalogResponse.json() as {
        runners: Array<Record<string, unknown>>;
      };
      assert.deepEqual(catalog.runners, [{
        id: "fixture-runner",
        displayName: "Local API fixture",
        provider: "fixture",
        endpoint: "https://fixture.invalid/v1",
        dataTransfer: "remote",
        dataSent: ["task", "system-prompt"],
        profiles: ["safe"],
        execution: "local",
        toolAccess: "mediated",
        workspaceMode: "approved-copy",
        cancellation: "confirmed",
      }]);
      assert.doesNotMatch(JSON.stringify(catalog), /apiKey|credential|secret/i);

      const previewResponse = await fetch(`${origin}/api/agent-runs/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runnerId: "fixture-runner",
          task: "inspect the approved copy",
          profileId: "project-reader",
          runnerProfileId: "safe",
        }),
      });
      assert.equal(previewResponse.status, 201);
      const preview = await previewResponse.json() as {
        id: string;
        consentDigest: string;
        task: string;
        runner: { provider: string; endpoint: string; dataSent: string[]; toolAccess: string; workspaceMode: string; cancellation: string };
        project: { manifest: { digest: string; files: Array<{ path: string }> } };
        tools: unknown[];
      };
      assert.equal(preview.task, "inspect the approved copy");
      assert.equal(preview.runner.provider, "fixture");
      assert.equal(preview.runner.endpoint, "https://fixture.invalid/v1");
      assert.deepEqual(preview.runner.dataSent, ["task", "system-prompt"]);
      assert.equal(preview.runner.toolAccess, "mediated");
      assert.equal(preview.runner.workspaceMode, "approved-copy");
      assert.equal(preview.runner.cancellation, "confirmed");
      assert.match(preview.project.manifest.digest, /^sha256:[a-f0-9]{64}$/);
      assert.equal(preview.project.manifest.files.some((file) => file.path === ".git"), false);

      const start = (consentDigest: string) => fetch(`${origin}/api/agent-runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ consentId: preview.id, consentDigest }),
      });
      assert.equal((await start("sha256:" + "0".repeat(64))).status, 409);
      assert.equal(startCount, 0);
      const startedResponse = await start(preview.consentDigest);
      assert.equal(startedResponse.status, 201);
      const started = await startedResponse.json() as {
        session: { id: string };
      };
      assert.ok(started.session.id);
      assert.equal((await start(preview.consentDigest)).status, 409);
      await workbench.settled();
      assert.equal(startCount, 1);
      const sessionResponse = await fetch(`${origin}/api/sessions/${started.session.id}`);
      assert.equal(sessionResponse.status, 200);
      const sessionPayload = await sessionResponse.json() as {
        session: { events: Array<{ kind: string; text: string }> };
      };
      assert.equal(sessionPayload.session.events.some(
        (event) =>
          event.kind === "assistant" &&
          event.text === "Synthetic runner completed the task.",
      ), true);
      assert.equal(sessionPayload.session.events.some(
        (event) =>
          event.kind === "assistant" &&
          event.text === "Synthetic terminal summary.",
      ), true);
      assert.equal(workbench.get(started.session.id)?.status, "idle");
    },
    { workbench },
  );
  await withServer("unused.jsonl", async (origin) => {
    const response = await fetch(`${origin}/api/agent-runners`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      runners: [{
        id: "fixture-runner",
        displayName: "Local API fixture",
        provider: "fixture",
        endpoint: "https://fixture.invalid/v1",
        dataTransfer: "remote",
        dataSent: ["task", "system-prompt"],
        profiles: ["safe"],
        execution: "local",
        toolAccess: "mediated",
        workspaceMode: "approved-copy",
        cancellation: "confirmed",
      }],
    });
  }, { agentRunners: [runner] });
  await withServer("unused.jsonl", async (origin) => {
    const response = await fetch(`${origin}/api/agent-runners`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { runners: [] });
  });
});
test("typed OpenRouter configuration preserves routing preferences and rejects misplaced options", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nomo-openrouter-config-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const requests: string[] = [];
  const workbench = new Workbench(
    { NOMO_DATA_DIR: directory },
    async (input) => {
      requests.push(String(input));
      return Response.json({ data: [{ id: "ai21/jamba-large-1.7" }] });
    },
  );
  const gatewayOptions = {
    openrouter: {
      referer: "https://nomo.example",
      title: "NOMO Harness",
      categories: ["coding"],
      provider: {
        order: ["anthropic"],
        allow_fallbacks: false,
        data_collection: "deny",
        zdr: true,
      },
    },
  };
  try {
    await withServer(
      "unused.jsonl",
      async (origin) => {
        const descriptor = {
          providerId: "openrouter",
          transport: "openrouter",
          endpoint: "https://openrouter.ai/api/v1",
          model: "ai21/jamba-large-1.7",
          auth: { kind: "api-key", apiKey: "openrouter-secret-not-returned" },
        };
        const configured = await fetch(`${origin}/api/provider`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...descriptor, gatewayOptions }),
        });
        assert.equal(configured.status, 200);
        assert.doesNotMatch(await configured.text(), /openrouter-secret-not-returned/);

        const state = await fetch(`${origin}/api/provider`);
        assert.equal(state.status, 200);
        const body = await state.json() as Record<string, unknown>;
        assert.equal(body.providerId, "openrouter");
        assert.deepEqual(body.gatewayOptions, gatewayOptions);
        assert.doesNotMatch(JSON.stringify(body), /openrouter-secret-not-returned/);

        for (const invalid of [
          {
            ...descriptor,
            gatewayOptions: {
              openrouter: {
                provider: { data_collection: "sometimes" },
              },
            },
          },
          {
            providerId: "openai",
            transport: "openai-responses",
            endpoint: "https://api.openai.com/v1",
            model: "gpt-5.4",
            auth: descriptor.auth,
            gatewayOptions,
          },
        ]) {
          const rejected = await fetch(`${origin}/api/provider`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(invalid),
          });
          assert.equal(rejected.status, 400);
        }

        const retained = await (await fetch(`${origin}/api/provider`)).json() as Record<string, unknown>;
        assert.deepEqual(retained.gatewayOptions, gatewayOptions);
        assert.deepEqual(requests, ["https://openrouter.ai/api/v1/models"]);
      },
      { workbench },
    );
  } finally {
    workbench.close();
  }
});
async function responseErrorCode(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  return body &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    "error" in body
    ? body.error
    : undefined;
}

test("session image bodies use a bounded route-specific limit and reject invalid image bytes", async () => {
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const acceptedSize = Buffer.concat([
    pngSignature,
    Buffer.alloc(1024 * 1024 - pngSignature.length),
  ]).toString("base64");
  await withServer("unused.jsonl", async (origin) => {
    const post = (body: unknown) =>
      fetch(origin + "/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const accepted = await post({
      prompt: "Inspect this image",
      model: "fixture-model",
      images: [{ mimeType: "image/png", data: acceptedSize }],
    });
    assert.equal(accepted.status, 409);
    assert.notEqual(await responseErrorCode(accepted), "body_too_large");

    const invalid = await post({
      prompt: "Inspect this file",
      model: "fixture-model",
      images: [{ mimeType: "image/png", data: Buffer.from("not an image").toString("base64") }],
    });
    assert.equal(invalid.status, 400);
    assert.equal(await responseErrorCode(invalid), "invalid_session_images");

    const tooManyBytes = await post({
      prompt: "Inspect this image",
      model: "fixture-model",
      images: [{
        mimeType: "image/png",
        data: Buffer.concat([pngSignature, Buffer.alloc(1024 * 1024)]).toString("base64"),
      }],
    });
    assert.equal(tooManyBytes.status, 400);
    assert.equal(await responseErrorCode(tooManyBytes), "invalid_session_images");
    const tooManyImages = await post({
      prompt: "Inspect these images",
      images: Array.from({ length: 5 }, () => ({
        mimeType: "image/png",
        data: pngSignature.toString("base64"),
      })),
    });
    assert.equal(tooManyImages.status, 400);
    assert.equal(await responseErrorCode(tooManyImages), "invalid_session_images");

    const unsupportedMime = await post({
      prompt: "Inspect this image",
      images: [{ mimeType: "image/gif", data: pngSignature.toString("base64") }],
    });
    assert.equal(unsupportedMime.status, 400);
    assert.equal(await responseErrorCode(unsupportedMime), "invalid_session_images");

    const oversizedBody = await fetch(origin + "/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "Inspect this image",
        model: "fixture-model",
        images: [{ mimeType: "image/png", data: "A".repeat(2 * 1024 * 1024) }],
      }),
    });
    assert.equal(oversizedBody.status, 413);
    assert.equal(await responseErrorCode(oversizedBody), "body_too_large");
  });
});
test("OpenAI Chat Completions rejects oversized JSON with a structured 413", async () => {
  await withServer("unused.jsonl", async (origin) => {
    const response = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "x".repeat(2 * 1024 * 1024) }],
      }),
    });
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), {
      error: {
        message: "The request body is too large.",
        type: "invalid_request_error",
        code: "body_too_large",
      },
    });
  });
});
test("OpenAI-compatible model listing never probes ambient provider credentials", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "nomo-openai-models-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const requests: string[] = [];
  const workbench = new Workbench(
    {
      NOMO_DATA_DIR: dataDir,
      NVIDIA_API_KEY: "synthetic-unused-key",
      OPENAI_API_KEY: "synthetic-unused-key",
    },
    async (input) => {
      requests.push(String(input instanceof Request ? input.url : input));
      return Response.json({ data: [{ id: "must-not-be-requested" }] });
    },
  );
  t.after(() => workbench.close());

  await withServer("unused.jsonl", async (origin) => {
    const response = await fetch(`${origin}/v1/models`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { object: "list", data: [] });
    assert.deepEqual(requests, []);
  }, { workbench });
});

test("OpenAI model listing uses the existing remote bearer-token gate", async () => {
  const token = "nomo-control-token-openai-fixture-0123456789";
  await withServer(
    "unused.jsonl",
    async (origin) => {
      const headers = { host: "harness.remote.test" };
      const denied = await fetch(`${origin}/v1/models`, { headers });
      assert.equal(denied.status, 403);

      const allowed = await fetch(`${origin}/v1/models`, {
        headers: { ...headers, authorization: `Bearer ${token}` },
      });
      assert.equal(allowed.status, 200);
      assert.deepEqual(await allowed.json(), { object: "list", data: [] });
    },
    { env: { NOMO_CONTROL_TOKEN: token } },
  );
});

test("OpenAI chat rejects client tools and unavailable models before session creation", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "nomo-openai-chat-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let providerRequests = 0;
  const workbench = new Workbench(
    { NOMO_DATA_DIR: dataDir },
    async () => {
      providerRequests++;
      return Response.json({ data: [] });
    },
  );
  t.after(() => workbench.close());

  await withServer("unused.jsonl", async (origin) => {
    const post = (body: unknown) => fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const tools = await post({
      model: "fixture-model",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    });
    assert.equal(tools.status, 400);
    assert.deepEqual(await tools.json(), {
      error: {
        message: "Client tool calling is not supported by the NOMO agent endpoint.",
        type: "invalid_request_error",
        param: "tools",
        code: "unsupported_parameter",
      },
    });
    assert.equal(workbench.list().length, 0);

    for (const messages of [
      [{ role: "tool", content: "not client-callable" }],
      [{ role: "user", content: [{ type: "text", text: "not supported" }] }],
      [{ role: "unknown", content: "invalid role" }],
    ]) {
      const unsupported = await post({ model: "fixture-model", messages });
      assert.equal(unsupported.status, 400);
      assert.equal(workbench.list().length, 0);
    }

    const malformed = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    assert.equal(malformed.status, 400);
    assert.equal(workbench.list().length, 0);

    const model = await post({
      model: "not-configured",
      messages: [{ role: "user", content: "hello" }],
    });
    assert.equal(model.status, 404);
    assert.deepEqual(await model.json(), {
      error: {
        message: "The requested model is not in the configured Workbench catalog.",
        type: "invalid_request_error",
        param: "model",
        code: "model_not_found",
      },
    });
    assert.equal(workbench.list().length, 0);
    assert.equal(providerRequests, 0);
  }, { workbench });
});
test("OpenAI Chat Completions returns Workbench JSON, usage, and SSE without exposing provider secrets", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "nomo-openai-completion-"));
  const secret = "openai-facade-fixture-secret";
  const completionRequests: Record<string, unknown>[] = [];
  const workbench = new Workbench(
    { NOMO_DATA_DIR: dataDir },
    async (input, init) => {
      if (String(input).endsWith("/models"))
        return Response.json({ data: [{ id: "fixture-model" }] });
      assert.equal(String(input), "https://provider.test/v1/chat/completions");
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${secret}`);
      completionRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({
        choices: [{
          message: { role: "assistant", content: "Synthetic answer." },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      });
    },
  );
  t.after(async () => {
    workbench.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  await workbench.configure({
    baseUrl: "https://provider.test/v1",
    apiKey: secret,
  });

  await withServer("unused.jsonl", async (origin) => {
    const modelsResponse = await fetch(`${origin}/v1/models`);
    assert.equal(modelsResponse.status, 200);
    assert.deepEqual(await modelsResponse.json(), {
      object: "list",
      data: [{
        id: "fixture-model",
        object: "model",
        created: 0,
        owned_by: "custom",
      }],
    });

    const body = {
      model: "fixture-model",
      messages: [
        { role: "developer", content: "Answer briefly." },
        { role: "user", content: "Say hello." },
      ],
    };
    const jsonResponse = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(jsonResponse.status, 200);
    const json = await jsonResponse.json() as {
      id: string;
      object: string;
      model: string;
      choices: Array<{ message: { role: string; content: string }; finish_reason: string }>;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };
    assert.equal(json.object, "chat.completion");
    assert.match(json.id, /^chatcmpl-/);
    assert.equal(json.model, "fixture-model");
    assert.deepEqual(json.choices, [{
      index: 0,
      message: { role: "assistant", content: "Synthetic answer." },
      finish_reason: "stop",
    }]);
    assert.deepEqual(json.usage, {
      prompt_tokens: 7,
      completion_tokens: 3,
      total_tokens: 10,
    });
    assert.doesNotMatch(JSON.stringify(json), new RegExp(secret));
    assert.match(
      JSON.stringify(completionRequests[0]?.messages),
      /Say hello/,
    );

    const streamResponse = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, stream: true }),
    });
    assert.equal(streamResponse.status, 200);
    assert.match(streamResponse.headers.get("content-type") ?? "", /text\/event-stream/);
    const stream = await streamResponse.text();
    const frames = stream
      .split("\n\n")
      .filter((frame) => frame.startsWith("data: "))
      .map((frame) => frame.slice("data: ".length));
    assert.equal(frames.at(-1), "[DONE]");
    const chunks = frames.slice(0, -1).map((frame) => JSON.parse(frame));
    assert.deepEqual(
      chunks.flatMap((chunk) =>
        chunk.choices.map((choice: { delta: { role?: string; content?: string }; finish_reason: string | null }) =>
          choice.delta.role ?? choice.delta.content ?? choice.finish_reason,
        ),
      ),
      ["assistant", "Synthetic answer.", "stop"],
    );
    assert.equal(completionRequests.length, 2);
  }, { workbench });
});
test("OpenAI Chat Completions stream_options emits usage only when requested", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "nomo-openai-stream-usage-"));
  let completionRequests = 0;
  const workbench = new Workbench(
    { NOMO_DATA_DIR: dataDir },
    async (input) => {
      if (String(input).endsWith("/models"))
        return Response.json({ data: [{ id: "fixture-model" }] });
      completionRequests += 1;
      return Response.json({
        choices: [{
          message: { role: "assistant", content: "Synthetic answer." },
          finish_reason: "stop",
        }],
        ...(completionRequests === 6
          ? {}
          : { usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }),
      });
    },
  );
  t.after(async () => {
    workbench.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  await workbench.configure({
    baseUrl: "https://provider.test/v1",
    apiKey: "openai-stream-usage-fixture-secret",
  });

  await withServer("unused.jsonl", async (origin) => {
    type StreamChunk = {
      choices: Array<{
        delta: { role?: string; content?: string };
        finish_reason: string | null;
      }>;
      usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      } | null;
    };
    const body = {
      model: "fixture-model",
      messages: [{ role: "user", content: "Say hello." }],
      stream: true,
    };
    const readChunks = async (streamOptions: unknown) => {
      const response = await fetch(`${origin}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, stream_options: streamOptions }),
      });
      assert.equal(response.status, 200);
      const frames = (await response.text())
        .split("\n\n")
        .filter((frame) => frame.startsWith("data: "))
        .map((frame) => frame.slice("data: ".length));
      assert.equal(frames.at(-1), "[DONE]");
      return frames.slice(0, -1).map((frame) => JSON.parse(frame) as StreamChunk);
    };

    const withUsage = await readChunks({ include_usage: true });
    assert.deepEqual(
      withUsage.slice(0, 3).map((chunk) => chunk.usage),
      [null, null, null],
    );
    assert.deepEqual(withUsage.at(-1)?.choices, []);
    assert.deepEqual(withUsage.at(-1)?.usage, {
      prompt_tokens: 7,
      completion_tokens: 3,
      total_tokens: 10,
    });

    const withoutUsage = await readChunks({ include_usage: false });
    assert(withoutUsage.every((chunk) => !Object.hasOwn(chunk, "usage")));
    const emptyOptions = await readChunks({});
    assert(emptyOptions.every((chunk) => !Object.hasOwn(chunk, "usage")));
    const nullOptions = await readChunks(null);
    assert(nullOptions.every((chunk) => !Object.hasOwn(chunk, "usage")));
    const omittedOptions = await readChunks(undefined);
    assert(omittedOptions.every((chunk) => !Object.hasOwn(chunk, "usage")));

    const missingUsage = await readChunks({ include_usage: true });
    assert.deepEqual(missingUsage.at(-1)?.choices, []);
    assert.equal(missingUsage.at(-1)?.usage, null);

    for (const request of [
      { ...body, stream_options: { include_usage: "true" } },
      { ...body, stream_options: { include_usage: true, include_obfuscation: false } },
      { ...body, stream: false, stream_options: { include_usage: true } },
    ]) {
      const response = await fetch(`${origin}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      assert.equal(response.status, 400);
      const result = await response.json() as { error: { param?: string } };
      assert.equal(result.error.param, "stream_options");
    }
    assert.equal(completionRequests, 6);
  }, { workbench });
});
test("OpenAI chat disconnect cancels only its Workbench run", { timeout: 5_000 }, async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "nomo-openai-cancel-"));
  const secret = "openai-cancel-fixture-secret";
  let providerAborted = false;
  let signalProviderStarted!: () => void;
  const providerStarted = new Promise<void>((resolve) => {
    signalProviderStarted = resolve;
  });
  const workbench = new Workbench(
    { NOMO_DATA_DIR: dataDir },
    async (input, init) => {
      if (String(input).endsWith("/models"))
        return Response.json({ data: [{ id: "fixture-model" }] });
      const signal = init?.signal;
      signalProviderStarted();
      return await new Promise<Response>((_resolve, reject) => {
        if (signal?.aborted) {
          providerAborted = true;
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        signal?.addEventListener("abort", () => {
          providerAborted = true;
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      });
    },
  );
  t.after(async () => {
    workbench.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  await workbench.configure({
    baseUrl: "https://provider.test/v1",
    apiKey: secret,
  });
  const originalStart = workbench.start.bind(workbench);
  let signalStartEntered!: () => void;
  let releaseStart!: () => void;
  const startEntered = new Promise<void>((resolve) => {
    signalStartEntered = resolve;
  });
  const startGate = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  workbench.start = async (...args: Parameters<Workbench["start"]>) => {
    signalStartEntered();
    await startGate;
    return originalStart(...args);
  };
  let signalCancelled!: (id: string) => void;
  const cancellation = new Promise<string>((resolve) => {
    signalCancelled = resolve;
  });
  const cancelledIds: string[] = [];
  const originalCancel = workbench.cancel.bind(workbench);
  workbench.cancel = (id) => {
    cancelledIds.push(id);
    signalCancelled(id);
    originalCancel(id);
  };

  await withServer("unused.jsonl", async (origin) => {
    const controller = new AbortController();
    const request = fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "fixture-model",
        messages: [{ role: "user", content: "wait for cancellation" }],
      }),
    });
    await startEntered;
    controller.abort();
    await assert.rejects(request);
    releaseStart();
    await providerStarted;
    const session = workbench.list().at(-1);
    assert.ok(session);
    const cancelledId = await cancellation;
    assert.equal(cancelledId, session.id);
    assert.deepEqual(cancelledIds, [session.id]);
    const completed = await workbench.waitForRun(session.id);
    assert.equal(providerAborted, true);
    assert.equal(completed.status, "cancelled");
    assert.equal(workbench.list().length, 1);
  }, { workbench });
});
