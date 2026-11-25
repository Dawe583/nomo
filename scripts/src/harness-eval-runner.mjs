#!/usr/bin/env node
/**
 * Local governed-path eval runner adapter (H11).
 *
 * Reads one prompt on stdin and prints exactly one JSON decision line for
 * `harness-eval.mjs`. The adapter is deterministic and offline: it proposes a
 * candidate first action from the prompt, validates that candidate against the
 * governed tool catalog, classifies it with `workspaceToolClass`, and applies
 * the same fail-closed boundary for unknown tools and unsafe web requests.
 *
 * This is a plumbing and governance fixture, not evidence of model capability.
 * It does not call a model, a network, a provider or a tool. A real model
 * runner needs an explicitly approved provider adapter in a later node.
 *
 * Exit codes: 0 = a decision line was printed; 1 = no decision could be made.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { workspaceTools, workspaceToolClass } from "../../packages/workbench/src/workspace.ts";
import { TODO_WRITE_TOOL } from "../../packages/workbench/src/todo-tool.ts";
import { PLAN_TOOL } from "../../packages/workbench/src/plan.ts";
import { isBlockedWebIp } from "../../packages/workbench/src/web-tools.ts";

const REFUSAL = { tool: "none", class: "refused" };

/** `void_workspace_undo` is operator-governed recovery rather than a normal
 * mutating document tool, so it is absent from workspaceTools by design. The
 * eval runner may propose it, but still cannot execute it here. */
const SPECIAL_TOOLS = [{ name: "void_workspace_undo" }];
const GOVERNED_TOOLS = new Map(
  [...workspaceTools, TODO_WRITE_TOOL, PLAN_TOOL, ...SPECIAL_TOOLS].map((tool) => [tool.name, tool]),
);

function governedClass(tool) {
  if (tool === "void_workspace_undo") return "r1";
  return workspaceToolClass(tool);
}

function urls(text) {
  return text.match(/https?:\/\/[^\s)]+/gi) ?? [];
}

function unsafeUrlDecision(prompt) {
  for (const raw of urls(prompt)) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      return REFUSAL;
    }
    if (url.protocol !== "https:") return REFUSAL;
    if (url.port !== "" && url.port !== "443") return REFUSAL;
    const literal = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(literal) || literal.includes(":")) {
      if (isBlockedWebIp(literal)) return REFUSAL;
    }
    const name = literal.toLowerCase().replace(/\.$/, "");
    if (name === "localhost" || name.endsWith(".localhost") || name.endsWith(".local") || name.endsWith(".internal"))
      return REFUSAL;
  }
  return null;
}

function documentPath(prompt, fallback = "notes.md") {
  const match = /\b([A-Za-z0-9_.-]+\.md)\b/.exec(prompt);
  return match ? match[1] : fallback;
}

function replacementContent(prompt) {
  const match = /content with '([^']*)'|says '([^']*)'/.exec(prompt);
  return match ? (match[1] ?? match[2]) : "final";
}

/** Deterministic first-action proposal. The rules read intent words only;
 * they never read the taskset file or its expected answers. */
export function propose(prompt) {
  const text = prompt.toLowerCase();
  if (unsafeUrlDecision(prompt)) return REFUSAL;
  if (/shell_rm_rf|rm\s+-rf|unknown tool/.test(text)) return REFUSAL;

  if (/undo/.test(text) && /managed workspace|managed document|nomo managed/.test(text))
    return { tool: "void_workspace_undo", args: {} };
  if (/bound project|project's test command|test command/.test(text))
    return { tool: "nomo_project_exec", args: { command: "test" } };
  if (/checklist|track these/.test(text))
    return { tool: "todo_write", args: { items: [{ text: "fixture item", status: "pending" }] } };
  if (/(lay out|restate).*\bplan\b/.test(text))
    return { tool: "nomo_plan_update", args: { items: [{ id: "step-1", text: "fixture plan step", status: "pending" }] } };

  if (/delete every|remove every/.test(text) && /do not know which|not seen/.test(text))
    return { tool: "void_workspace_list", args: {} };
  if (/timed out|unproven|truncated|not seen its current content|have not seen/.test(text))
    return { tool: "void_workspace_read", args: { path: documentPath(prompt) } };
  if (/already read/.test(text) && /replacing|replace|write/.test(text))
    return { tool: "void_workspace_write", args: { path: documentPath(prompt), content: replacementContent(prompt) } };
  if (/remove|delete/.test(text) && /obsolete\.md|managed document/.test(text))
    return { tool: "void_workspace_delete", args: { path: documentPath(prompt, "obsolete.md") } };
  if (/list the existing|list documents/.test(text)) return { tool: "void_workspace_list", args: {} };
  if (/read the nomo managed document/.test(text)) return { tool: "void_workspace_read", args: { path: documentPath(prompt) } };
  if (/propose writing/.test(text)) return { tool: "void_workspace_write", args: { path: documentPath(prompt), content: replacementContent(prompt) } };
  return REFUSAL;
}

/** Validate and classify a proposed first action through the governed catalog. */
export function governDecision(proposal) {
  if (proposal.tool === "none") return REFUSAL;
  if (!GOVERNED_TOOLS.has(proposal.tool)) return REFUSAL;
  const klass = governedClass(proposal.tool);
  if (!klass) return REFUSAL;
  return { tool: proposal.tool, class: klass, args: proposal.args ?? {} };
}

export function decide(prompt, options = {}) {
  const decision = governDecision(propose(prompt));
  if (!options.includeArgs) return { tool: decision.tool, class: decision.class };
  return decision;
}

export function main(argv = process.argv.slice(2)) {
  const prompt = readFileSync(0, "utf8");
  const includeArgs = argv.includes("--with-args");
  const decision = decide(prompt, { includeArgs });
  if (!decision || typeof decision.tool !== "string" || typeof decision.class !== "string") return 1;
  const out = { tool: decision.tool, class: decision.class };
  if (includeArgs) out.args = decision.args ?? {};
  process.stdout.write(`${JSON.stringify(out)}\n`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main();
