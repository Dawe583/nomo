import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseDecision, parseTaskset, scoreTask } from "./harness-eval.mjs";
import {
  compareRewardRecords,
  computeReward,
} from "../../packages/workbench/src/harness-scores.ts";

const script = fileURLToPath(new URL("./harness-eval.mjs", import.meta.url));

/**
 * A fake runner, so every claim about scoring is a claim about this script and
 * not about a model.
 *
 * It answers from `decisions.json` next to itself: prompt -> list of decisions,
 * one per invocation, so a runner that disagrees with its own first answer is
 * expressible. It always writes a canary on stdout and on stderr, because the
 * report must never echo either.
 */
const runnerSource = `
import { appendFileSync, readFileSync } from "node:fs";

const prompt = readFileSync(0, "utf8").trim();
const plan = JSON.parse(readFileSync(new URL("./decisions.json", import.meta.url), "utf8"));
const counterPath = process.argv[2];
let run = 1;
if (counterPath) {
  appendFileSync(counterPath, "x");
  run = readFileSync(counterPath, "utf8").length;
}
const answers = plan[prompt] ?? [];
const decision = answers[Math.min(run - 1, answers.length - 1)];
console.log("RAW-STDOUT-CANARY: a transcript the report must not echo");
console.error("RAW-STDERR-CANARY: a prompt the report must not echo");
console.log(JSON.stringify(decision));
`;

function workspace(taskset, decisions) {
  const dir = mkdtempSync(join(tmpdir(), "harness-eval-"));
  writeFileSync(join(dir, "taskset.json"), JSON.stringify(taskset));
  writeFileSync(join(dir, "decisions.json"), JSON.stringify(decisions));
  writeFileSync(join(dir, "runner.mjs"), runnerSource);
  return dir;
}

