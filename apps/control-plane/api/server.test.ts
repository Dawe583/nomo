import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { devKeyProvider, sha256Hex } from "../../../packages/ledger/src/sign.ts";
import { entryHash } from "../../../packages/ledger/src/canonical.ts";
import { jsonlStore } from "../../../packages/ledger/src/store.ts";
import { listenControlPlane, type ApprovalBroker, type PendingApproval } from "./server.ts";
import { Workbench } from "../../../packages/workbench/src/index.ts";
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
};

async function withServer<T>(
  ledgerPath: string,
  run: (origin: string) => Promise<T>,
  options: WithServerOptions = {},
): Promise<T> {
  const dataDir = await mkdtemp(join(tmpdir(), "void-api-workbench-"));
  const home = await mkdtemp(join(tmpdir(), "void-fleet-home-"));
  const handle = await listenControlPlane({
    ledgerPath,
    webRoot: join(import.meta.dirname, '../web'),
    approvals: options.approvals,
    workbench: options.workbench,
    env: { VOID_DATA_DIR: dataDir, ...options.env },
  });
  try {
    return await run(`http://127.0.0.1:${handle.port}`);
  } finally {
    await handle.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
}

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
  test("provider API exposes per-API availability reasons through the existing read endpoint", async () => {
    await withServer("unused.jsonl", async (origin) => {
      const response = await fetch(origin + "/api/provider");
      assert.equal(response.status, 200);
      const expected = PROVIDER_MODEL_MANIFEST.apiTransports
        .filter(item => item.status !== "implemented")
        .map(item => ({ ...item, disabled: true }));
      const state = await response.json() as {
        unavailableProviders: typeof expected;
      };
      assert.deepEqual(state.unavailableProviders, expected);
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
              ["api-key", "aws-credentials", "none"].includes(descriptor.authKind) &&
              (descriptor.endpoint === null || !/[<>{}]/.test(descriptor.endpoint)),
          ),
        );
        for (const providerId of ["kimi-code", "muse-code", "ollama-cloud", "amazon-bedrock"]) {
          assert.ok(
            !descriptors.some((descriptor) => descriptor.providerId === providerId),
            `${providerId} does not satisfy this setup's manifest auth contract`,
          );
        }
        assert.doesNotMatch(JSON.stringify(state), /typed-provider-secret-never-return/);
        const invalidBodies = [
          { providerId: "openai", transport: "openai-responses", endpoint: "https://api.openai.com/v1", model: "unknown-model", auth: { kind: "api-key", apiKey: secret } },
          { providerId: "openai", transport: "openai-responses", endpoint: "https://api.openai.com/v1", model: "gpt-5.4", auth: { kind: "none" } },
          { providerId: "openai", transport: "openai-responses", endpoint: "https://api.openai.com/v1", model: "gpt-5.4", auth: { kind: "api-key", apiKey: secret, unexpected: true } },
          { providerId: "azure", transport: "azure-openai-responses", endpoint: "https://attacker.example", model: "gpt-4o", auth: { kind: "api-key", apiKey: secret } },
          { providerId: "amazon-bedrock", transport: "bedrock-converse-stream", endpoint: "https://bedrock-runtime.us-west-2.amazonaws.com/", model: "amazon.nova-2-lite-v1:0", auth: { kind: "aws-credentials", accessKeyId: secret, secretAccessKey: secret } },
          { providerId: "kimi-code", transport: "openai-completions", endpoint: "https://api.kimi.com/coding/v1", model: "kimi-for-coding", auth: { kind: "api-key", apiKey: secret } },
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
        assert.equal(retainedState.providerId, "openai");
        assert.equal(retainedState.defaultModel, "gpt-5.4");
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
      assert.equal(state.providerId, "openai");
      assert.equal(state.transport, "openai-responses");
      assert.equal(state.defaultModel, "gpt-5.4");
    } finally {
      if (!workbenchClosed) workbench.close();
      restarted?.close();
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
      auth: {
        kind: "aws-credentials",
        accessKeyId: "fixture-only",
        secretAccessKey: "fixture-only",
      },
    };
    assert.throws(
      () => assertProviderDescriptorInManifest(bedrock),
      /Provider authentication is not supported by this setup/,
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
    const body = JSON.stringify({
      name: "oversized",
      payload: "x".repeat(70 * 1024),
    });
    for (const pathname of ["/api/agents", "/api/provider", "/api/sessions"]) {
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
