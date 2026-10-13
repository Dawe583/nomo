/**
 * A private temp root for the test suite, so a test run never depends on the
 * operator remembering an environment variable.
 *
 * `packages/ledger/src/hardening.ts` refuses a state tree whose ancestor chain
 * lets another principal replace it. On POSIX that check reads mode bits, and a
 * user's `TMPDIR` is already 0700 under a path nobody else can write, so the
 * check passes and this module does nothing. On Windows the check reads ACLs,
 * and a stock profile fails it: on the machine this was written on,
 * `%LOCALAPPDATA%\Temp` carries seven non-trusted principals holding
 * Delete/ChangePermissions/TakeOwnership. That is the check being correct — a
 * signed ledger must not sit somewhere another account can swap out from under
 * it — so the fix is to give the tests a directory that passes, not to relax
 * the check.
 *
 * The Windows root needs *two* levels, which is the part that is easy to get
 * wrong. `checkWindowsPathAcl` validates the immediate parent separately from
 * the rest of the chain, and demands that the immediate parent grant nothing
 * beyond the current user, SYSTEM and Administrators. So a directory placed
 * directly under `C:\` can never pass, no matter how it is protected, because
 * `C:\` itself grants other principals. The container below is created on the
 * system volume with its inheritance stripped, and the temp root handed to the
 * tests lives *inside* it, where the immediate parent is private.
 *
 * `NOMO_TEST_TEMP_ROOT` overrides the location for anyone who keeps theirs
 * somewhere else.
 *
 * Wired in with `node --import`, which awaits this module's evaluation before
 * any test module loads, so `os.tmpdir()` already answers with the private root
 * by the time a test calls it. On a platform where the default temp directory
 * is already safe this is a no-op, which is what keeps CI on Linux and macOS
 * unaffected.
 */

import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, parse } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { assertPrivateDirectoryIfPresent } from "../../packages/ledger/src/hardening.ts";

const runFile = promisify(execFile);
const CONTAINER_NAME = "nomo-test-tmp";
const SYSTEM_ROOT = process.env.SystemRoot ?? "C:\\Windows";

/** The directory a test run should use, before it has been proven private. */
export function testTempRoot() {
  const override = process.env.NOMO_TEST_TEMP_ROOT;
  if (typeof override === "string" && override.trim() !== "") return override;
  return join(parse(homedir()).root, CONTAINER_NAME);
}

/** The parent of the temp root, which has to be private in its own right. */
export function testTempContainer() {
  return testTempRoot();
}

/**
 * Point TEMP/TMP/TMPDIR at a temp root that passes the ledger's own private
 * directory check, creating and hardening it when needed.
 *
 * Idempotent, and safe to call from several test processes at once: creating
 * the container is a directory-creation followed by an idempotent ACL write, so
 * concurrent runners converge on the same directory.
 *
 * @returns {Promise<string>} the root, or "" on a platform that needs none.
 */
export async function usePrivateTestTemp() {
  // POSIX already passes: an owner-only TMPDIR under a path nobody else can
  // write is exactly what the mode-bit check requires. Doing nothing here is
  // what keeps this a no-op in CI.
  if (process.platform !== "win32") return "";

  const root = testTempRoot();
  try {
    await protectContainer(testTempContainer());
    await assertUsable(root);
    return applyEnv(root);
  } catch (cause) {
    throw new Error(
      [
        `Could not prepare a private temp root for tests at ${root}.`,
        "packages/ledger/src/hardening.ts refuses a state tree that another",
        "principal could replace, and this one could not be made private.",
        "Set NOMO_TEST_TEMP_ROOT to a directory whose immediate parent grants",
        "nothing beyond this user, SYSTEM and Administrators.",
        `Cause: ${describe(cause)}`,
      ].join("\n"),
      { cause },
    );
  }
}

/**
 * Create the container with its inheritance stripped and grant the current
 * user full control. A subset of the three accepted principals is enough: the
 * ledger check requires every Allow rule to be one of them, not all of them.
 *
 * This uses `icacls` rather than `[System.IO.Directory]::SetAccessControl`,
 * which is what `ensurePrivateDirectory` uses. On a Windows host where the
 * container's parent is the volume root, `SetAccessControl` throws
 * UnauthorizedAccessException when it disables inheritance; `icacls` performs
 * the same change and succeeds there. The SID form is used so the grant does not
 * depend on a localized account name.
 */
async function protectContainer(directory) {
  await mkdir(directory, { recursive: true });
  const script = `
$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& (Join-Path $env:SystemRoot 'System32\\icacls.exe') $env:NOMO_ACL_FILE /inheritance:r /grant:r "*\${sid}:(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "icacls failed with exit code $LASTEXITCODE" }
`;
  await runFile(
    join(SYSTEM_ROOT, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      windowsHide: true,
      timeout: 30_000,
      env: {
        ...process.env,
        PSModulePath: join(
          SYSTEM_ROOT,
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "Modules",
        ),
        NOMO_ACL_FILE: directory,
      },
    },
  );
}

/**
 * Prove the root works by running the ledger's own check against a directory
 * created inside it, rather than trusting that the ACL write did what it said.
 * A container that protects the root but not its children is the exact failure
 * this module exists to prevent, and it would otherwise show up as a confusing
 * denial inside whichever test happened to run first.
 */
async function assertUsable(root) {
  await mkdir(root, { recursive: true });
  const probe = join(root, `.probe-${process.pid}`);
  await rm(probe, { recursive: true, force: true });
  await mkdir(probe, { recursive: true });
  try {
    const ok = await assertPrivateDirectoryIfPresent(probe, "NOMO test temp root probe");
    if (!ok) throw new Error("the probe directory was not recognised as present");
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
}

function applyEnv(root) {
  process.env.TEMP = root;
  process.env.TMP = root;
  process.env.TMPDIR = root;
  return root;
}

/** The first line of the cause, so a PowerShell script dump cannot bury it. */
function describe(cause) {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.split("\n").slice(0, 3).join(" ").slice(0, 300);
}

// Importing this module is the side effect: `node --import` awaits this module's
// evaluation, top-level await included, before any test module is loaded. Running
// it directly applies the same change and prints the result, so a developer can
// point NOMO_TEST_TEMP_ROOT at it themselves.
const root = await usePrivateTestTemp();

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly)
  process.stdout.write(`${root || `(unchanged on this platform; ${tmpdir()})`}\n`);