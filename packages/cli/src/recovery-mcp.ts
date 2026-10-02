import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { isAbsolute } from "node:path";
import { readFileSync } from "node:fs";

import type {
  RecoveryJobPlan,
  RecoveryJobRequest,
  RecoveryJobResult,
  RecoveryPlan,
  RecoveryRuntime,
  Json,
} from "../../runtime/src/index.ts";

/**
 * The version this server reports in its `initialize` response.
 *
 * Read from the manifest rather than written here, because a literal in this
 * file is a version nobody has to bump and no gate reads. It answers exactly
 * what `bin/void.mjs --version` answers, from the same manifest and for the
 * same reason. `dispatch.packageVersion()` is the reader the commands use;
 * importing the dispatcher here would make this module carry the whole command
 * surface, and its SQLite graph, to answer one field.
 */
function productVersion(): string {
  const meta = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  if (!meta || typeof meta.version !== "string" || !meta.version) {
    throw Error("Package version is missing.");
  }
  return meta.version;
}

type Runtime = Pick<
  RecoveryRuntime,
  | "execute"
  | "planRecovery"
  | "recover"
  | "reconcile"
  | "reconcileRecovery"
  | "planRecoveryJob"
  | "recoveryJobStatus"
  | "runRecoveryJob"
>;
export type RecoveryErrorCategory =
  | "invalid_path"
  | "missing_artifact"
  | "policy_denied"
  | "key_unavailable"
  | "unsupported_recovery"
  | "unknown";
