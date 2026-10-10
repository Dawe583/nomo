#!/usr/bin/env node
/**
 * Standalone NOMO ledger verifier, published as @nomo/verifier. Third
 * parties run this without NOMO.
 *
 * Only Node built-ins are used: node:crypto and node:fs for verification,
 * node:os and node:path in the selftest. Nothing is imported from this
 * repository, so a copy of this one file plus a JSONL export bundle is
 * enough to recheck a ledger offline. The canonicaliser, the entry hash
 * and the signing preimage are replicated here byte for byte; any drift
 * between this file and packages/ledger is a defect, and the selftest
 * below pins the shared vectors.
 *
 * The package README carries the commitment that this file keeps zero
 * dependencies and will not acquire a build step. Both properties exist so a
 * verifier can be read rather than trusted, and a gate fails the build when
 * either is lost.
 *
 * Usage:
 *   nomo-verify <bundle.jsonl>
 *   nomo-verify <bundle.jsonl> --public-key <base64-spki> --key-id <id>
 *   nomo-verify --selftest
 *
 * Without a public key only hash links, sequence and body digests are
 * checked, and the verdict says so. That is integrity evidence, not
 * signature verification.
 */

import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LEDGER_PREIMAGE_VERSION = "void.ledger.v1";
const ENTRY_DOMAIN = "void.ledger.entry.v1";
const ATTESTATION_PREIMAGE_VERSION = "void.ledger.attestation.v1";
const MERKLE_DOMAIN = "void.ledger.merkle.v1";
const GENESIS_PREV = "0".repeat(64);
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 100_000;
const MAX_DEPTH = 1000;

function canonicalJson(value) {
  return canonicalize(value, new WeakSet(), 0);
}

function canonicalize(value, seen, depth) {
  if (depth > MAX_DEPTH)
    throw new TypeError("ledger payload nests deeper than 1000 levels");
  if (value === null) return "null";
  switch (typeof value) {
    case "undefined":
      throw new TypeError("undefined does not round trip through JSON");
    case "number":
      if (!Number.isFinite(value))
        throw new TypeError(
          `${String(value)} does not round trip through JSON`,
        );
      return JSON.stringify(value);
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "bigint":
    case "function":
    case "symbol":
      throw new TypeError(`${typeof value} does not round trip through JSON`);
    case "object": {
      if (seen.has(value))
        throw new TypeError("reference cycle in ledger payload");
      seen.add(value);
      try {
        if (Array.isArray(value))
          return `[${value.map((item) => canonicalize(item, seen, depth + 1)).join(",")}]`;
        const entries = Object.entries(value);
        entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
        return `{${entries.map(([key, item]) => `${canonicalize(key, seen, depth + 1)}:${canonicalize(item, seen, depth + 1)}`).join(",")}}`;
      } finally {
        seen.delete(value);
      }
    }
  }
  throw new TypeError(`${typeof value} is not a JSON value`);
}

function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

function entryHash(body, prevHash) {
  if (!/^[0-9a-f]{64}$/.test(prevHash))
    throw new TypeError("previous hash must be 64 lowercase hex characters");
  return sha256Hex(`${ENTRY_DOMAIN}|${prevHash}|${canonicalJson(body)}`);
}

function signingPreimage(keyId, hash) {
  if (!/^[0-9a-f]{64}$/.test(hash))
    throw new TypeError("entry hash must be 64 lowercase hex characters");
  if (!keyId) throw new TypeError("key id is required");
  return new TextEncoder().encode(
    `${LEDGER_PREIMAGE_VERSION}|ed25519|${keyId}|${hash}`,
  );
}

function merkleDigest(hashes) {
  if (!hashes.length) return sha256Hex(`${MERKLE_DOMAIN}|empty`);
  let level = [...hashes];
  for (const hash of level)
    if (!/^[0-9a-f]{64}$/.test(hash))
      throw new TypeError("merkle input must be a 64 lowercase hex digest");
  while (level.length > 1) {
    const next = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index];
      const right = level[index + 1] ?? left;
      next.push(sha256Hex(`${MERKLE_DOMAIN}|node|${left}|${right}`));
    }
    level = next;
  }
  return level[0] ?? GENESIS_PREV;
}

