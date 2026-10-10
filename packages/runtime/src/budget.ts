import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { chmod, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { OperationEvent } from "./journal.ts";
export type IrreversibilityBudget = {
  dailyLimit: number;
  perAgentDailyLimit?: number;
};
export type BudgetReservation = { day: string; units: 1; agentId: string };
export function validateBudget(budget: IrreversibilityBudget): void {
  for (const limit of [
    budget.dailyLimit,
    ...(budget.perAgentDailyLimit === undefined
      ? []
      : [budget.perAgentDailyLimit]),
  ])
    if (!Number.isSafeInteger(limit) || limit < 0)
      throw new Error("Budget limits must be nonnegative integers.");
}
/** Called inside the same workspace journal transaction as authorization and dispatch.
 * Unknown outcomes and unfinished reservations remain spent. No retry resets them. */
export function reserveBudget(
  events: readonly OperationEvent[],
  budget: IrreversibilityBudget,
  agentId: string,
  now = new Date(),
): BudgetReservation | null {
  validateBudget(budget);
  const day = now.toISOString().slice(0, 10),
    last = new Map(events.map((event) => [event.operationId, event]));
  let total = 0,
    agent = 0;
  for (const event of events) {
    if (
      event.stage !== "authorized" ||
      !event.data ||
      typeof event.data !== "object" ||
      Array.isArray(event.data)
    )
      continue;
    const reservation = event.data.budget as BudgetReservation | undefined;
    if (!reservation || reservation.day !== day) continue;
    // Only a confirmed failure releases the reservation. Unknown still consumes it.
    if (last.get(event.operationId)?.stage === "failed") continue;
    total += reservation.units;
    if (reservation.agentId === agentId) agent += reservation.units;
  }
  if (
    total >= budget.dailyLimit ||
    agent >= (budget.perAgentDailyLimit ?? budget.dailyLimit)
  )
    return null;
  return { day, units: 1, agentId };
}

// ---------------------------------------------------------------------------
// R10 server ledger.
//
// `reserveBudget` above derives the spend from one journal transaction held in
// one process. That is correct and it is also the whole story of what a local
// derivation can know: it sees exactly the events its own process wrote. The
// ledger below keeps the identical reservation semantics and moves the
// authority to a store every worker of one server can reach.
//
// Accounting is SHARED, not per session, and the reason is arithmetic rather
// than taste: a per-session ledger hands every worker the full daily limit, so
// N workers authorise N times the irreversible work the cap exists to prevent.
// Sharing buys two requirements the in-process derivation never needed, and
// this module refuses to run without both:
//
//   1. a store that serialises writers across workers, and
//   2. a fence per commit, so a worker that decided against a snapshot nobody
//      else has seen yet cannot overwrite the winner.
//
// What no store can buy is bought with disclosure instead of code. A `host`
// store fences processes on one machine and is structurally unable to detect a
// second, independent store on another host. `BUDGET_SCOPE_GUARANTEE` states
// that per scope and the ledger refuses a `session` store outright, so a caller
// cannot silently promote per process counting to a server budget.
//
// The crash question is decided here, not left to hope. The reserve commits
// before dispatch, so a process that dies in between leaves a durable
// `reserved` hold rather than a silent gap. `expire` makes that visible and
// marks it `expired`, which still counts as spent: a process that crashed
// cannot prove it never ran, and "cannot prove" is not a refund. Reclaiming
// those units is an audited operator action, deliberately absent here.
// ---------------------------------------------------------------------------

export type BudgetStoreScope = "session" | "host" | "cluster";

/** Quoted verbatim wherever a caller reports budget safety. None of these is
 * "safe by default"; the strongest one is only as good as the store claiming
 * it. */
export const BUDGET_SCOPE_GUARANTEE: Readonly<Record<BudgetStoreScope, string>> =
  Object.freeze({
    session:
      "No cross worker exclusion at all. Two workers each receive the full limit. Refused by serverBudgetLedger.",
    host: "Fenced across every process on one host by an SQLite writer mutex. A second host holding an independent store is not fenced and cannot be detected from here.",
    cluster:
      "Linearizable compare and swap ordered by one authority shared by every worker. Claimable only by a store that really has a single total order.",
  });

/** Unreadable or untrustworthy account state. Never a denial and never a
 * pass: the caller must treat it as an incident, not as an empty budget. */
export class BudgetStateError extends Error {}
/** A terminal action that contradicts the recorded hold. Also fail closed. */
export class BudgetConflictError extends Error {}

export type BudgetHoldState = "reserved" | "settled" | "released" | "expired";
/** `failed` is deliberately absent: in the journal a `failed` stage only ever
 * means the side effect provably never ran, which is `release`, not a charge
 * that happens to read "failed". A post-dispatch failure is `unknown`. */
export type BudgetOutcome = "succeeded" | "unknown";

export type BudgetHold = {
  operationId: string;
  agentId: string;
  units: 1;
  state: BudgetHoldState;
  reservedAt: string;
  outcome?: BudgetOutcome;
  settledAt?: string;
  releasedAt?: string;
  reason?: string;
};

export type BudgetDayState = {
  schema: "void.budget.account.v1";
  key: string;
  /** UTC day. The window comes from the clock only, so no timezone change can
   * open a second daily draw. */
  day: string;
  version: number;
  /** Append only, so releasing a hold keeps the trail of what it cost. */
  holds: BudgetHold[];
};

export type BudgetFence = { key: string; version: number };

export interface BudgetStore {
  readonly scope: BudgetStoreScope;
  /** `null` when the account has never been drawn from. Must throw rather than
   * return a default when the record exists but cannot be trusted. */
  read(key: string): Promise<BudgetDayState | null>;
  /** Atomic. `false` means a newer version already won and the caller must
   * re-read; a store that overwrites a stale version is not a store this
   * ledger can fence against. */
  compareAndSwap(
    key: string,
    expected: BudgetFence,
    next: BudgetDayState,
  ): Promise<boolean>;
  /** Release the backing handle. Optional because an in-memory store has none.
   *
   * A SQLite store must be closable: Windows refuses to unlink an open database
   * file, so a host that never calls this cannot rotate, archive or remove its
   * own budget state, and every test that cleans up a temp directory fails. */
  readonly close?: () => void;
}

export type BudgetSpend = {
  key: string;
  day: string;
  version: number;
  scope: BudgetStoreScope;
  guarantee: string;
  /** Units charged for the day. Released holds are the only exclusion. */
  total: number;
  perAgent: Record<string, number>;
  reserved: number;
  settled: number;
  expired: number;
};

export type ReserveOutcome =
  | { ok: true; hold: BudgetHold; idempotent: boolean; spend: BudgetSpend }
  | { ok: false; reason: "exhausted"; spend: BudgetSpend }
  | {
      ok: false;
      /** Not a cap decision: this call lost a fence it was not allowed to
       * retry past, so it reports contention rather than exhaustion. */
      reason: "contended";
      spend: BudgetSpend;
    };

export type ServerBudgetOptions = {
  store: BudgetStore;
  /** Shared by every worker of one server. */
  account: string;
  budget: IrreversibilityBudget;
  /** How long a `reserved` hold may sit without a terminal record before
   * `expire` may claim it. Expiry never refunds, so a lease that is too short
   * only makes a leak visible sooner and never opens the cap. */
  leaseMs?: number;
  now?: () => Date;
  /** Bounded compare and swap retries before failing closed on contention. */
  attempts?: number;
};

export type ServerBudgetLedger = {
  readonly account: string;
  readonly scope: BudgetStoreScope;
  readonly guarantee: string;
  readonly key: string;
  /** Commits the unit before dispatch, exactly where the journal derivation
   * refuses on a null reservation. `attempts` on the input bounds the fence
   * retries for that one call: a caller already holding an unrelated writer
   * lock passes 1 and is told `reason: "contended"` when the race is lost,
   * because for that caller a retry is the other lock's stall. */
  reserve(input: {
    operationId: string;
    agentId: string;
    attempts?: number;
  }): Promise<ReserveOutcome>;
  /** Records the terminal result of an operation that may have run. A second
   * settle of the same outcome is idempotent; a different one is a conflict
   * and throws. */
  settle(input: {
    operationId: string;
    outcome: BudgetOutcome;
  }): Promise<BudgetHold>;
  /** Confirmed non-execution only, never a guess. Requires the reason that
   * proves the side effect did not happen. This is where the journal's
   * `failed` stage belongs; it is the only call that hands a unit back. */
  release(input: { operationId: string; reason: string }): Promise<BudgetHold>;
  /** Turns a dangling reservation into a visible, still spent hold. */
  expire(input: { operationId: string }): Promise<BudgetHold>;
  /** Same sweep for every hold whose lease elapsed. Returns the operation ids. */
  expireStale(): Promise<string[]>;
  snapshot(): Promise<BudgetSpend>;
};

const ACCOUNT_SCHEMA = "void.budget.account.v1";
const DEFAULT_LEASE_MS = 900_000;
const DEFAULT_ATTEMPTS = 64;
const LOCK_DEADLINE_MS = 30_000;
const ACCOUNT_PATTERN = /^[\w.-]{1,100}$/;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const EXPIRED_REASON = "lease elapsed without a terminal record";
const HOLD_STATES: Readonly<Record<string, true>> = {
  reserved: true,
  settled: true,
  released: true,
  expired: true,
};
const OUTCOMES: Readonly<Record<string, true>> = {
  succeeded: true,
  unknown: true,
};

/** Wire shape of a persisted hold. Every field stays `unknown` until it is
 * checked, so the parser below is the only place that decides a hold is real. */
type BudgetHoldFields = {
  operationId?: unknown;
  agentId?: unknown;
  units?: unknown;
  state?: unknown;
  reservedAt?: unknown;
  outcome?: unknown;
  settledAt?: unknown;
  releasedAt?: unknown;
  reason?: unknown;
};

type BudgetAccountFields = {
  schema?: unknown;
  key?: unknown;
  day?: unknown;
  version?: unknown;
  holds?: unknown;
};

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const parseHold = (raw: unknown): BudgetHold => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new BudgetStateError("Budget hold is not an object.");
  const {
    operationId,
    agentId,
    units,
    state,
    reservedAt,
    outcome,
    settledAt,
    releasedAt,
    reason,
  } = raw as BudgetHoldFields;
  if (typeof operationId !== "string" || !operationId)
    throw new BudgetStateError("Budget hold has no operation id.");
  if (typeof agentId !== "string" || !agentId)
    throw new BudgetStateError("Budget hold has no agent id.");
  if (units !== 1)
    throw new BudgetStateError("Budget hold units must be 1.");
  if (typeof state !== "string" || !HOLD_STATES[state])
    throw new BudgetStateError(
      `Budget hold has an unknown state: ${String(state)}.`,
    );
  if (
    typeof reservedAt !== "string" ||
    !Number.isFinite(Date.parse(reservedAt))
  )
    throw new BudgetStateError("Budget hold has no valid reservation time.");
  if (outcome !== undefined && (typeof outcome !== "string" || !OUTCOMES[outcome]))
    throw new BudgetStateError(
      `Budget hold has an unknown outcome: ${String(outcome)}.`,
    );
  if (
    settledAt !== undefined &&
    (typeof settledAt !== "string" || !Number.isFinite(Date.parse(settledAt)))
  )
    throw new BudgetStateError("Budget hold has an invalid settlement time.");
  if (
    releasedAt !== undefined &&
    (typeof releasedAt !== "string" ||
      !Number.isFinite(Date.parse(releasedAt)))
  )
    throw new BudgetStateError("Budget hold has an invalid release time.");
  if (reason !== undefined && typeof reason !== "string")
    throw new BudgetStateError("Budget hold reason must be a string.");
  // Cross field: a hold that claims a terminal state must carry the evidence
  // for it, so a torn or hand edited body cannot forge "released" into
  // "settled" and leave the unit charged as a success.
  if (state === "settled" && (outcome === undefined || settledAt === undefined))
    throw new BudgetStateError("Settled budget hold is missing its outcome.");
  if (state === "released" && (reason === undefined || releasedAt === undefined))
    throw new BudgetStateError("Released budget hold is missing its reason.");
  if (
    state === "reserved" &&
    (outcome !== undefined ||
      settledAt !== undefined ||
      releasedAt !== undefined)
  )
    throw new BudgetStateError(
      "Reserved budget hold already carries a terminal record.",
    );
  if (state === "expired" && (settledAt !== undefined || releasedAt !== undefined))
    throw new BudgetStateError(
      "Expired budget hold already carries a terminal record.",
    );
  return {
    operationId,
    agentId,
    units: 1,
    state: state as BudgetHoldState,
    reservedAt,
    ...(outcome === undefined ? {} : { outcome: outcome as BudgetOutcome }),
    ...(settledAt === undefined ? {} : { settledAt }),
    ...(releasedAt === undefined ? {} : { releasedAt }),
    ...(reason === undefined ? {} : { reason }),
  };
};

