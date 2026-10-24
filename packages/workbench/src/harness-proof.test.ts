/**
 * H7: one real agent session drives the whole harness moment end to end.
 *
 * The loop the harness spec names: a connector call is refused, the refusal
 * repeats, the miner mints the rule as evidence, an operator approves a
 * proposal whose provenance cites the chain, the activation is a signed
 * record, a rollback is itself a signed event the board counts, and the
 * chain still verifies offline with the standalone verifier.
 *
 * The transport is the real one: a fixture MCP HTTP server stands in for the
 * upstream, and the provider is a test double, because a test that needs
 * credits cannot gate anything.
 */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, type Server } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { isolatedWorkbench } from "./test-fixture.ts";
import type { Workbench, SessionView } from "./index.ts";
import { mineLearnedRules } from "./learned-rules.ts";
import { measureBoard } from "./harness-scores.ts";
import { retainedKeyProvider } from "../../ledger/src/sign.ts";
import type { JsonlEntry } from "../../ledger/src/store.ts";
import type { RefinementProposal } from "./refine-pass.ts";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "..", "..", "..");

const DELETE_TOOL = { name: "delete", description: "delete: fixture" };
const DELETE = "aws.s3.object.delete";
const connectorFacts = { "bucket.versioning": "Enabled" };
const holdAll =
  "version: 1\nrules:\n  - match:\n      tool: aws.s3.object.delete\n    decision: hold\n    seconds: 5\n    notify: [cli]\n  - match: {}\n    decision: deny\n";
const denyAll =
  "version: 1\nrules:\n  - match:\n      tool: aws.s3.object.delete\n    decision: deny\n    rationale: destructive fixture tool refuses by policy\n  - match: {}\n    decision: deny\n";

/** A minimal MCP server over loopback HTTP that counts the calls it served. */
async function catalogServer() {
  const methods: string[] = [];
  const server: Server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text || "{}");
    if (body.method) methods.push(body.method);
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: body.method === "tools/list" ? { tools: [DELETE_TOOL] } : {},
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    methods,
    url: `http://127.0.0.1:${address.port}/mcp`,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** The connector tools reach the model under an index name; the description
 * carries the real one, so the call is picked the same way every other test
 * picks its tool. The gate starts closed: seeding must not race the call. */
type CallGate = { wantCall: boolean; systemPrompts: string[] };
function calling(gate: CallGate) {
  let callCount = 0;
  return async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("/models"))
      return Response.json({ data: [{ id: "fixture" }] });
    const body = JSON.parse(String(init?.body)) as {
      tools?: { function?: { name?: string; description?: string } }[];
      messages?: { role?: string; content?: unknown }[];
    };
    gate.systemPrompts.push(
      ...(body.messages ?? [])
        .filter((message) => message.role === "system")
        .map((message) => String(message.content ?? "")),
    );
    const asked = (body.messages ?? []).some(
      (message) =>
        message.role === "user" &&
        /delete/i.test(String(message.content ?? "")),
    );
    // The provider sees the local MCP tool name in the description; the
    // registry id reaches the decision only at authorization time, so the
    // fixture picks the tool by the local name, like connector.test.ts does.
    const connector = (body.tools ?? []).find((tool) =>
      tool.function?.description?.startsWith("delete:"),
    );
    if (connector && asked && gate.wantCall) {
      gate.wantCall = false;
      return Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `held-call-${++callCount}`,
                  type: "function",
                  function: {
                    name: connector.function!.name!,
                    arguments: "{}",
                  },
                },
              ],
            },
          },
        ],
      });
    }
    return Response.json({
      choices: [{ message: { role: "assistant", content: "Ready" } }],
    });
  };
}

type Fixture = {
  app: Workbench;
  session: SessionView;
  gate: CallGate;
  connectorId: string;
};

/** A workbench on the real connector path, with one confirmed connector and
 * one settled session whose chain already holds a record to cite. */
