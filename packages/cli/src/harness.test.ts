import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHarnessCommand, type HarnessSurface } from "./harness.ts";
import { defaultHarnessSettings } from "../../workbench/src/harness-settings.ts";

/**
 * The harness command, at the boundary an operator or a script touches.
 *
 * What matters here is that a decision binds to the exact digest, that a
 * rejection carries its reason, and that a refusal from the workbench is
 * printed as its own sentence rather than swallowed: a script that cannot
 * tell a refusal from a success will treat a rejected proposal as approved.
 */

const proposal = {
  digest: "a".repeat(64),
  at: "2026-10-20T10:00:00.000Z",
  summary: "repeated lesson",
  proposal: {
    edits: [
      {
        action: "create",
        kind: "memory",
        title: "approval pattern",
        content: "The operator repeatedly approved the same action.",
        derivedFromSeq: [1, 2],
      },
    ],
  },
};

function fake(overrides: Partial<HarnessSurface> = {}) {
  const calls: { method: string; args: readonly string[] }[] = [];
  const surface: HarnessSurface = {
    async pendingApprovalsFor(sessionId) {
      calls.push({ method: "list", args: [sessionId] });
      return [proposal];
    },
    async approveHarnessProposal(sessionId, digest) {
      calls.push({ method: "approve", args: [sessionId, digest] });
      return { applied: [{ outcome: "created" }] };
    },
    async rejectHarnessProposal(sessionId, digest, reason) {
      calls.push({ method: "reject", args: [sessionId, digest, reason ?? ""] });
    },
    async rollbackHarnessProposal(sessionId, digest) {
      calls.push({ method: "rollback", args: [sessionId, digest] });
      return { applied: [{ outcome: "deleted" }] };
    },
    async harnessEntries(sessionId) {
      calls.push({ method: "entries", args: [sessionId] });
      return [
        {
          id: "lesson-1",
          kind: "lesson",
          title: "approval pattern",
          content: "The operator repeatedly approved the same action.",
          tool: "postgres.row.update",
          klass: "r2",
          repeats: 3,
          decidedByOperator: true,
        },
      ];
    },
    harnessTextSettings() {
      return { refinementModel: "" };
    },
    patchHarnessTextSettings(body) {
      calls.push({ method: "model", args: [String(body.refinementModel ?? "")] });
      return { refinementModel: String(body.refinementModel ?? "") };
    },
    ...overrides,
  };
  return { surface, calls };
}

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    stdout: (line: string) => out.push(line),
    stderr: (line: string) => err.push(line),
    out,
    err,
  };
}

test("list prints the digest a decision binds to and the proposal it covers", async () => {
  const { surface } = fake();
  const terminal = io();
  const code = await runHarnessCommand(
    ["list", "--session", "s1"],
    terminal,
    { workbench: async () => surface },
  );
  assert.equal(code, 0);
  const text = terminal.out.join("\n");
  assert.match(text, new RegExp(proposal.digest));
  assert.match(text, /repeated lesson/);
  assert.match(text, /create memory/);
  assert.match(text, /records 1, 2/);
});

test("approve binds to the digest it was given", async () => {
  const { surface, calls } = fake();
  const terminal = io();
  const code = await runHarnessCommand(
    ["approve", "--session", "s1", proposal.digest],
    terminal,
    { workbench: async () => surface },
  );
  assert.equal(code, 0);
  assert.deepEqual(calls, [
    { method: "approve", args: ["s1", proposal.digest] },
  ]);
});

test("a rejection needs a reason and carries it", async () => {
  const { surface, calls } = fake();
  const terminal = io();
  const missing = await runHarnessCommand(
    ["reject", "--session", "s1", proposal.digest],
    terminal,
    { workbench: async () => surface },
  );
  assert.equal(missing, 1);
  assert.match(terminal.err.join("\n"), /needs a reason/);

  const withReason = await runHarnessCommand(
    ["reject", "--session", "s1", proposal.digest, "--reason", "one call is not a pattern"],
    io(),
    { workbench: async () => surface },
  );
  assert.equal(withReason, 0);
  assert.deepEqual(calls, [
    {
      method: "reject",
      args: ["s1", proposal.digest, "one call is not a pattern"],
    },
  ]);
});

test("a rollback undoes the digest it was given", async () => {
  const { surface, calls } = fake();
  const terminal = io();
  const code = await runHarnessCommand(
    ["rollback", "--session", "s1", proposal.digest],
    terminal,
    { workbench: async () => surface },
  );
  assert.equal(code, 0);
  assert.deepEqual(calls, [
    { method: "rollback", args: ["s1", proposal.digest] },
  ]);
});


