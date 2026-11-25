import { constants } from "node:fs";
import { open } from "node:fs/promises";

import { GENESIS_PREV, entryHash } from "./canonical.ts";
import { readLedgerReason } from "./attribution.ts";
import { readLedgerReversal, reversalFinding } from "./reversal.ts";
import { sha256Hex, verifySignature } from "./sign.ts";
import { signingPreimage } from "./index.ts";
import { readRewardRecordSchema, type JsonlEntry } from "./store.ts";

export type PublicKeyLookup =
  | Uint8Array
  | ((keyId: string) => Promise<Uint8Array | null> | Uint8Array | null);

export type VerifyChainLine = {
  readonly seq: number;
  readonly ok: boolean;
  readonly reason?: string;
};

export type VerifyChainResult = {
  readonly ok: boolean;
  readonly checked: number;
  readonly head: string;
  readonly lines: readonly VerifyChainLine[];
  readonly reason?: string;
};

export type VerifyChainOptions = {
  readonly publicKey?: PublicKeyLookup;
};

export type VerifyLedgerFileOptions = VerifyChainOptions & ReadLedgerEntriesOptions;

export async function verifyLedgerFile(
  path: string,
  options: VerifyLedgerFileOptions = {},
): Promise<VerifyChainResult> {
  return verifyChain(
    await readLedgerEntries(path, { maxBytes: options.maxBytes, maxEntries: options.maxEntries }),
    options,
  );
}

/**
 * Read limits for untrusted ledger files. G-16/S13: callers previously loaded
 * the whole file, so one giant line or an unbounded entry count could exhaust
 * memory before verification had a chance to name the finding. The limits cap
 * total bytes and entries per read; a legitimate ledger stays far below both,
 * and operators who outgrow them raise the bound explicitly per call site.
 */
export type ReadLedgerEntriesOptions = {
  readonly maxBytes?: number;
  readonly maxEntries?: number;
};

export const LEDGER_READ_MAX_BYTES = 64 * 1024 * 1024;
export const LEDGER_READ_MAX_ENTRIES = 100_000;
const LEDGER_READ_CHUNK_BYTES = 64 * 1024;