async function fixture(t: TestContext, policy: string): Promise<Fixture> {
  const server = await catalogServer();
  t.after(() => server.close());
  const gate: CallGate = { wantCall: true, systemPrompts: [] };
  const { app } = await isolatedWorkbench(
    t,
    calling(gate) as typeof fetch,
    {},
    { prefix: "void-harness-proof-" },
  );
  await app.addConnector({
    url: server.url,
    name: "Fixture",
    mapping: { delete: DELETE },
    facts: connectorFacts,
    policy,
  });
  const connectorId = app.connectionState().connectors.at(-1)!.id;
  await app.probeConnector(connectorId);
  await app.confirmConnector(connectorId);

  const session = await app.start("Review the workspace", "fixture");
  await app.settled();
  await app.editDocument(session.id, {
    path: "source.md",
    content: "signed source record",
    expectedRevision: null,
  });
  return { app, session, gate, connectorId };
}

/** The workspace chain as record bodies, for concise decision assertions. */
function bodies(
  app: Fixture["app"],
  workspace: string,
): readonly Record<string, unknown>[] {
  const internals = app as unknown as {
    evidence: Record<string, readonly { body: unknown }[]>;
  };
  return (internals.evidence[workspace] ?? []).map(
    (entry) => entry.body as Record<string, unknown>,
  );
}

const decisionsFor = (
  records: readonly Record<string, unknown>[],
  tool: string,
) =>
  records
    .filter((body) => body.tool === tool && typeof body.decision === "string")
    .map((body) => body.decision as string);

