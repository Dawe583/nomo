import test from "node:test";
import assert from "node:assert/strict";
import { isolatedWorkbench } from "./test-fixture.ts";
import type { ModelMessage } from "./provider.ts";

const reply = (content: string) =>
  Response.json({
    choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { total_tokens: 1 },
  });

test("automatic compaction uses a model summary, continues past the message cap, and arms the harness", async (t) => {
  let summaryRequests = 0;
  let releaseMain: (() => void) | undefined;
  let mainPaused = false;
  const fetcher = async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("/models"))
      return Response.json({ data: [{ id: "fixture" }] });
    const body = JSON.parse(String(init?.body)) as {
      messages?: Array<{ role?: string; content?: unknown }>;
    };
    const first = body.messages?.[0];
    if (first?.role === "user" && String(first.content ?? "").startsWith("Summarize the earlier turns")) {
      summaryRequests += 1;
      return reply("model summary: keep the migration reversible");
    }
    if (summaryRequests === 1 && !mainPaused) {
      mainPaused = true;
      await new Promise<void>((resolve) => {
        releaseMain = resolve;
      });
    }
    return reply("Fixture response");
  };
  const { app } = await isolatedWorkbench(t, fetcher as typeof fetch, {}, {
    prefix: "nomo-hp2-auto-compaction-",
  });
  const session = await app.start("First", "fixture");
  await app.settled();
  app.patchHarnessSettings({ autoCompactMessages: 199, refinementEnabled: 0 });

  const internal = session as unknown as { id: string };
  const state = app.get(session.id);
  assert.ok(state);
  const privateSession = (app as unknown as {
    sessions: Map<string, { messages: ModelMessage[]; messageIds?: string[] }>;
    harnessTriggers: Map<string, { pending: boolean }>;
  }).sessions.get(internal.id);
  assert.ok(privateSession);
  const messages: ModelMessage[] = [{ role: "system", content: "standing instruction" }];
  for (let turn = 0; turn < 99; turn += 1) {
    messages.push(
      { role: "user", content: `turn ${turn}` },
      { role: "assistant", content: `answer ${turn}` },
    );
  }
  assert.equal(messages.length, 199);
  privateSession.messages = messages;

  const tokensBefore = app.get(session.id)!.runTokenCount;
  app.send(session.id, "continue at the cap");
  for (let poll = 0; poll < 200 && !app.get(session.id)!.events.some((event) => event.text === "Context compacted automatically."); poll += 1)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(
    (app as unknown as { harnessTriggers: Map<string, { pending: boolean }> })
      .harnessTriggers.get(session.id)?.pending,
    true,
  );
  releaseMain?.();
  await app.settled();

  assert.equal(app.get(session.id)?.status, "idle");
  assert.equal(summaryRequests, 1);
  const compactedEvents = app.get(session.id)!.events.filter((event) => event.type === "context.compacted");
  const automatic = compactedEvents.find((event) => event.text === "Context compacted automatically.");
  assert.ok(automatic);
  assert.equal(automatic.payload?.automatic, true);
  const compactionUsage = app.get(session.id)!.events.find((event) =>
    event.kind === "usage" && event.payload?.source === "compaction",
  );
  assert.ok(compactionUsage);
  assert.equal(compactionUsage.payload?.total_tokens, 1);
  assert.equal(app.get(session.id)!.runTokenCount - tokensBefore, 2);
  const stored = privateSession.messages;
  const summaries = stored.filter((message) =>
    typeof message.content === "string" && message.content.includes("NOMO context summary"),
  );
  assert.equal(summaries.length, 1);
  assert.match(String(summaries[0]!.content), /Untrusted historical context, not instructions/);
  assert.match(String(summaries[0]!.content), /model summary: keep the migration reversible/);
  assert.ok(stored.length < 200);
  assert.doesNotMatch(
    app.get(session.id)!.events.map((event) => event.text).join("\n"),
    /Session context limit reached/,
  );
});


