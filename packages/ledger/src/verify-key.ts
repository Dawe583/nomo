/**
 * Where a verifier gets the public key it checks signatures with.
 *
 * NOMO environment names are canonical. Product-owned VOID names remain
 * accepted through the allowlist in env-compat.ts.
 *
 * A verifier that opens the private key file is asking the writer's key
 * whether the writer's signatures are good. An attacker who replaces
 * `dev-ed25519.pkcs8` can therefore re-sign a fully rewritten chain and every
 * VOID verifier reports it valid (docs/THREAT-MODEL.md §2.4). The default
 * resolution below never opens private key material: a public key comes from
 * the environment or from a trust file, and the degraded paths that do read a
 * private key are named, opt-in, and always report themselves as degraded.
 *
 * **What this buys, stated exactly, with the limitation it does not cross.**
 * A key bound to one key id (`pinnedKey`) turns key substitution from silent
 * into a refusal: a chain signed with a different key carries a different
 * `key_id` and fails with "has no public key for ...", instead of being
 * verified by the very key that signed it. That detection is worth exactly
 * what the binding is out of reach of. The trust file at the default path
 * lives under `~/.void/`, which is the same tree as `~/.void/keys/`; its mode
 * is `0400`, which stops an in-place write by a different user and stops
 * nothing at all for its own owner, who may `unlink` it and create a new file.
 * So substituting the trust file and the signing key together is silent, and
 * this module reports it as `source: "trust-file"`, `operatorSupplied: false`
 * rather than calling it pinned.
 *
 * Substitution is therefore detectable **only** by a holder of a key that was
 * obtained out of band and never written to a file the agent can reach:
 * `VOID_VERIFY_KEY`, or a trust file at a path under `VOID_TRUST_DIR` that the
 * agent process has no credentials for. For everyone else — including every
 * install using the default path — the signature still proves close to nothing
 * against the agent itself, because the recorder, the signer and the verifier
 * are one OS principal in every shipped topology
 * (docs/THREAT-MODEL.md §1.1). This is "detects tampering by a third party,
 * not by the agent itself", with the third party defined narrowly, and no
 * non-repudiation or tamper-proofing against a compromised agent.
 */

