import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { canonicalJson, GENESIS_PREV } from "./canonical.ts";
import { devKeyProvider, sha256Hex, verifySignature } from "./sign.ts";
import type { Alg, KeyProvider } from "./index.ts";
import { readLedgerEntries, verifyChain, type PublicKeyLookup } from "./verify.ts";
import type { JsonlEntry } from "./store.ts";
import {
  assertPrivateDirectoryPath,
  assertPrivateFilePath,
  ensurePrivateDirectory,
  openPrivateFile,
} from "./hardening.ts";

export type AttestationDocument = {
  readonly workspace: string;
  readonly headSeq: number;
  readonly headHash: string;
  readonly at: string;
  readonly entriesCount: number;
  readonly treeDigest: string;
  readonly key_id: string;
  readonly alg: Alg;
  readonly signature: string;
};

export type VerifyAttestationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * The result of checking a ledger against one anchor. `grown` is the number of
 * entries written after the anchor was taken: growth is normal, a shorter
 * chain is not.
 */
export type AnchorMatch =
  | {
      readonly ok: true;
      readonly headSeq: number;
      readonly headHash: string;
      readonly entriesCount: number;
      readonly grown: number;
      readonly at: string;
      readonly key_id: string;
    }
  | { readonly ok: false; readonly reason: string };

/** Parse and shape check an attestation document from untrusted bytes. */
export function parseAttestationDocument(value: unknown, label = "attestation"): AttestationDocument {
  if (typeof value !== "object" || value === null)
    throw new Error(`${label} is not an object`);
  const parsed = value as Partial<AttestationDocument>;
  if (typeof parsed.workspace !== "string" || parsed.workspace === "")
    throw new Error(`${label} has invalid workspace`);
  if (typeof parsed.headSeq !== "number" || !Number.isInteger(parsed.headSeq) || parsed.headSeq < 0)
    throw new Error(`${label} has invalid headSeq`);
  if (typeof parsed.headHash !== "string" || parsed.headHash === "")
    throw new Error(`${label} has invalid headHash`);
  if (typeof parsed.at !== "string" || parsed.at === "")
    throw new Error(`${label} has invalid at`);
  if (typeof parsed.entriesCount !== "number" || !Number.isInteger(parsed.entriesCount) || parsed.entriesCount < 0)
    throw new Error(`${label} has invalid entriesCount`);
  if (typeof parsed.treeDigest !== "string" || parsed.treeDigest === "")
    throw new Error(`${label} has invalid treeDigest`);
  if (typeof parsed.key_id !== "string" || parsed.key_id === "")
    throw new Error(`${label} has invalid key_id`);
  if (parsed.alg !== "ed25519" && parsed.alg !== "ecdsa-p256-sha256")
    throw new Error(`${label} has invalid alg`);
  if (typeof parsed.signature !== "string" || parsed.signature === "")
    throw new Error(`${label} has invalid signature`);
  return parsed as AttestationDocument;
}

export type AttestLedgerOptions = {
  readonly now?: () => Date;
};

const ATTESTATION_PREIMAGE_VERSION = "void.ledger.attestation.v1";
const MERKLE_DOMAIN = "void.ledger.merkle.v1";

export async function attestLedger(
  dir: string,
  workspace: string,
  key?: KeyProvider,
  options: AttestLedgerOptions = {},
): Promise<AttestationDocument> {
  const signer = key ?? await devKeyProvider();
  const file = join(dir, `${workspace}.jsonl`);
  await assertPrivateFilePath(file, "ledger file");
  const entries = await readLedgerEntries(file);
  if (entries.some((entry) => entry.workspace !== workspace))
    throw new Error("cannot attest ledger from another workspace");
  const verified = await verifyChain(entries, { publicKey: (keyId) => signer.publicKey(keyId) });
  if (!verified.ok) throw new Error(`cannot attest invalid ledger: ${verified.reason}`);
  const keyId = await signer.currentKeyId();
  const unsigned = {
    workspace,
    headSeq: entries.length === 0 ? 0 : entries[entries.length - 1]!.seq,
    headHash: verified.head,
    at: (options.now ?? (() => new Date()))().toISOString(),
    entriesCount: entries.length,
    treeDigest: await merkleDigest(entries.map((entry) => entry.hash)),
    key_id: keyId,
    alg: signer.alg,
  };
  const signature = await signer.sign(attestationPreimage(unsigned), keyId);
  return { ...unsigned, signature: `${signer.alg}:${Buffer.from(signature).toString("base64")}` };
}