function attestationPreimage(unsigned) {
  return new TextEncoder().encode(
    `${ATTESTATION_PREIMAGE_VERSION}|${canonicalJson(unsigned)}`,
  );
}

function parseAttestation(value) {
  if (typeof value !== "object" || value === null)
    throw new Error("attestation is not an object");
  for (const [field, ok] of [
    [
      "workspace",
      typeof value.workspace === "string" && value.workspace !== "",
    ],
    [
      "headSeq",
      typeof value.headSeq === "number" &&
        Number.isInteger(value.headSeq) &&
        value.headSeq >= 0,
    ],
    ["headHash", typeof value.headHash === "string"],
    [
      "entriesCount",
      typeof value.entriesCount === "number" &&
        Number.isInteger(value.entriesCount) &&
        value.entriesCount >= 0,
    ],
    ["treeDigest", typeof value.treeDigest === "string"],
    ["key_id", typeof value.key_id === "string" && value.key_id !== ""],
    ["alg", typeof value.alg === "string" && value.alg !== ""],
    [
      "signature",
      typeof value.signature === "string" && value.signature !== "",
    ],
  ])
    if (!ok) throw new Error(`attestation has invalid ${field}`);
  return value;
}

function verifyAttestation(doc, entries, publicKey) {
  const chain = verifyEntries(entries, publicKey);
  if (!chain.ok)
    return { ok: false, reason: `ledger mismatch: ${chain.reason}` };
  if (doc.entriesCount !== entries.length)
    return {
      ok: false,
      reason: `entries count mismatch: attestation ${doc.entriesCount}, ledger ${entries.length}`,
    };
  const headSeq = entries.length === 0 ? 0 : entries[entries.length - 1].seq;
  if (doc.headSeq !== headSeq)
    return {
      ok: false,
      reason: `head seq mismatch: attestation ${doc.headSeq}, ledger ${headSeq}`,
    };
  if (doc.headHash !== chain.head)
    return { ok: false, reason: "head hash mismatch" };
  let tree;
  try {
    tree = merkleDigest(entries.map((entry) => entry.hash));
  } catch (error) {
    return { ok: false, reason: `tree digest failed: ${error.message}` };
  }
  if (doc.treeDigest !== tree)
    return { ok: false, reason: "tree digest mismatch" };
  const wrong = entries.find((entry) => entry.workspace !== doc.workspace);
  if (wrong !== undefined)
    return { ok: false, reason: `workspace mismatch at entry ${wrong.seq}` };
  if (!publicKey) return { ok: true, integrityOnly: true };
  if (doc.alg !== "ed25519")
    return {
      ok: false,
      reason: `unsupported attestation algorithm ${doc.alg}`,
    };
  const [alg, encoded, extra] = doc.signature.split(":");
  if (extra !== undefined || alg !== doc.alg || !encoded)
    return { ok: false, reason: "malformed attestation signature" };
  const {
    workspace,
    headSeq: hs,
    headHash,
    at,
    entriesCount,
    treeDigest,
    key_id,
    alg: docAlg,
  } = doc;
  let signatureOk = false;
  try {
    signatureOk = verify(
      null,
      attestationPreimage({
        workspace,
        headSeq: hs,
        headHash,
        at,
        entriesCount,
        treeDigest,
        key_id,
        alg: docAlg,
      }),
      publicKey,
      Buffer.from(encoded, "base64"),
    );
  } catch {
    signatureOk = false;
  }
  if (!signatureOk)
    return {
      ok: false,
      reason: `attestation signature fails under ${doc.key_id}`,
    };
  return { ok: true };
}

