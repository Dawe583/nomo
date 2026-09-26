/**
 * R07: what a recovery step actually depended on.
 *
 * A plan is undone in reverse journal sequence, and that is only safe because
 * every producer of a resource a step read is itself undone after that step.
 * Reverse sequence alone does not prove it: for a selected subset, or when a
 * step read a resource an earlier step wrote, the order can be wrong, and
 * undoing a producer first would restore a value the consumer is about to be
 * rebuilt against.
 *
 * So the ordering is not assumed. The read and write sets come from the durable
 * capture, the planner checks reverse sequence against them, and a plan whose
 * order cannot be proven is refused rather than run.
 *
 * An absent read set is not an empty one. An adapter that reports no reads has
 * proven nothing, so it contributes no edges and no claim either way.
 */

import type { Json, Observation } from "../../../connectors/src/recovery.ts";

export type ProvenanceRead = { readonly resource: string; readonly revision: Json };

export type ProvenanceFact = {
  readonly operationId: string;
  readonly sequence: number;
  /** What this step wrote. */
  readonly resources: readonly string[];
  /** What this step consulted, with the revision it saw. Undefined is unknown. */
  readonly reads: readonly ProvenanceRead[] | undefined;
};

export type StepOrderVerdict =
  | { readonly safe: true; readonly independent: readonly string[]; readonly edges: number }
  | { readonly safe: false; readonly reason: string };

/** One proven claim: this step read that resource, and that step wrote it. */
export type ProvenanceEdge = {
  readonly consumer: string;
  readonly producer: string;
  readonly resource: string;
};


/** The read set an adapter recorded, or undefined when it recorded none. */
export function readsOf(observation: Observation): ProvenanceFact["reads"] {
  return observation.reads;
}

export function provenanceOf(
  operationId: string,
  sequence: number,
  observation: Observation,
): ProvenanceFact {
  return {
    operationId,
    sequence,
    resources: [...observation.resources],
    reads: readsOf(observation),
  };
}

/**
 * Prove, or refuse, that undoing in reverse sequence is safe for this set of
 * steps. A dependency edge exists when a step read a resource another step in
 * the set wrote; the consumer has to be undone first, which in reverse
 * sequence means its own sequence must be the higher one.
 *
 * A pair that reads and writes each other's resources is a cycle: no order is
 * safe, and the plan is refused rather than resolved by a guess.
 *
 * The facts must be the steps of one plan, and nothing else. A caller that
 * records a fact before it knows the operation is a step hands this function a
 * claim about an operation the plan never undoes: an unreadable capture
 * becomes a residual, and its blank fact would still be counted as
 * independent here. Nothing consumed that list at the time and the proof
 * itself stayed correct, which is exactly why it is easy to get wrong. Push
 * the fact once the operation really is a step.
 */
export function orderRecoverySteps(facts: readonly ProvenanceFact[]): StepOrderVerdict {
  const byId = new Map(facts.map((fact) => [fact.operationId, fact]));
  const independent: string[] = [];
  for (const fact of facts) if (fact.reads === undefined) independent.push(fact.operationId);
  const edges = provenanceEdges(facts);
  for (const edge of edges) {
    const consumer = byId.get(edge.consumer)!;
    const producer = byId.get(edge.producer)!;
    if (consumer.sequence === producer.sequence)
      return {
        safe: false,
        reason: `${edge.consumer} and ${edge.producer} share a journal sequence and read each other's writes`,
      };
    if (producer.sequence > consumer.sequence)
      return {
        safe: false,
        reason: `${edge.consumer} read ${edge.resource} from ${edge.producer}, which is later in the journal and would be restored first`,
      };
  }
  return { safe: true, independent, edges: edges.length };
}

/**
 * The graph the planner and the selectors share, so neither can hold a second
 * opinion about which step depends on which. One edge per consumer, producer
 * and resource: a read recorded twice is one claim, not two.
 */
export function provenanceEdges(
  facts: readonly ProvenanceFact[],
): readonly ProvenanceEdge[] {
  const writers = new Map<string, string[]>();
  for (const fact of facts)
    for (const resource of fact.resources) {
      const owners = writers.get(resource) ?? [];
      if (!owners.includes(fact.operationId)) owners.push(fact.operationId);
      writers.set(resource, owners);
    }
  const edges: ProvenanceEdge[] = [];
  const seen = new Set<string>();
  for (const fact of facts) {
    if (fact.reads === undefined) continue;
    for (const read of fact.reads)
      for (const producer of writers.get(read.resource) ?? []) {
        if (producer === fact.operationId) continue;
        const key = `${fact.operationId}\u0000${producer}\u0000${read.resource}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          consumer: fact.operationId,
          producer,
          resource: read.resource,
        });
      }
  }
  return edges;
}
