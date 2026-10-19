import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { devKeyProvider } from "../../ledger/src/sign.ts";
import { canonicalJson } from "../../ledger/src/canonical.ts";
import {
  reservedRecoveryVault,
  localRecoveryVault,
  localOperationJournal,
  recoveryRuntime,
  VaultCapacityError,
  type RecoveryAdapter,
  type Json,
} from "./index.ts";
import { digest } from "./journal.ts";
async function fixture(t: import("node:test").TestContext) {
  const root = await mkdtemp(join(tmpdir(), "nomo-reserved-"));
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
    /Vault worker states .* but the vault persists ./,
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
  await chmod(path, 0o600);

  await reservedRecoveryVault(f.root, f.keys, "first", capacity).reserve!(
    "one",
    "op",
  );
  const upgraded = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(upgraded.prepare("PRAGMA user_version").get()?.user_version, 2);
    assert.equal(
      upgraded
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='artifacts_key_id'")
        .get()?.name,
      "artifacts_key_id",
    );
    // Schema 2 carries retention: the evidence table and the artifact write
    // time the collector ages against.
    assert.equal(
      upgraded
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='retention'")
        .get()?.name,
      "retention",
    );
    const columns = upgraded
      .prepare("PRAGMA table_info(artifacts)")
      .all() as unknown as ReadonlyArray<{ name: string }>;
    assert.ok(columns.some((column) => column.name === "at"));
  } finally {
    upgraded.close();
  }
});