function parseEntry(value, line) {
  if (typeof value !== "object" || value === null)
    throw new Error(`ledger line ${line} is not an object`);
  for (const [field, ok] of [
    [
      "workspace",
      typeof value.workspace === "string" && value.workspace !== "",
    ],
    [
      "seq",
      typeof value.seq === "number" &&
        Number.isInteger(value.seq) &&
        value.seq >= 1,
    ],
    ["body", typeof value.body === "object" && value.body !== null],
    [
      "digests",
      typeof value.prev_hash === "string" && typeof value.hash === "string",
    ],
    ["key_id", typeof value.key_id === "string" && value.key_id !== ""],
    ["alg", typeof value.alg === "string" && value.alg !== ""],
    [
      "signature",
      typeof value.signature === "string" && value.signature !== "",
    ],
  ])
    if (!ok) throw new Error(`ledger line ${line} has invalid ${field}`);
  return value;
}

function verifyEntries(entries, publicKey) {
  let prev = GENESIS_PREV;
  let checked = 0;
  for (const entry of entries) {
    checked += 1;
    const fail = (reason) => ({ ok: false, checked, head: prev, reason });
    if (
      typeof entry.body !== "object" ||
      entry.body === null ||
      entry.body.workspace !== entry.workspace
    )
      return fail(
        `entry ${entry.seq} workspace does not match its signed body`,
      );
    if (entry.seq !== checked)
      return fail(`expected seq ${checked}, found ${entry.seq}`);
    if (entry.prev_hash !== prev)
      return fail(
        `entry ${entry.seq} points at ${entry.prev_hash}, expected ${prev}`,
      );
    let recomputed;
    try {
      recomputed = entryHash(entry.body, prev);
    } catch (error) {
      return fail(
        `entry ${entry.seq} body is not canonical JSON: ${error.message}`,
      );
    }
    if (recomputed !== entry.hash)
      return fail(`entry ${entry.seq} body does not match digest`);
    if (publicKey) {
      if (entry.alg !== "ed25519")
        return fail(
          `entry ${entry.seq} carries unsupported algorithm ${entry.alg}`,
        );
      const [alg, encoded, extra] = entry.signature.split(":");
      if (extra !== undefined || alg !== entry.alg || !encoded)
        return fail(`entry ${entry.seq} carries a malformed signature tag`);
      let signatureOk = false;
      try {
        signatureOk = verify(
          null,
          signingPreimage(entry.key_id, entry.hash),
          publicKey,
          Buffer.from(encoded, "base64"),
        );
      } catch {
        signatureOk = false;
      }
      if (!signatureOk)
        return fail(
          `entry ${entry.seq} fails signature verification under ${entry.key_id}`,
        );
    }
    prev = entry.hash;
  }
  return { ok: true, checked, head: prev };
}

/**
 * A caller who hands this verifier a directory means "verify what is in
 * here". Answering `cannot read bundle <dir>` for a readable directory is the
 * tool claiming it cannot understand its own argument, so the directory is
 * resolved and every way that can go wrong says which of them happened: the
 * path is absent, the directory is empty, or it holds more than one bundle and
 * this verifier will not guess which was meant. A malformed bundle is a
 * different failure again and is reported by `readBundle` below.
 *
 * Only a directory holding exactly one bundle gets a file chosen, and the
 * chosen file is echoed, so the verdict is about something the reader can see
 * rather than a path the tool derived silently. Zero dependencies still: this
 * is `node:fs`, like everything else in this file.
 */
function resolveBundlePath(input) {
  let info;
  try {
    info = statSync(input);
  } catch (error) {
    if (error.code === "ENOENT")
      throw new Error(
        `${input} does not exist: nomo-verify reads one JSONL bundle, named as its argument`,
      );
    throw new Error(
      `cannot read ${input}: ${error.code ?? error.message} (a permissions problem, not a missing file)`,
    );
  }
  if (!info.isDirectory()) return input;
  let names;
  try {
    names = readdirSync(input);
  } catch (error) {
    throw new Error(`cannot list ${input}: ${error.code ?? error.message}`);
  }
  const bundles = names.filter((name) => name.endsWith(".jsonl")).sort();
  if (!bundles.length)
    throw new Error(
      `${input} is an empty directory: it holds no .jsonl bundle to verify`,
    );
  if (bundles.length > 1)
    throw new Error(
      `${input} holds ${bundles.length} bundles (${bundles.join(", ")}): pass the one you mean as the argument`,
    );
  return join(input, bundles[0]);
}

