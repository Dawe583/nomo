import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import { DEFAULT_POLICY } from "./index.ts";
import { isolatedWorkbench } from "./test-fixture.ts";
import { LocalStorage } from "./storage.ts";
import { loadPolicy } from "../../policy/src/rules.ts";
import { policyDigest } from "../../policy/src/digest.ts";
import type { JsonlEntry } from "../../ledger/src/store.ts";
import type { LedgerAttribution } from "../../ledger/src/attribution.ts";

const MODEL = "fixture-model";
const PROFILE = "attribution-fixture";

type Body = Record<string, unknown>;

/**
 * One session, one governed document write, one operator approval and one
 * undo. Everything the workbench decides in that sequence has to name the
 * policy, the rule, the model and the request on the record itself, and the
 * undo has to name the record it inverts.
 */
async function governedSession(t: test.TestContext) {
  let turn = 0;
  const fetcher: typeof fetch = async (url, options) => {
    if (String(url).endsWith("/models"))
      return Response.json({ data: [{ id: MODEL }] });
    turn += 1;
    if (turn === 1) {
      const request = JSON.parse(String(options?.body));
      const tool = request.tools.find(
        (item: { function: { description: string } }) =>
          item.function.description.startsWith("void_workspace_write:"),
      );
      assert.ok(tool, "the profile must offer the document write tool");
      return Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "write-1",
                  type: "function",
                  function: {
                    name: tool.function.name,
                    arguments: JSON.stringify({ path: "plan.md", content: "Attributed." }),
                  },
                },
              ],
            },
          },
        ],
      });
    }
    return Response.json({
      choices: [{ message: { role: "assistant", content: "Written." } }],
      usage: { total_tokens: 7 },
    });
  };
  const f = await isolatedWorkbench(t, fetcher, {}, { prefix: "void-reversal-record-" });
  const app = f.app;
  app.upsertAgent({
    id: PROFILE,
    name: "Attribution fixture",
    systemPrompt: "Write the requested document.",
    allowedTools: ["void_workspace_write"],
    policyProfile: "default",
    maxTurns: 4,
    maxContextTokens: 131_072,
  });
  const session = await app.start("Write the plan.", MODEL, undefined, undefined, PROFILE);
  // The default policy holds every class above r0, so the governed call
  // waits for an operator exactly the way a destructive one would.
  for (let poll = 0; poll < 200 && app.pending().length === 0; poll += 1) await delay(10);
  const hold = app.pending()[0];
  assert.ok(hold, "the governed call must reach an operator");
  app.decide(hold.holdId, { kind: "approved", by: "fixture-operator" });
  for (let poll = 0; poll < 400 && app.get(session.id)?.status === "running"; poll += 1)
    await delay(10);
  assert.equal(app.get(session.id)?.status, "idle", "the approved turn must settle");
  return {
    directory: f.root,
    get app() {
      return f.app;
    },
    session,
    restart() {
      return f.restart({ keepOpen: true });
    },
  };
}

test("a governed workbench record names the policy, the rule, the model and the request", async (t) => {
  const f = await governedSession(t);
  const evidence = await f.app.ledger(f.session.workspace);
  assert.ok(evidence);
  assert.equal(evidence.result.ok, true);

  const loaded = loadPolicy(DEFAULT_POLICY);
  assert.ok(loaded.ok);
  const expected = policyDigest(loaded.policy);

  const decided = (evidence.entries as JsonlEntry[])
    .map((entry) => entry.body as Body)
    .filter(
      (entry) =>
        entry.tool === "void_workspace_write" &&
        typeof entry.decision === "string" &&
        entry.decision.startsWith("hold"),
    );
  assert.ok(decided.length >= 2, "the held call and its resolution are both recorded");

  for (const body of decided) {
    const attribution = body.attribution as LedgerAttribution | undefined;
    assert.ok(attribution, `record ${String(body.decision)} carries no attribution`);
    assert.equal(attribution.policyDigest, expected);
    assert.equal(attribution.modelId, MODEL);
    assert.match(attribution.requestDigest ?? "", /^[0-9a-f]{64}$/);
    assert.equal(attribution.rule?.index, 1, "the catch-all hold rule is index 1");
  }
});

test("an undo names the record it inverts, and the chain still verifies", async (t) => {
  const f = await governedSession(t);
  const operation = f.app.workspace(f.session.id).operations[0]!;
  const before = await f.app.ledger(f.session.workspace);
  const forward = (before!.entries as JsonlEntry[]).find(
    (entry) => (entry.body as Body).operationId === operation.id,
  );
  assert.ok(forward, "the forward record must be in the chain");

  await f.app.undo(f.session.id, operation.id, "tui-operator");
  assert.deepEqual(f.app.workspace(f.session.id).files, {});

  const after = await f.app.ledger(f.session.workspace);
  assert.equal(after!.result.ok, true);
  const undo = (after!.entries as JsonlEntry[])
    .map((entry) => entry.body as Body)
    .filter((body) => body.tool === "void_workspace_undo");
  assert.equal(undo.length, 1);
  assert.deepEqual(undo[0]!.reversal, { seq: forward.seq, digest: forward.hash });
});

test("an undo whose forward record is not in the chain is refused", async (t) => {
  const f = await governedSession(t);
  const operation = f.app.workspace(f.session.id).operations[0]!;
  await f.app.shutdown();

  // The signed evidence is the only thing that proves a capture exists. With
  // it removed and the workspace state intact, the inverse has nothing to
  // name and must not run.
  const storage = new LocalStorage(f.directory);
  const saved = storage.read<{ evidence: Record<string, JsonlEntry[]> }>()!;
  storage.save({ ...saved, evidence: {} });
  const restarted = f.restart();

  await assert.rejects(
    restarted.undo(f.session.id, operation.id, "tui-operator"),
    /signed evidence/,
  );
  assert.equal(restarted.document(f.session.id, "plan.md").content, "Attributed.");
  const evidence = await restarted.ledger(f.session.workspace);
  assert.equal(
    (evidence!.entries as JsonlEntry[]).some(
      (entry) => (entry.body as Body).tool === "void_workspace_undo",
    ),
    false,
    "a refused undo writes no record",
  );
});
