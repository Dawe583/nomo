import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { checkAnchors, readAnchors } from "../../ledger/src/anchor.ts";
import { parseAttestationDocument, verifyAttestation } from "../../ledger/src/attest.ts";
import {
  pinnedKey,
  publicKeyFromSpkiBase64,
  resolveVerificationKey,
  verificationKeyLine,
  type VerificationKey,
} from "../../ledger/src/verify-key.ts";
import { readLedgerEntries, verifyChain } from "../../ledger/src/verify.ts";
import type { PublicKeyLookup } from "../../ledger/src/verify.ts";
import { resolveLedgerTarget } from "./ledger-target.ts";

export type VerifyCommandIo = {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly env?: Readonly<NodeJS.ProcessEnv>;
};

export type VerifyCommandOptions = {
  readonly publicKey?: PublicKeyLookup;
};

type VerifyArgs = {
  readonly ledger: string | undefined;
  readonly file: string | undefined;
  readonly attestation: string | undefined;
  readonly anchors: string | undefined;
  readonly key: string | undefined;
  readonly keyId: string | undefined;
  readonly standalone: boolean;
};

const USAGE =
  "usage: void verify --ledger <dir-or-file> [--file export.jsonl] [--attestation path] [--anchors path] [--key base64-spki] [--key-id id] [--standalone]";

type ResolvedVerifyKey = {
  readonly publicKey: PublicKeyLookup | undefined;
  /** The same key as bytes, for a verifier that runs in another process. */
  readonly spki: Uint8Array | undefined;
  readonly lines: readonly string[];
};

