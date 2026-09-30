import type { S3Client, S3DeleteCall } from "./classify.ts";
import { sha256, type SnapshotReference, type SnapshotStore } from "./capture.ts";
import { restoreObject } from "./inverse.ts";

export type DriftChange = {
  readonly target: string;
  readonly key: Readonly<Record<string, string>>;
  readonly field: string;
  readonly capturedDigest: `sha256:${string}`;
  readonly currentDigest: `sha256:${string}`;
};

export type ReplayRefusal = {
  readonly stepId: string;
  readonly reason: "drift" | "missing_target" | "permission_denied" | "internal_error" | "verification_failed" | "verification_unavailable";
  readonly changed: readonly DriftChange[];
};

export type ApplyReport = {
  readonly applied: readonly string[];
  readonly refused: readonly ReplayRefusal[];
  /** Written only for a step whose restore was read back and proved. */
  readonly receipts?: readonly RestoreReceipt[];
};

/**
 * The proof that a restore reached the bucket, kept in the customer's own
 * snapshot store rather than in a VOID log. It says the bytes read back from
 * the object hash to the bytes that were captured, and nothing more: it does
 * not say a delete marker was removed, which a put cannot do, and it is not a
 * statement about any bucket's semantics beyond the one object it read.
 */
export type RestoreReceipt = {
  readonly stepId: string;
  readonly bucket: string;
  readonly key: string;
  readonly restoredDigest: `sha256:${string}`;
  readonly capturedDigest: `sha256:${string}`;
  readonly etag?: string;
  readonly versionId?: string;
  readonly verifiedAt: string;
  /**
   * Digest of the receipt document as stored. The document cannot contain its
   * own digest, so this is attached on the way out and is absent inside it.
   */
  readonly reference?: `sha256:${string}`;
};

export type ApplyRestoreInput = {
  readonly stepId: string;
  readonly call: S3DeleteCall;
  readonly reference: SnapshotReference;
  readonly capturedEtag?: string;
};

export async function applyRestore(store: SnapshotStore, client: S3Client, input: ApplyRestoreInput): Promise<ApplyReport> {
  try { return await restore(store, client, input); }
  catch (error) {
    const status = statusOf(error);
    return { applied: [], refused: [{ stepId: input.stepId, reason: status === 401 || status === 403 ? "permission_denied" : "internal_error", changed: [] }] };
  }
}

/**
 * The HTTP status of an S3 error, wherever the SDK chose to put it.
 *
 * Two shapes exist in practice: the AWS SDK v3 puts it in `$metadata`, and a
 * raw fetch or a proxy in front of the bucket uses a plain `statusCode`. Both
 * are read here so a single rule applies everywhere it matters.
 *
 * This exists because the two call sites disagreed. The guard around the PUT
 * and the guard around the whole restore each classified a 403, and only one of
 * them called it a permission failure — so the same bucket refusing the same
 * write was reported as `permission_denied` or `internal_error` depending on
 * which frame caught it. A refusal reason is what tells an operator whether to
 * fix credentials or investigate a fault, so the two have to agree.
 */
function statusOf(error: unknown): number | undefined {
  const record = error as { $metadata?: { httpStatusCode?: number }; statusCode?: number } | null;
  return record?.$metadata?.httpStatusCode ?? record?.statusCode;
}

async function restore(store: SnapshotStore, client: S3Client, input: ApplyRestoreInput): Promise<ApplyReport> {
  const current = await client.getObject(input.call).catch((error: unknown) => {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  });

  if (input.capturedEtag !== undefined && current?.etag !== undefined && current.etag !== input.capturedEtag) {
    return {
      applied: [],
      refused: [{
        stepId: input.stepId,
        reason: "drift",
        changed: [{
          target: "s3.object",
          key: { bucket: input.call.bucket, key: input.call.key },
          field: "etag",
          capturedDigest: input.reference.digest,
          currentDigest: current.body === undefined ? sha256(new Uint8Array()) : sha256(current.body),
        }],
      }],
    };
  }

  const bytes = await store.get(input.reference);
  try {
    await restoreObject(client, input.call, { bytes, etag: input.capturedEtag, ...(current?.etag ? { ifMatch: current.etag } : { ifNoneMatch: "*" }) });
  } catch (error) {
    const conflict = statusOf(error);
    return { applied: [], refused: [{ stepId: input.stepId, reason: conflict === 412 || conflict === 409 ? "drift" : conflict === 401 || conflict === 403 ? "permission_denied" : "internal_error", changed: [] }] };
  }
  return await proveRestore(store, client, input, bytes);
}

/**
 * The post-write read. A put that reports success has not proved anything
 * about the object the bucket now holds: it proved the request was accepted.
 * This re-reads the object and compares the bytes against the capture, and
 * refuses rather than reporting an applied step it could not read back.
 *
 * Two refusals, kept apart on purpose. Bytes that differ are a fact about the
 * object. A read that could not be performed is not a fact about the object at
 * all, it is an absence of one, and calling that a mismatch would report a
 * disagreement the system never had.
 *
 * What this evidence is worth, stated plainly: it is a read through the same
 * client, the same credentials and the same endpoint that did the write, over
 * an in-memory client in every test in this repository. It proves the code
 * compares what it wrote against what it reads back. It proves nothing about
 * real bucket semantics, and no test here may be read as a certification of
 * them. The receipt is written through the same durable store the before image
 * went into, so it survives the process that produced it.
 */
async function proveRestore(
  store: SnapshotStore,
  client: S3Client,
  input: ApplyRestoreInput,
  bytes: Uint8Array,
): Promise<ApplyReport> {
  const expected = sha256(bytes);
  const observed = await client.getObject(input.call).catch(() => undefined);
  if (observed?.body === undefined)
    return {
      applied: [],
      refused: [{ stepId: input.stepId, reason: "verification_unavailable", changed: [] }],
    };
  const digest = sha256(observed.body);
  if (digest !== expected)
    return {
      applied: [],
      refused: [{
        stepId: input.stepId,
        reason: "verification_failed",
        changed: [{
          target: "s3.object",
          key: { bucket: input.call.bucket, key: input.call.key },
          field: "body",
          capturedDigest: expected,
          currentDigest: digest,
        }],
      }],
    };
  const receipt: RestoreReceipt = {
    stepId: input.stepId,
    bucket: input.call.bucket,
    key: input.call.key,
    restoredDigest: digest,
    capturedDigest: input.reference.digest,
    ...(observed.etag === undefined ? {} : { etag: observed.etag }),
    ...(observed.versionId === undefined ? {} : { versionId: observed.versionId }),
    verifiedAt: new Date().toISOString(),
  };
  const stored = await store.put("s3-restore", new TextEncoder().encode(JSON.stringify({ version: "void.s3.restore.v1", ...receipt })), {
    stepId: input.stepId,
    bucket: input.call.bucket,
    key: input.call.key,
  });
  return {
    applied: [input.stepId],
    refused: [],
    receipts: [{ ...receipt, reference: stored.reference.digest }],
  };
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const record = error as Readonly<Record<string, unknown>>;
  return record.name === "NoSuchKey" || record.code === "NoSuchKey" || record.statusCode === 404;
}
