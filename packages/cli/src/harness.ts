/**
 * The harness proposals, from a terminal.
 *
 * The harness proposes and the operator decides, and the digest a decision
 * binds to is the only handle on a proposal: it is the hash of the exact
 * text the operator was shown. The interactive shell could show that digest
 * and decide it, and a script had no way in at all, so the loop could not be
 * driven from a terminal without the interactive surface.
 *
 * The command reads the same workbench the interactive shell uses, so the
 * proposals it lists are the proposals the shell would show: both read the
 * signed chain of the workspace, and neither holds a proposal in process
 * memory.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Workbench } from "../../workbench/src/index.ts";
import type { HarnessSettings } from "../../workbench/src/harness-settings.ts";
import {
  EVAL_TOOL_SCHEMA,
  evalCaseAttribution,
  evalToolRecord,
  type EvalToolInput,
  type EvalToolRecord,
} from "../../workbench/src/harness-eval-tools.ts";
import {
  REWARD_SCHEMA,
  SCORE_GUARDRAILS,
  measureBoard,
  rewardRecord,
  scoreCases,
  type RewardInput,
  type RewardRecord,
  type RewardIngestionProvenance,
} from "../../workbench/src/harness-scores.ts";
import { dataDir } from "../../ledger/src/paths.ts";

export type HarnessIo = {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
};

/** The part of the workbench this command uses. Narrow on purpose: the
 * command is a reader and a decider, and it does not need the run path. */
export type HarnessSurface = {
  /** A live session, when the surface owns sessions. */
  get?(id: string): { readonly workspace: string } | undefined;
  /** The signed chain of a workspace, verified. Optional: a test double may
   * omit it, and the ratchet reports that there is nothing to measure. */
  ledger?(
    workspace: string,
  ): Promise<
    | {
        readonly entries: readonly { readonly body: unknown; readonly seq: number }[];
        readonly result: unknown;
        readonly verification: unknown;
      }
    | undefined
  >;
  /** The entries the harness currently holds for a session's workspace. */
  harnessEntries(
    sessionId: string,
  ): Promise<
    readonly {
      readonly id: string;
      readonly kind: string;
      readonly title: string;
      readonly content: string;
      readonly tool: string;
      readonly klass: string;
      readonly repeats: number;
      readonly decidedByOperator?: boolean;
      /** The mined rule as policy file text, when the entry is one. Produced
       * by the workbench beside the rule, so the terminal and the web panel
       * print the same text. Printed so an operator can copy it into their
       * own file. */
      readonly policyText?: readonly string[];
    }[]
  >;
  /** The resolved harness settings, when the surface owns them. */
  harnessSettings?(): HarnessSettings;
  /** The reviewer model selection, as resolved. */
  harnessTextSettings(): { readonly refinementModel: string };
  patchHarnessTextSettings(
    body: Record<string, unknown>,
  ): { readonly refinementModel: string };
  /** Append one measured reward record, when the surface owns the chain. */
  recordHarnessReward?(
    sessionId: string,
    input: RewardInput,
    provenance?: RewardIngestionProvenance,
  ): Promise<RewardRecord>;
  /** Append one governed eval tool measurement, when the surface owns the chain. */
  recordHarnessEvalTool?(
    sessionId: string,
    input: EvalToolInput,
    provenance?: RewardIngestionProvenance,
  ): Promise<EvalToolRecord>;
  /** Start one production run bound to eval case identity, when the surface
   * owns runs. The command waits for settlement so its output is the observed
   * terminal state rather than a claim that work merely began. Reward remains
   * a separate measurement. */
  startHarnessEval?(
    prompt: string,
    model: string | undefined,
    attribution: unknown,
    agent?: string,
    idempotencyKey?: string,
  ): Promise<{ readonly id: string; readonly status?: string; readonly idempotentReplay?: boolean }>;
  /** Wait for one run, when the surface owns runs. */
  waitForRun?(id: string): Promise<{ readonly status?: string }>;
  /** Validate one eval verifier before any provider run starts. */
  validateHarnessEvalGate?(command: string): string;
  /** Run one operator-allowlisted eval verifier, when the surface owns hooks. */
  runHarnessEvalGate?(
    sessionId: string,
    command: string,
  ): Promise<{
    readonly outcome: "exited" | "timeout" | "spawn-error" | "disabled";
    readonly code: number | null;
    readonly durationMs: number;
    readonly passed: boolean;
  }>;
  pendingApprovalsFor(
    sessionId: string,
  ): Promise<
    readonly {
      readonly digest: string;
      readonly at: string;
      readonly summary: string;
      /** The workbench's own review text for a subagent or skill edit. Printed
       * beside the proposal so the terminal shows the same before/after and
       * parent bound the web panel does. */
      readonly profileReviewText?: string;
      readonly skillReviewText?: string;
      readonly proposal: {
        readonly edits: readonly {
          readonly action: string;
          readonly kind: string;
          readonly title?: string;
          readonly content?: string;
          readonly promptAddendum?: string;
          readonly derivedFromSeq: readonly number[];
        }[];
      };
    }[]
  >;
  approveHarnessProposal(
    sessionId: string,
    digest: string,
  ): Promise<{ readonly applied: readonly unknown[] }>;
  rejectHarnessProposal(
    sessionId: string,
    digest: string,
    reason?: string,
  ): Promise<void>;
  rollbackHarnessProposal(
    sessionId: string,
    digest: string,
  ): Promise<{ readonly applied: readonly unknown[] }>;
};

