import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  type FileHandle,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, parse, resolve, sep } from "node:path";

const runFile = promisify(execFile);
const directoryMode = 0o700;
const fileMode = 0o600;
const WORKSPACE_PATTERN = /^[a-z0-9._-]+$/;

export type PrivatePathKind = "file" | "directory";
export type PrivatePathAudit =
  | { readonly state: "missing" }
  | { readonly state: "private" }
  | { readonly state: "unsafe"; readonly detail: string };
export type PrivateTreeAudit = {
  readonly state: "missing" | "private" | "unsafe";
  readonly files: number;
  readonly directories: number;
  readonly detail?: string;
};

// Use SIDs, not localized account names. Paths are data, never PowerShell code.
function windowsPowerShell(script: string, env: NodeJS.ProcessEnv): Promise<void> {
  return runFile(
    join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      windowsHide: true,
      timeout: 30_000,
      env: {
        ...process.env,
        // Windows PowerShell 5.1 provides the .NET Framework ACL APIs used here.
        PSModulePath: join(
          process.env.SystemRoot ?? "C:\\Windows",
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "Modules",
        ),
        ...env,
      },
    },
  ).then(() => undefined);
}

async function windowsPathAcl(
  path: string,
  kind: PrivatePathKind,
  protect = false,
): Promise<void> {
  const script = `
$ErrorActionPreference = 'Stop'
$file = $env:VOID_ACL_FILE
$kind = $env:VOID_ACL_KIND
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$tokenSids = @($sid.Value) + @([System.Security.Principal.WindowsIdentity]::GetCurrent().Groups | ForEach-Object { $_.Value }) + @('S-1-1-0')
if ($kind -eq 'directory') { $acl = [System.IO.Directory]::GetAccessControl($file) }
else { $acl = [System.IO.File]::GetAccessControl($file) }
if ($env:VOID_ACL_PROTECT -eq '1') {
  if ($kind -eq 'directory') { $acl = New-Object System.Security.AccessControl.DirectorySecurity }
  else { $acl = New-Object System.Security.AccessControl.FileSecurity }
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  $inherit = [System.Security.AccessControl.InheritanceFlags]::None
  if ($kind -eq 'directory') { $inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit }
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, $inherit, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
  if ($kind -eq 'directory') { [System.IO.Directory]::SetAccessControl($file, $acl) }
  else { [System.IO.File]::SetAccessControl($file, $acl) }
  if ($kind -eq 'directory') { $acl = [System.IO.Directory]::GetAccessControl($file) }
  else { $acl = [System.IO.File]::GetAccessControl($file) }
}
if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'unexpected owner' }
$readable = $false
$writable = $false
$denied = $false
foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
  $appliesHere = ($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0
  if ($appliesHere -and $rule.AccessControlType -eq 'Deny' -and $tokenSids -contains $rule.IdentityReference.Value -and ($rule.FileSystemRights -band ([System.Security.AccessControl.FileSystemRights]::ReadData -bor [System.Security.AccessControl.FileSystemRights]::WriteData))) { $denied = $true }
  if ($appliesHere -and $rule.AccessControlType -eq 'Allow') {
    if ($rule.IdentityReference.Value -notin @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')) { throw 'ACL grants another principal access' }
    if ($rule.IdentityReference.Value -eq $sid.Value -and ($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::ReadData)) { $readable = $true }
    if ($rule.IdentityReference.Value -eq $sid.Value -and ($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::WriteData)) { $writable = $true }
  }
}
if (-not $readable -or -not $writable -or $denied) { throw 'ACL does not grant owner effective read and write access' }
`;
  try {
    await windowsPowerShell(script, {
      VOID_ACL_FILE: path,
      VOID_ACL_KIND: kind,
      VOID_ACL_PROTECT: protect ? "1" : "0",
    });
  } catch (error) {
    throw new Error(
      `${kind} must have a private Windows ACL owned by the current user`,
      {
        cause: new Error(
          String((error as { stderr?: string }).stderr ?? "Windows ACL command unavailable")
            .trim()
            .slice(0, 1000),
        ),
      },
    );
  }
}

