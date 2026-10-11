/**
 * `nomo state migrate`: copy the legacy data directory into the current name.
 *
 * Four properties, each of which the tests hold separately:
 *
 * - The source is never deleted, moved or written. A migration that removes
 *   the old tree has no rollback, and the plan requires one.
 * - The copy is validated before it is installed. A rename that publishes a
 *   truncated or half-written directory turns a recoverable problem into data
 *   that looks present and cannot be read.
 * - The install is a rename, so the destination is either absent or complete.
 * - A conflict is refused. When both directories exist the operator has two
 *   real states and the tool has no basis for choosing.
 *
 * Every path it touches comes from an injected root, so the tests run in a
 * temporary directory and the developer's own `~/.void` is never a candidate.
 */
import { constants, createReadStream } from "node:fs";
import { access, cp, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DATA_DIR_NAME,
  LEGACY_DATA_DIR_NAME,
  describeState,
} from "../../ledger/src/paths.ts";

export type MigrateIo = {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
};

export type MigrateResult =
  | { readonly ok: true; readonly from: string; readonly to: string; readonly files: number; readonly verified: boolean }
  | { readonly ok: false; readonly reason: string };

type ManifestEntry = { readonly path: string; readonly bytes: number; readonly sha256: string };

/**
 * Hash every regular file under `root`, keyed by its path relative to `root`.
 *
 * The manifest is what makes "validated before installed" mean something: the
 * copy is hashed and the two manifests compared, so a truncated file or a
 * directory that lost a subtree is caught before anything is renamed into
 * place. Symlinks and other special entries are refused rather than followed,
 * because a link out of the tree would copy bytes the source does not own.
 */
async function manifest(root: string, prefix = ""): Promise<ManifestEntry[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const out: ManifestEntry[] = [];
  for (const entry of entries) {
    const relative = prefix === "" ? entry.name : join(prefix, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await manifest(root, relative)));
      continue;
    }
    if (!entry.isFile())
      throw new Error(`Refusing to migrate ${relative}: not a regular file.`);
    const path = join(root, relative);
    const info = await stat(path);
    const digest = createHash("sha256");
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(path);
      stream.on("data", (chunk) => digest.update(chunk));
      stream.on("error", reject);
      stream.on("end", () => resolve());
    });
    out.push({ path: relative, bytes: info.size, sha256: digest.digest("hex") });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

const sameManifest = (a: readonly ManifestEntry[], b: readonly ManifestEntry[]): boolean =>
  a.length === b.length &&
  a.every((entry, index) => {
    const other = b[index];
    return other !== undefined && other.path === entry.path && other.bytes === entry.bytes && other.sha256 === entry.sha256;
  });

/**
 * Copy `from` to `to` through a temporary directory beside it, verify, then
 * rename into place.
 *
 * The temporary directory is a sibling of the destination rather than a child
 * of it, so the rename stays inside one filesystem and is therefore atomic. A
 * copy interrupted part way leaves the temporary directory behind and the
 * destination still absent, which is the state an operator can retry from.
 */
export async function migrateState(home: string = homedir()): Promise<MigrateResult> {
  const state = describeState(home);
  if (!state.migrationSafe) return { ok: false, reason: state.reason };

  const staging = join(home, `.${DATA_DIR_NAME}.migrating`);
  // A staging directory left by an interrupted run is not state and not a
  // merge candidate, so it is cleared rather than treated as a conflict. The
  // source it came from is still there, untouched.
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true, mode: 0o700 });

  try {
    await cp(state.legacy, staging, { recursive: true, preserveTimestamps: true });
    const [before, after] = await Promise.all([manifest(state.legacy), manifest(staging)]);
    if (!sameManifest(before, after)) {
      await rm(staging, { recursive: true, force: true });
      return {
        ok: false,
        reason: `The copy did not match ${state.legacy} byte for byte, so nothing was installed. ${state.legacy} is unchanged.`,
      };
    }
    await rename(staging, state.current);
    return { ok: true, from: state.legacy, to: state.current, files: before.length, verified: true };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    return {
      ok: false,
      reason: `Migration failed and nothing was installed: ${error instanceof Error ? error.message : String(error)}. ${state.legacy} is unchanged.`,
    };
  }
}

const exists = async (path: string): Promise<boolean> =>
  access(path, constants.F_OK).then(
    () => true,
    () => false,
  );

export async function runMigrateStateCommand(
  argv: readonly string[],
  io: MigrateIo,
  deps: { readonly home?: string; readonly json?: boolean } = {},
): Promise<number> {
  const args = [...argv];
  let json = deps.json ?? false;
  let home = deps.home;
  while (args.length > 0) {
    const arg = args.shift();
    const value = args.shift();
    if (arg === "--json") json = true;
    else if (arg === "--home") {
      if (value === undefined) {
        io.stderr("usage: nomo state migrate [--home path] [--json]");
        return 2;
      }
      home = value;
    } else {
      io.stderr("usage: nomo state migrate [--home path] [--json]");
      return 2;
    }
  }

  const result = await migrateState(home ?? homedir());
  if (!result.ok) {
    if (json) io.stdout(JSON.stringify(result));
    else io.stderr(result.reason);
    return 1;
  }
  if (json)
    io.stdout(JSON.stringify({ ...result, legacyName: LEGACY_DATA_DIR_NAME, currentName: DATA_DIR_NAME }));
  else
    io.stdout(
      `Copied ${result.files} file(s) from ${result.from} to ${result.to}. Every file verified byte for byte. The original is untouched.`,
    );
  return 0;
}

/** What the state command reports when it is only asked, never writes. */
export function stateSummary(home: string = homedir()) {
  return describeState(home);
}

export { exists as pathExists };