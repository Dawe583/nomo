import type { ConnectorId, ConnectorRegistry } from "../../connectors/src/registry.ts";
import { manifestWriter } from "../../connectors/src/manifest.ts";
import type { LegacyBindingResolver } from "../../proxy/src/forward/legacy-binding.ts";
import {
  LEGACY_BINDING_NAMES,
  legacyBindingRoot,
  type LegacyBindingLedgerBody,
} from "../../proxy/src/legacy-root.ts";

export type ConnectorLegacyBindingOptions = {
  readonly connectors: ConnectorRegistry;
  readonly snapshotDir: string;
  readonly ledger: {
    readonly append: (body: LegacyBindingLedgerBody) => Promise<unknown>;
  };
  readonly workspace: string;
  readonly completed?: (result: unknown) => boolean;
  readonly now?: () => Date;
};

export function connectorLegacyBinding(
  options: ConnectorLegacyBindingOptions,
): LegacyBindingResolver {
  const manifest = manifestWriter(options.snapshotDir);
  const resolvers = LEGACY_BINDING_NAMES.map((tool) => {
    const connectorId = connectorForLegacyTool(tool);
    const connector = options.connectors[connectorId];
    return legacyBindingRoot(tool, {
      async capture(bound) {
        const captured = await connector.capture({
          tool: bound.tool,
          connector: connectorId,
          arguments: bound.arguments,
          workspace: bound.workspace,
        });
        return {
          digest: captured.digest,
          reference: captured.reference,
          capturedAt: captured.capturedAt,
        };
      },
      manifest,
      ledger: options.ledger,
      workspace: options.workspace,
      completed: options.completed ?? appliedResult,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  });
  return (call) => {
    for (const resolver of resolvers) {
      const binding = resolver(call);
      if (binding !== null) return binding;
    }
    return null;
  };
}

function connectorForLegacyTool(tool: string): ConnectorId {
  return tool.startsWith("aws.s3.") ? "s3" : "postgres";
}

function appliedResult(result: unknown): boolean {
  return typeof result === "object" &&
    result !== null &&
    !Array.isArray(result) &&
    (result as { readonly applied?: unknown }).applied === true;
}
