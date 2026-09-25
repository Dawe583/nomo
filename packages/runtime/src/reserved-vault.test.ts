import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { devKeyProvider } from "../../ledger/src/sign.ts";
import {
  reservedRecoveryVault,
  localRecoveryVault,
  localOperationJournal,
  recoveryRuntime,
  type RecoveryAdapter,
  type Json,
} from "./index.ts";
async function fixture(t: import("node:test").TestContext) {
  const root = await mkdtemp(join(tmpdir(), "void-reserved-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, keys: { first: randomBytes(32), second: randomBytes(32) } };
}

test("durable reservations cap concurrent writers, survive restart and preserve room for recovery", async (t) => {
  const f = await fixture(t),
    capacity = { maxArtifactBytes: 1024, maxTotalBytes: 3 * 1052 };
  const first = reservedRecoveryVault(f.root, f.keys, "first", capacity),
    second = reservedRecoveryVault(f.root, f.keys, "first", capacity);
  const results = await Promise.allSettled([
    first.reserve!("one", "a"),
    second.reserve!("two", "b"),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const [workspace, operationId] =
    results[0]!.status === "fulfilled" ? ["one", "a"] : ["two", "b"];
  const restart = reservedRecoveryVault(f.root, f.keys, "second", capacity);
  await restart.reserve!(workspace!, operationId!);
  await assert.rejects(restart.reserve!("other", "extra"), /quota/);
  const capture = await restart.put(workspace!, "private old bytes", {
    operationId: operationId!,
    slot: "capture",
  });
  await restart.put(workspace!, "result", {
    operationId: operationId!,
    slot: "outcome",
  });
  // Unrelated traffic can consume only unreserved room, never the inverse's slot.
  await restart.put("other", "x".repeat(1022));
  await assert.rejects(restart.put("other", "y".repeat(1022)), /quota/);
  const receipt = await restart.put(workspace!, "restored", {
    operationId: operationId!,
    slot: "recovery",
  });
  assert.equal(await restart.get(workspace!, capture), "private old bytes");
  assert.equal(await restart.get(workspace!, receipt), "restored");
  assert.equal(
    (await readFile(join(f.root, "vault.sqlite"))).includes(
      Buffer.from("private old bytes"),
    ),
    false,
  );
});
test("slot retry returns the same artifact and rejects changed evidence or another workspace", async (t) => {
  const f = await fixture(t),
    vault = reservedRecoveryVault(f.root, f.keys, "first");
  await vault.reserve!("one", "op");
  const reference = await vault.put(
    "one",
    { value: "before" },
    { operationId: "op", slot: "capture" },
  );
  assert.deepEqual(
    await vault.put(
      "one",
      { value: "before" },
      { operationId: "op", slot: "capture" },
    ),
    reference,
  );
  await assert.rejects(
    vault.put(
      "one",
      { value: "changed" },
      { operationId: "op", slot: "capture" },
    ),
    /different evidence/,
  );
  await assert.rejects(vault.get("two", reference));
  await vault.release!("one", "op");
  assert.deepEqual(await vault.get("one", reference), { value: "before" });
  await assert.rejects(
    vault.put("one", "result", { operationId: "op", slot: "outcome" }),
    /not reserved/,
  );
});
test("legacy snapshots remain readable and consume quota; new configuration cannot reset the shared limit", async (t) => {
  const f = await fixture(t),
    old = localRecoveryVault(f.root, f.keys, "first", 1024),
    reference = await old.put("one", "legacy");
  const capacity = { maxArtifactBytes: 1024, maxTotalBytes: 3 * 1052 };
  const vault = reservedRecoveryVault(f.root, f.keys, "second", capacity);
  assert.equal(await vault.get("one", reference), "legacy");
  await assert.rejects(vault.reserve!("one", "op"), /quota/);
  await assert.rejects(
    reservedRecoveryVault(f.root, f.keys, "second", {
      ...capacity,
      maxTotalBytes: 100000,
    }).reserve!("one", "op"),
    /persisted configuration/,
  );
});
test("refuses a different 32-byte key under an existing key ID before accepting new work", async (t) => {
  const f = await fixture(t);
  const original = reservedRecoveryVault(f.root, f.keys, "first");
  await original.put("one", { secret: "retained" });
  const wrong = reservedRecoveryVault(f.root, { ...f.keys, first: randomBytes(32) }, "first");
  await assert.rejects(wrong.reserve!("one", "next"), /key unavailable|incorrect/i);
  await assert.rejects(wrong.put("one", { secret: "new" }), /key unavailable|incorrect/i);
  const db = new DatabaseSync(join(f.root, "vault.sqlite"), { readOnly: true });
  try {
    const row = db.prepare("SELECT count(*) AS n FROM artifacts").get();
    if (!row || typeof row.n !== "number")
      throw new Error("Artifact count unavailable.");
    assert.equal(row.n, 1);
  } finally {
    db.close();
  }
});

test("verifies an unmarked SQLite vault before persisting its key marker", async (t) => {
  const f = await fixture(t);
  const original = reservedRecoveryVault(f.root, f.keys, "first");
  const reference = await original.put("one", { secret: "retained" });
  const db = new DatabaseSync(join(f.root, "vault.sqlite"));
  db.exec("DELETE FROM key_checks");
  db.close();

  const migrated = reservedRecoveryVault(f.root, f.keys, "first");
  assert.deepEqual(await migrated.get("one", reference), { secret: "retained" });
  const check = new DatabaseSync(join(f.root, "vault.sqlite"), { readOnly: true });
  try {
    const row = check.prepare("SELECT key_id,proof FROM key_checks").get();
    if (!row || row.key_id !== "first" || typeof row.proof !== "string")
      throw new Error("Key marker migration unavailable.");
    assert.match(row.proof, /^[a-f0-9]{64}$/);
  } finally {
    check.close();
  }
  const wrong = reservedRecoveryVault(f.root, { ...f.keys, first: randomBytes(32) }, "first");
  await assert.rejects(wrong.reserve!("one", "next"), /key unavailable|incorrect/i);
});

test("requires retained evidence before accepting an unmarked key rotation", async (t) => {
  const f = await fixture(t);
  const original = reservedRecoveryVault(f.root, f.keys, "first");
  const oldReference = await original.put("one", { secret: "old" });
  const clear = new DatabaseSync(join(f.root, "vault.sqlite"));
  clear.exec("DELETE FROM key_checks");
  clear.close();

  const rotated = reservedRecoveryVault(
    f.root,
    { first: f.keys.first, second: f.keys.second },
    "second",
  );
  await rotated.reserve!("one", "rotation");
  const newReference = await rotated.put("one", { secret: "new" }, {
    operationId: "rotation",
    slot: "capture",
  });
  assert.equal(newReference.keyId, "second");
  assert.deepEqual(await rotated.get("one", oldReference), { secret: "old" });
  const migrated = new DatabaseSync(join(f.root, "vault.sqlite"));
  try {
    assert.equal(
      migrated.prepare("SELECT key_id,proof FROM key_checks").get()?.key_id,
      "second",
    );
  } finally {
    migrated.close();
  }


  const clearAgain = new DatabaseSync(join(f.root, "vault.sqlite"));
  clearAgain.exec("DELETE FROM key_checks");
  clearAgain.close();
  const missingOld = reservedRecoveryVault(
    f.root,
    { second: f.keys.second },
    "second",
  );
  await assert.rejects(
    missingOld.reserve!("one", "next"),
    /key unavailable|incorrect/i,
  );
});

test("ciphertext tampering and unavailable keys refuse restore", async (t) => {
  const f = await fixture(t),
    vault = reservedRecoveryVault(f.root, f.keys, "first");
  const reference = await vault.put("one", "private");
  const rotated = reservedRecoveryVault(
    f.root,
    { second: f.keys.second },
    "second",
  );
  await assert.rejects(rotated.get("one", reference), /unavailable/);
  const db = new DatabaseSync(join(f.root, "vault.sqlite"));
  db.prepare("UPDATE artifacts SET data=? WHERE digest=?").run(
    Buffer.alloc(reference.bytes),
    reference.digest,
  );
  db.close();
  await assert.rejects(vault.get("one", reference), /mismatch/);
});
test("runtime refuses dispatch without capacity and reconciles a persisted result without consuming a second slot", async (t) => {
  const f = await fixture(t),
    dir = join(f.root, "vault"),
    capacity = { maxArtifactBytes: 2048, maxTotalBytes: 3 * 2076 },
    vault = reservedRecoveryVault(dir, f.keys, "first", capacity);
  const signer = await devKeyProvider({ dir: join(f.root, "keys"), env: {} }),
    journal = localOperationJournal(join(f.root, "journal"), signer);
  let writes = 0,
    value: Json = "before";
  const adapter: RecoveryAdapter = {
    id: "fixture",
    version: "1",
    async preflight() {
      return {
        effect: "write",
        reversibility: "r1",
        readiness: "verified",
        scope: "value",
        resources: ["value"],
        revision: value,
        blastRadius: { count: 1, precision: "exact" },
      };
    },
    async prepare() {
      return { before: value, plan: null };
    },
    async execute(args) {
      writes++;
      value = args;
      return { result: value, evidence: null };
    },
    async release() {},
    async reconcile() {
      return {
        status: "succeeded",
        outcome: { result: value, evidence: null },
      };
    },
    async recover(prepared) {
      value = prepared.before;
      return { status: "restored", evidence: value };
    },
  };
  const request = {
    workspace: "one",
    agentId: "agent",
    runId: "run",
    operationId: "op",
    adapterId: adapter.id,
    arguments: "after",
  };
  await vault.reserve!("other", "blocking");
  const runtime = recoveryRuntime({
    journal,
    vault,
    adapters: [adapter],
    authorize: async () => true,
  });
  assert.deepEqual(await runtime.execute(request), {
    status: "failed",
    operationId: "op",
    reason: "recovery-capacity",
  });
  assert.equal((await runtime.execute(request)).reason, "recovery-capacity");
  assert.equal(writes, 0);
  await vault.release!("other", "blocking");
  let lost = true;
  const interrupted = recoveryRuntime({
    journal,
    vault: {
      ...vault,
      put: async (...args) => {
        const ref = await vault.put(...args);
        if (args[2]?.slot === "outcome" && lost) {
          lost = false;
          throw new Error("lost acknowledgement");
        }
        return ref;
      },
    },
    adapters: [adapter],
    authorize: async () => true,
  });
  assert.equal(
    (await interrupted.execute({ ...request, operationId: "working" })).status,
    "unknown",
  );
  assert.equal(writes, 1);
  const restarted = recoveryRuntime({
    journal,
    vault: reservedRecoveryVault(dir, f.keys, "second", capacity),
    adapters: [adapter],
    authorize: async () => true,
  });
  assert.equal(
    (await restarted.reconcile("one", "working")).status,
    "succeeded",
  );
  assert.equal(writes, 1);
  assert.equal(
    (
      await restarted.recover(
        await restarted.planRecovery("one", "working"),
        async () => true,
      )
    ).status,
    "restored",
  );
  assert.equal(value, "before");
});

test("storage refusal fails closed before dispatch without a success receipt", async (t) => {
  const f = await fixture(t),
    dir = join(f.root, "vault"),
    vault = reservedRecoveryVault(dir, f.keys, "first"),
    signer = await devKeyProvider({ dir: join(f.root, "keys"), env: {} }),
    journal = localOperationJournal(join(f.root, "journal"), signer);
  let dispatches = 0;
  const adapter: RecoveryAdapter = {
    id: "fixture",
    version: "1",
    async preflight() {
      return {
        effect: "write",
        reversibility: "r1",
        readiness: "verified",
        scope: "value",
        resources: ["value"],
        revision: null,
        blastRadius: { count: 1, precision: "exact" },
      };
    },
    async prepare() {
      return { before: null, plan: null };
    },
    async execute() {
      dispatches += 1;
      return { result: "unexpected", evidence: null };
    },
    async release() {},
    async reconcile() {
      throw new Error("not dispatched");
    },
    async recover() {
      throw new Error("not dispatched");
    },
  };
  const refusingVault = {
    ...vault,
    reserve: async () => {
      throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
    },
  };
  const runtime = recoveryRuntime({
    journal,
    vault: refusingVault,
    adapters: [adapter],
    authorize: async () => true,
  });
  const result = await runtime.execute({
    workspace: "one",
    agentId: "agent",
    runId: "run",
    operationId: "storage-refused",
    adapterId: adapter.id,
    arguments: "value",
  });
  assert.deepEqual(result, { status: "failed", operationId: "storage-refused" });
  assert.equal(dispatches, 0);
  await journal.transaction("one", async (tx) => {
    const stages = tx.events.map((event) => event.stage);
    assert.equal(stages.at(-1), "failed");
    assert.equal(stages.includes("succeeded"), false);
    assert.equal(stages.includes("dispatched"), false);
  });
});

test("SIGKILL before snapshot commit rolls back payload and quota together", async (t) => {
  const f = await fixture(t),
    root = join(f.root, "vault"),
    capacity = { maxArtifactBytes: 1024, maxTotalBytes: 3 * 1052 };
  const vault = reservedRecoveryVault(root, f.keys, "first", capacity);
  await vault.reserve!("one", "op");
  const { spawn } = await import("node:child_process");
  const { once } = await import("node:events");
  const code = `
 import {DatabaseSync} from 'node:sqlite';
 import {reservedRecoveryVault} from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
 const original=DatabaseSync.prototype.exec;
 DatabaseSync.prototype.exec=function(sql){if(sql==='COMMIT'){process.send('before-commit');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0)}return original.call(this,sql)};
 await reservedRecoveryVault(process.env.TEST_VAULT,{first:Buffer.from(process.env.TEST_KEY,'base64')},'first',${JSON.stringify(capacity)}).put('one','before',{operationId:'op',slot:'capture'});
 `;
  const child = spawn(
    process.execPath,
    ["--input-type=module", "--eval", code],
    {
      env: {
        ...process.env,
        TEST_VAULT: root,
        TEST_KEY: f.keys.first.toString("base64"),
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  const [stage] = await once(child, "message", {
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(stage, "before-commit");
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  const [exit, signal] = await exited;
  assert.equal(exit, null);
  assert.equal(signal, "SIGKILL");
  const restarted = reservedRecoveryVault(root, f.keys, "first", capacity);
  await assert.rejects(restarted.reserve!("other", "op", ["capture"]), /quota/);
  const reference = await restarted.put("one", "before", {
    operationId: "op",
    slot: "capture",
  });
  assert.equal(await restarted.get("one", reference), "before");
  assert.deepEqual(
    await restarted.put("one", "before", {
      operationId: "op",
      slot: "capture",
    }),
    reference,
  );
});

test("persisted v0 SQLite schema upgrades to the bounded vault schema in place", async (t) => {
  const f = await fixture(t),
    capacity = { maxArtifactBytes: 1024, maxTotalBytes: 3 * 1052 },
    path = join(f.root, "vault.sqlite");
  const previous = new DatabaseSync(path);
  try {
    previous.exec(`PRAGMA user_version=0;
      CREATE TABLE settings(id INTEGER PRIMARY KEY CHECK(id=1),capacity TEXT NOT NULL);
      CREATE TABLE artifacts(workspace TEXT NOT NULL,digest TEXT NOT NULL,key_id TEXT NOT NULL,data BLOB NOT NULL,operation_id TEXT,slot TEXT,content_digest TEXT NOT NULL,PRIMARY KEY(workspace,digest),UNIQUE(workspace,operation_id,slot));
      CREATE TABLE reservations(workspace TEXT NOT NULL,operation_id TEXT NOT NULL,slot TEXT NOT NULL,bytes INTEGER NOT NULL,PRIMARY KEY(workspace,operation_id,slot));
      CREATE TABLE key_checks(key_id TEXT PRIMARY KEY,proof TEXT NOT NULL);`);
    previous.prepare("INSERT INTO settings VALUES(1,?)").run(
      JSON.stringify(capacity),
    );
  } finally {
    previous.close();
  }

  await reservedRecoveryVault(f.root, f.keys, "first", capacity).reserve!(
    "one",
    "op",
  );
  const upgraded = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(upgraded.prepare("PRAGMA user_version").get()?.user_version, 1);
    assert.equal(
      upgraded
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='artifacts_key_id'")
        .get()?.name,
      "artifacts_key_id",
    );
  } finally {
    upgraded.close();
  }
});

test("newer persisted vault schema is refused before accepting bounded work", async (t) => {
  const f = await fixture(t),
    path = join(f.root, "vault.sqlite");
  const future = new DatabaseSync(path);
  try {
    future.exec("PRAGMA user_version=2; CREATE TABLE settings(id INTEGER PRIMARY KEY CHECK(id=1),capacity TEXT NOT NULL)");
  } finally {
    future.close();
  }

  await assert.rejects(
    reservedRecoveryVault(f.root, f.keys, "first").reserve!("one", "op"),
    /unsupported.*schema|schema.*unsupported/i,
  );
  const unchanged = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(unchanged.prepare("PRAGMA user_version").get()?.user_version, 2);
    assert.equal(
      unchanged
        .prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name='artifacts'")
        .get()?.count,
      0,
    );
  } finally {
    unchanged.close();
  }
});
