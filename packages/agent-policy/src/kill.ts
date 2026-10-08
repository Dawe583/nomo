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
  RevocationStoreError,
  type RevocationRecord,
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
  /** Present only in the process that owns the hold queue. */
  readonly holds?: { readonly index: AgentHoldIndex; readonly deny: HoldDenier };
};

export type KillResult = {
  readonly record: RevocationRecord;
  /** Holds of this agent that were pending and are now denied. */
  readonly deniedHolds: readonly string[];
  /** Whether the agent was already killed; null when the store could not be read. */
  readonly wasKilled: boolean | null;
};

function inputProblem(input: KillSwitchInput): string | null {
  if (typeof input.agentId !== "string" || !AGENT_ID.test(input.agentId))
    return "agent id must match ^[a-z0-9][a-z0-9._-]{0,63}$";
  if (typeof input.by !== "string" || input.by.trim() === "")
    return "the operator (by) is required";
  if (typeof input.reason !== "string") return "reason must be a string";
  return null;
}

function recordFor(
  kind: RevocationRecord["kind"],
  input: KillSwitchInput,
): RevocationRecord {
  return {
    kind,
    agentId: input.agentId,
    at: (input.now ?? (() => new Date()))().toISOString(),
    by: input.by,
    reason: input.reason,
  };
}

export async function killAgent(input: KillSwitchInput): Promise<KillResult> {
  const problem = inputProblem(input);
  if (problem !== null) throw new KillSwitchError(problem);

  let wasKilled: boolean | null;
  try {
    wasKilled = revocationView(await readRevocations(input.storePath)).isKilled(
      input.agentId,
    );
  } catch (error) {
    if (!(error instanceof RevocationStoreError)) throw error;
    wasKilled = null;
  }

  // Store first, holds second: once the record is down, any approval that
  // races the sweep meets a killed agent on its re-check.
  const record = recordFor("kill", input);
  await mkdir(dirname(input.storePath), { recursive: true, mode: 0o700 });
  await appendRevocation(input.storePath, record);

  const deniedHolds: string[] = [];
  if (input.holds !== undefined) {
    for (const holdId of input.holds.index.holdsOf(input.agentId)) {
      if (input.holds.deny(holdId, KILL_SWITCH_ACTOR)) deniedHolds.push(holdId);
      input.holds.index.forget(holdId);
    }
  }
  return { record, deniedHolds, wasKilled };
}

export async function reinstateAgent(
  input: Omit<KillSwitchInput, "holds">,
): Promise<RevocationRecord> {
  const problem = inputProblem(input);
  if (problem !== null) throw new KillSwitchError(problem);
  if (input.reason.trim() === "")
    throw new KillSwitchError("a reinstate needs a reason");
  // Strict read: a store we cannot parse never lets an agent back in.
  const view = revocationView(await readRevocations(input.storePath));
  if (!view.isKilled(input.agentId))
    throw new KillSwitchError(`agent ${input.agentId} is not killed`);
  const record = recordFor("reinstate", input);
  await appendRevocation(input.storePath, record);
  return record;
}