function readBundle(path) {
  const resolved = resolveBundlePath(path);
  let text;
  try {
    text = readFileSync(resolved, "utf8");
  } catch (error) {
    throw new Error(
      `cannot read bundle ${resolved}: ${error.code ?? error.message}`,
    );
  }
  if (Buffer.byteLength(text) > MAX_BYTES)
    throw new Error(`bundle exceeds the ${MAX_BYTES} byte read limit`);
  const entries = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === "") continue;
    if (entries.length >= MAX_ENTRIES)
      throw new Error(
        `bundle exceeds the ${MAX_ENTRIES} entry read limit at line ${index + 1}`,
      );
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`ledger line ${index + 1} is not JSON`);
    }
    entries.push(parseEntry(parsed, index + 1));
  }
  if (!entries.length) throw new Error("bundle holds no entries");
  return entries;
}

function selftest() {
  const dir = mkdtempSync(join(tmpdir(), "nomo-standalone-verify-"));
  try {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const spki = publicKey.export({ format: "der", type: "spki" });
    const keyId = `dev-ed25519:${sha256Hex(spki).slice(0, 16)}`;
    const entries = [];
    let prev = GENESIS_PREV;
    ["first write", "second write", "undo of first"].forEach((text, index) => {
      const body = {
        workspace: "selftest",
        at: `2026-09-17T00:00:0${index}Z`,
        tool: "nomo_workspace_write",
        klass: "r1",
        decision: "execute:completed",
        note: text,
      };
      const hash = entryHash(body, prev);
      const signature = `ed25519:${sign(null, signingPreimage(keyId, hash), privateKey).toString("base64")}`;
      entries.push({
        workspace: "selftest",
        seq: index + 1,
        body,
        prev_hash: prev,
        hash,
        key_id: keyId,
        alg: "ed25519",
        signature,
      });
      prev = hash;
    });
    const bundle = join(dir, "bundle.jsonl");
    writeFileSync(
      bundle,
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    const good = verifyEntries(
      readBundle(bundle),
      createPublicKey({ key: spki, format: "der", type: "spki" }),
    );
    if (!good.ok || good.checked !== 3)
      throw new Error(`roundtrip failed: ${good.reason ?? "wrong count"}`);
    console.log(
      `SELFTEST PASS roundtrip: 3 entries, head ${good.head.slice(0, 16)}`,
    );
    const tampered = entries.map((entry) => ({
      ...entry,
      body: { ...entry.body },
    }));
    tampered[1].body.note = "rewritten history";
    const bad = verifyEntries(
      tampered,
      createPublicKey({ key: spki, format: "der", type: "spki" }),
    );
    if (bad.ok || !/does not match digest/.test(bad.reason ?? ""))
      throw new Error("tampered body verified");
    console.log(`SELFTEST PASS tamper refused: ${bad.reason}`);
    const { publicKey: other } = generateKeyPairSync("ed25519");
    const wrong = verifyEntries(entries, other);
    if (wrong.ok || !/fails signature verification/.test(wrong.reason ?? ""))
      throw new Error("wrong key verified");
    console.log(`SELFTEST PASS wrong key refused: ${wrong.reason}`);
    const integrity = verifyEntries(readBundle(bundle), undefined);
    if (!integrity.ok)
      throw new Error(`integrity-only failed: ${integrity.reason ?? ""}`);
    console.log("SELFTEST PASS integrity-only: hash links hold without a key");
    const unsigned = {
      workspace: "selftest",
      headSeq: 3,
      headHash: good.head,
      at: "2026-09-18T00:00:00.000Z",
      entriesCount: 3,
      treeDigest: merkleDigest(entries.map((entry) => entry.hash)),
      key_id: keyId,
      alg: "ed25519",
    };
    const doc = {
      ...unsigned,
      signature: `ed25519:${sign(null, attestationPreimage(unsigned), privateKey).toString("base64")}`,
    };
    const spkiKey = createPublicKey({
      key: spki,
      format: "der",
      type: "spki",
    });
    const attested = verifyAttestation(doc, entries, spkiKey);
    if (!attested.ok)
      throw new Error(`attestation failed: ${attested.reason ?? ""}`);
    console.log("SELFTEST PASS attestation: signed slice matches the bundle");
    const recounted = verifyAttestation(
      { ...doc, entriesCount: 2 },
      entries,
      spkiKey,
    );
    if (recounted.ok || !/count mismatch/.test(recounted.reason ?? ""))
      throw new Error("recounted attestation verified");
    console.log(
      `SELFTEST PASS attestation tamper refused: ${recounted.reason}`,
    );
    console.log("SELFTEST PASS all six checks");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main(argv) {
  if (argv.includes("--selftest")) {
    selftest();
    return;
  }
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const file = positional[0];
  const keyIndex = argv.indexOf("--public-key");
  const idIndex = argv.indexOf("--key-id");
  const attestationIndex = argv.indexOf("--attestation");
  const encoded = keyIndex >= 0 ? argv[keyIndex + 1] : undefined;
  const onlyKeyId = idIndex >= 0 ? argv[idIndex + 1] : undefined;
  const attestationPath =
    attestationIndex >= 0 ? argv[attestationIndex + 1] : undefined;
  if (!file || file.startsWith("--")) {
    console.error(
      "Usage: nomo-verify <bundle.jsonl|directory> [--dir <path>] [--public-key <base64-spki> [--key-id <id>]] [--attestation <doc.json>]",
    );
    process.exitCode = 2;
    return;
  }
  // Key ids ride inside each entry, so --key-id is documentation only.
  void onlyKeyId;
  // The bundle actually read is echoed, so a verdict about a file this tool
  // picked out of a directory is never a verdict about something invisible.
  let resolved;
  try {
    resolved = resolveBundlePath(file);
  } catch (error) {
    console.error(`FAILED: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  let entries;
  try {
    entries = readBundle(resolved);
  } catch (error) {
    console.error(`FAILED: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  if (resolved !== file) console.log(`BUNDLE ${resolved}`);
  let publicKey;
  if (encoded !== undefined) {
    try {
      publicKey = createPublicKey({
        key: Buffer.from(encoded, "base64"),
        format: "der",
        type: "spki",
      });
    } catch {
      console.error("FAILED: public key is not valid base64 SPKI DER");
      process.exitCode = 1;
      return;
    }
    void onlyKeyId;
  }
  const result = verifyEntries(entries, publicKey);
  if (!result.ok) {
    console.error(`FAILED: ${result.reason}`);
    process.exitCode = 1;
    return;
  }
  const scope = publicKey
    ? "signatures and hash links"
    : "hash links only, signature NOT VERIFIED";
  console.log(
    `VERIFIED ${result.checked} entries, head ${result.head} (${scope})`,
  );
  if (attestationPath !== undefined) {
    let doc;
    try {
      doc = parseAttestation(JSON.parse(readFileSync(attestationPath, "utf8")));
    } catch (error) {
      console.error(`FAILED: attestation unreadable: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    const attested = verifyAttestation(doc, entries, publicKey);
    if (!attested.ok) {
      console.error(`FAILED: ${attested.reason}`);
      process.exitCode = 1;
      return;
    }
    console.log(
      `ATTESTED ${doc.entriesCount} entries under ${doc.key_id} (${publicKey ? "signed" : "integrity only, signature NOT VERIFIED"})`,
    );
  }
}

main(process.argv.slice(2));