test("newer persisted vault schema is refused before accepting bounded work", async (t) => {
  const f = await fixture(t),
    path = join(f.root, "vault.sqlite");
  const future = new DatabaseSync(path);
  try {
    future.exec("PRAGMA user_version=3; CREATE TABLE settings(id INTEGER PRIMARY KEY CHECK(id=1),capacity TEXT NOT NULL)");
  } finally {
    future.close();
  }
  await chmod(path, 0o600);

  await assert.rejects(
    reservedRecoveryVault(f.root, f.keys, "first").reserve!("one", "op"),
    /unsupported.*schema|schema.*unsupported/i,
  );
  const unchanged = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(unchanged.prepare("PRAGMA user_version").get()?.user_version, 3);
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

/** A capture that cannot be held: the source yields chunks and never a value. */
const chunked = (bytes: Buffer, size = 256 * 1024) => ({
  async *[Symbol.asyncIterator]() {
    for (let at = 0; at < bytes.length; at += size)
      yield bytes.subarray(at, Math.min(at + size, bytes.length));
  },
});

test("a streamed capture round trips without holding the artifact in memory", async (t) => {
  const f = await fixture(t),
    capacity = { maxArtifactBytes: 64 * 1024 * 1024, maxTotalBytes: 256 * 1024 * 1024 },
    vault = reservedRecoveryVault(f.root, f.keys, "first", capacity);
  // 32 MiB of plaintext. The value path needs roughly 360 MB of resident
  // memory for this artifact (measured in a fresh process at this commit: a
  // full canonical JSON string, a Buffer.concat copy, and a base64 string four
  // thirds its size). The stream path must stay near the size of the one
  // allocation it cannot avoid, which is the SQLite blob binding.
  const size = 32 * 1024 * 1024,
    plain = Buffer.from(JSON.stringify({ blob: "x".repeat(size) }));
  await vault.reserve!("one", "op", ["capture"]);
  const reference = await vault.putStream("one", chunked(plain), {
    bytes: plain.byteLength,
    allocation: { operationId: "op", slot: "capture" },
  });
  let read = 0,
    largest = 0;
  for await (const chunk of vault.getStream("one", reference)) {
    read += chunk.byteLength;
    largest = Math.max(largest, chunk.byteLength);
  }
  assert.equal(read, plain.byteLength, "the streamed read returns every plaintext byte");
  assert.equal(
    largest,
    256 * 1024,
    "a chunked reader yields bounded chunks, not the whole artifact",
  );
  // It is the same artifact the value path stores, so the two agree.
  assert.deepEqual(await vault.get("one", reference), { blob: "x".repeat(size) });
  // Peak memory is measured in a child process: this process already holds
  // every other test's artifacts, so its resident high-water mark would say
  // nothing about this path.
  const worker = join(f.root, "measure.mjs");
  await writeFile(
    worker,
    `
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { reservedRecoveryVault } from ${JSON.stringify(new URL("./reserved-vault.ts", import.meta.url).href)};
const size = ${size};
const root = await mkdtemp(join(tmpdir(), "nomo-measure-"));
const vault = reservedRecoveryVault(join(root, "vault"), { k: randomBytes(32) }, "k", ${JSON.stringify(capacity)});
await vault.reserve("w", "op", ["capture"]);
const plain = Buffer.from(JSON.stringify({ blob: "x".repeat(size) }));
async function* chunks() { for (let at = 0; at < plain.length; at += 262144) yield plain.subarray(at, at + 262144); }
const before = process.memoryUsage().rss;
let peak = 0;
const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss - before); }, 1);
const ref = await vault.putStream("w", chunks(), { bytes: plain.length, allocation: { operationId: "op", slot: "capture" } });
let read = 0;
for await (const chunk of vault.getStream("w", ref)) read += chunk.length;
clearInterval(timer);
process.stdout.write(JSON.stringify({ peak, read, bytes: plain.length }));
await rm(root, { recursive: true, force: true });
`,
  );
  const child = execFileSync(
    process.execPath,
    ["--experimental-strip-types", worker],
    { encoding: "utf8" },
  );
  const measured = JSON.parse(child) as { peak: number; read: number; bytes: number };
  assert.equal(measured.read, plain.byteLength, "the child read every byte back");
  assert.ok(
    measured.peak < 160 * 1024 * 1024,
    `streamed round trip peaked at ${Math.round(measured.peak / 1048576)} MB for a ${Math.round(plain.byteLength / 1048576)} MB artifact; the value path needs about 360 MB`,
  );
});

test("a streamed artifact carries the same content digest the value path computes", async (t) => {
  const f = await fixture(t),
    vault = reservedRecoveryVault(f.root, f.keys, "first"),
    value = { blob: "x".repeat(4096), nested: { a: [1, 2, 3] } },
    plain = Buffer.from(canonicalJson(value));
  await vault.reserve!("one", "op", ["capture"]);
  await vault.reserve!("two", "op", ["capture"]);
  const streamed = await vault.putStream("one", chunked(plain), {
    bytes: plain.byteLength,
    allocation: { operationId: "op", slot: "capture" },
  });
  const stored = await vault.put("two", value, {
    operationId: "op",
    slot: "capture",
  });
  const rows = (workspace: string) => {
    const db = new DatabaseSync(join(f.root, "vault.sqlite"), { readOnly: true });
    try {
      return db
        .prepare("SELECT content_digest FROM artifacts WHERE workspace=? AND digest=?")
        .get(workspace, workspace === "one" ? streamed.digest : stored.digest);
    } finally {
      db.close();
    }
  };
  assert.equal(
    rows("one")?.content_digest,
    rows("two")?.content_digest,
    "a streamed write and a value write agree on what the evidence is",
  );
  assert.equal(rows("one")?.content_digest, digest(value));
});

test("a stream that lies about its length stores nothing", async (t) => {
  const f = await fixture(t),
    capacity = { maxArtifactBytes: 1024, maxTotalBytes: 4096 },
    vault = reservedRecoveryVault(f.root, f.keys, "first", capacity);
  const over = Buffer.alloc(2048),
    under = Buffer.alloc(512);
  // Declared over the quota: the refusal lands before the source is read at
  // all, so a hostile stream costs no chunk of work.
  let touched = 0;
  await assert.rejects(
    vault.putStream("one", {
      async *[Symbol.asyncIterator]() {
        touched += 1;
        yield over;
      },
    }, { bytes: 2048 }),
    (error: unknown) => {
      assert.ok(error instanceof VaultCapacityError, String(error));
      return true;
    },
  );
  assert.equal(touched, 0, "an over-quota declaration must not read the source");
  // Declared within the quota but delivered differently: refused, and nothing
  // is left behind that a later reader could mistake for a stored artifact.
  for (const [payload, declared] of [
    [over, 1024],
    [under, 1024],
  ] as const)
    await assert.rejects(
      vault.putStream("one", chunked(payload, 512), { bytes: declared }),
      /exceeded the byte count it declared|ended before the byte count it declared/,
    );
  // One legitimate write establishes the schema, and it is the only row: a
  // refused stream leaves neither an artifact nor a partial payload.
  const kept = await vault.put("two", "stored");
  const db = new DatabaseSync(join(f.root, "vault.sqlite"), { readOnly: true });
  try {
    const rows = db
      .prepare("SELECT digest FROM artifacts WHERE workspace='one'")
      .all();
    assert.deepEqual(rows, [], "a refused stream stores nothing under its workspace");
    assert.equal(
      db.prepare("SELECT count(*) AS count FROM artifacts").get()?.count,
      1,
      "only the legitimate artifact is stored",
    );
  } finally {
    db.close();
  }
  assert.equal(await vault.get("two", kept), "stored");
});

test("a streamed write obeys the same reservation and slot rules as a value write", async (t) => {
  const f = await fixture(t),
    vault = reservedRecoveryVault(f.root, f.keys, "first"),
    plain = Buffer.from(canonicalJson({ value: "before" }));
  await assert.rejects(
    vault.putStream("one", chunked(plain), {
      bytes: plain.byteLength,
      allocation: { operationId: "unreserved", slot: "capture" },
    }),
    /not reserved/,
  );
  await vault.reserve!("one", "op", ["capture"]);
  const first = await vault.putStream("one", chunked(plain), {
    bytes: plain.byteLength,
    allocation: { operationId: "op", slot: "capture" },
  });
  // The same bytes retry to the same artifact, exactly as a value write does.
  assert.deepEqual(
    await vault.putStream("one", chunked(plain), {
      bytes: plain.byteLength,
      allocation: { operationId: "op", slot: "capture" },
    }),
    first,
    "a slot retry returns the artifact already stored",
  );
  const changed = Buffer.from(canonicalJson({ value: "after" }));
  await assert.rejects(
    vault.putStream("one", chunked(changed), {
      bytes: changed.byteLength,
      allocation: { operationId: "op", slot: "capture" },
    }),
    /different evidence/,
  );
  assert.deepEqual(await vault.get("one", first), { value: "before" });
});

test("a streamed read refuses a legacy artifact, a wrong key and a corrupted payload", async (t) => {
  const f = await fixture(t),
    legacy = localRecoveryVault(f.root, f.keys, "first", 1024),
    old = await legacy.put("one", "legacy bytes"),
    vault = reservedRecoveryVault(f.root, f.keys, "first"),
    plain = Buffer.from(canonicalJson("managed"));
  const managed = await vault.putStream("two", chunked(plain), {
    bytes: plain.byteLength,
  });
  await assert.rejects(
    (async () => {
      for await (const _ of vault.getStream("one", old));
    })(),
    /legacy file artifact has no chunked reader/,
  );
  // A reader that does not hold the key the artifact was written under cannot
  // decrypt it, and must say so rather than yield unauthenticated bytes.
  const holder = reservedRecoveryVault(f.root, f.keys, "second"),
    underSecond = await holder.putStream("two", chunked(plain), {
      bytes: plain.byteLength,
    });
  const withoutKey = reservedRecoveryVault(f.root, { first: f.keys.first }, "first");
  await assert.rejects(
    (async () => {
      for await (const _ of withoutKey.getStream("two", underSecond));
    })(),
    /key unavailable/,
  );
  // Flipping one ciphertext byte must refuse rather than yield forged bytes.
  const db = new DatabaseSync(join(f.root, "vault.sqlite"));
  try {
    const row = db
      .prepare("SELECT data FROM artifacts WHERE workspace=? AND digest=?")
      .get("two", managed.digest);
    if (typeof row !== "object" || row === null || !("data" in row))
      throw new Error("the streamed artifact row is unavailable");
    const data = Buffer.from(row.data as Uint8Array);
    data[data.length - 1] ^= 0xff;
    db.prepare("UPDATE artifacts SET data=? WHERE workspace=? AND digest=?").run(
      data,
      "two",
      managed.digest,
    );
  } finally {
    db.close();
  }
  await assert.rejects(
    (async () => {
      for await (const _ of vault.getStream("two", managed));
    })(),
    /digest or size mismatch/,
  );
});

test("a capacity migration moves capacity explicitly, once, and is recorded", async (t) => {
  const f = await fixture(t),
    before = { maxArtifactBytes: 1024, maxTotalBytes: 4 * 1052 },
    after = { maxArtifactBytes: 4096, maxTotalBytes: 64 * 1052 },
    original = reservedRecoveryVault(f.root, f.keys, "first", before);
  await original.put("one", "retained evidence");
  // A worker built with the new capacity is refused until an operator moves it,
  // which is the point: capacity never follows from ordinary use.
  await assert.rejects(
    reservedRecoveryVault(f.root, f.keys, "first", after).reserve!("one", "op"),
    /Vault worker states .* but the vault persists ./,
  );
  const moved = await reservedRecoveryVault(f.root, f.keys, "first", after)
    .migrateCapacity({ from: before, operatorId: "ops-1" });
  assert.deepEqual(moved.from, before);
  assert.deepEqual(moved.to, after);
  assert.ok(moved.usedBytes > 0, "the move reports the bytes in force when it applied");
  // The move took effect: a worker on the new capacity writes and reads, and
  // the worker that held the old capacity is now the mismatched one.
  const after1 = reservedRecoveryVault(f.root, f.keys, "first", after),
    second = await after1.put("one", "written after the move");
  assert.equal(await after1.get("one", second), "written after the move");
  await assert.rejects(
    reservedRecoveryVault(f.root, f.keys, "first", before).reserve!("one", "op"),
    /Vault worker states .* but the vault persists ./,
  );
  // Replaying the same move is refused: the vault no longer holds what it
  // declared, so a stale operator decision cannot be applied twice.
  await assert.rejects(
    reservedRecoveryVault(f.root, f.keys, "first", before).migrateCapacity({
      from: before,
      operatorId: "ops-2",
    }),
    /believed the vault holds .* but the settings row records ./,
  );
  const db = new DatabaseSync(join(f.root, "vault.sqlite"), { readOnly: true });
  try {
    const row = db.prepare("SELECT * FROM capacity_migrations").get();
    assert.equal(row?.operator_id, "ops-1", "the operator that moved capacity is recorded");
    assert.equal(row?.from_capacity, canonicalJson(before));
    assert.equal(row?.to_capacity, canonicalJson(after));
    assert.equal(row?.used_bytes, moved.usedBytes);
    assert.equal(db.prepare("SELECT count(*) AS count FROM capacity_migrations").get()?.count, 1);
  } finally {
    db.close();
  }
});

test("a capacity migration below the stored bytes is refused and changes nothing", async (t) => {
  const f = await fixture(t),
    before = { maxArtifactBytes: 64 * 1024, maxTotalBytes: 256 * 1024 },
    vault = reservedRecoveryVault(f.root, f.keys, "first", before);
  const reference = await vault.put("one", "x".repeat(40 * 1024));
  const tooSmall = { maxArtifactBytes: 1024, maxTotalBytes: 8 * 1024 };
  await assert.rejects(
    reservedRecoveryVault(f.root, f.keys, "first", tooSmall).migrateCapacity({
      from: before,
      operatorId: "ops",
    }),
    (error: unknown) => {
      // The refusal names the precondition and the byte count it would strand.
      assert.match((error as Error).message, /cannot lower the total below the \d+ bytes/);
      return true;
    },
  );
  // Nothing moved: the vault still reads and still enforces the capacity it had.
  assert.equal(typeof await vault.get("one", reference), "string");
  const db = new DatabaseSync(join(f.root, "vault.sqlite"), { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT count(*) AS count FROM capacity_migrations").get()?.count, 0);
    assert.equal(
      db.prepare("SELECT capacity FROM settings WHERE id=1").get()?.capacity,
      canonicalJson(before),
    );
  } finally {
    db.close();
  }
});

test("ordinary vault traffic never migrates capacity", async (t) => {
  const f = await fixture(t),
    capacity = { maxArtifactBytes: 1024, maxTotalBytes: 8 * 1052 },
    vault = reservedRecoveryVault(f.root, f.keys, "first", capacity);
  await vault.reserve!("one", "op");
  await vault.put("one", "kept");
  await vault.put("two", "also kept");
  await vault.release!("one", "op");
  const db = new DatabaseSync(join(f.root, "vault.sqlite"), { readOnly: true });
  try {
    assert.equal(
      db.prepare("SELECT count(*) AS count FROM capacity_migrations").get()?.count,
      0,
      "writing, reserving and releasing are not capacity moves",
    );
    assert.equal(
      db.prepare("SELECT capacity FROM settings WHERE id=1").get()?.capacity,
      canonicalJson(capacity),
    );
  } finally {
    db.close();
  }
});