function run(dir, extraArgs = []) {
  const result = spawnSync(
    process.execPath,
    [
      script,
      join(dir, "taskset.json"),
      ...extraArgs,
      "--",
      process.execPath,
      join(dir, "runner.mjs"),
      join(dir, "runs.txt"),
    ],
    { encoding: "utf8", timeout: 60_000 },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

const task = (id, prompt, tool, cls) => ({
  id,
  prompt,
  expectedTool: tool,
  expectedClass: cls,
});

describe("harness-eval scorer", () => {
  test("a task passes when both fields match", () => {
    const result = scoreTask(task("t1", "p", "read", "inspect"), [
      { decision: { tool: "read", class: "inspect" }, code: 0 },
      { decision: { tool: "read", class: "inspect" }, code: 0 },
    ]);
    assert.equal(result.status, "pass");
    assert.deepEqual(result.decision, { tool: "read", class: "inspect" });
  });

  test("a task fails on the run that disagrees with the pair", () => {
    const result = scoreTask(task("t1", "p", "read", "inspect"), [
      { decision: { tool: "read", class: "inspect" }, code: 0 },
      { decision: { tool: "edit", class: "inspect" }, code: 0 },
    ]);
    assert.equal(result.status, "fail");
    assert.equal(result.run, 2);
    assert.match(result.detail, /got tool=edit class=inspect/);
  });

  test("a missing decision line is not a pass", () => {
    const result = scoreTask(task("t1", "p", "read", "inspect"), [
      { decision: null, code: 0 },
    ]);
    assert.equal(result.status, "no-decision");
    assert.match(result.detail, /exit 0/);
  });

  test("a runner that never started is not a pass", () => {
    const result = scoreTask(task("t1", "p", "read", "inspect"), [
      { error: true },
    ]);
    assert.equal(result.status, "runner-error");
  });

  test("a matching decision followed by a process failure is not a pass", () => {
    const result = scoreTask(task("t1", "p", "read", "inspect"), [
      { decision: { tool: "read", class: "inspect" }, code: 1 },
    ]);
    assert.equal(result.status, "runner-error");
  });

  test("the decision is the last valid line, not the first brace", () => {
    const stdout = [
      "thinking about it {not json}",
      '{"tool":"read","class":"inspect"}',
      '{"tool":"edit","class":"mutate"}',
    ].join("\n");
    assert.deepEqual(parseDecision(stdout), {
      tool: "edit",
      class: "mutate",
    });
  });

  test("a multi-line object is refused rather than guessed at", () => {
    assert.equal(parseDecision('{\n  "tool": "read",\n  "class": "inspect"\n}'), null);
    assert.equal(parseDecision("no json here"), null);
    assert.equal(parseDecision('{"tool":"read"}'), null);
  });

  test("a taskset without the frozen fields is rejected", () => {
    const missing = parseTaskset(
      JSON.stringify({ tasks: [{ id: "t1", prompt: "p" }] }),
    );
    assert.equal(missing.tasks.length, 0);
    assert.deepEqual(missing.errors, [
      "tasks[0].expectedTool: required",
      "tasks[0].expectedClass: required",
    ]);

    const duplicate = parseTaskset(
      JSON.stringify({
        tasks: [task("t1", "a", "read", "inspect"), task("t1", "b", "read", "inspect")],
      }),
    );
    assert.match(duplicate.errors.join("\n"), /duplicate "t1"/);

    assert.deepEqual(parseTaskset("not json").errors, ["taskset: not valid JSON"]);
    assert.deepEqual(parseTaskset(JSON.stringify({ tasks: [] })).errors, [
      "tasks: must be a non-empty array",
    ]);
  });
});

describe("harness-eval CLI", () => {
  test("all tasks pass", () => {
    const dir = workspace(
      {
        id: "harness-core-v1",
        tasks: [
          task("read-before-edit", "read the file", "read", "inspect"),
          task("apply-edit", "apply the patch", "edit", "mutate"),
        ],
      },
      {
        "read the file": [{ tool: "read", class: "inspect" }],
        "apply the patch": [{ tool: "edit", class: "mutate" }],
      },
    );
    try {
      const result = run(dir);
      assert.equal(result.status, 0);
      assert.match(result.stdout, /^PASS\s+read-before-edit\s+tool=read class=inspect$/m);
      assert.match(result.stdout, /^PASS\s+apply-edit\s+tool=edit class=mutate$/m);
      assert.match(result.stdout, /total: 2\/2 passed, 0 failed, 0 no-decision, 0 runner-error/);
      assert.match(result.stdout, /harness-core-v1/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("one wrong decision fails the run and names the mismatch", () => {
    const dir = workspace(
      {
        tasks: [
          task("t1", "p1", "read", "inspect"),
          task("t2", "p2", "edit", "mutate"),
          task("t3", "p3", "write", "mutate"),
        ],
      },
      {
        p1: [{ tool: "read", class: "inspect" }],
        p2: [{ tool: "edit", class: "mutate" }],
        p3: [{ tool: "read", class: "inspect" }],
      },
    );
    try {
      const result = run(dir);
      assert.equal(result.status, 1);
      assert.match(
        result.stdout,
        /^FAIL {2}t3 {2}run 1: expected tool=write class=mutate, got tool=read class=inspect$/m,
      );
      assert.match(result.stdout, /total: 2\/3 passed, 1 failed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a runner that agrees once and disagrees once cannot pass a pair", () => {
    const dir = workspace(
      { tasks: [task("t1", "p1", "read", "inspect")] },
      {
        p1: [
          { tool: "read", class: "inspect" },
          { tool: "read", class: "mutate" },
        ],
      },
    );
    try {
      const result = run(dir);
      assert.equal(result.status, 1);
      assert.match(
        result.stdout,
        /^FAIL {2}t1 {2}run 2: expected tool=read class=inspect, got tool=read class=mutate$/m,
      );
      assert.match(result.stdout, /total: 0\/1 passed, 1 failed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no runner prints SKIP and exits 0", () => {
    const dir = workspace(
      { tasks: [task("t1", "p1", "read", "inspect")] },
      { p1: [{ tool: "read", class: "inspect" }] },
    );
    try {
      const result = spawnSync(
        process.execPath,
        [script, join(dir, "taskset.json")],
        { encoding: "utf8", timeout: 60_000 },
      );
      assert.equal(result.status, 0);
      assert.match(result.stdout, /^SKIP harness-eval: no runner command was given/);
      assert.doesNotMatch(result.stdout, /PASS/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("raw runner stdout and stderr are never echoed", () => {
    const dir = workspace(
      { tasks: [task("t1", "p1", "read", "inspect")] },
      { p1: [{ tool: "read", class: "inspect" }] },
    );
    try {
      const result = run(dir);
      assert.equal(result.status, 0);
      assert.doesNotMatch(result.stdout, /RAW-STDOUT-CANARY/);
      assert.doesNotMatch(result.stdout, /RAW-STDERR-CANARY/);
      assert.doesNotMatch(result.stderr, /RAW-STDOUT-CANARY/);
      assert.doesNotMatch(result.stderr, /RAW-STDERR-CANARY/);
      // The parsed decision is the only runner output that survives.
      assert.match(result.stdout, /tool=read class=inspect/);
      assert.doesNotMatch(result.stdout, /"tool":"read"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a broken taskset is refused without echoing prompt text", () => {
    const dir = workspace(
      { tasks: [{ id: "t1", prompt: "SECRET-PROMPT-TEXT", expectedTool: "read" }] },
      {},
    );
    try {
      const result = spawnSync(
        process.execPath,
        [script, join(dir, "taskset.json"), "--", process.execPath, join(dir, "runner.mjs")],
        { encoding: "utf8", timeout: 60_000 },
      );
      assert.equal(result.status, 2);
      assert.match(result.stderr, /tasks\[0\]\.expectedClass: required/);
      assert.doesNotMatch(result.stderr, /SECRET-PROMPT-TEXT/);
      assert.doesNotMatch(result.stdout, /SECRET-PROMPT-TEXT/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("harness-eval reward records", () => {
  const variantFile = (dir, name, settings = {}) => {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify({ model: "provider/model", promptPreamble: "PREAMBLE-CANARY", settings }));
    return path;
  };
  const weights = ["--weights", "breach=0,cost=0,latency=0.001"];

  test("a case with two runs writes one recomputable record and no prompt", () => {
    const dir = workspace(
      { tasks: [task("t1", "SECRET-PROMPT-CANARY", "read", "inspect")] },
      { "SECRET-PROMPT-CANARY": [{ tool: "read", class: "inspect" }] },
    );
    try {
      const records = join(dir, "records.jsonl");
      const variant = variantFile(dir, "variant.json");
      const result = run(dir, ["--runs", "2", "--records", records, ...weights, "--variant", variant]);
      assert.equal(result.status, 0);
      assert.match(result.stdout, /records: 1 written to /);
      const raw = readFileSync(records, "utf8");
      assert.doesNotMatch(raw, /CANARY/);
      const lines = raw.trim().split("\n");
      assert.equal(lines.length, 1);
      const record = JSON.parse(lines[0]);
      assert.equal(record.schema, "nomo.reward.v1");
      assert.equal(record.caseId, "t1");
      assert.match(record.variantId, /^sha256:[0-9a-f]{64}$/);
      assert.equal(record.baselineVariantId, null);
      assert.equal(record.changedAxis, null);
      assert.equal(record.passed, true);
      assert.equal(record.costUsd, "unmeasured");
      assert.equal(record.approvalMs, "unmeasured");
      assert.ok(typeof record.latencyMs === "number" && record.latencyMs > 0);
      assert.equal(typeof record.reward, "number");
      assert.equal(computeReward(record), record.reward);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a weighted metric without a producer leaves the reward unmeasured", () => {
    const dir = workspace(
      { tasks: [task("t1", "p1", "read", "inspect")] },
      { p1: [{ tool: "read", class: "inspect" }] },
    );
    try {
      const records = join(dir, "records.jsonl");
      const result = run(dir, [
        "--records", records,
        "--weights", "breach=0.5,cost=1,latency=0.001",
        "--variant", variantFile(dir, "variant.json"),
      ]);
      assert.equal(result.status, 0);
      const record = JSON.parse(readFileSync(records, "utf8").trim());
      assert.equal(record.reward, "unmeasured");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("records need explicit weights, and bad weights are refused", () => {
    const dir = workspace(
      { tasks: [task("t1", "p1", "read", "inspect")] },
      { p1: [{ tool: "read", class: "inspect" }] },
    );
    try {
      const records = join(dir, "records.jsonl");
      const missing = run(dir, ["--records", records]);
      assert.equal(missing.status, 2);
      assert.match(missing.stderr, /--records and --weights are required together/);
      const noVariant = run(dir, ["--records", records, ...weights]);
      assert.equal(noVariant.status, 2);
      assert.match(noVariant.stderr, /--records and --variant are required together/);
      const bad = run(dir, [
        "--records", records,
        "--weights", "breach=0.5,cost=1",
        "--variant", variantFile(dir, "variant.json"),
      ]);
      assert.equal(bad.status, 2);
      assert.match(bad.stderr, /weights\.latency/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("two variants one axis apart produce records that compare per case", () => {
    const dir = workspace(
      { tasks: [task("t1", "p1", "read", "inspect"), task("t2", "p2", "edit", "mutate")] },
      { p1: [{ tool: "read", class: "inspect" }], p2: [{ tool: "edit", class: "mutate" }] },
    );
    try {
      const base = variantFile(dir, "base.json");
      const next = variantFile(dir, "next.json", { autoCompactMessages: 75 });
      const a = join(dir, "a.jsonl");
      const b = join(dir, "b.jsonl");
      assert.equal(run(dir, ["--records", a, ...weights, "--variant", base]).status, 0);
      const second = run(dir, ["--records", b, ...weights, "--variant", next, "--baseline", base]);
      assert.equal(second.status, 0);
      assert.match(second.stdout, /changedAxis=autoCompactMessages/);
      const read = (path) => readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      const before = read(a);
      const after = read(b);
      assert.doesNotMatch(readFileSync(b, "utf8"), /PREAMBLE-CANARY/);
      for (const [index, record] of after.entries()) {
        assert.equal(record.baselineVariantId, before[index].variantId);
        assert.equal(record.changedAxis, "autoCompactMessages");
        const comparison = compareRewardRecords(before[index], record);
        assert.ok(comparison.comparable, comparison.reason);
        assert.equal(comparison.changedAxis, "autoCompactMessages");
        assert.equal(typeof comparison.delta, "number");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a baseline two axes away is refused before anything runs", () => {
    const dir = workspace(
      { tasks: [task("t1", "p1", "read", "inspect")] },
      { p1: [{ tool: "read", class: "inspect" }] },
    );
    try {
      const base = variantFile(dir, "base.json");
      const next = variantFile(dir, "next.json", { autoCompactMessages: 75, maxToolResultCharacters: 32000 });
      const records = join(dir, "records.jsonl");
      const result = run(dir, ["--records", records, ...weights, "--variant", next, "--baseline", base]);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /baseline refused: variants differ in 2 axes \(autoCompactMessages, maxToolResultCharacters\)/);
      assert.doesNotMatch(result.stdout, /PASS|FAIL/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
