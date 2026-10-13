import type { EvaluationResult } from "../../../registry/src/index.ts";
import {
  UNCLASSIFIED_CLASS,
  type PolicyCall,
  type PolicyDecision,
} from "../../../policy/src/index.ts";
import {
  holdErrorMessage,
  type HeldCall,
  type HoldResolution,
} from "../../../policy/src/index.ts";

import type { JsonRpcError, JsonRpcResult } from "../rpc.ts";
import type { ProbeProvider, ProbeProviderResult } from "../blast.ts";
import { buildAttribution, type LedgerAttribution } from "../../../ledger/src/attribution.ts";
import { legacyArgsDigest } from "./legacy-binding.ts";

export type { JsonRpcError, JsonRpcResult } from "../rpc.ts";

export type InterceptedCall = {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly connector: string;
  readonly workspace?: string;
};

export type CallVerdict =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly error: JsonRpcError }
  | {
      readonly kind: "hold";
      readonly promise: Promise<JsonRpcResult | JsonRpcError>;
    };

export type LedgerEntryInput = {
  readonly at: string;
  readonly tool: string;
  readonly klass: string;
  readonly decision: string;
  readonly argsDigest: string;
  /**
   * Why this record exists, bound into the entry hash and its signature.
   * Absent only when no policy was consulted, which is a different claim
   * from an attribution that names a policy and no rule.
   */
  readonly attribution?: LedgerAttribution;
};

export type InterceptDeps = {
  /**
   * The caller owns declared facts. When it merges this probe map, declared
   * facts stay authoritative because they are the operator safety contract.
   */
  readonly classify: (
    probeFacts: Readonly<Record<string, string>>,
  ) => EvaluationResult;
  /**
   * The decision seam. The classification is handed over rather than left to
   * the hook, because the hook and the ledger entry must judge the same call:
   * recomputing it here would drop the probe facts and let the agent policy
   * and the signed record disagree about what was classified.
   */
  readonly policy: (
    call: PolicyCall,
    classification?: EvaluationResult,
  ) => PolicyDecision;
  readonly hold: (
    seconds: number,
    signal?: AbortSignal,
  ) => Promise<HoldResolution>;
  /**
   * Aborts the hold when the caller cancels before dispatch. A hold that
   * cannot observe cancellation would park until its timer expires.
   */
  readonly signal?: AbortSignal;
  readonly ledger: (entry: LedgerEntryInput) => void | Promise<void>;
  /**
   * The digest of the policy content this call was decided under. A dep that
   * omits it records no attribution rather than an empty one, so a record
   * never claims a policy nobody can name. It is read per call because the
   * policy is reloaded per request.
   */
  readonly policyDigest?: () => string;
  readonly probe?: ProbeProvider;
  readonly now?: () => Date;
  /**
   * WP-R02 capture gate: a durable snapshot of the call envelope that must
   * complete before the proxy forwards upstream. Rejection blocks dispatch;
   * the upstream is never called. Absent means no binding for this host.
   */
  readonly capture?: (
    call: InterceptedCall,
    argsDigest: string,
  ) => Promise<unknown>;
};

const ERROR_CODE = -32003;

