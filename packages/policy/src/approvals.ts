/**
 * Approval state stays outside HoldQueue so HTTP, Slack and the terminal
 * cannot learn different decision rules. The broker has no timers by design:
 * the proxy or API server pumps expire(), which keeps tests deterministic and
 * makes a stalled event loop fail closed through the original hold timeout.
 *
 * A second constraint shapes every read and write of that state: only the
 * operator may reach the state directory, because a foreign writer can release
 * a held call by dropping one decision file, and a foreign reader learns which
 * calls are pending and their decision tokens. POSIX states that constraint as
 * mode bits and this file keeps asserting it there, unchanged. Windows has no
 * such bits. Measured on this machine, 2026-09-25: Node reports 0o666 for a
 * directory and for a file alike whatever chmod was asked for, stat uid is
 * always 0, and getuid is absent, so the old predicate could never be true and
 * the whole approval path was dead there. Asserting those bits on Windows would
 * be a claim the platform cannot support, so Windows verifies the DACL with the
 * icacls binary that ships with the operating system, and a directory VOID can
 * claim is narrowed to the operator before it is accepted, and only on the
 * write path: a function that inspects a directory changes nothing about it.
 * What cannot be proven is returned as unverifiable and refused unless the host
 * names the finding and accepts it, because an unproven control that reads as a
 * passing one is the defect this replaced.
 */

import * as nodeFs from "node:fs";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import type { Stats } from "node:fs";
import type { HeldCall, HoldId, HoldQueue, HoldResolution, Release } from "./hold.ts";
import type { PolicyCall } from "./decide.ts";
import type { NotifyChannel } from "./rules.ts";

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export type ApprovalDecision = {
  readonly kind: "approved" | "denied";
  readonly by: string;
  readonly reason?: string;
};

export type ApprovalRecord = {
  readonly holdId: HoldId;
  readonly decisionToken?: string;
  readonly call: PolicyCall;
  readonly expiresAt: number;
  readonly status: ApprovalStatus;
  readonly notify: readonly NotifyChannel[];
  readonly by?: string;
  readonly reason?: string;
};

export type ApprovalNotification = {
  readonly holdId: HoldId;
  readonly call: PolicyCall;
  readonly expiresAt: number;
  readonly notify: readonly NotifyChannel[];
  readonly held: HeldCall;
};

export type ApprovalChannel = {
  readonly notify: (approval: ApprovalNotification) => void;
};

export type ApprovalStateEvidence = "posix-mode" | "windows-dacl";

export type ApprovalStateCode =
  | "not-a-directory"
  | "symbolic-link"
  | "group-or-world-access"
  | "foreign-owner"
  | "foreign-write-access"
  | "unrecognised-principal"
  | "foreign-read-access"
  | "operator-unidentifiable"
  | "acl-unreadable";

export type ApprovalStateVerdict =
  | {
      readonly outcome: "owner-only";
      readonly evidence: ApprovalStateEvidence;
      readonly hardened: boolean;
    }
  | {
      readonly outcome: "unverifiable";
      readonly code: ApprovalStateCode;
      readonly hardened: boolean;
      readonly acknowledged: boolean;
    }
  | {
      readonly outcome: "unsafe";
      readonly code: ApprovalStateCode;
      readonly hardened: boolean;
    };

/**
 * One access control entry as the operating system reports it. A principal is
 * the text before the colon, which on the first line still carries the path
 * icacls echoes, so it is matched by suffix rather than by equality.
 */
export type ApprovalAclEntry = {
  readonly principal: string;
  readonly rights: string;
};

/** Returns undefined when the DACL cannot be read. Never throws. */
export type ApprovalAclReader = (
  dir: string,
) => readonly ApprovalAclEntry[] | undefined;

/**
 * Runs icacls to change a DACL, and returns whether the command succeeded.
 * Reached only from the write path, because it rewrites access control on a
 * directory the operator owns.
 */
export type ApprovalAclCommander = (
  dir: string,
  args: readonly string[],
) => boolean;

/**
 * The DACL rule's inputs. `harden` is the whole contract in one word: it is
 * false for every caller that only reads a directory, and true only where VOID
 * is about to write state into the one it is verifying.
 */