test("run-eval starts one attributed production run and waits for its terminal state", async () => {
  let seen:
    | {
        prompt: string;
        model: string | undefined;
        attribution: unknown;
        agent: string | undefined;
        idempotencyKey: string | undefined;
      }
    | undefined;
  let waited = "";
  const surface = fake({
    async startHarnessEval(prompt, model, attribution, agent, idempotencyKey) {
      seen = { prompt, model, attribution, agent, idempotencyKey };
      return { id: "eval-session-1", status: "running" };
    },
    async waitForRun(id) {
      waited = id;
      return { status: "idle" };
    },
  }).surface;
  const terminal = io();
  const code = await runHarnessCommand(
    [
      "run-eval",
      "--case", "case-api",
      "--variant", "sha256:" + "a".repeat(64),
      "--run", "2",
      "--model", "fixture-model",
      "--agent", "fixture-agent",
      "--prompt", "Write the managed note.",
      "--idempotency-key", "eval-cli-key-1",
    ],
    terminal,
    { workbench: async () => surface },
  );
  assert.equal(code, 0, terminal.err.join(" "));
  assert.deepEqual(seen, {
    prompt: "Write the managed note.",
    model: "fixture-model",
    agent: "fixture-agent",
    idempotencyKey: "eval-cli-key-1",
    attribution: {
      caseId: "case-api",
      variantId: "sha256:" + "a".repeat(64),
      run: 2,
    },
  });
  assert.equal(waited, "eval-session-1");
  assert.match(terminal.out.join("\n"), /run-eval: session eval-session-1 status idle/);
});

test("run-eval reads a prompt file and refuses malformed attribution before starting", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nomo-run-eval-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const promptFile = join(dir, "prompt.txt");
  await writeFile(promptFile, "Prompt from a file.\n");
  let starts = 0;
  const surface = fake({
    async startHarnessEval() {
      starts += 1;
      return { id: "eval-session-1" };
    },
    async waitForRun() {
      return { status: "idle" };
    },
  }).surface;

  const valid = io();
  const validCode = await runHarnessCommand(
    [
      "run-eval",
      "--case", "case-file",
      "--variant", "variant-a",
      "--run", "1",
      "--prompt-file", promptFile,
    ],
    valid,
    { workbench: async () => surface },
  );
  assert.equal(validCode, 0, valid.err.join(" "));
  assert.equal(starts, 1);

  const invalid = io();
  const invalidCode = await runHarnessCommand(
    [
      "run-eval",
      "--case", "case-file",
      "--variant", "variant-a",
      "--run", "0",
      "--prompt-file", promptFile,
    ],
    invalid,
    { workbench: async () => surface },
  );
  assert.equal(invalidCode, 1);
  assert.equal(starts, 1, "invalid attribution never starts a run");
  assert.match(invalid.err.join("\n"), /run must be a whole number/);

  const both = io();
  const bothCode = await runHarnessCommand(
    [
      "run-eval",
      "--case", "case-file",
      "--variant", "variant-a",
      "--run", "1",
      "--prompt", "inline",
      "--prompt-file", promptFile,
    ],
    both,
    { workbench: async () => surface },
  );
  assert.equal(bothCode, 1);
  assert.equal(starts, 1, "ambiguous prompt input never starts a run");
  assert.match(both.err.join("\n"), /exactly one prompt source/);
});

test("run-eval returns nonzero for a non-idle terminal state without hiding it", async () => {
  const surface = fake({
    async startHarnessEval() {
      return { id: "eval-session-1" };
    },
    async waitForRun() {
      return { status: "failed" };
    },
  }).surface;
  const terminal = io();
  const code = await runHarnessCommand(
    [
      "run-eval",
      "--case", "case-api",
      "--variant", "variant-a",
      "--run", "1",
      "--prompt", "Write the note.",
    ],
    terminal,
    { workbench: async () => surface },
  );
  assert.equal(code, 1);
  assert.match(terminal.out.join("\n"), /status failed/);
});

test("a refusal from the workbench is printed as its own sentence", async () => {
  const { surface } = fake({
    async approveHarnessProposal() {
      throw new Error("No pending refinement matches that digest.");
    },
  });
  const terminal = io();
  const code = await runHarnessCommand(
    ["approve", "--session", "s1", "b".repeat(64)],
    terminal,
    { workbench: async () => surface },
  );
  assert.equal(code, 1);
  assert.match(terminal.err.join("\n"), /No pending refinement matches that digest\./);
  assert.equal(terminal.out.length, 0);
});