test("H7: a refused call, a mined rule, an approved activation, a rollback and an offline verify", async (t) => {
  const { app, session, gate, connectorId } = await fixture(t, holdAll);

  // The hold appears while the turn runs. Deciding after settled() lets it expire.
  app.send(session.id, "Please delete the bucket");
  for (let poll = 0; poll < 200 && app.pending().length === 0; poll += 1)
    await delay(10);
  const holds = app.pending();
  assert.equal(holds.length, 1, "the fixture policy must hold the delete");
  assert.equal(
    app.decide(holds[0]!.holdId, {
      kind: "denied",
      by: "h7-operator",
      reason: "not yet",
    }),
    true,
  );
  await app.settled();
  assert.equal(app.get(session.id)?.status, "idle");
  assert.deepEqual(
    decisionsFor(bodies(app, session.workspace), DELETE),
    ["hold", "hold:denied"],
    "the hold decision and its outcome are both recorded",
  );

  // 2. Repeat the refused operation in the same session. A separate
  //    conversation has a separate workspace chain, so it cannot contribute
  //    to this session's learned rule.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    gate.wantCall = true;
    app.send(session.id, `Please delete the bucket, refusal ${attempt + 2}`);
    for (let poll = 0; poll < 200 && app.pending().length === 0; poll += 1)
      await delay(10);
    const nextHold = app.pending();
    assert.equal(nextHold.length, 1, "the repeated call must be held");
    assert.equal(
      app.decide(nextHold[0]!.holdId, {
        kind: "denied",
        by: "h7-operator",
        reason: "not yet",
      }),
      true,
    );
    await app.settled();
    assert.equal(app.get(session.id)?.status, "idle");
  }
  const refusals = decisionsFor(bodies(app, session.workspace), DELETE).filter(
    (decision) => decision === "hold:denied" || decision === "deny",
  );
  assert.ok(
    refusals.length >= 3,
    `three refusals are the miner's threshold, saw ${refusals.length}`,
  );

  // 3. The miner mints exactly the rule for the refused shape, and the mined
  //    entry carries provenance from the same workspace chain.
  const internals = app as unknown as {
    evidence: Record<string, readonly JsonlEntry[]>;
  };
  const chain = internals.evidence[session.workspace] ?? [];
  const mined = mineLearnedRules(chain);
  assert.equal(mined.length, 1);
  assert.deepEqual(mined[0]!.match, { class: "r3", tool: DELETE });
  assert.match(
    mined[0]!.rationale ?? "",
    /^Refused \d+ times on the signed ledger\. Not written by an operator\.$/,
  );
  const entries = await app.harnessEntries(session.workspace);
  const rule = entries.find((entry) => entry.kind === "rule");
  assert.ok(rule, "the mined rule is an entry the operator can read");
  assert.equal(rule!.repeats, 3);
  assert.ok(rule!.policyText?.length, "the rule renders as policy text");

  // 4. The operator approves a proposal that cites the chain, and the
  //    activation is a signed record.
  const lesson = (content: string): RefinementProposal => ({
    summary: "destructive delete needs a human",
    rationale: "three refusals on the signed ledger",
    expectedOutcome: "the same call shape is held again",
    edits: [
      {
        action: "create",
        kind: "memory",
        title: "delete needs a human",
        content,
        derivedFromSeq: rule!.derivedFromSeq,
        reason: "the refusal repeats",
      },
      {
        action: "create",
        kind: "memory",
        title: "verify before removal",
        content: "Check bucket versioning before deleting stored objects.",
        derivedFromSeq: rule!.derivedFromSeq,
        reason: "this is a separate, narrower check",
      },
    ],
  });
  const created = await app.refineHarness(
    session.id,
    lesson("Ask the operator before deleting a bucket."),
  );
  assert.ok(created.proposalDigest, "the proposal carries its digest");
  const pending = await app.pendingApprovalsFor(session.id);
  assert.equal(pending.length, 1);
  await app.approveHarnessProposal(session.id, pending[0]!.digest);
  const activated = (await app.ledger(session.workspace))!.entries.at(-1)!
    .body as Record<string, unknown>;
  assert.equal(activated.decision, "proposal:activated");
  app.patchHarnessSettings({ contextEntryLimit: 1 });
  gate.systemPrompts.length = 0;
  app.send(session.id, "How should deletion of this bucket be handled?");
  await app.settled();
  const digest = gate.systemPrompts.find((text) =>
    text.startsWith("NOMO learned-entry digest,"),
  );
  assert.ok(digest, "a later turn receives approved retrieval context");
  const lessonRows = digest
    .split("\n")
    .filter((line) => line.startsWith("- [lesson] "));
  assert.equal(
    lessonRows.length,
    1,
    "retrieval obeys the per-kind entry limit",
  );

  // 5. The signed workspace ledger carries one rollback. Measure the whole
  //    chain as one case because rollback is a workspace lifecycle event, not
  //    a connector call shape.
  const rollbackSamples = async () => {
    const entries = (await app.ledger(session.workspace))!.entries;
    return measureBoard([entries], new Date().toISOString()).metrics
      .rollback_count;
  };
  const before = await rollbackSamples();
  assert.equal(before.mean, 0, "the chain has no rollback before one lands");
  await app.rollbackHarnessProposal(session.id, pending[0]!.digest);
  const rolled = (await app.ledger(session.workspace))!.entries.at(-1)!
    .body as Record<string, unknown>;
  assert.equal(rolled.decision, "refinement:rolled-back");
  assert.equal(rolled.event, "rollback");
  const after = await rollbackSamples();
  assert.deepEqual(after, { n: 1, mean: 1, half: null, unmeasured: 0 });

  // 6. The chain verifies offline, through the standalone verifier, with the
  //    key the workbench actually signed with.
  const storage = app as unknown as { storage: { directory: string } };
  const exportDir = await mkdtemp(join(tmpdir(), "nomo-h7-export-"));
  t.after(() => rm(exportDir, { recursive: true, force: true }));
  const file = join(exportDir, `${session.workspace}.jsonl`);
  await writeFile(
    file,
    `${(internals.evidence[session.workspace] ?? [])
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
  );
  const key = await retainedKeyProvider({
    dir: join(storage.storage.directory, "keys"),
    env: {},
  });
  const publicKey = await key.publicKey(await key.currentKeyId());
  assert.ok(publicKey, "the retained verifier key must exist");
  const spki = Buffer.from(publicKey).toString("base64");
  const verified = await execFileAsync(
    process.execPath,
    [
      join(repoRoot, "packages", "verifier", "verify-ledger.mjs"),
      file,
      "--public-key",
      spki,
    ],
    { cwd: repoRoot },
  );
  assert.match(verified.stdout, /verified/i);
});