export type WindowsApprovalStateInput = {
  readonly stat: Pick<Stats, "dev" | "ino">;
  readonly acl: ApprovalAclReader;
  readonly run: ApprovalAclCommander;
  readonly harden: boolean;
};

export type ApprovalStateOptions = {
  readonly fs?: ApprovalFs;
  readonly acl?: ApprovalAclReader;
  // Only the write path may harden a DACL, and the inspection entry point is
  // not that path. It is accepted here so one options object configures both,
  // and approval-state.test.ts asserts that inspection never calls it.
  readonly run?: ApprovalAclCommander;
};

export type ApprovalBrokerOptions = {
  readonly channels?: Partial<Record<NotifyChannel, ApprovalChannel>>;
  readonly stateDir?: string;
  readonly fs?: ApprovalFs;
  readonly acl?: ApprovalAclReader;
  readonly nonce?: () => string;
  readonly now?: () => number;
  /**
   * The named acknowledgement of an unverifiable control. Absent means refuse,
   * which is the only default: an operator who wants an unproven directory
   * says so, and the verdict the broker records then carries acknowledged.
   */
  readonly acknowledgeUnverifiableState?: (code: ApprovalStateCode) => boolean;
};

type ExpirableQueue = {
  readonly clearTimer: (id: HoldId) => void;
  readonly finish: (id: HoldId, outcome: HoldResolution["outcome"]) => void;
};

export class ApprovalBroker {
  private readonly approvals = new Map<HoldId, ApprovalRecord>();
  private readonly queues = new Map<HoldId, HoldQueue>();
  private readonly channels: Partial<Record<NotifyChannel, ApprovalChannel>>;

  readonly stateDirectory: string | undefined;
  readonly stateDirectoryCheck: ApprovalStateVerdict | undefined;
  readonly fs: ApprovalFs;
  private readonly nonce: () => string;
  private readonly now: () => number;
  private readonly acknowledgeUnverifiableState:
    ((code: ApprovalStateCode) => boolean) | undefined;
  private lockHeld = false;

  constructor(options: ApprovalBrokerOptions = {}) {
    this.channels = options.channels ?? {};
    this.stateDirectory = options.stateDir;
    this.fs = options.fs ?? nodeFs;
    this.nonce = options.nonce ?? randomUUID;
    this.now = options.now ?? Date.now;
    this.acknowledgeUnverifiableState = options.acknowledgeUnverifiableState;
    if (this.stateDirectory !== undefined) {
      const check: ApprovalStateCheck = {
        fs: this.fs,
        acl: options.acl ?? readWindowsAcl,
        run: runIcacls,
        acknowledge: options.acknowledgeUnverifiableState,
      };
      this.stateDirectoryCheck = secureDirectory(this.stateDirectory, check);
      const lockPath = join(this.stateDirectory, "proxy.lock");
      let fd: number;
      try { fd = this.fs.openSync(lockPath, "wx", 0o600); }
      catch (error) {
        if (isObject(error) && error.code === "EEXIST") throw new ApprovalStateInUseError();
        throw error;
      }
      this.lockHeld = true;
      try {
        try {
          this.fs.writeFileSync(fd, String(process.pid));
          this.fs.fsyncSync(fd);
        } finally { this.fs.closeSync(fd); }
        secureDirectory(join(this.stateDirectory, "decisions"), check);
        this.savePending(this.stateDirectory);
      } catch (error) {
        this.close();
        throw error;
      }
    }
  }

  register(queue: HoldQueue, call: PolicyCall): ApprovalRecord {
    const held = this.findUnregisteredHold(queue, call);
    const record: ApprovalRecord = {
      holdId: held.id,
      decisionToken: this.nonce(),
      call,
      expiresAt: held.expiresAt,
      status: "pending",
      notify: notifyChannels(held.notify),
    };
    this.approvals.set(record.holdId, record);
    this.queues.set(record.holdId, queue);
    try {
      this.flush();
      this.emit(record, held);
    } catch (error) {
      queue.resolve(record.holdId, { kind: "denied", by: "approval state failure" });
      throw error;
    }
    return record;
  }