test("an unknown action, an unknown option and a missing session are refused by name", async () => {
  const { surface, calls } = fake();
  const terminal = io();
  const unknownAction = await runHarnessCommand(
    ["destroy"],
    terminal,
    { workbench: async () => surface },
  );
  assert.equal(unknownAction, 1);
  assert.match(terminal.err.join("\n"), /Unknown harness action destroy\./);

  const unknownOption = await runHarnessCommand(
    ["list", "--sessions", "s1"],
    io(),
    { workbench: async () => surface },
  );
  assert.equal(unknownOption, 1);

  const noSession = await runHarnessCommand(["list"], io(), {
    workbench: async () => surface,
  });
  assert.equal(noSession, 1);

  const misplaced = await runHarnessCommand(
    ["list", "--session", "s1", "--case", "case-1"],
    io(),
    { workbench: async () => surface },
  );
  assert.equal(misplaced, 1);
  assert.deepEqual(calls, []);
});

test("a machine with no workspace is refused, and none is created", async () => {
  const directory = join(tmpdir(), "nomo-harness-no-workspace-" + Date.now());
  const terminal = io();
  const code = await runHarnessCommand(["list", "--session", "s1"], terminal, {
    env: { NOMO_DATA_DIR: directory },
  });
  assert.equal(code, 1);
  assert.match(terminal.err.join("\n"), /No workspace at/);
  assert.equal(
    existsSync(directory),
    false,
    "a command that only reads must not create the workspace it would read",
  );
});

test("a digest prefix is refused even when it names exactly one proposal", async () => {
  const { surface, calls } = fake();
  const terminal = io();
  const code = await runHarnessCommand(
    ["approve", "--session", "s1", proposal.digest.slice(0, 8)],
    terminal,
    { workbench: async () => surface },
  );
  assert.equal(code, 1);
  assert.match(terminal.err.join("\n"), /full 64 hexadecimal digest/);
  assert.deepEqual(calls, []);
});

test("a malformed digest is refused before any pending list is read", async () => {
  const { surface, calls } = fake();
  const terminal = io();
  const code = await runHarnessCommand(
    ["approve", "--session", "s1", "fffffff"],
    terminal,
    { workbench: async () => surface },
  );
  assert.equal(code, 1);
  assert.match(terminal.err.join("\n"), /full 64 hexadecimal digest/);
  assert.deepEqual(calls, []);
});

test("entries shows what the harness holds", async () => {
  const { surface, calls } = fake();
  const terminal = io();
  const code = await runHarnessCommand(["entries", "--session", "s1"], terminal, {
    workbench: async () => surface,
  });
  assert.equal(code, 0);
  const text = terminal.out.join("\n");
  assert.match(text, /lesson-1/);
  assert.match(text, /operator/);
  assert.match(text, /postgres\.row\.update\/r2/);
  assert.deepEqual(calls, [{ method: "entries", args: ["s1"] }]);
});

