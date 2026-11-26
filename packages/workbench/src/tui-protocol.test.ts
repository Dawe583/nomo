import test from "node:test";
import assert from "node:assert/strict";
import {
  parseTuiClientMessage,
  parseTuiIntent,
  parseTuiProtocolMessage,
  serializeTuiClientMessage,
  serializeTuiProtocolMessage,
  tuiApprovalSummary,
  tuiRenderState,
  tuiSessionSummary,
  tuiSnapshot,
  tuiSnapshotFromWorkbench,
  tuiTranscriptPage,
  tuiUsageStatus,
  TUI_PROTOCOL_VERSION,
} from "./tui-protocol.ts";
import type { SessionView } from "./index.ts";

const view = {
  id: "session-1",
  workspace: "local",
  model: "fixture/model",
  title: "Boundary fixture",
  status: "idle",
  state: "idle",
  provider: "fixture-provider",
  runId: "run-1",
  parentId: "parent-1",
  project: "project-1",
  agent: "agent-1",
  contextMessages: 7,
  continuationCount: 2,
  runTokenCount: 123,
  events: [
    {
      seq: 1,
      at: "2026-01-01T00:00:00.000Z",
      kind: "user",
      text: "secret prompt text",
    },
    {
      seq: 2,
      at: "2026-01-01T00:00:01.000Z",
      kind: "assistant",
      text: "answer",
      payload: { nested: { value: 1 } },
    },
    {
      seq: 3,
      at: "2026-01-01T00:00:02.000Z",
      kind: "usage",
      text: "usage",
      payload: {
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30,
        cost: 0.004,
      },
    },
    {
      seq: 4,
      at: "2026-01-01T00:00:03.000Z",
      kind: "assistant",
      text: "tail",
    },
  ],
} satisfies SessionView;

test("session metadata excludes transcript events and keeps protocol identity", () => {
  const summary = tuiSessionSummary(view);
  assert.equal(summary.id, "session-1");
  assert.equal(summary.model, "fixture/model");
  assert.equal("events" in summary, false);
  assert.equal(JSON.stringify(summary).includes("secret prompt text"), false);
});

test("transcript pages are bounded, ascending and copy event payloads", () => {
  const first = tuiTranscriptPage(view, { limit: 2 });
  assert.deepEqual(
    first.events.map((event) => event.seq),
    [3, 4],
  );
  assert.equal(first.hasMore, true);
  assert.equal(first.nextBeforeSeq, 3);

  const older = tuiTranscriptPage(view, { beforeSeq: 3, limit: 2 });
  assert.deepEqual(
    older.events.map((event) => event.seq),
    [1, 2],
  );
  assert.equal(older.hasMore, false);
  assert.equal(older.nextBeforeSeq, null);

  const payload = older.events[1]?.payload as { nested: { value: number } };
  payload.nested.value = 99;
  assert.equal(
    (view.events[1]?.payload as { nested: { value: number } }).nested.value,
    1,
  );
});

test("usage status reads only provider-reported usage and session counters", () => {
  assert.deepEqual(tuiUsageStatus(view), {
    contextMessages: 7,
    runTokenCount: 123,
    promptTokens: 10,
    completionTokens: 20,
    totalTokens: 30,
    cost: 0.004,
  });
});

test("snapshot separates metadata, transcript, provider state and terminal capabilities", () => {
  const snapshot = tuiSnapshot({
    session: view,
    approvals: [
      {
        holdId: "session-1:hold-1",
        sessionId: "session-1",
        tool: "shell.exec",
        reversibilityClass: "r2",
        status: "pending",
      },
    ],
    provider: {
      providerId: "fixture-provider",
      status: "ready",
      model: "fixture/model",
    },
    palette: [{ command: "/help", description: "All commands" }],
  });
  assert.equal(snapshot.version, TUI_PROTOCOL_VERSION);
  assert.equal("activeView" in snapshot, false);
  assert.equal("terminal" in snapshot, false);
  assert.equal(snapshot.session?.id, "session-1");
  assert.equal(snapshot.transcript?.events.at(-1)?.seq, 4);
  assert.equal(snapshot.usage?.totalTokens, 30);
  assert.equal(snapshot.approvals[0]?.tool, "shell.exec");
});

