import { createHash } from "node:crypto";

/**
 * Snapshot store contract shared by the legacy connector capture path and the
 * managed recovery runtime.
 *
 * Pin, expiry, key binding and garbage collection are optional members rather
 * than required ones, and every default is fail closed. A store that does not
 * implement them cannot prove an artifact unpinned, readable or collectable, so
 * a caller must retain it. Making them required would have forced the in-memory
 * and S3 stores to advertise a guarantee they do not make, which is the failure
 * mode this contract exists to prevent.
 */

export type ConnectorId = string;
export type RegistryEntryId = string;
export type SnapshotNamespace = string;
export type SnapshotReference = {
  readonly namespace: string;
  readonly digest: `sha256:${string}`;
  readonly uri: string;
};
export type SnapshotPutResult = {
  readonly digest: `sha256:${string}`;
  readonly reference: SnapshotReference;
};
export type RetentionReport = {
  readonly deleted: number;
  readonly freedBytes: number;
  readonly errors: readonly string[];
  readonly skipped?: number;
};
export type RetentionPlan = {
  readonly namespace: SnapshotNamespace;
  readonly retainedBytes: number;
  readonly deleteOlderThan: (cutoff: Date) => Promise<RetentionReport>;
};
export type RedactionHook = (input: {
  readonly namespace: SnapshotNamespace;
  readonly bytes: Uint8Array;
  readonly metadata: Readonly<Record<string, string>>;
}) => Promise<Uint8Array>;

/** A pin is a hard retention promise. Only an explicit release may clear one. */
export type SnapshotPin = { readonly ownerId: string; readonly kind: string };

/** Declared capture facts. A store that cannot record them must refuse them. */
export type SnapshotPutOptions = {
  readonly expiresAt?: Date;
  readonly pin?: SnapshotPin;
  readonly keyId?: string;
  readonly formatVersion?: number;
};

/**
 * What a store durably knows about one artifact. `recorded: false` means
 * unknown, never "no pin", and `readable: false` means the bytes cannot be
 * demonstrated to be readable under a key this store holds.
 */
export type ArtifactState = {
  readonly digest: string;
  readonly recorded: boolean;
  readonly readable: boolean;
  readonly keyId?: string;
  readonly expiresAt?: string;
  readonly pin?: SnapshotPin;
  readonly formatVersion?: number;
};

export type GarbagePolicy = {
  /** Age authority: nothing modified at or after this instant is collectable. */
  readonly cutoff: Date;
  /** Restricts collection to these digests. Absent means an age based sweep. */
  readonly collectable?: ReadonlySet<string>;
  /**
   * Digests whose declared retention deadline has already passed. They are the
   * operator's own retention decision, so the modification time no longer
   * decides them; a freshly written expired capture is still collectable.
   */
  readonly expired?: ReadonlySet<string>;
  readonly protectedDigests?: ReadonlySet<string>;
};

export type GarbageReport = {
  readonly scanned: number;
  readonly deleted: number;
  /** Deltas the caller reconciles against its own index; never assumed. */
  readonly deletedDigests: readonly string[];
  readonly retained: number;
  readonly freedBytes: number;
  readonly skippedPinned: number;
  readonly skippedProtected: number;
  readonly skippedUnreadable: number;
  readonly errors: readonly string[];
};

export type SnapshotStore = {
  readonly put: (
    namespace: SnapshotNamespace,
    bytes: Uint8Array,
    metadata?: Readonly<Record<string, string>>,
    options?: SnapshotPutOptions,
  ) => Promise<SnapshotPutResult>;
  readonly get: (reference: SnapshotReference) => Promise<Uint8Array>;
  readonly retention: (namespace: SnapshotNamespace) => Promise<RetentionPlan>;
  readonly artifactState?: (
    reference: SnapshotReference,
  ) => Promise<ArtifactState | null>;
  /** Declared, not probed: the keys this store holds. An empty list holds none. */
  readonly availableKeyIds?: () => readonly string[];
  readonly collectGarbage?: (
    namespace: SnapshotNamespace,
    policy: GarbagePolicy,
  ) => Promise<GarbageReport>;
};

export type PutErrorKind =
  | "RedactionFailed"
  | "WriteFailed"
  | "RetentionFailed"
  | "InvalidNamespace"
  | "InvalidOptions"
  | "InternalError";
export type GetErrorKind =
  | "SnapshotUnavailable"
  | "DigestMismatch"
  | "ReadFailed"
  | "InvalidReference"
  | "KeyUnavailable"
  | "InternalError";

export type PutError = Error & {
  readonly kind: PutErrorKind;
  readonly namespace: SnapshotNamespace;
  readonly retryable: boolean;
  readonly cause: unknown;
};

export type GetError = Error & {
  readonly kind: GetErrorKind;
  readonly reference: SnapshotReference;
  readonly retryable: boolean;
  readonly cause: unknown;
};

export function sha256Digest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function makePutError(
  kind: PutErrorKind,
  namespace: SnapshotNamespace,
  message: string,
  cause?: unknown,
): PutError {
  return Object.assign(new Error(message), {
    kind,
    namespace,
    retryable: kind === "WriteFailed" || kind === "RetentionFailed",
    cause,
  });
}

export function makeGetError(
  kind: GetErrorKind,
  reference: SnapshotReference,
  message: string,
  cause?: unknown,
): GetError {
  return Object.assign(new Error(message), {
    kind,
    reference,
    retryable: kind === "SnapshotUnavailable" || kind === "ReadFailed",
    cause,
  });
}
