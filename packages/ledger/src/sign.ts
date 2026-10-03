/**
 * ed25519 signing through node:crypto, and nothing else.
 *
 * Decision 3. The entire cryptographic dependency budget is the platform: a
 * userland curve library is the single worst place to spend supply chain
 * risk in a component whose job is to be trustworthy. The interface is async
 * from the first line because every KMS is a network call, and there is no
 * way to export private key material because exported key material reaches
 * a log or a crash dump eventually.
 *
 * Development keys are generated on first append into ~/.void/keys at mode
 * 0600 and carry a dev- prefix in the key id, so the verifier can report
 * "valid, development key" and never plain valid. In production the same
 * interface is backed by KMS and no calling code changes.
 */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";

import type { Alg, KeyProvider } from "./index.ts";
import { canonicalJson, entryHash } from "./canonical.ts";
import {
  ensurePrivateDirectory,
  openPrivateFile,
  readPrivateFile,
} from "./hardening.ts";

/**
 * The one development signing key directory: `~/.void/keys`.
 *
 * Every surface that reads or writes the development key derives it here. The
 * trust anchor, `doctor`, `watch` and the TUI proxy all have to agree on which
 * key signs a ledger, and a trust anchor resolved against a different
 * directory than the signer used is not an anchor at all — it verifies
 * nothing and reads as an improvement. One derivation, so they cannot drift.
 *
 * The workbench document ledger is the one thing that keeps its own key, at
 * `<data dir>/keys`: it is a second recorder identity, not a second location
 * for this one, and the two are never interchangeable.
 */
export const devKeyDir = (home: string = homedir()): string =>
  join(home, ".void", "keys");


/** The digest engine. Swappable at the test boundary, node:crypto in production. */
export const sha256Hex = async (input: string): Promise<string> =>
  createHash("sha256").update(input).digest("hex");

/**
 * sha256 over the canonical JSON of a value, so two runtimes digesting the
 * same content agree byte for byte. One implementation, one answer: a second
 * content digest in the tree is a second value for the same claim, and the
 * loser of that race is whoever later re-derives the proof.
 */
export const canonicalDigest = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

export function keyIdFromSpki(spki: Uint8Array): string {
  const digest = createHash("sha256").update(spki).digest("hex");
  return `ed25519:${digest.slice(0, 16)}`;
}

/**
 * The key id a stored record carries for an SPKI public key. One scheme, one
 * place: a verifier that computes the id any other way silently stops
 * matching the records it is supposed to check.
 */
export const devKeyIdFromSpki = (spki: Uint8Array): string =>
  `dev-${keyIdFromSpki(spki)}`;

export interface DevKeyProviderOptions {
  /** Directory for the development key material. Defaults to ~/.void/keys. */
  readonly dir?: string;
  /** Environment, injectable at the test boundary. */
  readonly env?: Readonly<NodeJS.ProcessEnv>;
  /** Whether a missing development key may be generated. Defaults to true. */
  readonly createIfMissing?: boolean;
}

/**
 * The dev tier key path. VOID_SIGNING_KEY wins if set (base64 PKCS8); the
 * key file is generated and written once, 0600, and reused after. The one
 * loud line about a development key being in use is printed by the caller
 * (the CLI), not here, because a library that prints at import time is a
 * library nobody can script.
 */
export async function devKeyProvider(
  options: DevKeyProviderOptions = {},
): Promise<KeyProvider> {
  const dir = options.dir ?? devKeyDir();
  const env = options.env ?? process.env;
  const inline = env.VOID_SIGNING_KEY;
  if (inline !== undefined && inline !== "") {
    return keyProviderFromPkcs8(Buffer.from(inline, "base64"));
  }
  return keyProviderFromDirectory(dir, options.createIfMissing ?? true);
}

/** Open retained development signing state without creating a replacement key. */
export function retainedKeyProvider(
  options: Omit<DevKeyProviderOptions, "createIfMissing"> = {},
): Promise<KeyProvider> {
  return devKeyProvider({ ...options, createIfMissing: false });
}

export function keyProviderFromPkcs8(pkcs8: Buffer): KeyProvider {
  // DER, named explicitly: a bare Buffer defaults to PEM parsing and fails
  // with an opaque OpenSSL decoder error on the exact bytes export produced.
  const privateKey = createPrivateKey({
    key: pkcs8,
    format: "der",
    type: "pkcs8",
  });
  if (privateKey.asymmetricKeyType !== "ed25519")
    throw new TypeError(
      `expected an ed25519 private key, got ${String(privateKey.asymmetricKeyType)}`,
    );
  const spki = publicKeyBytes(privateKey);
  const keyId = devKeyIdFromSpki(spki);
  return {
    alg: "ed25519",
    async currentKeyId() {
      return keyId;
    },
    async sign(input: Uint8Array) {
      return cryptoSign(null, input, privateKey);
    },
    async publicKey(id: string) {
      return id === keyId ? spki : null;
    },
  };
}

async function keyProviderFromDirectory(
  dir: string,
  createIfMissing = true,
): Promise<KeyProvider> {
  const file = join(dir, "dev-ed25519.pkcs8");
  try {
    return keyProviderFromPkcs8(await readExistingKey(file));
  } catch (error) {
    if (!isMissingFile(error) || !createIfMissing) throw error;
  }
  try {
    return keyProviderFromPkcs8(await generateAndWriteKey(dir, file));
  } catch (error) {
    if (!isAlreadyThere(error)) throw error;
    // Two processes on one fresh directory: O_EXCL lost the race, so the
    // winner's key is on disk and the loser must adopt it rather than keep a
    // key nobody else will ever verify with. The winner is still mid write
    // in the worst interleaving and the file exists but is not yet whole, so
    // any unreadable read back is retried, never accepted as a key.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        return keyProviderFromPkcs8(await readExistingKey(file));
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    throw new Error(`development key at ${file} never became readable`);
  }
}

async function readExistingKey(file: string): Promise<Buffer> {
  return readPrivateFile(file, "development key file");
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isAlreadyThere(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

async function generateAndWriteKey(dir: string, file: string): Promise<Buffer> {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" });
  await ensurePrivateDirectory(dir, "development key directory");
  // O_EXCL, never O_TRUNC: a symlink pre placed at the file path would
  // otherwise carry the private key to any path an attacker chose, and the
  // write would succeed quietly. O_CREAT|O_EXCL refuses to follow it.
  const handle = await openPrivateFile(
    file,
    "exclusive-write",
    "development key file",
  );
  try {
    // openPrivateFile applies the Windows ACL before any secret bytes are written.
    await handle.writeFile(pkcs8);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return pkcs8;
}

function publicKeyBytes(
  privateKey: ReturnType<typeof createPrivateKey>,
): Uint8Array {
  const spki = createPublicKey(privateKey).export({
    format: "der",
    type: "spki",
  });
  return new Uint8Array(spki);
}

/** Verify a signature against an SPKI public key. Algorithm agnostic. */
export function verifySignature(
  alg: Alg,
  input: Uint8Array,
  signature: Uint8Array,
  spki: Uint8Array,
): boolean {
  if (alg !== "ed25519")
    throw new TypeError(`unsupported verification algorithm ${alg}`);
  try {
    return cryptoVerify(
      null,
      input,
      createPublicKey({
        key: Buffer.from(spki),
        format: "der",
        type: "spki",
      }),
      Buffer.from(signature),
    );
  } catch {
    return false;
  }
}

export { canonicalJson, entryHash };
