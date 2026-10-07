import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendRevocation,
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
});