async function windowsPrivateTreeAcl(root: string): Promise<void> {
  const script = `
$ErrorActionPreference = 'Stop'
$root = $env:VOID_ACL_ROOT
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$tokenSids = @($sid.Value) + @([System.Security.Principal.WindowsIdentity]::GetCurrent().Groups | ForEach-Object { $_.Value }) + @('S-1-1-0')
$items = @((Get-Item -LiteralPath $root -Force)) + @(Get-ChildItem -LiteralPath $root -Force -Recurse -ErrorAction Stop)
foreach ($item in $items) {
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'state tree contains a reparse point' }
  if ($item.PSIsContainer) { $acl = [System.IO.Directory]::GetAccessControl($item.FullName) }
  else { $acl = [System.IO.File]::GetAccessControl($item.FullName) }
  if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'unexpected owner in state tree' }
  $readable = $false
  $writable = $false
  $denied = $false
  foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    $appliesHere = ($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0
    if ($appliesHere -and $rule.AccessControlType -eq 'Deny' -and $tokenSids -contains $rule.IdentityReference.Value -and ($rule.FileSystemRights -band ([System.Security.AccessControl.FileSystemRights]::ReadData -bor [System.Security.AccessControl.FileSystemRights]::WriteData))) { $denied = $true }
    if ($appliesHere -and $rule.AccessControlType -eq 'Allow') {
      if ($rule.IdentityReference.Value -notin @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')) { throw 'state tree ACL grants another principal access' }
      if ($rule.IdentityReference.Value -eq $sid.Value -and ($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::ReadData)) { $readable = $true }
      if ($rule.IdentityReference.Value -eq $sid.Value -and ($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::WriteData)) { $writable = $true }
    }
  }
  if (-not $readable -or -not $writable -or $denied) { throw 'state tree ACL does not grant owner effective read and write access' }
}
`;
  try {
    await windowsPowerShell(script, { VOID_ACL_ROOT: root });
  } catch {
    throw new Error("configured state tree failed the Windows ACL check");
  }
}

async function windowsParentAcl(directory: string): Promise<void> {
  const script = `
$ErrorActionPreference = 'Stop'
$current = [System.IO.DirectoryInfo]::new($env:VOID_ACL_PARENT)
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$trustedOwners = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
$replaceMask = [System.Security.AccessControl.FileSystemRights]::Delete -bor [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor [System.Security.AccessControl.FileSystemRights]::TakeOwnership
while ($null -ne $current) {
  if (($current.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'path contains a reparse point' }
  $acl = [System.IO.Directory]::GetAccessControl($current.FullName)
  if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -notin $trustedOwners) { throw 'parent has an untrusted owner' }
  foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    $appliesHere = ($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0
    if ($appliesHere -and $rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $trustedOwners -and ($rule.FileSystemRights -band $replaceMask)) { throw 'parent ACL allows another principal to replace state' }
  }
  $current = $current.Parent
}
`;
  try {
    await windowsPowerShell(script, { VOID_ACL_PARENT: directory });
  } catch {
    throw new Error("a parent directory ACL permits another principal to replace local state");
  }
}

