import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { randomUUID } from "node:crypto";
import {
  demoRouter,
  demoCookie,
  demoIdentity,
  reserveDemoBudget,
  demoFailureMessage,
  DEMO_MODEL,
} from "./demo.mjs";
import { DEMO_OWNER } from "./owner.mjs";
import { NVIDIA_URL } from "../packages/workbench/src/provider-defaults.ts";
import { ProviderRequestError } from "../packages/workbench/src/provider.ts";
test("demo failures distinguish provider limits and authentication without leaking payloads", () => {
  assert.match(
    demoFailureMessage(new ProviderRequestError(429)),
    /rate limited.*429/,
  );
  assert.match(
    demoFailureMessage(new ProviderRequestError(401)),
    /credentials.*401/,
  );
  assert.match(demoFailureMessage(new ProviderRequestError(502)), /HTTP 502/);
  assert.doesNotMatch(
    demoFailureMessage(new Error("secret-provider-payload")),
    /secret-provider-payload/,
  );
});
test("demo cookies are signed, expiring and distinct from workspace authority", () => {
  const secret = "a".repeat(44),
    id = randomUUID(),
    now = Date.now();
  const cookie = demoCookie(id, secret, now);
  assert.equal(demoIdentity(cookie, secret, now), id);
  assert.equal(demoIdentity(cookie, "b".repeat(44), now), undefined);
  assert.equal(demoIdentity(cookie, secret, now + 86400001), undefined);
  assert.equal(
    demoIdentity("__Host-void-session=" + secret, secret, now),
    undefined,
  );
  assert.equal(
    demoIdentity(cookie.replace(id, randomUUID()), secret, now),
    undefined,
  );
});
test("durable demo budget bounds visitors, total requests and day rollover", () => {
  let budget;
  for (let i = 0; i < 6; i++) budget = reserveDemoBudget(budget, "visitor", 1);
  assert.throws(() => reserveDemoBudget(budget, "visitor", 1), /limit/);
  assert.equal(reserveDemoBudget(budget, "visitor", 86400001).runs, 1);
  for (let i = 6; i < 50; i++)
    budget = reserveDemoBudget(budget, `visitor-${i}`, 1);
  assert.throws(() => reserveDemoBudget(budget, "new-visitor", 1), /limit/);
});
test("anonymous demo isolates visitors and refuses arbitrary provider, host tools and private routes", async (t) => {
  const prior = { ...process.env };
  Object.assign(process.env, {
    VOID_PUBLIC_DEMO: "1",
    VOID_DEMO_NVIDIA_KEY: "test-key",
    VOID_SECRET_KEY: "s".repeat(44),
    VOID_LOCAL_TEST: "1",
  });
  t.after(() => {
    for (const key of [
      "VOID_PUBLIC_DEMO",
      "VOID_DEMO_NVIDIA_KEY",
      "VOID_SECRET_KEY",
      "VOID_LOCAL_TEST",
    ])
      if (prior[key] === undefined) delete process.env[key];
      else process.env[key] = prior[key];
  });
  const values = new Map(),
    reads = [],
    calls = [];
  // Serialize test transactions to reproduce the production capacity lock.
  let tail = Promise.resolve();
  const dependencies = {
    // The demo is reachable with no credential, so these assert that every
    // row it touches is filed under the one owner it is allowed.
    read: async (owner, key) => {
      assert.equal(owner, DEMO_OWNER);
      reads.push(key);
      return values.get(key);
    },
    write: async (owner, key, value) => {
      assert.equal(owner, DEMO_OWNER);
      values.set(key, structuredClone(value));
    },
    transaction: async (owner, key, run) => {
      assert.equal(owner, DEMO_OWNER);
      const next = tail.then(() => run({}));
      tail = next.catch(() => {});
      return next;
    },
    encrypt: JSON.stringify,
    decrypt: JSON.parse,
    provider: (config) => {
      assert.equal(config.baseUrl, NVIDIA_URL);
      assert.equal(config.apiKey, "test-key");
      return {
      redact: (value) => value,
      complete: async (model, messages, tools) => {
        calls.push({ model, tools });
        return {
          message: {
            role: "assistant",
            content: "Hello from the isolated demo.",
          },
        };
      },
    }; },
  };
  const app = express();
  app.use(express.json());
  app.use("/api/demo", demoRouter(dependencies));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, method = "GET", cookie = "", body, origin) =>
    fetch(base + "/api/demo" + path, {
      method,
      headers: {
        "content-type": "application/json",
        cookie,
        ...(origin ? { origin } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  assert.equal(
    (await request("/start", "POST", "", {}, "https://evil.example")).status,
    403,
  );
  assert.equal((await request("/state")).status, 401);
  const publicTools = await (await request('/tools')).json();
  assert.deepEqual(publicTools.tools.map(tool => tool.name), ['void_workspace_list', 'void_workspace_read', 'void_workspace_write', 'void_workspace_delete']);
  assert.ok(publicTools.tools.every(tool => tool.source === 'workspace'));
  assert.equal(reads.length, 0, 'Public tool metadata must not read private workspace state');
  const first = await request("/start", "POST"),
    firstCookie = first.headers.get("set-cookie");
  const second = await request("/start", "POST"),
    secondCookie = second.headers.get("set-cookie");
  assert.notEqual(firstCookie, secondCookie);
  const message = { prompt: "Hello", requestId: randomUUID() };
  assert.equal(
    (
      await request("/message", "POST", firstCookie, {
        ...message,
        agent: "prime-agent",
      })
    ).status,
    400,
  );
  assert.equal(
    (await request("/message", "POST", firstCookie, message)).status,
    200,
  );
  assert.equal(
    (await request("/message", "POST", firstCookie, message)).status,
    200,
  );
  assert.equal(calls.length, 1);
  // The demo has no operator to ask, so it names one model itself and reports
  // that same model on /status. Nothing here is a product default.
  assert.ok(DEMO_MODEL.length > 0);
  assert.equal(calls[0].model, DEMO_MODEL);
  assert.equal((await (await request("/status")).json()).model, DEMO_MODEL);
  assert.ok(
    calls[0].tools.every((tool) =>
      tool.function.name.startsWith("void_workspace_"),
    ),
  );
  assert.equal(
    (await (await request("/state", "GET", secondCookie)).json()).messages
      .length,
    0,
  );
  assert.equal(
    (await request("/prime/claim", "POST", firstCookie, {})).status,
    404,
  );
  assert.equal(
    (await request("/provider", "POST", firstCookie, {})).status,
    404,
  );
  assert.ok(
    reads.every(
      (key) => key.startsWith("demo") || key.startsWith("workspace:demo-"),
    ),
  );
  const firstId = demoIdentity(firstCookie, process.env.VOID_SECRET_KEY);
  const saved = JSON.parse(values.get(`demo:${firstId}`));
  saved.status = "running";
  saved.startedAt = Date.now() - 80000;
  saved.active = "lost-run";
  values.set(`demo:${firstId}`, JSON.stringify(saved));
  const interrupted = await (
    await request("/state", "GET", firstCookie)
  ).json();
  assert.equal(interrupted.status, "failed");
  assert.match(interrupted.error, /No tool was automatically retried/);
  assert.equal(calls.length, 1);
  assert.equal(
    (
      await request("/message", "POST", firstCookie, {
        prompt: "Continue",
        requestId: randomUUID(),
      })
    ).status,
    200,
  );
  assert.equal(calls.length, 2);
});