  decide(holdId: HoldId, decision: ApprovalDecision): boolean {
    validateDecision(decision);
    this.expire(this.now());
    const current = this.approvals.get(holdId);
    const queue = this.queues.get(holdId);
    if (current === undefined || queue === undefined || current.status !== "pending") return false;
    const release: Release = decision.kind === "approved"
      ? { kind: "approved" }
      : { kind: "denied", by: decision.by };
    if (this.stateDirectory !== undefined) {
      savePending(this.stateDirectory, this.pending().filter((record) => record.holdId !== holdId), this.fs);
    }
    if (!queue.resolve(holdId, release)) return false;
    this.approvals.set(holdId, {
      ...current,
      status: decision.kind,
      by: decision.by,
      reason: decision.reason,
    });
    this.queues.delete(holdId);
    return true;
  }

  expire(dueAt: number): readonly ApprovalRecord[] {
    const expired: ApprovalRecord[] = [];
    for (const record of this.approvals.values()) {
      if (record.status !== "pending") continue;
      const queue = this.queues.get(record.holdId);
      if (queue === undefined) continue;
      if (record.expiresAt > dueAt && queue.list().some((held) => held.id === record.holdId)) continue;
      this.expireOne(queue, record.holdId);
      const next = { ...record, status: "expired" as const };
      this.approvals.set(record.holdId, next);
      this.queues.delete(record.holdId);
      expired.push(next);
    }
    if (expired.length > 0) this.flush();
    return expired;
  }

  get(holdId: HoldId): ApprovalRecord | undefined {
    const record = this.approvals.get(holdId);
    return record === undefined ? undefined : { ...record };
  }

  list(): readonly ApprovalRecord[] {
    return [...this.approvals.values()].map((record) => ({ ...record }));
  }

  pending(): readonly ApprovalRecord[] {
    return this.list().filter((record) => record.status === "pending");
  }

  listPending(): readonly ApprovalRecord[] {
    return this.pending();
  }

  close(): void {
    if (!this.lockHeld || this.stateDirectory === undefined) return;
    this.fs.unlinkSync(join(this.stateDirectory, "proxy.lock"));
    this.lockHeld = false;
  }

  savePending(dir: string): void {
    savePending(dir, this.pending(), this.fs);
  }

  consumeDecisions(): void {
    const dir = this.stateDirectory;
    if (dir === undefined) return;
    const check: ApprovalStateCheck = {
      fs: this.fs,
      acl: readWindowsAcl,
      run: runIcacls,
      acknowledge: this.acknowledgeUnverifiableState,
    };
    assertPrivateDirectory(dir, check, false);
    assertPrivateDirectory(join(dir, "decisions"), check, false);
    for (const name of this.fs.readdirSync(join(dir, "decisions"))) {
      if (!name.endsWith(".json")) continue;
      const path = join(dir, "decisions", name);
      try {
        assertPrivateFile(path, check);
        const value: unknown = JSON.parse(this.fs.readFileSync(path, "utf8"));
        if (!isObject(value) || typeof value.holdId !== "string" || typeof value.decisionToken !== "string") {
          throw new Error("invalid approval decision file");
        }
        validateDecision(value.decision);
        const record = this.get(value.holdId);
        if (record?.decisionToken === value.decisionToken) this.decide(value.holdId, value.decision);
      } finally {
        this.fs.unlinkSync(path);
      }
    }
  }

  private flush(): void {
    if (this.stateDirectory !== undefined) this.savePending(this.stateDirectory);
  }

  private emit(record: ApprovalRecord, held: HeldCall): void {
    const notification: ApprovalNotification = {
      holdId: record.holdId,
      call: record.call,
      expiresAt: record.expiresAt,
      notify: record.notify,
      held,
    };
    for (const name of record.notify) this.channels[name]?.notify(notification);
  }

  private findUnregisteredHold(queue: HoldQueue, call: PolicyCall): HeldCall {
    const held = queue.list().find((candidate) => !this.approvals.has(candidate.id) && sameCall(candidate, call));
    if (held === undefined) throw new Error(`no pending hold matches ${call.tool}`);
    return held;
  }

  private expireOne(queue: HoldQueue, holdId: HoldId): void {
    const internal = queue as unknown as ExpirableQueue;
    internal.clearTimer(holdId);
    internal.finish(holdId, { kind: "expired" });
  }
}

