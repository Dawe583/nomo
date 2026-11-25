#!/usr/bin/env node
/**
 * Work-graph structural validation (Q1).
 *
 * Checks the canonical graph for duplicate node ids, dependencies that name no
 * node, and nodes marked done without evidence. Prints only counts; evidence
 * may quote command output but never belongs in this summary.
 *
 *   node scripts/src/work-graph-check.mjs [graph.json]
 *
 * Exit codes: 0 = 0 / 0 / 0; 1 = a structural violation; 2 = usage or file error.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const usage = "usage: node scripts/src/work-graph-check.mjs [graph.json]";

export function checkWorkGraph(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const counts = new Map();
  for (const node of nodes) counts.set(node.id, (counts.get(node.id) ?? 0) + 1);
  const ids = new Set(nodes.map((node) => node.id));
  const duplicates = [...counts.values()].filter((count) => count > 1).length;
  const dangling = nodes.reduce(
    (sum, node) => sum + (Array.isArray(node.dependsOn) ? node.dependsOn : []).filter((id) => !ids.has(id)).length,
    0,
  );
  const doneWithoutEvidence = nodes.filter(
    (node) => node.status === "done" && (!Array.isArray(node.evidence) || node.evidence.length === 0),
  ).length;
  return { duplicates, dangling, doneWithoutEvidence };
}

export function main(argv) {
  if (argv.length > 1) {
    console.error(usage);
    return 2;
  }
  const path = argv[0] ?? ".nomo/work-state.json";
  let graph;
  try {
    graph = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    console.error(`work-graph-check: graph could not be read as JSON: ${path}`);
    return 2;
  }
  const result = checkWorkGraph(graph);
  console.log(
    `graph-check: duplicate ids ${result.duplicates} / dangling deps ${result.dangling} / done without evidence ${result.doneWithoutEvidence}`,
  );
  return result.duplicates === 0 && result.dangling === 0 && result.doneWithoutEvidence === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
