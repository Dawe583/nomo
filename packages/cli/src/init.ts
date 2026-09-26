/**
 * Workspace setup. Creates the local encrypted storage layout and nothing
 * else: no provider is contacted, no model is called, no key is printed.
 * Running it twice is safe and changes nothing the second time.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { LocalStorage } from "../../workbench/src/storage.ts";
import {
  pinVerificationKey,
  pinVerificationKeyFromSigner,
  publicKeyFromSpkiBase64,
} from "../../ledger/src/verify-key.ts";

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
        ? (env.VOID_DATA_DIR ?? join(env.HOME ?? homedir(), ".void", "workbench"))
        : resolve(dir),
    pinVerifyKey,
    ...(fromSpki === undefined ? {} : { fromSpki }),
  };
}

const INIT_USAGE =
  "usage: void init [--data-dir PATH] [--pin-verify-key] [--from-spki base64-spki]";

/**
 * First-run provisioning of the verification key.
 *
 * Two forms, and the difference is the whole point:
 *
 * - `--from-spki <base64>` pins a key the operator obtained out of band. It
 *   anchors itself, and it is the only form that detects a key file that was
 *   already replaced.
 * - `--pin-verify-key` derives the pin from `dev-ed25519.pkcs8`. That anchors
 *   whatever the key file holds **at this moment** and detects only subsequent
 *   substitution. A key file replaced before this ran becomes the permanent
 *   anchor, because a pin is never silently replaced. So the SPKI is printed,
 *   for the operator to compare against what they believe is the key, and the
 *   limitation is stated rather than left to a reader of the source.
 */
async function pinVerifyKey(
  dir: string,
  env: Readonly<NodeJS.ProcessEnv>,
  fromSpki: string | undefined,
): Promise<string[]> {
  const pinned =
    fromSpki === undefined
      ? await pinVerificationKeyFromSigner({ env, keyDir: join(dir, "keys") })
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
          "  this anchors whatever the local key file holds right now, and detects only a LATER change to it",
          "  if the key file was already replaced, this pinned the wrong key; compare the spki above against the key you expect",
          "  for a key obtained out of band, run `void init --from-spki <base64>` instead",
        ]),
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
    io.stdout("next: run `void tui` to open the workspace");
    io.stdout("next: connect a provider with /connect inside the TUI");
    io.stdout("next: verify the setup with `void doctor`");
    return 0;
  } catch (error) {
    io.stderr(`init failed: ${message(error)}`);
    return 1;
  }
}
