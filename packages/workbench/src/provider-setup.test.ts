import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workbench } from "./index.ts";
import { connectTokenHarbor, stageTokenHarborKey } from "./provider-setup.ts";
import { ProviderRequestError } from "./provider.ts";

test("staged Token Harbor credentials remain encrypted; verification failure preserves the provider until reconnection", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-tokenharbor-"));
  const env = { VOID_DATA_DIR: root };
  let verified = false;
  const secret = "fixture-harbor-secret";
  let app = new Workbench(env, async (url, options) => {
    if (String(url).startsWith("https://tokenharbor.ai/")) {
      assert.equal(
        new Headers(options?.headers).get("authorization"),
        `Bearer ${secret}`,
      );
      if (!verified)
        return Response.json(
          { error: { type: "email_verification_required", message: secret } },
          { status: 403 },
        );
      return Response.json({ data: [{ id: "harbor-fixture" }] });
    }
    return Response.json({ data: [{ id: "original-model" }] });
  });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  await app.configure({
    baseUrl: "https://original.test/v1",
    apiKey: "original",
  });
  stageTokenHarborKey(secret, env);
  const path = join(root, "provider-setup", "workspace.enc");
  assert.equal((await readFile(path)).includes(Buffer.from(secret)), false);
  if (process.platform !== "win32")
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  await assert.rejects(
    connectTokenHarbor(app, env),
    (e) =>
      e instanceof ProviderRequestError &&
      e.code === "email_verification_required" &&
      !e.message.includes(secret),
  );
  assert.equal((await app.providerState()).baseUrl, "https://original.test/v1");
  verified = true;
  const connected = await connectTokenHarbor(app, env);
  assert.equal(connected.providerId, "tokenharbor");
  assert.equal(connected.defaultModel, "harbor-fixture");
  await app.shutdown();
  app = new Workbench(env);
  assert.equal((await app.providerState()).providerId, "tokenharbor");
  assert.equal(
    (await app.providerState()).defaultModel,
    "harbor-fixture",
  );
});
