import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AgentRunnerContractError,
  assertKnownAgentRunnerProfile,
  assertSafeAgentRunnerDescription,
  mediateAgentRunEvents,
  validateAgentRunEvents,
  type AgentRun,
  type AgentRunEvent,
  type AgentRunToolResponse,
  type AgentRunnerDescription,
} from "./agent-runner.ts";

const description: AgentRunnerDescription = {
  id: "fixture-runner",
  displayName: "Fixture runner",
  provider: "fixture",
  endpoint: "https://fixture.invalid/v1",
  dataTransfer: "remote",
  dataSent: ["task", "system-prompt", "tool-arguments", "tool-results"],
  profiles: ["safe", "review"],
  execution: "local",
  toolAccess: "mediated",
  workspaceMode: "approved-copy",
  cancellation: "may-be-unknown",
};

function statusEvent(
  sequence: number,
  status: "starting" | "running",
  runId = "run-1",
): AgentRunEvent {
  return { type: "status", runId, sequence, status };
}

function terminalEvent(
  sequence: number,
  status: "completed" | "failed" | "cancelled" | "unknown",
  runId = "run-1",
): AgentRunEvent {
  return { type: "terminal", runId, sequence, status };
}

async function collect(events: AsyncIterable<AgentRunEvent>, runId = "run-1") {
  const result: AgentRunEvent[] = [];
  for await (const item of validateAgentRunEvents(runId, events)) result.push(item);
  return result;
}

async function* from(events: readonly AgentRunEvent[]): AsyncGenerator<AgentRunEvent> {
  yield* events;
}

function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof AgentRunnerContractError && error.code === code;
}

test("runner profile selection rejects IDs outside the declared profile set", () => {
  assert.doesNotThrow(() => assertKnownAgentRunnerProfile(description, "safe"));
  assert.doesNotThrow(() => assertKnownAgentRunnerProfile(description));
  assert.throws(
    () => assertKnownAgentRunnerProfile(description, "unlisted"),
    hasCode("unknown-profile"),
  );
});

test("runner descriptions reject hidden endpoints and unmediated authority", () => {
  assert.doesNotThrow(() => assertSafeAgentRunnerDescription(description));
  assert.throws(
    () => assertSafeAgentRunnerDescription({
      ...description,
      endpoint: "https://runner.example/v1?api_key=secret",
    }),
    hasCode("invalid-description"),
  );
  assert.throws(
    () => assertSafeAgentRunnerDescription({
      ...description,
      toolAccess: "unmediated",
    }),
    hasCode("invalid-description"),
  );
  assert.throws(
    () => assertSafeAgentRunnerDescription({
      ...description,
      dataSent: [],
    }),
    hasCode("invalid-description"),
  );
  assert.throws(
    () => assertSafeAgentRunnerDescription({
      ...description,
      dataTransfer: "local-only",
      dataSent: ["task"],
      endpoint: "http://localhost:8000",
    }),
    hasCode("invalid-description"),
  );
});

test("event stream requires correlated, ordered events and one final terminal", async () => {

  const events: AgentRunEvent[] = [
    statusEvent(1, "starting"),
    statusEvent(2, "running"),
    terminalEvent(3, "completed"),
  ];
  assert.deepEqual(await collect(from(events)), events);
});

test("event stream rejects status regression from running to starting", async () => {
  await assert.rejects(
    collect(from([
      statusEvent(1, "running"),
      statusEvent(2, "starting"),
      terminalEvent(3, "completed"),
    ])),
    hasCode("invalid-event"),
  );
});

test("event stream accepts bounded assistant messages before one terminal event", async () => {
  const events: AgentRunEvent[] = [
    { type: "assistant-message", runId: "run-1", sequence: 1, text: "Finished safely." },
    terminalEvent(2, "completed"),
  ];
  assert.deepEqual(await collect(from(events)), events);
});


