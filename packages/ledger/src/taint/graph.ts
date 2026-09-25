import type { JsonlEntry } from "../store.ts";

/**
 * Taint graph construction over a verified ledger feed.
 *
 * Every edge carries the label of how it was established, so a reader can tell
 * a proven dependency from a heuristic one. Identical argument text is not proof
 * of causation, which is why the args digest fallback is labelled conservative
 * and never observed.
 */

export type CallDigest = string;

export type TaintNode = {
  readonly digest: CallDigest;
  readonly seq: number;
  readonly tool: string;
  readonly klass: string;
  readonly decision: string;
  readonly at: string;
  readonly revision?: string;
};

export type TaintEdge = {
  readonly from: CallDigest;
  readonly to: CallDigest;
  readonly kind: "resource" | "data";
  readonly via: string;
  readonly bindingType:
    "confirmed-data" | "observed-resource" | "conservative-potential";
};

export type TaintGraph = {
  readonly nodes: Map<CallDigest, TaintNode>;
  readonly edges: readonly TaintEdge[];
};

export const DATA_EDGE_HONESTY_NOTE =
  "Data edges require outputDigest on the producing ledger entry. Entries without outputDigest produce resource edges only.";

export function buildGraph(entries: readonly JsonlEntry[]): TaintGraph {
  const nodes = new Map<CallDigest, TaintNode>();
  const edges: TaintEdge[] = [];
  const edgeKeys = new Set<string>();
  const lastByResource = new Map<string, CallDigest>();
  const producerByOutput = new Map<string, CallDigest>();

  for (const entry of entries) {
    const body = entryBody(entry);
    const digest = requiredString(entry.hash, "entry hash", entry.seq);
    const node: TaintNode = {
      digest,
      seq: entry.seq,
      tool: requiredString(body.tool, "tool", entry.seq),
      klass: requiredString(body.klass, "klass", entry.seq),
      decision: requiredString(body.decision, "decision", entry.seq),
      at: requiredString(body.at, "at", entry.seq),
      revision: stringValue(body.revision),
    };
    nodes.set(digest, node);

    // First pass: check for confirmed data edges (outputDigest → inputDigest)
    for (const inputDigest of inputDigests(body)) {
      const from = producerByOutput.get(inputDigest);
      if (from !== undefined) {
        addEdge(
          edges,
          edgeKeys,
          from,
          digest,
          "data",
          inputDigest,
          "confirmed-data",
        );
      }
    }

    // node.tool rather than body.tool because it is already a validated string,
    // and reusing it keeps a via prefix from disagreeing with the tool the node
    // itself is labelled with.
    for (const binding of resourceBindings(body, node.tool)) {
      const from = lastByResource.get(binding.key);
      if (from !== undefined) {
        addEdge(
          edges,
          edgeKeys,
          from,
          digest,
          "resource",
          binding.key,
          binding.bindingType,
        );
      }
      lastByResource.set(binding.key, digest);
    }

    // Third pass: set producer by outputDigest for future data edge resolution
    const outputDigest = stringValue(body.outputDigest);
    if (outputDigest !== undefined) {
      producerByOutput.set(outputDigest, digest);
    }
  }

  return { nodes, edges };
}

function addEdge(
  edges: TaintEdge[],
  edgeKeys: Set<string>,
  from: CallDigest,
  to: CallDigest,
  kind: TaintEdge["kind"],
  via: string,
  bindingType: TaintEdge["bindingType"],
): void {
  if (from === to) return;
  const key = `${from}\0${to}\0${kind}\0${via}\0${bindingType}`;
  if (edgeKeys.has(key)) return;
  edgeKeys.add(key);
  edges.push({ from, to, kind, via, bindingType });
}

function entryBody(entry: JsonlEntry): Record<string, unknown> {
  if (typeof entry.body !== "object" || entry.body === null) {
    throw new Error(`ledger entry ${entry.seq} has invalid body`);
  }
  return entry.body as Record<string, unknown>;
}

function requiredString(value: unknown, name: string, seq: number): string {
  if (typeof value !== "string" || value === "")
    throw new Error(`ledger entry ${seq} has no ${name}`);
  return value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function sourceArgs(body: Record<string, unknown>): Record<string, unknown> {
  return typeof body.args === "object" && body.args !== null
    ? (body.args as Record<string, unknown>)
    : body;
}

type ResourceBinding = {
  readonly key: string;
  readonly bindingType: "observed-resource" | "conservative-potential";
};

function resourceBindings(
  body: Record<string, unknown>,
  tool: string,
): ResourceBinding[] {
  const args = sourceArgs(body);
  const bindings: ResourceBinding[] = [];
  const observed = (key: string): void => {
    bindings.push({ key, bindingType: "observed-resource" });
  };
  const bucket = firstString(args, ["bucket", "Bucket", "bucketName"]);
  const key = firstString(args, ["key", "Key", "objectKey"]);
  if (bucket !== undefined && key !== undefined)
    observed(`${tool}:bucket=${bucket}:key=${key}`);

  const table = firstString(args, ["table", "tableName", "relation"]);
  const rowDigest = firstString(args, [
    "rowPredicateDigest",
    "predicateDigest",
    "whereDigest",
    "queryDigest",
  ]);
  if (table !== undefined && rowDigest !== undefined)
    observed(`${tool}:table=${table}:predicate=${rowDigest}`);

  const identity = firstString(args, [
    "resourceKey",
    "resourceId",
    "identity",
    "target",
    "id",
  ]);
  if (identity !== undefined) observed(`${tool}:identity=${identity}`);

  if (bindings.length === 0) {
    const argsDigest = stringValue(body.argsDigest);
    // No resource identity is observable here, so the only thing binding these
    // two calls together is that their argument text is identical. That is a
    // potential dependency, not an observed one, and the label says so.
    if (argsDigest !== undefined)
      bindings.push({
        key: `${tool}:argsDigest=${argsDigest}`,
        bindingType: "conservative-potential",
      });
  }

  return bindings;
}

function firstString(
  source: Record<string, unknown>,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    const value = stringValue(source[name]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function inputDigests(body: Record<string, unknown>): string[] {
  const found = new Set<string>();
  collectNamedDigests(body.inputDigest, found);
  collectNamedDigests(body.inputDigests, found);
  collectStrings(sourceArgs(body), found);
  return [...found];
}

function collectNamedDigests(value: unknown, found: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectNamedDigests(item, found);
    return;
  }
  const digest = stringValue(value);
  if (digest !== undefined) found.add(digest);
}

function collectStrings(value: unknown, found: Set<string>): void {
  if (typeof value === "string") {
    if (value !== "") found.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, found);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) collectStrings(item, found);
  }
}