export async function storeAttestation(dir: string, doc: AttestationDocument): Promise<string> {
  const attestations = join(dir, "attestations");
  await assertPrivateDirectoryPath(dir, "ledger directory");
  await ensurePrivateDirectory(attestations, "ledger attestations directory");
  const path = join(attestations, `${doc.headSeq}.json`);
  const temporary = join(attestations, `.tmp-${randomBytes(16).toString("hex")}`);
  try {
    const handle = await openPrivateFile(
      temporary,
      "exclusive-write",
      "ledger attestation temporary file",
    );
    try {
      await handle.writeFile(`${JSON.stringify(doc, null, 2)}
`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    await assertPrivateFilePath(path, "ledger attestation file");
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return path;
}

export async function verifyAttestation(
  doc: AttestationDocument,
  ledgerEntries: readonly JsonlEntry[],
  options: { readonly publicKey: PublicKeyLookup },
): Promise<VerifyAttestationResult> {
  const chain = await verifyChain(ledgerEntries);
  if (!chain.ok) return { ok: false, reason: `ledger mismatch: ${chain.reason}` };
  if (doc.entriesCount !== ledgerEntries.length)
    return { ok: false, reason: `entries count mismatch: attestation ${doc.entriesCount}, ledger ${ledgerEntries.length}` };
  const headSeq = ledgerEntries.length === 0 ? 0 : ledgerEntries[ledgerEntries.length - 1]!.seq;
  if (doc.headSeq !== headSeq)
    return { ok: false, reason: `head seq mismatch: attestation ${doc.headSeq}, ledger ${headSeq}` };
  if (doc.headHash !== chain.head)
    return { ok: false, reason: `head hash mismatch: attestation ${doc.headHash}, ledger ${chain.head}` };
  const treeDigest = await merkleDigest(ledgerEntries.map((entry) => entry.hash));
  if (doc.treeDigest !== treeDigest)
    return { ok: false, reason: `tree digest mismatch: attestation ${doc.treeDigest}, ledger ${treeDigest}` };
  const wrongWorkspace = ledgerEntries.find((entry) => entry.workspace !== doc.workspace);
  if (wrongWorkspace !== undefined)
    return { ok: false, reason: `workspace mismatch at entry ${wrongWorkspace.seq}` };
  return verifyAnchorSignature(doc, options.publicKey);
}

/**
 * The check an anchor exists for, and the reason it is not the same call as
 * `verifyChain`: a chain is consistent on any prefix, so a chain that has had
 * its tail dropped verifies clean forever. An anchor is a length and a head
 * somebody else published, so this fails on a chain shorter than the anchor,
 * on an entry where the anchor said a different one was, and on a document
 * that does not verify under a key the holder of the anchor trusts.
 *
 * Growth is not a failure: entries written after the anchor was taken are
 * reported as `grown` and left to the next anchor.
 */
export async function verifyAnchor(
  doc: AttestationDocument,
  ledgerEntries: readonly JsonlEntry[],
  options: { readonly publicKey: PublicKeyLookup },
): Promise<AnchorMatch> {
  const chain = await verifyChain(ledgerEntries);
  if (!chain.ok) return { ok: false, reason: `ledger mismatch: ${chain.reason}` };
  if (doc.headSeq !== doc.entriesCount)
    return { ok: false, reason: `anchor head seq ${doc.headSeq} and entry count ${doc.entriesCount} disagree` };
  if (doc.entriesCount > ledgerEntries.length)
    return {
      ok: false,
      reason: `the anchor covers ${doc.entriesCount} entries and the ledger holds ${ledgerEntries.length}: the chain is shorter than the anchor, so entries were dropped`,
    };
  const anchored = doc.entriesCount === 0 ? undefined : ledgerEntries[doc.entriesCount - 1];
  const expectedHead = doc.entriesCount === 0 ? GENESIS_PREV : anchored!.hash;
  if (doc.headHash !== expectedHead)
    return { ok: false, reason: `entry ${doc.headSeq} is ${expectedHead}, the anchored head was ${doc.headHash}` };
  const treeDigest = await merkleDigest(ledgerEntries.slice(0, doc.entriesCount).map((entry) => entry.hash));
  if (doc.treeDigest !== treeDigest)
    return { ok: false, reason: `tree digest mismatch: ${doc.treeDigest}, ledger ${treeDigest}` };
  const wrongWorkspace = ledgerEntries.find((entry) => entry.workspace !== doc.workspace);
  if (wrongWorkspace !== undefined)
    return { ok: false, reason: `workspace mismatch at entry ${wrongWorkspace.seq}` };
  const signature = await verifyAnchorSignature(doc, options.publicKey);
  if (!signature.ok) return signature;
  return {
    ok: true,
    headSeq: doc.headSeq,
    headHash: doc.headHash,
    entriesCount: doc.entriesCount,
    grown: ledgerEntries.length - doc.entriesCount,
    at: doc.at,
    key_id: doc.key_id,
  };
}

/** The origin half of an anchor: which key signed it, and does that check out. */
async function verifyAnchorSignature(
  doc: AttestationDocument,
  publicKey: PublicKeyLookup,
): Promise<VerifyAttestationResult> {
  if (doc.alg !== "ed25519")
    return { ok: false, reason: `unsupported attestation algorithm ${doc.alg}` };
  const signature = attestationSignatureBytes(doc);
  if (signature === null) return { ok: false, reason: "malformed attestation signature" };
  const spki = await lookupAttestationKey(publicKey, doc.key_id);
  if (spki === null)
    return { ok: false, reason: `no public key for attestation key ${doc.key_id}` };
  const ok = verifySignature("ed25519", attestationPreimage(unsignedAttestation(doc)), signature, spki);
  return ok ? { ok: true } : { ok: false, reason: `attestation signature fails under ${doc.key_id}` };
}

export async function merkleDigest(hashes: readonly string[]): Promise<string> {
  if (hashes.length === 0) return sha256Hex(`${MERKLE_DOMAIN}|empty`);
  let level = [...hashes];
  for (const hash of level) assertDigest(hash);
  while (level.length > 1) {
    const next: string[] = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index]!;
      const right = level[index + 1] ?? left;
      next.push(await sha256Hex(`${MERKLE_DOMAIN}|node|${left}|${right}`));
    }
    level = next;
  }
  return level[0] ?? GENESIS_PREV;
}

function unsignedAttestation(doc: AttestationDocument): Omit<AttestationDocument, "signature"> {
  return {
    workspace: doc.workspace,
    headSeq: doc.headSeq,
    headHash: doc.headHash,
    at: doc.at,
    entriesCount: doc.entriesCount,
    treeDigest: doc.treeDigest,
    key_id: doc.key_id,
    alg: doc.alg,
  };
}

function attestationPreimage(doc: Omit<AttestationDocument, "signature">): Uint8Array {
  return new TextEncoder().encode(`${ATTESTATION_PREIMAGE_VERSION}|${canonicalJson(doc)}`);
}

function attestationSignatureBytes(doc: AttestationDocument): Uint8Array | null {
  const [alg, encoded, extra] = doc.signature.split(":");
  if (extra !== undefined || alg !== doc.alg || encoded === undefined || encoded === "")
    return null;
  return new Uint8Array(Buffer.from(encoded, "base64"));
}

async function lookupAttestationKey(
  lookup: PublicKeyLookup,
  keyId: string,
): Promise<Uint8Array | null> {
  if (lookup instanceof Uint8Array) return lookup;
  return lookup(keyId);
}

function assertDigest(hash: string): void {
  if (!/^[0-9a-f]{64}$/.test(hash))
    throw new TypeError(`merkle input must be a 64 lowercase hex digest, got ${JSON.stringify(hash)}`);
}