export async function interceptCall(
  call: InterceptedCall,
  deps: InterceptDeps,
): Promise<CallVerdict> {
  const now = deps.now ?? (() => new Date());
  try {
    const digest = await legacyArgsDigest(call.args);
    const baseClassification = deps.classify({});
    const probeResult = await runProbe(
      deps,
      call,
      buildPolicyCall(call, baseClassification, undefined),
    );
    const probeFacts =
      probeResult !== undefined &&
      !("error" in probeResult) &&
      probeResult.facts !== undefined
        ? probeResult.facts
        : {};
    const classification =
      Object.keys(probeFacts).length === 0
        ? baseClassification
        : deps.classify(probeFacts);
    const policyCall = buildPolicyCall(
      call,
      classification,
      chooseBlastRadius(probeResult),
    );
    const decision = deps.policy(policyCall, classification);
    const attribution = decisionAttribution(deps, decision);
    // The decision record lands before the verdict, so a crash after the
    // decision still leaves the ledger saying what was about to happen.
    await writeLedger(
      deps,
      now,
      call.tool,
      policyCall.klass,
      decision.kind,
      digest,
      attribution,
    );

    if (decision.kind === "allow") {
      const captured = await runCaptureGate(
        deps,
        now,
        call,
        policyCall,
        digest,
        "allow",
        attribution,
      );
      if (captured === null) {
        return {
          kind: "deny",
          error: denyError(
            call,
            policyCall,
            -1,
            "snapshot capture failed; upstream was not called",
          ),
        };
      }
      await writeLedger(
        deps,
        now,
        call.tool,
        policyCall.klass,
        "allow:resolved",
        digest,
        attribution,
      );
      return { kind: "allow" };
    }

    if (decision.kind === "deny" || decision.kind === "unmatched") {
      const error =
        decision.kind === "deny"
          ? denyError(call, policyCall, decision.ruleIndex, decision.rationale)
          : denyError(
              call,
              policyCall,
              -1,
              `policy returned ${decision.decision}`,
            );
      await writeLedger(
        deps,
        now,
        call.tool,
        policyCall.klass,
        `${decision.kind}:resolved`,
        digest,
        attribution,
      );
      return { kind: "deny", error };
    }

    const heldCall = toHeldCall(call, policyCall, decision);
    const promise = deps.hold(decision.seconds, deps.signal).then(async (resolution) => {
      if (
        resolution.outcome.kind === "released" &&
        resolution.outcome.release.kind === "approved"
      ) {
        const captured = await runCaptureGate(
          deps,
          now,
          call,
          policyCall,
          digest,
          "hold",
          attribution,
        );
        if (captured === null) {
          return holdError(
            resolution.call,
            {
              kind: "released",
              release: {
                kind: "denied",
                by: "snapshot capture failed; upstream was not called",
              },
            },
            "hold",
          );
        }
        await writeLedger(
          deps,
          now,
          call.tool,
          policyCall.klass,
          "hold:approved",
          digest,
          attribution,
        );
        return {
          jsonrpc: "2.0",
          id: 0,
          result: { approved: true },
        } satisfies JsonRpcResult;
      }
      const result = resolution.outcome.kind === "expired"
        ? "expired"
        : resolution.outcome.kind === "cancelled"
          ? "cancelled"
          : "denied";
      await writeLedger(
        deps,
        now,
        call.tool,
        policyCall.klass,
        `hold:${result}`,
        digest,
        attribution,
      );
      return holdError(resolution.call, resolution.outcome, "hold");
    });
    void heldCall;
    return { kind: "hold", promise };
  } catch {
    const policyCall = {
      tool: call.tool,
      connector: call.connector,
      workspace: call.workspace,
      klass: UNCLASSIFIED_CLASS,
      blastRadius: undefined,
    };
    return {
      kind: "deny",
      error: denyError(
        call,
        policyCall,
        -1,
        "internal dependency failure; operator review required",
      ),
    };
  }
}

function buildPolicyCall(
  call: InterceptedCall,
  classification: EvaluationResult,
  blastRadius: number | undefined,
): PolicyCall {
  const classified = classification.outcome === "classified";
  return {
    tool: call.tool,
    connector: call.connector,
    workspace: call.workspace,
    klass: classified ? classification.tone : UNCLASSIFIED_CLASS,
    blastRadius,
    ...(classified ? {} : { unclassified: true as const }),
  };
}

