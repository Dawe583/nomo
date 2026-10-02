/**
 * The state directory control, per platform. These tests exist because the old
 * predicate could not be satisfied on Windows: Node reports 0o666 for a
 * directory whatever chmod was asked for, so a mode assertion was a claim the
 * platform cannot support and the approval path was dead there. The POSIX rule
 * is tested through its own pure classifier so it stays reviewable from any
 * platform, and the Windows rule is tested against a real directory and a real
 * DACL rather than a mock of the decision.
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import {
  ApprovalBroker,
  ApprovalStateUnsafeError,
  classifyPosixApprovalState,
  inspectApprovalStateDirectory,
  loadPending,
} from "./approvals.ts";
import type {
  ApprovalAclEntry,
  ApprovalAclReader,
  ApprovalStateCode,
  ApprovalStateVerdict,
} from "./approvals.ts";

const windows = process.platform === "win32";
const skipPosix = windows
  ? "POSIX mode bits carry no meaning on this platform"
  : false;
const skipWindows = windows ? false : "the DACL control exists only on Windows";

describe("approval state directory, POSIX rule", () => {
  test("a group or world permission is refused by name, not by a generic throw", () => {
    const verdict = classifyPosixApprovalState(
      { ...stat({ isDirectory: () => true }), mode: 0o40755 },
      1000,
    );

    assert.equal(verdict.outcome, "unsafe");
    assert.equal(code(verdict), "group-or-world-access");
    assert.equal(verdict.outcome === "unsafe" && verdict.hardened, false);
  });

  test("owner only, owner uid, no link is accepted", () => {
    const verdict = classifyPosixApprovalState(
      { ...stat({ isDirectory: () => true }), mode: 0o40700, uid: 1000 },
      1000,
    );

    assert.deepEqual(verdict, {
      outcome: "owner-only",
      evidence: "posix-mode",
      hardened: false,
    });
  });

  test("a symlink, a foreign uid and a non directory are each refused by name", () => {
    const linked = classifyPosixApprovalState(
      {
        ...stat({
          isSymbolicLink: () => true,
          isDirectory: () => false,
          isFile: () => false,
        }),
      },
      1000,
    );
    const foreign = classifyPosixApprovalState(
      { ...stat({ isDirectory: () => true }), mode: 0o40700, uid: 0 },
      1000,
    );
    const file = classifyPosixApprovalState(
      { ...stat({ mode: 0o100600 }) },
      1000,
    );

    assert.equal(code(linked), "symbolic-link");
    assert.equal(code(foreign), "foreign-owner");
    assert.equal(code(file), "not-a-directory");
  });

  test(
    "a state directory that is a regular file is refused on a platform that has mode bits",
    { skip: skipPosix },
    (t) => {
      const base = temporary(t, "file-as-dir");
      const file = join(base, "state");
      fs.writeFileSync(file, "[]", { mode: 0o600 });

      assert.throws(
        () => new ApprovalBroker({ stateDir: file }),
        (error: unknown) => {
          assert.ok(error instanceof ApprovalStateUnsafeError);
          assert.equal(error.code, "not-a-directory");
          return true;
        },
      );
    },
  );

  test(
    "a real 0o755 directory is refused on a platform that has mode bits",
    { skip: skipPosix },
    (t) => {
      const dir = temporary(t, "posix");
      fs.chmodSync(dir, 0o755);

      assert.throws(
        () => new ApprovalBroker({ stateDir: dir }),
        (error: unknown) => {
          assert.ok(error instanceof ApprovalStateUnsafeError);
          assert.equal(error.code, "group-or-world-access");
          assert.match(error.message, /owner-only/);
          return true;
        },
      );
    },
  );

  test(
    "a real 0o700 directory is accepted on a platform that has mode bits",
    { skip: skipPosix },
    (t) => {
      const dir = temporary(t, "posix-ok");
      fs.chmodSync(dir, 0o700);
      const broker = new ApprovalBroker({ stateDir: dir });

      try {
        assert.deepEqual(broker.stateDirectoryCheck, {
          outcome: "owner-only",
          evidence: "posix-mode",
          hardened: false,
        });
      } finally {
        broker.close();
      }
    },
  );
});

describe("approval state directory, refused on every platform", () => {
  test("a symlinked state directory is refused before any platform rule runs", (t) => {
    const base = temporary(t, "link");
    const target = join(base, "target");
    const link = join(base, "linked");
    fs.mkdirSync(target, { mode: 0o700 });
    fs.symlinkSync(target, link);

    assert.throws(
      () => new ApprovalBroker({ stateDir: link }),
      (error: unknown) => {
        assert.ok(error instanceof ApprovalStateUnsafeError);
        assert.equal(error.code, "symbolic-link");
        return true;
      },
    );
  });

  test(
    "a proven unsafe state directory is refused even when the host offers to accept anything",
    { skip: skipPosix },
    (t) => {
      const dir = temporary(t, "unsafe");
      fs.chmodSync(dir, 0o755);
      let offered = false;

      assert.throws(
        () =>
          new ApprovalBroker({
            stateDir: dir,
            acknowledgeUnverifiableState: () => {
              offered = true;
              return true;
            },
          }),
        (error: unknown) => {
          assert.ok(error instanceof ApprovalStateUnsafeError);
          assert.equal(error.code, "group-or-world-access");
          return true;
        },
      );
      assert.equal(offered, false, "unsafe is never acknowledgeable");
    },
  );

  test("the refusal names a code and never the path, the account or the DACL", (t) => {
    const base = temporary(t, "leak");
    const target = join(base, "target");
    const link = join(base, "linked");
    fs.mkdirSync(target);
    fs.symlinkSync(target, link);

    try {
      new ApprovalBroker({ stateDir: link });
      assert.fail("expected a refusal");
    } catch (error) {
      assert.ok(error instanceof ApprovalStateUnsafeError);
      const message = error.message;
      assert.match(message, /owner-only/);
      assert.match(message, /symbolic-link/);
      assert.equal(message.includes(base), false, "no path");
      assert.equal(
        message.includes(os.userInfo().username),
        false,
        "no account name",
      );
      assert.equal(
        message.includes(process.env.USERDOMAIN ?? "\u0000"),
        false,
        "no host detail",
      );
    }
  });
});

describe("approval state directory, Windows DACL rule", () => {
  test(
    "a real DACL that is not owner only is narrowed to the operator, then accepted",
    { skip: skipWindows },
    (t) => {
      const dir = temporary(t, "foreign-writer-real");
      // Constructed for real, without elevation: the owner of a directory may
      // always add an access control entry to it.
      icacls(dir, ["/grant", "*S-1-1-0:(M)"]);
      assert.match(icacls(dir), /Everyone/);

      const verdict = inspectApprovalStateDirectory(dir);

      assert.equal(verdict.outcome, "owner-only");
      assert.equal(
        verdict.outcome === "owner-only" && verdict.evidence,
        "windows-dacl",
      );
      assert.equal(verdict.outcome === "owner-only" && verdict.hardened, true);
      assert.equal(
        /Everyone/.test(icacls(dir)),
        false,
        "the foreign writer is gone from the real DACL",
      );
    },
  );

  test(
    "a real state directory is accepted and its pending state is readable",
    { skip: skipWindows },
    (t) => {
      const dir = temporary(t, "round-trip");
      const broker = new ApprovalBroker({ stateDir: dir });

      try {
        assert.equal(broker.stateDirectoryCheck?.outcome, "owner-only");
        assert.deepEqual(loadPending(dir), []);
      } finally {
        broker.close();
      }
    },
  );

  test(
    "a foreign writer that VOID cannot narrow is refused, never acknowledged",
    { skip: skipWindows },
    (t) => {
      const dir = temporary(t, "foreign-writer");
      // A reader that keeps reporting the same DACL is a directory VOID cannot
      // narrow, which is the only way a not owner only ACL survives.
      const refusing: ApprovalAclReader = () => [
        { principal: "Everyone", rights: "M" },
      ];
      let offered = false;

      assert.throws(
        () =>
          new ApprovalBroker({
            stateDir: dir,
            acl: refusing,
            acknowledgeUnverifiableState: () => {
              offered = true;
              return true;
            },
          }),
        (error: unknown) => {
          assert.ok(error instanceof ApprovalStateUnsafeError);
          assert.equal(error.code, "foreign-write-access");
          assert.equal(error.verdict.outcome, "unsafe");
          return true;
        },
      );
      assert.equal(
        offered,
        false,
        "a proven foreign writer is never acknowledgeable",
      );
    },
  );

  test(
    "a foreign read grant is unverifiable, not proven owner only",
    { skip: skipWindows },
    (t) => {
      const dir = temporary(t, "foreign-read");

      const verdict = inspectApprovalStateDirectory(dir, {
        acl: () => [{ principal: "Everyone", rights: "RX" }],
      });

      assert.equal(verdict.outcome, "unverifiable");
      assert.equal(code(verdict), "foreign-read-access");
    },
  );

  test(
    "a principal this process cannot resolve is unverifiable rather than proven hostile",
    { skip: skipWindows },
    (t) => {
      const dir = temporary(t, "unknown-principal");

      const verdict = inspectApprovalStateDirectory(dir, {
        acl: () => [{ principal: "S-1-5-21-1-2-3-1007", rights: "F" }],
      });

      assert.equal(verdict.outcome, "unverifiable");
      assert.equal(code(verdict), "unrecognised-principal");
    },
  );

  test(
    "a low integrity label that grants write is a proven foreign writer",
    { skip: skipWindows },
    (t) => {
      const dir = temporary(t, "integrity-label");

      const verdict = inspectApprovalStateDirectory(dir, {
        acl: () => [
          { principal: "Mandatory Label\\Low Mandatory Level", rights: "M" },
        ],
      });

      assert.equal(verdict.outcome, "unsafe");
      assert.equal(code(verdict), "foreign-write-access");
    },
  );

  test(
    "an unreadable DACL is unverifiable, and only a named acknowledgement proceeds",
    { skip: skipWindows },
    (t) => {
      const dir = temporary(t, "unreadable");
      const offered: ApprovalStateCode[] = [];
      const unreadable: ApprovalAclReader = () => undefined;

      assert.throws(
        () => new ApprovalBroker({ stateDir: dir, acl: unreadable }),
        (error: unknown) => {
          assert.ok(error instanceof ApprovalStateUnsafeError);
          assert.equal(error.code, "acl-unreadable");
          assert.equal(error.verdict.outcome, "unverifiable");
          return true;
        },
      );

      const broker = new ApprovalBroker({
        stateDir: dir,
        acl: unreadable,
        acknowledgeUnverifiableState: (finding) => {
          offered.push(finding);
          return true;
        },
      });
      try {
        // The caller has to be able to see that the control did not pass.
        assert.deepEqual(broker.stateDirectoryCheck, {
          outcome: "unverifiable",
          code: "acl-unreadable",
          hardened: false,
          acknowledged: true,
        });
        assert.equal(offered.length >= 1, true);
        assert.deepEqual([...new Set(offered)], ["acl-unreadable"]);
      } finally {
        broker.close();
      }
    },
  );

  test(
    "a verified DACL is read once per directory, so a state write does not spawn a process",
    { skip: skipWindows },
    (t) => {
      const dir = temporary(t, "memo");

      const first = inspectApprovalStateDirectory(dir);
      const second = inspectApprovalStateDirectory(dir);

      assert.equal(first.outcome, "owner-only");
      // The same verdict object, not an equal one: that identity is the cache.
      assert.equal(first, second);
    },
  );

  test(
    "one reader is never served another reader's verdict",
    { skip: skipWindows },
    (t) => {
      const dir = temporary(t, "per-reader");
      const trusted = trustedEntries();
      let calls = 0;
      const counting: ApprovalAclReader = () => {
        calls += 1;
        return trusted;
      };

      assert.equal(
        inspectApprovalStateDirectory(dir, { acl: counting }).outcome,
        "owner-only",
      );
      assert.equal(
        inspectApprovalStateDirectory(dir, { acl: counting }).outcome,
        "owner-only",
      );
      assert.equal(calls, 1, "the same reader is memoised per directory");

      const other = inspectApprovalStateDirectory(dir, {
        acl: () => [{ principal: "Everyone", rights: "M" }],
      });
      assert.equal(
        other.outcome,
        "unsafe",
        "a second reader is asked, not served",
      );
    },
  );

  test(
    "the operator, SYSTEM and Administrators are trusted, in name and in SID form",
    { skip: skipWindows },
    (t) => {
      const dir = temporary(t, "trusted");
      const entries: readonly ApprovalAclEntry[] = [
        ...trustedEntries(),
        { principal: "S-1-5-18", rights: "F" },
        { principal: "S-1-5-32-544", rights: "F" },
      ];

      assert.equal(
        inspectApprovalStateDirectory(dir, { acl: () => entries }).outcome,
        "owner-only",
      );
    },
  );

  test(
    "an unrecognised rights letter is treated as write access, never as harmless",
    { skip: skipWindows },
    (t) => {
      const dir = temporary(t, "unknown-rights");
      const write = ["ZZ", "W", "M", "F", "D", "WO", "WDAC", "S", "GA"];
      const read = ["RX", "R", "GR", "N", "OI,CI,RX", "I,OI,CI,GRCX"];

      for (const rights of write) {
        assert.equal(
          verdictFor(dir, "Everyone", rights),
          "unsafe",
          `${rights} must not read as harmless`,
        );
      }
      for (const rights of read) {
        assert.equal(
          verdictFor(dir, "Everyone", rights),
          "unverifiable",
          `${rights} is a read grant, which is unverifiable, not owner only`,
        );
      }
    },
  );
});

describe("approval state file", () => {
  test("a symlinked pending file is refused even in a verified directory", (t) => {
    const dir = temporary(t, "file-link");
    const broker = new ApprovalBroker({ stateDir: dir });
    const real = join(dir, "real.json");
    fs.writeFileSync(real, "[]");
    fs.rmSync(join(dir, "pending.json"));
    try {
      fs.symlinkSync(real, join(dir, "pending.json"), "file");
      assert.throws(() => loadPending(dir), /bounded owner-only regular file/);
    } finally {
      broker.close();
    }
  });
});

function verdictFor(
  dir: string,
  principal: string,
  rights: string,
): ApprovalStateVerdict["outcome"] {
  return inspectApprovalStateDirectory(dir, {
    acl: () => [{ principal, rights }],
  }).outcome;
}

function trustedEntries(): readonly ApprovalAclEntry[] {
  const user = process.env.USERNAME ?? "operator";
  const domain = process.env.USERDOMAIN;
  return [
    { principal: `${domain ?? "HOST"}\\${user}`, rights: "I,OI,CI,F" },
    { principal: "NT AUTHORITY\\SYSTEM", rights: "I,OI,CI,F" },
    { principal: "BUILTIN\\Administrators", rights: "I,OI,CI,F" },
  ];
}

function code(verdict: ApprovalStateVerdict): ApprovalStateCode | undefined {
  return verdict.outcome === "owner-only" ? undefined : verdict.code;
}

function icacls(target: string, args: readonly string[] = []): string {
  return execFileSync("icacls", [target, ...args], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });
}

function temporary(
  t: { after: (fn: () => void) => void },
  name: string,
): string {
  const dir = fs.mkdtempSync(join(os.tmpdir(), `void-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function stat(overrides: Partial<fs.Stats> = {}): fs.Stats {
  return {
    isDirectory: () => false,
    isFile: () => true,
    isSymbolicLink: () => false,
    mode: 0o100600,
    uid: 1000,
    size: 0,
    ...overrides,
  } as unknown as fs.Stats;
}