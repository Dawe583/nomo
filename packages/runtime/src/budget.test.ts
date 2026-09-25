import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { devKeyProvider } from "../../ledger/src/sign.ts";
import {
  BUDGET_SCOPE_GUARANTEE,
  BudgetConflictError,
  BudgetStateError,
  localOperationJournal,
  localRecoveryVault,
  recoveryRuntime,
  reserveBudget,
  serverBudgetLedger,
  sqliteBudgetStore,
  validateBudget,
  type BudgetStore,
  type ExecutionRequest,
  type OperationEvent,
  type RecoveryAdapter,
  type Stage,
} from "./index.ts";

test("100 concurrent requests across runtime instances cannot exceed two daily irreversible calls; unknown and restart preserve spend", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "void-budget-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const signer = await devKeyProvider({ dir: join(dir, "keys"), env: {} }),
    vault = localRecoveryVault(
      join(dir, "vault"),
      { key: randomBytes(32) },
      "key",
    );
  let dispatches = 0;
  const adapter: RecoveryAdapter = {
    id: "terminal-fixture",
    version: "1",
    async preflight() {
      return {
        effect: "write",
        reversibility: "r3",
        readiness: "unsupported",
        scope: "irreversible test counter",
        resources: ["counter"],
        revision: null,
        blastRadius: { count: 1, precision: "exact" },
      };
    },
    async prepare() {
      return { before: null, plan: { inverse: false } };
    },
    async execute() {
      dispatches++;
      throw new Error("lost response after effect");
    },
    async release() {},
    async reconcile() {
      return { status: "unknown" };
    },
    async recover() {
      throw new Error("no inverse");
    },
  };
  const create = () =>
    recoveryRuntime({
      journal: localOperationJournal(join(dir, "journal"), signer),
      vault,
      adapters: [adapter],
      authorize: async () => true,
      requireRecoverable: false,
      irreversibilityBudget: { dailyLimit: 2, perAgentDailyLimit: 1 },
    });
  const a = create(),
    b = create();
  const request = (i: number): ExecutionRequest => ({
    workspace: "test",
    operationId: "op-" + i,
    runId: "run",
    agentId: "agent-" + i,
    adapterId: adapter.id,
    arguments: null,
  });
  const result = await Promise.all(
    Array.from({ length: 100 }, (_, i) => (i % 2 ? a : b).execute(request(i))),
  );
  assert.equal(result.filter((r) => r.status === "unknown").length, 2);
  assert.equal(result.filter((r) => r.status === "denied").length, 98);
  assert.equal(dispatches, 2);
  assert.equal((await create().execute(request(100))).status, "denied");
  // Concurrent directory setup does not guarantee which request obtains the lock first.
  const admitted = result.findIndex((item) => item.status === "unknown");
  assert.equal((await create().execute(request(admitted))).status, "unknown");
  assert.equal(dispatches, 2);
});
test("invalid and fractional irreversible budgets fail closed", () => {
  for (const dailyLimit of [-1, NaN, Infinity, 1.5])
    assert.throws(() => validateBudget({ dailyLimit }));
  assert.doesNotThrow(() =>
    validateBudget({ dailyLimit: 0, perAgentDailyLimit: 0 }),
  );
});

// ---------------------------------------------------------------------------
// R10 server ledger. Every case below drives the shipped ledger against a real
// store; the crash and two worker cases use real child processes so "durable"
// and "shared" are observed rather than asserted.
// ---------------------------------------------------------------------------

const BUDGET_MODULE = join(import.meta.dirname, "budget.ts");
const AT = "2026-09-25T10:00:00.000Z";
const DAY = AT.slice(0, 10);

const operation = (
  operationId: string,
  agentId: string,
  stage: Stage,
  day?: string,
): OperationEvent => ({
  schema: "void.operation.v1",
  workspace: "test",
  operationId,
  requestDigest: "digest",
  adapterId: "terminal",
  adapterVersion: "1",
  agentId,
  runId: "run",
  at: AT,
  stage,
  data:
    stage === "authorized"
      ? { budget: { day: day ?? DAY, units: 1, agentId } }
      : null,
});

const store = (t: { after: (fn: () => unknown) => void }, dir: string) => {
  t.after(() => rm(dir, { recursive: true, force: true }));
  return sqliteBudgetStore(join(dir, "budget.sqlite"));
};

/** A store that cannot exclude anything across workers must be refused, not
 * silently counted. This is the shared versus per session answer made
 * executable rather than documented. */
const sessionStore: BudgetStore = {
  scope: "session",
  read: async () => null,
  compareAndSwap: async () => true,
};

