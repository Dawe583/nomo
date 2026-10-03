/**
 * Where the ledger is, before anything reads it.
 *
 * Every command that takes a ledger resolves it here, and it returns a result
 * rather than throwing. The reason is history: `void verify`, `void metrics`
 * and the export/attest pair each resolved the path on their own and each let
 * `fs.stat` raise, so an operator who passed a readable but empty directory
 * was answered with `ENOENT ... /<dir>/default.jsonl` — a file they never
 * named and may not have. One helper, one answer.
 *
 * Four situations used to collapse into that single errno. They are now
 * separate results, because they are separate operational problems:
 *
 *  - `absent`            the path named does not exist;
 *  - `empty-directory`   the directory exists and holds no `*.jsonl` at all;
 *  - `workspace-absent`  the directory holds ledgers, just not this workspace;
 *  - `unreadable`        the filesystem refused, which is a permissions
 *                        problem and not a missing file;
 *  - `not-a-file`        `--file` was pointed at a directory.
 *
 * Every message names what the caller actually passed. When nothing was passed
 * the default location is named, because that is what was resolved, and it is
 * labelled as the default rather than presented as an operator's argument.
 */
import { readdir, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * `workspace` reads one workspace, so a directory resolves to the workspace
 * file inside it. `scan` reads a directory whole — it exists to count the
 * ledgers that do not verify — so an empty directory is a report of zeroes, not
 * a refusal, and only an absent or unreadable path stops the measurement.
 */
export type LedgerMode = "workspace" | "scan";

export type LedgerRequest = {
  readonly mode: LedgerMode;
  /** An explicit single file (`--file` on `void verify`). */
  readonly file?: string | undefined;
  /** The ledger file or ledger directory the caller named. */
  readonly ledger?: string | undefined;
  /** Overrides `VOID_WORKSPACE`; a `--workspace <name>` the operator passed. */
  readonly workspace?: string | undefined;
  readonly env: Readonly<NodeJS.ProcessEnv>;
};

export type LedgerResolution =
  | {
      readonly ok: true;
      readonly path: string;
      /** Exactly what the caller named, or the default when they named nothing. */
      readonly requested: string;
      readonly requestedByCaller: boolean;
      readonly directory: boolean;
    }
  | {
      readonly ok: false;
      readonly kind:
        | "absent"
        | "empty-directory"
        | "workspace-absent"
        | "unreadable"
        | "not-a-file";
      readonly requested: string;
      readonly path: string;
      readonly message: string;
    };

const code = (error: unknown): string =>
  (error as NodeJS.ErrnoException | undefined)?.code ?? "";

const fail = (
  kind: Extract<LedgerResolution, { ok: false }>["kind"],
  requested: string,
  path: string,
  lines: readonly string[],
): Extract<LedgerResolution, { ok: false }> => ({
  ok: false,
  kind,
  requested,
  path,
  message: lines.join("\n  "),
});

export async function resolveLedgerTarget(
  request: LedgerRequest,
): Promise<LedgerResolution> {
  const env = request.env;
  const workspace = request.workspace ?? env.VOID_WORKSPACE ?? "default";
  const defaultFile = join(
    env.VOID_LEDGER_DIR ?? join(homedir(), ".void", "ledger"),
    `${workspace}.jsonl`,
  );
  const requested = request.file ?? request.ledger ?? defaultFile;
  const requestedByCaller =
    request.file !== undefined ||
    request.ledger !== undefined ||
    request.workspace !== undefined;
  const found =
    request.file !== undefined
      ? "--file"
      : request.ledger !== undefined
        ? "--ledger"
        : "--workspace";

  let info: Stats;
  try {
    info = await stat(requested);
  } catch (error) {
    if (code(error) === "ENOENT")
      return requestedByCaller
        ? fail("absent", requested, requested, [
            `no ledger at the path you passed: ${requested}`,
            `that is what ${found} resolves to here, and it does not exist`,
            "a ledger is created on first use; `void doctor` shows where VOID looks",
          ])
        : fail("absent", requested, requested, [
            `no ledger at ${requested} (the resolved default location; name one with --ledger or --workspace)`,
            "pass --ledger <dir-or-file>, or set VOID_LEDGER_DIR",
            "a ledger is created on first use",
          ]);
    return fail("unreadable", requested, requested, [
      `cannot read the ledger path you passed: ${requested}`,
      `${code(error) || "unknown error"}: the filesystem refused access, which is a permissions problem rather than a missing file`,
    ]);
  }

  if (!info.isDirectory())
    return { ok: true, path: requested, requested, requestedByCaller, directory: false };

  if (request.file !== undefined)
    return fail("not-a-file", requested, requested, [
      `${requested} is a directory, not a ledger file`,
      "pass --ledger with the directory instead, and name the workspace if it is not the default",
    ]);

  if (request.mode === "scan")
    return { ok: true, path: requested, requested, requestedByCaller, directory: true };

  const candidate = join(requested, `${workspace}.jsonl}`);
  let candidateInfo: Stats;
  try {
    candidateInfo = await stat(candidate);
  } catch (error) {
    if (code(error) !== "ENOENT")
      return fail("unreadable", requested, candidate, [
        `cannot read ${candidate} inside the ledger directory you passed: ${requested}`,
        `${code(error) || "unknown error"}: the filesystem refused access, which is a permissions problem rather than a missing file`,
      ]);
    let names: string[];
    try {
      names = await readdir(requested);
    } catch (error) {
      return fail("unreadable", requested, requested, [
        `cannot list the ledger directory you passed: ${requested}`,
        `${code(error) || "unknown error"}: the filesystem refused access, which is a permissions problem rather than a missing file`,
      ]);
    }
    const ledgers = names.filter((name) => name.endsWith(".jsonl")).sort();
    if (!ledgers.length)
      return fail("empty-directory", requested, candidate, [
        `the ledger directory you passed is empty: ${requested}`,
        "it holds no *.jsonl ledger, so there is nothing to read",
        "a ledger is created there on the first recorded operation",
      ]);
    return fail("workspace-absent", requested, candidate, [
      `the ledger directory you passed has no ${workspace}.jsonl: ${requested}`,
      `it holds: ${ledgers.join(", ")}`,
      "pass --workspace <name> for one of those, or --ledger <file>",
    ]);
  }

  if (!candidateInfo.isFile())
    return fail("not-a-file", requested, candidate, [
      `${candidate} is not a regular file`,
      "pass a readable *.jsonl ledger, or the directory that holds one",
    ]);

  return { ok: true, path: candidate, requested, requestedByCaller, directory: true };
}