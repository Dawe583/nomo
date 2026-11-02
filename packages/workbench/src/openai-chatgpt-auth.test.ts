import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import {
  buildOpenAIChatGPTAuthorizeUrl,
  OpenAIChatGPTAuthStore,
  withOpenAIChatGPTAuthLock,
} from "./openai-chatgpt-auth.ts";

const common = {
  hostId: "urn:uuid:host-fixture",
  redirectUri: "http://127.0.0.1:43127/auth/callback",
  state: "state-fixture",
  nonce: "nonce-fixture",
  codeChallenge: "challenge-fixture",
};

test("first Sign in with ChatGPT authorization requests the documented least-privilege flow", () => {
  const url = buildOpenAIChatGPTAuthorizeUrl({
    ...common,
    agentNameHint: "NOMO",
  });

  assert.equal(url.origin, "https://auth.openai.com");
  assert.equal(url.pathname, "/api/accounts/authorize");
  assert.equal(url.searchParams.get("client_id"), "dynamic_agent_client");
  assert.equal(url.searchParams.get("agent_name_hint"), "NOMO");
  assert.equal(url.searchParams.get("ext_agent_host_id"), common.hostId);
  assert.equal(url.searchParams.get("redirect_uri"), common.redirectUri);
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("resource"), "https://api.openai.com/v1");
  assert.equal(url.searchParams.get("state"), common.state);
  assert.equal(url.searchParams.get("nonce"), common.nonce);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge"), common.codeChallenge);
  assert.deepEqual(
    new Set(url.searchParams.get("scope")?.split(" ")),
    new Set([
      "openid",
      "profile",
      "email",
      "offline_access",
      "resource.invoke",
      "chatgpt.tokens.use.direct",
    ]),
  );
  assert.equal(url.searchParams.has("client_secret"), false);
  assert.equal(url.searchParams.has("id_token_hint"), false);
  assert.equal(url.searchParams.has("login_hint"), false);
});

test("reauthorization reuses the issued client ID without sending account hints", () => {
  const url = buildOpenAIChatGPTAuthorizeUrl({
    ...common,
    clientId: "oaiapp-issued-fixture",
  });

  assert.equal(url.searchParams.get("client_id"), "oaiapp-issued-fixture");
  assert.equal(url.searchParams.has("agent_name_hint"), false);
  assert.equal(url.searchParams.has("id_token_hint"), false);
  assert.equal(url.searchParams.has("login_hint"), false);
});

test("plan-usage enable requests consent only when explicitly selected", () => {
  const enabled = buildOpenAIChatGPTAuthorizeUrl({
    ...common,
    clientId: "oaiapp-issued-fixture",
    promptConsent: true,
  });
  const ordinary = buildOpenAIChatGPTAuthorizeUrl({
    ...common,
    clientId: "oaiapp-issued-fixture",
  });
  assert.equal(enabled.searchParams.get("prompt"), "consent");
  assert.equal(ordinary.searchParams.has("prompt"), false);
});

test("authorization refuses callback URIs outside the exact loopback contract", () => {
  for (const redirectUri of [
    "http://localhost:43127/auth/callback",
    "http://127.0.0.2:43127/auth/callback",
    "https://127.0.0.1:43127/auth/callback",
    "http://127.0.0.1:43127/callback",
    "http://user@127.0.0.1:43127/auth/callback",
    "http://127.0.0.1:43127/auth/callback?next=https://attacker.test",
  ]) {
    assert.throws(
      () => buildOpenAIChatGPTAuthorizeUrl({ ...common, redirectUri }),
      /loopback callback/i,
      redirectUri,
    );
  }
});

