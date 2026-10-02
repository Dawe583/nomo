import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mountRecoveryRoutes } from "./recovery-routes.mjs";
import { view } from "./store.mjs";
import { OPERATOR_OWNER } from "./owner.mjs";

async function fixture(t) {
  const state = { session: { id: "session", workspace: "agent-session", status: "idle" }, applies: 0, reads: [] };
  const digest = "a".repeat(64);
  state.plan = { jobId: "job", digest, selection: { kind: "operations", operationIds: ["op"] }, boundary: { sequence: 2, digest }, steps: [{ operationId: "op", sequence: 1, plan: { resources: ["notes.md"], scope: "managed-documents", secret: "private-capture" } }], residuals: [] };
  state.status = state.plan;
  const client = {};
  const deps = {
    transaction: async (owner, _id, run) => {
      assert.equal(owner, OPERATOR_OWNER);
      if (state.race) state.session.status = "running";
      return run(client);
    },
    read: async (owner, _key, c) => {
      assert.equal(owner, OPERATOR_OWNER);
      state.reads.push(c);
      return state.session;
    },
    write: async (owner, _key, session, c) => {
      assert.equal(owner, OPERATOR_OWNER);
      assert.equal(c, client);
      state.saved = structuredClone(session);
    },
    planCloudRecoveryJob: async () => state.plan,
    cloudRecoveryJobStatus: async () => state.status,
    cloudRecoveryJobPlanDigest: async () => state.plan.digest,
    runCloudRecoveryJob: async (_owner, _s, _c, _id, approve) => {
      assert.equal(await approve(state.plan), true);
      state.applies++;
      return state.status = { jobId: "job", status: state.applyStatus ?? "restored", checkpoint: 1, outcomes: [{ operationId: "op", status: "restored" }], residuals: [] };
    },
  };
  const app = express();
  app.use(express.json());
  // Stands in for the session gate in cloud/server.mjs, which is what puts an
  // owner on the request. The route itself refuses a request that has none.
  app.use((req, _res, next) => { if (!state.anonymous) req.owner = OPERATOR_OWNER; next(); });
  mountRecoveryRoutes(app, deps);
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const request = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/sessions/session/recovery-jobs/${path}`, {
      method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  return {
    state,
    deps,
    request,
    digest,
    client,
    anonymous: () => { state.anonymous = true; },
  };
}

test("recovery route projects immutable plans without capture contents", async t => {
  const f = await fixture(t);
  const response = await f.request("plan", { jobId: "job", selection: { kind: "operations", operationIds: ["op"] } });
  assert.equal(response.status, 200);
  assert.equal(response.body.planDigest, f.digest);
  assert.deepEqual(response.body.steps, [{ operationId: "op", sequence: 1, resources: ["notes.md"], scope: "managed-documents" }]);
  assert.doesNotMatch(JSON.stringify(response.body), /private-capture/);
  assert.ok(f.state.reads.every(c => c === f.client));
});

test("recovery apply validates consent and digest even after completion", async t => {
  const f = await fixture(t), apply = { jobId: "job", planDigest: f.digest, approved: true };
  assert.equal((await f.request("apply", { ...apply, approved: false })).status, 400);
  assert.equal((await f.request("apply", { ...apply, planDigest: "b".repeat(64) })).status, 409);
  assert.equal((await f.request("apply", apply)).body.status, "restored");
  assert.equal((await f.request("apply", apply)).body.status, "restored");
  assert.equal(f.state.applies, 1);
  assert.equal((await f.request("apply", { ...apply, planDigest: "b".repeat(64) })).status, 409);
  assert.equal((await f.request("apply", { ...apply, approved: false })).status, 400);
});

test("recovery checks current session under transaction instead of stale pre-lock state", async t => {
  const f = await fixture(t); f.state.race = true;
  assert.equal((await f.request("apply", { jobId: "job", planDigest: f.digest, approved: true })).status, 409);
  assert.equal(f.state.applies, 0);
});

test("missing jobs return 404 and unknown outcomes never redispatch", async t => {
  const f = await fixture(t); f.state.status = null;
  assert.equal((await f.request("job")).status, 404);
  assert.equal((await f.request("apply", { jobId: "job", planDigest: f.digest, approved: true })).status, 404);
  f.state.status = { jobId: "job", status: "unknown", checkpoint: 0, outcomes: [], residuals: [{ operationId: "op", status: "unknown" }] };
  assert.equal((await f.request("apply", { jobId: "job", planDigest: f.digest, approved: true })).body.status, "unknown");
  assert.equal(f.state.applies, 0);
});

test("recovery accepts real generation run IDs and refuses invalid selections", async t => {
  const f = await fixture(t);
  assert.equal((await f.request("plan", { jobId: "job", selection: { kind: "run", runId: "session:1" } })).status, 200);
  assert.equal((await f.request("plan", { jobId: "job", selection: { kind: "operations", operationIds: ["op", "op"] } })).status, 400);
  assert.equal((await f.request("plan", { jobId: "job", selection: { kind: "run", runId: "../escape" } })).status, 400);
});

test("recovery accepts a journal checkpoint and refuses malformed ones", async t => {
  const f = await fixture(t);
  assert.equal((await f.request("plan", { jobId: "job", selection: { kind: "checkpoint", sequence: 2 } })).status, 200);
  assert.equal((await f.request("plan", { jobId: "job", selection: { kind: "checkpoint", sequence: 0 } })).status, 200);
  for (const sequence of [-1, 1.5, "2", null, undefined])
    assert.equal((await f.request("plan", { jobId: "job", selection: { kind: "checkpoint", sequence } })).status, 400);
  assert.equal((await f.request("plan", { jobId: "job", selection: { kind: "checkpoint" } })).status, 400);
  assert.equal((await f.request("plan", { jobId: "job", selection: { kind: "branches" } })).status, 400);
});

for (const status of ["unknown", "paused"]) {
  test(`recovery ${status} durably blocks forward work in its owning session`, async t => {
    const f = await fixture(t); f.state.applyStatus = status;
    const result = await f.request("apply", { jobId: "job", planDigest: f.digest, approved: true });
    assert.equal(result.body.status, status);
    assert.equal(f.state.saved?.status, status);
  });
}

for (const terminal of ["restored", "partial", "conflict"]) {
  test(`only the owning repaired job releases paused recovery as ${terminal}`, async t => {
    const f = await fixture(t), apply = { jobId: "job", planDigest: f.digest, approved: true };
    f.state.applyStatus = "paused";
    await f.request("apply", apply);
    assert.deepEqual(f.state.saved.recoveryBlock, { jobId: "job", priorStatus: "idle" });
    assert.equal((await f.request("apply", { ...apply, approved: false })).status, 400);
    assert.equal((await f.request("apply", { ...apply, planDigest: "b".repeat(64) })).status, 409);
    assert.equal((await f.request("apply", { ...apply, jobId: "unrelated" })).status, 409);
    assert.equal(f.state.applies, 1);
    f.state.applyStatus = terminal;
    assert.equal((await f.request("apply", apply)).body.status, terminal);
    assert.equal(f.state.saved.status, "idle");
    assert.equal(f.state.saved.recoveryBlock, undefined);
    assert.equal(f.state.applies, 2);
  });
}
for (const priorStatus of ["unknown", "paused", "cancelled", "failed"]) {
  test(`a repaired recovery preserves prior ${priorStatus} rather than inventing idle`, async t => {
    const f = await fixture(t), apply = { jobId: "job", planDigest: f.digest, approved: true };
    f.state.session.status = priorStatus;
    f.state.applyStatus = "paused";
    await f.request("apply", apply);
    f.state.applyStatus = "restored";
    await f.request("apply", apply);
    assert.equal(f.state.saved.status, priorStatus);
    assert.equal(f.state.saved.recoveryBlock, undefined);
  });
}

test("admitted recovery retains only public job identity across completion and reload", async t => {
  const f = await fixture(t), apply = { jobId: "job", planDigest: f.digest, approved: true };
  f.state.applyStatus = "paused";
  await f.request("apply", apply);
  assert.deepEqual(f.state.saved.lastRecoveryJob, { jobId: "job" });
  const paused = view(structuredClone(f.state.saved));
  assert.deepEqual(paused.lastRecoveryJob, { jobId: "job" });
  assert.deepEqual(view({ ...f.state.saved, lastRecoveryJob: { jobId: "older", secret: "private-capture" } }).lastRecoveryJob, { jobId: "job" });
  assert.doesNotMatch(JSON.stringify(paused), /priorStatus|recoveryBlock|private-capture/);
  f.state.applyStatus = "restored";
  await f.request("apply", apply);
  const terminal = view(structuredClone(f.state.saved));
  assert.deepEqual(terminal.lastRecoveryJob, { jobId: "job" });
  assert.equal(terminal.recoveryBlock, undefined);
  const count = f.state.applies;
  assert.equal((await f.request("job")).body.status, "restored");
  assert.equal(f.state.applies, count);
});

test("recovery refuses a request that carries no owner instead of planning against shared state", async (t) => {
  const f = await fixture(t);
  f.anonymous();
  const refused = await f.request("plan", {
    jobId: "job",
    selection: { kind: "operations", operationIds: ["op"] },
  });
  assert.equal(refused.status, 401);
  assert.deepEqual(f.state.reads, [], "a refused request must not read any session row");
  assert.equal(f.state.saved, undefined, "a refused request must not write any session row");
});
