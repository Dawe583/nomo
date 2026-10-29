import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PROJECT_CHANGES_TOOL } from "../project-workspace.ts";
import { PROJECT_EXEC_TOOL } from "../project-sandbox.ts";
import { isolatedWorkbench } from "../test-fixture.ts";
import type {
  AgentRunEvent,
  AgentRunner,
  AgentRunInput,
  AgentRunToolResponse,
} from "./agent-runner.ts";

const profile = {
  id: "project-reader",
  name: "Project reader",
  systemPrompt: "Read the confirmed project copy only.",
  allowedTools: [PROJECT_CHANGES_TOOL.name],
  policyProfile: "default",
  maxTurns: 2,
  maxContextTokens: 8192,
};

test("agent run requires a current consent digest and leaves the provider route unused", async (t) => {
  const requests: AgentRunInput[] = [];
  const responses: AgentRunToolResponse[] = [];
  const runner: AgentRunner = {
    describe: () => ({
      id: "fixture-runner",
      displayName: "Fixture runner",
      provider: "fixture",
      endpoint: "https://fixture.invalid/v1",
      dataTransfer: "remote",
      dataSent: ["task", "system-prompt", "tool-arguments", "tool-results"],
      profiles: ["safe"],
      execution: "local",
      toolAccess: "mediated",
      workspaceMode: "approved-copy",
      cancellation: "confirmed",
    }),
    async start(input) {
      requests.push(input);
      let resolveResponse!: (response: AgentRunToolResponse) => void;
      let resolveOutOfScopeResponse!: (response: AgentRunToolResponse) => void;
      const response = new Promise<AgentRunToolResponse>((resolve) => {
        resolveResponse = resolve;
      });
      const outOfScopeResponse = new Promise<AgentRunToolResponse>((resolve) => {
        resolveOutOfScopeResponse = resolve;
      });
      const events: AsyncIterable<AgentRunEvent> = (async function* () {
        yield { type: "status", runId: "fixture-run", sequence: 1, status: "running" };
        yield {
          type: "tool-request",
          runId: "fixture-run",
          sequence: 2,
          requestId: "tool-1",
          toolName: PROJECT_CHANGES_TOOL.name,
          argsJson: '{"operation":"status"}',
        };
        const result = await response;
        yield {
          type: "tool-result",
          runId: "fixture-run",
          sequence: 3,
          requestId: "tool-1",
          resultJson: result.kind === "result" ? result.resultJson : result.message,
        };
        yield {
          type: "tool-request",
          runId: "fixture-run",
          sequence: 4,
          requestId: "tool-2",
          toolName: PROJECT_EXEC_TOOL.name,
          argsJson: '{"command":"printf harness-out-of-scope"}',
        };
        const outOfScopeResult = await outOfScopeResponse;
        yield {
          type: "tool-result",
          runId: "fixture-run",
          sequence: 5,
          requestId: "tool-2",
          resultJson: outOfScopeResult.kind === "result"
            ? outOfScopeResult.resultJson
            : outOfScopeResult.message,
        };
        yield { type: "terminal", runId: "fixture-run", sequence: 6, status: "completed" };
      })();
      return {
        id: "fixture-run",
        events,
        async respondToTool(requestId, result) {
          responses.push(result);
          if (requestId === "tool-1") resolveResponse(result);
          else {
            assert.equal(requestId, "tool-2");
            resolveOutOfScopeResponse(result);
          }
        },
      };
    },
    async cancel() { return "confirmed"; },
  };
  const fixture = await isolatedWorkbench(
    t,
    undefined,
    { NOMO_PERMISSION_MODE: "normal" },
    { configure: false, agentRunners: [runner] },
  );
  fixture.app.upsertAgent(profile);
  const projectRoot = await mkdtemp(join(tmpdir(), "nomo-agent-runner-project-"));
  execFileSync("git", ["init", "--quiet"], { cwd: projectRoot, stdio: "ignore" });
  await writeFile(join(projectRoot, ".env.local"), "workspace-secret-fixture");
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const { rootDigest } = await fixture.app.confirmProjectAccess(projectRoot, []);

  const preview = await fixture.app.prepareAgentRun({
    runnerId: "fixture-runner",
    task: "do-not-persist-this-secret task",
    profileId: profile.id,
    runnerProfileId: "safe",
  });
  assert.equal(preview.project.manifest.files.some((file) => file.path === ".env.local"), false);
  assert.equal(preview.project.rootDigest, rootDigest);
  assert.equal(preview.runner.endpoint, "https://fixture.invalid/v1");
  assert.equal(preview.runner.dataTransfer, "remote");
  assert.deepEqual(preview.runner.dataSent, [
    "task",
    "system-prompt",
    "tool-arguments",
    "tool-results",
  ]);
  assert.equal(preview.profile.systemPrompt, profile.systemPrompt);
  assert.equal(preview.tools.some((tool) => tool.name === PROJECT_CHANGES_TOOL.name), true);
  await assert.rejects(
    fixture.app.startAgentRun({ consentId: preview.id, consentDigest: "sha256:wrong" }),
  );
  assert.equal(requests.length, 0);

  const started = await fixture.app.startAgentRun({
    consentId: preview.id,
    consentDigest: preview.consentDigest,
  });
  await fixture.app.settled();

  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.workspace.rootDigest, rootDigest);
  assert.equal(requests[0]!.systemPrompt, profile.systemPrompt);
  assert.deepEqual(requests[0]!.workspace.allowedTools, [PROJECT_CHANGES_TOOL.name]);
  assert.deepEqual(Object.keys(requests[0]!).sort(), [
    "profileId",
    "signal",
    "systemPrompt",
    "task",
    "tools",
    "workspace",
  ]);
  const serializedRunnerInput = JSON.stringify(requests[0]);
  assert.equal(serializedRunnerInput.includes(projectRoot), false);
  assert.equal(serializedRunnerInput.includes("workspace-secret-fixture"), false);
  assert.equal(fixture.app.get(started.id)?.status, "idle");
  assert.equal(responses.length, 2);
  assert.equal(responses[0]?.kind, "result");
  assert.equal(responses[1]?.kind, "error");
  const ledger = await fixture.app.ledger(started.workspace);
  assert.equal(ledger?.result.ok, true);
  const entries = (ledger?.entries ?? []).map(
    (entry) => entry.body as Record<string, unknown>,
  );
  assert.equal(entries.some((body) =>
    body.requestedTool === PROJECT_EXEC_TOOL.name && body.decision === "deny",
  ), true);
  assert.equal(entries.some((body) => body.tool === PROJECT_EXEC_TOOL.name), false);
  const serializedLedger = JSON.stringify(ledger?.entries);
  assert.equal(serializedLedger.includes("do-not-persist-this-secret task"), false);
});

