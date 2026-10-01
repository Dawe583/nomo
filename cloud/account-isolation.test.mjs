/**
 * Account isolation must hold at the HTTP boundary against real SQL rows.
 * This suite runs only in the disposable database used by the cloud gate.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { validateCloudTestEnvironment } from "../scripts/src/cloud-test-config.mjs";
import { sealSession } from "./account.mjs";
import { append, database, event, read, transaction, write } from "./store.mjs";
import { OPERATOR_OWNER } from "./owner.mjs";

if (process.env.VOID_GUI_DATABASE_TEST === "1") validateCloudTestEnvironment(process.env);

test("two verified accounts cannot read or change each other's cloud rows", {
  skip: process.env.VOID_GUI_DATABASE_TEST !== "1",
}, async (t) => {
  const ownerA = randomUUID(), ownerB = randomUUID();
  const owners = [ownerA, ownerB];
  const suffix = randomUUID();
  const workspace = `account-${suffix}`;
  const secret = randomBytes(32).toString("hex");
  process.env.SUPABASE_URL = "https://provider.invalid";
  process.env.SUPABASE_ANON_KEY = "disposable-test-key";
  process.env.VOID_ACCOUNT_SEAL_KEY = secret;
  assert.notEqual(process.env.VOID_ACCOUNT_SIGNUP, "1");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    if (String(input) === "https://provider.invalid/auth/v1/user") {
      const token = init?.headers?.Authorization?.replace(/^Bearer /, "");
      const id = owners.find((owner) => token === `account:${owner}`);
      return Promise.resolve(Response.json(id ? { id, email: `${id}@example.invalid` } : {}, {
        status: id ? 200 : 401,
      }));
    }
    return originalFetch(input, init);
  };
  const { default: app } = await import("./server.mjs");
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    globalThis.fetch = originalFetch;
    await database().end();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = (owner) => `__Host-void-account=${sealSession({
    userId: owner,
    accessToken: `account:${owner}`,
    refreshToken: `refresh:${owner}`,
    accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
    expiresAt: Date.now() + 60000,
  }, secret)}`;
  const request = async (owner, path, method = "GET", body) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        cookie: owner === OPERATOR_OWNER ? "" : cookie(owner),
        ...(owner === OPERATOR_OWNER ? { authorization: `Bearer ${process.env.VOID_CONTROL_TOKEN}` } : {}),
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const ids = owners.map(() => randomUUID());
  for (const [index, owner] of owners.entries()) {
    const session = {
      id: ids[index], workspace, title: `private-${index}-${suffix}`,
      createdAt: new Date().toISOString(), status: "idle", generation: 1,
      events: [], messages: [], tools: [],
    };
    event(session, "user", `private-event-${index}-${suffix}`);
    await write(owner, `session:${session.id}`, session);
    await transaction(owner, workspace, (client) => append(owner, {
      workspace, at: new Date().toISOString(), tool: `private-tool-${index}`,
      klass: "r0", decision: "allow",
    }, client));
  }
  for (const [index, owner] of owners.entries()) {
    const other = 1 - index;
    const own = await request(owner, `/api/sessions/${ids[index]}`);
    assert.equal(own.status, 200);
    assert.equal(own.body.session.title, `private-${index}-${suffix}`);
    assert.equal((await request(owner, `/api/sessions/${ids[other]}`)).status, 404);
    assert.equal((await request(owner, `/api/sessions/${ids[other]}/events`)).status, 404);
    assert.equal((await request(owner, `/api/sessions/${ids[other]}`, "PATCH", { title: "forged" })).status, 404);
    assert.equal((await read(owners[other], `session:${ids[other]}`)).title, `private-${other}-${suffix}`);
    const page = await request(owner, `/api/sessions?q=${suffix}`);
    assert.equal(page.status, 200);
    assert.deepEqual(page.body.items.map((item) => item.id), [ids[index]]);
    const feed = await request(owner, `/api/feed?workspace=${workspace}`);
    assert.equal(feed.status, 200);
    assert.deepEqual(feed.body.items.map((item) => item.tool), [`private-tool-${index}`]);
    const updated = await request(owner, "/api/preferences", "PATCH", { appearance: index ? "light" : "dark" });
    assert.equal(updated.status, 200);
    const shown = await request(owner, "/api/preferences");
    assert.equal(shown.status, 200);
    assert.equal(shown.body.preferences.appearance, index ? "light" : "dark");
  }
  assert.equal((await read(ownerA, "preferences")).appearance, "dark");
  assert.equal((await read(ownerB, "preferences")).appearance, "light");
  assert.equal((await request(OPERATOR_OWNER, `/api/sessions/${ids[0]}`)).status, 404);
  assert.equal((await request(OPERATOR_OWNER, `/api/sessions/${ids[1]}`)).status, 404);
  assert.equal((await request(OPERATOR_OWNER, `/api/feed?workspace=${workspace}`)).body.total, 0);
  const anonymous = await originalFetch(base + `/api/sessions/${ids[0]}`);
  assert.equal(anonymous.status, 401);
});