test("server ledger decides every reservation exactly like the journal derivation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "void-budget-parity-"));
  const budget = { dailyLimit: 3, perAgentDailyLimit: 2 };
  const ledger = serverBudgetLedger({
    store: await store(t, dir),
    account: "shared",
    budget,
    now: () => new Date(AT),
  });
  // The journal side accumulates the same operation history the ledger is
  // asked about, so both decide from the same facts at every step.
  const events: OperationEvent[] = [];
  const step = async (
    operationId: string,
    agentId: string,
    terminal: "succeeded" | "unknown" | "failed" | null,
  ) => {
    // Both decide before the reservation is recorded, which is the ordering
    // execute.ts relies on: reserve, then append `authorized`, then dispatch.
    const derived = reserveBudget(events, budget, agentId, new Date(AT));
    const outcome = await ledger.reserve({ operationId, agentId });
    events.push(operation(operationId, agentId, "authorized"));
    if (terminal) events.push(operation(operationId, agentId, terminal));
    assert.equal(
      outcome.ok,
      derived !== null,
      `reservation ${operationId} disagreed`,
    );
    if (outcome.ok && terminal === "failed")
      await ledger.release({ operationId, reason: "no dispatch occurred" });
    if (outcome.ok && terminal && terminal !== "failed")
      await ledger.settle({ operationId, outcome: terminal });
    return { derived, outcome };
  };
  const first = await step("op-1", "agent-a", "succeeded");
  assert.equal(first.outcome.ok && first.outcome.idempotent, false);
  // A confirmed failure releases, so the unit returns to the pool. This is
  // the only path that hands a unit back, and the journal `failed` stage
  // must land there rather than in settle.
  const second = await step("op-2", "agent-a", "failed");
  assert.equal(second.outcome.ok, true);
  assert.equal((await ledger.snapshot()).total, 1);
  await assert.rejects(
    () => ledger.settle({ operationId: "op-1", outcome: "failed" as never }),
    /belongs in release/,
  );
  // A process that died after authorizing never wrote a terminal stage. The
  // derivation charges it and so must the ledger.
  await step("op-3", "agent-a", null);
  // Unknown holds its unit.
  await step("op-4", "agent-b", "unknown");
  // Daily cap reached: both refuse.
  const denied = await step("op-5", "agent-b", "succeeded");
  assert.equal(denied.outcome.ok, false);
  assert.equal(denied.derived, null);
  assert.equal((await ledger.snapshot()).total, 3);
  assert.equal((await ledger.snapshot()).settled, 2);
});

test("per agent cap refuses the same agent the journal derivation refuses", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "void-budget-agent-"));
  const budget = { dailyLimit: 5, perAgentDailyLimit: 1 };
  const ledger = serverBudgetLedger({
    store: await store(t, dir),
    account: "shared",
    budget,
    now: () => new Date(AT),
  });
  const events: OperationEvent[] = [];
  const attempt = async (operationId: string, agentId: string) => {
    const derived = reserveBudget(events, budget, agentId, new Date(AT));
    const outcome = await ledger.reserve({ operationId, agentId });
    events.push(operation(operationId, agentId, "authorized"));
    assert.equal(outcome.ok, derived !== null, `per agent cap disagreed on ${operationId}`);
  };
  await attempt("op-1", "agent-a");
  await attempt("op-2", "agent-a");
  // The daily cap has room, so only the per agent cap can be the reason.
  await attempt("op-3", "agent-b");
  const spend = await ledger.snapshot();
  assert.equal(spend.total, 2);
  assert.deepEqual(spend.perAgent, { "agent-a": 1, "agent-b": 1 });
});

