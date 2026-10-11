import test, { describe } from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertPrivateKeyFileMode,
  sanitizeWorkspace,
  windowsKeyAcl,
} from "./hardening.ts";
import { devKeyProvider } from "./sign.ts";
import { jsonlStore } from "./store.ts";

describe("sanitizeWorkspace", () => {
  test("allows only one safe file name", () => {
    assert.equal(sanitizeWorkspace("team_1.prod-logs"), "team_1.prod-logs");
    assert.throws(() => sanitizeWorkspace("../prod"), /workspace must match/);
    assert.throws(() => sanitizeWorkspace("Prod"), /workspace must match/);
    assert.throws(() => sanitizeWorkspace(""), /workspace must match/);
    assert.throws(() => sanitizeWorkspace(".."), /workspace must match/);
  });

  test("jsonlStore rejects unsafe workspace names before opening a path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nomo-ledger-hardening-"));
    const key = await devKeyProvider({ dir: join(dir, "keys"), env: {} });
    const store = jsonlStore(key, { dir: join(dir, "ledger") });

    await assert.rejects(
      () =>
        store.append({
          workspace: "../outside",
          at: "now",
          tool: "t",
          klass: "r1",
          decision: "allow",
          argsDigest: "a",
        }),
      /workspace must match/,
    );
  });
});

describe("development key file permissions", () => {
  if (process.platform === "win32")
    test("Windows rejects an explicitly broadened ACL and restores private access", async () => {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const dir = await mkdtemp(join(tmpdir(), "nomo key ' acl-"));
      const file = join(dir, "dev-ed25519.pkcs8");
      await devKeyProvider({ dir, env: {} });
      await promisify(execFile)(
        join(process.env.SystemRoot!, "System32", "icacls.exe"),
        [file, "/grant", "*S-1-1-0:(R)"],
        { windowsHide: true },
      );
      await assert.rejects(
        () => devKeyProvider({ dir, env: {} }),
        /private Windows ACL/,
      );
      await windowsKeyAcl(file, true);
      await assertPrivateKeyFileMode(file);
    });
  test("new development keys are private and reusable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nomo-key-mode-"));

    const first = await devKeyProvider({ dir, env: {} });
    const second = await devKeyProvider({ dir, env: {} });
    assert.equal(await first.currentKeyId(), await second.currentKeyId());
    await assertPrivateKeyFileMode(join(dir, "dev-ed25519.pkcs8"));

    const mode = (await stat(join(dir, "dev-ed25519.pkcs8"))).mode & 0o777;
    if (process.platform !== "win32") assert.equal(mode, 0o600);
  });

  test("existing development keys with broad permissions are rejected", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nomo-key-wide-"));
    const file = join(dir, "dev-ed25519.pkcs8");
    if (process.platform === "win32") {
      await devKeyProvider({ dir, env: {} });
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      await promisify(execFile)(
        join(process.env.SystemRoot!, "System32", "icacls.exe"),
        [file, "/grant", "*S-1-1-0:(R)"],
        { windowsHide: true },
      );
      await assert.rejects(
        () => devKeyProvider({ dir, env: {} }),
        /private Windows ACL/,
      );
      await windowsKeyAcl(file, true);
    } else {
      await writeFile(file, "not a key");
      await chmod(file, 0o644);
      await assert.rejects(
        () => devKeyProvider({ dir, env: {} }),
        /permissions 0600/,
      );
    }
  });

  test("symbolic link key files are rejected before read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nomo-key-link-"));
    const targetDir = await mkdtemp(join(tmpdir(), "nomo-key-target-"));
    const target = join(targetDir, "target.pkcs8");
    await writeFile(target, "not a key");
    // Junctions exercise reparse-point rejection without requiring Windows
    // developer mode or SeCreateSymbolicLinkPrivilege.
    await symlink(
      process.platform === "win32" ? targetDir : target,
      join(dir, "dev-ed25519.pkcs8"),
      process.platform === "win32" ? "junction" : "file",
    );

    await assert.rejects(
      () => assertPrivateKeyFileMode(join(dir, "dev-ed25519.pkcs8")),
      /symbolic link|reparse point|regular file|private Windows ACL/,
    );
    await assert.rejects(
      () => devKeyProvider({ dir, env: {} }),
      /symbolic link|reparse point|regular file|private Windows ACL/,
    );
  });
});