test("workbench snapshots adapt views and normalize approvals without client state", () => {
  const approvalInput = {
    holdId: "session-1:hold-1",
    sessionId: "session-1",
    status: "pending",
    expiresAt: 123,
    call: { tool: " shell.exec ", klass: "r2" },
  };
  const snapshot = tuiSnapshotFromWorkbench(
    {
      allViews: () => [view],
      approvals: () => [approvalInput],
    },
    {
      sessionId: "session-1",
      provider: { providerId: "fixture-provider", status: "ready" },
      transcriptLimit: 2,
    },
  );
  assert.equal(snapshot.session?.id, "session-1");
  assert.deepEqual(
    snapshot.transcript?.events.map((event) => event.seq),
    [3, 4],
  );
  assert.equal(snapshot.approvals[0]?.tool, "shell.exec");
  assert.equal(snapshot.approvals[0]?.reversibilityClass, "r2");
  assert.equal("activeView" in snapshot, false);
  assert.equal("terminal" in snapshot, false);
});

test("workbench snapshots fail closed for an unknown explicit session", () => {
  assert.throws(
    () =>
      tuiSnapshotFromWorkbench(
        { allViews: () => [view], approvals: () => [] },
        {
          sessionId: "missing-session",
          provider: { providerId: "fixture-provider", status: "ready" },
        },
      ),
    /Unknown TUI snapshot session: missing-session/u,
  );
});

test("render state carries client context beside server-owned workbench state", () => {
  const workbench = tuiSnapshot({
    session: view,
    provider: { status: "ready", providerId: "fixture-provider" },
  });
  const render = tuiRenderState({
    client: {
      activeView: "models",
      terminal: {
        columns: 40,
        rows: 12,
        ansi: false,
        colorDepth: 0,
        symbolPreset: "ascii",
        motion: "off",
      },
    },
    workbench,
  });
  assert.equal(render.client.activeView, "models");
  assert.equal(render.client.terminal.columns, 40);
  assert.equal(render.workbench.session?.id, "session-1");
  assert.equal("activeView" in render.workbench, false);
});


test("protocol messages round trip as one validated NDJSON object", () => {
  const snapshot = tuiSnapshot({
    session: view,
    provider: { providerId: "fixture-provider", status: "ready" },
    palette: [{ command: "/help", description: "All commands" }],
  });
  const line = serializeTuiProtocolMessage({ type: "snapshot", snapshot });
  assert.equal(line.includes("\n"), false);
  const parsed = parseTuiProtocolMessage(line);
  assert.equal(parsed.version, TUI_PROTOCOL_VERSION);
  assert.deepEqual(parsed.event, { type: "snapshot", snapshot });
});

test("protocol messages fail closed for malformed JSON, versions and wire shape", () => {
  assert.throws(() => parseTuiProtocolMessage("{"), /malformed JSON/u);
  assert.throws(
    () => parseTuiProtocolMessage(JSON.stringify({ version: 2, event: { type: "diagnostic", message: "x" } })),
    /version must be 1/u,
  );
  assert.throws(
    () => parseTuiProtocolMessage(JSON.stringify({ version: 1, event: { type: "unknown" } })),
    /unknown event type/u,
  );
  assert.throws(
    () =>
      parseTuiProtocolMessage(
        JSON.stringify({
          version: 1,
          event: {
            type: "transcript.appended",
            sessionId: "session-1",
            event: { seq: 0, at: "2026-01-01T00:00:00.000Z", kind: "assistant", text: "bad" },
          },
        }),
      ),
    /event\.event\.seq/u,
  );
});


