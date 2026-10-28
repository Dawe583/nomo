/**
 * R02: the one place a legacy host binding is composed.
 *
 * `forward/legacy-binding.ts` is a tool agnostic evidence contract. It says
 * what a capture, a dispatch and a terminal outcome look like; it does not
 * decide which tool is bound, does not translate an intercepted call into the
 * shape a connector captures, and does not make the capture durable before the
 * upstream is reached. That composition is this module, and it is reachable
 * from the package entry `@nomo/proxy` rather than from a test: a host
 * resolves a name here and hands the resolver to `runProxy({ legacyBinding })`.
 *
 * Binding selection is explicit. A name outside `LEGACY_BINDING_NAMES` throws
 * rather than falling back to a default. A host that believes it bound a
 * connector and silently received envelope only capture would keep recording
 * decisions it can never recover, which is the exact failure this gate exists
 * to make loud at startup instead of quiet at the first tools/call.
 */
import type {
  LegacyBindingResolver,
  LegacyOutcomeEvidence,
  LegacyOutcomeStatus,
  LegacyProxyBinding,
} from "./forward/legacy-binding.ts";
import type { JsonRpcError, JsonRpcResult } from "./rpc.ts";
import type { InterceptedCall } from "./forward/tools.ts";

/**
 * The tools this root can bind, and the reason each one is here.
 *
 * A name earns its place only because a connector in this repository can
 * capture a before image and invert it. `postgres.row.update` and
 * `postgres.row.delete` share the postgres connector, whose capture walks the
 * primary key schema and, for delete, the ON DELETE CASCADE edges. The S3
 * connector captures the object body and its ETag for a delete.
 *
 * `aws.s3.object.put` is deliberately absent: a put overwrites bytes this
 * root has never read, so there is no before image to invert. The same
 * argument removes `aws.s3.bucket.delete` and the policy writes. Adding a
 * name here without a connector behind it would advertise a recovery that
 * cannot run.
 */
export const LEGACY_BINDING_NAMES = [
  "postgres.row.update",
  "postgres.row.delete",
  "aws.s3.object.delete",
] as const;

export type LegacyBindingName = (typeof LEGACY_BINDING_NAMES)[number];

export class UnknownLegacyBindingError extends Error {
  readonly requested: string;
  readonly supported: readonly LegacyBindingName[];

  constructor(requested: string) {
    super(`unknown legacy binding: ${requested}`);
    this.name = "UnknownLegacyBindingError";
    this.requested = requested;
    this.supported = LEGACY_BINDING_NAMES;
  }
}

/**
 * A content addressed snapshot reference. The digest is narrowed to the
 * `sha256:` form here rather than inherited from the evidence contract, which
 * types it as a plain string because it only ever pattern matches it. A host
 * handing this root a reference has to satisfy a store that will digest
 * verify those bytes, so the prefix is part of the contract, not a detail.
 */
export type LegacyBindingReference = {
  readonly namespace: string;
  readonly digest: `sha256:${string}`;
  readonly uri: string;
};

/** The snapshot shape a connector capture must return to be bindable here. */
export type LegacyBindingSnapshot = {
  readonly digest: `sha256:${string}`;
  readonly reference: LegacyBindingReference;
  readonly capturedAt: string;
};

/**
 * The translated call a connector receives. `InterceptedCall.args` becomes
 * `arguments` here, once, so a connector never has to know about the proxy's
 * interception shape and the proxy never has to know about the connector's.
 */
export type LegacyBoundCall = {
  readonly tool: string;
  readonly connector: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly workspace: string | undefined;
};

/**
 * The durable capture index recovery reads back after a restart. The digest
 * is the snapshot digest, not the argument digest: a manifest entry that
 * named anything else would send recovery to a reference it cannot read.
 */
export type LegacyBindingManifestEntry = {
  readonly tool: string;
  readonly reference: LegacyBindingReference;
  readonly digest: `sha256:${string}`;
};

export type LegacyBindingLedgerBody = {
  readonly workspace: string;
  readonly at: string;
  readonly tool: string;
  readonly schema: string;
  readonly decision: string;
  readonly argsDigest: string;
  readonly captureDigest: string;
};