async function runProbe(
  deps: InterceptDeps,
  call: InterceptedCall,
  policyCall: PolicyCall,
): Promise<ProbeProviderResult | undefined> {
  if (deps.probe === undefined) return undefined;
  try {
    return await deps.probe({ ...policyCall, args: call.args });
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function chooseBlastRadius(
  probeResult: ProbeProviderResult | undefined,
): number | undefined {
  if (
    probeResult !== undefined &&
    !("error" in probeResult) &&
    typeof probeResult.radius === "number" &&
    Number.isSafeInteger(probeResult.radius) &&
    probeResult.radius >= 0
  ) {
    return probeResult.radius;
  }
  // Caller-supplied counts are claims, never measurements that authorize writes.
  return undefined;
}

/**
 * Runs the WP-R02 capture gate. Returns non-null on success, null when the
 * snapshot failed and dispatch must be blocked. Never throws: a throwing
 * capture dependency resolves to a blocked dispatch, and the caller answers
 * deny locally without contacting the upstream.
 */
async function runCaptureGate(
  deps: InterceptDeps,
  now: () => Date,
  call: InterceptedCall,
  policyCall: PolicyCall,
  argsDigest: string,
  decision: string,
  attribution: LedgerAttribution | undefined,
): Promise<unknown> {
  if (deps.capture === undefined) return true;
  try {
    return await deps.capture(call, argsDigest);
  } catch {
    await writeLedger(
      deps,
      now,
      call.tool,
      policyCall.klass,
      `${decision}:capture-failed`,
      argsDigest,
      attribution,
    );
    return null;
  }
}

async function writeLedger(
  deps: InterceptDeps,
  now: () => Date,
  tool: string,
  klass: string,
  decision: string,
  argsDigest: string,
  attribution: LedgerAttribution | undefined,
): Promise<void> {
  await deps.ledger({
    at: now().toISOString(),
    tool,
    klass,
    decision,
    argsDigest,
    // Spread rather than a bare undefined: canonicalJson refuses undefined,
    // and a record that names no policy must simply not carry the field.
    ...(attribution === undefined ? {} : { attribution }),
  });
}

/**
 * The reason bound to this record. One read of the decision and one digest of
 * the policy, computed once per call and written on every record the call
 * produces, so the first record and the resolved one cannot disagree about
 * which policy and rule produced them.
 */
function decisionAttribution(
  deps: InterceptDeps,
  decision: PolicyDecision,
): LedgerAttribution | undefined {
  const digest = deps.policyDigest?.();
  if (digest === undefined) return undefined;
  // An unmatched call names no rule and that is not a rule zero: the policy
  // file it was decided under is still worth binding.
  return buildAttribution(digest, "ruleIndex" in decision ? decision : {});
}

function denyError(
  call: InterceptedCall,
  policyCall: PolicyCall,
  ruleIndex: number,
  rationale: string | undefined,
): JsonRpcError {
  return {
    jsonrpc: "2.0",
    error: {
      code: ERROR_CODE,
      message:
        `The call to ${call.tool} (${policyCall.klass}, blast radius ${policyCall.blastRadius ?? "unknown"}) was denied. ` +
        `Rule ${ruleIndex} denied it${rationale === undefined ? "." : `: ${rationale}.`} ` +
        "Do not retry the same call; NOMO rejected it.",
      data: {
        tool: call.tool,
        class: policyCall.klass,
        blastRadius: policyCall.blastRadius,
        rule: ruleIndex,
        rationale,
        retry: "do-not-retry",
      },
    },
  };
}

function toHeldCall(
  call: InterceptedCall,
  policyCall: PolicyCall,
  decision: Extract<PolicyDecision, { readonly kind: "hold" }>,
): HeldCall {
  const heldAt = Date.now();
  return {
    id: "pending",
    tool: call.tool,
    klass: policyCall.klass,
    blastRadius: policyCall.blastRadius,
    ruleIndex: decision.ruleIndex,
    rationale: decision.rationale,
    args: call.args,
    heldAt,
    expiresAt: heldAt + decision.seconds * 1000,
    notify: decision.notify,
  };
}

function holdError(
  call: HeldCall,
  outcome: HoldResolution["outcome"],
  decision: "hold" | "deny" | "allow",
): JsonRpcError {
  const body = holdErrorMessage(call, outcome, decision);
  return {
    jsonrpc: "2.0",
    error: {
      code: outcome.kind === "cancelled" ? body.code : ERROR_CODE,
      message: body.message.includes("Do not retry")
        ? body.message
        : `${body.message} Do not retry the same call; NOMO rejected it.`,
      data: body.data,
    },
  };
}
