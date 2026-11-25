/** Measurement identity for one governed tool execution inside the offline
 * eval fixture. The record is evidence metadata only: arguments, results,
 * prompts and document content never belong here. */
export const EVAL_TOOL_SCHEMA = "nomo.eval-tool.v1";

export const EVAL_TOOL_EXECUTION = "managed-workspace-fixture";

const IDENTIFIER = /^[A-Za-z0-9_.:\/-]{1,128}$/;
const FIELDS = [
  "schema",
  "caseId",
  "variantId",
  "run",
  "toolName",
  "toolClass",
  "ok",
  "execution",
] as const;

export type EvalToolRecord = {
  readonly schema: typeof EVAL_TOOL_SCHEMA;
  readonly caseId: string;
  readonly variantId: string;
  /** One-based paired-run index inside one evaluated case. */
  readonly run: number;
  readonly toolName: string;
  readonly toolClass: string;
  readonly ok: boolean | "unmeasured";
  readonly execution: typeof EVAL_TOOL_EXECUTION;
};

export type EvalToolInput = Omit<EvalToolRecord, "schema">;

/** Case identity a production eval run binds into every ledger entry it
 * causes. It is metadata only, never prompt or tool content. */
export type EvalCaseAttribution = {
  readonly caseId: string;
  readonly variantId: string;
  readonly run: number;
};

const CASE_FIELDS = ["caseId", "variantId", "run"] as const;

const identifier = (value: unknown): value is string =>
  typeof value === "string" && IDENTIFIER.test(value);


/** Validate eval case identity without copying hostile values into errors. */
export function evalCaseAttribution(input: unknown): EvalCaseAttribution {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new TypeError("eval case attribution: expected an object");
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some((key) => !(CASE_FIELDS as readonly string[]).includes(key)))
    throw new TypeError("eval case attribution: unknown field");
  if (!identifier(body.caseId) || !identifier(body.variantId))
    throw new TypeError("eval case attribution: caseId and variantId must be bounded identifiers");
  if (!Number.isSafeInteger(body.run) || (body.run as number) < 1 || (body.run as number) > 100)
    throw new TypeError("eval case attribution: run must be a whole number from 1 to 100");
  return {
    caseId: body.caseId,
    variantId: body.variantId,
    run: body.run as number,
  };
}

/** Build one validated record. Error messages name fields, never values. */
export function evalToolRecord(input: EvalToolInput): EvalToolRecord {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new TypeError("eval tool record: expected an object");
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some((key) => !(FIELDS as readonly string[]).includes(key)))
    throw new TypeError("eval tool record: unknown field");
  if (!identifier(body.caseId) || !identifier(body.variantId))
    throw new TypeError("eval tool record: caseId and variantId must be bounded identifiers");
  if (!Number.isSafeInteger(body.run) || (body.run as number) < 1 || (body.run as number) > 100)
    throw new TypeError("eval tool record: run must be a whole number from 1 to 100");
  if (!identifier(body.toolName))
    throw new TypeError("eval tool record: toolName must be a bounded identifier");
  if (body.toolClass !== "unmeasured" && !identifier(body.toolClass))
    throw new TypeError("eval tool record: toolClass must be a bounded identifier or unmeasured");
  if (typeof body.ok !== "boolean" && body.ok !== "unmeasured")
    throw new TypeError("eval tool record: ok must be boolean or unmeasured");
  if (body.execution !== EVAL_TOOL_EXECUTION)
    throw new TypeError("eval tool record: unsupported execution");
  return {
    schema: EVAL_TOOL_SCHEMA,
    caseId: body.caseId,
    variantId: body.variantId,
    run: body.run as number,
    toolName: body.toolName,
    toolClass: body.toolClass,
    ok: body.ok,
    execution: EVAL_TOOL_EXECUTION,
  };
}
