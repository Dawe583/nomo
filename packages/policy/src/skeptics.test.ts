import test, { describe } from "node:test";
import assert from "node:assert/strict";

import { decide } from "./decide.ts";
import { HoldQueue, verifiedLocalOperatorId } from "./hold.ts";
import type { PolicyCall } from "./decide.ts";
import type { HeldCall, HoldResolution, Release } from "./hold.ts";
import type { LoadedPolicy } from "./rules.ts";

const call = (over: Partial<PolicyCall> = {}): PolicyCall => ({
  tool: "postgres.row.delete",
  connector: "postgres",
  workspace: "sandbox",
  klass: "r1",
  blastRadius: 12,
  ...over,
});

const baseCall = (over: Partial<Omit<HeldCall, "id" | "heldAt" | "expiresAt">> = {}): Omit<HeldCall, "id" | "heldAt" | "expiresAt"> => ({
  tool: "postgres.row.delete",
  klass: "r1",
  blastRadius: 41883,
  ruleIndex: 2,
  rationale: "a human must see the blast radius first",
  args: { table: "orders", where: "status = draft" },
  notify: ["cli"],
  ...over,
});

const approveAs = (queue: HoldQueue, id: string, release: Release, caller: string): boolean => {
  const carried = { ...release, by: caller } as Release & { readonly by: string };
  return queue.resolve(id, carried);
};

const assertReleased = (resolution: HoldResolution): Release => {
  assert.equal(resolution.outcome.kind, "released");
  if (resolution.outcome.kind !== "released") throw new Error("unreachable");
  return resolution.outcome.release;
};

describe("a rule that never matches", () => {
  test("an unmatched decision holds closed when the catch-all is gone mid-flight", () => {
    const policy: LoadedPolicy = {
      ok: true,
      policy: {
        version: 1,
        rules: [
          {
            match: { tool: "postgres.table.drop" },
            decision: "deny",
            rationale: "dropping tables needs a separate path",
          },
        ],
      },
    };

    const decision = decide(policy, call({ tool: "postgres.row.delete" }));
    assert.equal(decision.kind, "unmatched");
    if (decision.kind === "unmatched") assert.equal(decision.decision, "hold");
  });
});

describe("a hold that expires during a proxy restart", () => {
  test("close drains parked promises without delivering expiry events", async () => {
    const expired: HoldResolution[] = [];
    const queue = new HoldQueue((resolution) => {
      expired.push(resolution);
    });
    const first = queue.hold(baseCall({ tool: "postgres.row.delete" }), 300);
    const second = queue.hold(baseCall({ tool: "postgres.row.update" }), 300);

    const drained = queue.close();
    const resolutions = await Promise.all([first, second]);

    assert.equal(drained.length, 2);
    assert.deepEqual(resolutions.map((resolution) => resolution.outcome.kind), ["expired", "expired"]);
    assert.deepEqual(drained.map((resolution) => resolution.outcome.kind), ["expired", "expired"]);
    assert.deepEqual(queue.list(), []);
    assert.deepEqual(expired, []);

    const restarted = new HoldQueue();
    assert.deepEqual(restarted.list(), []);
    restarted.close();

    assert.throws(() => queue.hold(baseCall(), 1), /closed/);
  });
});

describe("two holds resolving out of order", () => {
  test("each promise resolves with its own call and insertion order stays stable", async () => {
    const queue = new HoldQueue();
    const first = queue.hold(baseCall({ tool: "postgres.row.delete", args: { table: "orders" } }), 120);
    const second = queue.hold(baseCall({ tool: "postgres.row.update", args: { table: "users" } }), 120);
    const listed = queue.list();

    assert.deepEqual(listed.map((held) => held.id), ["h0001", "h0002"]);
    assert.deepEqual(listed.map((held) => held.tool), ["postgres.row.delete", "postgres.row.update"]);

    assert.equal(queue.resolve("h0002", { kind: "denied", by: "cli" }), true);
    const secondResolution = await second;
    assert.equal(secondResolution.id, "h0002");
    assert.equal(secondResolution.call.id, "h0002");
    assert.equal(secondResolution.call.tool, "postgres.row.update");
    assert.deepEqual(secondResolution.call.args, { table: "users" });
    assert.deepEqual(queue.list().map((held) => held.id), ["h0001"]);

    assert.equal(queue.resolve("h0001", { kind: "approved" }), true);
    const firstResolution = await first;
    assert.equal(firstResolution.id, "h0001");
    assert.equal(firstResolution.call.id, "h0001");
    assert.equal(firstResolution.call.tool, "postgres.row.delete");
    assert.deepEqual(firstResolution.call.args, { table: "orders" });

    queue.close();
  });
});

describe("caller supplied approval identity", () => {
  test("an unbound approval drops an untrusted operator label", async () => {
    const queue = new HoldQueue();
    const waiting = queue.hold(baseCall(), 120);

    assert.equal(approveAs(queue, "h0001", { kind: "approved" }, "unknown"), true);
    const release = assertReleased(await waiting);
    assert.deepEqual(release, { kind: "approved" });

    queue.close();
  });

  test("a denial records the local operator instead of a caller label", async () => {
    const queue = new HoldQueue();
    const waiting = queue.hold(baseCall(), 120);

    // A channel still authenticates before it calls resolve; the caller label is not identity evidence.
    assert.equal(approveAs(queue, "h0001", { kind: "denied", by: "stranger" }, "stranger"), true);
    const release = assertReleased(await waiting);
    assert.deepEqual(release, { kind: "denied", by: verifiedLocalOperatorId() });

    queue.close();
  });
});
