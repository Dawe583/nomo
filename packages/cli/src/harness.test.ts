import test from "node:test";
import assert from "node:assert/strict";
import { runHarnessCommand, type HarnessSurface } from "./harness.ts";

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
  assert.deepEqual(calls, []);
});

test("no action prints the usage and fails", async () => {
  const terminal = io();
  const code = await runHarnessCommand([], terminal, {
    workbench: async () => fake().surface,
  });
  assert.equal(code, 1);
  assert.match(terminal.out.join("\n"), /nomo harness list --session/);
});