const parseDayState = (body: string, key: string): BudgetDayState => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new BudgetStateError(
      `Budget account state is not readable JSON: ${errorText(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new BudgetStateError("Budget account state is not an object.");
  const { schema, key: storedKey, day, version, holds } =
    parsed as BudgetAccountFields;
  if (schema !== ACCOUNT_SCHEMA)
    throw new BudgetStateError(
      `Budget account state has schema ${String(schema)}, expected ${ACCOUNT_SCHEMA}.`,
    );
  if (storedKey !== key)
    throw new BudgetStateError("Budget account state belongs to another key.");
  if (typeof day !== "string" || !DAY_PATTERN.test(day))
    throw new BudgetStateError("Budget account state has no valid UTC day.");
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0)
    throw new BudgetStateError("Budget account state has no valid version.");
  if (!Array.isArray(holds))
    throw new BudgetStateError("Budget account state has no holds list.");
  return {
    schema: ACCOUNT_SCHEMA,
    key,
    day,
    version,
    holds: holds.map(parseHold),
  };
};

const tally = (holds: readonly BudgetHold[]) => {
  let total = 0,
    reserved = 0,
    settled = 0,
    expired = 0;
  const perAgent: Record<string, number> = {};
  for (const hold of holds) {
    // Only a confirmed non-execution stops counting. Unknown and expired stay
    // spent, exactly as the journal derivation above treats them.
    if (hold.state === "released") continue;
    total += hold.units;
    perAgent[hold.agentId] = (perAgent[hold.agentId] ?? 0) + hold.units;
    if (hold.state === "reserved") reserved += hold.units;
    if (hold.state === "settled") settled += hold.units;
    if (hold.state === "expired") expired += hold.units;
  }
  return { total, perAgent, reserved, settled, expired };
};

const latestHold = (
  state: BudgetDayState,
  operationId: string,
): BudgetHold | undefined => {
  for (let i = state.holds.length - 1; i >= 0; i--)
    if (state.holds[i].operationId === operationId) return state.holds[i];
  return undefined;
};

export function serverBudgetLedger(
  options: ServerBudgetOptions,
): ServerBudgetLedger {
  const { store, account, budget } = options;
  if (store.scope === "session")
    throw new Error(
      `A session scoped store cannot back a server budget ledger. ${BUDGET_SCOPE_GUARANTEE.session}`,
    );
  validateBudget(budget);
  if (!ACCOUNT_PATTERN.test(account)) throw new Error("Invalid budget account.");
  const now = options.now ?? (() => new Date());
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 0)
    throw new Error("Budget lease must be a nonnegative integer.");
  if (!Number.isSafeInteger(attempts) || attempts < 1)
    throw new Error("Budget attempts must be a positive integer.");
  const day = () => now().toISOString().slice(0, 10);
  const spendOf = (state: BudgetDayState): BudgetSpend => ({
    key: state.key,
    day: state.day,
    version: state.version,
    scope: store.scope,
    guarantee: BUDGET_SCOPE_GUARANTEE[store.scope],
    ...tally(state.holds),
  });
  /** A store that answers with a default instead of a trustworthy record is
   * the one failure this ledger must never absorb, so nothing is caught here
   * beyond turning the cause into a typed incident. */
  const readState = async (forDay: string): Promise<BudgetDayState> => {
    const stored = await store.read(`${account}:${forDay}`).catch((error: unknown) => {
      throw new BudgetStateError(
        `Budget account state could not be read: ${errorText(error)}`,
      );
    });
    return (
      stored ?? {
        schema: ACCOUNT_SCHEMA,
        key: `${account}:${forDay}`,
        day: forDay,
        version: 0,
        holds: [],
      }
    );
  };
  /** Read, decide, commit under the caller's fence. A lost race re-reads and
   * re-decides instead of overwriting, which is the whole fencing story.
   *
   * `lost` exists for the one caller that cannot afford to re-decide. A
   * dispatch path holds an unrelated writer lock across the journal
   * transaction, so a spin here is that lock's stall, and the store behind it
   * can be contended by a worker that is not inside a transaction at all.
   * Such a caller names its own attempt limit and is handed the contention
   * instead of waiting it out. */
  const update = async <T>(
    apply: (state: BudgetDayState) => readonly [BudgetDayState | null, T],
    limit: number,
    lost?: () => Promise<T> | T,
  ): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
      const current = await readState(day());
      const [next, result] = apply(current);
      if (!next) return result;
      if (next.version !== current.version + 1)
        throw new BudgetStateError(
          `Budget commit must advance the version by one, got ${current.version} to ${next.version}.`,
        );
      const won = await store
        .compareAndSwap(
          next.key,
          { key: next.key, version: current.version },
          next,
        )
        .catch((error: unknown) => {
          throw new BudgetStateError(
            `Budget account state could not be committed: ${errorText(error)}`,
          );
        });
      if (won) return result;
      if (attempt >= limit) {
        if (lost) return lost();
        throw new BudgetStateError(
          `Budget commit lost the fence ${limit} times; refusing to guess the account state.`,
        );
      }
    }
  };
  /** Every terminal action starts by proving the hold it means to move. */
  const requireHold = (state: BudgetDayState, operationId: string) => {
    const hold = latestHold(state, operationId);
    if (!hold)
      throw new BudgetConflictError(
        `No budget reservation for operation ${operationId}.`,
      );
    return hold;
  };
  const identifier = (value: string, name: string) => {
    if (typeof value !== "string" || !value)
      throw new Error(`Budget ${name} must be a nonempty string.`);
    return value;
  };
  const move = (
    state: BudgetDayState,
    hold: BudgetHold,
    next: BudgetHold,
  ): BudgetDayState => ({
    ...state,
    version: state.version + 1,
    holds: state.holds.map((item) => (item === hold ? next : item)),
  });
  return {
    account,
    scope: store.scope,
    guarantee: BUDGET_SCOPE_GUARANTEE[store.scope],
    key: `${account}:${day()}`,
    async reserve(input) {
      const operationId = identifier(input.operationId, "operation id");
      const agentId = identifier(input.agentId, "agent id");
      const limit = input.attempts ?? attempts;
      if (!Number.isSafeInteger(limit) || limit < 1)
        throw new Error("Budget attempts must be a positive integer.");
      return update<ReserveOutcome>(
        (state): readonly [BudgetDayState | null, ReserveOutcome] => {
          const existing = latestHold(state, operationId);
          // An operation already charged stays charged, and a retry of an
          // in-flight operation is admitted even at the cap: its unit is paid
          // for, and charging it twice would silently double the spend.
          if (existing && existing.state !== "released")
            return [
              null,
              {
                ok: true,
                hold: existing,
                idempotent: true,
                spend: spendOf(state),
              },
            ];
          const spend = tally(state.holds);
          if (
            spend.total >= budget.dailyLimit ||
            (spend.perAgent[agentId] ?? 0) >=
              (budget.perAgentDailyLimit ?? budget.dailyLimit)
          )
            return [
              null,
              { ok: false, reason: "exhausted", spend: spendOf(state) },
            ];
          const hold: BudgetHold = {
            operationId,
            agentId,
            units: 1,
            state: "reserved",
            reservedAt: now().toISOString(),
          };
          const next = {
            ...state,
            version: state.version + 1,
            holds: [...state.holds, hold],
          };
          return [
            next,
            { ok: true, hold, idempotent: false, spend: spendOf(next) },
          ];
        },
        limit,
        // Only a caller that named its own limit hears about contention. The
        // default keeps treating an unproven account as an incident, because
        // a refusal the caller can act on is a weaker promise than one it
        // cannot.
        input.attempts === undefined
          ? undefined
          : async () => ({
              ok: false,
              reason: "contended" as const,
              spend: spendOf(await readState(day())),
            }),
      );
    },
    async settle(input) {
      const operationId = identifier(input.operationId, "operation id");
      if (typeof input.outcome !== "string" || !OUTCOMES[input.outcome])
        throw new Error(
          `Settling accepts only ${Object.keys(OUTCOMES).join(" and ")}; a confirmed non-execution belongs in release(). Got ${String(input.outcome)}.`,
        );
      return update((state) => {
        const hold = requireHold(state, operationId);
        if (hold.state === "settled") {
          if (hold.outcome === input.outcome) return [null, hold] as const;
          throw new BudgetConflictError(
            `Operation ${operationId} is already settled as ${hold.outcome}; refusing to record ${input.outcome}.`,
          );
        }
        if (hold.state !== "reserved")
          throw new BudgetConflictError(
            `Operation ${operationId} is ${hold.state} and cannot be settled.`,
          );
        const settled: BudgetHold = {
          ...hold,
          state: "settled",
          outcome: input.outcome as BudgetOutcome,
          settledAt: now().toISOString(),
        };
        return [move(state, hold, settled), settled] as const;
      }, attempts);
    },
    async release(input) {
      const operationId = identifier(input.operationId, "operation id");
      // Handing budget back is the one move that shrinks the charge, so the
      // caller has to name the evidence that nothing ran.
      if (typeof input.reason !== "string" || !input.reason)
        throw new Error(
          "Releasing a budget reservation requires the confirmed non-execution reason.",
        );
      return update((state) => {
        const hold = requireHold(state, operationId);
        if (hold.state === "released") return [null, hold] as const;
        if (hold.state !== "reserved")
          throw new BudgetConflictError(
            `Operation ${operationId} is ${hold.state} and cannot be released.`,
          );
        const released: BudgetHold = {
          ...hold,
          state: "released",
          releasedAt: now().toISOString(),
          reason: input.reason,
        };
        return [move(state, hold, released), released] as const;
      }, attempts);
    },
    async expire(input) {
      const operationId = identifier(input.operationId, "operation id");
      return update((state) => {
        const hold = requireHold(state, operationId);
        if (hold.state === "expired") return [null, hold] as const;
        if (hold.state !== "reserved")
          throw new BudgetConflictError(
            `Operation ${operationId} is ${hold.state} and cannot expire.`,
          );
        const expired: BudgetHold = {
          ...hold,
          state: "expired",
          reason: EXPIRED_REASON,
        };
        return [move(state, hold, expired), expired] as const;
      }, attempts);
    },
    async expireStale() {
      return update((state) => {
        const cutoff = now().getTime() - leaseMs;
        const operationIds: string[] = [];
        const holds = state.holds.map((hold) => {
          if (
            hold.state !== "reserved" ||
            Date.parse(hold.reservedAt) > cutoff
          )
            return hold;
          operationIds.push(hold.operationId);
          return {
            ...hold,
            state: "expired" as const,
            reason: EXPIRED_REASON,
          };
        });
        if (!operationIds.length) return [null, [] as string[]] as const;
        return [
          { ...state, version: state.version + 1, holds },
          operationIds,
        ] as const;
      }, attempts);
    },
    async snapshot() {
      return spendOf(await readState(day()));
    },
  };
}

// ---------------------------------------------------------------------------
// Host store. Same writer mutex discipline as `localOperationJournal`: the
// SQLite lock is a writer mutex, not a lease, and process death releases it.
// Local disk only. This is `host` scope and must never be reported as a
// cluster budget; see BUDGET_SCOPE_GUARANTEE.
// ---------------------------------------------------------------------------

const serialise = async <T>(
  db: DatabaseSync,
  write: boolean,
  run: () => T,
): Promise<T> => {
  const deadline = Date.now() + LOCK_DEADLINE_MS;
  for (;;) {
    try {
      if (!write) return run();
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = run();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // The transaction already unwound itself; the original error wins.
        }
        throw error;
      }
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes("database is locked")
      )
        throw error;
      if (Date.now() >= deadline)
        throw new BudgetStateError(
          `Budget store stayed locked for ${LOCK_DEADLINE_MS}ms.`,
        );
      await delay(25);
    }
  }
};

export async function sqliteBudgetStore(file: string): Promise<BudgetStore> {
  const folder = dirname(file);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  // basename, not file.split("/").pop(): a Windows caller passes backslashes, so
  // splitting on "/" returns the whole absolute path and re-joining it doubled
  // the drive into the directory.
  const path = join(await realpath(folder), basename(file));
  const db = new DatabaseSync(path);
  await chmod(path, 0o600);
  db.exec("PRAGMA busy_timeout=0");
  db.exec(
    "CREATE TABLE IF NOT EXISTS nomo_budget_day (key TEXT PRIMARY KEY, version INTEGER NOT NULL, body TEXT NOT NULL)",
  );
  // Prepared once: both call sites sit on a commit path, so re-preparing per
  // read would compile a statement per operation.
  const selectDay = db.prepare(
    "SELECT version, body FROM nomo_budget_day WHERE key = ?",
  );
  const writeDay = db.prepare(
    "INSERT INTO nomo_budget_day (key, version, body) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET version = excluded.version, body = excluded.body",
  );
  const rowAt = (key: string) =>
    selectDay.get(key) as { version: number; body: string } | undefined;
  return {
    scope: "host",
    async read(key) {
      return serialise(db, false, () => {
        const row = rowAt(key);
        if (!row) return null;
        const state = parseDayState(row.body, key);
        // A row whose index disagrees with its body is torn or edited. Either
        // way the fence is untrustworthy, so the whole read fails closed.
        if (row.version !== state.version)
          throw new BudgetStateError(
            `Budget row version ${row.version} disagrees with body version ${state.version}.`,
          );
        return state;
      });
    },
    async compareAndSwap(key, expected, next) {
      if (next.key !== key)
        throw new BudgetStateError("Budget commit key does not match the row.");
      if (next.version !== expected.version + 1)
        throw new BudgetStateError(
          `Budget commit version ${next.version} does not follow fence ${expected.version}.`,
        );
      return serialise(db, true, () => {
        const row = rowAt(key);
        if ((row ? row.version : 0) !== expected.version) return false;
        writeDay.run(key, next.version, JSON.stringify(next));
        return true;
      });
    },
    close() {
      db.close();
    },
  };
}
