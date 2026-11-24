#!/usr/bin/env node
/**
 * One tick of the autonomous loop.
 *
 * Three steps, in this order, and each one is idempotent:
 *
 *   1. append pending nodes for gaps the repository can prove;
 *   2. retire a schedule whose node is finished, and record a schedule for the
 *      next ready node, so the loop cannot re-fire a prompt it already solved;
 *   3. ask the workbench for one due evaluation.
 *
 * The firing itself stays in `Workbench.runDueSchedules`, which runs it through
 * the same governed path a person's run uses. The firing cannot write this
 * graph: its only host-reaching tool is `nomo_project_exec`, which is r3 and
 * therefore needs an approval hold that an unattended run never receives, and
 * `void_workspace_write` writes a managed document, not a host file. So this
 * script reads the settled firing back and records it: an evidence line for
 * every firing, and `done` only when the node's own declared verifier exits 0.
 * The firing's own words are never taken as proof.
 *
 * `--once` runs a single tick and exits, which is what the launchd job calls.
 * `--dry-run` prints the decisions without creating or deleting a schedule.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readyNode, promptFor } from "./nomo-autoloop.mjs";
import { proposals } from "./nomo-graph-propose.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const DEFAULT_GRAPH = resolve(root, ".nomo/work-state.json");

/**
 * No token budget at all, and the product's own maximum run count. `maxRuns`
 * is capped at 1000 by the schedule parser, so that is the ceiling this loop
 * asks for: the operator asked for no budget, not for a number the product
 * refuses to store.
 */
const UNLIMITED_RUNS = 1_000;
const CADENCE_SECONDS = 900;

const FINISHED = new Set(["done", "blocked", "partial"]);

/** A verifier is a local check, not a build farm; one command gets five minutes. */
const VERIFIER_TIMEOUT_MS = 300_000;
/** One line of verifier output is the evidence; a full log belongs in a file. */
const EVIDENCE_TAIL = 600;

/** Schedules whose node is no longer open. */
export function staleSchedules(schedules, graph) {
  const byId = new Map((graph?.nodes ?? []).map((node) => [node.id, node]));
  return schedules.filter((schedule) => {
    const node = byId.get(schedule.name);
    // A schedule this loop created for a node that is gone or finished is
    // stale. An operator-named schedule is left alone: this loop does not own
    // a record it did not write.
    if (node) return FINISHED.has(node.status);
    return schedule.name.startsWith("autoloop-");
  });
}

/** The node a schedule fires for. This loop names every schedule it writes after its node. */
export function firingNode(graph, scheduleName) {
  return (graph?.nodes ?? []).find((node) => node.id === scheduleName) ?? null;
}

/** One declared verifier, reduced to the exit code and the last line a reader needs. */
export function runVerifier(command, { cwd = root, timeoutMs = VERIFIER_TIMEOUT_MS } = {}) {
  // shortcut: the timeout kills the shell, not every grandchild; use a process
  // group if a verifier ever leaves a server behind.
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
  const tail = `${result.stdout ?? ""}${result.stderr ?? ""}`
    .trim()
    .split("\n")
    .filter(Boolean)
    .at(-1) ?? "";
  return {
    command,
    exitCode: typeof result.status === "number" ? result.status : null,
    timedOut: result.signal === "SIGTERM" || result.error?.code === "ETIMEDOUT",
    tail: tail.length > EVIDENCE_TAIL ? `${tail.slice(0, EVIDENCE_TAIL)}…` : tail,
  };
}

/**
 * Record one settled firing on its node.
 *
 * An evidence line is written for every firing. The status changes only when
 * the run settled `idle` and every declared verifier exits 0, because the
 * firing's own report is a claim and the verifier is the observation. A node
 * that is already finished is never reopened by a late firing.
 */
export function settleFiring(
  graph,
  { node, firing, run = runVerifier, now = new Date() },
) {
  if (!node) return { changed: false, reason: "no node for this schedule" };
  if (FINISHED.has(node.status))
    return { changed: false, reason: "node already settled" };
  const settled = `autoloop firing ${firing.scheduleId} session ${firing.sessionId} settled "${firing.outcome}" at ${now.toISOString()}`;
  const evidence = Array.isArray(node.evidence) ? node.evidence : [];
  const commands = Array.isArray(node.verifier) ? node.verifier : [];
  if (firing.outcome !== "idle") {
    node.evidence = [
      ...evidence,
      `${settled}; no verifier was run because the run did not settle idle`,
    ];
    return { changed: true, status: node.status, reason: "firing did not settle idle" };
  }
  if (commands.length === 0) {
    node.evidence = [
      ...evidence,
      `${settled}; the node declares no verifier, so its status is unchanged`,
    ];
    return { changed: true, status: node.status, reason: "node declares no verifier" };
  }
  const observed = commands.map((command) => run(command));
  const green = observed.every((result) => result.exitCode === 0 && !result.timedOut);
  node.evidence = [
    ...evidence,
    ...observed.map(
      (result) =>
        `${settled}; verifier \`${result.command}\` exit ${result.exitCode}${result.timedOut ? " (timed out)" : ""}: ${result.tail || "(no output)"}`,
    ),
  ];
  if (green) node.status = "done";
  return {
    changed: true,
    status: node.status,
    reason: green ? "verifier green" : "verifier red",
  };
}

