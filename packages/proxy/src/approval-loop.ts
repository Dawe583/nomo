/**
 * The proxy owns pumping because approval expiry is part of request routing,
 * not policy. A directory watcher must also wake the pump while a request is
 * blocked on a hold; polling only between input reads would deadlock approval.
 */

import { join } from "node:path";

import type { ApprovalBroker, ApprovalRecord } from "../../policy/src/approvals.ts";
import type { HeldCall, HoldQueue } from "../../policy/src/hold.ts";
import type { PolicyCall } from "../../policy/src/decide.ts";

export type ApprovalClock = {
  readonly now: () => number;
};

export type ApprovalPump = {
  readonly onHold: (queue: HoldQueue) => () => void;
  readonly poll: (dueAt?: number) => readonly ApprovalRecord[];
  readonly stop: () => void;
};

export type ApprovalWatcher = (dir: string, changed: () => void, failed: (error: unknown) => void) => { close(): void };
export type ApprovalPumpOptions = {
  readonly watch?: ApprovalWatcher;
  readonly onError?: (error: unknown) => void;
};

export function pumpApprovals(
  broker: ApprovalBroker,
  clock: ApprovalClock = { now: () => Date.now() },
  options: ApprovalPumpOptions = {},
): ApprovalPump {
  let active: { readonly queue: HoldQueue; readonly originalHold: HoldQueue["hold"] } | null = null;

  let stopped = false;
  const failClosed = (error: unknown): void => {
    active?.queue.close();
    try { broker.expire(Infinity); } catch { /* Queue closure must survive a broken disk. */ }
    try { options.onError?.(error); } catch { /* Diagnostics cannot undo a refusal. */ }
  };
  const poll = (dueAt = clock.now()): readonly ApprovalRecord[] => {
    if (stopped) return [];
    try {
      const expired = broker.expire(dueAt);
      broker.consumeDecisions();
      return expired;
    } catch (error) {
      failClosed(error);
      return [];
    }
  };
  const watcher = broker.stateDirectory === undefined ? undefined :
    (options.watch ?? watchDecisions)(join(broker.stateDirectory, "decisions"), () => { poll(); }, failClosed);

  return {
    onHold(queue) {
      if (stopped || active !== null) throw new Error("approval pump cannot attach another queue");
      const originalHold = queue.hold;
      const runHold = originalHold.bind(queue);
      const restore = (): void => {
        if (active === null || active.queue !== queue) return;
        queue.hold = originalHold;
        active = null;
      };
      queue.hold = ((
        call: Omit<HeldCall, "id" | "heldAt" | "expiresAt">,
        seconds: number,
        signal?: AbortSignal,
      ) => {
        const promise = runHold(call, seconds, signal);
        const held = newestHold(queue, call.tool);
        broker.register(queue, policyCallFromHeld(held));
        void promise.then((resolution) => {
          if (resolution.outcome.kind === "cancelled") broker.cancel(resolution.id);
          else poll();
        });
        return promise;
      }) as HoldQueue["hold"];
      active = { queue, originalHold };
      return restore;
    },
    poll,
    stop() {
      stopped = true;
      watcher?.close();
      if (active === null) { broker.close(); return; }
      active.queue.close();
      try { broker.expire(Infinity); } catch { /* Shutdown still closes the queue when persistence fails. */ }
      active.queue.hold = active.originalHold;
      active = null;
      broker.close();
    },
  };
}

function newestHold(queue: HoldQueue, tool: string): HeldCall {
  const matches = queue.list().filter((call) => call.tool === tool);
  const latest = matches.at(-1);
  if (latest === undefined) throw new Error(`hold queue did not retain ${tool}`);
  return latest;
}

function policyCallFromHeld(held: HeldCall): PolicyCall {
  // Args stay on the HeldCall and live in this process only: approval state
  // is durable, and call arguments can carry secrets, so the record a later
  // reader sees must not reproduce what the call was handed. The approve.test
  // fixture pins that boundary by asserting the persisted bytes never contain
  // the arguments it handed the hold.
  return {
    tool: held.tool,
    connector: connectorFromTool(held.tool),
    workspace: undefined,
    klass: held.klass,
    blastRadius: held.blastRadius,
  };
}

function connectorFromTool(tool: string): string {
  const dot = tool.indexOf(".");
  return dot === -1 ? tool : tool.slice(0, dot);
}

function watchDecisions(_dir: string, changed: () => void, _failed: (error: unknown) => void): { close(): void } {
  // Polling avoids fs.watch backend limits (EMFILE was reproduced on macOS)
  // and lost notifications on mounted filesystems. Reads still fail closed.
  const timer = setInterval(changed, 100);
  timer.unref();
  return { close() { clearInterval(timer); } };
}