test("a mutable runner description cannot rewrite the consent snapshot", async (t) => {
  const description = {
    id: "mutable-runner",
    displayName: "Runner before consent",
    provider: "fixture",
    endpoint: "https://fixture.invalid/v1",
    dataTransfer: "remote" as const,
    dataSent: ["task", "system-prompt", "tool-arguments", "tool-results"] as const,
    profiles: ["safe"],
    execution: "local" as const,
    toolAccess: "mediated" as const,
    workspaceMode: "approved-copy" as const,
    cancellation: "confirmed" as const,
  };
  let response: AgentRunToolResponse | undefined;
  const runner: AgentRunner = {
    describe: () => description,
    async start() {
      description.displayName = "Runner after consent";
      return {
        id: "mutable-run",
        events: (async function* () {
          yield {
            type: "tool-request",
            runId: "mutable-run",
            sequence: 1,
            requestId: "changes-1",
            toolName: PROJECT_CHANGES_TOOL.name,
            argsJson: '{"operation":"status"}',
          } as AgentRunEvent;
          yield {
            type: "tool-result",
            runId: "mutable-run",
            sequence: 2,
            requestId: "changes-1",
            resultJson: "refused",
          } as AgentRunEvent;
          yield { type: "terminal", runId: "mutable-run", sequence: 3, status: "completed" } as AgentRunEvent;
        })(),
        async respondToTool(_requestId, result) {
          response = result;
        },
      };
    },
    async cancel() { return "confirmed"; },
  };
  const fixture = await isolatedWorkbench(
    t,
    undefined,
    { NOMO_PERMISSION_MODE: "normal" },
    { configure: false, agentRunners: [runner] },
  );
  fixture.app.upsertAgent(profile);
  const projectRoot = await mkdtemp(join(tmpdir(), "nomo-agent-runner-description-"));
  execFileSync("git", ["init", "--quiet"], { cwd: projectRoot, stdio: "ignore" });
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await fixture.app.confirmProjectAccess(projectRoot, []);
  const preview = await fixture.app.prepareAgentRun({
    runnerId: description.id,
    task: "review current project",
    profileId: profile.id,
    runnerProfileId: "safe",
  });
  const started = await fixture.app.startAgentRun({
    consentId: preview.id,
    consentDigest: preview.consentDigest,
  });
  await fixture.app.settled();

  assert.equal(response?.kind, "error");
  const decisions = (await fixture.app.ledger(started.workspace))?.entries.map(
    (entry) => (entry.body as Record<string, unknown>).decision,
  );
  assert.equal(decisions?.includes("deny"), true);
  assert.equal(decisions?.includes("execute:completed"), false);
});

