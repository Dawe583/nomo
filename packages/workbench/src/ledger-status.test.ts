import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { isolatedWorkbench } from "./test-fixture.ts";
import type { JsonlEntry } from "../../ledger/src/store.ts";

const models = () => Response.json({ data: [{ id: "fixture" }] });
const response = () =>
  Response.json({
    choices: [
      { message: { role: "assistant", content: "Done" }, finish_reason: "stop" },
    ],
  });

/**
 * Two settled turns, so the workspace chain holds at least two records.
 *
 * Each turn calls one read class tool. A turn that only answers writes no
 * ledger record, so the chain would stay empty and every assertion below
 * would pass against a workbench that recorded nothing.
 */
async function twoRecordChain(t: test.TestContext) {
  let turn = 0;
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/models")) return models();
    turn += 1;
    if (turn % 2 === 1) {
      const request = JSON.parse(String(init?.body)) as {
        tools: Array<{ function: { name: string; description: string } }>;
      };
      const tool = request.tools.find((item) =>
        String(item.function.description).startsWith("void_workspace_list:"),
      );
      assert.ok(tool, "the default profile must offer the workspace list tool");
      return Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `list-${turn}`,
                  type: "function",
                  function: { name: tool.function.name, arguments: "{}" },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      });
    }
    return response();
  };
  const f = await isolatedWorkbench(t, fetcher, {}, {
    prefix: "nomo-ledger-status-",
  });
  const session = await f.app.start("One", "fixture");
  await f.app.settled();
  f.app.send(session.id, "Two");
  await f.app.settled();
  const evidence =
    (f.app as unknown as { evidence: Record<string, JsonlEntry[]> }).evidence[
      session.workspace
    ] ?? [];
  assert.ok(
    evidence.length >= 2,
    `the fixture must sign at least two records, got ${evidence.length}`,
  );
  return { f, session, evidence };
}

test("a corrupt record keeps its own verdict and does not hide the rest", async (t) => {
  const { f, session, evidence } = await twoRecordChain(t);
  // Tamper with the first record's body in memory. Its digest no longer
  // matches, while every later record still points at the digest it was
  // written against.
  const first = evidence[0]!;
  evidence[0] = {
    ...first,
    body: {
      ...(first.body as Record<string, unknown>),
      decision: "allow:tampered",
    },
  };

  const status = await f.app.ledgerStatus(session.workspace);
  assert.ok(status);
  assert.equal(status.result.ok, false);
  assert.equal(status.records.length, evidence.length);
  assert.equal(status.records[0]!.status, "corrupt");
  assert.match(status.records[0]!.reason!, /does not hash to its stored digest/);
  assert.equal(status.records[0]!.id, `${session.workspace}:${first.seq}`);
  for (const record of status.records.slice(1))
    assert.equal(record.status, "verified");
  assert.ok(status.verification);

  // The strict read keeps its guarantee: this workspace is refused whole.
  await assert.rejects(
    f.app.ledger(session.workspace),
    /ledger signature verification failed/,
  );

  const byId = await f.app.verifyRecord(
    session.workspace,
    `${session.workspace}:${first.seq}`,
  );
  assert.equal(byId?.status, "corrupt");
  const bySeq = await f.app.verifyRecord(session.workspace, evidence[1]!.seq);
  assert.equal(bySeq?.status, "verified");
});

test("a missing verification key yields unverified records, not a failed read", async (t) => {
  const { f, session, evidence } = await twoRecordChain(t);
  // The workbench signed with a key under its own directory. Removing it
  // leaves the records in place and no key to check them with, which is the
  // state a surface must still be able to render.
  await rm(join(f.root, "keys"), { recursive: true, force: true });

  const status = await f.app.ledgerStatus(session.workspace);
  assert.ok(status);
  assert.equal(status.verification, undefined);
  assert.match(status.keyError!, /verification key/i);
  assert.equal(status.records.length, evidence.length);
  assert.deepEqual(
    status.records.map((record) => record.status),
    evidence.map(() => "unverified"),
  );
  assert.equal(status.result.ok, false);
});

test("an unmanaged workspace has no status and no record", async (t) => {
  const { f } = await twoRecordChain(t);

  assert.equal(await f.app.ledgerStatus("no-such-workspace"), undefined);
  assert.equal(
    await f.app.verifyRecord("no-such-workspace", "no-such-workspace:1"),
    undefined,
  );
});
