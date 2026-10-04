import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GENESIS_PREV } from "./canonical.ts";
import { devKeyProvider } from "./sign.ts";
import { jsonlStore, type JsonlEntry, type JsonlFsyncEvent } from "./store.ts";
import { verifyLedgerFile } from "./verify.ts";
import type { KeyProvider } from "./index.ts";

const workspace = "group-commit-ws";

/** How many appends the concurrency tests issue at once. */
const CONCURRENCY = 32;

/** A group commit that still issues one fsync per append is not a group commit. */
const MAX_FSYNCS = Math.ceil(CONCURRENCY / 8);

// A deadline on the awaited IPC event, not a sleep: if the child stops sending
// the wait rejects instead of hanging the suite.
const CHILD_TIMEOUT_MS = 60_000;

type Body = {
  readonly workspace: string;
  readonly at: string;
  readonly tool: string;
  readonly klass: string;
  readonly decision: string;
  readonly argsDigest: string;
};

function body(index: number): Body {
  return {
    workspace,
    at: `2026-10-03T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
    tool: "aws.s3.bucket.delete",
    klass: "r3",
    decision: "allow",
    argsDigest: String(index % 10).repeat(64),
  };
}

function bodies(count: number): Body[] {
  return Array.from({ length: count }, (_, index) => body(index));
}

type Fixture = {
  readonly key: KeyProvider;
  readonly ledgerDir: string;
  readonly file: string;
};

async function fixture(t: { after: (fn: () => unknown) => void }): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "void-group-commit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const key = await devKeyProvider({ dir: join(dir, "keys"), env: {} });
  const ledgerDir = join(dir, "ledger");
  return { key, ledgerDir, file: join(ledgerDir, `${workspace}.jsonl`) };
}

/** Chain metadata straight off disk, in file order, with nothing recomputed. */
async function chainLinks(file: string): Promise<
  readonly Pick<JsonlEntry, "seq" | "prev_hash" | "hash">[]
> {
  const text = await readFile(file, "utf8");
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Pick<JsonlEntry, "seq" | "prev_hash" | "hash">);
}

describe("group commit", () => {
  test("N concurrent appends produce one chain every prev_hash links", async (t) => {
    const { key, ledgerDir, file } = await fixture(t);
    const store = jsonlStore(key, { dir: ledgerDir });

    await Promise.all(bodies(CONCURRENCY).map((entry) => store.append(entry)));

    const keyId = await key.currentKeyId();
    const publicKey = await key.publicKey(keyId);
    assert.ok(publicKey !== null);
    const result = await verifyLedgerFile(file, { publicKey });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.checked, CONCURRENCY);

    const lines = await chainLinks(file);
    assert.equal(lines.length, CONCURRENCY);
    let prev = GENESIS_PREV;
    for (const [index, line] of lines.entries()) {
      assert.equal(line.seq, index + 1, `entry ${index} carries the wrong seq`);
      assert.equal(line.prev_hash, prev, `entry ${line.seq} does not link to its predecessor`);
      prev = line.hash;
    }
  });

  test("N concurrent appends share fsyncs instead of queueing one each", async (t) => {
    const { key, ledgerDir } = await fixture(t);
    const fsyncs: JsonlFsyncEvent[] = [];
    const store = jsonlStore(key, {
      dir: ledgerDir,
      onFsync: (event) => {
        fsyncs.push(event);
      },
    });

    await Promise.all(bodies(CONCURRENCY).map((entry) => store.append(entry)));

    // Counted at the seam, never inferred from the clock: the number of syncs
    // is the claim, and a wall clock assertion would pass on a fast disk and
    // fail on a slow one while saying nothing about the mechanism.
    assert.ok(fsyncs.length > 0, "the store reported no fsync at all");
    assert.ok(
      fsyncs.length <= MAX_FSYNCS,
      `${CONCURRENCY} concurrent appends issued ${fsyncs.length} fsyncs`,
    );
    assert.equal(
      Math.max(...fsyncs.map((event) => event.seq)),
      CONCURRENCY,
      "the last group must cover the last append",
    );
  });

  test("a returned receipt is already fsynced and a killed in-flight append is not in the chain", async (t) => {
    const { key, ledgerDir, file } = await fixture(t);
    let syncedSeq = 0;
    let completedSyncs = 0;
    const store = jsonlStore(key, {
      dir: ledgerDir,
      onFsync: (event) => {
        syncedSeq = Math.max(syncedSeq, event.seq);
        completedSyncs += 1;
      },
    });

    const receipts = await Promise.all(
      bodies(CONCURRENCY).map(async (entry) => {
        const before = completedSyncs;
        const receipt = await store.append(entry);
        // The receipt is the durability claim: a sync that had not completed
        // when it resolved is a receipt the ledger cannot honour after a crash.
        assert.ok(
          syncedSeq >= receipt.seq,
          `receipt ${receipt.seq} resolved with only seq ${syncedSeq} fsynced`,
        );
        assert.ok(completedSyncs > before, `receipt ${receipt.seq} resolved without a sync`);
        // Readable through a handle opened after the receipt, from the file.
        const handle = await open(file, "r");
        const text = (await handle.readFile()).toString("utf8");
        await handle.close();
        assert.ok(text.includes(`"hash":"${receipt.hash}"`), "the receipt is not on disk");
        return receipt;
      }),
    );
    assert.equal(receipts.length, CONCURRENCY);

    await crashHalf(t);
  });
});

/**
 * The crash half, in its own directory because it needs a child process that
 * the parent can SIGKILL. The child acknowledges three appends and then stalls
 * inside the fourth, before any byte of it is written; the parent kills it and
 * the ledger must hold exactly the three acknowledged records, still linked.
 */
async function crashHalf(t: { after: (fn: () => unknown) => void }): Promise<void> {
  const acknowledged = 3;
  const dir = await mkdtemp(join(tmpdir(), "void-group-commit-crash-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // The child opens this same directory, so the parent can verify with the key.
  const key = await devKeyProvider({ dir: join(dir, "keys"), env: {} });
  const worker = join(dir, "worker.mjs");
  await writeFile(
    worker,
    `
import { join } from "node:path";
import { devKeyProvider } from ${JSON.stringify(new URL("./sign.ts", import.meta.url).href)};
import { jsonlStore } from ${JSON.stringify(new URL("./store.ts", import.meta.url).href)};
const root = process.env.TEST_ROOT;
const key = await devKeyProvider({ dir: join(root, "keys"), env: {} });
let stalled = false;
const signer = {
  alg: key.alg,
  currentKeyId: () => key.currentKeyId(),
  publicKey: (id) => key.publicKey(id),
  sign: async (input, id) => {
    // A stall, not a sleep: the parent kills the process while this promise is
    // pending, so the append is in flight and nothing is waiting on a clock.
    if (stalled) await new Promise(() => {});
    return key.sign(input, id);
  },
};
const store = jsonlStore(signer, {
  dir: join(root, "ledger"),
  onFsync: (event) => process.send({ type: "sync", seq: event.seq }),
});
for (let index = 1; index <= ${acknowledged}; index += 1) {
  const receipt = await store.append({
    workspace: ${JSON.stringify(workspace)},
    at: "2026-10-03T00:00:00.000Z",
    tool: "aws.s3.bucket.delete",
    klass: "r3",
    decision: "allow",
    argsDigest: "a".repeat(64),
    index,
  });
  process.send({ type: "ack", seq: receipt.seq, hash: receipt.hash });
}
stalled = true;
await store.append({
  workspace: ${JSON.stringify(workspace)},
  at: "2026-10-03T00:00:01.000Z",
  tool: "aws.s3.bucket.delete",
  klass: "r3",
  decision: "allow",
  argsDigest: "b".repeat(64),
});
process.send({ type: "returned" });
`,
  );

  const child: ChildProcess = fork(worker, [], {
    env: { ...process.env, TEST_ROOT: dir },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });

  const acks: { seq: number; hash: string }[] = [];
  let synced = 0;
  const exited = once(child, "exit");
  while (acks.length < acknowledged) {
    const [message] = (await once(child, "message", {
      signal: AbortSignal.timeout(CHILD_TIMEOUT_MS),
    })) as [{ type: string; seq: number; hash: string }];
    if (message.type === "ack") acks.push({ seq: message.seq, hash: message.hash });
    else if (message.type === "sync") synced = Math.max(synced, message.seq);
    else assert.fail(`the stalled append resolved (${message.type})`);
  }
  assert.equal(
    synced,
    acknowledged,
    "an acknowledged append must be covered by a completed sync before the receipt exists",
  );

  child.kill("SIGKILL");
  await exited;

  const file = join(dir, "ledger", `${workspace}.jsonl`);
  const result = await verifyLedgerFile(file, { publicKey: (id) => key.publicKey(id) });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.checked, acknowledged);
  const lines = await chainLinks(file);
  let prev = GENESIS_PREV;
  for (const line of lines) {
    assert.equal(line.prev_hash, prev, `entry ${line.seq} does not link to its predecessor`);
    prev = line.hash;
  }
  assert.equal(prev, acks[acknowledged - 1]!.hash);
}