test("exhausted, unreadable and contradictory budget state all refuse", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "void-budget-refuse-"));
  const file = join(dir, "budget.sqlite");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ledger = serverBudgetLedger({
    store: await sqliteBudgetStore(file),
    account: "shared",
    budget: { dailyLimit: 1 },
    now: () => new Date(AT),
  });
  await ledger.reserve({ operationId: "op-1", agentId: "agent-a" });
  const exhausted = await ledger.reserve({ operationId: "op-2", agentId: "agent-b" });
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.ok === false && exhausted.reason, "exhausted");
  // A retry of an operation already charged is admitted, never recharged.
  const retry = await ledger.reserve({ operationId: "op-1", agentId: "agent-a" });
  assert.equal(retry.ok && retry.idempotent, true);
  assert.equal((await ledger.snapshot()).total, 1);
  // Settling is idempotent for the same outcome and refuses a different one.
  await ledger.settle({ operationId: "op-1", outcome: "unknown" });
  await ledger.settle({ operationId: "op-1", outcome: "unknown" });
  await assert.rejects(
    () => ledger.settle({ operationId: "op-1", outcome: "succeeded" }),
    BudgetConflictError,
  );
  await assert.rejects(
    () => ledger.settle({ operationId: "never-reserved", outcome: "succeeded" }),
    BudgetConflictError,
  );
  // Releasing a settled hold would hand back a unit that was really spent.
  await assert.rejects(
    () => ledger.release({ operationId: "op-1", reason: "pretend" }),
    BudgetConflictError,
  );
  await assert.rejects(
    () => ledger.release({ operationId: "op-1", reason: "" }),
    /confirmed non-execution/,
  );
  assert.equal((await ledger.snapshot()).total, 1);
  // Unreadable account state is an incident, never an empty budget.
  const raw = new DatabaseSync(file);
  raw.prepare("UPDATE void_budget_day SET body = ?").run("{not json");
  await assert.rejects(
    () => ledger.reserve({ operationId: "op-3", agentId: "agent-a" }),
    BudgetStateError,
  );
  // Each of these is a hand edited body that claims a terminal state it cannot
  // back up. The probe ledger has headroom on purpose: a forged body that
  // happens to hit the cap would still answer "exhausted" and hide the fact
  // that the state was trusted at all.
  const probe = serverBudgetLedger({
    store: await sqliteBudgetStore(file),
    account: "shared",
    budget: { dailyLimit: 1000 },
    now: () => new Date(AT),
  });
  // The indexed version moves with the body, so each case below fails on the
  // forged hold itself rather than on a torn row.
  const corrupt = (hold: Record<string, unknown>) => {
    raw
      .prepare("UPDATE void_budget_day SET version = 7, body = ?")
      .run(
        JSON.stringify({
          schema: "void.budget.account.v1",
          key: `shared:${DAY}`,
          day: DAY,
          version: 7,
          holds: [hold],
        }),
      );
  };
  for (const hold of [
    { operationId: "x", agentId: "a", units: 1, state: "settled", reservedAt: AT },
    {
      operationId: "x",
      agentId: "a",
      units: 1,
      state: "settled",
      outcome: "succeeded",
      reservedAt: AT,
    },
    { operationId: "x", agentId: "a", units: 1, state: "released", reservedAt: AT },
    {
      operationId: "x",
      agentId: "a",
      units: 1,
      state: "expired",
      settledAt: AT,
      reservedAt: AT,
    },
    { operationId: "x", agentId: "a", units: 2, state: "reserved", reservedAt: AT },
    { operationId: "x", agentId: "a", units: 1, state: "pending", reservedAt: AT },
  ]) {
    corrupt(hold);
    await assert.rejects(
      () => probe.reserve({ operationId: "op-3", agentId: "agent-a" }),
      BudgetStateError,
      `accepted a forged hold: ${JSON.stringify(hold)}`,
    );
  }
  raw.close();
  // A store that cannot exclude anything across workers is refused outright.
  assert.throws(
    () =>
      serverBudgetLedger({
        store: sessionStore,
        account: "shared",
        budget: { dailyLimit: 1 },
      }),
    /session scoped store/,
  );
  assert.match(BUDGET_SCOPE_GUARANTEE.host, /cannot be detected/);
});

test("two workers on one account never both spend the same unit", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "void-budget-race-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // Two stores, two connections, no shared memory: exactly the situation the
  // in process journal derivation cannot see.
  const budget = { dailyLimit: 2, perAgentDailyLimit: 1 };
  const left = serverBudgetLedger({
    store: await sqliteBudgetStore(join(dir, "budget.sqlite")),
    account: "shared",
    budget,
  });
  const right = serverBudgetLedger({
    store: await sqliteBudgetStore(join(dir, "budget.sqlite")),
    account: "shared",
    budget,
  });
  const outcomes = await Promise.all(
    Array.from({ length: 100 }, (_, i) =>
      (i % 2 ? left : right).reserve({
        operationId: `op-${i}`,
        agentId: `agent-${i}`,
      }),
    ),
  );
  assert.equal(outcomes.filter((item) => item.ok).length, 2);
  assert.equal((await left.snapshot()).total, 2);
  assert.equal((await right.snapshot()).total, 2);
  // Every worker sees the same charge, so no worker can restart from zero.
  assert.equal((await right.snapshot()).version, (await left.snapshot()).version);
});