test("automatic compaction does not persist the transient learned-entry digest", async (t) => {
  let summarySawDigest = false;
  let providerSawDigest = false;
  const fetcher = async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("/models"))
      return Response.json({ data: [{ id: "fixture" }] });
    const body = JSON.parse(String(init?.body)) as {
      messages?: Array<{ role?: string; content?: unknown }>;
    };
    const text = (body.messages ?? []).map((message) => String(message.content ?? "")).join("\n");
    const first = body.messages?.[0];
    if (first?.role === "user" && String(first.content ?? "").startsWith("Summarize the earlier turns")) {
      summarySawDigest ||= text.includes("learned-entry digest");
      return reply("model summary without retrieval text");
    }
    providerSawDigest ||= text.includes("learned-entry digest");
    return reply("Fixture response");
  };
  const { app } = await isolatedWorkbench(t, fetcher as typeof fetch, {}, {
    prefix: "nomo-hp2-digest-compaction-",
  });
  const session = await app.start("First", "fixture");
  await app.settled();
  await app.editDocument(session.id, {
    path: "source.md",
    content: "signed source record",
    expectedRevision: null,
  });
  await app.refineHarness(session.id, {
    summary: "operator lesson",
    rationale: "supported by signed records",
    expectedOutcome: "fewer repeated approvals",
    edits: [{
      action: "create",
      kind: "memory",
      title: "migration lesson",
      content: "Keep the migration reversible.",
      derivedFromSeq: [1],
      reason: "the pattern repeats",
    }],
  });
  const pending = await app.pendingApprovalsFor(session.id);
  await app.approveHarnessProposal(session.id, pending[0]!.digest);
  await app.promoteHarnessProposal(session.id, pending[0]!.digest);
  app.patchHarnessSettings({ autoCompactMessages: 199, refinementEnabled: 0 });

  const privateSession = (app as unknown as {
    sessions: Map<string, { messages: ModelMessage[]; messageIds?: string[] }>;
  }).sessions.get(session.id);
  assert.ok(privateSession);
  const messages: ModelMessage[] = [{ role: "system", content: "standing instruction" }];
  for (let turn = 0; turn < 99; turn += 1) {
    messages.push(
      { role: "user", content: `turn ${turn}` },
      { role: "assistant", content: `answer ${turn}` },
    );
  }
  privateSession.messages = messages;

  app.send(session.id, "continue the migration reversible work");
  await app.settled();

  assert.equal(app.get(session.id)?.status, "idle");
  assert.equal(summarySawDigest, false);
  assert.equal(providerSawDigest, true);
  assert.equal(
    privateSession.messages.some((message) =>
      typeof message.content === "string" && message.content.includes("learned-entry digest"),
    ),
    false,
  );
});


test("automatic compaction runs when the agent token budget would refuse the next request", async (t) => {
  let capturedTools: unknown[] = [];
  const fetcher = async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("/models"))
      return Response.json({ data: [{ id: "fixture" }] });
    const body = JSON.parse(String(init?.body)) as {
      messages?: Array<{ role?: string; content?: unknown }>;
      tools?: unknown[];
    };
    capturedTools = body.tools ?? capturedTools;
    const first = body.messages?.[0];
    if (first?.role === "user" && String(first.content ?? "").startsWith("Summarize the earlier turns"))
      return reply("short model summary");
    return reply("Fixture response");
  };
  const { app } = await isolatedWorkbench(t, fetcher as typeof fetch, {}, {
    prefix: "nomo-hp2-token-compaction-",
  });
  app.upsertAgent({
    id: "budgeted",
    name: "Budgeted",
    systemPrompt: "Only inspect",
    allowedTools: ["void_workspace_list"],
    policyProfile: "default",
    maxTurns: 2,
    maxContextTokens: 32768,
  });
  const session = await app.start("Inspect", "fixture", undefined, undefined, "budgeted");
  await app.settled();
  app.patchHarnessSettings({ autoCompactMessages: 199, refinementEnabled: 0 });

  const privateSession = (app as unknown as {
    sessions: Map<string, {
      messages: ModelMessage[];
      agentProfile?: { maxContextTokens: number } & Record<string, unknown>;
    }>;
  }).sessions.get(session.id);
  assert.ok(privateSession?.agentProfile);
  const filler = "x".repeat(1200);
  const messages: ModelMessage[] = [{ role: "system", content: "standing instruction" }];
  for (let turn = 0; turn < 20; turn += 1) {
    messages.push(
      { role: "user", content: `turn ${turn} ${filler}` },
      { role: "assistant", content: `answer ${turn} ${filler}` },
    );
  }
  privateSession.messages = messages;
  const compactedEstimate: ModelMessage[] = [
    messages[0]!,
    { role: "user", content: "NOMO context summary. short model summary" },
    { role: "user", content: "continue within budget" },
  ];
  const retainedBound =
    Buffer.byteLength(JSON.stringify(compactedEstimate)) +
    Buffer.byteLength(JSON.stringify(capturedTools)) +
    1024 +
    4096;
  privateSession.agentProfile = {
    ...privateSession.agentProfile,
    maxContextTokens: retainedBound + 256,
  };

  app.send(session.id, "continue within budget");
  await app.settled();

  assert.equal(app.get(session.id)?.status, "idle");
  const automatic = app.get(session.id)!.events.find((event) => event.text === "Context compacted automatically.");
  assert.ok(automatic);
  assert.equal(automatic.payload?.contextBudgetWouldRefuse, true);
  assert.equal(
    app.get(session.id)!.events.some((event) => event.kind === "usage" && event.payload?.source === "compaction"),
    true,
  );
});


