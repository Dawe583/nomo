import test, { describe } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

import { connectorFor, connectorRegistry, makeConnector, type ConnectorCall, type S3Client } from "./registry.ts";
import type { QueryExecutor } from "./postgres/capture.ts";
import type { SnapshotReference, SnapshotStore } from "./snapshot/store.ts";

// `makeConnector` used to allocate a `Map<string, StoredPostgresCapture>` and a
// `Map<string, StoredS3Capture>`, write every capture into them, and never read
// them back: `inverse` and `apply` both resolve the capture through
// `readPostgresCapture`/`readS3Capture`, which load the envelope out of the
// snapshot store. The S3 restart test below is the proof that the map is not
// load-bearing — a second connector built over the same store produces the
// identical plan — so the maps were write-only retention of a full
// before-image plus derived steps, growing for the life of the process for no
// reader at all.
//
// The maps are deleted rather than capped because a cap on a map with no
// reader only makes the leak slower. This test keeps the deletion honest: it
// asserts the source allocates none and touches none, so a capture map cannot
// be reintroduced unnoticed. A future in-process map that genuinely has a
// reader must arrive with a named ceiling, as `probeCache` now does, and this
// assertion widens to accept it at that point.
test("the registry keeps no in-process capture map: every capture resolves through the store", () => {
  const source = readFileSync(new URL("./registry.ts", import.meta.url), "utf8");

  assert.equal(
    /new Map<\s*string,\s*Stored(?:Postgres|S3)Capture\s*>/.test(source),
    false,
    "registry.ts must not allocate a capture map: captures are read back through the snapshot store, so an in-process map is unbounded retention with no reader",
  );
  assert.equal(
    /\bcaptures\.(?:set|get|has|delete|clear)\(/.test(source),
    false,
    "registry.ts must not read or write a capture map",
  );
});

test("captures survive many writes without any in-process retention", async () => {
  const store = new MemorySnapshotStore();
  const client = new FakeS3Client();
  await client.putObject({ bucket: "bucket", key: "key", body: encoder.encode("before") });
  const registry = makeConnector({ store, s3: client });

  // Every entry the deleted maps used to hold is still reachable afterwards:
  // the snapshot store is the only retention, and it is the one that survives
  // a restart. This is the behaviour the maps were duplicating.
  const references = [];
  for (let index = 0; index < 50; index += 1) {
    references.push(await registry.s3.capture({
      tool: "s3.object.delete",
      connector: "s3",
      arguments: { bucket: "bucket", key: "key" },
      workspace: "workspace-a",
    }));
  }
  for (const capture of references) {
    const plan = await makeConnector({ store, s3: client }).s3.inverse(capture.reference);
    assert.equal(plan.steps[0]?.target, "s3://bucket/key");
  }
});

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("connector registry", () => {
  test("connectorFor maps vendor prefixes and returns null for unknown vendors", () => {
    const postgres = connectorFor("postgres.orders_delete");
    const s3 = connectorFor("s3.object_delete");

    assert.equal(postgres?.connectorId, "postgres");
    assert.equal(postgres?.connector.id, "postgres");
    assert.equal(s3?.connectorId, "s3");
    assert.equal(s3?.connector.id, "s3");
    assert.equal(connectorFor("stripe.refund_create"), null);
    assert.equal(connectorFor("unknown"), null);
  });

  test("registry binds connector functions and probe sets", () => {
    const registry = connectorRegistry();

    assert.deepEqual(Object.keys(registry).sort(), ["postgres", "s3"]);
    assert.equal(typeof registry.postgres.classify, "function");
    assert.equal(typeof registry.postgres.capture, "function");
    assert.equal(typeof registry.postgres.inverse, "function");
    assert.equal(typeof registry.postgres.apply, "function");
    assert.equal(registry.postgres.probes.length > 0, true);
    assert.equal(typeof registry.s3.classify, "function");
    assert.equal(typeof registry.s3.capture, "function");
    assert.equal(typeof registry.s3.inverse, "function");
    assert.equal(typeof registry.s3.apply, "function");
    assert.equal(registry.s3.probes.length > 0, true);
  });

  test("makeConnector wires Postgres capture and inverse with fake dependencies", async () => {
    const store = new MemorySnapshotStore();
    const exec = new FakeQueryExecutor({ "public.orders": [{ id: 1, status: "draft" }] });
    const registry = makeConnector({ store, exec });
    const call: ConnectorCall = {
      tool: "postgres.orders_update",
      connector: "postgres",
      arguments: {
        sql: "update public.orders set status = 'paid' where id = 1",
        schema: { tables: [{ table: "public.orders", primaryKey: ["id"] }] },
      },
      workspace: "workspace-a",
    };

    const capture = await registry.postgres.capture(call);
    const plan = await registry.postgres.inverse(capture.reference);

    assert.equal(capture.digest, capture.reference.digest);
    assert.equal(plan.connector, "postgres");
    assert.equal(plan.call.tool, call.tool);
    assert.equal(plan.steps[0]?.operation, "update");
    assert.equal(plan.steps[0]?.target, "public.orders");
    assert.equal(fact(capture.facts, "pg.capture.before_image"), "true");
  });

  test("makeConnector wires S3 capture and inverse with fake dependencies", async () => {
    const store = new MemorySnapshotStore();
    const client = new FakeS3Client();
    await client.putObject({ bucket: "bucket", key: "key", body: encoder.encode("before") });
    const registry = makeConnector({ store, s3: client });
    const call: ConnectorCall = {
      tool: "s3.object_delete",
      connector: "s3",
      arguments: { bucket: "bucket", key: "key" },
      workspace: "workspace-a",
    };

    const capture = await registry.s3.capture(call);
    const plan = await registry.s3.inverse(capture.reference);

    const restartedPlan = await makeConnector({ store, s3: client }).s3.inverse(capture.reference);
    assert.deepEqual(restartedPlan, plan);
    assert.equal(plan.connector, "s3");
    assert.equal(plan.steps[0]?.operation, "putObject");
    assert.match(plan.steps[0]?.inputDigest ?? "", /^sha256:/);
  });
});

class MemorySnapshotStore implements SnapshotStore {
  readonly values = new Map<string, Uint8Array>();

  async put(namespace: string, bytes: Uint8Array): Promise<{ readonly digest: `sha256:${string}`; readonly reference: SnapshotReference }> {
    const { sha256Digest } = await import("./snapshot/store.ts");
    const digest = sha256Digest(bytes);
    const reference = { namespace, digest, uri: `memory://${namespace}/${digest}` };
    this.values.set(reference.uri, new Uint8Array(bytes));
    return { digest, reference };
  }

  async get(reference: SnapshotReference): Promise<Uint8Array> {
    const value = this.values.get(reference.uri);
    if (value === undefined) throw new Error("missing snapshot");
    return new Uint8Array(value);
  }

  async retention(namespace: string): Promise<{ readonly namespace: string; readonly retainedBytes: number; readonly deleteOlderThan: () => Promise<{ readonly deleted: number; readonly freedBytes: number; readonly errors: readonly string[] }> }> {
    return { namespace, retainedBytes: 0, deleteOlderThan: async () => ({ deleted: 0, freedBytes: 0, errors: [] }) };
  }
}

class FakeQueryExecutor implements QueryExecutor {
  private readonly tables: Readonly<Record<string, readonly Record<string, unknown>[]>>;

  constructor(tables: Readonly<Record<string, readonly Record<string, unknown>[]>>) {
    this.tables = tables;
  }

  async query<T>(sql: string): Promise<T[]> {
    if (sql.includes("information_schema")) return [];
    const table = sql.includes("public") ? "public.orders" : "orders";
    return [...(this.tables[table] ?? [])] as T[];
  }
}

type StoredObject = { readonly body: Uint8Array; readonly etag: string; readonly versionId?: string };

class FakeS3Client implements S3Client {
  readonly objects = new Map<string, StoredObject>();

  async getBucketVersioning(): Promise<{ readonly status: "Enabled" | "Suspended" | "Disabled"; readonly mfaDelete: "Enabled" | "Disabled" }> {
    return { status: "Disabled", mfaDelete: "Disabled" };
  }

  async getObject(input: { readonly bucket: string; readonly key: string }): Promise<{ readonly body: Uint8Array; readonly etag: string; readonly versionId?: string }> {
    const stored = this.objects.get(`${input.bucket}/${input.key}`);
    if (stored === undefined) {
      const error = new Error("missing key") as Error & { code: string; statusCode: number };
      error.code = "NoSuchKey";
      error.statusCode = 404;
      throw error;
    }
    return { body: new Uint8Array(stored.body), etag: stored.etag, versionId: stored.versionId };
  }

  async putObject(input: { readonly bucket: string; readonly key: string; readonly body: Uint8Array }): Promise<{ readonly etag: string }> {
    const etag = `"${Buffer.from(input.body).toString("hex")}"`;
    this.objects.set(`${input.bucket}/${input.key}`, { body: new Uint8Array(input.body), etag });
    return { etag };
  }

  async deleteObject(): Promise<{ readonly deleteMarker: boolean }> {
    return { deleteMarker: false };
  }
}

function fact(facts: readonly { readonly name: string; readonly value: string | boolean }[], name: string): string | boolean | undefined {
  return facts.find((item) => item.name === name)?.value;
}

test('AWS S3 aliases resolve the same persisted connector', () => {
  assert.equal(connectorFor('aws.s3.object.delete')?.connectorId, 's3');
});