export async function readLedgerEntries(
  path: string,
  options: ReadLedgerEntriesOptions = {},
): Promise<JsonlEntry[]> {
  const maxBytes = options.maxBytes ?? LEDGER_READ_MAX_BYTES;
  const maxEntries = options.maxEntries ?? LEDGER_READ_MAX_ENTRIES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new RangeError(`ledger maxBytes must be a non-negative safe integer: got ${JSON.stringify(maxBytes)}.`);
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 0)
    throw new RangeError(`ledger maxEntries must be a non-negative safe integer: got ${JSON.stringify(maxEntries)}.`);

  // Opening nonblocking and checking this handle prevents a FIFO from hanging
  // verification; bounded reads enforce the limit even if a regular file grows.
  // Sources: https://nodejs.org/api/fs.html#file-open-constants
  // https://nodejs.org/api/fs.html#filehandlereadbuffer-offset-length-position
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  let text: string;
  try {
    const info = await handle.stat();
    if (!info.isFile())
      throw new Error(`ledger path ${path} is not a regular file`);
    if (info.size > maxBytes) {
      throw new Error(
        `ledger file ${path} is ${info.size} bytes and exceeds the ${maxBytes} byte read limit`,
      );
    }

    const chunks: Buffer[] = [];
    let bytesRead = 0;
    for (;;) {
      const remaining = maxBytes - bytesRead + 1;
      const buffer = Buffer.allocUnsafe(Math.min(LEDGER_READ_CHUNK_BYTES, remaining));
      const result = await handle.read(buffer, 0, buffer.length, null);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
      if (bytesRead > maxBytes)
        throw new Error(`ledger file ${path} exceeds the ${maxBytes} byte read limit`);
      chunks.push(buffer.subarray(0, result.bytesRead));
    }
    text = Buffer.concat(chunks, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
  const entries: JsonlEntry[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (line === "") continue;
    if (entries.length >= maxEntries) {
      throw new Error(
        `ledger file ${path} exceeds the ${maxEntries} entry read limit at line ${index + 1}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`ledger line ${index + 1} is not JSON`);
    }
    entries.push(asEntry(parsed, index + 1));
  }
  return entries;
}


export async function verifyChain(
  entries: readonly JsonlEntry[],
  options: VerifyChainOptions = {},
): Promise<VerifyChainResult> {
  let prev = GENESIS_PREV;
  let checked = 0;
  const lines: VerifyChainLine[] = [];
  const proven = new Map<number, string>();

  for (const entry of entries) {
    checked += 1;
    const fail = (reason: string): VerifyChainResult => {
      lines.push({ seq: entry.seq, ok: false, reason });
      return { ok: false, checked, head: prev, lines, reason };
    };

    if (typeof entry.body !== "object" || entry.body === null ||
        !("workspace" in entry.body) || entry.body.workspace !== entry.workspace)
      return fail(`entry ${entry.seq} workspace does not match its signed body`);
    const rewardSchema = readRewardRecordSchema(entry.body, entry.seq);
    if (rewardSchema.kind === "unknown-version")
      return fail(`schema: ${rewardSchema.detail}`);
    const reason = readLedgerReason(entry.body, entry.seq);
    if (reason.kind === "malformed")
      return fail(`attribution: ${reason.detail}`);
    // A reversal is only meaningful against the records this run has already
    // proved, so it is enforced here with the same rule the store enforces and
    // for the same reason: this is the function a third party runs, and a
    // signed record asserting the inversion of something absent from the file
    // must not pass it.
    const reversal = readLedgerReversal(entry.body, entry.seq);
    if (reversal.kind === "malformed")
      return fail(`reversal: ${reversal.detail}`);
    if (reversal.kind === "reversal") {
      const finding = reversalFinding(reversal.reversal, entry.seq, (named) =>
        proven.get(named),
      );
      if (finding !== undefined)
        return fail(`reversal: entry ${entry.seq} ${finding}`);
    }
    if (entry.seq !== checked)
      return fail(`expected seq ${checked}, found ${entry.seq}`);
    if (entry.prev_hash !== prev)
      return fail(`entry ${entry.seq} points at ${entry.prev_hash}, expected ${prev}`);
    const recomputed = await entryHash(entry.body, prev, sha256Hex);
    if (recomputed !== entry.hash)
      return fail(`entry ${entry.seq} body does not match digest: computed ${recomputed}, stored ${entry.hash}`);

    if (options.publicKey !== undefined) {
      if (entry.alg !== "ed25519")
        return fail(`entry ${entry.seq} carries unsupported algorithm ${entry.alg}`);
      const signature = signatureBytes(entry);
      if (signature === null)
        return fail(`entry ${entry.seq} carries a malformed signature tag`);
      const publicKey = await lookupPublicKey(options.publicKey, entry.key_id);
      if (publicKey === null)
        return fail(`entry ${entry.seq} has no public key for ${entry.key_id}`);
      const ok = verifySignature(
        "ed25519",
        signingPreimage("ed25519", entry.key_id, entry.hash),
        signature,
        publicKey,
      );
      if (!ok)
        return fail(`entry ${entry.seq} fails signature verification under ${entry.key_id}`);
    }

    lines.push({ seq: entry.seq, ok: true });
    proven.set(entry.seq, entry.hash);
    prev = entry.hash;
  }

  return { ok: true, checked, head: prev, lines };
}

/**
 * How one record stands on its own.
 *
 * `verified` means every check this verifier can run was run and passed.
 * `corrupt` means a check ran and failed. `unverified` means no check failed
 * but at least one could not be run: the signing key is unknown, or the caller
 * supplied no public key at all. Keeping those three apart is the whole point
 * of this surface. A record signed by a key this machine does not hold is not
 * the same fact as a record whose body no longer hashes to its digest, and a
 * surface that renders both as "error" tells the operator nothing about which
 * one to act on.
 */
export type LedgerRecordStatus = "verified" | "corrupt" | "unverified";

export type LedgerRecordVerification = {
  /** Stable key inside one chain: `<workspace>:<seq>`. */
  readonly id: string;
  readonly seq: number;
  /** The digest the file stores for this record, never a recomputed one. */
  readonly hash: string;
  readonly status: LedgerRecordStatus;
  readonly reason?: string;
};

export type VerifyChainRecordsResult = {
  /** True only when every record is `verified`. An empty chain is true. */
  readonly ok: boolean;
  readonly checked: number;
  /** The last stored digest, or the genesis digest for an empty chain. */
  readonly head: string;
  readonly records: readonly LedgerRecordVerification[];
  /** The first record's finding, in chain order, for a caller that wants one. */
  readonly reason?: string;
};

/**
 * Every record in the chain with its own verdict, without stopping at the
 * first bad one.
 *
 * `verifyChain` above is the strict read and stays the strict read: it stops
 * at the first finding so a caller that must not act on unverified evidence
 * cannot. That is exactly the wrong shape for a surface that has to show the
 * operator what is in the file, because one corrupt record would hide every
 * record after it. This walks the whole chain and reports each record
 * separately.
 *
 * The checks are the same ones, with one deliberate difference that makes the
 * per record verdicts independent. The link check compares a record's
 * `prev_hash` with the digest the *previous record stores*, not with a digest
 * this run recomputed. A tampered body therefore produces exactly one corrupt
 * record: its own digest no longer matches its body, while the record after it
 * still points at the stored digest it was written against. The body hash is
 * likewise recomputed over `entry.prev_hash`, so a broken link does not make
 * every later record look corrupt as well. Neither choice weakens the verdict:
 * the strict verifier still refuses the whole chain, and a record whose link
 * is wrong is corrupt on its own.
 *
 * A record's hash joins the reversal lookup once its body proves against its
 * stored digest. A reversal is a claim about a digest the chain holds, not
 * about a signature, so an unknown signing key at the named record does not
 * turn a well formed reversal into a finding. A named record whose own body
 * does not prove is a finding, and it is reported as that, not as a chain that
 * never held the record.
 */
export async function verifyChainRecords(
  entries: readonly JsonlEntry[],
  options: VerifyChainOptions = {},
): Promise<VerifyChainRecordsResult> {
  const records: LedgerRecordVerification[] = [];
  /** Every digest already walked, proven or not, by sequence. */
  const stored = new Map<number, string>();
  /** Digests whose body proved against them, which is what a reversal names. */
  const proven = new Map<number, string>();
  let prev = GENESIS_PREV;
  let checked = 0;
  let reason: string | undefined;

  for (const entry of entries) {
    checked += 1;
    let corrupt: string | undefined;
    let unverified: string | undefined;

    if (
      typeof entry.body !== "object" ||
      entry.body === null ||
      !("workspace" in entry.body) ||
      entry.body.workspace !== entry.workspace
    ) {
      corrupt = `workspace: entry ${entry.seq} does not match its signed body`;
    } else {
      const rewardSchema = readRewardRecordSchema(entry.body, entry.seq);
      if (rewardSchema.kind === "unknown-version")
        corrupt = `schema: ${rewardSchema.detail}`;
      const attribution = readLedgerReason(entry.body, entry.seq);
      if (corrupt === undefined && attribution.kind === "malformed")
        corrupt = `attribution: ${attribution.detail}`;
      if (corrupt === undefined) {
        const reversal = readLedgerReversal(entry.body, entry.seq);
        if (reversal.kind === "malformed") corrupt = `reversal: ${reversal.detail}`;
        else if (reversal.kind === "reversal") {
          const finding = reversalFinding(reversal.reversal, entry.seq, (seq) =>
            proven.get(seq),
          );
          if (finding !== undefined) {
            const named = stored.get(reversal.reversal.seq);
            corrupt =
              named === reversal.reversal.digest
                ? `reversal: entry ${entry.seq} names record ${reversal.reversal.seq}, which is not itself verified`
                : `reversal: entry ${entry.seq} ${finding}`;
          }
        }
      }
    }
    if (corrupt === undefined && entry.seq !== checked)
      corrupt = `order: expected seq ${checked}, found ${entry.seq}`;
    if (corrupt === undefined && entry.prev_hash !== prev)
      corrupt = `link: entry ${entry.seq} points at ${entry.prev_hash.slice(0, 8)} but the chain is at ${prev.slice(0, 8)}`;
    if (corrupt === undefined) {
      // A record that names an unusable predecessor digest reaches here when
      // the record before it stored that same digest. Hashing throws on it,
      // and letting that escape would end the walk: the one thing this read
      // must never do is let a hostile record hide the records after it.
      try {
        const recomputed = await entryHash(
          entry.body,
          entry.prev_hash,
          sha256Hex,
        );
        if (recomputed !== entry.hash)
          corrupt = `body: entry ${entry.seq} does not hash to its stored digest: computed ${recomputed.slice(0, 16)}, stored ${entry.hash.slice(0, 16)}`;
      } catch (error) {
        corrupt = `body: entry ${entry.seq} could not be hashed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    if (corrupt === undefined) {
      if (entry.alg !== "ed25519") {
        // The signature cannot be checked, but nothing about the record is
        // proven wrong either, so it is unverified rather than corrupt.
        unverified = `signature: entry ${entry.seq} carries unsupported algorithm ${entry.alg}`;
      } else {
        const signature = signatureBytes(entry);
        if (signature === null) {
          corrupt = `signature: entry ${entry.seq} carries a malformed signature tag`;
        } else if (options.publicKey === undefined) {
          unverified = `signature: entry ${entry.seq} not checked, no public key was supplied`;
        } else {
          const publicKey = await lookupPublicKey(
            options.publicKey,
            entry.key_id,
          );
          if (publicKey === null) {
            unverified = `signature: entry ${entry.seq} has no public key for ${entry.key_id}`;
          } else if (
            !verifySignature(
              "ed25519",
              signingPreimage("ed25519", entry.key_id, entry.hash),
              signature,
              publicKey,
            )
          ) {
            corrupt = `signature: entry ${entry.seq} fails signature verification under ${entry.key_id}`;
          }
        }
      }
    }

    const finding = corrupt ?? unverified;
    records.push({
      id: `${entry.workspace}:${entry.seq}`,
      seq: entry.seq,
      hash: entry.hash,
      status:
        corrupt !== undefined
          ? "corrupt"
          : unverified !== undefined
            ? "unverified"
            : "verified",
      ...(finding === undefined ? {} : { reason: finding }),
    });
    if (reason === undefined && finding !== undefined) reason = finding;
    stored.set(entry.seq, entry.hash);
    if (corrupt === undefined) proven.set(entry.seq, entry.hash);
    prev = entry.hash;
  }

  return {
    ok: records.every((record) => record.status === "verified"),
    checked,
    head: prev,
    records,
    ...(reason === undefined ? {} : { reason }),
  };
}

async function lookupPublicKey(
  lookup: PublicKeyLookup,
  keyId: string,
): Promise<Uint8Array | null> {
  if (lookup instanceof Uint8Array) return lookup;
  return lookup(keyId);
}

function signatureBytes(entry: JsonlEntry): Uint8Array | null {
  const [alg, encoded, extra] = entry.signature.split(":");
  if (extra !== undefined || alg !== entry.alg || encoded === undefined || encoded === "")
    return null;
  return new Uint8Array(Buffer.from(encoded, "base64"));
}

function asEntry(value: unknown, line: number): JsonlEntry {
  if (typeof value !== "object" || value === null)
    throw new Error(`ledger line ${line} is not an object`);
  const entry = value as Partial<JsonlEntry>;
  if (typeof entry.workspace !== "string" || entry.workspace === "")
    throw new Error(`ledger line ${line} has invalid workspace`);
  if (typeof entry.seq !== "number" || !Number.isInteger(entry.seq) || entry.seq < 1)
    throw new Error(`ledger line ${line} has invalid seq`);
  if (typeof entry.body !== "object" || entry.body === null)
    throw new Error(`ledger line ${line} has invalid body`);
  if (typeof entry.prev_hash !== "string" || typeof entry.hash !== "string")
    throw new Error(`ledger line ${line} has invalid chain digests`);
  if (typeof entry.key_id !== "string" || entry.key_id === "")
    throw new Error(`ledger line ${line} has invalid key id`);
  if (typeof entry.alg !== "string" || entry.alg === "")
    throw new Error(`ledger line ${line} has invalid algorithm`);
  if (typeof entry.signature !== "string" || entry.signature === "")
    throw new Error(`ledger line ${line} has invalid signature`);
  return entry as JsonlEntry;
}
