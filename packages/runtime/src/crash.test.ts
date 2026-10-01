import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { devKeyProvider } from "../../ledger/src/sign.ts";
import {
  BudgetStateError,
  localOperationJournal,
  localRecoveryVault,
  recoveryRuntime,
  serverBudgetLedger,
  sqliteBudgetStore,
  type RecoveryAdapter,
} from "./index.ts";

test("SIGKILL releases the writer mutex; restarted executor records unknown without repeating a dispatched write", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "void-killed-runtime-")),
    key = randomBytes(32);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const signer = await devKeyProvider({ dir: join(dir, "keys"), env: {} });
  const request = {
    workspace: "test",
    agentId: "agent",
    runId: "run",
    operationId: "op",
    adapterId: "fixture",
    arguments: null,
  };
  const worker = join(dir, "worker.mjs");
  await writeFile(
    worker,
    `
 import {writeFile} from 'node:fs/promises';
 import {join} from 'node:path';
 import {devKeyProvider} from ${JSON.stringify(new URL("../../ledger/src/sign.ts", import.meta.url).href)};
 import {recoveryRuntime,localOperationJournal,localRecoveryVault} from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
 const root=process.env.TEST_ROOT,signer=await devKeyProvider({dir:join(root,'keys'),env:{}});
 const adapter={id:'fixture',version:'1',async preflight(){return {effect:'write',reversibility:'r1',readiness:'verified',scope:'fixture',resources:['value'],revision:null,blastRadius:{count:1,precision:'exact'}}},async prepare(){return {before:null,plan:null}},async execute(){await writeFile(join(root,'effect'),'one actual effect');process.send('dispatched');await new Promise(()=>{})},async release(){},async reconcile(){return {status:'unknown'}},async recover(){throw new Error('not used')}};
 await recoveryRuntime({journal:localOperationJournal(join(root,'journal'),signer),vault:localRecoveryVault(join(root,'vault'),{key:Buffer.from(process.env.TEST_KEY,'base64')},'key'),adapters:[adapter],authorize:async()=>true}).execute(${JSON.stringify(request)});
 `,
  );
  const child = fork(worker, [], {
    env: { ...process.env, TEST_ROOT: dir, TEST_KEY: key.toString("base64") },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  const [message] = await once(child, "message", {
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(message, "dispatched");
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  let repeats = 0;
  const adapter: RecoveryAdapter = {
    id: "fixture",
    version: "1",
    async preflight() {
      throw new Error("must not preflight again");
    },
    async prepare() {
      throw new Error("must not prepare again");
    },
    async execute() {
      repeats++;
      throw new Error("must not execute again");
    },
    async release() {},
    async reconcile() {
      return { status: "unknown" };
    },
    async recover() {
      throw new Error("unused");
    },
  };
  const runtime = recoveryRuntime({
    journal: localOperationJournal(join(dir, "journal"), signer),
    vault: localRecoveryVault(join(dir, "vault"), { key }, "key"),
    adapters: [adapter],
    authorize: async () => true,
  });
  assert.equal((await runtime.execute(request)).status, "unknown");
  assert.equal(repeats, 0);
  assert.equal(
    await readFile(join(dir, "effect"), "utf8"),
    "one actual effect",
  );
  assert.equal((await runtime.reconcile("test", "op")).status, "unknown");
});

test("independent processes cannot enter the local journal transaction together", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "void-process-lock-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const signer = await devKeyProvider({ dir: join(dir, "keys"), env: {} }),
    worker = join(dir, "worker.mjs");
  await writeFile(
    worker,
    `
 import {join} from 'node:path';
 import {devKeyProvider} from ${JSON.stringify(new URL("../../ledger/src/sign.ts", import.meta.url).href)};
 import {localOperationJournal} from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
 const root=process.env.TEST_ROOT,signer=await devKeyProvider({dir:join(root,'keys'),env:{}});
 await localOperationJournal(join(root,'journal'),signer).transaction('test',async()=>{process.send('locked');await new Promise(resolve=>process.once('message',resolve));});
 process.disconnect();
 `,
  );
  const child = fork(worker, [], {
    env: { ...process.env, TEST_ROOT: dir },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  await once(child, "message", { signal: AbortSignal.timeout(15_000) });
  let entered = false;
  const waiting = localOperationJournal(
    join(dir, "journal"),
    signer,
  ).transaction("test", async () => {
    entered = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(entered, false);
  child.send("release");
  await waiting;
  assert.equal(entered, true);
  if (child.exitCode === null) await once(child, "exit");
});

// ---------------------------------------------------------------------------
// R10: the shared budget ledger on a real dispatch path.
//
// The ledger's own tests prove the reservation semantics against a store.
// What only a dispatch can show is the two properties the wiring exists for:
// two workers that share an account cannot both spend the same unit, and a
// restarted executor cannot re-observe a charge it already paid for.
// ---------------------------------------------------------------------------

const BUDGET_MODULE = new URL("./budget.ts", import.meta.url).href;
const RUNTIME_MODULE = new URL("./index.ts", import.meta.url).href;
const SIGN_MODULE = new URL("../../ledger/src/sign.ts", import.meta.url).href;

/** An effect that cannot be undone, so the irreversible gate is the one under
 * test rather than a recovery path. */
const terminalAdapter = (onExecute: () => void): RecoveryAdapter => ({
  id: "terminal",
  version: "1",
  async preflight() {
    return {
      effect: "write",
      reversibility: "r3",
      readiness: "unsupported",
      scope: "irreversible fixture",
      resources: ["value"],
      revision: null,
      blastRadius: { count: 1, precision: "exact" },
    };
  },
  async prepare() {
    return { before: null, plan: null };
  },
  async execute() {
    onExecute();
    return { result: null, evidence: null };
  },
  async release() {},
  async reconcile() {
    return { status: "unknown" };
  },
  async recover() {
    throw new Error("no inverse for an r3 effect.");
  },
});

test("two workers sharing one account cannot both spend the last unit", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "void-shared-budget-"));
  const budgetFile = join(dir, "budget.sqlite");
  const stores: Array<{ close?: () => unknown }> = [];
  t.after(async () => {
    for (const store of stores) await store.close?.();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const signer = await devKeyProvider({ dir: join(dir, "keys"), env: {} });
  const key = randomBytes(32);
  let dispatches = 0;
  const adapter = terminalAdapter(() => {
    dispatches++;
  });
  // Separate journal directories are what makes these two workers: each one's
  // journal derivation sees nothing of the other's, so the only thing that
  // can refuse the second dispatch is the shared account.
  const worker = async (name: string) => {
    const store = await sqliteBudgetStore(budgetFile);
    stores.push(store);
    return {
      runtime: recoveryRuntime({
        journal: localOperationJournal(join(dir, `journal-${name}`), signer),
        vault: localRecoveryVault(join(dir, "vault"), { key }, "key"),
        adapters: [adapter],
        authorize: async () => true,
        requireRecoverable: false,
        irreversibilityBudget: { dailyLimit: 1 },
        budgetLedger: serverBudgetLedger({
          store,
          account: "shared",
          budget: { dailyLimit: 1 },
        }),
      }),
    };
  };
  const left = await worker("left"),
    right = await worker("right");
  const request = (operationId: string) => ({
    workspace: "test",
    operationId,
    agentId: "agent",
    runId: "run",
    adapterId: adapter.id,
    arguments: null,
  });
  assert.equal((await left.runtime.execute(request("op-left"))).status, "succeeded");
  assert.equal(dispatches, 1);
  // The second worker has its own journal, so the local cap still has room.
  // Only the account refuses it.
  const refused = await right.runtime.execute(request("op-right"));
  assert.equal(refused.status, "denied");
  assert.equal(dispatches, 1);
  // A reader that joined after both dispatches sees the charge either worker
  // wrote, and the version is the one both of them agreed on.
  const spend = await sqliteBudgetStore(budgetFile);
  stores.push(spend);
  const ledger = serverBudgetLedger({
    store: spend,
    account: "shared",
    budget: { dailyLimit: 1 },
  });
  assert.equal((await ledger.snapshot()).total, 1);
  assert.equal((await ledger.snapshot()).settled, 1);
  // The refusal is durable, not a race that a retry would undo.
  assert.equal((await right.runtime.execute(request("op-again"))).status, "denied");
  assert.equal(dispatches, 1);
});

test("a restarted executor does not re-observe an already dispatched irreversible charge", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "void-restart-budget-"));
  const budgetFile = join(dir, "budget.sqlite");
  const stores: Array<{ close?: () => unknown }> = [];
  let child: ReturnType<typeof fork> | undefined;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit").catch(() => []);
      child.kill("SIGKILL");
      await exited;
    }
    for (const store of stores) await store.close?.();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const key = randomBytes(32);
  const request = {
    workspace: "test",
    operationId: "op",
    agentId: "agent",
    runId: "run",
    adapterId: "terminal",
    arguments: null,
  };
  const worker = join(dir, "worker.mjs");
  await writeFile(
    worker,
    `
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {devKeyProvider} from ${JSON.stringify(SIGN_MODULE)};
import {recoveryRuntime,localOperationJournal,localRecoveryVault,serverBudgetLedger,sqliteBudgetStore} from ${JSON.stringify(RUNTIME_MODULE)};
const root=process.env.TEST_ROOT,signer=await devKeyProvider({dir:join(root,'keys'),env:{}});
const adapter={id:'terminal',version:'1',async preflight(){return {effect:'write',reversibility:'r3',readiness:'unsupported',scope:'fixture',resources:['value'],revision:null,blastRadius:{count:1,precision:'exact'}}},async prepare(){return {before:null,plan:null}},async execute(){await writeFile(join(root,'effect'),'one actual effect');process.send('dispatched');await new Promise(()=>{})},async release(){},async reconcile(){return {status:'unknown'}},async recover(){throw new Error('unused')}};
await recoveryRuntime({
  journal: localOperationJournal(join(root,'journal'),signer),
  vault: localRecoveryVault(join(root,'vault'),{key:Buffer.from(process.env.TEST_KEY,'base64')},'key'),
  adapters:[adapter],
  authorize: async()=>true,
  requireRecoverable: false,
  irreversibilityBudget: {dailyLimit: 1},
  budgetLedger: serverBudgetLedger({store: await sqliteBudgetStore(join(root,'budget.sqlite')),account:'shared',budget:{dailyLimit:1}}),
}).execute(${JSON.stringify(request)});
`,
  );
  child = fork(worker, [], {
    env: { ...process.env, TEST_ROOT: dir, TEST_KEY: key.toString("base64") },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const [message] = await once(child, "message", {
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(message, "dispatched");
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  // A fresh store, no memory of the dead process: the unit it reserved before
  // dispatching is still charged, and still unfinished.
  const store = await sqliteBudgetStore(budgetFile);
  stores.push(store);
  const account = serverBudgetLedger({
    store,
    account: "shared",
    budget: { dailyLimit: 1 },
  });
  const charged = await account.snapshot();
  assert.equal(charged.total, 1);
  assert.equal(charged.reserved, 1);
  let repeats = 0;
  const adapter: RecoveryAdapter = {
    id: "terminal",
    version: "1",
    async preflight() {
      throw new Error("must not preflight again");
    },
    async prepare() {
      throw new Error("must not prepare again");
    },
    async execute() {
      repeats++;
      throw new Error("must not execute again");
    },
    async release() {},
    async reconcile() {
      return { status: "unknown" };
    },
    async recover() {
      throw new Error("unused");
    },
  };
  const restart = async (adapters: readonly RecoveryAdapter[]) =>
    recoveryRuntime({
      journal: localOperationJournal(
        join(dir, "journal"),
        await devKeyProvider({ dir: join(dir, "keys"), env: {} }),
      ),
      vault: localRecoveryVault(join(dir, "vault"), { key }, "key"),
      adapters,
      authorize: async () => true,
      requireRecoverable: false,
      budgetLedger: serverBudgetLedger({
        store: await sqliteBudgetStore(budgetFile),
        account: "shared",
        budget: { dailyLimit: 1 },
      }),
    });
  assert.equal(
    (await (await restart([adapter])).execute(request)).status,
    "unknown",
  );
  assert.equal(repeats, 0);
  assert.equal(await readFile(join(dir, "effect"), "utf8"), "one actual effect");
  // Reconciling the restarted executor must not move the dead process's hold
  // either: a charge it cannot prove is not a charge it may hand back. A
  // release would drop the total to zero, which is the whole failure.
  const afterRestart = await account.snapshot();
  assert.equal(afterRestart.total, 1);
  assert.equal(afterRestart.reserved, 1);
  assert.equal(afterRestart.settled, 0);
  // And the cap the dead process left behind still refuses a new dispatch,
  // through a worker that is perfectly willing to dispatch it.
  const next = await (await restart([terminalAdapter(() => {})])).execute({
    ...request,
    operationId: "op-next",
  });
  assert.equal(next.status, "denied");
  assert.equal(await readFile(join(dir, "effect"), "utf8"), "one actual effect");
  assert.equal((await account.snapshot()).total, 1);
});

test("an account that cannot be trusted is an incident, not a failed operation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "void-budget-incident-"));
  const budgetFile = join(dir, "budget.sqlite");
  const open: Array<() => void> = [];
  t.after(async () => {
    for (const close of open) close();
    await rm(dir, { recursive: true, force: true });
  });
  const signer = await devKeyProvider({ dir: join(dir, "keys"), env: {} });
  const key = randomBytes(32);
  const store = await sqliteBudgetStore(budgetFile);
  open.push(() => store.close?.());
  const adapter = terminalAdapter(() => {});
  const runtime = recoveryRuntime({
    journal: localOperationJournal(join(dir, "journal"), signer),
    vault: localRecoveryVault(join(dir, "vault"), { key }, "key"),
    adapters: [adapter],
    authorize: async () => true,
    requireRecoverable: false,
    // A local cap as well, so the first dispatch is admitted whether or not
    // the shared account is wired. The case under test is the second one.
    irreversibilityBudget: { dailyLimit: 4 },
    budgetLedger: serverBudgetLedger({
      store,
      account: "shared",
      budget: { dailyLimit: 4 },
    }),
  });
  const request = {
    workspace: "test",
    operationId: "op",
    agentId: "agent",
    runId: "run",
    adapterId: adapter.id,
    arguments: null,
  };
  assert.equal((await runtime.execute(request)).status, "succeeded");
  const raw = new DatabaseSync(budgetFile);
  open.push(() => raw.close());
  raw.prepare("UPDATE void_budget_day SET body = ?").run("{not json");
  // A torn account must be reported, not absorbed into a `failed` operation:
  // the caller has to treat it as an incident, and a second operation must
  // not be dispatched against an account nobody can read.
  await assert.rejects(
    () => runtime.execute({ ...request, operationId: "op-second" }),
    BudgetStateError,
  );
  assert.equal(await runtime.status("test", "op-second"), undefined);
});
