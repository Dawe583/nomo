import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("the ratchet reports strictly before vs after refinement effect and labels unmeasured guardrails", async () => {
  const terminal = io();
  const digestA = "a".repeat(64);
  const entries = [
    allowed(1, "postgres.row.read"),
    allowed(2, "postgres.row.update"),
    allowed(3, "postgres.row.delete"),
    {
      seq: 4,
      body: {
        workspace: "ws-1",
        decision: "proposal:activated",
        harnessProposal: { digest: digestA, proposal: { summary: "confirm deletes", edits: [] } },
      },
    },
    refused(5, "postgres.row.read"),
    refused(6, "postgres.row.update"),
    refused(7, "postgres.row.delete"),
  ];
  const code = await runHarnessCommand(
    ["ratchet", "--session", "s1"],
    terminal,
    { workbench: async () => chain(entries) },
  );
  assert.equal(code, 0);
  const text = terminal.out.join("\n");
  assert.match(text, /Refinement effect \(strictly before vs after activation\):/);
  assert.match(text, /Activation at sequence 4 \(aaaaaaaa, standing\): "confirm deletes"/);
  assert.match(text, /deny_rate.*0\.000 \(n=3\) -> 1\.000 \(n=3\).*REGRESSED/);
  assert.match(text, /Unmeasured guardrails: unknown_tool_rate/);
});

test("the ratchet reports post-activation silence as unmeasured without leaking pre-activation calls", async () => {
  const terminal = io();
  const entries = [
    allowed(1, "postgres.row.read"),
    allowed(2, "postgres.row.update"),
    allowed(3, "postgres.row.delete"),
    activated(4),
  ];
  const code = await runHarnessCommand(
    ["ratchet", "--session", "s1"],
    terminal,
    { workbench: async () => chain(entries) },
  );
  assert.equal(code, 0);
  const text = terminal.out.join("\n");
  assert.match(text, /cases 3 -> 0/);
  assert.match(text, /Unmeasured guardrails: deny_rate, rollback_count, unknown_tool_rate/);
});

test("the ratchet filters refinement effect by digest prefix and rejects unknown or ambiguous prefixes", async () => {
  const digestA = "aa11" + "0".repeat(60);
  const digestB = "aa22" + "0".repeat(60);
  const entries = [
    allowed(1, "postgres.row.read"),
    allowed(2, "postgres.row.update"),
    {
      seq: 3,
      body: {
        workspace: "ws-1",
        decision: "proposal:activated",
        harnessProposal: { digest: digestA, proposal: { summary: "first lesson", edits: [] } },
      },
    },
    allowed(4, "postgres.row.read"),
    allowed(5, "postgres.row.update"),
    {
      seq: 6,
      body: {
        workspace: "ws-1",
        decision: "refinement:rolled-back",
        event: "rollback",
        harnessLifecycle: { digest: digestA, events: ["refinement:rolled-back"] },
      },
    },
    {
      seq: 7,
      body: {
        workspace: "ws-1",
        decision: "proposal:activated",
        harnessProposal: { digest: digestB, proposal: { summary: "second lesson", edits: [] } },
      },
    },
    refused(8, "postgres.row.read"),
    refused(9, "postgres.row.update"),
  ];

  const one = io();
  const codeOne = await runHarnessCommand(
    ["ratchet", "--session", "s1", "aa11"],
    one,
    { workbench: async () => chain(entries) },
  );
  assert.equal(codeOne, 0);
  const textOne = one.out.join("\n");
  assert.match(textOne, /first lesson/);
  assert.match(textOne, /rolled back at sequence 6/);
  assert.doesNotMatch(textOne, /second lesson/);

  const ambiguous = io();
  const codeAmb = await runHarnessCommand(
    ["ratchet", "--session", "s1", "aa"],
    ambiguous,
    { workbench: async () => chain(entries) },
  );
  assert.equal(codeAmb, 1);
  assert.match(ambiguous.err.join("\n"), /names 2 activated refinements/);

  const missing = io();
  const codeMissing = await runHarnessCommand(
    ["ratchet", "--session", "s1", "ffff"],
    missing,
    { workbench: async () => chain(entries) },
  );
  assert.equal(codeMissing, 1);
  assert.match(missing.err.join("\n"), /No activated refinement matches/);
});

