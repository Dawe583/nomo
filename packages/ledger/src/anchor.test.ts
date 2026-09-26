import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendAnchor, checkAnchors, readAnchors } from "./anchor.ts";
import { attestLedger, verifyAnchor, type AttestationDocument } from "./attest.ts";
import { entryHash } from "./canonical.ts";
import { devKeyProvider, sha256Hex } from "./sign.ts";
import { jsonlStore } from "./store.ts";
import { readLedgerEntries, verifyChain } from "./verify.ts";

const workspace = "anchor-ws";

const seed = async (dir: string, count: number) => {
  const key = await devKeyProvider({ dir: join(dir, "keys"), env: {} });
  const store = jsonlStore(key, { dir });
  for (let index = 1; index <= count; index += 1)
    await store.append({
      workspace,
      at: `2026-09-26T00:00:0${index}.000Z`,
      tool: `fixture.step.${index}`,
      klass: "r0",
      decision: "allow",
      argsDigest: `${index}`.repeat(64),
    });
  return { key, file: join(dir, `${workspace}.jsonl`) };
};

const scratch = async (t: { after: (fn: () => unknown) => void }, prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

const lookup = (key: Awaited<ReturnType<typeof devKeyProvider>>) => (id: string) => key.publicKey(id);

/** The documents in an anchor file, or a thrown assertion for a failed read. */
const anchorsIn = async (path: string): Promise<readonly AttestationDocument[]> => {
  const read = await readAnchors(path);
  assert.equal(read.ok, true, read.ok ? undefined : read.reason);
  return read.ok ? read.anchors : [];
};

describe("verifyAnchor", () => {
  test("an anchored chain matches, and a longer one is growth rather than a failure", async (t) => {
    const dir = await scratch(t, "void-anchor-grow-");
    const { key, file } = await seed(dir, 3);
    const doc = await attestLedger(dir, workspace, key);
    const entries = await readLedgerEntries(file);

    const anchored = await verifyAnchor(doc, entries, { publicKey: lookup(key) });
    assert.equal(anchored.ok, true);
    assert.equal(anchored.ok && anchored.grown, 0);
    assert.equal(anchored.ok && anchored.headSeq, 3);

    await jsonlStore(key, { dir }).append({
      workspace,
      at: "2026-09-26T00:00:09.000Z",
      tool: "fixture.step.4",
      klass: "r0",
      decision: "allow",
      argsDigest: "4".repeat(64),
    });
    const grown = await verifyAnchor(doc, await readLedgerEntries(file), { publicKey: lookup(key) });
    assert.equal(grown.ok, true);
    assert.equal(grown.ok && grown.grown, 1);
  });

  test("a truncated but internally consistent chain fails", async (t) => {
    const dir = await scratch(t, "void-anchor-truncate-");
    const { key, file } = await seed(dir, 4);
    const doc = await attestLedger(dir, workspace, key);
    const entries = await readLedgerEntries(file);

    // Drop the tail. `verifyChain` is happy: a prefix is a valid chain.
    const truncated = entries.slice(0, 2);
    assert.equal((await verifyChain(truncated)).ok, true);

    const checked = await verifyAnchor(doc, truncated, { publicKey: lookup(key) });
    assert.equal(checked.ok, false);
    assert.match(checked.ok === false ? checked.reason : "", /shorter than the anchor/);
  });

  test("an entry rewritten under the anchor fails on the anchored head", async (t) => {
    const dir = await scratch(t, "void-anchor-rewrite-");
    const { key, file } = await seed(dir, 3);
    const doc = await attestLedger(dir, workspace, key);
    const lines = (await readFile(file, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    // The whole chain is rehashed, exactly as an attacker holding the signing
    // key would do it, so only the anchored head can tell.
    (lines[1]!["body"] as Record<string, unknown>)["tool"] = "aws.s3.object.put";
    for (const [index, entry] of lines.entries()) {
      entry["prev_hash"] = index === 0 ? entry["prev_hash"] : lines[index - 1]!["hash"];
      entry["hash"] = await entryHash(entry["body"]!, String(entry["prev_hash"]), sha256Hex);
    }
    await writeFile(file, `${lines.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

    const checked = await verifyAnchor(doc, await readLedgerEntries(file), { publicKey: lookup(key) });
    assert.equal(checked.ok, false);
    assert.match(checked.ok === false ? checked.reason : "", /the anchored head was/);
  });

  test("an anchor signed by another key is not evidence of anything", async (t) => {
    const dir = await scratch(t, "void-anchor-key-");
    const { key, file } = await seed(dir, 2);
    const doc = await attestLedger(dir, workspace, key);
    const other = await devKeyProvider({ dir: join(dir, "other-keys"), env: {} });
    const entries = await readLedgerEntries(file);
    const checked = await verifyAnchor(doc, entries, { publicKey: lookup(other) });
    assert.equal(checked.ok, false);
    assert.match(checked.ok === false ? checked.reason : "", /no public key for attestation key/);
  });
});

describe("anchor files", () => {
  test("an appended anchor file is read back and checked", async (t) => {
    const dir = await scratch(t, "void-anchor-file-");
    const { key, file } = await seed(dir, 2);
    const anchorFile = join(dir, "out-of-band", "anchors.jsonl");
    const first: AttestationDocument = await attestLedger(dir, workspace, key);
    await appendAnchor(anchorFile, first);

    await jsonlStore(key, { dir }).append({
      workspace,
      at: "2026-09-26T00:00:03.000Z",
      tool: "fixture.step.3",
      klass: "r0",
      decision: "allow",
      argsDigest: "3".repeat(64),
    });
    await appendAnchor(anchorFile, await attestLedger(dir, workspace, key));

    const anchors = await anchorsIn(anchorFile);
    assert.equal(anchors.length, 2);
    const checked = await checkAnchors(anchors, await readLedgerEntries(file), {
      publicKey: lookup(key),
    });
    assert.equal(checked.ok, true);
    assert.equal(checked.ok && checked.anchors, 2);
    assert.equal(checked.ok && checked.headSeq, 3);
  });

  test("a chain shorter than the anchor file fails, an empty file is not an anchor", async (t) => {
    const dir = await scratch(t, "void-anchor-short-");
    const { key, file } = await seed(dir, 3);
    const anchorFile = join(dir, "anchors.jsonl");
    await appendAnchor(anchorFile, await attestLedger(dir, workspace, key));
    const anchors = await anchorsIn(anchorFile);

    const shortened = await checkAnchors(anchors, (await readLedgerEntries(file)).slice(0, 1), {
      publicKey: lookup(key),
    });
    assert.equal(shortened.ok, false);
    assert.match(shortened.ok === false ? shortened.reason : "", /shorter than the anchor/);

    const none = await checkAnchors([], await readLedgerEntries(file), { publicKey: lookup(key) });
    assert.equal(none.ok, false);
    assert.match(none.ok === false ? none.reason : "", /holds no anchors/);
  });

  test("two anchors claiming one head with different hashes are refused", async (t) => {
    const dir = await scratch(t, "void-anchor-forged-file-");
    const { key, file } = await seed(dir, 2);
    const anchorFile = join(dir, "anchors.jsonl");
    await appendAnchor(anchorFile, await attestLedger(dir, workspace, key));
    const [first] = await anchorsIn(anchorFile);
    // A second anchor for the same head with a different head hash is the one
    // in-place contradiction the anchor set does catch.
    await appendAnchor(anchorFile, { ...first!, headHash: "f".repeat(64) });
    const checked = await checkAnchors(await anchorsIn(anchorFile), await readLedgerEntries(file), {
      publicKey: lookup(key),
    });
    assert.equal(checked.ok, false);
    assert.match(checked.ok === false ? checked.reason : "", /two anchors claim head/);
  });

  test("deleting anchor lines is NOT caught: a shrink needs a copy held elsewhere", async (t) => {
    // The limitation, pinned as a test so it cannot quietly return. The
    // ordering and head rules hold only across the anchors still present, and
    // nothing records how many there were, so a deleted line is invisible. The
    // only way to see it is to compare against a copy of the anchor set the
    // agent cannot rewrite.
    const dir = await scratch(t, "void-anchor-shrink-");
    const { key, file } = await seed(dir, 3);
    const anchorFile = join(dir, "anchors.jsonl");
    await appendAnchor(anchorFile, await attestLedger(dir, workspace, key));
    await jsonlStore(key, { dir }).append({
      workspace,
      at: "2026-09-26T00:00:04.000Z",
      tool: "fixture.step.4",
      klass: "r0",
      decision: "allow",
      argsDigest: "4".repeat(64),
    });
    await appendAnchor(anchorFile, await attestLedger(dir, workspace, key));
    const entries = await readLedgerEntries(file);
    const full = await checkAnchors(await anchorsIn(anchorFile), entries, {
      publicKey: lookup(key),
    });
    assert.equal(full.ok, true);

    // Drop the earlier anchor. The remaining anchor still covers the whole
    // ledger prefix, so nothing contradicts anything and the check passes with
    // one fewer anchor: exactly what an attacker deleting a line gets.
    const [dropped] = await anchorsIn(anchorFile);
    await writeFile(anchorFile, `${JSON.stringify((await anchorsIn(anchorFile))[1]!)}\n`);
    const shrunk = await checkAnchors(await anchorsIn(anchorFile), entries, {
      publicKey: lookup(key),
    });
    assert.equal(shrunk.ok, true);
    assert.equal(shrunk.ok && shrunk.anchors, 1);
    assert.equal(dropped!.headSeq, 3);
  });

  test("anchors that go backwards are refused", async (t) => {
    const dir = await scratch(t, "void-anchor-backwards-");
    const { key, file } = await seed(dir, 2);
    const earlier = await attestLedger(dir, workspace, key, { now: () => new Date("2026-09-26T01:00:00.000Z") });
    await jsonlStore(key, { dir }).append({
      workspace,
      at: "2026-09-26T01:30:00.000Z",
      tool: "fixture.step.3",
      klass: "r0",
      decision: "allow",
      argsDigest: "3".repeat(64),
    });
    const later = await attestLedger(dir, workspace, key, { now: () => new Date("2026-09-26T02:00:00.000Z") });
    assert.equal(earlier.headSeq, 2);
    assert.equal(later.headSeq, 3);
    const anchorFile = join(dir, "anchors.jsonl");
    await appendAnchor(anchorFile, later);
    await appendAnchor(anchorFile, earlier);
    const checked = await checkAnchors(await anchorsIn(anchorFile), await readLedgerEntries(file), {
      publicKey: lookup(key),
    });
    assert.equal(checked.ok, false);
    assert.match(checked.ok === false ? checked.reason : "", /out of order/);
  });
});