test("a worker killed between reserve and settle leaves a detectable charge that is never refunded", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "void-budget-crash-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "budget.sqlite");
  const worker = join(dir, "worker.mts");
  const ready = join(dir, "ready");
  await writeFile(
    worker,
    `import { writeFileSync } from "node:fs";
import { serverBudgetLedger, sqliteBudgetStore } from ${JSON.stringify(BUDGET_MODULE)};
const [storeFile, account, limit, operationId, readyPath] = process.argv.slice(2);
const ledger = serverBudgetLedger({
  store: await sqliteBudgetStore(storeFile),
  account,
  budget: { dailyLimit: Number(limit) },
});
const outcome = await ledger.reserve({ operationId, agentId: "agent-crash" });
writeFileSync(readyPath, outcome.ok ? "reserved" : "denied");
process.kill(process.pid, "SIGKILL");
`,
  );
  const killed = spawnSync(
    process.execPath,
    [worker, file, "shared", "1", "op-crash", ready],
    { encoding: "utf8" },
  );
  assert.equal(killed.signal, "SIGKILL");
  assert.equal(await readFile(ready, "utf8"), "reserved");
  // A fresh process, a fresh store, no memory of the dead one: the charge
  // survived the crash and is visible as an unfinished reservation.
  const after = serverBudgetLedger({
    store: await sqliteBudgetStore(file),
    account: "shared",
    budget: { dailyLimit: 1 },
    leaseMs: 1000,
    now: () => new Date(Date.now() + 3_600_000),
  });
  const seen = await after.snapshot();
  assert.equal(seen.total, 1);
  assert.equal(seen.reserved, 1);
  assert.deepEqual(await after.expireStale(), ["op-crash"]);
  const expired = await after.snapshot();
  assert.equal(expired.expired, 1);
  assert.equal(expired.reserved, 0);
  // Expiry makes the leak visible; it does not refund it, because a crashed
  // process cannot prove the side effect never happened.
  assert.equal(expired.total, 1);
  const next = await after.reserve({ operationId: "op-next", agentId: "agent-a" });
  assert.equal(next.ok, false);
  // Nothing can quietly settle or release the crash away afterwards either.
  await assert.rejects(
    () => after.settle({ operationId: "op-crash", outcome: "unknown" }),
    BudgetConflictError,
  );
  await assert.rejects(
    () => after.release({ operationId: "op-crash", reason: "it probably ran" }),
    BudgetConflictError,
  );
  assert.equal((await after.snapshot()).total, 1);
});

test("two worker processes share one account across a process boundary", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "void-budget-procs-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "budget.sqlite");
  const worker = join(dir, "worker.mts");
  await writeFile(
    worker,
    `import { serverBudgetLedger, sqliteBudgetStore } from ${JSON.stringify(BUDGET_MODULE)};
const [storeFile, account, limit, tag, count] = process.argv.slice(2);
const ledger = serverBudgetLedger({
  store: await sqliteBudgetStore(storeFile),
  account,
  budget: { dailyLimit: Number(limit) },
});
const outcomes = await Promise.all(
  Array.from({ length: Number(count) }, (_, i) =>
    ledger.reserve({ operationId: tag + "-" + i, agentId: tag }),
  ),
);
process.stdout.write(String(outcomes.filter((item) => item.ok).length));
`,
  );
  const runs = ["a", "b", "c", "d"].map((tag) =>
    spawnSync(
      process.execPath,
      [worker, file, "shared", "2", tag, "10"],
      { encoding: "utf8" },
    ),
  );
  for (const run of runs) assert.equal(run.status, 0, run.stderr);
  const admitted = runs.reduce(
    (sum, run) => sum + Number(run.stdout),
    0,
  );
  assert.equal(admitted, 2);
  const ledger = serverBudgetLedger({
    store: await sqliteBudgetStore(file),
    account: "shared",
    budget: { dailyLimit: 2 },
  });
  assert.equal((await ledger.snapshot()).total, 2);
});

test("a stale fence can never overwrite a newer account state", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "void-budget-fence-"));
  const budgetStore = await store(t, dir);
  const key = "shared:" + DAY;
  const fresh = (version: number) => ({
    schema: "void.budget.account.v1" as const,
    key,
    day: DAY,
    version,
    holds: [],
  });
  assert.equal(
    await budgetStore.compareAndSwap(key, { key, version: 0 }, fresh(1)),
    true,
  );
  // A second worker that decided against version 0 loses rather than wins.
  assert.equal(
    await budgetStore.compareAndSwap(key, { key, version: 0 }, fresh(1)),
    false,
  );
  assert.equal(
    await budgetStore.compareAndSwap(key, { key, version: 1 }, fresh(2)),
    true,
  );
  assert.equal((await budgetStore.read(key))?.version, 2);
  // A version that does not follow the fence is a store bug, not a write.
  await assert.rejects(
    () => budgetStore.compareAndSwap(key, { key, version: 9 }, fresh(12)),
    /does not follow fence/,
  );
});