test("promote binds to an activated digest of the session and prints the promotion digest", async () => {
  const activated = "c".repeat(64);
  const promotionDigest = "e".repeat(64);
  const { surface, calls } = fake({
    get: (id) => (id === "s1" ? { workspace: "agent-s1" } : undefined),
    async harnessOutcomes(workspace) {
      calls.push({ method: "outcomes", args: [workspace] });
      // The same prefix also names a rejected proposal. Only an activated one
      // can be promoted, so the prefix still names exactly one.
      return [
        { digest: activated, status: "activated" },
        { digest: `${"c".repeat(63)}d`, status: "rejected" },
      ];
    },
    async promoteHarnessProposal(sessionId, digest) {
      calls.push({ method: "promote", args: [sessionId, digest] });
      return { digest: promotionDigest, entries: [{ id: "x" }] };
    },
  });
  const terminal = io();
  const code = await runHarnessCommand(
    ["promote", "--session", "s1", "cccccccc"],
    terminal,
    { workbench: async () => surface },
  );
  assert.equal(code, 0, terminal.err.join("\n"));
  assert.deepEqual(calls, [
    { method: "outcomes", args: ["agent-s1"] },
    { method: "promote", args: ["s1", activated] },
  ]);
  assert.match(
    terminal.out.join("\n"),
    new RegExp(`Promoted 1 entry from ${activated} to every conversation as ${promotionDigest}\\.`),
  );

  const missing = io();
  assert.equal(
    await runHarnessCommand(["promote", "--session", "s1", "dddd"], missing, {
      workbench: async () => surface,
    }),
    1,
  );
  assert.match(missing.err.join("\n"), /No activated refinement matches the digest prefix dddd\./);

  const noSession = io();
  assert.equal(
    await runHarnessCommand(["promote", activated], noSession, { workbench: async () => surface }),
    1,
  );
  assert.match(noSession.err.join("\n"), /need a session/);
});

test("global lists every promotion and demote binds to a standing promotion digest", async () => {
  const standing = "e".repeat(64);
  const demoted = `${"e".repeat(63)}f`;
  const entry = {
    id: "x",
    kind: "lesson",
    title: "plan first",
    content: "Read the migration plan first.",
    tool: "",
    klass: "",
  };
  const { surface, calls } = fake({
    async operatorHarnessPromotions() {
      return [
        {
          digest: standing,
          status: "promoted",
          sourceWorkspace: "agent-s1",
          sourceDigest: "c".repeat(64),
          sourceSeq: 4,
          promotedSeq: 1,
          demotedSeq: null,
          entries: [entry],
        },
        {
          digest: demoted,
          status: "demoted",
          sourceWorkspace: "agent-s2",
          sourceDigest: "b".repeat(64),
          sourceSeq: 7,
          promotedSeq: 2,
          demotedSeq: 3,
          entries: [entry],
        },
      ];
    },
    async demoteHarnessPromotion(digest) {
      calls.push({ method: "demote", args: [digest] });
    },
  });
  const listed = io();
  assert.equal(await runHarnessCommand(["global"], listed, { workbench: async () => surface }), 0);
  const text = listed.out.join("\n");
  assert.match(text, new RegExp(`${standing}  promoted  from agent-s1 cccccccc at sequence 4`));
  assert.match(text, new RegExp(`${demoted}  demoted at sequence 3  from agent-s2 bbbbbbbb at sequence 7`));
  assert.match(text, /lesson: plan first \| Read the migration plan first\./);

  const terminal = io();
  // The prefix names both digests; only the standing one can be demoted.
  assert.equal(
    await runHarnessCommand(["demote", "eeeeeeee"], terminal, { workbench: async () => surface }),
    0,
    terminal.err.join("\n"),
  );
  assert.deepEqual(calls, [{ method: "demote", args: [standing] }]);
  assert.match(terminal.out.join("\n"), new RegExp(`Demoted ${standing}\\.`));

  const none = io();
  assert.equal(
    await runHarnessCommand(["global"], none, {
      workbench: async () => fake({ async operatorHarnessPromotions() { return []; } }).surface,
    }),
    0,
  );
  assert.match(none.out.join("\n"), /No refinement is promoted to every conversation\./);
});

test("a rollback prefix names an activated refinement, never a pending proposal", async () => {
  // A rollback undoes an activation, so its prefix has to be resolved among
  // the activated refinements. Resolving it among the pending proposals, as
  // approve does, refused every documented rollback by prefix.
  const activated = "c".repeat(64);
  const { surface, calls } = fake({
    get: (id) => (id === "s1" ? { workspace: "agent-s1" } : undefined),
    async harnessOutcomes() {
      return [
        { digest: activated, status: "activated" },
        { digest: `${"c".repeat(63)}e`, status: "rolled-back" },
      ];
    },
  });
  const terminal = io();
  assert.equal(
    await runHarnessCommand(["rollback", "--session", "s1", "cccccccc"], terminal, {
      workbench: async () => surface,
    }),
    0,
    terminal.err.join("\n"),
  );
  assert.deepEqual(calls, [{ method: "rollback", args: ["s1", activated] }]);
});
