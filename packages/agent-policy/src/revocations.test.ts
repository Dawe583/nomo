import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendRevocation,
  isUtcInstant,
  parseRevocations,
  readRevocations,
  revocationView,
  RevocationStoreError,
  type RevocationRecord,
} from "./revocations.ts";

const record = (over: Partial<RevocationRecord> = {}): RevocationRecord => ({
  kind: "kill",
  agentId: "demo-support-bot",
  at: "2026-10-07T18:00:00.000Z",
  by: "oliver",
  reason: "demo",
  ...over,
});

describe("revocation store", () => {
  test("the last act on an agent is its state", () => {
    const view = revocationView([
      record(),
      record({ kind: "reinstate", at: "2026-10-07T18:01:00.000Z" }),
      record({ agentId: "demo-report-bot" }),
    ]);
    assert.equal(view.isKilled("demo-support-bot"), false);
    assert.equal(view.isKilled("demo-report-bot"), true);
    assert.equal(view.isKilled("never-seen"), false);
    assert.deepEqual(view.kills("demo-support-bot"), [
      Date.parse("2026-10-07T18:00:00.000Z"),
    ]);
  });

  test("a missing file is an empty store, a corrupt one is an error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nomo-revocations-"));
    try {
      assert.deepEqual(await readRevocations(join(dir, "absent.jsonl")), []);
      const corrupt = join(dir, "corrupt.jsonl");
      await writeFile(corrupt, '{"kind":"kill"\n', "utf8");
      await assert.rejects(readRevocations(corrupt), RevocationStoreError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an appended kill reads back", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nomo-revocations-"));
    const path = join(dir, "revocations.jsonl");
    try {
      await appendRevocation(path, record());
      await appendRevocation(
        path,
        record({ kind: "reinstate", at: "2026-10-07T18:00:05.000Z" }),
      );
      const records = await readRevocations(path);
      assert.equal(records.length, 2);
      assert.equal(revocationView(records).isKilled("demo-support-bot"), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an invalid record is refused on write and on read", async () => {
    await assert.rejects(
      appendRevocation("unused.jsonl", record({ agentId: "Not Valid" })),
      RevocationStoreError,
    );
    assert.throws(
      () =>
        parseRevocations(JSON.stringify(record({ kind: "pause" as never }))),
      /kind must be kill or reinstate/,
    );
  });

  test("at is accepted only as a UTC instant with a Z", async () => {
    for (const at of [
      "2026-10-07T18:00:00Z",
      "2026-10-07T18:00:00.123Z",
      "2026-10-07T18:00:00.123456Z",
      new Date("2026-10-07T18:00:00Z").toISOString(),
    ])
      assert.equal(isUtcInstant(at), true, at);
    for (const at of [
      "2026-10-07T18:00:00", // Date.parse reads this as local time
      "2026-10-07T18:00:00+02:00",
      "2026-10-07T18:00:00+00:00",
      "2026-10-07T18:00:00z",
      "2026-10-07",
      "2026-02-30T00:00:00Z", // Date.parse rolls this into March
      "2026-10-07T24:00:00Z",
      " 2026-10-07T18:00:00Z",
      1791396000000,
    ])
      assert.equal(isUtcInstant(at), false, String(at));

    assert.throws(
      () =>
        parseRevocations(
          JSON.stringify(record({ at: "2026-10-07T20:00:00+02:00" })),
        ),
      /revocations line 1: at must be an ISO 8601 time in UTC, ending in Z/,
    );
    await assert.rejects(
      appendRevocation("unused.jsonl", record({ at: "2026-10-07T18:00:00" })),
      RevocationStoreError,
    );
  });
});