function notifyChannels(values: readonly string[]): readonly NotifyChannel[] {
  const channels: NotifyChannel[] = [];
  for (const value of values) {
    if (value !== "cli" && value !== "slack") throw new Error(`unknown approval channel ${value}`);
    channels.push(value);
  }
  return channels;
}

function sameCall(held: HeldCall, call: PolicyCall): boolean {
  return held.tool === call.tool && held.klass === call.klass && held.blastRadius === call.blastRadius;
}

/**
 * Local owner-only files avoid a new network listener. One proxy owns a state
 * directory, enforced by an exclusive lock. After a crash an operator must
 * confirm the old process is gone before removing proxy.lock; guessing from a
 * reused PID could admit two writers. Nonces bind decisions to this hold, because queue ids repeat after
 * restart. A crash leaves only complete files or ignored temporary files; it
 * never restores a held call. Payload arguments are not part of ApprovalRecord.
 */
export type ApprovalFs = Pick<typeof nodeFs,
  "mkdirSync" | "openSync" | "writeFileSync" | "fsyncSync" | "closeSync" |
  "renameSync" | "unlinkSync" | "readFileSync" | "readdirSync" | "lstatSync">;

export function savePending(dir: string, records: readonly ApprovalRecord[], fs: ApprovalFs = nodeFs): void {
  atomicWrite(dir, "pending.json", records, stateCheck(fs));
}

export function loadPending(dir: string, fs: ApprovalFs = nodeFs, acknowledge?: (code: ApprovalStateCode) => boolean): readonly ApprovalRecord[] {
  const check = stateCheck(fs, acknowledge);
  assertPrivateDirectory(dir, check, false);
  assertPrivateFile(join(dir, "pending.json"), check);
  const value: unknown = JSON.parse(fs.readFileSync(join(dir, "pending.json"), "utf8"));
  if (!Array.isArray(value) || !value.every((item: unknown) => isObject(item) &&
    typeof item.holdId === "string" && typeof item.decisionToken === "string" &&
    item.status === "pending" && typeof item.expiresAt === "number" && Number.isFinite(item.expiresAt) &&
    isObject(item.call) && typeof item.call.tool === "string" && typeof item.call.klass === "string" &&
    Array.isArray(item.notify))) throw new Error("invalid pending approvals file");
  return value as ApprovalRecord[];
}

export function writeDecision(
  dir: string, holdId: string, decision: ApprovalDecision, fs: ApprovalFs = nodeFs,
  now: () => number = Date.now,
  acknowledge?: (code: ApprovalStateCode) => boolean,
): void {
  validateDecision(decision);
  const check = stateCheck(fs, acknowledge);
  const record = loadPending(dir, fs, acknowledge).find((pending) => pending.holdId === holdId);
  if (record === undefined || record.expiresAt <= now()) throw new Error("hold is not pending or has expired");
  atomicWrite(join(dir, "decisions"), `${randomUUID()}.json`, {
    holdId, decisionToken: record.decisionToken, decision,
  }, check);
}

function stateCheck(fs: ApprovalFs, acknowledge?: (code: ApprovalStateCode) => boolean): ApprovalStateCheck {
  return { fs, acl: readWindowsAcl, run: runIcacls, acknowledge };
}

function atomicWrite(dir: string, name: string, value: unknown, check: ApprovalStateCheck): void {
  secureDirectory(dir, check);
  const fs = check.fs;
  const temporary = join(dir, `.${randomUUID()}.tmp`);
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    try {
      fs.writeFileSync(fd, JSON.stringify(value));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, join(dir, name));
    // Node cannot flush a Windows directory, and Windows does not expose the
    // handle it would need. The file contents were flushed above and the rename
    // is journalled, so the entry is durable there. Same guard as
    // workbench/src/storage.ts, which hit the identical EPERM.
    if (process.platform !== "win32") {
      const directory = fs.openSync(dir, "r");
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    }
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* Rename may already have committed. */ }
    throw error;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateDecision(value: unknown): asserts value is ApprovalDecision {
  if (!isObject(value) || (value.kind !== "approved" && value.kind !== "denied") ||
    typeof value.by !== "string" || value.by.trim() === "" ||
    (value.reason !== undefined && typeof value.reason !== "string") ||
    Object.keys(value).some((key) => !["kind", "by", "reason"].includes(key))) {
    throw new Error("invalid approval decision");
  }
}

