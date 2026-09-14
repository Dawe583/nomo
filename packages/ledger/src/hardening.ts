import { lstat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const runFile = promisify(execFile);

// Use SIDs, not localized account names. Paths are data, never PowerShell code.
export async function windowsKeyAcl(
  file: string,
  protect = false,
): Promise<void> {
  const script = `
$ErrorActionPreference = 'Stop'
$file = $env:VOID_ACL_FILE
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
if ($env:VOID_ACL_PROTECT -eq '1') {
  $acl = New-Object System.Security.AccessControl.FileSecurity
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')
  $acl.AddAccessRule($rule)
  [System.IO.File]::SetAccessControl($file, $acl)
}
$acl = Get-Acl -LiteralPath $file
if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'unexpected key owner' }
$readable = $false
foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq 'Allow') {
    if ($rule.IdentityReference.Value -notin @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')) { throw 'key ACL grants another principal access' }
    if ($rule.IdentityReference.Value -eq $sid.Value -and ($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::ReadData)) { $readable = $true }
  }
}
if (-not $readable) { throw 'key ACL does not grant owner read access' }
`;
  try {
    await runFile(
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
        timeout: 15_000,
        env: {
          ...process.env,
          VOID_ACL_FILE: file,
          VOID_ACL_PROTECT: protect ? "1" : "0",
        },
      },
    );
  } catch {
    throw new Error(
      "development key file must have a private Windows ACL owned by the current user",
    );
  }
}

const WORKSPACE_PATTERN = /^[a-z0-9._-]+$/;

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

export async function assertPrivateKeyFileMode(file: string): Promise<void> {
  const info = await lstat(file);
  if (info.isSymbolicLink()) {
    throw new Error("development key file must not be a symbolic link");
  }
  if (!info.isFile()) {
    throw new Error("development key path must be a regular file");
  }
  if (process.platform === "win32") {
    await windowsKeyAcl(file);
    return;
  }
  const mode = info.mode & 0o777;
  if (mode !== 0o600) {
    throw new Error(
      `development key file must have permissions 0600, got ${mode.toString(8).padStart(4, "0")}`,
    );
  }
}