test("event stream accepts bounded broker request and result events", async () => {
  const events: AgentRunEvent[] = [
    {
      type: "tool-request",
      runId: "run-1",
      sequence: 1,
      requestId: "request-1",
      toolName: "workspace.read",
      argsJson: "{\"path\":\"README.md\"}",
    },
    {
      type: "tool-result",
      runId: "run-1",
      sequence: 2,
      requestId: "request-1",
      resultJson: "{\"content\":\"ok\"}",
    },
    terminalEvent(3, "completed"),
  ];
  assert.deepEqual(await collect(from(events)), events);
});

test("event stream rejects a different run ID and sequence gaps", async () => {
  await assert.rejects(
    collect(from([statusEvent(1, "running", "another-run"), terminalEvent(2, "failed")])),
    hasCode("run-id-mismatch"),
  );
  await assert.rejects(
    collect(from([statusEvent(2, "running"), terminalEvent(3, "failed")])),
    hasCode("sequence-mismatch"),
  );
});

test("event stream rejects missing, duplicate, or non-final terminal events", async () => {
  await assert.rejects(
    collect(from([statusEvent(1, "running")])),
    hasCode("terminal-missing"),
  );
  await assert.rejects(
    collect(from([terminalEvent(1, "completed"), terminalEvent(2, "failed")])),
    hasCode("event-after-terminal"),
  );
  await assert.rejects(
    collect(from([terminalEvent(1, "completed"), statusEvent(2, "running")])),
    hasCode("event-after-terminal"),
  );
});

test("event stream rejects oversized payloads", async () => {
  const oversized = {
    type: "tool-request",
    runId: "run-1",
    sequence: 1,
    requestId: "request-1",
    toolName: "workspace.read",
    argsJson: "x".repeat(64 * 1024),
  } as AgentRunEvent;
  await assert.rejects(
    collect(from([oversized, terminalEvent(2, "completed")])),
    hasCode("event-too-large"),
  );
});

test("tool requests wait for Workbench mediation before the runner continues", async () => {
  let deliver!: (response: AgentRunToolResponse) => void;
  const responsePromise = new Promise<AgentRunToolResponse>((resolve) => {
    deliver = resolve;
  });
  const seen: string[] = [];
  async function* events(): AsyncGenerator<AgentRunEvent> {
    yield {
      type: "tool-request",
      runId: "run-1",
      sequence: 1,
      requestId: "request-1",
      toolName: "workspace.read",
      argsJson: "{}",
    };
    const response = await responsePromise;
    seen.push(response.kind);
    yield {
      type: "tool-result",
      runId: "run-1",
      sequence: 2,
      requestId: "request-1",
      resultJson: response.kind === "result" ? response.resultJson : response.message,
    };
    yield terminalEvent(3, "completed");
  }
  const run: AgentRun = {
    id: "run-1",
    events: events(),
    async respondToTool(requestId, response) {
      assert.equal(requestId, "request-1");
      deliver?.(response);
    },
  };

  let executions = 0;
  await mediateAgentRunEvents(run, async (request) => {
    executions++;
    assert.equal(request.toolName, "workspace.read");
    return { kind: "result", resultJson: '{"content":"safe"}' };
  });

  assert.equal(executions, 1);
  assert.deepEqual(seen, ["result"]);
});

test("the broker rejects a repeated tool request ID before re-execution", async () => {
  const request = (sequence: number): AgentRunEvent => ({
    type: "tool-request",
    runId: "run-1",
    sequence,
    requestId: "same-request",
    toolName: "workspace.write",
    argsJson: '{"path":"note.md","content":"once"}',
  });
  const result = (sequence: number): AgentRunEvent => ({
    type: "tool-result",
    runId: "run-1",
    sequence,
    requestId: "same-request",
    resultJson: '{"ok":true}',
  });
  const run: AgentRun = {
    id: "run-1",
    events: from([
      request(1),
      result(2),
      request(3),
      result(4),
      terminalEvent(5, "completed"),
    ]),
    async respondToTool() {},
  };
  let calls = 0;
  await assert.rejects(
    mediateAgentRunEvents(run, async () => {
      calls++;
      return { kind: "result", resultJson: '{"ok":true}' };
    }),
    hasCode("tool-request-duplicate"),
  );
  assert.equal(calls, 1);
});