function secureDirectory(dir: string, check: ApprovalStateCheck): ApprovalStateVerdict {
  try {
    check.fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    // Recursive mkdir reports an existing non-directory as EEXIST, and that
    // happens before anything can classify it. Left alone it reaches the
    // caller as a bare errno whose message carries the full filesystem path,
    // which is the one thing this file refuses to put in a refusal, and it
    // makes the not-a-directory verdict unreachable. Swallowing only EEXIST
    // lets the classification below name the real reason; any other errno is
    // still a genuine failure to create the directory and propagates.
    if (!isObject(error) || error.code !== "EEXIST") throw error;
  }
  // About to create state in this directory, so this is the one place that
  // may harden the DACL rather than only report on it.
  return assertPrivateDirectory(dir, check, true);
}

function assertPrivateDirectory(
  dir: string,
  check: ApprovalStateCheck,
  harden: boolean,
): ApprovalStateVerdict {
  const verdict = approvalStateVerdict(dir, check, harden);
  if (verdict.outcome === "owner-only") return verdict;
  const acknowledged =
    verdict.outcome === "unverifiable" &&
    check.acknowledge !== undefined &&
    check.acknowledge(verdict.code) === true;
  if (verdict.outcome === "unverifiable" && acknowledged) {
    return { ...verdict, acknowledged: true };
  }
  throw new ApprovalStateUnsafeError(verdict);
}

/**
 * The single entry point a host can call to learn what VOID could prove about a
 * state directory, without creating a broker and without a decision to make.
 * It reads and changes nothing: no directory is created, and on Windows no DACL
 * is narrowed. A host that asks what VOID could prove gets the verdict that was
 * measured, and a directory that is not owner only is still reported as not
 * owner only. Only the write path may harden a directory, because only the
 * write path has a reason to.
 */
export function inspectApprovalStateDirectory(
  dir: string,
  options: ApprovalStateOptions = {},
): ApprovalStateVerdict {
  return approvalStateVerdict(
    dir,
    {
      fs: options.fs ?? nodeFs,
      acl: options.acl ?? readWindowsAcl,
      run: options.run ?? runIcacls,
      acknowledge: undefined,
    },
    false,
  );
}

/**
 * The POSIX rule, split out as a pure function of the stat so a reviewer on any
 * platform can run it. It is the control the other platforms are measured
 * against, so it must stay testable where the mode bits mean nothing.
 */
export function classifyPosixApprovalState(
  stat: Pick<
    Stats,
    "isDirectory" | "isFile" | "isSymbolicLink" | "mode" | "uid"
  >,
  effectiveUid: number | undefined,
): ApprovalStateVerdict {
  if (stat.isSymbolicLink())
    return { outcome: "unsafe", code: "symbolic-link", hardened: false };
  if (!stat.isDirectory())
    return { outcome: "unsafe", code: "not-a-directory", hardened: false };
  if ((stat.mode & 0o077) !== 0)
    return {
      outcome: "unsafe",
      code: "group-or-world-access",
      hardened: false,
    };
  if (effectiveUid !== undefined && stat.uid !== effectiveUid)
    return { outcome: "unsafe", code: "foreign-owner", hardened: false };
  return { outcome: "owner-only", evidence: "posix-mode", hardened: false };
}

type ApprovalStateCheck = {
  readonly fs: ApprovalFs;
  readonly acl: ApprovalAclReader;
  readonly run: ApprovalAclCommander;
  readonly acknowledge: ((code: ApprovalStateCode) => boolean) | undefined;
};

