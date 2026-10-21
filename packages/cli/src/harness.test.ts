import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ruleAsPolicyText, runHarnessCommand, type HarnessSurface } from "./harness.ts";
import { loadPolicy } from "../../policy/src/rules.ts";

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

test("a machine with no workspace is refused, and none is created", async () => {
  const directory = join(tmpdir(), "void-harness-no-workspace-" + Date.now());
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

test("a digest prefix names the proposal, and an ambiguous one is refused", async () => {
  const { surface, calls } = fake();
  const terminal = io();
  const code = await runHarnessCommand(
    ["approve", "--session", "s1", "aaaaaaa"],
    terminal,
    { workbench: async () => surface },
  );
  assert.equal(code, 0);
  // The prefix is resolved against the pending proposals, so the list is
  // read before the decision is made.
  assert.deepEqual(calls, [
    { method: "list", args: ["s1"] },
    { method: "approve", args: ["s1", proposal.digest] },
  ]);

  const ambiguous = io();
  const refused = await runHarnessCommand(
    ["approve", "--session", "s1", "z"],
    ambiguous,
    {
      workbench: async () => ({
        ...surface,
        async pendingApprovalsFor() {
          return [
            { ...proposal, digest: "z1".repeat(32) },
            { ...proposal, digest: "z2".repeat(32) },
          ];
        },
      }),
    },
  );
  assert.equal(refused, 1);
  assert.match(ambiguous.err.join("\n"), /names 2 pending proposals/);
});

test("a digest prefix that names nothing is refused", async () => {
  const { surface } = fake();
  const terminal = io();
  const code = await runHarnessCommand(
    ["approve", "--session", "s1", "fffffff"],
    terminal,
    { workbench: async () => surface },
  );
  assert.equal(code, 1);
  assert.match(terminal.err.join("\n"), /No pending proposal matches the digest prefix/);
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

test("a mined rule prints as policy text the loader accepts", () => {
  // The rule is not in force. Printing it is only useful if the operator can
  // paste it into their own file, so the text is loaded by the same loader
  // the runtime uses, ahead of the terminal catch-all it has to sit before.
  const text = ruleAsPolicyText({
    match: { class: "r3", tool: "fs.delete" },
    decision: "hold",
    seconds: 300,
    notify: ["cli"],
    rationale: "Refused 3 times on the signed ledger. Not written by an operator.",
  }).join("\n");
  const loaded = loadPolicy(
    `version: 1\nrules:\n${text}\n- match: {}\n  decision: allow\n`,
  );
  assert.equal(loaded.ok, true, loaded.ok ? "" : loaded.errors.join("; "));
  if (!loaded.ok) return;
  assert.deepEqual(loaded.policy.rules[0]?.match, { class: "r3", tool: "fs.delete" });
  assert.equal(loaded.policy.rules[0]?.decision, "hold");
});

test("entries prints a mined rule as policy text under the entry", async () => {
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
        rule: {
          match: { class: "r3", tool: "fs.delete" },
          decision: "hold",
          seconds: 300,
          notify: ["cli"],
          rationale: "Refused 3 times on the signed ledger. Not written by an operator.",
        },
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
