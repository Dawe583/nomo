import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { IncomingMessage } from "node:http";
import { dirname, join } from "node:path";

import { devKeyProvider, sha256Hex } from "../../../packages/ledger/src/sign.ts";
import { entryHash } from "../../../packages/ledger/src/canonical.ts";
import { jsonlStore } from "../../../packages/ledger/src/store.ts";
import { authorizedRemote } from "./auth.ts";
import { listenControlPlane, type ApprovalBroker, type PendingApproval } from "./server.ts";

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
  const dir = await mkdtemp(join(tmpdir(), "nomo-control-plane-api-"));
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
};

async function withServer<T>(
  ledgerPath: string,
  run: (origin: string) => Promise<T>,
  options: WithServerOptions = {},
): Promise<T> {
  const dataDir = await mkdtemp(join(tmpdir(), "nomo-api-workbench-"));
  const handle = await listenControlPlane({
    ledgerPath,
    webRoot: join(import.meta.dirname, '../web'),
    approvals: options.approvals,
    env: { NOMO_DATA_DIR: dataDir, ...options.env },
  });
  try {
    return await run(`http://127.0.0.1:${handle.port}`);
  } finally {
    await handle.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

describe("control plane API", () => {
  test("serves built assets on every host and refuses Windows path separators", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nomo-built-assets-"));
    const webRoot = join(dir, "web");
    await mkdir(join(webRoot, "assets"), { recursive: true });
    await writeFile(join(webRoot, "index.html"), '<script src="/assets/app-123.js"></script>');
    await writeFile(join(webRoot, "assets", "app-123.js"), 'console.log("fixture")');
    await writeFile(join(webRoot, "assets", "app-123.css"), 'body{color:red}');
    const handle = await listenControlPlane({ webRoot, env: { NOMO_DATA_DIR: join(dir, "data") } });
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
    const dir = await mkdtemp(join(tmpdir(), "nomo-control-plane-api-empty-"));
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
    }, { env: { NOMO_SIGNING_KEY: keyMaterial.toString("base64") } });
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
    }, { env: { NOMO_SIGNING_KEY: keyMaterial.toString("base64") } });
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
      assert.match(await response.text(), /NOMO Call Feed/);
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

const legacyToken = "legacy-".padEnd(40, "a");
const currentToken = "current-".padEnd(40, "b");

function bearerRequest(authorization: string): IncomingMessage {
  return { headers: { authorization } } as unknown as IncomingMessage;
}

test("the remote gate accepts a bearer only from the configured token, current name or legacy name", () => {
  assert.equal(authorizedRemote(bearerRequest(`Bearer ${currentToken}`), { NOMO_CONTROL_TOKEN: currentToken }), true);
  // The name the product carried before the rename is still the name an
  // operator typed into their shell, so a machine configured before the
  // rename must not report itself unconfigured.
  assert.equal(authorizedRemote(bearerRequest(`Bearer ${legacyToken}`), { VOID_CONTROL_TOKEN: legacyToken }), true);
  assert.equal(authorizedRemote(bearerRequest(`Bearer ${legacyToken}`), { NOMO_CONTROL_TOKEN: currentToken }), false);
  // A present current name wins, so an operator who replaced the token is not
  // still admitted with the value they replaced.
  assert.equal(authorizedRemote(bearerRequest(`Bearer ${currentToken}`), { VOID_CONTROL_TOKEN: legacyToken, NOMO_CONTROL_TOKEN: currentToken }), true);
  assert.equal(authorizedRemote(bearerRequest(`Bearer ${legacyToken}`), { VOID_CONTROL_TOKEN: legacyToken, NOMO_CONTROL_TOKEN: currentToken }), false);
});

test("a refused remote request answers the same generic refusal and never echoes a token", async () => {
  await withServer("unused.jsonl", async (origin) => {
    // The legacy name is a configured token, so the remote gate is closed and
    // only the bearer carrying it is admitted.
    assert.equal((await fetch(`${origin}/api/provider`, { headers: { authorization: `Bearer ${legacyToken}` } })).status, 200);
    for (const headers of [{}, { authorization: `Bearer wrong-${legacyToken}` }]) {
      const response = await fetch(`${origin}/api/provider`, { headers });
      assert.equal(response.status, 403);
      const text = await response.text();
      assert.deepEqual(JSON.parse(text), { error: "local_origin_required" });
      assert.doesNotMatch(text, new RegExp(legacyToken));
    }
  }, { env: { VOID_CONTROL_TOKEN: legacyToken } });
});

test("a legacy data directory holds the workspace state", async () => {
  const data = await mkdtemp(join(tmpdir(), "nomo-legacy-data-"));
  try {
    await withServer("unused.jsonl", async (origin) => {
      const response = await fetch(`${origin}/api/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "legacy", root: "/tmp/legacy" }),
      });
      assert.equal(response.status, 200);
    }, { env: { NOMO_DATA_DIR: undefined, VOID_DATA_DIR: data } });
    assert.ok(await readFile(join(data, "workspace.key"), "utf8"), "the legacy data directory is where the state was written");
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

async function seedWorkspace(dir: string, name: string, count: number): Promise<void> {
  const signer = await devKeyProvider({ dir: join(dir, "keys"), env: {} });
  const store = jsonlStore(signer, { dir });
  for (let index = 1; index <= count; index += 1) {
    await store.append({
      workspace: name,
      at: `2026-09-0${index}T00:00:00.000Z`,
      tool: `${name}.call.${index}`,
      klass: "r1",
      decision: "allow:resolved",
      argsDigest: `${index}`.repeat(64),
    });
  }
}

async function withEnvironment<T>(env: Readonly<NodeJS.ProcessEnv>, run: (origin: string) => Promise<T>): Promise<T> {
  const data = await mkdtemp(join(tmpdir(), "nomo-api-env-"));
  const handle = await listenControlPlane({ webRoot: join(import.meta.dirname, "../web"), env: { NOMO_DATA_DIR: data, ...env } });
  try {
    return await run(`http://127.0.0.1:${handle.port}`);
  } finally {
    await handle.close();
    await rm(data, { recursive: true, force: true });
  }
}

test("the feed resolves a legacy ledger directory and workspace name", async () => {
  const ledgerDir = await mkdtemp(join(tmpdir(), "nomo-legacy-ledger-"));
  try {
    await seedWorkspace(ledgerDir, "legacy-ws", 2);
    await withEnvironment({ VOID_LEDGER_DIR: ledgerDir, VOID_WORKSPACE: "legacy-ws" }, async (origin) => {
      const response = await fetch(`${origin}/api/feed`);
      assert.equal(response.status, 200);
      const body = await response.json() as { scope: string; entries: Array<{ tool: string }> };
      assert.equal(body.scope, "legacy-ws");
      assert.deepEqual(body.entries.map(entry => entry.tool).sort(), ["legacy-ws.call.1", "legacy-ws.call.2"]);
    });
  } finally {
    await rm(ledgerDir, { recursive: true, force: true });
  }
});

test("the current ledger directory and workspace name win over the legacy ones", async () => {
  const ledgerDir = await mkdtemp(join(tmpdir(), "nomo-current-ledger-"));
  const legacyDir = await mkdtemp(join(tmpdir(), "nomo-legacy-ledger-"));
  try {
    await seedWorkspace(ledgerDir, "current-ws", 3);
    await seedWorkspace(legacyDir, "legacy-ws", 1);
    await withEnvironment({
      NOMO_LEDGER_DIR: ledgerDir,
      VOID_LEDGER_DIR: legacyDir,
      NOMO_WORKSPACE: "current-ws",
      VOID_WORKSPACE: "legacy-ws",
    }, async (origin) => {
      const response = await fetch(`${origin}/api/feed`);
      assert.equal(response.status, 200);
      const body = await response.json() as { scope: string; entries: Array<{ tool: string }> };
      assert.equal(body.scope, "current-ws");
      assert.deepEqual(body.entries.map(entry => entry.tool).sort(), ["current-ws.call.1", "current-ws.call.2", "current-ws.call.3"]);
    });
  } finally {
    await rm(ledgerDir, { recursive: true, force: true });
    await rm(legacyDir, { recursive: true, force: true });
  }
});

test("the permission mode resolves under both names and the current one wins", async () => {
  await withEnvironment({ VOID_PERMISSION_MODE: "normal" }, async (origin) => {
    const body = await (await fetch(`${origin}/api/capabilities`)).json() as { permissionMode: string };
    assert.equal(body.permissionMode, "normal");
  });
  await withEnvironment({ VOID_PERMISSION_MODE: "normal", NOMO_PERMISSION_MODE: "read-only" }, async (origin) => {
    const body = await (await fetch(`${origin}/api/capabilities`)).json() as { permissionMode: string };
    assert.equal(body.permissionMode, "read-only");
  });
});