import { createPublicKey } from "node:crypto";
import { mkdir, open, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { configuredEnvValue } from "./env-compat.ts";

import { devKeyDir, devKeyIdFromSpki, keyProviderFromPkcs8, retainedKeyProvider } from "./sign.ts";
import type { KeyProvider } from "./index.ts";
import type { JsonlEntry } from "./store.ts";
import { readLedgerEntries, type PublicKeyLookup } from "./verify.ts";

/** Base64 SPKI DER, inline. Supplied out of band, never written to a file. */
export const PINNED_KEY_ENV = "NOMO_VERIFY_KEY";
/** Path to a file holding one base64 SPKI DER public key. */
export const PINNED_KEY_FILE_ENV = "NOMO_VERIFY_KEY_FILE";
/** Directory holding the pinned key file when the path is not given. */
export const TRUST_DIR_ENV = "NOMO_TRUST_DIR";
/** Explicit opt-in to degraded private-key paths, on top of NOMO_SIGNING_KEY. */
export const DEGRADED_KEY_ENV = "NOMO_VERIFY_ALLOW_SIGNING_KEY";
export const PINNED_KEY_FILE_NAME = "verify-ed25519.spki";

/**
 * The one line every surface prints when it is verifying in a degraded mode.
 *
 * It leads with the opt-in, not with the explanation, because an operator who
 * lands in this mode by accident cannot find the switch that put them there
 * and every one of these surfaces truncates this line to the terminal width —
 * the tail is what gets cut, so the actionable part has to be at the front.
 * This is the only place the degraded mode is described; every surface renders
 * this string rather than restating it.
 */
export const DEGRADED_VERIFICATION_NOTE =
  "NOMO_VERIFY_ALLOW_SIGNING_KEY / NOMO_SIGNING_KEY: the verification key came from signing key material, so a replaced key file cannot be detected in this mode";

/**
 * The one line every surface prints beside a trust file that lives where the
 * agent can reach it. It is a note about the file, not about the key: reading
 * a trust file is not what makes verification weak, sharing a directory tree
 * with the signing key is.
 */
export const TRUST_FILE_NOTE =
  "the trust file shares ~/.void/ with the signing key, so anyone who can replace the key file can replace this one too; key substitution is only detected by a holder of a key obtained out of band";

/**
 * A trust file outside the VOID data tree is reported as operator-supplied,
 * but VOID infers that from the path alone. It cannot tell who wrote the
 * bytes, so a path the agent happens to have credentials for is accepted the
 * same way. This is the weakest claim in the resolution order, and it used to
 * be printed as a bare `PASS` with no caveat at all.
 */
export const OUT_OF_TREE_TRUST_FILE_NOTE =
  "this trust file is outside the VOID data tree, which VOID takes as operator-supplied from the path alone; it cannot prove who wrote the bytes, so a path the agent can also write is accepted";

/**
 * The one line every surface prints when nothing at all was configured. No
 * key means no signature was checked, which is neither authenticated nor
 * cleanly unauthenticated: it is the state a caller must not mistake for
 * either.
 */
export const NO_VERIFICATION_KEY_NOTE =
  "no verification key is configured, so no signature was checked; hash links are intact and nothing is authenticated";

/**
 * Where the key came from. The file branch is called `trust-file`, not
 * "pinned": the file it names lives in the same tree as the signing key, and
 * reading it proves nothing about who wrote it. Only a key supplied out of
 * band, or a trust file outside the VOID data tree, is a pin.
 */
export type VerificationKeySource =
  | "pinned-env"
  | "trust-file"
  | "signing-key-env"
  | "signing-key-provider"
  | "signing-key-file";

export type VerificationKey = {
  /**
   * A lookup that answers for exactly one key id. A bound key answers for the
   * id the records of that key carry, so a substituted key is reported as an
   * unknown key id rather than as a signature that happens to fail.
   */
  readonly publicKey: PublicKeyLookup;
  readonly keyId: string;
  readonly source: VerificationKeySource;
  /**
   * True when private key material was involved in resolving this key, which
   * is the one fact that makes the check worthless against its own writer.
   * It is never inferred from having read a file, and it is derived in exactly
   * one place, `verificationKeyFrom`, so the two can never disagree.
   */
  readonly degraded: boolean;
  /**
   * True only when the bytes came from the operator and the agent could not
   * have chosen them: `VOID_VERIFY_KEY`, or a trust file at a path outside the
   * default `~/.void/trust/` location. False for a trust file at the default
   * path, and for every source that reads signing key material.
   */
  readonly operatorSupplied: boolean;
  /** The same bytes as a value, for a verifier that has to hand them on. */
  readonly spki: Uint8Array;
};

/**
 * The four facts every surface needs in order to describe a resolved key, and
 * the only shape the vocabulary below accepts. Deliberately narrower than
 * `VerificationKey`: a surface describes a key here, it never re-derives one.
 */
export type VerificationFacts = {
  readonly keyId: string;
  readonly source: VerificationKeySource;
  readonly degraded: boolean;
  readonly operatorSupplied: boolean;
};

/**
 * The caveat a resolved key carries, or undefined when it carries none.
 *
 * This is the single derivation of "is there anything to disclose here", so
 * `verify`, `doctor`, `watch`, the TUI, `export`/`attest` and the control-plane
 * API cannot drift apart on which states deserve a warning. The order is
 * fixed and total: private material first, then the trust file, then nothing.
 */
export function verificationKeyNote(key: VerificationFacts): string | undefined {
  if (key.degraded) return DEGRADED_VERIFICATION_NOTE;
  if (key.source === "trust-file")
    return key.operatorSupplied ? OUT_OF_TREE_TRUST_FILE_NOTE : TRUST_FILE_NOTE;
  return undefined;
}

/**
 * The one line a surface prints about the key it checked with. `pinned`
 * appears only for a key the operator supplied out of band, which is the one
 * state where that word is earned: a trust file at the default path lives in
 * the same tree as the signing key, so calling it pinned claims a separation
 * it does not have.
 */
export function verificationKeyLine(key: VerificationFacts): string {
  const note = verificationKeyNote(key);
  if (key.degraded)
    return `verification key: DEGRADED ${key.keyId} (${key.source}): ${note}`;
  if (key.source === "trust-file" && !key.operatorSupplied)
    return `verification key: ${key.keyId} (${key.source}): ${note}`;
  return `verification key: pinned ${key.keyId} (${key.source})${note === undefined ? "" : `: ${note}`}`;
}

/**
 * A short state for a headline, where the long caveat does not fit.
 *
 * A binary `verified` is not enough on a status line, for two reasons that
 * pull in opposite directions and both have to be honoured at once.
 *
 * Which key answered matters: "verified against a key this process could also
 * have replaced" and "verified against a key the operator supplied" are
 * different claims and must not read the same.
 *
 * And the word `verified` itself overclaims. What a chain signature proves is
 * that the bytes came from a process holding a particular key, and that the
 * chain is internally consistent. It does not prove nobody rewrote the
 * history, because in every shipped topology the recorder, the signer and the
 * verifier are one OS principal. So the honest headline says what was
 * established, `integrity only`, rather than leaving `verified` to be read as
 * tamper-evidence it is not. An independent review recommended exactly this,
 * and it is the cheapest true change available: it removes a claim the code
 * cannot back, and it does not pretend the boundary moved.
 */
export function verificationStatus(key: VerificationFacts): string {
  if (key.degraded) return "DEGRADED, integrity only (key from signing key material)";
  if (key.source === "trust-file" && !key.operatorSupplied)
    return "integrity only, verified against a trust file the agent can also replace (key substitution NOT detected)";
  return "integrity only, verified against a key supplied out of band";
}

/** A public key bound to the one key id the records of that key carry. */
export type BoundKey = {
  readonly keyId: string;
  readonly publicKey: PublicKeyLookup;
};

type KeySourceFacts = {
  readonly source: VerificationKeySource;
  /** True when the bytes came out of private key material. */
  readonly privateMaterial: boolean;
  /** True when the operator supplied the bytes where the agent cannot reach. */
  readonly operatorSupplied: boolean;
};

/**
 * The single place a `VerificationKey` is built, so `degraded` has one
 * derivation. It is the private-material fact and nothing else: reading a file
 * is not a reason to report a key as safe.
 */
function verificationKeyFrom(
  bound: BoundKey,
  spki: Uint8Array,
  facts: KeySourceFacts,
): VerificationKey {
  return {
    ...bound,
    spki,
    source: facts.source,
    degraded: facts.privateMaterial,
    operatorSupplied: facts.operatorSupplied,
  };
}

/** Decode and validate a base64 SPKI DER ed25519 public key. */
export function publicKeyFromSpkiBase64(encoded: string, label = "public key"): Uint8Array {
  const der = Buffer.from(encoded.trim(), "base64");
  if (der.length === 0) throw new TypeError(`${label} is empty, expected base64 SPKI DER`);
  let key;
  try {
    key = createPublicKey({ key: der, format: "der", type: "spki" });
  } catch {
    throw new TypeError(`${label} is not a valid base64 SPKI DER public key`);
  }
  if (key.asymmetricKeyType !== "ed25519")
    throw new TypeError(`${label} is ${String(key.asymmetricKeyType)}, expected ed25519`);
  return new Uint8Array(der);
}


export type PinnedKeyFileOptions = {
  readonly home?: string;
  /** Default trust file. Off unless the caller is the operator's own process. */
  readonly allowDefault?: boolean;
};

/**
 * The default trust file, and what it is worth.
 *
 * The default lives under `~/.void/trust/`, which is **not** a separate trust
 * domain from `~/.void/keys/`: `~/.void/` is the common ancestor, so anyone who
 * can replace the signing key file can replace this one too. The file mode is
 * `0400`, which refuses an in-place write by a different user and is no defence
 * at all against its own owner, who may unlink and recreate it.
 *
 * It stays there anyway. There is no location on a single-user host that a
 * same-uid attacker cannot also write, so moving it would buy no security and
 * would silently strand every pin already provisioned at the old path. The
 * out-of-tree location is `VOID_TRUST_DIR`, and a key there is what
 * `operatorSupplied: true` reports.
 */
export function pinnedKeyFile(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
  options: PinnedKeyFileOptions = {},
): string | undefined {
  const explicit = configuredEnvValue(env, PINNED_KEY_FILE_ENV);
  if (explicit !== undefined && explicit !== "") return explicit;
  const trustDir = configuredEnvValue(env, TRUST_DIR_ENV);
  if (trustDir !== undefined && trustDir !== "") return join(trustDir, PINNED_KEY_FILE_NAME);
  // `HOME` set means the caller named the home it operates in, which is what
  // an injected env carries. Without it the default trust file is not read at
  // all, so a test env can never pick up the operator's real pinned key.
  if (options.allowDefault ?? (env === process.env || env.HOME !== undefined))
    return join(
      options.home ?? env.HOME ?? homedir(),
      ".void",
      "trust",
      PINNED_KEY_FILE_NAME,
    );
  return undefined;
}

/** Bind a public key to the one key id the records of that key carry. */
export function pinnedKey(spki: Uint8Array): BoundKey {
  const keyId = devKeyIdFromSpki(spki);
  return { keyId, publicKey: (id) => (id === keyId ? spki : null) };
}

/**
 * A key the operator handed in directly, as base64 SPKI. This is the only
 * resolution that is unambiguously out of band, because no file the agent can
 * write holds these bytes: a bundle reviewer passes the recorder's key on the
 * command line, and `void verify --key` does the same.
 */
export function verificationKeyFromBase64(
  encoded: string,
  label = "verification key",
): VerificationKey {
  const spki = publicKeyFromSpkiBase64(encoded, label);
  return verificationKeyFrom(pinnedKey(spki), spki, {
    source: "pinned-env",
    privateMaterial: false,
    operatorSupplied: true,
  });
}

export type ResolveVerificationKeyOptions = {
  readonly env?: Readonly<NodeJS.ProcessEnv>;
  readonly home?: string;
  /**
   * Opt in to the degraded paths that read private key material. A configured
   * `VOID_SIGNING_KEY` counts as opting in on its own: naming a signing key is
   * an explicit choice, and the result still reports itself as degraded.
   */
  readonly allowDegraded?: boolean;
  /**
   * The caller's own signer, used only by a degraded resolution. It may
   * return undefined when the caller has no retained key: a read path must be
   * able to say "no key" rather than mint one to have something to degrade to.
   */
  readonly signingKey?: () => Promise<KeyProvider | undefined>;
  /** Key directory for the degraded development key file. Never creates one. */
  readonly keyDir?: string;
  /** Read the default trust file for an injected env. Off by default. */
  readonly allowDefaultTrustFile?: boolean;
};

/**
 * Resolve the key a verifier checks with. Returns undefined when nothing is
 * configured: callers must then report integrity without claiming
 * authentication rather than quietly reading a private key.
 *
 * No branch here creates key material, and none reports `degraded: false`
 * because a file was read. `degraded` says whether private key material was
 * involved; `operatorSupplied` says whether the operator chose these bytes in
 * a place the agent cannot reach, which for the default trust file it did not.
 */
export async function resolveVerificationKey(
  options: ResolveVerificationKeyOptions = {},
): Promise<VerificationKey | undefined> {
  const env = options.env ?? process.env;
  const allowDefault =
    options.allowDefaultTrustFile ?? (env === process.env || env.HOME !== undefined);

  const inline = configuredEnvValue(env, PINNED_KEY_ENV);
  if (inline !== undefined && inline !== "") {
    const spki = publicKeyFromSpkiBase64(inline, PINNED_KEY_ENV);
    return verificationKeyFrom(pinnedKey(spki), spki, {
      source: "pinned-env",
      privateMaterial: false,
      operatorSupplied: true,
    });
  }

  const file = pinnedKeyFile(env, { home: options.home, allowDefault });
  if (file !== undefined) {
    let text: string | undefined;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error(
          `trust file ${file} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    if (text !== undefined) {
      const spki = publicKeyFromSpkiBase64(text, file);
      // The default path is inside the VOID data tree, the same tree the
      // signing key lives in, so calling it pinned would claim a separation it
      // does not have. An explicitly configured path counts as
      // operator-supplied only when it is somewhere else entirely.
      const defaultPath = join(
        options.home ?? env.HOME ?? homedir(),
        ".void",
        "trust",
        PINNED_KEY_FILE_NAME,
      );
      return verificationKeyFrom(pinnedKey(spki), spki, {
        source: "trust-file",
        privateMaterial: false,
        operatorSupplied: resolve(file) !== resolve(defaultPath),
      });
    }
  }

  const inlineSigning = configuredEnvValue(env, "NOMO_SIGNING_KEY");
  const opt = configuredEnvValue(env, DEGRADED_KEY_ENV);
  if (
    !(
      options.allowDegraded === true ||
      (inlineSigning !== undefined && inlineSigning !== "") ||
      opt === "1" ||
      opt === "true" ||
      opt === "yes"
    )
  )
    return undefined;

  const provider =
    inlineSigning !== undefined && inlineSigning !== ""
      ? keyProviderFromPkcs8(Buffer.from(inlineSigning, "base64"))
      : options.signingKey !== undefined
        ? await options.signingKey()
        : options.keyDir !== undefined
          ? await retainedKeyProvider({ dir: options.keyDir, env }).catch((error: unknown) => {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
              return undefined;
            })
          : undefined;
  if (provider === undefined) return undefined;
  const keyId = await provider.currentKeyId();
  const spki = await provider.publicKey(keyId);
  if (spki === null) return undefined;
  return verificationKeyFrom(
    { keyId, publicKey: (id) => provider.publicKey(id) },
    spki,
    {
      source:
        inlineSigning !== undefined && inlineSigning !== ""
          ? "signing-key-env"
          : options.signingKey !== undefined
            ? "signing-key-provider"
            : "signing-key-file",
      privateMaterial: true,
      operatorSupplied: false,
    },
  );
}

export type PinVerificationKeyResult = {
  readonly path: string;
  readonly keyId: string;
  readonly created: boolean;
  /**
   * The anchored bytes, base64 SPKI DER. A public key, so printing it is
   * safe, and the operator has to be able to see and compare it.
   */
  readonly spkiBase64: string;
  /**
   * Where the bytes came from, and therefore how much the pin is worth. A
   * `signing-key-file` pin anchors whatever that file holds at this moment; a
   * key the operator supplied out of band anchors itself.
   */
  readonly anchoredFrom: "signing-key-file" | "signing-key-env" | "operator-spki";
};

/**
 * Provision a trust file holding one public key. The bytes may come from
 * anywhere; what matters is that the caller can show the operator which bytes
 * they are, because a pin is only as good as the moment it was taken.
 *
 * `O_EXCL` and mode `0400` are correct and stay: a symlink or a pre-placed
 * file at the trust path is refused rather than followed. Neither is a defence
 * against the file's own owner, who may unlink the trust file and create
 * another one in its place.
 */
export async function pinVerificationKey(
  spki: Uint8Array,
  options: {
    readonly file?: string;
    readonly env?: Readonly<NodeJS.ProcessEnv>;
    readonly home?: string;
    /** Recorded so a caller can tell the operator how the bytes were obtained. */
    readonly anchoredFrom: PinVerificationKeyResult["anchoredFrom"];
  } = { anchoredFrom: "operator-spki" },
): Promise<PinVerificationKeyResult> {
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? homedir();
  const file =
    options.file ??
    pinnedKeyFile(env, { home }) ??
    join(home, ".void", "trust", PINNED_KEY_FILE_NAME);
  const keyId = devKeyIdFromSpki(spki);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  try {
    // O_EXCL: a symlink or a pre-placed file at the trust path is refused
    // rather than followed, the same rule the signing key file follows.
    const handle = await open(file, "wx", 0o400);
    try {
      await handle.writeFile(`${Buffer.from(spki).toString("base64")}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return {
      path: file,
      keyId,
      created: true,
      spkiBase64: Buffer.from(spki).toString("base64"),
      anchoredFrom: options.anchoredFrom,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = devKeyIdFromSpki(publicKeyFromSpkiBase64(await readFile(file, "utf8"), file));
    if (existing !== keyId)
      throw new Error(
        `a different verification key is already pinned at ${file} (${existing}); remove it deliberately to repin`,
      );
    return {
      path: file,
      keyId,
      created: false,
      spkiBase64: Buffer.from(spki).toString("base64"),
      anchoredFrom: options.anchoredFrom,
    };
  }
}

/**
 * Provisioning from a signing key: the documented first-run path, and the
 * weakest one. The pin is a pure function of whatever `dev-ed25519.pkcs8`
 * holds at this moment, so a key file that was already replaced before the
 * operator ran this becomes the permanent anchor, and `pinVerificationKey`
 * then refuses to change it. The caller is told which case it is in through
 * `anchoredFrom` and must say so out loud. `pinVerificationKey` with a key the
 * operator obtained out of band is the one that anchors something the agent
 * did not choose.
 */
export async function pinVerificationKeyFromSigner(
  options: {
    readonly env?: Readonly<NodeJS.ProcessEnv>;
    readonly keyDir?: string;
    readonly file?: string;
    readonly home?: string;
  } = {},
): Promise<PinVerificationKeyResult> {
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? homedir();
  const keyDir = options.keyDir ?? devKeyDir(home);
  const inline = configuredEnvValue(env, "NOMO_SIGNING_KEY");
  let provider: KeyProvider;
  if (inline !== undefined && inline !== "") {
    provider = keyProviderFromPkcs8(Buffer.from(inline, "base64"));
  } else {
    try {
      provider = await retainedKeyProvider({ dir: keyDir, env });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // A command whose job is to anchor an existing key must never be the
      // thing that creates it: a pin of a key this call just minted is a pin
      // of nothing, because the key's only existence is the act of pinning
      // it. Refuse in words an operator can act on, not as a bare lstat error.
      throw new Error(
        `no key to anchor: ${keyDir}/dev-ed25519.pkcs8 does not exist. ` +
          `This command pins a key that already exists and never creates one. ` +
          `Use \`void tui\` once to create it, or pin a key obtained out of band with \`void init --from-spki <base64>\`.`,
      );
    }
  }
  const keyId = await provider.currentKeyId();
  const spki = await provider.publicKey(keyId);
  if (spki === null) throw new Error(`signing key ${keyId} published no public key to pin`);
  return pinVerificationKey(spki, {
    file: options.file,
    env,
    home,
    anchoredFrom: inline !== undefined && inline !== "" ? "signing-key-env" : "signing-key-file",
  });
}

export type SigningKeyIdsInLedgersOptions = {
  readonly env?: Readonly<NodeJS.ProcessEnv>;
  readonly home?: string;
  /** Ledger directory. Defaults to `VOID_LEDGER_DIR`, else `~/.void/ledger`. */
  readonly dir?: string;
};

/**
 * Which key ids the ledgers on disk actually carry, and how many entries each
 * one signed.
 *
 * This is the question a trust anchor has to answer for itself. Whether a key
 * has signed anything is a fact about the ledgers, not about the key file, so
 * it is read out of the `key_id` the entries record — the same field a
 * verifier resolves against, and the field whose mismatch produces `entry 1
 * has no public key for ...`. A pin whose key id appears nowhere here anchors
 * a key that has signed nothing, which a reader cannot see from the trust
 * file alone: it looks exactly like a successful pin.
 *
 * A ledger that will not parse is skipped rather than thrown. It is evidence
 * about no key either way, and a pin must not fail because some unrelated
 * file in the ledger directory is malformed.
 */
export async function signingKeyIdsInLedgers(
  options: SigningKeyIdsInLedgersOptions = {},
): Promise<Map<string, number>> {
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? homedir();
  const dir = options.dir ?? configuredEnvValue(env, "NOMO_LEDGER_DIR") ?? join(home, ".void", "ledger");
  const counts = new Map<string, number>();
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (error) {
    // No ledger directory is a state, not a fault: nothing has been recorded,
    // so nothing has signed anything, and the caller reports exactly that.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return counts;
    throw error;
  }
  for (const name of files) {
    if (!name.endsWith(".jsonl")) continue;
    let entries: JsonlEntry[];
    try {
      entries = await readLedgerEntries(join(dir, name));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (typeof entry.key_id !== "string" || entry.key_id === "") continue;
      counts.set(entry.key_id, (counts.get(entry.key_id) ?? 0) + 1);
    }
  }
  return counts;
}