function approvalStateVerdict(
  dir: string,
  check: ApprovalStateCheck,
  harden: boolean,
): ApprovalStateVerdict {
  const stat = check.fs.lstatSync(dir);
  // The link check runs on both platforms and before any platform rule: a
  // symlink or junction redirects the check at a directory the operator never
  // named, and on Windows hardening it would rewrite that target's DACL.
  if (stat.isSymbolicLink())
    return { outcome: "unsafe", code: "symbolic-link", hardened: false };
  if (process.platform !== "win32")
    return classifyPosixApprovalState(stat, process.getuid?.());
  if (!stat.isDirectory())
    return { outcome: "unsafe", code: "not-a-directory", hardened: false };
  return verifyWindowsApprovalState(dir, {
    stat,
    acl: check.acl,
    run: check.run,
    harden,
  });
}

// A verified DACL is remembered per process and per reader, because reading it
// costs a process spawn and every state write would otherwise pay it. A
// directory that is owner only can afterwards be changed only by the operator,
// so the memo cannot be stale in the direction that matters, and the identity is
// the file index, so a path deleted and recreated under the same name is read
// again. Per reader, so an injected reader is never served a verdict it did not
// produce.
const verifiedDacl = new WeakMap<
  ApprovalAclReader,
  Map<string, ApprovalStateVerdict>
>();
const MAX_MEMOIZED_DIRECTORIES = 32;

/**
 * The DACL rule, split out from the platform branch so a reviewer on any
 * machine can run the one decision that rewrites an operator's access control,
 * exactly as classifyPosixApprovalState is split out for the mode bits.
 *
 * `harden` is the contract. A caller that only reads passes false and gets the
 * verdict it measured, with icacls never run and the DACL never touched. Only
 * the write path passes true.
 */
export function verifyWindowsApprovalState(
  dir: string,
  input: WindowsApprovalStateInput,
): ApprovalStateVerdict {
  const memo = daclMemo(input.acl);
  const key = `${input.stat.dev}:${input.stat.ino}`;
  const cached = memo.get(key);
  if (cached !== undefined) return cached;
  const entries = input.acl(dir);
  if (entries === undefined) return unverifiable("acl-unreadable", false);
  const first = classifyWindowsAcl(entries, operatorPrincipals());
  if (first.outcome === "owner-only") return remember(memo, key, first);
  if (!input.harden) return first;
  // mkdirSync above already promises mode 0o700, which Windows cannot honour.
  // Narrowing the DACL is that same promise in the unit Windows does enforce,
  // so the write path applies it rather than refusing a directory it cannot
  // leave as it found it. A directory it cannot narrow keeps the verdict that
  // was measured, not the one that would have been convenient.
  if (!narrowWindowsAcl(dir, entries, input.run)) return first;
  const narrowed = input.acl(dir);
  const second =
    narrowed === undefined
      ? unverifiable("acl-unreadable", true)
      : {
          ...classifyWindowsAcl(narrowed, operatorPrincipals()),
          hardened: true,
        };
  if (second.outcome !== "owner-only") return second;
  return remember(memo, key, second);
}

function daclMemo(
  reader: ApprovalAclReader,
): Map<string, ApprovalStateVerdict> {
  const existing = verifiedDacl.get(reader);
  if (existing !== undefined) return existing;
  const created = new Map<string, ApprovalStateVerdict>();
  verifiedDacl.set(reader, created);
  return created;
}

function remember(
  memo: Map<string, ApprovalStateVerdict>,
  key: string,
  verdict: ApprovalStateVerdict,
): ApprovalStateVerdict {
  if (memo.size >= MAX_MEMOIZED_DIRECTORIES) {
    const oldest = memo.keys().next();
    if (oldest.done !== true) memo.delete(oldest.value);
  }
  memo.set(key, verdict);
  return verdict;
}

function unverifiable(
  code: ApprovalStateCode,
  hardened: boolean,
): ApprovalStateVerdict {
  return { outcome: "unverifiable", code, hardened, acknowledged: false };
}

function operatorPrincipals(): readonly string[] {
  const user = process.env.USERNAME?.trim();
  if (user === undefined || user === "") return [];
  const domain = process.env.USERDOMAIN?.trim();
  return domain === undefined || domain === ""
    ? [user]
    : [`${domain}\\${user}`, user];
}

