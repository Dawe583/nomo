import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  database,
  write,
  encrypt,
  event,
  eventsAfter,
  sessionPage,
  ledgerPage,
  transaction,
  read,
} from "./store.mjs";
import { signer } from "./store.mjs";
import { entryHash, GENESIS_PREV } from "../packages/ledger/src/canonical.ts";
import { sha256Hex } from "../packages/ledger/src/sign.ts";
import { signingPreimage } from "../packages/ledger/src/index.ts";
import { createWorkspace } from "../packages/workbench/src/workspace.ts";
import { validateCloudTestEnvironment } from "../scripts/src/cloud-test-config.mjs";
if (process.env.VOID_GUI_DATABASE_TEST === "1") validateCloudTestEnvironment(process.env);

// Run only against an explicitly supplied isolated test database.
test(
  "cloud GUI retained history, indexed pages, revisions, branch and SSE",
  { skip: process.env.VOID_GUI_DATABASE_TEST !== "1" },
  async (t) => {
    const { default: app } = await import("./server.mjs");
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await database().end();
    });
    const base = `http://127.0.0.1:${server.address().port}`,
      headers = {
        authorization: `Bearer ${process.env.VOID_CONTROL_TOKEN}`,
        "content-type": "application/json",
      };
    const request = async (path, method = "GET", body) => {
      const response = await fetch(base + path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: response.status, body: await response.json() };
    };
    const prefix = randomUUID(),
      rows = Array.from({ length: 151 }, (_, i) => ({
        id: `${prefix}-${i}`,
        workspace: `agent-${prefix}-${i}`,
        title: `${prefix} ${i === 150 ? "needle" : "chat"}`,
        createdAt: new Date(Date.UTC(2025, 0, 1, 0, i)).toISOString(),
        status: "idle",
        model: "test",
        generation: 1,
        events: [],
        messages: [{ role: "system", content: "test" }],
        tools: [],
        provider: { mode: "tokenrouter" },
      }));
    for (const row of rows) await write(`session:${row.id}`, row);
    const session = rows[150];
    for (let i = 0; i < 1001; i++)
      event(session, i % 2 ? "assistant" : "user", `message ${i}`);
    await write(`session:${session.id}`, session);
    await write(`workspace:${session.id}`, encrypt(createWorkspace()));
    const first = await sessionPage(
      new URLSearchParams({ q: prefix, limit: "50" }),
    );
    assert.equal(first.total, 151);
    assert.equal(first.items.length, 50);
    assert.equal(first.items[0].events.length, 0);
    const second = await sessionPage(
      new URLSearchParams({ q: prefix, limit: "50", cursor: first.nextCursor }),
    );
    assert.equal(second.items.length, 50);
    assert.notEqual(first.items[0].id, second.items[0].id);
    assert.equal(
      (await sessionPage(new URLSearchParams({ q: `${prefix} needle` })))
        .items[0].id,
      session.id,
    );
    assert.equal((await eventsAfter(session.id, 999)).length, 2);
    const edited = await request(
      `/api/sessions/${session.id}/documents`,
      "PATCH",
      { path: "notes.md", content: "Version one", expectedRevision: null },
    );
    assert.equal(edited.status, 200);
    assert.ok(edited.body.document.revision);
    const conflict = await request(
      `/api/sessions/${session.id}/documents`,
      "PATCH",
      { path: "notes.md", content: "Overwrite", expectedRevision: null },
    );
    assert.equal(conflict.status, 409);
    const branch = await request(
      `/api/sessions/${session.id}/branches`,
      "POST",
      { seq: 1, prompt: "Changed message", snapshotDocuments: true },
    );
    assert.equal(branch.status, 201);
    assert.equal(branch.body.session.status, "idle");
    assert.equal(branch.body.session.events[0].text, "Changed message");
    const copied = await request(
      `/api/sessions/${branch.body.session.id}/documents?path=notes.md`,
    );
    assert.equal(copied.body.document.content, "Version one");
    const proof = await request(
      `/api/ledger/verify?workspace=${session.workspace}`,
    );
    assert.equal(proof.body.verified, true);
    assert.equal(proof.body.checked, 6);
    const feed = await ledgerPage(session.workspace, new URLSearchParams());
    assert.equal(feed.items.length, 6);
    assert.equal(feed.verified, false);
    for (const status of ["stopping", "unknown", "paused"]) {
      await write(`session:${session.id}`, { ...session, status });
      assert.equal((await request(`/api/sessions/${session.id}/documents`, "PATCH", {
        path: "notes.md", content: "unsafe edit", expectedRevision: edited.body.document.revision,
      })).status, 409, `document edit must refuse ${status}`);
      assert.equal((await request(`/api/sessions/${session.id}/undo/${edited.body.document.revision}`, "POST", {
        confirm: edited.body.document.revision,
      })).status, 409, `legacy Undo must refuse ${status}`);
    }
    await write(`session:${session.id}`, session);
    const undo = await request(
      `/api/sessions/${session.id}/undo/${edited.body.document.revision}`,
      "POST",
      { confirm: edited.body.document.revision },
    );
    assert.equal(undo.status, 200);
    const guardBase = await read(`session:${session.id}`);
    const guarded = { ...guardBase, lastRecoveryJob: { jobId: "older-recovery" }, recoveryBlock: { jobId: "parent-recovery", priorStatus: "idle" } };
    await write(`session:${session.id}`, guarded);
    const guardedView = (await request(`/api/sessions/${session.id}`)).body.session;
    assert.deepEqual(guardedView.lastRecoveryJob, { jobId: "parent-recovery" });
    assert.doesNotMatch(JSON.stringify(guardedView), /priorStatus|recoveryBlock/);
    for (const [path, method, body] of [
      ["documents", "PATCH", { path: "notes.md", content: "blocked", expectedRevision: null }],
      ["compact", "POST", {}],
      [`undo/${edited.body.document.revision}`, "POST", { confirm: edited.body.document.revision }],
    ]) assert.equal((await request(`/api/sessions/${session.id}/${path}`, method, body)).status, 409);
    assert.equal((await request(`/api/sessions/${session.id}`, "POST", { prompt: "Blocked by recovery ownership" })).status, 409);
    const independentBranch = await request(`/api/sessions/${session.id}/branches`, "POST", { seq: 1 });
    assert.equal(independentBranch.status, 201);
    const branchedState = await read(`session:${independentBranch.body.session.id}`);
    assert.equal(branchedState.recoveryBlock, undefined);
    assert.equal(branchedState.lastRecoveryJob, undefined);
    assert.equal((await request(`/api/sessions/${independentBranch.body.session.id}/documents`, "PATCH", {
      path: "independent.md", content: "New workspace", expectedRevision: null,
    })).status, 200);
    assert.equal((await read(`session:${session.id}`)).recoveryBlock.jobId, "parent-recovery");
    await write(`session:${session.id}`, guardBase);
    // Lifecycle contracts use the same SQL store and routes as production.
    const interrupted = { ...rows[148], status: "running", executing: "tool" };
    await write(`session:${interrupted.id}`, interrupted);
    const { advance, fail } = await import("./steps.mjs");
    assert.equal(await advance(interrupted.id, 1), "done");
    const uncertain = await request(`/api/sessions/${interrupted.id}`);
    assert.equal(uncertain.body.session.status, "unknown");
    assert.equal(uncertain.body.session.state, "unknown");
    assert.equal(uncertain.body.session.reconcileRequired, true);
    assert.equal((await request(`/api/sessions/${interrupted.id}`, "POST", { prompt: "Do not replay" })).status, 409);
    const stopped = { ...rows[147], status: "running", executing: null };
    await write(`session:${stopped.id}`, stopped);
    assert.equal((await request(`/api/runs/${stopped.id}/stop`, "POST", {})).status, 200);
    assert.equal((await read(`session:${stopped.id}`)).status, "cancelled");
    for (const retained of [{ queue: [{ id: "cancelled-call" }] }, { pending: { holdId: "cancelled-hold" } }]) {
      await write(`session:${stopped.id}`, { ...stopped, status: "cancelled", ...retained });
      assert.equal((await request(`/api/sessions/${stopped.id}`, "POST", { prompt: "New intent must never release old calls" })).status, 409);
    }
    const settling = { ...rows[146], status: "running", executing: "model" };
    await write(`session:${settling.id}`, settling);
    assert.equal((await request(`/api/runs/${settling.id}/stop`, "POST", {})).status, 200);
    assert.equal((await read(`session:${settling.id}`)).status, "stopping");
    await fail(settling.id, 1);
    assert.equal((await read(`session:${settling.id}`)).status, "cancelled");
    const compactable = await read(`session:${session.id}`);
    compactable.messages = [
      { role: "system", content: "Operator policy" },
      { role: "user", content: "Old context" },
      { role: "assistant", content: "Old response" },
      { role: "user", content: "Current question" },
      { role: "assistant", content: "Current response" },
    ];
    await write(`session:${session.id}`, compactable);
    const compacted = await request(`/api/sessions/${session.id}/compact`, "POST", {});
    assert.equal(compacted.status, 200);
    assert.equal(compacted.body.compaction.omittedMessageCount, 2);
    assert.equal(compacted.body.session.contextMessages, 4);
    const persisted = await request(`/api/sessions/${session.id}`);
    assert.deepEqual(persisted.body.session.compaction, compacted.body.compaction);
    const context = (await read(`session:${session.id}`)).messages;
    assert.equal(context[0].content, "Operator policy");
    assert.equal(context[1].role, "user");
    assert.equal((await request(`/api/sessions/${interrupted.id}/compact`, "POST", {})).status, 409);
    const held = { ...rows[145], status: "running", pending: { holdId: "private-hold-details" } };
    event(held, "user", "Held run fixture");
    await write(`session:${held.id}`, held);
    assert.equal((await request(`/api/sessions/${held.id}`)).body.session.state, "awaiting-approval");
    const heldPage = await sessionPage(new URLSearchParams({ q: held.title }));
    assert.equal(heldPage.items.find(row => row.id === held.id)?.state, "awaiting-approval");
    assert.doesNotMatch(JSON.stringify(heldPage), /private-hold-details/);
    const heldRuns = await request("/api/runs?limit=100");
    assert.equal(heldRuns.body.items.find(run => run.sessionId === held.id)?.state, "awaiting-approval");
    await write(`session:${held.id}`, { ...held, status: "stopping", pending: null });
    assert.equal((await request(`/api/sessions/${rows[144].id}`, "POST", { prompt: "Capacity stays reserved while stopping" })).status, 409);
    const scaleWorkspace = `scale-${prefix}`,
      signed = [],
      key = await signer(),
      keyId = await key.currentKeyId();
    let previous = GENESIS_PREV;
    for (let seq = 1; seq <= 10000; seq++) {
      const body = {
          workspace: scaleWorkspace,
          at: new Date().toISOString(),
          tool: seq === 1 ? "old-needle" : "fixture",
          klass: "r0",
          decision: "allow",
        },
        hash = await entryHash(body, previous, sha256Hex);
      signed.push({
        workspace: scaleWorkspace,
        seq,
        body,
        prev_hash: previous,
        hash,
        key_id: keyId,
        alg: key.alg,
        signature: `${key.alg}:${Buffer.from(await key.sign(signingPreimage(key.alg, keyId, hash))).toString("base64")}`,
      });
      previous = hash;
    }
    await database().query(
      "INSERT INTO void_cloud_ledger(workspace,seq,entry) SELECT $1,(e->>'seq')::integer,e FROM jsonb_array_elements($2::jsonb) e",
      [scaleWorkspace, JSON.stringify(signed)],
    );
    const scalePage = await ledgerPage(
      scaleWorkspace,
      new URLSearchParams("limit=50"),
    );
    assert.equal(scalePage.total, 10000);
    assert.equal(scalePage.items.length, 50);
    assert.equal(scalePage.items[0].seq, 10000);
    const scaleNext = await ledgerPage(
      scaleWorkspace,
      new URLSearchParams({ limit: "50", cursor: scalePage.nextCursor }),
    );
    assert.equal(scaleNext.items[0].seq, 9950);
    assert.equal(
      (await ledgerPage(scaleWorkspace, new URLSearchParams("tool=old-needle")))
        .items[0].seq,
      1,
    );
    const scaleProof = await request(
      `/api/ledger/verify?workspace=${scaleWorkspace}`,
    );
    assert.equal(scaleProof.body.checked, 10000);
    assert.equal(scaleProof.body.verified, true);
    const stream = await fetch(
      `${base}/api/sessions/${session.id}/stream?after=1000`,
      { headers },
    );
    const reader = stream.body.getReader();
    const chunk = await reader.read();
    assert.match(new TextDecoder().decode(chunk.value), /id: 1001/);
    await reader.cancel();
    assert.equal((await read(`session:${session.id}`)).events.length, 200);
    assert.ok((await eventsAfter(session.id, 1000)).length >= 3);
  },
);