test("the reviewer model is shown, set and cleared", async () => {
  const { surface, calls } = fake();
  const shown = io();
  const read = await runHarnessCommand(["model"], shown, {
    workbench: async () => surface,
  });
  assert.equal(read, 0);
  assert.match(shown.out.join("\n"), /conversation's own model/);

  const set = io();
  const written = await runHarnessCommand(["model", "reviewer-1"], set, {
    workbench: async () => surface,
  });
  assert.equal(written, 0);
  assert.match(set.out.join("\n"), /reviewer-1/);

  const cleared = io();
  const clearedCode = await runHarnessCommand(["model", "--clear"], cleared, {
    workbench: async () => surface,
  });
  assert.equal(clearedCode, 0);
  assert.deepEqual(
    calls.filter((call) => call.method === "model").map((call) => call.args[0]),
    ["reviewer-1", ""],
  );
});

test("no action prints the usage and fails", async () => {
  const terminal = io();
  const code = await runHarnessCommand([], terminal, {
    workbench: async () => fake().surface,
  });
  assert.equal(code, 1);
  assert.match(terminal.out.join("\n"), /nomo harness list --session/);
});

test("entries prints a mined rule as policy text under the entry", async () => {
  // The rule is not in force. Printing it is only useful if the operator can
  // paste it into their own file, so the command prints the text the workbench
  // built beside the rule rather than formatting a second copy here. The
  // loader-validity half of this lives with that builder, in learned-rules.
  const { surface } = fake();
  const withRule: HarnessSurface = {
    ...surface,
    harnessEntries: async () => [
      {
        id: "le_rule_1",
        kind: "rule",
        title: "refused this call shape",
        content: "Refused 3 times on the signed ledger. Not written by an operator.",
        tool: "fs.delete",
        klass: "r3",
        repeats: 3,
        policyText: [
          "- match:",
          "    class: r3",
          "    tool: fs.delete",
          "  decision: hold",
          "  seconds: 300",
          "  notify: [cli]",
          '  rationale: "Refused 3 times on the signed ledger. Not written by an operator."',
        ],
      },
    ],
  };
  const terminal = io();
  const code = await runHarnessCommand(["entries", "--session", "s1"], terminal, {
    workbench: async () => withRule,
  });
  assert.equal(code, 0);
  const text = terminal.out.join("\n");
  assert.match(text, /\ble_rule_1\b/);
  assert.match(text, /policy rule, paste it into your own file/);
  assert.match(text, /- match:/);
  assert.match(text, /decision: hold/);
  assert.match(text, /tool: fs\.delete/);
});

test("entries resolves the session to its workspace before it asks", async () => {
  // The workbench keys entries by workspace, and the web route resolves it
  // before asking. Passing the session id returned nothing on a real store,
  // so the command pins which key it uses.
  const asked: string[] = [];
  const terminal = io();
  const code = await runHarnessCommand(
    ["entries", "--session", "s1"],
    terminal,
    {
      workbench: async () =>
        fake({
          get: () => ({ workspace: "ws-1" }),
          harnessEntries: async (workspace: string) => {
            asked.push(workspace);
            return [];
          },
        }).surface,
    },
  );
  assert.equal(code, 0);
  assert.deepEqual(asked, ["ws-1"]);
  assert.match(terminal.out.join("\n"), /no entry/);
});

test("a surface with no sessions is asked with the id it was given", async () => {
  const asked: string[] = [];
  const code = await runHarnessCommand(
    ["entries", "--session", "s1"],
    io(),
    {
      workbench: async () =>
        fake({
          harnessEntries: async (workspace: string) => {
            asked.push(workspace);
            return [];
          },
        }).surface,
    },
  );
  assert.equal(code, 0);
  assert.deepEqual(asked, ["s1"]);
});

/** A chain as the ratchet reads it: sequence, signed body, nothing else that
 * command is allowed to trust. */
function chain(entries: readonly { body: unknown; seq: number }[]) {
  return fake({
    get: () => ({ workspace: "ws-1" }),
    ledger: async () => ({ entries, result: { ok: true }, verification: {} }),
  }).surface;
}

const refused = (seq: number, tool: string) => ({
  seq,
  body: { workspace: "ws-1", tool, klass: "r3", decision: "deny:policy" },
});
const allowed = (seq: number, tool: string) => ({
  seq,
  body: { workspace: "ws-1", tool, klass: "r3", decision: "execute:ok" },
});
const activated = (seq: number) => ({
  seq,
  body: { workspace: "ws-1", decision: "proposal:activated" },
});

test("the ratchet says there is nothing to measure when the chain is empty", async () => {
  const terminal = io();
  const code = await runHarnessCommand(
    ["ratchet", "--session", "s1"],
    terminal,
    { workbench: async () => chain([]) },
  );
  assert.equal(code, 0);
  const text = terminal.out.join("\n");
  assert.match(text, /nothing to measure/);
  assert.match(text, /descriptive only/);
});

test("the trend reports multiple signed activations and leaves gaps unmeasured", async () => {
  const terminal = io();
  const code = await runHarnessCommand(
    ["trend", "--session", "s1"],
    terminal,
    { workbench: async () => chain([activated(1), allowed(2, "fixture.read"), activated(3)]) },
  );
  assert.equal(code, 0, terminal.err.join(" "));
  const text = terminal.out.join("\n");
  const latest = text.indexOf("activated at seq 3");
  assert.ok(latest >= 0 && text.indexOf("activated at seq 1") > latest);
  assert.match(text, /unmeasured guardrails/);
  assert.match(text, /Descriptive only/);
});

test("with no previous refinement the ratchet reports the board as it stands", async () => {
  const terminal = io();
  const code = await runHarnessCommand(
    ["ratchet", "--session", "s1"],
    terminal,
    {
      workbench: async () =>
        chain([allowed(1, "postgres.row.read"), refused(2, "postgres.row.delete")]),
    },
  );
  assert.equal(code, 0);
  const text = terminal.out.join("\n");
  assert.match(text, /No previous refinement/);
  assert.match(text, /Current board: verdict flat, 2 cases, deny_rate 2 measured/);
});

test("the ratchet names the baseline and marks a guardrail that regressed", async () => {
  const terminal = io();
  // Three call shapes, each allowed once before the refinement and refused
  // twice after it, so the per shape deny rate moves from 0 to two thirds
  // with no spread across the shapes and the comparison is not noise.
  const entries = [
    allowed(1, "postgres.row.read"),
    allowed(2, "postgres.row.update"),
    allowed(3, "postgres.row.delete"),
    activated(4),
    refused(5, "postgres.row.read"),
    refused(6, "postgres.row.update"),
    refused(7, "postgres.row.delete"),
    refused(8, "postgres.row.read"),
    refused(9, "postgres.row.update"),
    refused(10, "postgres.row.delete"),
  ];
  const code = await runHarnessCommand(
    ["ratchet", "--session", "s1"],
    terminal,
    { workbench: async () => chain(entries) },
  );
  assert.equal(code, 0);
  const text = terminal.out.join("\n");
  assert.match(text, /Baseline: the board before the refinement activated at sequence 4/);
  assert.match(text, /deny_rate.*0\.000.*0\.667.*REGRESSED/);
  assert.match(text, /report, not a refusal/);
});


const rewardBody = (overrides: Record<string, unknown> = {}) => ({
  schema: "nomo.reward.v1",
  caseId: "case-1",
  variantId: "variant-a",
  baselineVariantId: null,
  changedAxis: null,
  passed: true,
  guardrails: { deny_rate: 0 },
  costUsd: 0.01,
  latencyMs: 100,
  approvalMs: "unmeasured",
  weights: { breach: 0.5, cost: 1, latency: 0.001 },
  reward: 0.89,
  ...overrides,
});

function rewardChain(records: readonly Record<string, unknown>[]) {
  return chain(records.map((body, index) => ({ body, seq: index + 1 })));
}

test("reward prints only a matching recomputed record, measured fields and current-weight rescoring", async () => {
  const surface = rewardChain([rewardBody(), rewardBody({ caseId: "other-case" })]);
  surface.harnessSettings = () => ({
    ...defaultHarnessSettings(),
    rewardCostWeight: 2,
    rewardLatencyWeight: 0.002,
  });
  const terminal = io();
  const code = await runHarnessCommand(
    ["reward", "--session", "s1", "case-1"],
    terminal,
    { workbench: async () => surface },
  );
  assert.equal(code, 0, terminal.err.join(" "));
  const lines = terminal.out;
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /seq 1 case=\"case-1\" variant=\"variant-a\"/);
  assert.match(lines[0]!, /reward=0\.89 recompute=match currentWeightsReward=0\.78/);
  assert.match(lines[0]!, /costUsd=0\.01 latencyMs=100 approvalMs=unmeasured/);
});

test("reward keeps a missing case empty and refuses a reward that does not recompute", async () => {
  const missing = io();
  const missingCode = await runHarnessCommand(
    ["reward", "--session", "s1", "absent"],
    missing,
    { workbench: async () => rewardChain([rewardBody()]) },
  );
  assert.equal(missingCode, 0);
  assert.match(missing.out.join("\n"), /No reward record for case \"absent\"/);

  const tampered = io();
  const tamperedCode = await runHarnessCommand(
    ["reward", "--session", "s1", "case-1"],
    tampered,
    { workbench: async () => rewardChain([rewardBody({ reward: 1 })]) },
  );
  assert.equal(tamperedCode, 1);
  assert.match(tampered.err.join("\n"), /stored 1 recomputes to 0\.89/);
  assert.equal(tampered.out.length, 0);
});

test("the trend prints pass rate, reward, samples and delta between two activations", async () => {
  const terminal = io();
  const entries = [
    activated(1),
    { seq: 2, body: { ...rewardBody({ caseId: "first-a", costUsd: 0, latencyMs: 0, reward: 1 }) } },
    activated(3),
    { seq: 4, body: { ...rewardBody({ caseId: "second-a", passed: false, costUsd: 0, latencyMs: 0, reward: 0 }) } },
    { seq: 5, body: { ...rewardBody({ caseId: "second-b", costUsd: 0, latencyMs: 0, reward: 1 }) } },
  ];
  const code = await runHarnessCommand(
    ["trend", "--session", "s1"],
    terminal,
    { workbench: async () => chain(entries) },
  );
  assert.equal(code, 0, terminal.err.join(" "));
  const text = terminal.out.join("\n");
  assert.match(text, /pass_rate 1\.000->0\.500 delta -0\.500/);
  assert.match(text, /reward 1\.000->0\.500 delta -0\.500/);
  assert.match(text, /reward_samples 1->2/);
  assert.match(text, /activated at seq 1[^\n]*pass_rate insufficient-data/);
});