test("unconfirmed cancellation is recorded as unknown and stops the run", async (t) => {
  let release!: () => void;
  const waitForCancel = new Promise<void>((resolve) => { release = resolve; });
  const runner: AgentRunner = {
    describe: () => ({
      id: "uncertain-runner",
      displayName: "Uncertain runner",
      provider: "fixture",
      endpoint: "https://fixture.invalid/v1",
      dataTransfer: "remote",
      dataSent: ["task", "system-prompt", "tool-arguments", "tool-results"],
      profiles: ["safe"],
      execution: "local",
      toolAccess: "mediated",
      workspaceMode: "approved-copy",
      cancellation: "may-be-unknown",
    }),
    async start() {
      return {
        id: "uncertain-run",
        events: (async function* () {
          yield { type: "status", runId: "uncertain-run", sequence: 1, status: "running" } as AgentRunEvent;
          await waitForCancel;
          yield { type: "terminal", runId: "uncertain-run", sequence: 2, status: "unknown" } as AgentRunEvent;
        })(),
        async respondToTool() { throw new Error("No tool request expected."); },
      };
    },
    async cancel() {
      release();
      return "unknown";
    },
  };
  const fixture = await isolatedWorkbench(
    t,
    undefined,
    { NOMO_PERMISSION_MODE: "normal" },
    { configure: false, agentRunners: [runner] },
  );
  fixture.app.upsertAgent(profile);
  const projectRoot = await mkdtemp(join(tmpdir(), "nomo-agent-runner-cancel-"));
  execFileSync("git", ["init", "--quiet"], { cwd: projectRoot, stdio: "ignore" });
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await fixture.app.confirmProjectAccess(projectRoot, []);
  const preview = await fixture.app.prepareAgentRun({
    runnerId: "uncertain-runner",
    task: "inspect only",
    profileId: profile.id,
    runnerProfileId: "safe",
  });
  const started = await fixture.app.startAgentRun({
    consentId: preview.id,
    consentDigest: preview.consentDigest,
  });

  assert.equal(await fixture.app.cancelAgentRun(started.id), "unknown");
  await fixture.app.settled();

  assert.equal(fixture.app.get(started.id)?.status, "unknown");
  const ledger = await fixture.app.ledger(started.workspace);
  assert.equal(ledger?.result.ok, true);
  assert.equal(
    (ledger?.entries ?? []).some(
      (entry) => (entry.body as Record<string, unknown>).decision === "unknown",
    ),
    true,
  );
});