type RecoveryErrorPayload = { category: RecoveryErrorCategory; message: string };
const safeErrorMessages: Record<RecoveryErrorCategory, string> = {
  invalid_path: "Use a workspace-relative path without traversal or protected segments.",
  missing_artifact: "Required recovery evidence is unavailable. Restore the retained state before retrying.",
  policy_denied: "Operator policy does not allow this recovery request.",
  key_unavailable: "The retained recovery key is unavailable. Restore the original key before retrying.",
  unsupported_recovery: "This operation does not have a supported recovery path.",
  unknown: "Recovery request refused or unavailable. Check operator policy, argument schema, workspace, and signed operation evidence.",
};
class RecoveryMcpError extends Error {
  readonly category: RecoveryErrorCategory;
  constructor(category: RecoveryErrorCategory) {
    super(safeErrorMessages[category]);
    this.category = category;
  }
}
const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  )
    return error.message;
  return "";
};
const classifyError = (error: unknown): RecoveryErrorCategory => {
  if (error instanceof RecoveryMcpError) return error.category;
  const message = errorMessage(error).toLowerCase();
  if (
    /invalid workspace path|protected or invalid workspace path|unsafe workspace parent|invalid file path|invalid git path|absolute path|path traversal|relative path/.test(
      message,
    )
  )
    return "invalid_path";
  if (
    message.includes("not authorized") ||
    message.includes("policy does not allow") ||
    message.includes("operator policy")
  )
    return "policy_denied";
  if (
    /key unavailable|key is unavailable|key.*required|invalid or unavailable recovery reference|incorrect for retained vault|encryption key/.test(
      message,
    )
  )
    return "key_unavailable";
  if (
    /no verified recovery capability|not ready for recovery|only a confirmed successful operation|recovery adapter version is unavailable|unsupported recovery|no uncertain recovery exists/.test(
      message,
    )
  )
    return "unsupported_recovery";
  if (
    (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") ||
    /required operation evidence is missing|operation evidence is missing|artifact.*(missing|unavailable)|recovery artifact|operation not found|recovery job not found|invalid recovery reference/.test(
      message,
    )
  )
    return "missing_artifact";
  return "unknown";
};
const errorResult = (category: RecoveryErrorCategory) => ({
  isError: true,
  content: [
    {
      type: "text" as const,
      text: JSON.stringify({ category, message: safeErrorMessages[category] } satisfies RecoveryErrorPayload),
    },
  ],
});
const workspaceRelativePath = {
  type: "string",
  minLength: 1,
  maxLength: 1024,
  description: "Workspace-relative path to one regular file; absolute paths, traversal, symlinks, and protected segments are refused.",
};
const boundedBase64 = {
  type: "string",
  maxLength: Math.ceil((1024 * 1024) / 3) * 4,
  description: "Canonical base64, maximum 1 MiB decoded.",
};
const validateWorkspacePath = (value: unknown): void => {
  if (typeof value !== "string" || !value || value.length > 1024 || isAbsolute(value) || value.includes("\\") || value.includes("\0"))
    throw new RecoveryMcpError("invalid_path");
  const parts = value.split("/");
  if (
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        /[<>:"|?*\x00-\x1f]/.test(part) ||
        /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part) ||
        /^(\.git|\.ssh|\.aws|\.env.*|\.void.*)$/i.test(part),
    )
  )
    throw new RecoveryMcpError("invalid_path");
};
const validateFilesystemMutation = (mutation: unknown): void => {
  if (!mutation || typeof mutation !== "object" || Array.isArray(mutation))
    throw new RecoveryMcpError("unknown");
  if (!("path" in mutation) || typeof mutation.path !== "string")
    throw new RecoveryMcpError("invalid_path");
  validateWorkspacePath(mutation.path);
  if ("action" in mutation && mutation.action === "rename" && "to" in mutation) {
    if (typeof mutation.to !== "string")
      throw new RecoveryMcpError("invalid_path");
    validateWorkspacePath(mutation.to);
  }
};
const identityPattern = "^[\\w-]{1,120}$";
const identityShape = (label: string) => ({ type: "string", pattern: identityPattern, description: label });
const isIdentity = (value: unknown): value is string => typeof value === "string" && new RegExp(identityPattern).test(value);
const validJobSelection = (selection: RecoveryJobRequest["selection"]): boolean => {
  if (!selection || typeof selection !== "object" || Array.isArray(selection)) return false;
  if (selection.kind === "run") return isIdentity(selection.runId);
  if (selection.kind !== "operations") return false;
  const ids = selection.operationIds;
  if (!Array.isArray(ids) || ids.length === 0 || new Set(ids).size !== ids.length) return false;
  return ids.every(isIdentity);
};
const identity = { type: "string", pattern: "^[\\w-]{1,120}$" };
const operation = { operationId: identity };
const names = [
  "void_execute",
  "void_recovery_plan",
  "void_recovery_apply",
  "void_recovery_plan_job",
  "void_recovery_status_job",
  "void_recovery_apply_job",
  "void_reconcile",
  "void_recovery_reconcile",
] as const;
export type RecoveryTool = (typeof names)[number];
const tool = (
  name: RecoveryTool,
  description: string,
  properties: Record<string, object>,
  required: string[],
  readOnlyHint: boolean,
): Tool => ({
  name,
  description,
  inputSchema: {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint,
    destructiveHint: !readOnlyHint,
    idempotentHint: true,
    openWorldHint: true,
  },
});
const tools: Tool[] = [
  tool(
    "void_recovery_reconcile",
    "Read durable evidence after an unknown Undo outcome. Never repeats the inverse; may update the local journal.",
    operation,
    ["operationId"],
    false,
  ),
  tool(
    "void_execute",
    "Execute one configured PostgreSQL row mutation with durable capture. Reuse operationId and runId only for the identical request. Unknown results must be reconciled, never resubmitted under another ID.",
    {
      ...operation,
      runId: identity,
      mutation: {
        type: "object",
        additionalProperties: false,
        required: ["table", "action", "key"],
        properties: {
          table: { type: "string", description: "Configured schema.table" },
          action: { type: "string", enum: ["insert", "update", "delete"] },
          key: { type: "object", description: "Exact primary key" },
          values: {
            type: "object",
            description: "Configured writable columns; omit for delete",
          },
        },
      },
    },
    ["operationId", "runId", "mutation"],
    false,
  ),
  tool(
    "void_recovery_plan",
    "Preview the exact scope and digest for restoring one confirmed operation. This does not execute recovery.",
    operation,
    ["operationId"],
    true,
  ),
  tool(
    "void_recovery_apply",
    "Apply the reviewed recovery plan if operator policy permits it. Concurrent human changes produce a conflict. A plan digest is not permission.",
    {
      plan: {
        type: "object",
        additionalProperties: false,
        required: [
          "workspace",
          "operationId",
          "digest",
          "scope",
          "resources",
          "reversibility",
        ],
        properties: {
          workspace: { type: "string" },
          operationId: identity,
          digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
          scope: { type: "string" },
          resources: { type: "array", items: { type: "string" } },
          reversibility: { type: "string", enum: ["r0", "r1", "r2"] },
        },
      },
    },
    ["plan"],
    false,
  ),
  tool(
    "void_reconcile",
    "Look up durable execution evidence after an unknown outcome. Does not repeat the original mutation; may update the local journal.",
    operation,
    ["operationId"],
    false,
  ),
  tool(
    "void_recovery_plan_job",
    "Plan one retained recovery job for an exact run or explicit operation list. Load or create by stable job ID; validates the signed stored plan rather than trusting caller plan bytes.",
    { jobId: identityShape("Stable job ID reused across retries"), selection: { type: "object", description: "One exact run or explicit operation ID list" } },
    ["jobId", "selection"],
    true,
  ),
  tool(
    "void_recovery_status_job",
    "Return the stored retained job plan or its terminal restored/partial/conflict/unknown/paused result by stable job ID.",
    { jobId: identityShape("Stable job ID") },
    ["jobId"],
    true,
  ),
  tool(
    "void_recovery_apply_job",
    "Apply one already-planned retained job after operator policy checks the stored plan digest. The job ID alone is not permission.",
    { jobId: identityShape("Stable job ID"), planDigest: { type: "string", pattern: "^[a-f0-9]{64}$", description: "Digest of the stored plan" } },
    ["jobId", "planDigest"],
    false,
  ),
];
export function recoveryMcpServer(options: {
  runtime: Runtime;
  workspace: string;
  agentId: string;
  adapterId: string;
  permitted: (tool: RecoveryTool) => Promise<boolean>;
}) {
  const server = new Server(
    { name: "void-recovery", version: productVersion() },
    { capabilities: { tools: {} } },
  );
  const definitions =
    options.adapterId === "filesystem.managed"
      ? tools.map((definition) =>
          definition.name !== "void_execute"
            ? definition
            : {
                ...definition,
                description:
                  "Execute one cooperative workspace-relative file mutation with durable capture. Supported actions are write, delete, and (on POSIX) rename. Each target is a regular file, each write is bounded to 1 MiB decoded, and bytes and mode only are covered. No shell guarantee. Rename refuses a destination observed before dispatch, but no operation is safe from excluded concurrent external writers. Reconcile unknown outcomes without redispatch.",
                inputSchema: {
                  ...definition.inputSchema,
                  properties: {
                    ...definition.inputSchema.properties,
                    mutation: {
                      oneOf: [
                        {
                          type: "object",
                          additionalProperties: false,
                          required: ["action", "path", "base64"],
                          properties: {
                            action: { type: "string", enum: ["write"] },
                            path: workspaceRelativePath,
                            base64: boundedBase64,
                            mode: {
                              type: "integer",
                              minimum: 0,
                              maximum: 511,
                            },
                          },
                        },
                        {
                          type: "object",
                          additionalProperties: false,
                          required: ["action", "path"],
                          properties: {
                            action: { type: "string", enum: ["delete"] },
                            path: workspaceRelativePath,
                          },
                        },
                        ...(process.platform === "win32"
                          ? []
                          : [
                              {
                                type: "object",
                                additionalProperties: false,
                                required: ["action", "path", "to"],
                                properties: {
                                  action: {
                                    type: "string",
                                    enum: ["rename"],
                                  },
                                  path: {
                                    ...workspaceRelativePath,
                                    description: "Existing workspace-relative source path",
                                  },
                                  to: {
                                    ...workspaceRelativePath,
                                    description:
                                      "Absent workspace-relative destination path in the same cooperative workspace",
                                  },
                                },
                              },
                            ]),
                      ],
                    },
                  },
                },
              },
        )
      : options.adapterId === "git.managed"
        ? tools.map((definition) =>
            definition.name !== "void_execute"
              ? definition
              : {
                  ...definition,
                  description:
                    "Execute one structured Git worktree or index mutation in a declared cooperative POSIX repository. No commits, remotes, hooks, shell, arbitrary Git commands or safety against excluded concurrent writers. Stage leaves a content-addressed dangling blob that can retain selected bytes until Git garbage collection. Unknown outcomes remain unknown without an operation-specific durable receipt.",
                  inputSchema: {
                    ...definition.inputSchema,
                    properties: {
                      ...definition.inputSchema.properties,
                      mutation: {
                        oneOf: [
                          {
                            type: "object",
                            additionalProperties: false,
                            required: ["action", "path", "base64"],
                            properties: {
                              action: { type: "string", enum: ["write"] },
                              path: { type: "string" },
                              base64: { type: "string", description: "Canonical base64, maximum 1 MiB decoded" },
                              mode: { type: "integer", minimum: 0, maximum: 511 },
                            },
                          },
                          ...["delete", "stage", "unstage"].map((action) => ({
                            type: "object",
                            additionalProperties: false,
                            required: ["action", "path"],
                            properties: { action: { type: "string", enum: [action] }, path: { type: "string" } },
                          })),
                          {
                            type: "object",
                            additionalProperties: false,
                            required: ["action", "path", "to"],
                            properties: {
                              action: { type: "string", enum: ["rename"] },
                              path: { type: "string", description: "Existing source path" },
                              to: { type: "string", description: "Absent destination path" },
                            },
                          },
                        ],
                      },
                    },
                  },
                },
          )
        : tools;
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: definitions,
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const name = request.params.name as RecoveryTool;
      if (!names.includes(name)) throw new Error("Unknown recovery tool.");
      const args = request.params.arguments ?? {};
      const definition = tools.find((t) => t.name === name)!;
      if (
        Object.keys(args).some(
          (k) => !(k in definition.inputSchema.properties!),
        )
      )
        throw new Error("Unexpected argument.");
      for (const key of definition.inputSchema.required ?? [])
        if (!(key in args)) throw new Error("Missing argument.");
      for (const key of ["operationId", "runId", "jobId"])
        if (key in args && !isIdentity(args[key])) throw new Error("Invalid identity.");
      if ("selection" in args && !validJobSelection(args.selection as RecoveryJobRequest["selection"])) throw new Error("Invalid recovery job selection.");
      if ("planDigest" in args && (typeof args.planDigest !== "string" || !/^[a-f0-9]{64}$/.test(args.planDigest))) throw new Error("Invalid plan digest.");
      if (!(await options.permitted(name)))
        throw new RecoveryMcpError("policy_denied");
      let result: unknown;
      if (name === "void_execute") {
        if (
          !args.mutation ||
          typeof args.mutation !== "object" ||
          Array.isArray(args.mutation)
        )
          throw new Error("Mutation must be an object.");
        if (options.adapterId === "filesystem.managed")
          validateFilesystemMutation(args.mutation);
        result = await options.runtime.execute({
          workspace: options.workspace,
          agentId: options.agentId,
          adapterId: options.adapterId,
          operationId: args.operationId as string,
          runId: args.runId as string,
          arguments: args.mutation as Json,
        });
      } else if (name === "void_recovery_plan")
        result = await options.runtime.planRecovery(
          options.workspace,
          args.operationId as string,
        );
      else if (name === "void_recovery_reconcile")
        result = await options.runtime.reconcileRecovery(
          options.workspace,
          args.operationId as string,
        );
      else if (name === "void_reconcile")
        result = await options.runtime.reconcile(
          options.workspace,
          args.operationId as string,
        );
      else if (name === "void_recovery_plan_job") {
        const request = { workspace: options.workspace, jobId: args.jobId, selection: args.selection } as RecoveryJobRequest;
        if (request.workspace !== options.workspace) throw new Error("Recovery job belongs to another workspace.");
        result = await options.runtime.planRecoveryJob(request);
      } else if (name === "void_recovery_status_job") {
        result = await options.runtime.recoveryJobStatus(options.workspace, args.jobId as string);
      } else if (name === "void_recovery_apply_job") {
        if (!(await options.permitted(name)))
          throw new RecoveryMcpError("policy_denied");
        const stored = await options.runtime.recoveryJobStatus(options.workspace, args.jobId as string);
        if (!("digest" in stored)) {
          result = stored;
        } else {
          if (stored.digest !== args.planDigest) throw new Error("Recovery job digest changed; re-plan the job.");
          result = await options.runtime.runRecoveryJob(options.workspace, args.jobId as string, async (storedPlan: RecoveryJobPlan) => {
            if (storedPlan.digest !== args.planDigest) throw new Error("Recovery job digest changed; re-plan the job.");
            return true;
          });
        }
      } else {
        const plan = args.plan as RecoveryPlan | undefined;
        if (!plan || plan.workspace !== options.workspace)
          throw new Error("Recovery plan belongs to another workspace.");
        result = await options.runtime.recover(plan, async () =>
          options.permitted(name),
        );
      }
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      // Runtime errors can contain credentials, paths, prompts, or row values.
      // Classify them without forwarding any of those details to MCP callers.
      return errorResult(classifyError(error));
    }
  });
  return server;
}
