import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { decide, loadPolicy, policyDigest } from "../../../policy/src/index.ts";
import { readLedgerReason } from "../../../ledger/src/attribution.ts";
import { readLedgerFeed } from "../../../ledger/src/feed.ts";
import { devKeyProvider } from "../../../ledger/src/sign.ts";
import { jsonlStore } from "../../../ledger/src/store.ts";

import { interceptCall, type InterceptedCall, type LedgerEntryInput } from "./tools.ts";

const call: InterceptedCall = {
  tool: "postgres.row.delete",
  connector: "postgres",
  args: { table: "accounts" },
};

const RULES = `
version: 1
rules:
  - match: { class: r0 }
    decision: allow
    rationale: reads are reversible
  - match: { class: r1 }
    decision: allow
  - match: { class: r2 }
    decision: hold
    seconds: 60
    notify: [cli]
    rationale: needs a human
  - match: {}
    decision: deny
    rationale: unclassified destructive call
`;

function loaded() {
  const policy = loadPolicy(RULES);
  if (!policy.ok) throw new Error("fixture policy must load");
  return policy;
}

const classified = (tone: "r0" | "r1" | "r2" | "r3") =>
  ({ outcome: "classified", entryId: call.tool, caseIndex: 0, tone, reason: "matched" }) as const;

async function record(
  tone: "r0" | "r1" | "r2" | "r3",
): Promise<LedgerEntryInput[]> {
  const written: LedgerEntryInput[] = [];
  const policy = loaded();
  await interceptCall(call, {
    classify: () => classified(tone),
    policy: (policyCall) => decide(policy, policyCall),
    policyDigest: () => policyDigest(policy.policy),
    hold: async (seconds) => ({
      id: "h1",
      outcome: { kind: "released", release: { kind: "approved" } },
      call: {
        id: "h1",
        tool: call.tool,
        klass: "r2",
        blastRadius: 12,
        ruleIndex: 2,
        rationale: "needs a human",
        args: call.args,
        heldAt: 1,
        expiresAt: 1 + seconds * 1000,
        notify: ["cli"],
      },
    }),
    ledger: (entry) => {
      written.push(entry);
    },
  });
  return written;
}

test("a denied call records which policy and which rule said no, on every record it writes", async () => {
  const policy = loaded();
  const written = await record("r3");
  const expected = {
    policyDigest: policyDigest(policy.policy),
    rule: { index: 3, rationale: "unclassified destructive call" },
  };
  // Both the decision record and the resolved one: a reviewer reading either
  // must reach the same reason, and a crash between them leaves the first.
  assert.equal(written.length, 2);
  for (const entry of written) assert.deepEqual(entry.attribution, expected);
});

test("an allowed call records the rule that authorized it", async () => {
  const written = await record("r0");
  assert.deepEqual(written[0]?.attribution, {
    policyDigest: policyDigest(loaded().policy),
    rule: { index: 0, rationale: "reads are reversible" },
  });
});

test("an allow whose rule states no rationale records the rule and not a rationale", async () => {
  const written = await record("r1");
  assert.deepEqual(written[0]?.attribution, {
    policyDigest: policyDigest(loaded().policy),
    rule: { index: 1 },
  });
  // The absence is in the record, not in a field set to something empty.
  assert.ok(!("rationale" in (written[0]?.attribution?.rule ?? {})));
});

test("a held call records the hold rule before and after the human answers", async () => {
  const written = await record("r2");
  assert.equal(written[0]?.decision, "hold");
  assert.deepEqual(written[0]?.attribution, {
    policyDigest: policyDigest(loaded().policy),
    rule: { index: 2, rationale: "needs a human" },
  });
  assert.deepEqual(written[1]?.attribution, written[0]?.attribution);
});

test("a host with no policy to name writes no attribution at all", async () => {
  const written: LedgerEntryInput[] = [];
  await interceptCall(call, {
    classify: () => classified("r3"),
    policy: () => ({ kind: "deny", ruleIndex: 0, rationale: "denied" }),
    hold: async () => {
      throw new Error("hold should not run");
    },
    ledger: (entry) => {
      written.push(entry);
    },
  });
  for (const entry of written) {
    assert.equal(entry.attribution, undefined);
    // Not an empty one. A record that named no policy must not carry a
    // policy field, or a reader cannot tell it apart from a broken record.
    assert.ok(!("attribution" in entry));
  }
});

test("what the proxy writes, a third party reads back and re-derives", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nomo-proxy-attribution-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const key = await devKeyProvider({ dir: join(dir, "keys"), env: {} });
  const store = jsonlStore(key, { dir });
  const policy = loaded();

  await interceptCall(call, {
    classify: () => classified("r3"),
    policy: (policyCall) => decide(policy, policyCall),
    policyDigest: () => policyDigest(policy.policy),
    hold: async () => {
      throw new Error("hold should not run");
    },
    ledger: async (entry) => {
      await store.append({ ...entry, workspace: "ws" });
    },
  });

  assert.deepEqual(await store.verify("ws"), { ok: true, checked: 2 });
  const page = await readLedgerFeed(join(dir, "ws.jsonl"), {
    publicKey: (id) => key.publicKey(id),
  });
  const first = page.records[0]!;
  // The reason survives the whole chain, and the reader is told which policy
  // to go and obtain.
  assert.equal(first.attribution?.policyDigest, policyDigest(policy.policy));
  assert.equal(first.attribution?.rule?.index, 3);
  assert.equal(first.attribution?.rule?.rationale, "unclassified destructive call");
  // And the same value comes out of an independent read of the stored body.
  const stored = [...(await collectRaw(dir, "ws"))];
  assert.equal(
    readLedgerReason(JSON.parse(stored[0]!).body, 1).kind,
    "attributed",
  );
});

async function collectRaw(dir: string, workspace: string): Promise<string[]> {
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(join(dir, `${workspace}.jsonl`), "utf8");
  return text.split("\n").filter((line) => line !== "");
}