async function assertSafeAncestorChain(directory: string): Promise<void> {
  if (process.platform === "win32") {
    await windowsParentAcl(resolve(directory));
    return;
  }
  const uid = currentUid();
  const checkCanonical = async (path: string): Promise<void> => {
    const canonical = await realpath(path);
    const canonicalRoot = parse(canonical).root;
    const canonicalParts = canonical.slice(canonicalRoot.length).split(sep).filter(Boolean);
    let current = canonicalRoot;
    const check = async (candidate: string): Promise<void> => {
      const info = await lstat(candidate);
      if (!info.isDirectory())
        throw new Error(`local state ancestor is not a directory: ${candidate}`);
      if (uid !== undefined && info.uid !== 0 && info.uid !== uid)
        throw new Error(`local state ancestor is owned by another user: ${candidate}`);
      const mode = info.mode & 0o7777;
      const stickyRoot = (mode & 0o1000) !== 0 && info.uid === 0;
      if ((mode & 0o022) !== 0 && !stickyRoot)
        throw new Error(`local state ancestor is writable by other users: ${candidate}`);
    };
    await check(current);
    for (const part of canonicalParts) {
      current = join(current, part);
      const info = await lstat(current);
      if (info.isSymbolicLink())
        throw new Error(`local state ancestor is not a real directory: ${current}`);
      await check(current);
    }
  };
  const absolute = resolve(directory);
  const root = parse(absolute).root;
  const parts = absolute.slice(root.length).split(sep).filter(Boolean);
  let lexical = root;
  await checkCanonical(root);
  for (const part of parts) {
    lexical = join(lexical, part);
    const info = await lstat(lexical);
    if (info.isSymbolicLink()) {
      if (uid !== undefined && info.uid !== 0 && info.uid !== uid)
        throw new Error(`local state path link is owned by another user: ${lexical}`);
      // Validate both the link's containing directory and its resolved target.
      await checkCanonical(dirname(lexical));
      await checkCanonical(lexical);
    } else if (info.isDirectory()) {
      await checkCanonical(lexical);
    }
  }
}

