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
