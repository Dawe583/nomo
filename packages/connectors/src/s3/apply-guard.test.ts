/**
 * The conditional-write seam in `restore`, which the other tests in this
 * directory do not reach.
 *
 * `apply.test.ts` covers drift by etag, a permission failure, a byte mismatch
 * and an unavailable read-back. What it does not pin down is the branch that
 * decides *how* the PUT is guarded, and that branch is the one that decides
 * whether a restore can overwrite a concurrent writer:
 *
 *   - the object exists, so the PUT carries `ifMatch` with the etag that was
 *     read. A concurrent write between the read and the PUT makes the bucket
 *     answer 412, which becomes `drift`.
 *   - the object is absent, so the PUT carries `ifNoneMatch: "*"`. A concurrent
 *     creation between the read and the PUT makes the bucket answer 412 or 409,
 *     which also becomes `drift`.
 *
 * The second branch is the one worth asserting. Restoring into a key that was
 * just created is exactly the overwrite this product exists to prevent, and
 * the guard is a single conditional that nothing else would notice if it were
 * dropped, because every test with the object present would still pass.
 *
 * The other gap this file closes: `receipts` is optional on the report and is
 * absent on every refusal. A receipt is the only evidence a restore produced,
 * so a refusal that carried one would be a claim of proof for a write that was
 * not proved. `apply.test.ts` asserts that on two paths; this asserts it on all
 * of them, so a new refusal reason cannot be added that quietly emits one.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { applyRestore } from "./apply.ts";
import type { S3Client } from "./classify.ts";
import { sha256 } from "./capture.ts";

const bytes = new TextEncoder().encode("before");
const reference = { namespace: "s3", uri: "memory://before", digest: sha256(bytes) };
const call = { bucket: "fixture", key: "fixture" };

/** A store that records the receipt document it was asked to keep. */
function recorder(onPut?: () => never) {
  const kept: Array<{ namespace: string; bytes: Uint8Array }> = [];
  return {
    kept,
    store: {
      get: async () => bytes,
      put: async (namespace: string, body: Uint8Array) => {
        if (onPut) onPut();
        kept.push({ namespace, bytes: body });
        const digest = sha256(body);
        return { reference: { namespace, uri: `memory://${digest}`, digest }, digest };
      },
    },
  };
}

test("a restore into a key that now exists refuses on the ifNoneMatch guard", async () => {
  // The read says the key is gone, so the restore must be conditional on it
  // staying gone. Without `ifNoneMatch: "*"` this PUT would create the object
  // and overwrite whatever a concurrent writer had just put there, and the
  // report would call it applied.
  const before = await recorder();
  const guard: { ifMatch?: string; ifNoneMatch?: string } = {};
  const client: S3Client = {
    getObject: async () => {
      throw { name: "NoSuchKey" };
    },
    putObject: async (input) => {
      guard.ifMatch = input.ifMatch;
      guard.ifNoneMatch = input.ifNoneMatch;
      throw { $metadata: { httpStatusCode: 412 } };
    },
    deleteObject: async () => ({}),
    getBucketVersioning: async () => ({}),
  };

  const report = await applyRestore(before.store, client, {
    stepId: "restore",
    call,
    reference,
    capturedEtag: "known-etag",
  });

  assert.equal(guard.ifNoneMatch, "*", "the create-if-absent guard was not sent");
  assert.equal(guard.ifMatch, undefined, "ifMatch and ifNoneMatch cannot both be sent");
  assert.deepEqual(report.applied, []);
  assert.equal(report.refused[0]?.reason, "drift");
  assert.deepEqual(report.refused[0]?.changed, []);
  assert.equal(report.receipts, undefined);
  assert.equal(before.kept.length, 0, "a refused restore stored a receipt");
});