async function assertExistingAncestorChain(path: string): Promise<void> {
  let candidate = resolve(path);
  for (;;) {
    try {
      await lstat(candidate);
      await assertSafeAncestorChain(candidate);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

/** Keep the signing-key helper name stable for existing callers. */
export async function windowsKeyAcl(
  file: string,
  protect = false,
): Promise<void> {
  return windowsPathAcl(file, "file", protect);
}

export function sanitizeWorkspace(workspace: string): string {
  if (
    !WORKSPACE_PATTERN.test(workspace) ||
    workspace === "." ||
    workspace === ".."
  ) {
    throw new TypeError(
      "workspace must match [a-z0-9._-]+ and stay within one file name",
    );
  }
  return workspace;
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function assertFileStat(
  info: Awaited<ReturnType<FileHandle["stat"]>>,
  file: string,
  label: string,
): void {
  if (!info.isFile()) throw new Error(`${label} must be a regular file: ${file}`);
  if (info.nlink !== 1)
    throw new Error(`${label} must not have hard links: ${file}`);
  const uid = currentUid();
  if (uid !== undefined && info.uid !== uid)
    throw new Error(`${label} must be owned by the current user: ${file}`);
  if (process.platform !== "win32") {
    const mode = info.mode & 0o7777;
    if (mode !== fileMode) {
      throw new Error(
        `${label} must have permissions 0600, got ${mode.toString(8).padStart(4, "0")}: ${file}`,
      );
    }
  }
}

function assertDirectoryStat(
  info: Awaited<ReturnType<typeof lstat>>,
  directory: string,
  label: string,
): void {
  if (info.isSymbolicLink())
    throw new Error(`${label} must not be a symbolic link: ${directory}`);
  if (!info.isDirectory())
    throw new Error(`${label} must be a directory: ${directory}`);
  const uid = currentUid();
  if (uid !== undefined && info.uid !== uid)
    throw new Error(`${label} must be owned by the current user: ${directory}`);
  if (process.platform !== "win32") {
    const mode = info.mode & 0o7777;
    if (mode !== directoryMode) {
      throw new Error(
        `${label} must have permissions 0700, got ${mode.toString(8).padStart(4, "0")}: ${directory}`,
      );
    }
  }
}

/** Create a storage directory privately or reject an unsafe existing one. */
export async function ensurePrivateDirectory(
  directory: string,
  label = "local state directory",
): Promise<void> {
  await assertExistingAncestorChain(dirname(resolve(directory)));
  let existed = true;
  try {
    await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    existed = false;
  }
  await mkdir(directory, { recursive: true, mode: directoryMode });
  await assertSafeAncestorChain(dirname(resolve(directory)));
  const info = await lstat(directory);
  assertDirectoryStat(info, directory, label);
  if (process.platform === "win32")
    await windowsPathAcl(directory, "directory", !existed);
}

export async function assertPrivateDirectoryPath(
  directory: string,
  label = "local state directory",
): Promise<void> {
  const info = await lstat(directory);
  assertDirectoryStat(info, directory, label);
  await assertSafeAncestorChain(dirname(resolve(directory)));
  if (process.platform === "win32")
    await windowsPathAcl(directory, "directory");
}

export async function assertPrivateFilePath(
  file: string,
  label = "local state file",
): Promise<void> {
  await assertPrivateDirectoryPath(dirname(resolve(file)), `${label} parent directory`);
  const info = await lstat(file);
  if (info.isSymbolicLink())
    throw new Error(`${label} must not be a symbolic link: ${file}`);
  assertFileStat(info, file, label);
  if (process.platform === "win32") await windowsPathAcl(file, "file");
}

export async function assertPrivateFileIfPresent(
  file: string,
  label = "local state file",
): Promise<boolean> {
  try {
    await assertPrivateFilePath(file, label);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function assertPrivateHandle(
  handle: FileHandle,
  file: string,
  label: string,
): Promise<void> {
  assertFileStat(await handle.stat(), file, label);
}

export type PrivateOpenMode = "read" | "append" | "exclusive-write";

/**
 * Open a file without following leaf symlinks on POSIX and validate the
 * opened object, rather than relying only on a prior path lookup. Creation is
 * always exclusive and requests 0600 before any bytes can be written.
 */
export async function openPrivateFile(
  file: string,
  mode: PrivateOpenMode,
  label = "local state file",
): Promise<FileHandle> {
  await assertPrivateDirectoryPath(
    dirname(resolve(file)),
    `${label} parent directory`,
  );
  const noFollow =
    process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
  const nonBlock = constants.O_NONBLOCK ?? 0;
  let handle: FileHandle;
  let created = false;
  if (mode === "exclusive-write") {
    handle = await open(
      file,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      fileMode,
    );
    created = true;
  } else if (mode === "append") {
    try {
      handle = await open(
        file,
        constants.O_WRONLY |
          constants.O_APPEND |
          constants.O_CREAT |
          constants.O_EXCL |
          noFollow |
          nonBlock,
        fileMode,
      );
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      handle = await open(
        file,
        constants.O_WRONLY | constants.O_APPEND | noFollow | nonBlock,
      );
    }
  } else {
    handle = await open(file, constants.O_RDONLY | noFollow | nonBlock);
  }

  try {
    await assertPrivateHandle(handle, file, label);
    if (process.platform === "win32") {
      if (created) await windowsPathAcl(file, "file", true);
      else await windowsPathAcl(file, "file");
      // A path-based Windows ACL update is accepted only if it still names the
      // object that was opened. Writes use this handle after the ACL is set.
      const [opened, current] = [await handle.stat(), await lstat(file)];
      if (current.isSymbolicLink() || opened.dev !== current.dev || opened.ino !== current.ino)
        throw new Error(`${label} changed while its Windows ACL was checked: ${file}`);
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

/** Pre-create SQLite files privately before SQLite opens them by path. */
export async function ensurePrivateFile(
  file: string,
  label = "local state file",
): Promise<void> {
  try {
    const handle = await openPrivateFile(file, "exclusive-write", label);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await assertPrivateFilePath(file, label);
}

/** Tighten sidecars created by SQLite while the containing 0700 directory was private. */
export async function secureGeneratedPrivateSidecar(
  file: string,
  label = "SQLite sidecar",
): Promise<void> {
  await assertPrivateDirectoryPath(dirname(resolve(file)), `${label} parent directory`);
  const noFollow =
    process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
  const nonBlock = constants.O_NONBLOCK ?? 0;
  let handle: FileHandle;
  try {
    handle = await open(file, constants.O_RDONLY | noFollow | nonBlock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile())
      throw new Error(`${label} must be a regular file: ${file}`);
    // SQLite can unlink a journal or WAL immediately after the connection is
    // closed, including between open() and this first fstat(). An unlinked
    // descriptor has no path to secure, so leave it alone and return.
    if (opened.nlink === 0) return;
    if (opened.nlink !== 1)
      throw new Error(`${label} must not have hard links: ${file}`);
    const uid = currentUid();
    if (uid !== undefined && opened.uid !== uid)
      throw new Error(`${label} must be owned by the current user: ${file}`);
    if (process.platform === "win32") {
      try {
        await windowsPathAcl(file, "file", true);
      } catch (error) {
        // Windows ACLs are changed by path, so SQLite may win the race and
        // unlink the sidecar while PowerShell is opening it. Check whether the
        // opened object still has a name before treating that as a failure.
        const after = await handle.stat();
        if (after.nlink === 0) return;
        let current: Awaited<ReturnType<typeof lstat>>;
        try {
          current = await lstat(file);
        } catch (pathError) {
          if ((pathError as NodeJS.ErrnoException).code === "ENOENT") return;
          throw pathError;
        }
        if (
          current.isSymbolicLink() ||
          current.dev !== after.dev ||
          current.ino !== after.ino
        )
          return;
        throw error;
      }
    } else if ((opened.mode & 0o7777) !== fileMode) {
      await handle.chmod(fileMode);
    }
    const secured = await handle.stat();
    if (secured.nlink === 0) return;
    assertFileStat(secured, file, label);
    let current: Awaited<ReturnType<typeof lstat>>;
    try {
      current = await lstat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    // SQLite may remove or replace an unlocked sidecar after this connection
    // closes. Do not turn an already committed operation into a failure; a
    // later open validates any replacement before SQLite can use it.
    if (
      current.isSymbolicLink() ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino
    )
      return;
  } finally {
    await handle.close();
  }
}

export async function readPrivateFile(
  file: string,
  label = "local state file",
  maxBytes = Number.MAX_SAFE_INTEGER,
): Promise<Buffer> {
  const handle = await openPrivateFile(file, "read", label);
  try {
    const metadata = await handle.stat();
    if (metadata.size > maxBytes)
      throw new Error(`${label} exceeds the ${maxBytes} byte read limit: ${file}`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/** Read-only inspection for doctor; no state is repaired or created. */
export async function auditPrivatePath(
  path: string,
  kind: PrivatePathKind,
): Promise<PrivatePathAudit> {
  try {
    if (kind === "directory") {
      await assertPrivateDirectoryPath(path, "local state directory");
    } else {
      await assertPrivateFilePath(path, "local state file");
    }
    return { state: "private" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { state: "missing" };
    return {
      state: "unsafe",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Audit a configured state tree, including vault artifacts and temp files. */
export async function auditPrivateTree(
  root: string,
): Promise<PrivateTreeAudit> {
  let files = 0;
  let directories = 0;
  let rootInfo: Awaited<ReturnType<typeof lstat>>;
  try {
    await assertPrivateDirectoryPath(root, "local state tree root");
    rootInfo = await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { state: "missing", files, directories };
    return {
      state: "unsafe",
      files,
      directories,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (process.platform === "win32") {
    try {
      await windowsPrivateTreeAcl(root);
    } catch (error) {
      return {
        state: "unsafe",
        files,
        directories,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
  const visit = async (
    path: string,
    knownInfo?: Awaited<ReturnType<typeof lstat>>,
  ): Promise<void> => {
    const info = knownInfo ?? (await lstat(path));
    if (info.isSymbolicLink())
      throw new Error(`local state tree contains a symbolic link: ${path}`);
    if (info.isDirectory()) {
      assertDirectoryStat(info, path, "local state directory");
      directories += 1;
      for (const name of await readdir(path)) await visit(join(path, name));
      return;
    }
    assertFileStat(info, path, "local state file");
    files += 1;
  };
  try {
    await visit(root, rootInfo);
    return { state: "private", files, directories };
  } catch (error) {
    return {
      state: "unsafe",
      files,
      directories,
      detail:
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "state tree changed during scan; run doctor while the executor is idle"
          : error instanceof Error
            ? error.message
            : String(error),
    };
  }
}

export async function assertPrivateKeyFileMode(file: string): Promise<void> {
  await assertPrivateFilePath(file, "development key file");
}
