import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { promptFor, readyNode, scheduleCommand } from "./nomo-autoloop.mjs";

const script = fileURLToPath(new URL("./nomo-autoloop.mjs", import.meta.url));

const graph = (nodes) => ({ activeGraph: "fixture", nodes });

test("a node waiting on an unfinished dependency is not ready", () => {
  const node = readyNode(
    graph([
      { id: "a", status: "in-progress", dependsOn: [] },
      { id: "b", status: "pending", dependsOn: ["a"] },
    ]),
  );
  assert.equal(node?.id, "a");
});

test("done, blocked and partial nodes are never offered", () => {
  const node = readyNode(
    graph([
      { id: "a", status: "done", dependsOn: [] },
      { id: "b", status: "blocked", dependsOn: [] },
      { id: "c", status: "partial", dependsOn: [] },
      { id: "d", status: "pending", dependsOn: ["a"] },
    ]),
  );
  assert.equal(node?.id, "d");
});

test("the prompt names one node, its verifier and the stop rule", () => {
  const text = promptFor(
    { id: "x", scope: ["src/a.ts"], acceptance: ["a passes"], verifier: ["node --test a.test.ts"] },
    { activeGraph: "fixture" },
  );
  assert.match(text, /node x/);
  assert.match(text, /src\/a\.ts/);
  assert.match(text, /node --test a\.test\.ts/);
  assert.match(text, /Do not widen scope/);
  assert.match(text, /never claim a check you did not observe/);
});

test("the schedule command carries bounds rather than an open tap", () => {
  const command = scheduleCommand({ id: "x" });
  assert.match(command, /--max-runs \d+/);
  assert.match(command, /--token-budget \d+/);
  assert.match(command, /--every \d+/);
});

test("the CLI prints the ready node and exits 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "nomo-autoloop-"));
  try {
    const path = join(dir, "graph.json");
    writeFileSync(path, JSON.stringify(graph([{ id: "only", status: "pending", dependsOn: [] }])));
    const result = spawnSync(process.execPath, [script, "--graph", path, "--json"], { encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).ready, "only");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty graph exits 3 so a clock can stop cleanly", () => {
  const dir = mkdtempSync(join(tmpdir(), "nomo-autoloop-"));
  try {
    const path = join(dir, "graph.json");
    writeFileSync(path, JSON.stringify(graph([{ id: "only", status: "done", dependsOn: [] }])));
    const result = spawnSync(process.execPath, [script, "--graph", path], { encoding: "utf8" });
    assert.equal(result.status, 3);
    assert.match(result.stdout, /No ready node/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const settle = (await import("./nomo-autoloop-cycle.mjs")).settleFiring;
const recordFirings = (await import("./nomo-autoloop-cycle.mjs")).recordFirings;

const firing = (outcome = "idle") => ({ scheduleId: "sched-1", sessionId: "sess-1", outcome });
const node = (extra = {}) => ({ id: "x", status: "in-progress", evidence: [], verifier: ["node --test a.test.ts"], ...extra });
const NOW = new Date("2026-11-25T00:00:00.000Z");

test("an idle firing with a green verifier is the only path to done", () => {
  const target = node();
  const result = settle(target, {
    node: target,
    firing: firing(),
    now: NOW,
    run: (command) => ({ command, exitCode: 0, timedOut: false, tail: "pass 3" }),
  });
  assert.equal(result.reason, "verifier green");
  assert.equal(target.status, "done");
  assert.match(target.evidence[0], /autoloop firing sched-1 session sess-1 settled "idle"/);
  assert.match(target.evidence[0], /exit 0: pass 3/);
});

test("a firing that did not settle idle records the outcome and changes no status", () => {
  const target = node();
  let ran = 0;
  settle(target, { node: target, firing: firing("failed"), now: NOW, run: () => (ran += 1) });
  assert.equal(ran, 0);
  assert.equal(target.status, "in-progress");
  assert.match(target.evidence[0], /settled "failed"/);
  assert.match(target.evidence[0], /no verifier was run/);
});

test("a red verifier keeps the node open and quotes the failure", () => {
  const target = node();
  const result = settle(target, {
    node: target,
    firing: firing(),
    now: NOW,
    run: (command) => ({ command, exitCode: 1, timedOut: false, tail: "fail 1" }),
  });
  assert.equal(result.reason, "verifier red");
  assert.equal(target.status, "in-progress");
  assert.match(target.evidence[0], /exit 1: fail 1/);
});

test("a node without a verifier gets evidence, never a done", () => {
  const target = node({ verifier: [] });
  settle(target, { node: target, firing: firing(), now: NOW, run: () => ({ exitCode: 0 }) });
  assert.equal(target.status, "in-progress");
  assert.match(target.evidence[0], /declares no verifier/);
});

test("a finished node is never reopened by a late firing", () => {
  const target = node({ status: "done" });
  const result = settle(target, { node: target, firing: firing(), now: NOW, run: () => ({ exitCode: 1 }) });
  assert.equal(result.changed, false);
  assert.equal(target.status, "done");
  assert.deepEqual(target.evidence, []);
});

test("recordFirings maps a schedule back to the node named after it", () => {
  const target = node();
  const graph = { updatedAt: "old", nodes: [target] };
  const results = recordFirings(graph, [firing()], [{ id: "sched-1", name: "x" }], {
    now: NOW,
    run: (command) => ({ command, exitCode: 0, timedOut: false, tail: "ok" }),
  });
  assert.deepEqual(results.map((entry) => [entry.name, entry.status]), [["x", "done"]]);
  assert.equal(target.status, "done");
  assert.notEqual(graph.updatedAt, "old");
});