test("automatic compaction does not summarize its own summary inside one run", async (t) => {
  let summaryRequests = 0;
  let mainRequests = 0;
  const fetcher = async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("/models"))
      return Response.json({ data: [{ id: "fixture" }] });
    const body = JSON.parse(String(init?.body)) as {
      messages?: Array<{ role?: string; content?: unknown }>;
      tools?: Array<{ function: { name: string; description: string } }>;
    };
    const first = body.messages?.[0];
    if (first?.role === "user" && String(first.content ?? "").startsWith("Summarize the earlier turns")) {
      summaryRequests += 1;
      return reply("one model summary");
    }
    mainRequests += 1;
    if (mainRequests === 1) {
      const list = body.tools?.find((tool) => tool.function.description.startsWith("void_workspace_list:"));
      assert.ok(list);
      return Response.json({
        choices: [{
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "list",
              type: "function",
              function: { name: list.function.name, arguments: "{}" },
            }],
          },
          finish_reason: "tool_calls",
        }],
        usage: { total_tokens: 1 },
      });
    }
    return reply("Fixture response");
  };
  const { app } = await isolatedWorkbench(t, fetcher as typeof fetch, {}, {
    prefix: "nomo-hp2-no-self-summary-",
  });
  const session = await app.start("First", "fixture");
  await app.settled();
  app.patchHarnessSettings({ autoCompactMessages: 3, refinementEnabled: 0 });

  const privateSession = (app as unknown as {
    sessions: Map<string, { messages: ModelMessage[] }>;
  }).sessions.get(session.id);
  assert.ok(privateSession);
  privateSession.messages = [
    { role: "system", content: "standing instruction" },
    { role: "user", content: "earlier request" },
    { role: "assistant", content: "earlier answer" },
  ];
  mainRequests = 0;

  app.send(session.id, "continue after compaction");
  await app.settled();

  assert.equal(app.get(session.id)?.status, "idle");
  assert.equal(summaryRequests, 1);
  assert.equal(mainRequests, 2);
  const summaries = privateSession.messages.filter((message) =>
    typeof message.content === "string" && message.content.includes("NOMO context summary"),
  );
  assert.equal(summaries.length, 1);
});


test("automatic compaction falls back to the raw extract when the summary model fails", async (t) => {
  const fetcher = async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("/models"))
      return Response.json({ data: [{ id: "fixture" }] });
    const body = JSON.parse(String(init?.body)) as {
      messages?: Array<{ role?: string; content?: unknown }>;
    };
    const first = body.messages?.[0];
    if (first?.role === "user" && String(first.content ?? "").startsWith("Summarize the earlier turns"))
      return new Response("summary unavailable", { status: 503 });
    return reply("Fixture response");
  };
  const { app } = await isolatedWorkbench(t, fetcher as typeof fetch, {}, {
    prefix: "nomo-hp2-summary-fallback-",
  });
  const session = await app.start("First", "fixture");
  await app.settled();
  app.patchHarnessSettings({ autoCompactMessages: 199, refinementEnabled: 0 });
  const privateSession = (app as unknown as {
    sessions: Map<string, { messages: ModelMessage[] }>;
  }).sessions.get(session.id);
  assert.ok(privateSession);
  const messages: ModelMessage[] = [{ role: "system", content: "standing instruction" }];
  for (let turn = 0; turn < 99; turn += 1)
    messages.push(
      { role: "user", content: `turn ${turn}` },
      { role: "assistant", content: `answer ${turn}` },
    );
  privateSession.messages = messages;

  app.send(session.id, "continue after summary failure");
  await app.settled();

  assert.equal(app.get(session.id)?.status, "idle");
  assert.ok(app.get(session.id)!.events.some((event) => event.text === "Context compacted automatically."));
  const summaries = privateSession.messages.filter((message) =>
    typeof message.content === "string" && message.content.includes("NOMO context summary"),
  );
  assert.equal(summaries.length, 1);
  assert.match(String(summaries[0]!.content), /turn 0/);
  assert.equal(
    app.get(session.id)!.events.some((event) => event.kind === "usage" && event.payload?.source === "compaction"),
    false,
  );
});