test("host account storage is shared, encrypted, and preserves its host ID", async t => {
  const directory = await mkdtemp(join(tmpdir(), "nomo-siwc-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const firstWorkspace = new OpenAIChatGPTAuthStore(join(directory, "host-auth"));
  const secondWorkspace = new OpenAIChatGPTAuthStore(join(directory, "host-auth"));
  const account = {
    id: "account-fixture",
    clientId: "oaiapp-fixture",
    subject: "subject-fixture",
    scopes: ["resource.invoke", "chatgpt.tokens.use.direct"],
    usageEnabled: true,
    accessToken: "access-secret-fixture",
    refreshToken: "refresh-secret-fixture",
    expiresAt: 123456789,
  };

  const firstHostId = await firstWorkspace.update(state => ({
    state: { ...state, accounts: [account], activeAccountId: account.id },
    result: state.hostId,
  }));
  const secondState = secondWorkspace.read();
  assert.equal(secondState?.hostId, firstHostId);
  assert.equal(secondState?.accounts[0]?.clientId, account.clientId);
  const encrypted = await import("node:fs/promises").then(fs => fs.readFile(join(directory, "host-auth", "workspace.enc"), "utf8"));
  assert.equal(encrypted.includes(account.accessToken), false);
  assert.equal(encrypted.includes(account.refreshToken), false);

  await secondWorkspace.update(state => ({
    state: {
      ...state,
      accounts: [...state.accounts, {
        id: "disabled-fixture",
        clientId: "oaiapp-disabled-fixture",
        subject: "disabled-subject",
        scopes: ["openid", "profile"],
        usageEnabled: false,
      }],
    },
    result: undefined,
  }));
  const disabled = secondWorkspace.read()?.accounts.find(item => item.id === "disabled-fixture");
  assert.equal(disabled?.usageEnabled, false);
  assert.equal("accessToken" in (disabled ?? {}), false);
  assert.equal("refreshToken" in (disabled ?? {}), false);
});

test("corrupt account stores fail closed without overwriting ciphertext", async t => {
  const directory = await mkdtemp(join(tmpdir(), "nomo-siwc-corrupt-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new OpenAIChatGPTAuthStore(join(directory, "host-auth"));
  await store.update(state => ({ state, result: undefined }));
  const path = join(directory, "host-auth", "workspace.enc");
  const original = fs.readFileSync(path);
  const invalidTag = Buffer.from(original);
  invalidTag[12] = invalidTag[12]! ^ 1;
  for (const corrupted of [Buffer.alloc(0), original.subarray(0, 20), invalidTag]) {
    fs.writeFileSync(path, corrupted);
    assert.throws(() => store.read());
    let called = false;
    await assert.rejects(store.update(state => {
      called = true;
      return { state, result: undefined };
    }));
    assert.equal(called, false);
    assert.deepEqual(fs.readFileSync(path), corrupted);
  }
});

test("account lifecycle lock serializes separate runtime processes", { timeout: 10_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "nomo-siwc-process-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lockPath = join(directory, "accounts.lock");
  const firstReady = join(directory, "first-ready");
  const releaseFirst = join(directory, "release-first");
  const secondReady = join(directory, "second-ready");
  const secondLockCheck = join(directory, "second-lock-check");
  const moduleUrl = new URL("./openai-chatgpt-auth.ts", import.meta.url).href;
  const firstScript = `
    const { withOpenAIChatGPTAuthLock } = await import(${JSON.stringify(moduleUrl)});
    const { writeFile, access } = await import("node:fs/promises");
    await withOpenAIChatGPTAuthLock(process.argv[1], async () => {
      await writeFile(process.argv[2], "ready");
      while (true) {
        try { await access(process.argv[3]); break; }
        catch { await new Promise(resolve => setTimeout(resolve, 10)); }
      }
    });
  `;
  const secondScript = `
    const { writeFile } = await import("node:fs/promises");
    const { writeFileSync } = await import("node:fs");
    const originalSetTimeout = setTimeout;
    let reportedLockWait = false;
    globalThis.setTimeout = (callback, delay, ...args) => {
      if (delay === 25 && !reportedLockWait) {
        reportedLockWait = true;
        writeFileSync(process.argv[3], "waiting");
      }
      return originalSetTimeout(callback, delay, ...args);
    };
    const { withOpenAIChatGPTAuthLock } = await import(${JSON.stringify(moduleUrl)});
    await withOpenAIChatGPTAuthLock(process.argv[1], async () => writeFile(process.argv[2], "ready"));
  `;
  const exit = (child: ReturnType<typeof spawn>) => new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const waitForFile = async (path: string, child: ReturnType<typeof spawn>) => {
    for (let attempt = 0; attempt < 300; attempt++) {
      if (fs.existsSync(path)) return;
      if (child.exitCode !== null) assert.fail(`lock process exited ${child.exitCode}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail(`timed out waiting for ${path}`);
  };
  const first = spawn(process.execPath, ["--input-type=module", "-e", firstScript, lockPath, firstReady, releaseFirst], { stdio: "ignore" });
  const firstExit = exit(first);
  let second: ReturnType<typeof spawn> | undefined;
  let secondExit: Promise<number | null> | undefined;
  try {
    await waitForFile(firstReady, first);
    second = spawn(process.execPath, ["--input-type=module", "-e", secondScript, lockPath, secondReady, secondLockCheck], { stdio: "ignore" });
    secondExit = exit(second);
    await waitForFile(secondLockCheck, second);
    assert.equal(fs.existsSync(secondReady), false);
    await writeFile(releaseFirst, "release");
    await waitForFile(secondReady, second);
    assert.deepEqual(await Promise.all([firstExit, secondExit]), [0, 0]);
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    if (first.exitCode === null) first.kill();
    if (second?.exitCode === null) second.kill();
  }
});

test("account lifecycle mutations wait for the host lock before entering", async t => {
  const directory = await mkdtemp(join(tmpdir(), "nomo-siwc-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const events: string[] = [];
  let releaseFirst!: () => void;
  let startedFirst!: () => void;
  const firstStarted = new Promise<void>(resolve => { startedFirst = resolve; });
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });

  const first = withOpenAIChatGPTAuthLock(join(directory, "accounts.lock"), async () => {
    events.push("first-start");
    startedFirst();
    await firstGate;
    events.push("first-end");
  });
  await firstStarted;
  const second = withOpenAIChatGPTAuthLock(join(directory, "accounts.lock"), async () => {
    events.push("second-start");
  });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(events, ["first-start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first-start", "first-end", "second-start"]);
});

test("lifecycle lock refuses stale owner without changing the lock", async t => {
  const directory = await mkdtemp(join(tmpdir(), "nomo-siwc-lock-stale-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const child = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
  assert.equal(child.status, 0);
  const path = join(directory, "accounts.lock");
  fs.writeFileSync(path, String(child.pid));
  await assert.rejects(
    withOpenAIChatGPTAuthLock(path, async () => {}),
    /stale owner; stop all NOMO processes and remove the lock to recover/,
  );
  assert.equal(fs.readFileSync(path, "utf8"), String(child.pid));
  await rm(path);
  let entered = false;
  await withOpenAIChatGPTAuthLock(path, async () => { entered = true; });
  assert.equal(entered, true);
  assert.equal(fs.existsSync(path), false);
});
