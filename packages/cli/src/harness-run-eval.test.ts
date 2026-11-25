import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runHarnessCommand } from "./harness.ts";
import { isolatedWorkbench } from "../../workbench/src/test-fixture.ts";

const MODEL = "fixture-model";
const EVAL_CASE = {
  caseId: "cli-production-eval",
  variantId: "sha256:" + "a".repeat(64),
  run: 1,
};

test("run-eval drives a real governed production run and the chain carries its case identity", async (t) => {
  let turn = 0;
  const fetcher: typeof fetch = async (url, options) => {
    if (String(url).endsWith("/models"))
      return Response.json({ data: [{ id: MODEL }] });
    turn += 1;
    if (turn === 1) {
      const request = JSON.parse(String(options?.body));
      const tool = request.tools.find(
        (item: { function: { description: string } }) =>
          item.function.description.startsWith("void_workspace_list:"),
      );
      assert.ok(tool, "the run must offer the managed document list tool");
      return Response.json({ choices: [{ message: { role: "assistant",
      content: null, tool_calls: [
        {
          id: "list-1",
          type: "function",
          function: {
            name: tool.function.name,
            arguments: JSON.stringify({}),
          },
        },
      ] }, finish_reason: "tool_calls" }] });
    }
    return Response.json({
      choices: [{ message: { role: "assistant", content: "Listed." }, finish_reason: "stop" }],
      usage: { total_tokens: 3 },
    });
  };
  const gateDir = await mkdtemp(join(tmpdir(), "nomo-eval-gate-"));
  t.after(async () => rm(gateDir, { recursive: true, force: true }));
  const gate = join(gateDir, "verifier");
  await writeFile(gate, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await chmod(gate, 0o700);
  const fixture = await isolatedWorkbench(
    t,
    fetcher,
    { NOMO_HOOK_COMMANDS: JSON.stringify([gate]) },
    { prefix: "nomo-run-eval-cli-" },
  );
  const out: string[] = [];
  const err: string[] = [];
  const code = await runHarnessCommand(
    [
      "run-eval",
      "--case", EVAL_CASE.caseId,
      "--variant", EVAL_CASE.variantId,
      "--run", String(EVAL_CASE.run),
      "--model", MODEL,
      "--idempotency-key", "cli-eval-idem-1",
      "--gate", gate,
      "--weights", "breach=0,cost=0,latency=0",
      "--prompt", "List the managed documents.",
    ],
    {
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    },
    { workbench: async () => fixture.app },
  );
  assert.equal(code, 0, err.join(" "));
  const match = /^run-eval: session ([0-9a-f-]+) status idle\nrun-eval: verifier passed reward 1$/.exec(out.join("\n"));
  assert.ok(match, `unexpected output: ${out.join("\\n")}`);
  const session = fixture.app.get(match[1]!);
  assert.ok(session, "the command output must name a live session");
  assert.deepEqual(session.harnessEval, EVAL_CASE);
  const turnsAfterCommand = turn;
  const repeated = await fixture.app.startHarnessEval(
    "List the managed documents.",
    MODEL,
    EVAL_CASE,
    undefined,
    "cli-eval-idem-1",
  );
  assert.equal(repeated.id, session.id, "the same exact keyed eval request must reuse the session");
  assert.equal(turn, turnsAfterCommand, "an idempotent retry must not start another provider run");
  await assert.rejects(
    fixture.app.startHarnessEval(
      "List the managed documents.",
      MODEL,
      { ...EVAL_CASE, run: 2 },
      undefined,
      "cli-eval-idem-1",
    ),
    /Idempotency key belongs to another request/,
  );
  assert.equal(turn, turnsAfterCommand, "a conflicting keyed eval request must not start a provider run");
  const proof = await fixture.app.ledger(session.workspace);
  const entries = (proof?.entries ?? []).map((entry) => entry.body as Record<string, unknown>);
  const calls = entries.filter((body) => body.tool === "void_workspace_list");
  assert.ok(calls.length >= 1, "the governed production tool call must be recorded");
  for (const body of calls) assert.deepEqual(body.harnessEval, EVAL_CASE);
  const gates = entries.filter((body) => body.tool === "harness.eval-gate");
  assert.equal(gates.length, 1, "the verifier execution must be chain evidence");
  assert.deepEqual(gates[0]?.harnessEval, EVAL_CASE);
  assert.equal(gates[0]?.decision, "eval-gate:passed");
  assert.equal(gates[0]?.commandDigest, `sha256:${createHash("sha256").update(gate).digest("hex")}`);
  assert.equal(gates[0]?.passed, true);
  assert.ok(!("stdout" in gates[0]!) && !("stderr" in gates[0]!), "verifier output must not enter the chain");
  const rewards = entries.filter((body) => body.schema === "nomo.reward.v1");
  assert.equal(rewards.length, 1, "the measured reward must be chain evidence");
  assert.equal(rewards[0]?.passed, true);
  assert.equal(rewards[0]?.reward, 1);
  assert.deepEqual(rewards[0]?.harnessEval, EVAL_CASE);
  const flat = JSON.stringify(calls);
  assert.doesNotMatch(flat, /List the managed documents\./, "attribution never carries prompt text");
});

test("run-eval refuses a non-allowlisted verifier before provider cost", async (t) => {
  let turn = 0;
  const fetcher: typeof fetch = async (url) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: MODEL }] });
    turn += 1;
    return Response.json({ choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }] });
  };
  const fixture = await isolatedWorkbench(t, fetcher, {}, { prefix: "nomo-run-eval-gate-refusal-" });
  const out: string[] = [];
  const err: string[] = [];
  const code = await runHarnessCommand(
    [
      "run-eval",
      "--case", EVAL_CASE.caseId,
      "--variant", EVAL_CASE.variantId,
      "--run", String(EVAL_CASE.run),
      "--model", MODEL,
      "--gate", "definitely-not-allowlisted",
      "--weights", "breach=0,cost=0,latency=0",
      "--prompt", "Do not run.",
    ],
    { stdout: (line) => out.push(line), stderr: (line) => err.push(line) },
    { workbench: async () => fixture.app },
  );
  assert.equal(code, 1);
  assert.equal(turn, 0, "verifier validation must happen before the first provider turn");
  assert.equal(out.length, 0);
  assert.match(err.join("\n"), /not on the operator hook allowlist/);
});