export type HarnessDeps = {
  readonly env?: Readonly<NodeJS.ProcessEnv>;
  /** Injected so a test does not open the operator's real workspace. */
  readonly workbench?: () => Promise<HarnessSurface>;
};

/** Where the workbench keeps its state, resolved the way the workbench
 * resolves it. */
function workspaceDir(env: Readonly<NodeJS.ProcessEnv>): string {
  return (
    env.NOMO_DATA_DIR ??
    join(env.NOMO_LEDGER_DIR ?? dataDir(homedir()), "workbench")
  );
}

const USAGE = [
  "usage:",
  "  nomo harness list --session <id>",
  "  nomo harness approve --session <id> <digest>",
  "  nomo harness reject --session <id> <digest> --reason <text>",
  "  nomo harness rollback --session <id> <digest>",
  "  nomo harness reward --session <id> <caseId> show measured reward records",
  "  nomo harness ingest-rewards --session <id> <records.jsonl> append measured eval rewards",
  "  nomo harness ingest-eval --session <id> <measurements.jsonl> append rewards and attributed tool measurements",
  "  nomo harness run-eval --case <id> --variant <id> --run <n> (--prompt <text> | --prompt-file <path>) [--model <id>] [--agent <id>] [--idempotency-key <key>] [--gate <exact-command> --weights breach=<n>,cost=<n>,latency=<n>]",
  "                                      run one attributed production eval case and wait; provider cost may apply",
  "  nomo harness entries --session <id> show what the harness holds",
  "  nomo harness ratchet --session <id> measure the guardrails before and after the last refinement",
  "  nomo harness trend --session <id> show measured effects by activation",
  "  nomo harness model                 show the reviewer model",
  "  nomo harness model <model-id>      set the reviewer model",
  "  nomo harness model --clear         use the conversation's own model",
].join("\n");

type Flags = {
  readonly session: string;
  readonly reason: string;
  readonly digest: string;
  readonly clear: boolean;
  readonly caseId: string;
  readonly variantId: string;
  readonly run: string;
  readonly model: string;
  readonly agent: string;
  readonly prompt: string;
  readonly promptFile: string;
  readonly idempotencyKey: string;
  readonly gate: string;
  readonly weights: string;
  readonly unknown: readonly string[];
};

