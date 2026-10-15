/**
 * Workspace setup. Creates the local encrypted storage layout and nothing
 * else: no provider is contacted, no model is called, no key is printed.
 * Running it twice is safe and changes nothing the second time.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { LocalStorage } from "../../workbench/src/storage.ts";
import { devKeyDir, retainedKeyProvider } from "../../ledger/src/sign.ts";
import {
  pinVerificationKey,
  pinVerificationKeyFromSigner,
  publicKeyFromSpkiBase64,
  signingKeyIdsInLedgers,
} from "../../ledger/src/verify-key.ts";
import { dataDir } from "../../ledger/src/paths.ts";


export type InitIo = {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
};
export type InitDeps = { readonly env?: Readonly<NodeJS.ProcessEnv> };

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export type InitOptions = {
  readonly dir: string;
  /** Set by `--pin-verify-key`: derive the public key and pin it. */
  readonly pinVerifyKey: boolean;
  /**
   * Set by `--from-spki <base64>`: pin a key the operator obtained out of
   * band, which is the only form of pin that anchors something the local key
   * file did not choose.
   */
  readonly fromSpki?: string;
};

export function resolveInitOptions(
  argv: readonly string[],
  env: Readonly<NodeJS.ProcessEnv>,
): InitOptions {
  let dir: string | undefined;
  let pinVerifyKey = false;
  let fromSpki: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--data-dir") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--"))
        throw Error(INIT_USAGE);
      dir = value;
      i++;
    } else if (argv[i] === "--from-spki") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw Error(`${"--from-spki"} needs a value`);
      fromSpki = value;
      i++;
    } else if (argv[i] === "--pin-verify-key") pinVerifyKey = true;
    else throw Error(INIT_USAGE);
  }
  if (fromSpki !== undefined && pinVerifyKey)
    throw Error("--from-spki already names the key; do not combine it with --pin-verify-key");
  if (fromSpki !== undefined) pinVerifyKey = true;
  return {
    dir:
      dir === undefined
        ? (env.NOMO_DATA_DIR ?? join(dataDir(env.HOME ?? homedir()), "workbench"))
        : resolve(dir),
    pinVerifyKey,
    ...(fromSpki === undefined ? {} : { fromSpki }),
  };
}

const INIT_USAGE =
  "usage: nomo init [--data-dir PATH] [--pin-verify-key] [--from-spki base64-spki]";

/**
 * The signing key id already present in a key directory, or undefined when
 * there is none. Never creates one: a read that minted a key would report the
 * key it just made as pre-existing.
 */
async function retainedKeyId(
  keyDir: string,
  env: Readonly<NodeJS.ProcessEnv>,
): Promise<string | undefined> {
  try {
    return await (await retainedKeyProvider({ dir: keyDir, env })).currentKeyId();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * What the anchored key has actually signed, and what has signed instead.
 *
 * The single most important line this command can print is "this key has not
 * signed anything yet". A pin that reads as success while naming a key no
 * ledger has ever been signed with is the defect this reports: the operator
 * sees `trust-file` appear in `nomo doctor`, concludes the setup is now
 * authenticated, and has anchored nothing at all.
 */
async function signingReport(
  keyId: string,
  env: Readonly<NodeJS.ProcessEnv>,
  home: string,
): Promise<string[]> {
  const ledgerDir = env.NOMO_LEDGER_DIR ?? join(dataDir(home), "ledger");
  const counts = await signingKeyIdsInLedgers({ env, home });
  const signed = counts.get(keyId) ?? 0;
  if (signed > 0)
    return [`  signed ${signed} ledger entr${signed === 1 ? "y" : "ies"} in ${ledgerDir}`];
  if (counts.size === 0)
    return [
      `  this key has not signed anything yet: no ledger in ${ledgerDir} carries it`,
    ];
  const others = [...counts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, n]) => `${id} (${n} ${n === 1 ? "entry" : "entries"})`)
    .join(", ");
  return [
    `  this key has not signed anything yet. The ${counts.size} key id${counts.size === 1 ? "" : "s"} in ${ledgerDir} are: ${others}`,
    `  anchoring this key makes \`nomo verify\` refuse every existing ledger until they are re-signed with it`,
  ];
}

/**
 * The one line that catches a `--data-dir` naming a different key location.
 *
 * `--data-dir` chooses where workspace state lives. It must not silently
 * choose which key gets anchored, and it no longer does: the anchor is always
 * the shared signing key. When the data directory holds a key of its own this
 * says so, because that key signs the workbench document ledger and an
 * operator who assumed `--data-dir` moved it deserves to be told it did not.
 */
