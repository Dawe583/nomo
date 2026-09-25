/**
 * R06: the lease a recovery job holds while a worker is applying it.
 *
 * The workspace already refuses a second recovery job while one is in flight,
 * and that refusal is inside the journal writer transaction, so two workers
 * cannot interleave. What it cannot survive is the worker dying: the job stays
 * mid-`applying` and the workspace is blocked until someone edits a journal by
 * hand.
 *
 * A lease is only as good as its reclaim rule. "Expired" alone would displace a
 * worker that is merely slow, so reclaim requires both: the deadline passed
 * AND the holder is provably gone. Either check being uncertain keeps the
 * refusal, so the failure mode stays "no recovery" rather than "two recoveries".
 *
 * The holder carries its own process id and the test supplies liveness, so the
 * rule is decided here and can be proven without arranging for a real crash.
 */

export type RecoveryJobLease = {
  /** `<hostLabel>:<pid>`. The label is operator-facing; the pid is authority. */
  readonly holder: string;
  readonly expiresAt: number;
};

export type LeaseVerdict =
  | { readonly reclaimable: false; readonly reason: string }
  | { readonly reclaimable: true; readonly holder: string };

/** A holder string is only usable if its pid is parseable, so an unparseable
 * holder is never treated as gone. */
export function holderPid(holder: string): number | null {
  const pid = Number.parseInt(holder.slice(holder.lastIndexOf(":") + 1), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * `isAlive` is supplied by the caller so the rule can be proven for a real dead
 * process, a real live one and an unanswerable case without arranging any of
 * them. The default asks the operating system.
 */
export function leaseVerdict(
  lease: RecoveryJobLease | undefined,
  isAlive: (pid: number) => boolean = processAlive,
  now: number = Date.now(),
): LeaseVerdict {
  if (lease === undefined) {
    return { reclaimable: false, reason: "the job holds no lease, so its owner is unknown" };
  }
  const pid = holderPid(lease.holder);
  if (pid === null) {
    return { reclaimable: false, reason: `lease holder ${JSON.stringify(lease.holder)} carries no usable pid` };
  }
  if (lease.expiresAt > now) {
    return { reclaimable: false, reason: "the lease has not expired" };
  }
  if (isAlive(pid)) {
    return { reclaimable: false, reason: `lease holder ${lease.holder} is still running` };
  }
  return { reclaimable: true, holder: lease.holder };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists and belongs to someone else, which is
    // still alive. Only ESRCH is a process that is gone.
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

/** Read a lease out of a job event payload without inventing one. */
export function leaseOf(data: unknown): RecoveryJobLease | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const lease = (data as Record<string, unknown>).lease;
  if (typeof lease !== "object" || lease === null || Array.isArray(lease)) return undefined;
  const record = lease as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    typeof record.holder !== "string" ||
    typeof record.expiresAt !== "number" ||
    !Number.isFinite(record.expiresAt)
  ) {
    return undefined;
  }
  return { holder: record.holder, expiresAt: record.expiresAt };
}