function parseFlags(args: readonly string[]): Flags {
  let session = "";
  let reason = "";
  let digest = "";
  let clear = false;
  let caseId = "";
  let variantId = "";
  let run = "";
  let model = "";
  let agent = "";
  let prompt = "";
  let promptFile = "";
  let idempotencyKey = "";
  let gate = "";
  let weights = "";
  const unknown: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--clear") {
      clear = true;
      continue;
    }
    if (arg === "--session") {
      session = args[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--reason") {
      reason = args[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--case") {
      caseId = args[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--variant") {
      variantId = args[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--run") {
      run = args[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--model") {
      model = args[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--agent") {
      agent = args[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--prompt") {
      prompt = args[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--prompt-file") {
      promptFile = args[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--idempotency-key") {
      idempotencyKey = args[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--gate") {
      gate = args[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--weights") {
      weights = args[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      unknown.push(arg);
      continue;
    }
    digest = arg;
  }
  return { session, reason, digest, clear, caseId, variantId, run, model, agent, prompt, promptFile, idempotencyKey, gate, weights, unknown };
}

const REWARD_FIELDS = [
  "schema",
  "caseId",
  "variantId",
  "baselineVariantId",
  "changedAxis",
  "passed",
  "guardrails",
  "costUsd",
  "latencyMs",
  "approvalMs",
  "weights",
  "reward",
] as const;
const REWARD_FIELD_SET = new Set<string>(REWARD_FIELDS);
const MAX_REWARD_FILE_BYTES = 1024 * 1024;
const MAX_EVAL_PROMPT_FILE_BYTES = 1024 * 1024;
const REWARD_IDENTIFIER = /^[A-Za-z0-9_.:\/-]{1,128}$/;
const rewardIdentifier = (value: unknown): value is string =>
  typeof value === "string" && REWARD_IDENTIFIER.test(value);

type ValidatedReward = {
  readonly kind: "reward";
  readonly input: RewardInput;
};

type ValidatedEvalTool = {
  readonly kind: "eval-tool";
  readonly input: EvalToolInput;
};

type ValidatedMeasurement = ValidatedReward | ValidatedEvalTool;

/**
 * Validate one exported reward without printing its content. `rewardRecord`
 * rebuilds the measurement from explicit fields; the stored reward must equal
 * that recomputation exactly, so a tampered file is refused rather than
 * silently corrected. Unknown fields are refused because they are outside the
 * schema and could be a side channel for prompt or tool content.
 */
function validateExportedReward(value: unknown, where: string): ValidatedReward {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${where}: expected a reward object`);
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !REWARD_FIELD_SET.has(key)))
    throw new Error(`${where}: unknown reward field`);
  if (body.schema !== REWARD_SCHEMA)
    throw new Error(`${where}: expected schema ${REWARD_SCHEMA}`);
  if (
    body.guardrails === null ||
    typeof body.guardrails !== "object" ||
    Array.isArray(body.guardrails)
  )
    throw new Error(`${where}: guardrails must be an object`);
  if (!rewardIdentifier(body.caseId) || !rewardIdentifier(body.variantId))
    throw new Error(`${where}: caseId and variantId must be bounded identifiers`);
  for (const key of ["baselineVariantId", "changedAxis"] as const)
    if (body[key] !== null && !rewardIdentifier(body[key]))
      throw new Error(`${where}: ${key} must be a bounded identifier or null`);
  if (Object.keys(body.guardrails).some((key) => !REWARD_IDENTIFIER.test(key)))
    throw new Error(`${where}: guardrail names must be bounded identifiers`);
  if (
    body.weights === null ||
    typeof body.weights !== "object" ||
    Array.isArray(body.weights) ||
    Object.keys(body.weights).some((key) => !["breach", "cost", "latency"].includes(key))
  )
    throw new Error(`${where}: weights must contain only breach, cost and latency`);
  let record: RewardRecord;
  try {
    record = rewardRecord(body as unknown as RewardInput);
  } catch (error) {
    throw new Error(
      `${where}: invalid reward record: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (record.reward !== body.reward)
    throw new Error(`${where}: stored reward does not recompute`);
  return { kind: "reward", input: body as unknown as RewardInput };
}

/** Validate one exported eval tool measurement without printing its content. */
function validateExportedEvalTool(value: unknown, where: string): ValidatedEvalTool {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${where}: expected an eval tool object`);
  const body = value as Record<string, unknown>;
  if (body.schema !== EVAL_TOOL_SCHEMA)
    throw new Error(`${where}: expected schema ${EVAL_TOOL_SCHEMA}`);
  try {
    const record = evalToolRecord(body as unknown as EvalToolInput);
    const { schema: _schema, ...input } = record;
    return { kind: "eval-tool", input };
  } catch (error) {
    throw new Error(
      `${where}: invalid eval tool record: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** The ingestion position carried by one chain body when it belongs to the
 * file currently being ingested. Hostile or malformed metadata is ignored as
 * provenance, never trusted as a reason to skip a measurement. */
function chainedIngestionIndex(body: unknown, fileDigest: string, count: number): number | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const ingestion = (body as Record<string, unknown>).rewardIngestion;
  if (ingestion === null || typeof ingestion !== "object" || Array.isArray(ingestion)) return null;
  const provenance = ingestion as Record<string, unknown>;
  if (
    provenance.fileDigest !== fileDigest ||
    provenance.count !== count ||
    !Number.isSafeInteger(provenance.index) ||
    (provenance.index as number) < 0 ||
    (provenance.index as number) >= count
  )
    return null;
  return provenance.index as number;
}

/** One line per edit, so a proposal can be read in a terminal. */
function describeEdit(edit: {
  readonly action: string;
  readonly kind: string;
  readonly title?: string;
  readonly content?: string;
  readonly promptAddendum?: string;
  readonly derivedFromSeq: readonly number[];
}): string {
  const text =
    edit.kind === "prompt"
      ? (edit.promptAddendum ?? "")
      : (edit.content ?? "");
  const body = text.length > 160 ? `${text.slice(0, 160)}...` : text;
  return `    ${edit.action} ${edit.kind}: ${edit.title ?? ""}${
    body ? ` | ${body}` : ""
  } | records ${edit.derivedFromSeq.join(", ")}`;
}

const objectRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function matchesEvalAttribution(body: Record<string, unknown>, attribution: ReturnType<typeof evalCaseAttribution>): boolean {
  const evalIdentity = objectRecord(body.harnessEval);
  return (
    evalIdentity?.caseId === attribution.caseId &&
    evalIdentity.variantId === attribution.variantId &&
    evalIdentity.run === attribution.run
  );
}

function measuredUsageCost(
  entries: readonly { readonly body: unknown }[],
  attribution: ReturnType<typeof evalCaseAttribution>,
  requiredWorkspaces: number,
): RewardInput["costUsd"] {
  const receipts = entries
    .map((entry) => objectRecord(entry.body))
    .filter((body): body is Record<string, unknown> =>
      body !== null && body.tool === "harness.usage" && matchesEvalAttribution(body, attribution),
    );
  const measuredWorkspaces = new Set(receipts.map((receipt) => receipt.workspace));
  if (receipts.length === 0 || measuredWorkspaces.size < requiredWorkspaces) return "unmeasured";
  let total = 0;
  for (const receipt of receipts) {
    const cost = receipt.costUsd;
    if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)
      return "unmeasured";
    total += cost;
  }
  return total;
}

async function evalUsageEvidence(
  workbench: HarnessSurface,
  workspace: string,
  attribution: ReturnType<typeof evalCaseAttribution>,
): Promise<{
  readonly entries: readonly { readonly body: unknown }[];
  readonly complete: boolean;
  readonly workspaceCount: number;
}> {
  const rootEntries = (await workbench.ledger!(workspace))?.entries ?? [];
  const childWorkspaces = new Set<string>();
  for (const entry of rootEntries) {
    const body = objectRecord(entry.body);
    if (
      body?.tool === "void_subagent_spawn" &&
      matchesEvalAttribution(body, attribution) &&
      typeof body.childWorkspace === "string" &&
      body.childWorkspace.length > 0 &&
      body.childWorkspace.length <= 160
    )
      childWorkspaces.add(body.childWorkspace);
  }
  const entries: { readonly body: unknown }[] = [...rootEntries];
  let complete = true;
  for (const childWorkspace of childWorkspaces) {
    const child = await workbench.ledger!(childWorkspace);
    if (!child) complete = false;
    else entries.push(...child.entries);
  }
  return { entries, complete, workspaceCount: 1 + childWorkspaces.size };
}

function measuredEvalGuardrails(
  entries: readonly { readonly body: unknown }[],
  attribution: ReturnType<typeof evalCaseAttribution>,
  complete: boolean,
): RewardInput["guardrails"] {
  if (!complete)
    return Object.fromEntries(SCORE_GUARDRAILS.map((key) => [key, "unmeasured"]));
  const attributed = entries.filter((entry) => {
    const body = objectRecord(entry.body);
    return body !== null && matchesEvalAttribution(body, attribution);
  });
  const board = measureBoard(scoreCases(attributed), new Date().toISOString());
  const guardrails: Record<string, number | "unmeasured"> = {};
  for (const key of SCORE_GUARDRAILS) {
    const summary = board.guardrails[key];
    guardrails[key] =
      summary.n > 0 && typeof summary.mean === "number" && Number.isFinite(summary.mean) && summary.mean >= 0
        ? summary.mean
        : "unmeasured";
  }
  return guardrails;
}

function existingEvalGates(
  entries: readonly { readonly body: unknown }[],
  attribution: ReturnType<typeof evalCaseAttribution>,
): Record<string, unknown>[] {
  return entries
    .map((entry) => objectRecord(entry.body))
    .filter((body): body is Record<string, unknown> =>
      body !== null && body.tool === "harness.eval-gate" && matchesEvalAttribution(body, attribution),
    );
}

function existingEvalRewards(
  entries: readonly { readonly body: unknown }[],
  attribution: ReturnType<typeof evalCaseAttribution>,
): RewardRecord[] {
  return entries
    .map((entry) => objectRecord(entry.body))
    .filter((body): body is Record<string, unknown> =>
      body !== null && body.schema === REWARD_SCHEMA && matchesEvalAttribution(body, attribution),
    )
    .map((body) => body as unknown as RewardRecord);
}

function rewardRecomputes(record: RewardRecord): boolean {
  try {
    return rewardRecord(record as unknown as RewardInput).reward === record.reward;
  } catch {
    return false;
  }
}

function sameMeasurementWeights(record: RewardRecord, weights: RewardInput["weights"]): boolean {
  return (
    record.weights.breach === weights.breach &&
    record.weights.cost === weights.cost &&
    record.weights.latency === weights.latency &&
    record.baselineVariantId === null &&
    record.changedAxis === null
  );
}

function parseWeightsArg(text: string): RewardInput["weights"] {
  const weights: Record<string, number> = {};
  for (const part of text.split(",")) {
    const match = /^(breach|cost|latency)=([0-9]+(?:\.[0-9]+)?)$/.exec(part);
    if (!match || weights[match[1]!] !== undefined)
      throw new Error("Invalid weights: use exactly breach=<n>,cost=<n>,latency=<n> with non-negative finite numbers.");
    weights[match[1]!] = Number(match[2]);
  }
  if (Object.keys(weights).length !== 3)
    throw new Error("Invalid weights: use exactly breach=<n>,cost=<n>,latency=<n> with non-negative finite numbers.");
  return weights as unknown as RewardInput["weights"];
}

/**
 * A harness decision binds only to the full digest the operator typed.
 * Short shell rendering is display text, never authorization input.
 */
async function resolveDigest(
  workbench: HarnessSurface,
  sessionId: string,
  typed: string,
): Promise<string> {
  void workbench;
  void sessionId;
  if (!/^[a-f0-9]{64}$/.test(typed))
    throw new Error("Enter the full 64 hexadecimal digest characters.");
  return typed;
}

export async function runHarnessCommand(
  args: readonly string[],
  io: HarnessIo,
  deps: HarnessDeps = {},
): Promise<number> {
  const action = args[0] ?? "";
  if (!action || action === "--help" || action === "-h") {
    io.stdout(USAGE);
    return action ? 0 : 1;
  }
  if (!["list", "entries", "approve", "reject", "rollback", "reward", "ingest-rewards", "ingest-eval", "run-eval", "model", "ratchet", "trend"].includes(action)) {
    io.stderr(`Unknown harness action ${action}.`);
    io.stderr(USAGE);
    return 1;
  }
  const flags = parseFlags(args.slice(1));
  if (flags.unknown.length) {
    io.stderr(`Unknown option ${flags.unknown[0]}.`);
    io.stderr(USAGE);
    return 1;
  }
  if (
    action !== "run-eval" &&
    (flags.caseId || flags.variantId || flags.run || flags.model || flags.agent || flags.prompt || flags.promptFile || flags.idempotencyKey || flags.gate || flags.weights)
  ) {
    io.stderr("The eval case, variant, run, model, agent, prompt, idempotency, gate and weights options belong to run-eval.");
    io.stderr(USAGE);
    return 1;
  }
  if (action === "model") {
    const env = deps.env ?? process.env;
    if (!deps.workbench) {
      const directory = workspaceDir(env);
      if (!existsSync(directory)) {
        io.stderr(`No workspace at ${directory}. Run nomo init first.`);
        return 1;
      }
    }
    const workbench = deps.workbench
      ? await deps.workbench()
      : new Workbench(env);
    try {
      if (flags.clear) {
        const applied = workbench.patchHarnessTextSettings({ refinementModel: "" });
        io.stdout(
          `The reviewer runs on the conversation's own model now (${applied.refinementModel || "unset"}).`,
        );
        return 0;
      }
      if (!flags.digest) {
        const current = workbench.harnessTextSettings();
        io.stdout(
          current.refinementModel
            ? `The reviewer runs on ${current.refinementModel}.`
            : "The reviewer runs on the conversation's own model.",
        );
        return 0;
      }
      const applied = workbench.patchHarnessTextSettings({
        refinementModel: flags.digest,
      });
      io.stdout(`The reviewer runs on ${applied.refinementModel}.`);
      return 0;
    } catch (error) {
      io.stderr(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }
  if (!flags.session && !["model", "ratchet", "run-eval"].includes(action)) {
    io.stderr("The harness commands need a session: --session <id>.");
    io.stderr(USAGE);
    return 1;
  }
  if (!["list", "entries", "model", "ratchet", "trend", "run-eval"].includes(action) && !flags.digest) {
    io.stderr(
      `The ${action} action needs ${
        action === "reward"
          ? "a case id"
          : action === "ingest-rewards" || action === "ingest-eval"
            ? "a records JSONL file"
            : "the digest of the proposal"
      }.`,
    );
    io.stderr(USAGE);
    return 1;
  }
  if (action === "reject" && !flags.reason) {
    io.stderr("A rejection needs a reason: --reason <text>.");
    return 1;
  }
  const env = deps.env ?? process.env;
  if (!deps.workbench) {
    // The workbench writes its storage key when it is constructed, so a
    // command that only reads would create a workspace on a machine that has
    // none. The refusal names the path and the command that creates it.
    const directory = workspaceDir(env);
    if (!existsSync(directory)) {
      io.stderr(`No workspace at ${directory}. Run nomo init first.`);
      return 1;
    }
  }
  const workbench = deps.workbench
    ? await deps.workbench()
    : new Workbench(env);
  try {
    if (action === "run-eval") {
      if (flags.digest) {
        io.stderr("run-eval takes its prompt through --prompt or --prompt-file, not a positional argument.");
        return 1;
      }
      if (
        !workbench.startHarnessEval ||
        !workbench.waitForRun ||
        (flags.gate && (!workbench.runHarnessEvalGate || !workbench.validateHarnessEvalGate))
      ) {
        io.stderr("This harness surface cannot start measured production eval runs.");
        return 1;
      }
      if ((flags.gate ? 1 : 0) !== (flags.weights ? 1 : 0)) {
        io.stderr("run-eval measurement needs --gate and --weights together.");
        return 1;
      }
      let weights: RewardInput["weights"] | undefined;
      if (flags.weights) {
        try {
          weights = parseWeightsArg(flags.weights);
        } catch (error) {
          io.stderr(error instanceof Error ? error.message : String(error));
          return 1;
        }
      }
      if ((flags.prompt ? 1 : 0) + (flags.promptFile ? 1 : 0) !== 1) {
        io.stderr("run-eval needs exactly one prompt source: --prompt <text> or --prompt-file <path>.");
        return 1;
      }
      let gateCommand = flags.gate;
      if (flags.gate) {
        try {
          gateCommand = workbench.validateHarnessEvalGate!(flags.gate);
        } catch (error) {
          io.stderr(error instanceof Error ? error.message : String(error));
          return 1;
        }
      }
      let attribution;
      try {
        attribution = evalCaseAttribution({
          caseId: flags.caseId,
          variantId: flags.variantId,
          run: flags.run === "" ? Number.NaN : Number(flags.run),
        });
      } catch (error) {
        io.stderr(error instanceof Error ? error.message : String(error));
        return 1;
      }
      let prompt = flags.prompt;
      if (flags.promptFile) {
        try {
          const info = await stat(flags.promptFile);
          if (!info.isFile() || info.size > MAX_EVAL_PROMPT_FILE_BYTES) {
            io.stderr("Invalid prompt file: expected a text file of at most 1 MiB.");
            return 1;
          }
          prompt = await readFile(flags.promptFile, "utf8");
        } catch {
          io.stderr("Prompt file could not be read.");
          return 1;
        }
      }
      const runStartedAt = Date.now();
      const started = await workbench.startHarnessEval(
        prompt,
        flags.model || undefined,
        attribution,
        flags.agent || undefined,
        flags.idempotencyKey || undefined,
      );
      const settled = await workbench.waitForRun(started.id);
      const latencyMs = Math.max(0, Date.now() - runStartedAt);
      io.stdout(`run-eval: session ${started.id} status ${settled.status ?? "unknown"}`);
      if (settled.status !== "idle") return 1;
      if (!flags.gate) return 0;
      const session = workbench.get?.(started.id);
      if (!session || !workbench.ledger) {
        io.stderr("This harness surface cannot read signed eval measurement evidence.");
        return 1;
      }
      const proof = await workbench.ledger(session.workspace);
      const entries = proof?.entries ?? [];
      const usageEvidence = await evalUsageEvidence(workbench, session.workspace, attribution);
      const existing = existingEvalRewards(entries, attribution)
        .filter((record) => sameMeasurementWeights(record, weights!));
      if (existing.length > 1 || existing.some((record) => !rewardRecomputes(record))) {
        io.stderr("Existing eval reward evidence is ambiguous or invalid, so no new reward was recorded.");
        return 1;
      }
      if (existing.length === 1) {
        const record = existing[0]!;
        io.stdout(`run-eval: verifier ${record.passed ? "passed" : "failed"} reward ${String(record.reward)} reused`);
        return 0;
      }
      const priorGates = existingEvalGates(entries, attribution).filter((body) => body.outcome === "exited");
      if (priorGates.length > 1) {
        io.stderr("Existing eval verifier evidence is ambiguous, so no new reward was recorded.");
        return 1;
      }
      let gate: { readonly outcome: string; readonly passed: boolean };
      if (priorGates.length === 1) {
        const prior = priorGates[0]!;
        const passed = prior.decision === "eval-gate:passed";
        const expectedDigest = `sha256:${createHash("sha256").update(gateCommand).digest("hex")}`;
        if (
          prior.commandDigest !== expectedDigest ||
          prior.passed !== passed ||
          (prior.decision !== "eval-gate:passed" && prior.decision !== "eval-gate:failed")
        ) {
          io.stderr("Existing eval verifier evidence is inconsistent, so no new reward was recorded.");
          return 1;
        }
        gate = { outcome: "exited", passed };
      } else {
        gate = await workbench.runHarnessEvalGate!(started.id, gateCommand);
      }
      if (gate.outcome !== "exited") {
        io.stderr("The eval verifier did not produce a pass or fail outcome, so no reward was recorded.");
        return 1;
      }
      const record = await workbench.recordHarnessReward!(started.id, {
        caseId: attribution.caseId,
        variantId: attribution.variantId,
        baselineVariantId: null,
        changedAxis: null,
        passed: gate.passed,
        guardrails: measuredEvalGuardrails(usageEvidence.entries, attribution, usageEvidence.complete),
        costUsd: usageEvidence.complete
          ? measuredUsageCost(usageEvidence.entries, attribution, usageEvidence.workspaceCount)
          : "unmeasured",
        latencyMs: started.idempotentReplay === true ? "unmeasured" : latencyMs,
        approvalMs: "unmeasured",
        weights: weights!,
      });
      io.stdout(`run-eval: verifier ${gate.passed ? "passed" : "failed"} reward ${String(record.reward)}`);
      return 0;
    }
    if (action === "ingest-rewards" || action === "ingest-eval") {
      if (!workbench.recordHarnessReward || (action === "ingest-eval" && !workbench.recordHarnessEvalTool)) {
        io.stderr("This harness surface cannot record measured eval evidence.");
        return 1;
      }
      const session = workbench.get?.(flags.session);
      if (!session) {
        io.stderr("Session not found.");
        return 1;
      }
      let raw;
      try {
        const info = await stat(flags.digest);
        if (!info.isFile() || info.size > MAX_REWARD_FILE_BYTES) {
          io.stderr("Invalid reward file: expected a reward JSONL file of at most 1 MiB. Nothing was written.");
          return 1;
        }
        raw = await readFile(flags.digest, "utf8");
      } catch {
        io.stderr("Reward records could not be read.");
        return 1;
      }
      const lines = raw.split(/\r?\n/);
      const validated: ValidatedMeasurement[] = [];
      for (const [index, line] of lines.entries()) {
        if (!line.trim()) continue;
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          io.stderr(`Invalid reward file: line ${index + 1} is not JSON. Nothing was written.`);
          return 1;
        }
        try {
          const schema = value !== null && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>).schema
            : undefined;
          validated.push(
            action === "ingest-eval" && schema === EVAL_TOOL_SCHEMA
              ? validateExportedEvalTool(value, `line ${index + 1}`)
              : validateExportedReward(value, `line ${index + 1}`),
          );
        } catch (error) {
          io.stderr(
            `Invalid reward file: ${error instanceof Error ? error.message : String(error)}. Nothing was written.`,
          );
          return 1;
        }
      }
      if (!validated.length) {
        io.stderr("Invalid reward file: no reward records. Nothing was written.");
        return 1;
      }

      const fileDigest = createHash("sha256").update(raw).digest("hex");
      const count = validated.length;
      const proof = workbench.ledger ? await workbench.ledger(session.workspace) : undefined;
      const ingested = new Set(
        (proof?.entries ?? [])
          .map((entry) => chainedIngestionIndex(entry.body, fileDigest, count))
          .filter((index): index is number => typeof index === "number"),
      );
      const toWrite = validated
        .map((record, index) => ({
          record,
          provenance: { fileDigest, index, count },
        }))
        .filter(({ provenance }) => !ingested.has(provenance.index));
      const duplicates = validated.length - toWrite.length;
      for (const { record, provenance } of toWrite) {
        if (record.kind === "reward")
          await workbench.recordHarnessReward(flags.session, record.input, provenance);
        else
          await workbench.recordHarnessEvalTool!(flags.session, record.input, provenance);
      }
      const rewardCount = validated.filter((record) => record.kind === "reward").length;
      const toolCount = validated.length - rewardCount;
      const noun = action === "ingest-eval" ? "ingest-eval" : "ingest-rewards";
      io.stdout(
        `${noun}: ${toWrite.length} written, ${duplicates} duplicates skipped, ${validated.length} validated` +
          (action === "ingest-eval" ? `, ${rewardCount} rewards, ${toolCount} tool-records` : ""),
      );
      return 0;
    }
    if (action === "reward") {
      const session = workbench.get?.(flags.session);
      if (!session) {
        io.stderr("Session not found.");
        return 1;
      }
      const proof = await workbench.ledger?.(session.workspace);
      const entries = proof?.entries ?? [];
      const matches = entries.filter((entry) => {
        const body = entry.body as Record<string, unknown> | null;
        return body?.schema === "nomo.reward.v1" && body.caseId === flags.digest;
      });
      if (!matches.length) {
        io.stdout(`No reward record for case ${JSON.stringify(flags.digest)}.`);
        return 0;
      }
      const { computeReward } = await import("../../workbench/src/harness-scores.ts");
      const { rewardCostLatencyWeights } = await import("../../workbench/src/harness-settings.ts");
      const settings = workbench.harnessSettings?.();
      for (const entry of matches) {
        const record = entry.body as Parameters<typeof computeReward>[0] & {
          readonly reward: number | "unmeasured";
          readonly weights: { readonly breach: number };
        };
        let recomputed;
        try {
          recomputed = computeReward(record);
        } catch (error) {
          io.stderr(
            `Invalid reward record at seq ${entry.seq}: ${error instanceof Error ? error.message : String(error)}`,
          );
          return 1;
        }
        if (recomputed !== record.reward) {
          io.stderr(
            `Invalid reward record at seq ${entry.seq}: stored ${String(record.reward)} recomputes to ${String(recomputed)}.`,
          );
          return 1;
        }
        let current = "not-read";
        if (settings) {
          const weights = {
            breach: record.weights.breach,
            ...rewardCostLatencyWeights(settings),
          };
          current = String(computeReward({ ...record, weights }));
        }
        io.stdout(
          `seq ${entry.seq} case=${JSON.stringify(record.caseId)} variant=${JSON.stringify(record.variantId)} ` +
            `reward=${String(record.reward)} recompute=match currentWeightsReward=${current} ` +
            `costUsd=${String(record.costUsd)} latencyMs=${String(record.latencyMs)} approvalMs=${String(record.approvalMs)}`,
        );
      }
      return 0;
    }
    if (action === "trend") {
      const session = workbench.get?.(flags.session);
      if (!session) {
        io.stderr("Session not found.");
        return 1;
      }
      const proof = await workbench.ledger?.(session.workspace);
      const { formatEffectsForReview, mineRefinementEffects } = await import(
        "../../workbench/src/refinement-outcomes.ts"
      );
      const effects = mineRefinementEffects(proof?.entries ?? []);
      const report = formatEffectsForReview(effects, 16_384);
      io.stdout(
        report ||
          (effects.length
            ? "No activation fits the report limit."
            : "No signed refinement activation to measure."),
      );
      return 0;
    }
    if (action === "ratchet") {
      // The workbench owns the sessions; a test double may not, so the
      // session lookup falls back to a pending-proposals probe.
      let session: { readonly workspace: string } | undefined;
      try {
        session = workbench.get ? workbench.get(flags.session) : undefined;
      } catch {
        session = undefined;
      }
      if (!session) {
        io.stderr("Session not found.");
        return 1;
      }
      const proof = workbench.ledger
        ? await workbench.ledger(session.workspace)
        : undefined;
      const entries = (proof?.entries ?? []) as readonly {
        readonly body: unknown;
        readonly seq: number;
      }[];
      const now = new Date().toISOString();
      io.stdout(
        "The harness board is descriptive only. It never changes a decision or permission.",
      );
      io.stdout("");
      if (!entries.length) {
        io.stdout("No signed entry in this workspace, so there is nothing to measure.");
        return 0;
      }
      const previous = [...entries]
        .reverse()
        .find(
          (entry) =>
            (entry.body as Record<string, unknown> | null)?.decision ===
            "proposal:activated",
        );
      if (!previous) {
        const { measureBoard, scoreCases } = await import(
          "../../workbench/src/harness-scores.ts"
        );
        const current = measureBoard(scoreCases(entries), now);
        io.stdout("No previous refinement: nothing to compare against.");
        io.stdout(
          `Current board: verdict ${current.verdict}, ${current.caseCount} cases, deny_rate ${current.metrics.deny_rate.n} measured.`,
        );
        return 0;
      }
      const baselineIndex = entries.indexOf(previous);
      const { compareBoards, measureBoard, scoreCases, SCORE_GUARDRAILS, SCORE_METRICS } = await import(
        "../../workbench/src/harness-scores.ts"
      );
      const before = measureBoard(scoreCases(entries.slice(0, baselineIndex)), now);
      const after = measureBoard(scoreCases(entries), now);
      const compared = compareBoards(before, after);
      io.stdout(`Baseline: the board before the refinement activated at sequence ${previous.seq}.`);
      io.stdout(`Verdict: ${compared.verdict}`);
      io.stdout("");
      for (const key of SCORE_GUARDRAILS) {
        const metric = SCORE_METRICS[key];
        const b = before.guardrails[key];
        const a = after.guardrails[key];
        const fmt = (summary: { readonly mean: number | null; readonly n: number } | undefined) =>
          summary && summary.mean !== null
            ? `${summary.mean.toFixed(3)} (n=${summary.n})`
            : "unmeasured";
        // A breach is stored as a sentence naming the metric, so the marker
        // matches the metric it starts with rather than the whole sentence.
        // Comparing against the bare key never matched, and the marker that
        // told an operator which line moved was dead code.
        const moved = compared.guardrailBreaches.some((line) =>
          line.startsWith(`${key} `),
        )
          ? "  REGRESSED"
          : "";
        io.stdout(
          `${key}  ${metric ? metric.label : key}: ${fmt(b)} -> ${fmt(a)}${moved}`,
        );
      }
      if (compared.guardrailBreaches.length) {
        io.stdout("");
        io.stdout(
          "A guardrail regressed outside noise. This is a report, not a refusal: the workbench decides, and it decides on evidence the harness chain carries.",
        );
      }
      return 0;
    }
    if (action === "entries") {
      // The workbench keys entries by workspace and a session id is not one.
      // The web route resolves the workspace before it asks, so the command
      // has to as well; a surface with no sessions is handed the id unchanged.
      let workspace = flags.session;
      if (workbench.get) {
        try {
          workspace = workbench.get(flags.session)?.workspace ?? flags.session;
        } catch {
          workspace = flags.session;
        }
      }
      const entries = await workbench.harnessEntries(workspace);
      if (!entries.length) {
        io.stdout("The harness holds no entry for this workspace.");
        return 0;
      }
      for (const entry of entries) {
        const content =
          entry.content.length > 160
            ? `${entry.content.slice(0, 160)}...`
            : entry.content;
        io.stdout(
          `${entry.id}  ${entry.kind}${entry.decidedByOperator ? "  operator" : ""}${
            entry.tool ? `  ${entry.tool}/${entry.klass}` : ""
          }`,
        );
        io.stdout(`    ${entry.title}`);
        io.stdout(`    ${content}`);
        if (entry.policyText?.length) {
          io.stdout("    policy rule, paste it into your own file:");
          for (const line of entry.policyText) io.stdout(`      ${line}`);
        }
      }
      return 0;
    }
    if (action === "list") {
      const proposals = await workbench.pendingApprovalsFor(flags.session);
      if (!proposals.length) {
        io.stdout("No harness proposal awaits a decision.");
        return 0;
      }
      for (const proposal of proposals) {
        io.stdout(`${proposal.digest}  ${proposal.summary}  ${proposal.at}`);
        for (const edit of proposal.proposal.edits) io.stdout(describeEdit(edit));
        for (const text of [proposal.profileReviewText, proposal.skillReviewText])
          if (text)
            for (const line of text.split("\n")) io.stdout(`    ${line}`);
      }
      return 0;
    }
    if (action === "approve") {
      const applied = await workbench.approveHarnessProposal(
        flags.session,
        await resolveDigest(workbench, flags.session, flags.digest),
      );
      io.stdout(`Applied ${applied.applied.length} edit(s) from ${flags.digest}.`);
      return 0;
    }
    if (action === "reject") {
      const digest = await resolveDigest(
        workbench,
        flags.session,
        flags.digest,
      );
      await workbench.rejectHarnessProposal(flags.session, digest, flags.reason);
      io.stdout(`Rejected ${digest}.`);
      return 0;
    }
    const rolled = await workbench.rollbackHarnessProposal(
      flags.session,
      await resolveDigest(workbench, flags.session, flags.digest),
    );
    io.stdout(`Rolled back ${flags.digest}: ${rolled.applied.length} edit(s) undone.`);
    return 0;
  } catch (error) {
    // The workbench's own sentence, kept whole. A refusal that is reworded
    // here is a refusal the operator cannot match against the surface that
    // produced it.
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