/** Apply every settled firing to its node and persist once. */
export function recordFirings(graph, firings, schedules, { run, now } = {}) {
  const nameById = new Map((schedules ?? []).map((schedule) => [schedule.id, schedule.name]));
  const results = [];
  for (const firing of firings ?? []) {
    const node = firingNode(graph, nameById.get(firing.scheduleId));
    const result = settleFiring(graph, { node, firing, run, now });
    if (result.changed) results.push({ name: nameById.get(firing.scheduleId), ...result });
  }
  if (results.length > 0) graph.updatedAt = new Date().toISOString();
  return results;
}

export function scheduleFor(graph, schedules) {
  const node = readyNode(graph);
  if (!node) return null;
  const live = schedules.find(
    (schedule) => schedule.name === node.id && schedule.status === "active",
  );
  if (live) return null;
  return {
    name: node.id,
    prompt: promptFor(node, graph),
    cadence: { kind: "interval", everySeconds: CADENCE_SECONDS },
    maxRuns: UNLIMITED_RUNS,
  };
}

function loadGraph(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function appendProposals(path, graph) {
  let inventory = "";
  try {
    inventory = readFileSync(resolve(root, "scripts/src/harness-inventory.test.mjs"), "utf8");
  } catch {
    inventory = "";
  }
  const found = proposals(graph, inventory);
  if (found.length === 0) return 0;
  graph.nodes = [...(graph.nodes ?? []), ...found];
  graph.updatedAt = new Date().toISOString();
  writeFileSync(path, `${JSON.stringify(graph, null, 2)}\n`);
  return found.length;
}

async function main(argv) {
  const options = { graph: DEFAULT_GRAPH, dryRun: argv.includes("--dry-run") };
  const graphIndex = argv.indexOf("--graph");
  if (graphIndex >= 0) options.graph = resolve(argv[graphIndex + 1] ?? "");

  const graph = loadGraph(options.graph);
  const added = options.dryRun ? proposals(graph, "").length : appendProposals(options.graph, graph);
  console.log(`proposals: ${added} pending node(s)${options.dryRun ? " (dry run, not written)" : ""}`);

  const { Workbench } = await import("../../packages/workbench/src/index.ts");
  const workbench = new Workbench(process.env);
  try {
    const schedules = workbench.listSchedules();
    const stale = staleSchedules(schedules, graph);
    for (const schedule of stale) {
      if (options.dryRun) console.log(`would retire schedule ${schedule.name} (${schedule.id})`);
      else {
        workbench.deleteSchedule(schedule.id);
        console.log(`retired schedule ${schedule.name} (${schedule.id})`);
      }
    }
    const live = options.dryRun ? schedules : workbench.listSchedules();
    const wanted = scheduleFor(loadGraph(options.graph), live);
    if (wanted) {
      if (options.dryRun) console.log(`would schedule node ${wanted.name}`);
      else {
        const created = await workbench.createSchedule(wanted);
        console.log(`scheduled node ${wanted.name} as ${created.id}`);
      }
    } else console.log("schedules: nothing new to schedule");
    if (options.dryRun) return 0;
    const results = await workbench.runDueSchedules();
    console.log(`run-due: ${results.length} firing(s)`);
    for (const result of results) console.log(`  ${JSON.stringify(result)}`);
    // The firing cannot write this graph, so its settled outcome is read back
    // here: evidence for every firing, `done` only on a green declared verifier.
    if (results.length > 0) {
      const settledGraph = loadGraph(options.graph);
      const settled = recordFirings(settledGraph, results, workbench.listSchedules());
      if (settled.length > 0) writeFileSync(options.graph, `${JSON.stringify(settledGraph, null, 2)}\n`);
      for (const entry of settled) console.log(`  settled ${entry.name}: ${entry.reason} -> ${entry.status}`);
    }
    return 0;
  } finally {
    workbench.close?.();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)))
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`autoloop-cycle: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    },
  );
