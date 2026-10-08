/**
 * The kill-switch as an act, contract section 7, steps 1 to 4.
 *
 * Killing and reinstating are deliberately asymmetric. A kill is never blocked:
 * not by a corrupt store, not by an agent the store has never seen, not by the
 * agent already being killed. A store that cannot be parsed already denies
 * every call, so appending to it can only keep things stopped. A reinstate is
 * the opposite: it reads the store strictly and refuses unless the agent is
 * killed right now, because it is the one act here that lets an agent run
 * again.
 *
 * Both write under `<store>.lock`, so a reinstate's read, check and append
 * cannot interleave with a kill's append from this or another process. A kill
 * waits for the lock only briefly and then writes anyway: stopping an agent
 * must not depend on a lock another writer left behind.
 *
 * Pending holds: VOID's `HeldCall` carries no agent, and this package does not
 * change VOID's hold queue. The proxy records which hold belongs to which agent
 * in an `AgentHoldIndex` when it parks a call, and `killAgent` denies those
 * holds through a callback the proxy supplies (`HoldQueue.resolve` or
 * `ApprovalBroker.decide`). A separate process, such as the CLI, has no queue to
 * call; there the next check, or the release re-check, does the stopping.
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { AGENT_ID, BUILTIN_RULES } from "./grammar.ts";
import {
  appendRevocation,
  readRevocations,
  revocationView,
  RevocationLockTimeout,
  RevocationStoreError,
  withStoreLock,
  type RevocationRecord,
  type StoreLockOptions,
} from "./revocations.ts";

/** The `by` on every hold the kill-switch denies, so the agent's error body names it. */
export const KILL_SWITCH_ACTOR = BUILTIN_RULES.killSwitch;

export class KillSwitchError extends Error {}

/** Which pending hold belongs to which agent. One instance per proxy process, like the hold queue. */
export class AgentHoldIndex {
  private readonly agentOf = new Map<string, string>();

  track(holdId: string, agentId: string): void {
    this.agentOf.set(holdId, agentId);
  }

  /** Called when a hold resolves or expires; forgetting an unknown id is a no-op. */
  forget(holdId: string): void {
    this.agentOf.delete(holdId);
  }

  holdsOf(agentId: string): readonly string[] {
    return [...this.agentOf]
      .filter(([, agent]) => agent === agentId)
      .map(([holdId]) => holdId);
  }
}

/** Denies one pending hold. False when the hold had already finished. */
export type HoldDenier = (holdId: string, by: string) => boolean;

export type KillSwitchInput = {
  readonly storePath: string;
  readonly agentId: string;
  readonly by: string;
  readonly reason: string;
  readonly now?: () => Date;
  /** Store lock timing; the defaults suit operators, tests shorten them. */
  readonly lock?: StoreLockOptions;
  /** Present only in the process that owns the hold queue. */
  readonly holds?: { readonly index: AgentHoldIndex; readonly deny: HoldDenier };
};

export type KillResult = {
  readonly record: RevocationRecord;
  /** Holds of this agent that were pending and are now denied. */
  readonly deniedHolds: readonly string[];
  /** Holds whose denier threw. They may still be pending and stay indexed for the next kill. */
  readonly failedHolds: readonly string[];
  /** Whether the agent was already killed; null when the store could not be read. */
  readonly wasKilled: boolean | null;
  /** True when the store lock stayed held past its wait and the kill was written without it. */
  readonly lockTimedOut: boolean;
};

function inputProblem(input: KillSwitchInput): string | null {
  if (typeof input.agentId !== "string" || !AGENT_ID.test(input.agentId))
    return "agent id must match ^[a-z0-9][a-z0-9._-]{0,63}$";
  if (typeof input.by !== "string" || input.by.trim() === "")
    return "the operator (by) is required";
  if (typeof input.reason !== "string") return "reason must be a string";
  return null;
}

/**
 * The clock, checked. An invalid Date would make `toISOString` throw a
 * RangeError after the store was already touched; this names it instead.
 */
function clockOf(input: { readonly now?: () => Date }): () => Date {
  const now = input.now ?? (() => new Date());
  return () => {
    const at = now();
    if (!(at instanceof Date) || Number.isNaN(at.getTime()))
      throw new KillSwitchError("the clock returned an invalid time");
    return at;
  };
}