test("client intent messages round trip as versioned NDJSON objects", () => {
  const intent = {
    type: "session.create" as const,
    prompt: "Plan the release",
    idempotencyKey: "fixture-intent-1",
  };
  const line = serializeTuiClientMessage(intent);
  assert.equal(line.includes("\n"), false);
  assert.deepEqual(parseTuiClientMessage(line), {
    version: TUI_PROTOCOL_VERSION,
    intent,
  });
  assert.deepEqual(parseTuiClientMessage(serializeTuiClientMessage({ type: "view.select", view: "help" })).intent, {
    type: "view.select",
    view: "help",
  });
});

test("client intent messages fail closed for malformed envelopes and intents", () => {
  assert.throws(() => parseTuiClientMessage("{"), /malformed JSON/u);
  assert.throws(
    () => parseTuiClientMessage(JSON.stringify({ version: 2, intent: { type: "view.select", view: "help" } })),
    /version must be 1/u,
  );
  assert.throws(
    () => parseTuiClientMessage(JSON.stringify({ version: 1, intent: { type: "session.create", prompt: "x", idempotencyKey: "bad key" } })),
    /idempotencyKey/u,
  );
});

test("approval normalization preserves malformed tools without inventing status", () => {
  assert.deepEqual(
    tuiApprovalSummary({
      holdId: "session-1:hold-1",
      sessionId: "session-1",
      status: "pending",
      expiresAt: 123,
      call: { tool: " shell.exec ", klass: "r2" },
    }),
    {
      holdId: "session-1:hold-1",
      sessionId: "session-1",
      tool: "shell.exec",
      reversibilityClass: "r2",
      status: "pending",
      expiresAt: 123,
    },
  );
  assert.equal(
    tuiApprovalSummary({ holdId: "hold", status: "pending", call: {} }).tool,
    "unknown",
  );
  assert.throws(
    () => tuiApprovalSummary({ holdId: "hold", status: "finished" }),
    /Invalid TUI approval status/,
  );
});

test("mutation intents require valid shape and idempotency keys", () => {
  assert.deepEqual(
    parseTuiIntent({
      type: "prompt.submit",
      sessionId: "session-1",
      prompt: "continue",
      idempotencyKey: "tui:prompt:12345678",
    }),
    {
      type: "prompt.submit",
      sessionId: "session-1",
      prompt: "continue",
      idempotencyKey: "tui:prompt:12345678",
    },
  );
  assert.throws(
    () =>
      parseTuiIntent({
        type: "prompt.submit",
        sessionId: "session-1",
        prompt: "continue",
        idempotencyKey: "bad key",
      }),
    /Invalid TUI intent/,
  );
  assert.throws(
    () =>
      parseTuiIntent(
        {
          type: "prompt.submit",
          sessionId: "session-1",
          prompt: "x".repeat(41),
          idempotencyKey: "tui:prompt:12345678",
        },
        { maxPromptCharacters: 40 },
      ),
    /exceeds 40 characters/,
  );
});

test("approval, palette and view intents are discriminated and validated", () => {
  assert.deepEqual(
    parseTuiIntent({
      type: "approval.decide",
      holdId: "session-1:hold-1",
      decision: "denied",
      by: "operator",
      reason: "blast radius is not reversible",
    }),
    {
      type: "approval.decide",
      holdId: "session-1:hold-1",
      decision: "denied",
      by: "operator",
      reason: "blast radius is not reversible",
    },
  );
  assert.deepEqual(parseTuiIntent({ type: "view.select", view: "models" }), {
    type: "view.select",
    view: "models",
  });
  assert.throws(
    () => parseTuiIntent({ type: "palette.execute", command: "help" }),
    /Invalid TUI intent/,
  );
  assert.throws(
    () =>
      parseTuiIntent({
        type: "approval.decide",
        holdId: "session-1:hold-1",
        decision: "expired",
        by: "operator",
      }),
    /approved or denied/,
  );
});
