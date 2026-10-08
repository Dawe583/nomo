import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HoldQueue } from "../../policy/src/hold.ts";
import { loadPolicy } from "../../policy/src/rules.ts";
import { classifyTool } from "../../registry/src/evaluate.ts";
import { checkPolicy, type PolicyCheckRequest } from "./check.ts";
import {
  AgentHoldIndex,
  KILL_SWITCH_ACTOR,
  killAgent,
  KillSwitchError,
  reinstateAgent,
} from "./kill.ts";
import { loadAgentPolicy } from "./load.ts";
import {
  appendRevocation,
  readRevocations,
  revocationView,
  withStoreLock,
  type TokenClaims,
} from "./revocations.ts";

const agentPolicy = loadAgentPolicy(
  readFileSync(new URL("../../../policy/agents.yaml", import.meta.url), "utf8"),
);
const classPolicy = loadPolicy(`
version: 1
rules:
  - match: { class: r0 }
    decision: allow
  - match: {}
    decision: deny
`);

const at = (iso: string) => () => new Date(iso);

async function withStore(run: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "nomo-kill-"));
  try {
    // A nested path proves the first kill creates the store's directory.
    await run(join(dir, "state", "revocations.jsonl"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const parkCall = (queue: HoldQueue) =>
  queue.hold(
    {
      tool: "fs.file.delete",
      klass: "r2",
      blastRadius: 1,
      ruleIndex: 0,
      rationale: "deleting anything waits for a person",
      args: {},
      notify: [],
    },
    60,
  );

const writeDraft = (token?: TokenClaims): PolicyCheckRequest => ({
  contract: "nomo.policy-check.v0",
  requestId: "req-kill",
  agent: { id: "demo-support-bot" },
  tool: "fs.file.write",
  connector: "fs",
  args: {},
  target: "fs:sandbox/drafts/reply.md",
  scope: "write",
  workspace: "demo",
  ...(token === undefined ? {} : { token }),
});

async function checkFromDisk(
  storePath: string,
  now: Date,
  token?: TokenClaims,
) {
  return checkPolicy(writeDraft(token), {
    agentPolicy,
    classPolicy,
    classify: () =>
      classifyTool("fs.file.write", {
        facts: { "fs.shadow.captured": "true" },
        args: {},
      }),
    revocations: revocationView(await readRevocations(storePath)),
    now: () => now,
    requireToken: token !== undefined,
  });
}

const tokenIssuedAt = (iso: string): TokenClaims => {
  const iat = Math.floor(Date.parse(iso) / 1000);
  return {
    jti: `tok-${iat}`,
    agentId: "demo-support-bot",
    tool: "fs.file.write",
    target: "fs:sandbox/drafts/reply.md",
    scope: "write",
    workspace: "demo",
    iat,
    exp: iat + 60,
    agentPolicyDigest: "",
  };
};

describe("kill-switch", () => {
  test("a kill denies the next check and the agent's pending holds, and only those", async () =>
    withStore(async (storePath) => {
      const before = await checkFromDisk(
        storePath,
        new Date("2026-10-08T10:00:00Z"),
      );
      assert.equal(before.decision, "allow");

      const queue = new HoldQueue();
      const index = new AgentHoldIndex();
      const supportHold = parkCall(queue);
      const otherHold = parkCall(queue);
      const [supportId, otherId] = queue.list().map((call) => call.id);
      index.track(supportId!, "demo-support-bot");
      index.track(otherId!, "demo-report-bot");

      const result = await killAgent({
        storePath,
        agentId: "demo-support-bot",
        by: "oliver",
        reason: "demo",
        now: at("2026-10-08T10:00:05Z"),
        holds: {
          index,
          deny: (holdId, by) => queue.resolve(holdId, { kind: "denied", by }),
        },
      });
      assert.equal(result.wasKilled, false);
      assert.deepEqual(result.deniedHolds, [supportId]);
      assert.deepEqual(result.record, {
        kind: "kill",
        agentId: "demo-support-bot",
        at: "2026-10-08T10:00:05.000Z",
        by: "oliver",
        reason: "demo",
      });

      const resolution = await supportHold;
      assert.deepEqual(resolution.outcome, {
        kind: "released",
        release: { kind: "denied", by: KILL_SWITCH_ACTOR },
      });
      assert.deepEqual(
        queue.list().map((call) => call.id),
        [otherId],
      );
      assert.deepEqual(index.holdsOf("demo-support-bot"), []);
      assert.deepEqual(index.holdsOf("demo-report-bot"), [otherId]);

      const after = await checkFromDisk(
        storePath,
        new Date("2026-10-08T10:00:06Z"),
      );
      assert.equal(after.decision, "deny");
      assert.equal(after.ruleId, "nomo:kill-switch");
      assert.equal(after.layer, "kill-switch");

      queue.close();
      await otherHold;
    }));

  test("a reinstate lets new tokens through and keeps old ones dead", async () =>
    withStore(async (storePath) => {
      await killAgent({
        storePath,
        agentId: "demo-support-bot",
        by: "oliver",
        reason: "demo",
        now: at("2026-10-08T10:00:05Z"),
      });
      await reinstateAgent({
        storePath,
        agentId: "demo-support-bot",
        by: "oliver",
        reason: "fixed the prompt",
        now: at("2026-10-08T10:00:20Z"),
      });

      const old = await checkFromDisk(
        storePath,
        new Date("2026-10-08T10:00:30Z"),
        tokenIssuedAt("2026-10-08T10:00:00Z"),
      );
      assert.equal(old.decision, "deny");
      assert.equal(old.ruleId, "nomo:token-revoked");

      const fresh = await checkFromDisk(
        storePath,
        new Date("2026-10-08T10:00:30Z"),
        tokenIssuedAt("2026-10-08T10:00:25Z"),
      );
      assert.equal(fresh.decision, "allow");
    }));

  test("a second kill is recorded and reports the agent was already killed", async () =>
    withStore(async (storePath) => {
      const input = {
        storePath,
        agentId: "demo-support-bot",
        by: "oliver",
        reason: "",
      };
      await killAgent(input);
      const again = await killAgent(input);
      assert.equal(again.wasKilled, true);
      assert.equal((await readRevocations(storePath)).length, 2);
    }));

  test("a corrupt store never blocks a kill, and always blocks a reinstate", async () =>
    withStore(async (storePath) => {
      await killAgent({
        storePath,
        agentId: "demo-report-bot",
        by: "oliver",
        reason: "",
      });
      await writeFile(storePath, "not json\n", { flag: "a" });

      const result = await killAgent({
        storePath,
        agentId: "demo-support-bot",
        by: "oliver",
        reason: "",
      });
      assert.equal(result.wasKilled, null);
      assert.match(await readFile(storePath, "utf8"), /demo-support-bot/);

      await assert.rejects(
        reinstateAgent({
          storePath,
          agentId: "demo-support-bot",
          by: "oliver",
          reason: "try anyway",
        }),
        /revocations line 2: not JSON/,
      );
    }));

  test("a reinstate needs a killed agent and a reason", async () =>
    withStore(async (storePath) => {
      const input = {
        storePath,
        agentId: "demo-support-bot",
        by: "oliver",
        reason: "never killed",
      };
      await assert.rejects(reinstateAgent(input), /is not killed/);
      await killAgent(input);
      await assert.rejects(
        reinstateAgent({ ...input, reason: " " }),
        /needs a reason/,
      );
    }));

  test("bad input is refused before anything is written", async () =>
    withStore(async (storePath) => {
      await assert.rejects(
        killAgent({ storePath, agentId: "Bad Id", by: "oliver", reason: "" }),
        KillSwitchError,
      );
      await assert.rejects(
        killAgent({ storePath, agentId: "demo-support-bot", by: " ", reason: "" }),
        /operator/,
      );
      assert.deepEqual(await readRevocations(storePath), []);
    }));

  test("a denier that throws does not stop the sweep, and its hold is retried by the next kill", async () =>
    withStore(async (storePath) => {
      const index = new AgentHoldIndex();
      for (const id of ["h1", "h2", "h3"]) index.track(id, "demo-support-bot");
      const denied: string[] = [];
      const input = {
        storePath,
        agentId: "demo-support-bot",
        by: "oliver",
        reason: "",
      };

      const first = await killAgent({
        ...input,
        holds: {
          index,
          deny: (holdId) => {
            if (holdId === "h2") throw new Error("queue closed under us");
            denied.push(holdId);
            return true;
          },
        },
      });
      assert.deepEqual(first.deniedHolds, ["h1", "h3"]);
      assert.deepEqual(first.failedHolds, ["h2"]);
      assert.deepEqual(denied, ["h1", "h3"]);
      assert.deepEqual(index.holdsOf("demo-support-bot"), ["h2"]);

      const second = await killAgent({
        ...input,
        holds: { index, deny: () => true },
      });
      assert.deepEqual(second.deniedHolds, ["h2"]);
      assert.deepEqual(second.failedHolds, []);
      assert.deepEqual(index.holdsOf("demo-support-bot"), []);
    }));

  test("an invalid clock is a KillSwitchError and writes nothing", async () =>
    withStore(async (storePath) => {
      const input = {
        storePath,
        agentId: "demo-support-bot",
        by: "oliver",
        reason: "clock",
      };
      for (const now of [() => new Date(Number.NaN), () => "soon" as never]) {
        await assert.rejects(killAgent({ ...input, now }), KillSwitchError);
        await assert.rejects(stat(storePath), { code: "ENOENT" });
      }
      await killAgent({ ...input, now: at("2026-10-08T10:00:00Z") });
      await assert.rejects(
        reinstateAgent({ ...input, now: () => new Date(Number.NaN) }),
        (error) =>
          error instanceof KillSwitchError && /invalid time/.test(error.message),
      );
      assert.equal((await readRevocations(storePath)).length, 1);
    }));

  test("a reinstate cannot predate the agent's last record", async () =>
    withStore(async (storePath) => {
      const input = {
        storePath,
        agentId: "demo-support-bot",
        by: "oliver",
        reason: "clock skew",
      };
      await killAgent({ ...input, now: at("2026-10-08T10:00:05Z") });
      await assert.rejects(
        reinstateAgent({ ...input, now: at("2026-10-08T10:00:00Z") }),
        /behind the agent's last record/,
      );
      assert.equal((await readRevocations(storePath)).length, 1);
      // The same instant is not behind it.
      await reinstateAgent({ ...input, now: at("2026-10-08T10:00:05Z") });
    }));
});

describe("kill-switch store lock", () => {
  const input = (storePath: string) => ({
    storePath,
    agentId: "demo-support-bot",
    by: "oliver",
    reason: "race",
  });
  const tick = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  test("a reinstate checks the store again under the lock, so a write it did not see stops it", async () =>
    withStore(async (storePath) => {
      await killAgent(input(storePath));
      let pending: Promise<unknown> | undefined;
      await withStoreLock(storePath, async () => {
        // Passes the unlocked pre-check, then waits for this lock.
        pending = reinstateAgent(input(storePath)).catch((error) => error);
        await tick(50);
        // Another operator lifts the kill while the first reinstate waits.
        await appendRevocation(storePath, {
          kind: "reinstate",
          agentId: "demo-support-bot",
          at: new Date().toISOString(),
          by: "max",
          reason: "first",
        });
      });
      const outcome = await pending;
      assert.ok(outcome instanceof KillSwitchError);
      assert.match(outcome.message, /is not killed/);
      assert.deepEqual(
        (await readRevocations(storePath)).map((r) => r.kind),
        ["kill", "reinstate"],
      );
    }));

  test("a reinstate never lifts a kill that landed while it waited", async () =>
    withStore(async (storePath) => {
      await killAgent(input(storePath));
      let pending: Promise<unknown> | undefined;
      await withStoreLock(storePath, async () => {
        pending = reinstateAgent(input(storePath)).catch((error) => error);
        await tick(50);
        await appendRevocation(storePath, {
          kind: "kill",
          agentId: "demo-support-bot",
          at: new Date().toISOString(),
          by: "max",
          reason: "second, independent kill",
        });
      });
      const outcome = await pending;
      assert.ok(outcome instanceof KillSwitchError);
      assert.match(outcome.message, /killed again while this reinstate waited/);
      const records = await readRevocations(storePath);
      assert.deepEqual(
        records.map((r) => `${r.kind}/${r.by}`),
        ["kill/oliver", "kill/max"],
      );
      assert.equal(revocationView(records).isKilled("demo-support-bot"), true);
    }));

  test("a kill waits for the writer holding the lock instead of slipping between its read and its append", async () =>
    withStore(async (storePath) => {
      await killAgent(input(storePath));
      let killed: ReturnType<typeof killAgent> | undefined;
      await withStoreLock(storePath, async () => {
        const before = await readRevocations(storePath);
        killed = killAgent({ ...input(storePath), agentId: "demo-report-bot" });
        await tick(50);
        assert.deepEqual(await readRevocations(storePath), before);
        await appendRevocation(storePath, {
          kind: "reinstate",
          agentId: "demo-support-bot",
          at: new Date().toISOString(),
          by: "oliver",
          reason: "inside the lock",
        });
      });
      assert.equal((await killed!).lockTimedOut, false);
      assert.deepEqual(
        (await readRevocations(storePath)).map((r) => `${r.kind}:${r.agentId}`),
        [
          "kill:demo-support-bot",
          "reinstate:demo-support-bot",
          "kill:demo-report-bot",
        ],
      );
      await assert.rejects(stat(`${storePath}.lock`), { code: "ENOENT" });
    }));

  test("a lock that stays held never blocks a kill, and always blocks a reinstate", async () =>
    withStore(async (storePath) => {
      await killAgent(input(storePath));
      await writeFile(`${storePath}.lock`, "someone else", "utf8");

      const result = await killAgent({
        ...input(storePath),
        lock: { waitMs: 30 },
      });
      assert.equal(result.lockTimedOut, true);
      assert.equal((await readRevocations(storePath)).length, 2);

      await assert.rejects(
        reinstateAgent({ ...input(storePath), lock: { waitMs: 30 } }),
        /locked by another writer; nothing was recorded/,
      );
      assert.equal((await readRevocations(storePath)).length, 2);
      // Not ours, so it is left alone.
      assert.equal(await readFile(`${storePath}.lock`, "utf8"), "someone else");
    }));

  test("a lock left by a dead writer is broken once it is stale", async () =>
    withStore(async (storePath) => {
      await killAgent(input(storePath));
      const lockPath = `${storePath}.lock`;
      await writeFile(lockPath, "dead writer", "utf8");
      const minuteAgo = new Date(Date.now() - 60_000);
      await utimes(lockPath, minuteAgo, minuteAgo);

      await reinstateAgent({ ...input(storePath), lock: { waitMs: 30 } });
      assert.equal(
        revocationView(await readRevocations(storePath)).isKilled(
          "demo-support-bot",
        ),
        false,
      );
      await assert.rejects(stat(lockPath), { code: "ENOENT" });
    }));
});
