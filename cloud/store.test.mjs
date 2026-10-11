import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { append, database } from "./store.mjs";

test("cloud database uses a standard PostgreSQL Pool for Supabase", async () => {
  process.env.DATABASE_URL = "postgresql://void_test:secret@127.0.0.1:5432/void_test";
  const pool = database();
  assert.ok(pool instanceof Pool);
  assert.equal(pool.options.connectionString, process.env.DATABASE_URL);
  assert.equal(pool.options.max, 3);
  await pool.end();
});

/** A signing key `signer()` accepts, so `append` can be exercised without a
 * database and without touching the developer's real key directory. */
const withSigningKey = async (run) => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const previous = process.env.NOMO_SIGNING_KEY;
  process.env.NOMO_SIGNING_KEY = privateKey
    .export({ format: "der", type: "pkcs8" })
    .toString("base64");
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.NOMO_SIGNING_KEY;
    else process.env.NOMO_SIGNING_KEY = previous;
  }
};

const recordingClient = () => {
  const calls = [];
  return {
    calls,
    query: async (text, params) => {
      calls.push({ text, params });
      return { rows: [] };
    },
  };
};

test("the ledger append locks the owner and workspace before it reads a sequence", async () => {
  await withSigningKey(async () => {
    const owner = randomUUID();
    const client = recordingClient();
    const body = {
      workspace: "agent-shared",
      at: new Date().toISOString(),
      tool: "void_test",
      klass: "r1",
      decision: "execute:completed",
    };
    await append(owner, body, client);

    const lock = client.calls.findIndex((c) => /pg_advisory_xact_lock/.test(c.text));
    const read = client.calls.findIndex((c) => /FROM void_cloud_ledger/.test(c.text));
    assert.notEqual(lock, -1, "append must take an advisory lock");
    assert.notEqual(read, -1, "append must read the previous entry");
    assert.ok(
      lock < read,
      "the lock must be taken before the sequence number is decided, or two sessions in one workspace both read the same last seq and the second insert fails on the primary key",
    );
    assert.deepEqual(
      client.calls[lock].params,
      [owner, body.workspace],
      "the lock must carry the owner and the workspace as bound parameters",
    );
  });
});

test("sessions sharing a workspace contend on one lock, and separate workspaces do not", async () => {
  await withSigningKey(async () => {
    const owner = randomUUID();
    const locks = async (workspace) => {
      const client = recordingClient();
      await append(owner, { workspace, at: new Date().toISOString() }, client);
      return client.calls.find((c) => /pg_advisory_xact_lock/.test(c.text)).params;
    };
    // Two different sessions in one workspace must take the same lock, which
    // is what stops them interleaving their read-then-insert.
    assert.deepEqual(await locks("agent-shared"), await locks("agent-shared"));
    assert.notDeepEqual(await locks("agent-shared"), await locks("agent-other"));
  });
});

test("owner routing stays out of the canonical ledger entry", async () => {
  await withSigningKey(async () => {
    const owner = randomUUID();
    const body = { workspace: "agent-shared", at: new Date().toISOString() };
    const entry = await append(owner, body, recordingClient());
    // The entry is what gets hashed and signed, so an owner inside it would
    // make the same operation hash differently per account and would publish
    // the tenant boundary inside a document the ledger hands to a verifier.
    assert.equal("owner" in entry, false);
    assert.equal(entry.workspace, body.workspace);
    assert.equal("owner" in entry.body, false);
  });
});
