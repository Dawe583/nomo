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
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, type Server } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { assertIsolated, isolatedWorkbench } from "./test-fixture.ts";
import { Workbench, type SessionView } from "./index.ts";
import { mineLearnedRules } from "./learned-rules.ts";
import { measureBoard } from "./harness-scores.ts";
import { dataDir } from "../../ledger/src/paths.ts";
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
      return Response.json({ choices: [{ message: { role: "assistant",
      content: null, tool_calls: [
        {
          id: `held-call-${++callCount}`,
          type: "function",
          function: {
            name: connector.function!.name!,
            arguments: "{}",
          },
        },
      ] }, finish_reason: "tool_calls" }] });
    }
    return Response.json({ choices: [{ message: { role: "assistant", content: "Ready" }, finish_reason: "stop" }] });
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
    { prefix: "nomo-harness-proof-" },
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

test("H7: real stdio proxy closed loop with H10 outcome feedback, H11 refinement effect and offline verify", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nomo-h7-proxy-proof-"));
  let app: Workbench | undefined;
  t.after(async () => {
    await app?.shutdown();
    await rm(dir, { recursive: true, force: true });
  });
  const policyPath = join(dir, "policy.yaml");
  await writeFile(
    policyPath,
    [
      "version: 1",
      "rules:",
      "  - match:",
      "      tool: echo",
      "      class: unknown",
      "    decision: allow",
      "  - match:",
      "      tool: orders_delete",
      "    decision: deny",
      "    rationale: destructive proxy fixture tool denied by policy",
      "  - match: {}",
      "    decision: deny",
      "",
    ].join("\n"),
  );

  let nextCall: { toolHint: string; args: Record<string, unknown> } | null = null;
  let seqId = 0;
  const systemPrompts: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/models")) {
      return Response.json({ data: [{ id: "fixture" }] });
    }
    const body = JSON.parse(String(init?.body)) as {
      tools?: { function?: { name?: string; description?: string } }[];
      messages?: { role?: string; content?: unknown }[];
    };
    systemPrompts.push(
      ...(body.messages ?? [])
        .filter((m) => m.role === "system")
        .map((m) => String(m.content ?? "")),
    );
    if (nextCall) {
      const wanted = nextCall;
      nextCall = null;
      const tool = (body.tools ?? []).find((item) =>
        item.function?.description?.includes(wanted.toolHint),
      );
      assert.ok(tool?.function?.name, `expected proxied tool matching ${wanted.toolHint}`);
      return Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `proxy-call-${++seqId}`,
                  type: "function",
                  function: {
                    name: tool.function.name,
                    arguments: JSON.stringify(wanted.args),
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      });
    }
    return Response.json({
      choices: [
        { message: { role: "assistant", content: "Done" }, finish_reason: "stop" },
      ],
    });
  };

  const proxyEnv = {
    NOMO_LEDGER_DIR: dir,
    NOMO_UPSTREAM_COMMAND: JSON.stringify([
      process.execPath,
      join(repoRoot, "fixtures/e2e-server.mjs"),
    ]),
    NOMO_POLICY_PATH: policyPath,
  };
  app = new Workbench(proxyEnv, fetcher);
  assertIsolated(join(dir, "workbench"), proxyEnv);
  await app.configure({
    baseUrl: "https://provider.test/v1",
    apiKey: "fixture-secret-not-logged",
  });

  // 1. Proxied echo succeeds and syncs its signed proxy entry into the workspace chain.
  nextCall = { toolHint: "Returns the text argument unchanged.", args: { text: "before" } };
  const session = await app.start("Run proxied echo before refinement", "fixture");
  await app.settled();
  assert.equal(app.get(session.id)?.status, "idle");

  // 2. Three proxied orders_delete calls are denied by policy through packages/proxy.
  for (let i = 1; i <= 3; i += 1) {
    nextCall = {
      toolHint: "Destructive test tool that deletes matching orders.",
      args: { where: `id=${i}` },
    };
    app.send(session.id, `Attempt orders_delete ${i}`);
    await app.settled();
    assert.equal(app.get(session.id)?.status, "idle");
  }

  const preLedger = (await app.ledger(session.workspace))!.entries;
  const proxyEntries = preLedger.filter(
    (entry) => (entry.body as Record<string, unknown>).source === "stdio-proxy",
  );
  assert.ok(proxyEntries.length >= 4, `expected >=4 synced stdio-proxy entries, got ${proxyEntries.length}`);

  // 3. Mined rule emerges from the three proxied refusals with chain provenance.
  const mined = mineLearnedRules(preLedger);
  assert.equal(mined.length, 1);
  assert.equal(mined[0]!.match.tool, "orders_delete");
  const harnessBefore = await app.harnessEntries(session.workspace);
  const rule = harnessBefore.find((entry) => entry.kind === "rule");
  assert.ok(rule && rule.repeats >= 3 && rule.derivedFromSeq.length >= 3);

  // 4. Create proposal citing the signed refusals and approve its exact digest.
  const proposal: RefinementProposal = {
    summary: "orders_delete requires explicit review",
    rationale: "three proxied policy denials on the signed ledger",
    expectedOutcome: "later turns avoid unapproved orders_delete calls",
    edits: [
      {
        action: "create",
        kind: "memory",
        title: "avoid unapproved orders_delete",
        content: "Do not call orders_delete without explicit operator approval.",
        derivedFromSeq: rule!.derivedFromSeq,
        reason: "repeated proxy denial",
      },
      {
        action: "create",
        kind: "memory",
        title: "prefer echo check first",
        content: "Check workspace status with safe read/echo tools before mutation.",
        derivedFromSeq: rule!.derivedFromSeq,
        reason: "safe diagnostic pattern",
      },
    ],
  };
  const created = await app.refineHarness(session.id, proposal);
  assert.ok(created.proposalDigest);
  await app.approveHarnessProposal(session.id, created.proposalDigest!);

  // 5. Bounded retrieval injects only 1 lesson when contextEntryLimit is 1.
  app.patchHarnessSettings({ contextEntryLimit: 1 });
  systemPrompts.length = 0;
  nextCall = { toolHint: "Returns the text argument unchanged.", args: { text: "after" } };
  app.send(session.id, "Check orders_delete guidance and run echo after activation");
  await app.settled();
  const digestPrompt = systemPrompts.find((text) =>
    text.startsWith("NOMO learned-entry digest,"),
  );
  assert.ok(digestPrompt, "later turn must carry approved learned-entry digest");
  const retrievedLessons = digestPrompt
    .split("\n")
    .filter((line) => line.startsWith("- [lesson] "));
  assert.equal(retrievedLessons.length, 1);

  // 6. H11: measure descriptive before-vs-after effect across the activation boundary.
  const ledgerLenBeforeEffect = (await app.ledger(session.workspace))!.entries.length;
  const effectsStanding = await app.harnessEffects(session.workspace, "2026-11-21T00:00:00Z");
  assert.equal(effectsStanding.length, 1);
  assert.equal(effectsStanding[0]!.digest, created.proposalDigest);
  assert.equal(effectsStanding[0]!.status, "activated");
  assert.ok(effectsStanding[0]!.effect.before.caseCount >= 2);
  assert.ok(effectsStanding[0]!.effect.after.caseCount >= 1);
  assert.equal(
    (await app.ledger(session.workspace))!.entries.length,
    ledgerLenBeforeEffect,
    "measuring effects must never mutate the signed ledger (decision D1)",
  );

  // 7. Roll back the activation; H10 records the settled fate and refuses an
  //    identical re-proposal citing nothing newer; H11 caps the effect window.
  await app.rollbackHarnessProposal(session.id, created.proposalDigest!);
  const outcomes = await app.harnessOutcomes(session.workspace);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]!.status, "rolled-back");
  assert.equal(outcomes[0]!.activatedSeq, effectsStanding[0]!.activationSeq);
  let repeatError = "";
  await assert.rejects(
    app.refineHarness(session.id, proposal),
    (error: unknown) => {
      repeatError = error instanceof Error ? error.message : String(error);
      return /already rolled back this refinement/i.test(repeatError);
    },
  );
  const effectsRolledBack = await app.harnessEffects(session.workspace, "2026-11-21T00:00:00Z");
  assert.equal(effectsRolledBack[0]!.status, "rolled-back");
  assert.ok(effectsRolledBack[0]!.rolledBackSeq !== null);

  // 8. Standalone offline verifier verifies BOTH the exported workbench chain
  //    and the raw stdio proxy ledger chain.
  const exportDir = await mkdtemp(join(tmpdir(), "nomo-h7-proxy-export-"));
  t.after(() => rm(exportDir, { recursive: true, force: true }));
  const exportedWorkspace = join(exportDir, `${session.workspace}.jsonl`);
  const finalEntries = (await app.ledger(session.workspace))!.entries;
  await writeFile(
    exportedWorkspace,
    `${finalEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
  const wbKey = await retainedKeyProvider({
    dir: join(dir, "workbench", "keys"),
    env: {},
  });
  const wbPub = await wbKey.publicKey(await wbKey.currentKeyId());
  assert.ok(wbPub);
  const verifiedWb = await execFileAsync(
    process.execPath,
    [
      join(repoRoot, "packages", "verifier", "verify-ledger.mjs"),
      exportedWorkspace,
      "--public-key",
      Buffer.from(wbPub).toString("base64"),
    ],
    { cwd: repoRoot },
  );
  assert.match(verifiedWb.stdout, /verified/i);

  const proxyKey = await retainedKeyProvider({
    dir: join(dataDir(homedir()), "keys"),
    env: {},
  });
  const proxyPub = await proxyKey.publicKey(await proxyKey.currentKeyId());
  assert.ok(proxyPub);
  const verifiedProxy = await execFileAsync(
    process.execPath,
    [
      join(repoRoot, "packages", "verifier", "verify-ledger.mjs"),
      join(dir, `${session.workspace}.jsonl`),
      "--public-key",
      Buffer.from(proxyPub).toString("base64"),
    ],
    { cwd: repoRoot },
  );
  assert.match(verifiedProxy.stdout, /verified/i);

  if (process.env.NOMO_H7_TRANSCRIPT === "1") {
    console.log(
      "H7_TRANSCRIPT_JSON=" +
        JSON.stringify({
          workspaceEntries: finalEntries.length,
          syncedProxyEntries: proxyEntries.length,
          minedRule: {
            tool: mined[0]!.match.tool,
            class: mined[0]!.match.class,
            repeats: rule!.repeats,
            derivedFromSeq: rule!.derivedFromSeq,
          },
          proposalDigestPrefix: created.proposalDigest!.slice(0, 12),
          activationSeq: effectsStanding[0]!.activationSeq,
          retrievedLessonRows: retrievedLessons.length,
          effectStanding: {
            beforeCases: effectsStanding[0]!.effect.before.caseCount,
            afterCases: effectsStanding[0]!.effect.after.caseCount,
            verdict: effectsStanding[0]!.effect.verdict,
            unmeasuredGuardrails: effectsStanding[0]!.effect.unmeasuredGuardrails,
            denyBefore: effectsStanding[0]!.effect.before.guardrails.deny_rate,
            denyAfter: effectsStanding[0]!.effect.after.guardrails.deny_rate,
          },
          rolledBackSeq: effectsRolledBack[0]!.rolledBackSeq,
          repeatRefusalNote: repeatError,
          verifiedWorkbenchStdout: verifiedWb.stdout.trim(),
          verifiedProxyStdout: verifiedProxy.stdout.trim(),
        }),
    );
  }
});