function classifyWindowsAcl(
  entries: readonly ApprovalAclEntry[],
  operator: readonly string[],
): ApprovalStateVerdict {
  let unrecognised: ApprovalStateVerdict | undefined;
  let foreignRead: ApprovalStateVerdict | undefined;
  for (const entry of entries) {
    const principal = entry.principal.trim();
    if (matchesAny(principal, TRUSTED_ACLS, operator)) continue;
    const write = writesAccess(entry.rights);
    if (principal.toUpperCase().startsWith("MANDATORY LABEL")) {
      // An integrity label that grants write means a low integrity process can
      // write approval state, which is a proven foreign writer. One that grants
      // nothing grants no access to the contents either, so it says nothing.
      if (write)
        return {
          outcome: "unsafe",
          code: "foreign-write-access",
          hardened: false,
        };
      continue;
    }
    if (matchesAny(principal, SHARED_ACLS, [])) {
      // Everyone and the local group are demonstrably somebody else, so a write
      // grant here is a proven path to releasing a held call and is never
      // acknowledgeable. A read grant only discloses which calls are pending.
      if (write)
        return {
          outcome: "unsafe",
          code: "foreign-write-access",
          hardened: false,
        };
      foreignRead ??= unverifiable("foreign-read-access", false);
      continue;
    }
    // A principal that is neither the operator nor a shared group may be the
    // operator under a name this process cannot resolve, so it is reported as
    // unproven rather than proven hostile in either direction.
    unrecognised ??= unverifiable(
      operator.length === 0
        ? "operator-unidentifiable"
        : "unrecognised-principal",
      false,
    );
  }
  return (
    unrecognised ??
    foreignRead ?? {
      outcome: "owner-only",
      evidence: "windows-dacl",
      hardened: false,
    }
  );
}

const TRUSTED_ACLS = [
  "nt authority\\system",
  "system",
  "s-1-5-18",
  "builtin\\administrators",
  "administrators",
  "s-1-5-32-544",
];

const SHARED_ACLS = [
  "everyone",
  "s-1-1-0",
  "authenticated users",
  "s-1-5-11",
  "builtin\\users",
  "users",
  "s-1-5-32-545",
  "guests",
  "s-1-5-32-546",
  "nt authority\\anonymous logon",
  "anonymous logon",
  "s-1-5-7",
];

const INHERITANCE_FLAGS: Record<string, true> = {
  I: true,
  IO: true,
  OI: true,
  CI: true,
  ID: true,
  NP: true,
  IOI: true,
};

// An allowlist, because a permission letter this file does not understand must
// not be read as harmless. Rights icacls abbreviates as anything else, F M W D
// S WO WDAC, are treated as write access.
const READ_ONLY_RIGHTS: Record<string, true> = {
  N: true,
  R: true,
  RX: true,
  X: true,
  GR: true,
  GX: true,
  GRGE: true,
  GRCX: true,
  RC: true,
  RCD: true,
  RCX: true,
  RDC: true,
  RA: true,
};

function writesAccess(rights: string): boolean {
  for (const letter of rights.split(/[,\s]+/)) {
    const token = letter.trim().toUpperCase();
    if (token === "" || INHERITANCE_FLAGS[token] === true) continue;
    if (READ_ONLY_RIGHTS[token] !== true) return true;
  }
  return false;
}

function matchesAny(
  principal: string,
  names: readonly string[],
  extra: readonly string[],
): boolean {
  const lower = principal.toLowerCase();
  for (const name of [...names, ...extra]) {
    const wanted = name.toLowerCase();
    if (lower === wanted || lower.endsWith(` ${wanted}`)) return true;
  }
  return false;
}

const ACL_TIMEOUT_MS = 5000;
const MAX_REMOVED_ACES = 16;

function narrowWindowsAcl(
  dir: string,
  entries: readonly ApprovalAclEntry[],
  run: ApprovalAclCommander,
): boolean {
  const operator = operatorPrincipals()[0];
  if (operator === undefined) return false;
  if (
    !run(dir, [
      "/inheritance:r",
      "/grant:r",
      `${operator}:(OI)(CI)F`,
      "*S-1-5-18:(OI)(CI)F",
      "*S-1-5-32-544:(OI)(CI)F",
    ])
  )
    return false;
  // Best effort only. /inheritance:r drops inherited entries, which is most of
  // what a shared parent contributes, and the re-read judges the result, so a
  // removal that finds nothing left to remove must not decide the verdict.
  const foreign = entries
    .map((entry) => aclToken(entry.principal))
    .filter(
      (token) =>
        token !== "" && !matchesAny(token, TRUSTED_ACLS, operatorPrincipals()),
    )
    .slice(0, MAX_REMOVED_ACES);
  for (const token of foreign) run(dir, ["/remove:g", token]);
  return true;
}

