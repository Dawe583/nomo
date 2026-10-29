/**
 * The boundary these tests pin: environment credentials are probed per source.
 *
 * A rejected key on one endpoint must not veto the next source behind it, and a
 * refused key is still a credential: the state has to report the recorded
 * failure instead of asking for the setup it already has. Failed sources are
 * probed once per process, not once per `providerState` poll, so a bad key
 * cannot turn every UI refresh into another HTTP attempt.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isolatedWorkbench } from "./test-fixture.ts";
import { NVIDIA_URL, QWEN_URL } from "./provider-defaults.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

test("a rejected DashScope key reports the failure instead of setup-required", async (t) => {
  let probes = 0;
  const fetcher: typeof fetch = async (url) => {
    probes++;
    assert.ok(String(url).startsWith(QWEN_URL), String(url));
    return new Response("denied", { status: 401 });
  };
  const { app } = await isolatedWorkbench(
    t,
    fetcher,
    { DASHSCOPE_API_KEY: "dashscope-fixture-key" },
    { configure: false, prefix: "nomo-env-dashscope-401-" },
  );

  const state = await app.providerState();
  assert.equal(state.connected, false);
  assert.equal(state.setupRequired, false);
  assert.equal(state.status, "unavailable");
  assert.match(state.detail ?? "", /rejected the credential/);
  assert.equal(probes, 1);

  // The refused source is not re-probed on every poll.
  assert.equal((await app.providerState()).status, "unavailable");
  assert.equal(probes, 1);
});

test("a rejected NVIDIA key does not veto the DashScope key behind it", async (t) => {
  const attempts: string[] = [];
  const fetcher: typeof fetch = async (url) => {
    const target = String(url);
    attempts.push(target);
    if (target.startsWith(NVIDIA_URL))
      return new Response("denied", { status: 401 });
    if (target.startsWith(QWEN_URL))
      return Response.json({
        data: [{ id: "qwen3.8-flash", name: "Qwen 3.8 Flash" }],
      });
    throw new Error(`unexpected probe ${target}`);
  };
  const { app } = await isolatedWorkbench(
    t,
    fetcher,
    {
      NVIDIA_API_KEY: "nvidia-fixture-key",
      DASHSCOPE_API_KEY: "dashscope-fixture-key",
    },
    { configure: false, prefix: "nomo-env-second-source-" },
  );

  const state = await app.providerState();
  assert.equal(state.connected, true);
  assert.equal(state.providerId, "qwen");
  assert.equal(state.status, "ready");
  // NVIDIA is tried first and refused; DashScope is still reached.
  assert.equal(attempts.length, 2);
  assert.ok(attempts[0]!.startsWith(NVIDIA_URL));
  assert.ok(attempts[1]!.startsWith(QWEN_URL));
});

test("each refused environment source is probed once per attempt", async (t) => {
  let probes = 0;
  const fetcher: typeof fetch = async () => {
    probes++;
    throw new Error("fixture connection failure");
  };
  const { app } = await isolatedWorkbench(
    t,
    fetcher,
    {
      NVIDIA_API_KEY: "nvidia-fixture-key",
      DASHSCOPE_API_KEY: "dashscope-fixture-key",
    },
    { configure: false, prefix: "nomo-env-both-refused-" },
  );

  const first = await app.providerState();
  assert.equal(first.connected, false);
  // A configured-but-refused key is not the same as no key at all.
  assert.equal(first.setupRequired, false);
  assert.equal(first.status, "unavailable");
  assert.equal(probes, 2);

  // A second poll replays the recorded failure and sends nothing.
  assert.equal((await app.providerState()).status, "unavailable");
  assert.equal(probes, 2);

  // An explicit reconnect is a new attempt: one fresh probe per source.
  assert.equal(
    (await app.providerState({ reconnectEnvironment: true })).status,
    "unavailable",
  );
  assert.equal(probes, 4);
});

test("passive provider state waits for an explicit environment check", async (t) => {
  let probes = 0;
  const { app } = await isolatedWorkbench(
    t,
    async () => {
      probes++;
      return Response.json({ data: [{ id: "fixture-model" }] });
    },
    {
      NVIDIA_API_KEY: "nvidia-fixture-key",
      DASHSCOPE_API_KEY: "dashscope-fixture-key",
    },
    { configure: false, prefix: "nomo-env-passive-state-" },
  );

  const state = await app.providerState({ probeEnvironment: false });
  assert.equal(probes, 0);
  assert.equal(state.connected, false);
  assert.equal(state.setupRequired, false);
  assert.equal(state.status, "unavailable");
  assert.equal(state.detail, "Environment provider has not been checked.");
});

test("OPENAI_API_KEY configures and restores the manifest-bound Responses provider", async (t) => {
  const apiKey = "openai-fixture-key";
  const requests: Array<{
    url: string;
    method: string;
    authorization: string | undefined;
    redirect: string | undefined;
  }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const headers = init?.headers as Record<string, string>;
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      authorization: headers.authorization,
      redirect: init?.redirect,
    });
    return Response.json({ data: [{ id: "gpt-5.5" }, { id: "gpt-4.1" }] });
  };
  const fixture = await isolatedWorkbench(
    t,
    fetcher,
    { OPENAI_API_KEY: apiKey },
    { configure: false, prefix: "nomo-env-openai-" },
  );

  const state = await fixture.app.providerState();
  assert.equal(state.connected, true);
  assert.equal(state.providerId, "openai");
  assert.equal(state.transport, "openai-responses");
  assert.equal(state.authKind, "api-key");
  assert.equal(state.defaultModel, "gpt-5.5");
  assert.deepEqual(state.models, [
    { id: "gpt-5.5", name: "gpt-5.5" },
    { id: "gpt-4.1", name: "gpt-4.1" },
  ]);
  assert.equal(state.keyStorage, "encrypted-local");
  assert.doesNotMatch(JSON.stringify(state), /openai-fixture-key/);
  assert.deepEqual(requests, [{
    url: "https://api.openai.com/v1/models",
    method: "GET",
    authorization: "Bearer openai-fixture-key",
    redirect: "error",
  }]);

  const ciphertext = await readFile(join(fixture.root, "workspace.enc"));
  assert.equal(ciphertext.includes(Buffer.from(apiKey)), false);
  const restored = fixture.restart();
  const restoredState = await restored.providerState({ probeEnvironment: false });
  assert.equal(restoredState.connected, true);
  assert.equal(restoredState.providerId, "openai");
  assert.equal(restoredState.transport, "openai-responses");
  assert.equal(requests.length, 1);
});

test("a rejected OpenAI environment key is redacted and probed only on reconnect", async (t) => {
  const apiKey = "openai-rejected-fixture-key";
  let probes = 0;
  const { app } = await isolatedWorkbench(
    t,
    async (input, init) => {
      probes++;
      assert.equal(String(input), "https://api.openai.com/v1/models");
      assert.equal(
        (init?.headers as Record<string, string>).authorization,
        `Bearer ${apiKey}`,
      );
      return new Response("authentication failed", { status: 401 });
    },
    { OPENAI_API_KEY: apiKey },
    { configure: false, prefix: "nomo-env-openai-rejected-" },
  );

  const first = await app.providerState();
  assert.equal(first.connected, false);
  assert.equal(first.setupRequired, false);
  assert.equal(first.status, "unavailable");
  assert.doesNotMatch(JSON.stringify(first), /openai-rejected-fixture-key/);
  assert.equal(probes, 1);
  assert.equal((await app.providerState()).status, "unavailable");
  assert.equal(probes, 1);
  assert.equal(
    (await app.providerState({ reconnectEnvironment: true })).status,
    "unavailable",
  );
  assert.equal(probes, 2);
});