function recordFor(
  kind: RevocationRecord["kind"],
  input: KillSwitchInput,
  at: Date,
): RevocationRecord {
  return {
    kind,
    agentId: input.agentId,
    at: at.toISOString(),
    by: input.by,
    reason: input.reason,
  };
}

export async function killAgent(input: KillSwitchInput): Promise<KillResult> {
  const problem = inputProblem(input);
  if (problem !== null) throw new KillSwitchError(problem);
  const clock = clockOf(input);
  clock(); // refuse a broken clock before anything is written

  await mkdir(dirname(input.storePath), { recursive: true, mode: 0o700 });
  let wasKilled: boolean | null = null;
  let record: RevocationRecord | undefined;
  const append = async () => {
    try {
      wasKilled = revocationView(
        await readRevocations(input.storePath),
      ).isKilled(input.agentId);
    } catch (error) {
      if (!(error instanceof RevocationStoreError)) throw error;
      wasKilled = null;
    }
    // Stamped inside the lock, so the kill is never older than a record
    // appended by whoever held the lock before us.
    record = recordFor("kill", input, clock());
    await appendRevocation(input.storePath, record);
  };

  // The lock keeps a reinstate from reading the store, missing this kill and
  // appending after it. A kill is never blocked, so a lock that stays held
  // past the wait is written through and the result says so.
  let lockTimedOut = false;
  try {
    await withStoreLock(input.storePath, append, input.lock);
  } catch (error) {
    if (!(error instanceof RevocationLockTimeout)) throw error;
    lockTimedOut = true;
    await append();
  }

  // Store first, holds second: once the record is down, any approval that
  // races the sweep meets a killed agent on its re-check. One denier failing
  // must not leave the agent's other holds pending, so each is tried; a hold
  // whose denier threw stays in the index, and the next kill tries it again.
  const deniedHolds: string[] = [];
  const failedHolds: string[] = [];
  if (input.holds !== undefined) {
    for (const holdId of input.holds.index.holdsOf(input.agentId)) {
      let denied: boolean;
      try {
        denied = input.holds.deny(holdId, KILL_SWITCH_ACTOR);
      } catch {
        failedHolds.push(holdId);
        continue;
      }
      if (denied) deniedHolds.push(holdId);
      input.holds.index.forget(holdId);
    }
  }
  return { record: record!, deniedHolds, failedHolds, wasKilled, lockTimedOut };
}

export async function reinstateAgent(
  input: Omit<KillSwitchInput, "holds">,
): Promise<RevocationRecord> {
  const problem = inputProblem(input);
  if (problem !== null) throw new KillSwitchError(problem);
  if (input.reason.trim() === "")
    throw new KillSwitchError("a reinstate needs a reason");
  const clock = clockOf(input);
  clock();

  const killedNow = async (): Promise<readonly RevocationRecord[]> => {
    // Strict read: a store we cannot parse never lets an agent back in.
    const records = (await readRevocations(input.storePath)).filter(
      (record) => record.agentId === input.agentId,
    );
    if (records.at(-1)?.kind !== "kill")
      throw new KillSwitchError(`agent ${input.agentId} is not killed`);
    return records;
  };
  // Checked once without the lock, so a refused reinstate leaves no lock file
  // behind, and once more under it, where it counts. The operator asked to
  // lift the kill they saw; a kill that landed while this waited is a new
  // decision by someone else, and lifting it unseen is the race this prevents.
  const seen = await killedNow();
  try {
    return await withStoreLock(
      input.storePath,
      async () => {
        const records = await killedNow();
        if (records.length !== seen.length)
          throw new KillSwitchError(
            `agent ${input.agentId} was killed again while this reinstate waited; nothing was recorded, check the store and retry`,
          );
        const record = recordFor("reinstate", input, clock());
        const lastAt = records.at(-1)!.at;
        if (Date.parse(record.at) < Date.parse(lastAt))
          throw new KillSwitchError(
            `the clock (${record.at}) is behind the agent's last record (${lastAt}); a reinstate cannot predate the kill it lifts`,
          );
        await appendRevocation(input.storePath, record);
        return record;
      },
      input.lock,
    );
  } catch (error) {
    if (error instanceof RevocationLockTimeout)
      throw new KillSwitchError(
        "the revocation store is locked by another writer; nothing was recorded, try again",
      );
    throw error;
  }
}