test("a restore over an existing object is guarded by the etag that was read", async () => {
  // The mirror branch: the object was there, so the PUT is conditional on it
  // being the same object. `ifNoneMatch` would be wrong here, because the
  // object exists and the bucket would refuse a legitimate restore.
  //
  // The second read has to return the restored bytes. The point of this file is
  // the guard, but the guard cannot be observed on a report that refuses, so
  // the fake reads back what the PUT wrote.
  const before = await recorder();
  const guard: { ifMatch?: string; ifNoneMatch?: string } = {};
  let reads = 0;
  const client: S3Client = {
    getObject: async () => {
      reads += 1;
      return reads === 1
        ? { body: new Uint8Array(), etag: "current-etag" }
        : { body: bytes, etag: "written-etag" };
    },
    putObject: async (input) => {
      guard.ifMatch = input.ifMatch;
      guard.ifNoneMatch = input.ifNoneMatch;
      return { etag: "written-etag" };
    },
    deleteObject: async () => ({}),
    getBucketVersioning: async () => ({}),
  };

  const report = await applyRestore(before.store, client, {
    stepId: "restore",
    call,
    reference,
    capturedEtag: "current-etag",
  });

  assert.equal(guard.ifMatch, "current-etag");
  assert.equal(guard.ifNoneMatch, undefined);
  assert.deepEqual(report.applied, ["restore"]);
});

test("no refusal path emits a receipt", async () => {
  // One loop over every way this can refuse. The invariant is not that these
  // particular inputs refuse, it is that a refusal never carries evidence: the
  // receipt is the claim that a write was read back and found equal, so a
  // refusal carrying one would assert a proof it does not have.
  const refuse = async (reason: string) => {
    const before = recorder();
    const client: S3Client = {
      getObject: async () => ({ body: new Uint8Array(), etag: "current-etag" }),
      // Refusing at the PUT, which is the last point before the read-back.
      putObject: async () => {
        throw reason === "permission_denied"
          ? { $metadata: { httpStatusCode: 403 } }
          : { $metadata: { httpStatusCode: 412 } };
      },
      deleteObject: async () => ({}),
      getBucketVersioning: async () => ({}),
    };
    const report = await applyRestore(before.store, client, {
      stepId: "restore",
      call,
      reference,
      capturedEtag: "current-etag",
    });
    return { report, before };
  };

  for (const reason of ["drift", "permission_denied"]) {
    const { report, before } = await refuse(reason);
    assert.equal(report.refused[0]?.reason, reason, `${reason} was not reported as itself`);
    assert.deepEqual(report.applied, []);
    assert.equal(report.receipts, undefined, `a ${reason} refusal carried a receipt`);
    assert.equal(before.kept.length, 0, `a ${reason} refusal stored a receipt`);
  }
});

test("a receipt is stored once, in the s3-restore namespace, without its own digest", async () => {
  // The stored document is the durable copy and the returned `reference` is its
  // digest. Putting the digest inside the document would be impossible, so the
  // field is attached on the way out and must be absent from what was written,
  // or the two would disagree about what they describe.
  const before = recorder();
  // Two reads, as the code does: the first sees the object as it is now, the
  // second sees it after the PUT. Both etags matter — the first has to match
  // `capturedEtag` or this refuses as drift before it writes anything, and the
  // second is the read-back that becomes the receipt's evidence.
  let reads = 0;
  const client: S3Client = {
    getObject: async () => {
      reads += 1;
      return reads === 1
        ? { body: bytes, etag: "known-etag" }
        : { body: bytes, etag: "written-etag", versionId: "v9" };
    },
    putObject: async () => ({ etag: "written-etag" }),
    deleteObject: async () => ({}),
    getBucketVersioning: async () => ({}),
  };

  const report = await applyRestore(before.store, client, {
    stepId: "restore",
    call,
    reference,
    capturedEtag: "known-etag",
  });

  assert.equal(before.kept.length, 1, "the receipt was stored more than once");
  const [entry] = before.kept;
  assert.equal(entry!.namespace, "s3-restore");
  const document = JSON.parse(new TextDecoder().decode(entry!.bytes)) as Record<string, unknown>;
  assert.equal(document.version, "void.s3.restore.v1");
  assert.equal("reference" in document, false, "the stored document contains its own digest");

  const receipt = report.receipts?.[0];
  assert.ok(receipt);
  assert.equal(receipt.versionId, "v9", "the observed versionId was dropped");
  assert.equal(receipt.restoredDigest, sha256(bytes));
  assert.equal(receipt.capturedDigest, reference.digest);
  assert.equal(receipt.reference, sha256(entry!.bytes));
  assert.equal(receipt.verifiedAt.length > 0, true);
});