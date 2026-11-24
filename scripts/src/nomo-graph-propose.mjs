#!/usr/bin/env node
/**
 * Turns observed gaps into pending graph nodes.
 *
 * An autonomous loop that only executes a fixed list stops being useful the
 * moment the list empties. This proposes the next nodes from evidence the
 * repository already carries, and it only ever appends `pending` nodes: a
 * proposal is not a decision, so the loop still has to execute and verify a
 * node before anything is marked done.
 *
 * Two sources, both machine readable:
 *   - a node whose `stopCondition` names missing evidence or measurement
 *     (blocked on data, not on a person) becomes `unblock-<id>`;
 *   - a documented harness setting still listed as a gap becomes
 *     `restore-setting-<key>`.
 *
 * Nothing here invents a goal, runs a model, or edits an existing node.
 *
 *   node scripts/src/nomo-graph-propose.mjs [--graph path] [--write]
 *
 * Exit codes: 0 = proposals printed (and written with --write); 3 = no gap
 * left to propose; 2 = the graph cannot be read.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const DEFAULT_GRAPH = resolve(root, ".nomo/work-state.json");
const INVENTORY = resolve(root, "scripts/src/harness-inventory.test.mjs");

/** A stop condition that waits for a person is not a gap the loop can close. */
const PERSON = /\b(user|operator|approval|authori[sz]ation|login|credential|release|deploy|push)\b/i;
const EVIDENCE = /\b(measure|measured|evidence|data|observed|effect|real provider|benchmark)\b/i;

const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Nodes the loop could unblock itself, from the graph alone. */
export function nodeGaps(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const known = new Set(nodes.map((node) => node.id));
  const out = [];
  for (const node of nodes) {
    if (node.status !== "blocked" && node.status !== "partial") continue;
    const condition = String(node.stopCondition ?? "");
    if (!condition || PERSON.test(condition) || !EVIDENCE.test(condition)) continue;
    const id = `unblock-${node.id}`;
    if (known.has(id)) continue;
    out.push({
      id,
      status: "pending",
      owner: "autoloop",
      dependsOn: [],
      scope: node.scope ?? [],
      protectedPaths: node.protectedPaths ?? ["nomo-web"],
      acceptance: [`Observed evidence satisfies the stop condition of ${node.id}: ${condition}`],
      verifier: node.verifier ?? [],
      evidence: [],
      stopCondition: "Met when the named evidence exists and is quoted in this node.",
      proposedFrom: node.id,
    });
  }
  return out;
}

/** Settings documented as gaps in the inventory gate. */
export function settingGaps(source) {
  const out = [];
  const pattern = /\["([A-Za-z][A-Za-z0-9]*)",\s*"([^"]+)"\]/g;
  for (const match of source.matchAll(pattern))
    out.push({
      id: `restore-setting-${slug(match[1])}`,
      status: "pending",
      owner: "autoloop",
      dependsOn: [],
      scope: ["packages/workbench/src/harness-settings.ts", "packages/workbench/src/index.ts"],
      protectedPaths: ["nomo-web"],
      acceptance: [`${match[1]} exists in source and has a consumer, or the gap is closed by a documented decision`],
      verifier: ["node --test scripts/src/harness-inventory.test.mjs"],
      evidence: [],
      stopCondition: `Met when ${match[1]} is no longer a documented gap.`,
      proposedFrom: "harness-inventory",
    });
  return out;
}

/** Proposals that are not already nodes, in a stable order. */
export function proposals(graph, inventorySource = "") {
  const known = new Set((graph?.nodes ?? []).map((node) => node.id));
  return [...nodeGaps(graph), ...settingGaps(inventorySource)].filter(
    (node) => !known.has(node.id),
  );
}

function main(argv) {
  const options = { graph: DEFAULT_GRAPH, write: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--write") options.write = true;
    else if (argv[index] === "--graph") options.graph = resolve(argv[index + 1] ?? ""), (index += 1);
  }
  let graph;
  try {
    graph = JSON.parse(readFileSync(options.graph, "utf8"));
  } catch {
    console.error(`graph-propose: cannot read a task graph at ${options.graph}`);
    return 2;
  }
  let inventory = "";
  try {
    inventory = readFileSync(INVENTORY, "utf8");
  } catch {
    inventory = "";
  }
  const found = proposals(graph, inventory);
  if (found.length === 0) {
    console.log("No gap to propose. Every blocked node waits on a person, and no documented gap is open.");
    return 3;
  }
  for (const node of found) console.log(`propose ${node.id}  from ${node.proposedFrom}`);
  if (options.write) {
    graph.nodes = [...(graph.nodes ?? []), ...found];
    graph.updatedAt = new Date().toISOString();
    writeFileSync(options.graph, `${JSON.stringify(graph, null, 2)}\n`);
    console.log(`wrote ${found.length} pending node(s) to ${options.graph}`);
  } else console.log("dry run: pass --write to append these as pending nodes");
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)))
  process.exitCode = main(process.argv.slice(2));