function aclToken(principal: string): string {
  const trimmed = principal.trim();
  const space = trimmed.lastIndexOf(" ");
  const token = space === -1 ? trimmed : trimmed.slice(space + 1);
  return token.toUpperCase().startsWith("S-1-") ? `*${token}` : token;
}

const runIcacls: ApprovalAclCommander = (dir, args) => {
  try {
    execFileSync("icacls", [dir, ...args], {
      encoding: "utf8",
      timeout: ACL_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 256 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

const ACL_ENTRY = /^(.*?):((?:\([A-Z0-9,]*\))+)\s*$/i;

/**
 * Reads the DACL of one directory. Only lines shaped like an access control
 * entry are parsed, because icacls reports failure in the console language of
 * the machine, which is not UTF-8 and must never be matched on. A missing
 * binary, a timeout, a non-zero exit and an unparseable listing are all one
 * answer: the DACL could not be read here.
 */
const readWindowsAcl: ApprovalAclReader = (dir) => {
  let output: string;
  try {
    output = execFileSync("icacls", [dir], {
      encoding: "utf8",
      timeout: ACL_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 256 * 1024,
    });
  } catch {
    return undefined;
  }
  const entries: ApprovalAclEntry[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = ACL_ENTRY.exec(line.trim());
    if (match === null) continue;
    const rights = (match[2] ?? "").match(/\(([^)]*)\)/g) ?? [];
    entries.push({
      principal: match[1] ?? "",
      rights: rights.map((group) => group.slice(1, -1)).join(","),
    });
  }
  return entries.length === 0 ? undefined : entries;
};

function assertPrivateFile(path: string, check: ApprovalStateCheck): void {
  // lstat is what rejects a symlinked pending.json on both platforms, because a
  // link fails isFile. The DACL of a file inside a directory that was just
  // verified owner only cannot be widened by anyone else, so the parent verdict
  // is the evidence there; re-reading it per file would put a process spawn in
  // front of every pending read for a fact the parent already establishes.
  const fs = check.fs;
  const stat = fs.lstatSync(path);
  if (!stat.isFile() || stat.size > 1024 * 1024) {
    throw new Error("approval state requires a bounded owner-only regular file");
  }
  // Windows has no POSIX mode bits to test here, exactly as for the directory:
  // the containing DACL was just verified by assertPrivateDirectory, and the
  // owner-only guarantee rests on that rather than on bits the platform has
  // none of.
  if (process.platform === "win32") return;
  if ((stat.mode & 0o077) !== 0 ||
    (process.getuid !== undefined && stat.uid !== process.getuid())) {
    throw new Error("approval state requires a bounded owner-only regular file");
  }
}

export class ApprovalStateInUseError extends Error {
  readonly code = "APPROVAL_STATE_IN_USE";
  constructor() {
    super("approval state directory is locked; stop its proxy, or confirm it has exited before removing proxy.lock");
    this.name = "ApprovalStateInUseError";
  }
}

export class ApprovalStateUnsafeError extends Error {
  readonly code: ApprovalStateCode;
  readonly verdict: Exclude<ApprovalStateVerdict, { outcome: "owner-only" }>;
  constructor(
    verdict: Exclude<ApprovalStateVerdict, { outcome: "owner-only" }>,
  ) {
    // The reason is a fixed code, never a path, an account name or anything
    // icacls printed, because this message can reach an agent.
    super(
      verdict.outcome === "unsafe"
        ? `approval state requires an owner-only directory without symlinks, and this state directory is not: ${verdict.code}`
        : `approval state requires an owner-only directory without symlinks, which could not be verified here: ${verdict.code}`,
    );
    this.name = "ApprovalStateUnsafeError";
    this.code = verdict.code;
    this.verdict = verdict;
  }
}