async function divergentKeyNote(
  dir: string,
  env: Readonly<NodeJS.ProcessEnv>,
  home: string,
  pinnedKeyId: string,
): Promise<string[]> {
  const keyDir = devKeyDir(home);
  const dataKeyDir = join(dir, "keys");
  if (resolve(dataKeyDir) === resolve(keyDir)) return [];
  const dataKeyId = await retainedKeyId(dataKeyDir, env);
  if (dataKeyId === undefined || dataKeyId === pinnedKeyId) return [];
  return [
    `  note: ${dataKeyDir}/dev-ed25519.pkcs8 holds a different key (${dataKeyId}). It signs the workbench document ledger and is not the trust anchor.`,
    `  the anchored key is ${keyDir}/dev-ed25519.pkcs8 (${pinnedKeyId}); --data-dir did not change which key is anchored`,
  ];
}
/**
 * First-run provisioning of the verification key.
 *
 * Two forms, and the difference is the whole point:
 *
 * - `--from-spki <base64>` pins a key the operator obtained out of band. It
 *   anchors itself, and it is the only form that detects a key file that was
 *   already replaced.
 * - `--pin-verify-key` derives the pin from `~/.nomo/keys/dev-ed25519.pkcs8`,
 *   the key ledgers in this installation are actually signed with. That anchors
 *   whatever that file holds **at this moment** and detects only subsequent
 *   substitution. A key file replaced before this ran becomes the permanent
 *   anchor, because a pin is never silently replaced. So the SPKI is printed,
 *   for the operator to compare against what they believe is the key, and the
 *   limitation is stated rather than left to a reader of the source.
 *
 * `--data-dir` does not appear in the derivation. It names where workspace
 * state lives; letting it choose the key made the trust anchor a function of
 * an unrelated flag, and anchored a key that had signed nothing while reading
 * as an improvement over the degraded state it replaced.
 */
async function pinVerifyKey(
  dir: string,
  env: Readonly<NodeJS.ProcessEnv>,
  fromSpki: string | undefined,
): Promise<string[]> {
  const home = env.HOME ?? homedir();
  const keyDir = devKeyDir(home);
  const pinned =
    fromSpki === undefined
      ? await pinVerificationKeyFromSigner({ env, keyDir })
      : await pinVerificationKey(publicKeyFromSpkiBase64(fromSpki, "--from-spki"), {
          env,
          anchoredFrom: "operator-spki",
        });
  return [
    pinned.created
      ? `pinned verification key ${pinned.keyId} at ${pinned.path}`
      : `verification key ${pinned.keyId} was already pinned at ${pinned.path}`,
    `  spki: ${pinned.spkiBase64}`,
    ...(pinned.anchoredFrom === "operator-spki"
      ? [
          "  this key was supplied out of band, so a key file replaced before or after this point is detected",
        ]
      : [
          `  anchored from ${keyDir}/dev-ed25519.pkcs8, the signing key the ledgers in this installation use`,
          "  this anchors whatever that key file holds right now, and detects only a LATER change to it",
          "  if the key file was already replaced, this pinned the wrong key; compare the spki above against the key you expect",
          "  for a key obtained out of band, run `nomo init --from-spki <base64>` instead",
        ]),
    ...(await signingReport(pinned.keyId, env, home)),
    ...(await divergentKeyNote(dir, env, home, pinned.keyId)),
  ];
}

export async function runInitCommand(
  argv: readonly string[],
  io: InitIo,
  deps: InitDeps = {},
): Promise<number> {
  const env = deps.env ?? process.env;
  let options: InitOptions;
  try {
    options = resolveInitOptions(argv, env);
  } catch (error) {
    io.stderr(message(error));
    return 2;
  }
  const dir = options.dir;
  try {
    if (options.pinVerifyKey)
      for (const line of await pinVerifyKey(dir, env, options.fromSpki)) io.stdout(line);
    if (existsSync(join(dir, "tui", "workspace.key"))) {
      io.stdout(`already initialized: ${dir}`);
      return 0;
    }
    void new LocalStorage(join(dir, "tui"));
    io.stdout(`created: ${dir}`);
    io.stdout("next: run `nomo tui` to open the workspace");
    io.stdout("next: connect a provider with /connect inside the TUI");
    io.stdout("next: verify the setup with `nomo doctor`");
    return 0;
  } catch (error) {
    io.stderr(`init failed: ${message(error)}`);
    return 1;
  }
}
