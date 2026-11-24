#!/usr/bin/env node
/**
 * Turns the task graph into the next bounded prompt.
 *
 * Autonomy is not a daemon this script invents: NOMO already owns a schedule
 * table with `maxRuns` and `tokenBudget`, and `nomo schedule run-due` is the
 * one call a cron entry makes. What was missing is the step between them, a
 * deterministic answer to "which node is ready, and what should the run be
 * told". This prints that answer and the exact command to schedule it.
 *
 * It is read only. It does not run a model, write the graph, or install a
 * clock, because a graph writer is the session that holds the node and a
 * clock is a system change an operator makes on purpose.
 *
 * Exit codes: 0 = a node is ready and printed; 3 = nothing ready; 2 = the
 * graph is missing or unreadable.
 *
 *   node scripts/src/nomo-autoloop.mjs [--graph path] [--json]
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const DEFAULT_GRAPH = resolve(root, ".nomo/work-state.json");
const DONE = new Set(["done", "blocked", "partial"]);

/** A node is ready when it is not finished and every dependency is done. */
export function readyNode(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const done = new Set(nodes.filter((node) => node.status === "done").map((node) => node.id));
  return (
    nodes.find((node) => {
      if (DONE.has(node.status)) return false;
      const deps = Array.isArray(node.dependsOn) ? node.dependsOn : [];
      return deps.every((id) => done.has(id));
    }) ?? null
  );
}

/**
 * The prompt a scheduled run receives.
 *
 * It names one node, its verifier and its stop rule, and forbids the two
 * things an unattended run must never do on its own: broaden its scope and
 * mark a node done without observed output.
 */
export function promptFor(node, graph) {
  const scope = (node.scope ?? []).join(", ") || "the paths its acceptance names";
  const verifier = (node.verifier ?? []).join(" && ") || "the narrowest check its acceptance names";
  return [
    `NOMO autonomous loop, graph ${graph?.activeGraph ?? "unknown"}, node ${node.id}.`,
    `Do only this node. Scope: ${scope}.`,
    `Acceptance: ${(node.acceptance ?? []).join("; ") || "as the node states"}.`,
    `Verify with: ${verifier}.`,
    "Record the exact command output in the task graph before changing the node status.",
    "If the check fails, diagnose once, repair once, then mark the node blocked with the observed",
    "failure and stop. Do not widen scope, do not touch another node's paths, do not commit,",
    "push, deploy or install dependencies, and never claim a check you did not observe.",
  ].join(" ");
}

/** The schedule command an operator runs once, with bounds, not an open tap. */
export function scheduleCommand(node, { graph = DEFAULT_GRAPH, every = 900, maxRuns = 8, tokenBudget = 250000 } = {}) {
  const prompt = promptFor(node, { activeGraph: node.graph });
  return [
    "nomo schedule add",
    `--name ${node.id}`,
    `--every ${every}`,
    `--max-runs ${maxRuns}`,
    `--token-budget ${tokenBudget}`,
    JSON.stringify(prompt),
  ].join(" ");
}

function main(argv) {
  const options = { graph: DEFAULT_GRAPH, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--json") options.json = true;
    else if (argv[index] === "--graph") options.graph = resolve(argv[index + 1] ?? ""), (index += 1);
  }
  let graph;
  try {
    graph = JSON.parse(readFileSync(options.graph, "utf8"));
  } catch {
    console.error(`autoloop: cannot read a task graph at ${options.graph}`);
    return 2;
  }
  const node = readyNode(graph);
  if (!node) {
    if (options.json) console.log(JSON.stringify({ ready: null }));
    else console.log("No ready node. Every node is done, blocked, or waiting on a dependency.");
    return 3;
  }
  if (options.json) {
    console.log(JSON.stringify({ ready: node.id, prompt: promptFor(node, graph) }));
    return 0;
  }
  console.log(`Ready node: ${node.id}`);
  console.log("");
  console.log(promptFor(node, graph));
  console.log("");
  console.log("Schedule it (bounded, one operator command):");
  console.log(scheduleCommand(node, { graph: options.graph }));
  console.log("");
  console.log("Then the clock calls: nomo schedule run-due");
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)))
  process.exitCode = main(process.argv.slice(2));
