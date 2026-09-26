import { readFile, stat } from "node:fs/promises";

import { GENESIS_PREV, entryHash } from "./canonical.ts";
import { readLedgerReason } from "./attribution.ts";
import { sha256Hex, verifySignature } from "./sign.ts";
import { signingPreimage } from "./index.ts";
import type { JsonlEntry } from "./store.ts";

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

export async function readLedgerEntries(
  path: string,
  options: ReadLedgerEntriesOptions = {},
): Promise<JsonlEntry[]> {
  const maxBytes = options.maxBytes ?? LEDGER_READ_MAX_BYTES;
  const maxEntries = options.maxEntries ?? LEDGER_READ_MAX_ENTRIES;
  const stat = await fstat(path);
  if (stat > maxBytes) {
    throw new Error(
      `ledger file ${path} is ${stat} bytes and exceeds the ${maxBytes} byte read limit`,
    );
  }
  const text = await readFile(path, "utf8");
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

async function fstat(path: string): Promise<number> {
  const info = await stat(path);
  return info.size;
}

export async function verifyChain(
  entries: readonly JsonlEntry[],
  options: VerifyChainOptions = {},
): Promise<VerifyChainResult> {
  let prev = GENESIS_PREV;
  let checked = 0;
  const lines: VerifyChainLine[] = [];

  for (const entry of entries) {
    checked += 1;
    const fail = (reason: string): VerifyChainResult => {
      lines.push({ seq: entry.seq, ok: false, reason });
      return { ok: false, checked, head: prev, lines, reason };
    };

    if (typeof entry.body !== "object" || entry.body === null ||
        !("workspace" in entry.body) || entry.body.workspace !== entry.workspace)
      return fail(`entry ${entry.seq} workspace does not match its signed body`);
    const reason = readLedgerReason(entry.body, entry.seq);
    if (reason.kind === "malformed")
      return fail(`attribution: ${reason.detail}`);
    if (entry.seq !== checked)
      return fail(`expected seq ${checked}, found ${entry.seq}`);
    if (entry.prev_hash !== prev)
      return fail(`entry ${entry.seq} points at ${entry.prev_hash}, expected ${prev}`);
    const recomputed = await entryHash(entry.body, prev, sha256Hex);
    if (recomputed !== entry.hash)
      return fail(`entry ${entry.seq} body does not match digest`);

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
    prev = entry.hash;
  }

  return { ok: true, checked, head: prev, lines };
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