test("a revoked project grant blocks a queued runner tool request", async (t) => {
  let release!: () => void;
  let resolveStarted!: () => void;
  let resolveResponse!: (response: AgentRunToolResponse) => void;
  const waitForRelease = new Promise<void>((resolve) => { release = resolve; });
  const runnerStarted = new Promise<void>((resolve) => { resolveStarted = resolve; });
  const toolResponse = new Promise<AgentRunToolResponse>((resolve) => {
    resolveResponse = resolve;
  });
  let response: AgentRunToolResponse | undefined;
  const runner: AgentRunner = {
    describe: () => ({
      id: "revocation-runner",
      displayName: "Revocation runner",
      provider: "fixture",
      endpoint: "https://fixture.invalid/v1",
      dataTransfer: "remote",
      dataSent: ["task", "system-prompt", "tool-arguments", "tool-results"],
      profiles: ["safe"],
      execution: "local",
      toolAccess: "mediated",
      workspaceMode: "approved-copy",
      cancellation: "confirmed",
    }),
    async start() {
      resolveStarted();
      return {
        id: "revocation-run",
        events: (async function* () {
          yield { type: "status", runId: "revocation-run", sequence: 1, status: "running" } as AgentRunEvent;
          await waitForRelease;
          yield {
            type: "tool-request",
            runId: "revocation-run",
            sequence: 2,
            requestId: "revoked-call",
            toolName: PROJECT_CHANGES_TOOL.name,
            argsJson: '{"operation":"status"}',
          } as AgentRunEvent;
          const result = await toolResponse;
          yield {
            type: "tool-result",
            runId: "revocation-run",
            sequence: 3,
            requestId: "revoked-call",
            resultJson: result.kind === "result" ? result.resultJson : result.message,
          } as AgentRunEvent;
          yield { type: "terminal", runId: "revocation-run", sequence: 4, status: "completed" } as AgentRunEvent;
        })(),
        async respondToTool(_requestId, result) {
          response = result;
          resolveResponse(result);
        },
      };
    },
    async cancel() { return "confirmed"; },
  };
  const fixture = await isolatedWorkbench(
    t,
    undefined,
    { NOMO_PERMISSION_MODE: "normal" },
    { configure: false, agentRunners: [runner] },
  );
  fixture.app.upsertAgent(profile);
  const projectRoot = await mkdtemp(join(tmpdir(), "nomo-agent-runner-revoke-"));
  execFileSync("git", ["init", "--quiet"], { cwd: projectRoot, stdio: "ignore" });
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await fixture.app.confirmProjectAccess(projectRoot, []);
  const preview = await fixture.app.prepareAgentRun({
    runnerId: "revocation-runner",
    task: "review current project",
    profileId: profile.id,
    runnerProfileId: "safe",
  });
  const started = await fixture.app.startAgentRun({
    consentId: preview.id,
    consentDigest: preview.consentDigest,
  });
  await runnerStarted;
  await fixture.app.revokeProjectAccess();
  release();
  await fixture.app.settled();

  assert.equal(response?.kind, "error");
  const ledger = await fixture.app.ledger(started.workspace);
  assert.equal(ledger?.result.ok, true);
  const decisions = (ledger?.entries ?? []).map(
    (entry) => (entry.body as Record<string, unknown>).decision,
  );
  assert.equal(decisions.includes("deny"), true);
  assert.equal(decisions.includes("execute:completed"), false);
});
test("a policy changed during runner approval denies the write before dispatch", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nomo-agent-runner-policy-"));
  const policies = join(directory, "policies");
  await mkdir(policies);
  const policyPath = join(policies, "operator.yaml");
  const customPolicyPath = join(policies, "mutable.yaml");
  const holdPolicy =
    "version: 1\nrules:\n  - match: {}\n    decision: hold\n    seconds: 300\n    notify: [cli]\n";
  const denyPolicy =
    "version: 1\nrules:\n  - match: {}\n    decision: deny\n    rationale: policy changed during approval\n";
  await writeFile(policyPath, holdPolicy);
  await writeFile(customPolicyPath, holdPolicy);
  t.after(() => rm(directory, { recursive: true, force: true }));

  let resolveResponse!: (response: AgentRunToolResponse) => void;
  let toolResponse: AgentRunToolResponse | undefined;
  const response = new Promise<AgentRunToolResponse>((resolve) => {
    resolveResponse = resolve;
  });
  const runner: AgentRunner = {
    describe: () => ({
      id: "policy-runner",
      displayName: "Policy runner",
      provider: "fixture",
      endpoint: "https://fixture.invalid/v1",
      dataTransfer: "remote",
      dataSent: ["task", "system-prompt", "tool-arguments", "tool-results"],
      profiles: ["safe"],
      execution: "local",
      toolAccess: "mediated",
      workspaceMode: "approved-copy",
      cancellation: "confirmed",
    }),
    async start() {
      return {
        id: "policy-run",
        events: (async function* () {
          yield { type: "tool-request", runId: "policy-run", sequence: 1, requestId: "write-1", toolName: "void_workspace_write", argsJson: '{"path":"note","content":"must not be written"}' } as AgentRunEvent;
          const result = await response;
          yield { type: "tool-result", runId: "policy-run", sequence: 2, requestId: "write-1", resultJson: result.kind === "result" ? result.resultJson : result.message } as AgentRunEvent;
          yield { type: "terminal", runId: "policy-run", sequence: 3, status: "completed" } as AgentRunEvent;
        })(),
        async respondToTool(_requestId, result) {
          toolResponse = result;
          resolveResponse(result);
        },
      };
    },
    async cancel() { return "confirmed"; },
  };
  const fixture = await isolatedWorkbench(
    t,
    undefined,
    { NOMO_PERMISSION_MODE: "normal", NOMO_POLICY_PATH: policyPath },
    { configure: false, agentRunners: [runner] },
  );
  fixture.app.upsertAgent({
    ...profile,
    id: "policy-writer",
    allowedTools: ["void_workspace_write"],
    policyProfile: "mutable",
  });
  const projectRoot = await mkdtemp(join(tmpdir(), "nomo-agent-runner-policy-project-"));
  execFileSync("git", ["init", "--quiet"], { cwd: projectRoot, stdio: "ignore" });
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await fixture.app.confirmProjectAccess(projectRoot, []);
  const preview = await fixture.app.prepareAgentRun({
    runnerId: "policy-runner",
    task: "write the note",
    profileId: "policy-writer",
    runnerProfileId: "safe",
  });
  const started = await fixture.app.startAgentRun({
    consentId: preview.id,
    consentDigest: preview.consentDigest,
  });

  for (let attempt = 0; attempt < 200 && !fixture.app.pending().length; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  const hold = fixture.app.pending()[0];
  assert.ok(hold, "runner tool call must wait for operator approval");
  await writeFile(customPolicyPath, denyPolicy);
  assert.equal(
    fixture.app.decide(hold.holdId, { kind: "approved", by: "test-operator" }),
    true,
  );
  await fixture.app.settled();
  assert.equal(fixture.app.document(started.id, "note").content, null);
  assert.equal(toolResponse?.kind, "result");
  assert.match(
    toolResponse?.kind === "result" ? toolResponse.resultJson : "",
    /policy changed while authorization was pending/,
  );
  const decisions = (await fixture.app.ledger(started.workspace))?.entries.map(
    (entry) => (entry.body as Record<string, unknown>).decision,
  );
  assert.equal(decisions?.includes("execute:refused"), true);

});
test("a runner stream without terminal evidence remains unknown", async (t) => {
  let cancelCalls = 0;
  const runner: AgentRunner = {
    describe: () => ({
      id: "truncated-runner",
      displayName: "Truncated runner",
      provider: "fixture",
      endpoint: "https://fixture.invalid/v1",
      dataTransfer: "remote",
      dataSent: ["task", "system-prompt", "tool-arguments", "tool-results"],
      profiles: ["safe"],
      execution: "local",
      toolAccess: "mediated",
      workspaceMode: "approved-copy",
      cancellation: "may-be-unknown",
    }),
    async start() {
      return {
        id: "truncated-run",
        events: (async function* () {
          yield { type: "status", runId: "truncated-run", sequence: 1, status: "running" } as AgentRunEvent;
        })(),
        async respondToTool() {},
      };
    },
    async cancel() {
      cancelCalls++;
      return "unknown";
    },
  };
  const fixture = await isolatedWorkbench(
    t,
    undefined,
    { NOMO_PERMISSION_MODE: "normal" },
    { configure: false, agentRunners: [runner] },
  );
  fixture.app.upsertAgent(profile);
  const projectRoot = await mkdtemp(join(tmpdir(), "nomo-agent-runner-truncated-"));
  execFileSync("git", ["init", "--quiet"], { cwd: projectRoot, stdio: "ignore" });
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await fixture.app.confirmProjectAccess(projectRoot, []);
  const preview = await fixture.app.prepareAgentRun({
    runnerId: "truncated-runner",
    task: "inspect project",
    profileId: profile.id,
    runnerProfileId: "safe",
  });
  const started = await fixture.app.startAgentRun({
    consentId: preview.id,
    consentDigest: preview.consentDigest,
  });
  await fixture.app.settled();

  assert.equal(cancelCalls, 1);
  assert.equal(fixture.app.get(started.id)?.status, "unknown");
  const ledger = await fixture.app.ledger(started.workspace);
  assert.equal(ledger?.entries.some((entry) => {
    const body = entry.body as Record<string, unknown>;
    return body.tool === "agent_runner.terminal" && body.decision === "unknown";
  }), true);
});

