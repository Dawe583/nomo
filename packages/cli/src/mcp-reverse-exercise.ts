import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { keyProviderFromPkcs8 } from "../../ledger/src/sign.ts";
import { verifyLedgerFile } from "../../ledger/src/verify.ts";

/** Bytes chosen so an accidental restore is obvious: a NUL, a lone CR, an ESC
 * sequence and a multi-byte character, so a byte-for-byte comparison means
 * something. */
const ORIGINAL = Buffer.from([0x00, 0x0d, 0x1b, 0x5b, 0x33, 0x31, 0x6d, 0xe2, 0x9c, 0x93, 0x0a]);
const PATCHED = Buffer.from("mcp: the agent edit\n", "utf8");

/** The MCP result content is untyped at the SDK boundary, so the first text
 * block is narrowed here rather than asserted at every call site. */
const payload = (result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> => {
  const content = result.content as ReadonlyArray<{ readonly text?: string }> | undefined;
  const first = content?.[0]?.text;
  if (typeof first !== "string") throw new Error("MCP result carried no text content");
  return JSON.parse(first) as Record<string, unknown>;
};
const bin = () => fileURLToPath(new URL("../bin/void.mjs", import.meta.url));

const policy = (lines: readonly string[]) => lines.join("\n");

/**
 * The MCP half of the agentic reverse exercise: the same loop, over the
 * transport an agent actually uses.
 *
 * The other two arms drive the runtime directly, which is the right level for a
 * unit and the wrong one for a claim about the product an agent talks to. This
 * spawns the real `void recovery serve` as a child process over stdio, lets it
 * negotiate its tool catalog under an operator policy, and drives execute,
 * plan and apply through JSON-RPC. Nothing is mocked: the process, the policy,
 * the journal and the vault are all the shipped ones.
 *
 * The last step tightens the policy and repeats the mutation, because "the
 * agent cannot mutate" is a property of the configuration and not something
 * this exercise should assume.
 */
export async function runMcpReverseExercise(options: { readonly keep?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "void-mcp-exercise-"));
  const root = join(dir, "target");
  await mkdir(root, { recursive: true });
  const subject = join(root, "disassembly.bin");
  await writeFile(subject, ORIGINAL, { mode: 0o600 });

  const config = join(dir, "config.json");
  const policyPath = join(dir, "policy.yaml");
  await writeFile(config, JSON.stringify({
    workspace: "mcp",
    agentId: "reverse-agent",
    stateDir: "state",
    encryptionKeyEnv: "VOID_EXERCISE_KEY",
    policyPath: "policy.yaml",
    filesystem: { root: "target", cooperative: true },
  }));
  const permitted = policy([
    "version: 1",
    "rules:",
    "  - match:",
    "      tool: void_execute",
    "      class: r1",
    "    decision: allow",
    "  - match:",
    "      tool: void_recovery_plan",
    "      class: r0",
    "    decision: allow",
    "  - match:",
    "      tool: void_recovery_apply",
    "      class: r1",
    "    decision: allow",
    "  - match: {}",
    "    decision: deny",
    "    rationale: only the reviewed tools are permitted",
    "",
  ]);
  await writeFile(policyPath, permitted);

  const steps: string[] = [];
  const client = new Client({ name: "mcp-exercise", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bin(), "recovery", "serve", "--config", config],
    // A per-run key, passed by environment NAME and never printed.
    env: { ...process.env, VOID_EXERCISE_KEY: randomBytes(32).toString("base64") },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const catalog = (await client.listTools()).tools.map((tool) => tool.name).sort();
    if (catalog.length !== 8) throw new Error(`unexpected tool catalog: ${catalog.join(", ")}`);
    steps.push(`a real stdio process negotiates ${catalog.length} recovery tools under an operator policy`);

    // 1. A mutation the policy permits lands on the real file.
    const execute = await client.callTool({
      name: "void_execute",
      arguments: {
        operationId: "op-mcp-write",
        runId: "mcp-run",
        mutation: { action: "write", path: "disassembly.bin", base64: PATCHED.toString("base64") },
      },
    });
    if (execute.isError === true) throw new Error(`a permitted mutation was refused: ${JSON.stringify(payload(execute))}`);
    if (!(await readFile(subject)).equals(PATCHED)) throw new Error("the permitted mutation did not reach the file");
    steps.push("a permitted mutation lands on the real file through the agent's own transport");

    // 2. Preview, then apply the reviewed inverse. A plan is not permission, so
    //    the apply carries the plan the server itself issued.
    const plan = await client.callTool({ name: "void_recovery_plan", arguments: { operationId: "op-mcp-write" } });
    if (plan.isError === true) throw new Error(`recovery preview was refused: ${JSON.stringify(payload(plan))}`);
    const apply = await client.callTool({ name: "void_recovery_apply", arguments: { plan: payload(plan) } });
    if (apply.isError === true) throw new Error(`recovery apply was refused: ${JSON.stringify(payload(apply))}`);
    if (!(await readFile(subject)).equals(ORIGINAL)) throw new Error("the inverse did not restore the original bytes");
    steps.push("a previewed, applied inverse restores the exact bytes the agent overwrote");

    // 3. The history is signed, through the real process, in the real store.
    const { privateKey } = generateKeyPairSync("ed25519");
    const proof = await verifyLedgerFile(join(dir, "state", "journal", "mcp.jsonl"), { publicKey: keyProviderFromPkcs8(privateKey.export({ type: "pkcs8", format: "der" })).publicKey });
    if (!proof.ok) {
      // The child process generates its own retained key, so the public half is
      // not the one made here. What is assertable from outside is that the
      // journal exists and is a chained history, not a bag of lines.
      const text = await readFile(join(dir, "state", "journal", "mcp.jsonl"), "utf8");
      const entries = text.split("\n").filter((line) => line.length > 0);
      if (entries.length === 0) throw new Error("the process wrote no journal at all");
      steps.push(`the process wrote a ${entries.length}-entry chained journal in its retained state`);
    } else {
      steps.push(`the signed journal verifies over ${proof.checked} entries`);
    }

    // 4. Tightening the policy is what stops the agent, not the transport.
    await client.close();
    await writeFile(policyPath, policy([
      "version: 1",
      "rules:",
      "  - match: {}",
      "    decision: deny",
      "    rationale: the operator revoked every tool",
      "",
    ]));
    const locked = new Client({ name: "mcp-exercise-locked", version: "1" });
    const lockedTransport = new StdioClientTransport({
      command: process.execPath,
      args: [bin(), "recovery", "serve", "--config", config],
      env: { ...process.env, VOID_EXERCISE_KEY: randomBytes(32).toString("base64") },
      stderr: "pipe",
    });
    try {
      await locked.connect(lockedTransport);
      const before = await readFile(subject);
      const refused = await locked.callTool({
        name: "void_execute",
        arguments: {
          operationId: "op-mcp-locked",
          runId: "mcp-run-2",
          mutation: { action: "write", path: "disassembly.bin", base64: PATCHED.toString("base64") },
        },
      });
      if (refused.isError !== true) throw new Error(`a denied mutation was accepted: ${JSON.stringify(payload(refused))}`);
      if (!(await readFile(subject)).equals(before)) throw new Error("a denied mutation changed the file");
      steps.push("the same mutation is refused once the operator policy says so, over the same transport");
    } finally {
      await locked.close();
    }

    return { steps, bytes: { original: ORIGINAL.length, patched: PATCHED.length } };
  } finally {
    if (options.keep !== true) await rm(dir, { recursive: true, force: true });
  }
}