export type LegacyRootDeps = {
  /** Durable before image for the bound tool. */
  readonly capture: (call: LegacyBoundCall) => Promise<LegacyBindingSnapshot>;
  /** Append only index of captures, read back by recovery. */
  readonly manifest: {
    readonly write: (entry: LegacyBindingManifestEntry) => Promise<void>;
  };
  /** Append only signed ledger. */
  readonly ledger: {
    readonly append: (body: LegacyBindingLedgerBody) => Promise<unknown>;
  };
  /** The workspace every record of this binding belongs to. */
  readonly workspace: string;
  /**
   * The provider's own convention for a mutation that took effect. A result
   * that fails this check records `unknown` and never `completed`: without
   * proof of the effect there is nothing safe to offer recovery.
   */
  readonly completed: (result: unknown) => boolean;
  readonly now?: () => Date;
};

/**
 * Composes the binding for one named tool. This is the only exported way to
 * obtain a resolver, so the production path and a conformance fixture cannot
 * drift into two mechanisms.
 */
export function legacyBindingRoot(
  name: string,
  deps: LegacyRootDeps,
): LegacyBindingResolver {
  const tool = requireBindingName(name);
  const now = deps.now ?? ((): Date => new Date());
  const binding: LegacyProxyBinding = {
    tool,
    async capture(call, argsDigest) {
      // The proxy stamps the call with the workspace it was started for. If
      // that disagrees with the workspace this root records into, the capture
      // lands in one namespace and the ledger in another, and recovery would
      // read a snapshot the signed record never names.
      if (call.workspace !== deps.workspace) {
        throw new Error(
          `legacy binding workspace mismatch: the call declares ${JSON.stringify(call.workspace)}, this binding records into ${JSON.stringify(deps.workspace)}`,
        );
      }
      const snapshot = await deps.capture({
        tool: call.tool,
        connector: call.connector,
        arguments: call.args,
        workspace: call.workspace,
      });
      // Durable before the upstream is reachable. A manifest write that fails
      // rejects the capture, the interceptor denies, and the upstream is never
      // called with a write nobody can invert.
      await deps.manifest.write({
        tool: call.tool,
        digest: snapshot.digest,
        reference: snapshot.reference,
      });
      return {
        schema: "void.legacy.capture.v1",
        at: snapshot.capturedAt,
        tool: call.tool,
        workspace: call.workspace,
        argsDigest,
        captureDigest: snapshot.digest,
        reference: snapshot.reference,
      };
    },
    async dispatched(evidence) {
      await deps.ledger.append({
        workspace: deps.workspace,
        at: now().toISOString(),
        tool: evidence.tool,
        schema: evidence.schema,
        decision: "execute:dispatched",
        argsDigest: evidence.argsDigest,
        captureDigest: evidence.captureDigest,
      });
    },
    async outcome(evidence, response) {
      const outcome: LegacyOutcomeEvidence = {
        schema: "void.legacy.outcome.v1",
        at: now().toISOString(),
        status: terminalStatus(response, deps.completed),
        tool: evidence.tool,
        workspace: evidence.workspace,
        argsDigest: evidence.argsDigest,
        captureDigest: evidence.captureDigest,
      };
      await deps.ledger.append({
        workspace: deps.workspace,
        ...outcome,
        decision: `execute:${outcome.status}`,
      });
      return outcome;
    },
  };
  return (call) => (call.tool === tool ? binding : null);
}

/**
 * No response, or a result that does not prove the effect, is `unknown`. Only
 * a JSON-RPC error is `failed`. Recovery requires `completed`, so an
 * unproven result must never be promoted into one.
 */
function terminalStatus(
  response: JsonRpcResult | JsonRpcError | null,
  completed: (result: unknown) => boolean,
): LegacyOutcomeStatus {
  if (response === null) return "unknown";
  if ("error" in response) return "failed";
  return completed(response.result) ? "completed" : "unknown";
}

function requireBindingName(name: string): LegacyBindingName {
  if (!(LEGACY_BINDING_NAMES as readonly string[]).includes(name)) {
    throw new UnknownLegacyBindingError(name);
  }
  return name as LegacyBindingName;
}