test("an allowed project command refuses before dispatch when no sandbox is configured", async (t) => {
  let hostFallback = "";
  let resolveResponse!: (response: AgentRunToolResponse) => void;
  let response: AgentRunToolResponse | undefined;
  const waitingForTool = new Promise<AgentRunToolResponse>((resolve) => {
    resolveResponse = resolve;
  });
  const runner: AgentRunner = {
    describe: () => ({
      id: "unconfigured-sandbox-runner",
      displayName: "Unconfigured sandbox runner",
      provider: "fixture",
      endpoint: "https://fixture.invalid/v1",
      dataTransfer: "remote",
      dataSent: ["task", "system-prompt", "tool-arguments", "tool-results"],
      profiles: ["safe"],
      execution: "local",
      toolAccess: "mediated",
      workspaceMode: "approved-copy",
      cancellation: "confirmed",
    }),
    async start() {
      return {
        id: "unconfigured-sandbox-run",
        events: (async function* () {
          yield {
            type: "tool-request",
            runId: "unconfigured-sandbox-run",
            sequence: 1,
            requestId: "host-fallback",
            toolName: PROJECT_EXEC_TOOL.name,
            argsJson: JSON.stringify({ command: `touch ${hostFallback}` }),
          } as AgentRunEvent;
          const result = await waitingForTool;
          yield {
            type: "tool-result",
            runId: "unconfigured-sandbox-run",
            sequence: 2,
            requestId: "host-fallback",
            resultJson: result.kind === "result" ? result.resultJson : result.message,
          } as AgentRunEvent;
          yield {
            type: "terminal",
            runId: "unconfigured-sandbox-run",
            sequence: 3,
            status: "completed",
          } as AgentRunEvent;
        })(),
        async respondToTool(_requestId, result) {
          response = result;
          resolveResponse(result);
        },
      };
    },
    async cancel() { return "confirmed"; },
  };
  const fixture = await isolatedWorkbench(
    t,
    undefined,
    { NOMO_PERMISSION_MODE: "normal" },
    { configure: false, agentRunners: [runner] },
  );
  const commandProfile = {
    ...profile,
    id: "runner-command",
    allowedTools: [PROJECT_EXEC_TOOL.name],
  };
  fixture.app.upsertAgent(commandProfile);
  const projectRoot = await mkdtemp(join(tmpdir(), "nomo-agent-runner-no-sandbox-"));
  execFileSync("git", ["init", "--quiet"], { cwd: projectRoot, stdio: "ignore" });
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await fixture.app.confirmProjectAccess(projectRoot, []);
  hostFallback = join(projectRoot, "host-fallback");
  const preview = await fixture.app.prepareAgentRun({
    runnerId: "unconfigured-sandbox-runner",
    task: "run a project command",
    profileId: commandProfile.id,
    runnerProfileId: "safe",
  });
  const started = await fixture.app.startAgentRun({
    consentId: preview.id,
    consentDigest: preview.consentDigest,
  });
  for (let attempt = 0; attempt < 200 && !fixture.app.pending().length; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  const hold = fixture.app.pending()[0];
  assert.ok(hold, "R3 project command must wait for policy approval");
  assert.equal(
    fixture.app.decide(hold.holdId, { kind: "approved", by: "test-operator" }),
    true,
  );
  await fixture.app.settled();

  assert.equal(response?.kind, "result");
  assert.match(
    response?.kind === "result" ? response.resultJson : "",
    /NOMO_PROJECT_SANDBOX_RUNTIME/,
  );
  await assert.rejects(access(hostFallback));
  const entries = (await fixture.app.ledger(started.workspace))?.entries.map(
    (entry) => entry.body as Record<string, unknown>,
  );
  assert.equal(entries?.some(
    (body) => body.tool === PROJECT_EXEC_TOOL.name && body.decision === "dispatch:started",
  ), false);
});
test("AWS access-key IDs from the environment are withheld from runner output", async (t) => {
  const secret = "SYNTHETIC_ACCESS_ID_8472";
  let runCount = 0;
  const runner: AgentRunner = {
    describe: () => ({
      id: "output-fixture",
      displayName: "Output fixture",
      provider: "fixture",
      endpoint: "https://fixture.invalid/v1",
      dataTransfer: "remote",
      dataSent: ["task"],
      profiles: ["safe"],
      execution: "local",
      toolAccess: "mediated",
      workspaceMode: "approved-copy",
      cancellation: "confirmed",
    }),
    async start() {
      const runId = `output-run-${++runCount}`;
      const events: AgentRunEvent[] = runCount === 1
        ? [
            { type: "assistant-message", runId, sequence: 1, text: "Safe answer." } as AgentRunEvent,
            { type: "assistant-message", runId, sequence: 2, text: `Echo: ${secret}` } as AgentRunEvent,
            { type: "terminal", runId, sequence: 3, status: "failed", message: "Safe failure detail." } as AgentRunEvent,
          ]
        : [
            { type: "assistant-message", runId, sequence: 1, text: "Stopping safely." } as AgentRunEvent,
            { type: "terminal", runId, sequence: 2, status: "cancelled", message: "Cancellation confirmed." } as AgentRunEvent,
          ];
      return {
        id: runId,
        events: (async function* () { yield* events; })(),
        async respondToTool() { throw new Error("No tool expected."); },
      };
    },
    async cancel() { return "confirmed"; },
  };
  const fixture = await isolatedWorkbench(
    t,
    undefined,
    { AWS_ACCESS_KEY_ID: secret },
    { configure: false, agentRunners: [runner] },
  );
  fixture.app.upsertAgent(profile);
  const projectRoot = await mkdtemp(join(tmpdir(), "nomo-agent-runner-output-"));
  execFileSync("git", ["init", "--quiet"], { cwd: projectRoot, stdio: "ignore" });
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await fixture.app.confirmProjectAccess(projectRoot, []);

  const start = async () => {
    const preview = await fixture.app.prepareAgentRun({
      runnerId: "output-fixture",
      task: "Summarize this project.",
      profileId: profile.id,
      runnerProfileId: "safe",
    });
    const session = await fixture.app.startAgentRun({
      consentId: preview.id,
      consentDigest: preview.consentDigest,
    });
    await fixture.app.settled();
    return fixture.app.get(session.id)!;
  };

  const failed = await start();
  assert.equal(failed.status, "failed");
  const failedMessages = failed.events.filter((event) => event.kind === "assistant");
  assert.equal(failedMessages.some((event) => event.text === "Safe answer."), true);
  assert.equal(failedMessages.some((event) => event.text === "Safe failure detail."), true);
  assert.equal(JSON.stringify(failed.events).includes(secret), false);
  const failedLedger = await fixture.app.ledger(failed.workspace);
  assert.equal(JSON.stringify(failedLedger?.entries).includes("Safe answer."), false);
  assert.equal(JSON.stringify(failedLedger?.entries).includes("Safe failure detail."), false);

  const cancelled = await start();
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.events.some(
    (event) => event.kind === "assistant" && event.text === "Cancellation confirmed.",
  ), true);
  const persistedState = await readFile(join(fixture.root, "workspace.enc"), "utf8");
  assert.equal(persistedState.includes("Safe answer."), false);
  assert.equal(persistedState.includes("Safe failure detail."), false);
});
test("runner output is truncated on UTF-8 boundaries and bounded across the run", async (t) => {
  const texts = [
    `${"A".repeat(16 * 1024 - 1)}🧠discarded`,
    "B".repeat(16 * 1024),
    "C".repeat(16 * 1024),
    "D".repeat(16 * 1024),
    "E".repeat(16 * 1024),
    "discarded after budget",
  ];
  const runner: AgentRunner = {
    describe: () => ({
      id: "bounded-output-fixture",
      displayName: "Bounded output fixture",
      provider: "fixture",
      endpoint: "https://fixture.invalid/v1",
      dataTransfer: "remote",
      dataSent: ["task"],
      profiles: ["safe"],
      execution: "local",
      toolAccess: "mediated",
      workspaceMode: "approved-copy",
      cancellation: "confirmed",
    }),
    async start() {
      const runId = "bounded-output-run";
      return {
        id: runId,
        events: (async function* () {
          for (let index = 0; index < texts.length; index++)
            yield {
              type: "assistant-message",
              runId,
              sequence: index + 1,
              text: texts[index]!,
            } as AgentRunEvent;
          yield {
            type: "terminal",
            runId,
            sequence: texts.length + 1,
            status: "completed",
          } as AgentRunEvent;
        })(),
        async respondToTool() { throw new Error("No tool expected."); },
      };
    },
    async cancel() { return "confirmed"; },
  };
  const fixture = await isolatedWorkbench(
    t,
    undefined,
    { NOMO_PERMISSION_MODE: "normal" },
    { configure: false, agentRunners: [runner] },
  );
  fixture.app.upsertAgent(profile);
  const projectRoot = await mkdtemp(join(tmpdir(), "nomo-agent-runner-output-limit-"));
  execFileSync("git", ["init", "--quiet"], { cwd: projectRoot, stdio: "ignore" });
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await fixture.app.confirmProjectAccess(projectRoot, []);
  const preview = await fixture.app.prepareAgentRun({
    runnerId: "bounded-output-fixture",
    task: "Summarize this project.",
    profileId: profile.id,
    runnerProfileId: "safe",
  });
  const session = await fixture.app.startAgentRun({
    consentId: preview.id,
    consentDigest: preview.consentDigest,
  });
  await fixture.app.settled();

  const messages = fixture.app.get(session.id)!.events.filter(
    (event) => event.kind === "assistant",
  );
  assert.equal(Buffer.byteLength(messages[0]!.text, "utf8"), 16 * 1024 - 1);
  assert.equal(messages[0]!.payload?.textTruncated, true);
  assert.equal(messages[0]!.text.includes("🧠"), false);
  assert.equal(messages[4]!.text, "E");
  assert.equal(messages[4]!.payload?.textTruncated, true);
  assert.equal(messages[5]!.text, "Další výstup agenta byl zkrácen kvůli limitu velikosti.");
  assert.equal(messages.filter((event) => event.text === "Další výstup agenta byl zkrácen kvůli limitu velikosti.").length, 1);
  assert.equal(Buffer.byteLength(messages.slice(0, 5).map((event) => event.text).join(""), "utf8"), 64 * 1024);
  assert.equal(messages.some((event) => event.text.includes("discarded")), false);
});
