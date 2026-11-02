import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { OpenAIChatGPTAuthStore } from "./openai-chatgpt-auth.ts";
import { OpenAIChatGPTAuthError, OpenAIChatGPTAuthService } from "./openai-chatgpt-login.ts";

async function fixture(t: test.TestContext, fetcher: typeof fetch) {
  const directory = await mkdtemp(join(tmpdir(), "nomo-siwc-lifecycle-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new OpenAIChatGPTAuthStore(join(directory, "host-auth"));
  const account = {
    id: "account-fixture",
    clientId: "oaiapp-fixture",
    subject: "subject-fixture",
    scopes: ["resource.invoke", "chatgpt.tokens.use.direct"],
    usageEnabled: true,
    accessToken: "expired-access-fixture",
    refreshToken: "refresh-fixture-secret",
    expiresAt: Date.now() - 1,
  };
  await store.update(state => ({
    state: { ...state, accounts: [account] },
    result: undefined,
  }));
  const service = new OpenAIChatGPTAuthService({ store, fetcher, agentNameHint: "NOMO" });
  return { store, service };
}

test("separate runtimes serialize refresh and reuse the rotated token", { timeout: 10_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "nomo-siwc-refresh-processes-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storePath = join(directory, "host-auth");
  const lockPath = join(storePath, "accounts.lifecycle.lock");
  const release = join(directory, "release-refresh");
  const firstResult = join(directory, "first-result");
  const secondResult = join(directory, "second-result");
  const firstRequest = join(directory, "first-request");
  const secondRequest = join(directory, "second-request");
  const secondLockCheck = join(directory, "second-lock-check");
  const store = new OpenAIChatGPTAuthStore(storePath);
  const account = {
    id: "account-fixture",
    clientId: "oaiapp-fixture",
    subject: "subject-fixture",
    scopes: ["resource.invoke", "chatgpt.tokens.use.direct"],
    usageEnabled: true,
    accessToken: "expired-access-fixture",
    refreshToken: "refresh-fixture-secret",
    expiresAt: Date.now() - 1,
  };
  await store.update(state => ({ state: { ...state, accounts: [account] }, result: undefined }));
  const worker = `
    import { writeFile } from "node:fs/promises";
    import { writeFileSync } from "node:fs";
    import { OpenAIChatGPTAuthStore } from ${JSON.stringify(new URL("./openai-chatgpt-auth.ts", import.meta.url).href)};
    import { OpenAIChatGPTAuthService } from ${JSON.stringify(new URL("./openai-chatgpt-login.ts", import.meta.url).href)};
    const [storePath, release, resultPath, requestPath, lockCheck] = process.argv.slice(1);
    if (resultPath.endsWith("second-result")) {
      const originalSetTimeout = setTimeout;
      let reportedLockWait = false;
      globalThis.setTimeout = (callback, delay, ...args) => {
        if (delay === 25 && !reportedLockWait) {
          reportedLockWait = true;
          writeFileSync(lockCheck, "waiting");
        }
        return originalSetTimeout(callback, delay, ...args);
      };
    }
    const service = new OpenAIChatGPTAuthService({
      store: new OpenAIChatGPTAuthStore(storePath),
      agentNameHint: "NOMO",
      fetcher: async () => {
        await writeFile(requestPath, "refreshing");
        while (true) {
          try { await (await import("node:fs/promises")).access(release); break; }
          catch { await new Promise(resolve => setTimeout(resolve, 10)); }
        }
        return Response.json({
          access_token: "rotated-access-fixture",
          refresh_token: "rotated-refresh-fixture",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "resource.invoke chatgpt.tokens.use.direct",
        });
      },
    });
    const token = await service.accessToken("account-fixture");
    await writeFile(resultPath, token);
  `;
  const first = spawn(process.execPath, ["--input-type=module", "-e", worker, storePath, release, firstResult, firstRequest], { stdio: "ignore" });
  const exit = (child: ReturnType<typeof spawn>) => new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const firstExit = exit(first);
  let second: ReturnType<typeof spawn> | undefined;
  let secondExit: Promise<number | null> | undefined;
  const waitForFile = async (path: string, children: readonly ReturnType<typeof spawn>[]) => {
    for (let attempt = 0; attempt < 300; attempt++) {
      if (existsSync(path)) return;
      for (const child of children)
        if (child.exitCode !== null) assert.fail(`refresh process exited ${child.exitCode}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail(`timed out waiting for ${path}`);
  };
  try {
    await waitForFile(lockPath, [first]);
    await waitForFile(firstRequest, [first]);
    second = spawn(process.execPath, ["--input-type=module", "-e", worker, storePath, release, secondResult, secondRequest, secondLockCheck], { stdio: "ignore" });
    secondExit = exit(second);
    await waitForFile(secondLockCheck, [second]);
    assert.equal(existsSync(secondRequest), false);
    await writeFile(release, "release");
    await waitForFile(firstResult, [first]);
    await waitForFile(secondResult, [second]);
    assert.deepEqual(await Promise.all([firstExit, secondExit]), [0, 0]);
    assert.equal(readFileSync(firstResult, "utf8"), "rotated-access-fixture");
    assert.equal(readFileSync(secondResult, "utf8"), "rotated-access-fixture");
    assert.equal(existsSync(secondRequest), false);
    assert.equal(store.read()?.accounts[0]?.refreshToken, "rotated-refresh-fixture");
  } finally {
    if (first.exitCode === null) first.kill();
    if (second?.exitCode === null) second.kill();
  }
});

test("invalid_grant clears unusable credentials and requires sign-in again", async t => {
  const { store, service } = await fixture(t, async () => Response.json(
    { error: "invalid_grant" },
    { status: 400 },
  ));
  await assert.rejects(
    service.accessToken("account-fixture"),
    error => error instanceof OpenAIChatGPTAuthError && error.code === "reauth_required",
  );
  const account = store.read()?.accounts[0];
  assert.equal(account?.usageEnabled, false);
  assert.equal(account?.reauthRequired, true);
  assert.equal("accessToken" in (account ?? {}), false);
  assert.equal("refreshToken" in (account ?? {}), false);
});

test("temporary refresh failures preserve the encrypted token set", async t => {
  const { store, service } = await fixture(t, async () => {
    throw new TypeError("fixture network unavailable");
  });
  await assert.rejects(
    service.accessToken("account-fixture"),
    error => error instanceof OpenAIChatGPTAuthError && error.code === "refresh_failed",
  );
  const account = store.read()?.accounts[0];
  assert.equal(account?.usageEnabled, true);
  assert.equal(account?.accessToken, "expired-access-fixture");
  assert.equal(account?.refreshToken, "refresh-fixture-secret");
});

test("temporary refresh failures retain safe provider diagnostics", async t => {
  const { service } = await fixture(t, async () => Response.json(
    { error: "temporarily_unavailable", error_description: "refresh-fixture-secret" },
    { status: 503, headers: { "x-request-id": "expired-access-fixture" } },
  ));
  await assert.rejects(
    service.accessToken("account-fixture"),
    error => error instanceof OpenAIChatGPTAuthError &&
      error.code === "refresh_failed" &&
      error.httpStatus === 503 &&
      error.providerErrorCode === "temporarily_unavailable" &&
      error.requestId === undefined &&
      !error.message.includes("refresh-fixture-secret"),
  );
});

test("refresh retains rotated credentials when plan scope is no longer granted", async t => {
  const { store, service } = await fixture(t, async () => Response.json({
    access_token: "rotated-access-fixture",
    refresh_token: "rotated-refresh-fixture",
    token_type: "Bearer",
    expires_in: 3600,
    scope: "openid profile resource.invoke",
  }));
  await assert.rejects(
    service.accessToken("account-fixture"),
    error => error instanceof OpenAIChatGPTAuthError && error.code === "usage_disabled",
  );
  const account = store.read()?.accounts[0];
  assert.equal(account?.usageEnabled, false);
  assert.equal(account?.accessToken, "rotated-access-fixture");
  assert.equal(account?.refreshToken, "rotated-refresh-fixture");
  await assert.rejects(
    service.accessToken("account-fixture"),
    error => error instanceof OpenAIChatGPTAuthError && error.code === "usage_disabled",
  );
});