export async function runVerifyCommand(
  argv: readonly string[],
  io: VerifyCommandIo,
  options: VerifyCommandOptions = {},
): Promise<number> {
  try {
    const parsed = parseVerifyArgs(argv);
    const env = io.env ?? process.env;
    // The resolver answers before any reading, and its answer names what the
    // caller passed. `readLedgerEntries` used to raise the raw errno instead,
    // so an empty directory was reported as a missing `default.jsonl` the
    // operator never named.
    const resolution = await resolveLedgerTarget({
      mode: "workspace",
      file: parsed.file,
      ledger: parsed.ledger,
      env,
    });
    if (!resolution.ok) {
      io.stderr(resolution.message);
      return 1;
    }
    const ledgerPath = resolution.path;
    // A verifier never mints a key and never falls back to the private key
    // file: an attacker who can replace that file must not be able to redefine
    // what "valid" means. The resolved source is printed, always.
    const key = await resolveVerifyKey(parsed, env, options);
    for (const line of key.lines) io.stdout(line);
    if (parsed.standalone) return runStandalone(ledgerPath, parsed, io, key);
    const entries = await readLedgerEntries(ledgerPath);
    const chain = await verifyChain(entries, { publicKey: key.publicKey });
    for (const line of chain.lines) {
      io.stdout(line.ok ? `seq ${line.seq}: ok` : `seq ${line.seq}: fail ${line.reason}`);
    }
    if (!chain.ok) {
      io.stderr(`void verify failed: ${chain.reason}`);
      return 1;
    }
    io.stdout(`chain: ${chain.checked} entries ok`);

    if (parsed.attestation === undefined && parsed.anchors === undefined) {
      io.stdout("attestation: not checked");
      return 0;
    }

    if (parsed.attestation !== undefined) {
      const doc = parseAttestationDocument(
        JSON.parse(await readFile(parsed.attestation, "utf8")),
        parsed.attestation,
      );
      const attestation = await verifyAttestation(doc, entries, {
        publicKey: key.publicKey ?? (() => null),
      });
      if (!attestation.ok) {
        io.stdout(`attestation: mismatch ${attestation.reason}`);
        return 1;
      }
      io.stdout("attestation: match");
    }

    if (parsed.anchors !== undefined) {
      // An anchor is a signed claim about a length and a head. Without a
      // verification key the holder would be checking their own claim, so the
      // refusal is the honest result rather than a structural match.
      if (key.publicKey === undefined) {
        io.stdout("anchor: not checked, an anchor needs a verification key");
        return 1;
      }
      const read = await readAnchors(parsed.anchors);
      if (!read.ok) {
        io.stdout(`anchor: unreadable ${read.reason}`);
        return 1;
      }
      const check = await checkAnchors(read.anchors, entries, { publicKey: key.publicKey });
      if (!check.ok) {
        io.stdout(`anchor: mismatch ${check.reason}`);
        return 1;
      }
      io.stdout(
        `anchor: match head ${check.headSeq} ${check.headHash} under ${check.key_id} (${check.anchors} anchor(s) held, ${check.grown} entries since)`,
      );
    }
    return 0;
  } catch (error) {
    io.stderr(`void verify failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function parseVerifyArgs(argv: readonly string[]): VerifyArgs {
  let ledger: string | undefined;
  let file: string | undefined;
  let attestation: string | undefined;
  let anchors: string | undefined;
  let key: string | undefined;
  let keyId: string | undefined;
  let standalone = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--ledger") {
      ledger = needValue(argv, index, "--ledger");
      index += 1;
    } else if (arg === "--file") {
      file = needValue(argv, index, "--file");
      index += 1;
    } else if (arg === "--attestation") {
      attestation = needValue(argv, index, "--attestation");
      index += 1;
    } else if (arg === "--anchors") {
      anchors = needValue(argv, index, "--anchors");
      index += 1;
    } else if (arg === "--key") {
      key = needValue(argv, index, "--key");
      index += 1;
    } else if (arg === "--key-id") {
      keyId = needValue(argv, index, "--key-id");
      index += 1;
    } else if (arg === "--standalone") {
      standalone = true;
    } else {
      throw new Error(`unknown verify option ${JSON.stringify(arg)}. ${USAGE}`);
    }
  }
  return { ledger, file, attestation, anchors, key, keyId, standalone };
}

/**
 * Where the key came from, printed before anything is called verified. This
 * was the last surface still calling a default-path trust file "pinned",
 * which claimed a separation the file does not have: it shares `~/.void/`
 * with the signing key, so anyone who can replace the key file can replace it
 * too. The wording now comes from `verificationKeyLine`, the same derivation
 * every other surface renders, so the two cannot drift apart again.
 *
 * The two paths that do say "pinned" are the two where the operator handed the
 * bytes over directly: `--key` on this command line, and a caller that
 * injected its own lookup. Neither is a file the agent can reach.
 */
async function resolveVerifyKey(
  args: VerifyArgs,
  env: Readonly<NodeJS.ProcessEnv>,
  options: VerifyCommandOptions,
): Promise<ResolvedVerifyKey> {
  if (options.publicKey !== undefined)
    return {
      publicKey: options.publicKey,
      spki: undefined,
      lines: ["verification key: supplied by the caller"],
    };
  if (args.key !== undefined) {
    const spki = publicKeyFromSpkiBase64(args.key, "--key");
    const pinned = pinnedKey(spki);
    return { publicKey: pinned.publicKey, spki, lines: [`verification key: pinned ${pinned.keyId} (--key)`] };
  }
  const resolved = await resolveVerificationKey({ env });
  if (resolved === undefined)
    return {
      publicKey: undefined,
      spki: undefined,
      lines: [
        "verification key: none, signature NOT VERIFIED",
        "  pin one with `void init --pin-verify-key`, or set VOID_VERIFY_KEY to a base64 SPKI public key",
      ],
    };
  return {
    publicKey: resolved.publicKey,
    spki: resolved.spki,
    lines: [verificationKeyLine(resolved)],
  };
}
/**
 * Rechecks through the standalone script in a child process, so the proof
 * never imports this repository. A failure there is independent evidence,
 * not a second run of the same code.
 *
 * The exit code is the contract a script, a CI gate or a `set -e` wrapper
 * actually reads. The standalone script prints `signature NOT VERIFIED` and
 * exits 0 when it was given no key, so a chain whose signatures were never
 * checked used to exit 0 too. The text was honest; the exit code was not, and
 * a false pass is worse than a failure. With no key resolved, this returns
 * non-zero after the child has said plainly what it did and did not check.
 */
async function runStandalone(
  target: string,
  args: VerifyArgs,
  io: VerifyCommandIo,
  key: ResolvedVerifyKey,
): Promise<number> {
  const script = fileURLToPath(
    new URL("../../verifier/verify-ledger.mjs", import.meta.url),
  );
  const scriptArgs = [script, target];
  // A key resolved from a pin is handed on explicitly, so the independent
  // check is authenticated rather than silently reduced to hash links.
  const encoded =
    args.key ?? (key.spki === undefined ? undefined : Buffer.from(key.spki).toString("base64"));
  if (encoded !== undefined) scriptArgs.push("--public-key", encoded);
  if (args.keyId !== undefined) scriptArgs.push("--key-id", args.keyId);
  if (args.attestation !== undefined)
    scriptArgs.push("--attestation", args.attestation);
  const code = await new Promise<number>((resolveCode) => {
    execFile(process.execPath, scriptArgs, (error, stdout, stderr) => {
      const output = `${stdout ?? ""}${stderr ?? ""}`;
      for (const line of output.split("\n"))
        if (line) io.stdout(line);
      if (error === null) return resolveCode(0);
      const failed = error as { code?: unknown };
      resolveCode(typeof failed.code === "number" ? failed.code : 1);
    });
  });
  if (key.publicKey !== undefined) return code;
  io.stderr(
    "void verify failed: no verification key was resolved, so no signature was checked",
  );
  return code === 0 ? 1 : code;
}


function needValue(argv: readonly string[], index: number, name: string): string {
  const value = argv[index + 1];
  if (value === undefined || value === "") throw new Error(`${name} needs a value`);
  return value;
}

