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
 */
export function orderRecoverySteps(facts: readonly ProvenanceFact[]): StepOrderVerdict {
  const writers = new Map<string, string[]>();
  for (const fact of facts) {
    for (const resource of fact.resources) {
      const owners = writers.get(resource) ?? [];
      owners.push(fact.operationId);
      writers.set(resource, owners);
    }
  }
  const independent: string[] = [];
  let edges = 0;
  for (const fact of facts) {
    if (fact.reads === undefined) {
      independent.push(fact.operationId);
      continue;
    }
    for (const read of fact.reads) {
      for (const producer of writers.get(read.resource) ?? []) {
        if (producer === fact.operationId) continue;
        const producerFact = facts.find((candidate) => candidate.operationId === producer);
        if (producerFact === undefined) continue;
        if (producerFact.sequence === fact.sequence) {
          return {
            safe: false,
            reason: `${fact.operationId} and ${producer} share a journal sequence and read each other's writes`,
          };
        }
        if (producerFact.sequence > fact.sequence) {
          return {
            safe: false,
            reason: `${fact.operationId} read ${read.resource} from ${producer}, which is later in the journal and would be restored first`,
          };
        }
        edges += 1;
      }
    }
  }
  return { safe: true, independent, edges };
}
