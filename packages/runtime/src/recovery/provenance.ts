/**
 * R07: what a recovery step actually depended on.
 *
 * A plan is undone in reverse journal sequence, and that is safe because every
 * producer of a resource a step read is itself undone after that step. The read
 * and write sets come from the durable capture, so the order is proved against
 * what the adapter observed rather than assumed.
 *
 * A read names one state of one resource, so exactly one step can have produced
 * it: the last step that wrote that resource before the reader ran. That is the
 * closure this file computes, and it is why the older rule, a read matches
 * every step that wrote the same resource, was wrong twice over. It named a
 * producer the reader cannot have read from, and it read a step's own
 * before-image as though it were a read of somebody else's work. Two ordinary
 * writes to one file, which is what a retry or a reformat looks like, were
 * refused with a claim that was true of neither of them.
 *
 * An absent read set is not an empty one. An adapter that reports no reads has
 * proven nothing, so it contributes no edges and no claim either way.
 */

import { canonicalJson } from "../../../ledger/src/canonical.ts";
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

/** One step's claim on one resource: it wrote the resource, and it recorded the
 * revision it started from when it recorded anything at all. */
type Claim = {
  readonly operationId: string;
  readonly sequence: number;
  readonly revision: Json | null;
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
 * Every step that wrote each resource, oldest journal position first, with the
 * revision it recorded for that resource before its own write. A step that
 * recorded no read of the resource it wrote has no claim to compare: it is
 * carried, so the closure can still name it, and its revision stays null.
 */
function timelines(
  facts: readonly ProvenanceFact[],
): Map<string, Claim[]> {
  const timelines = new Map<string, Claim[]>();
  for (const fact of facts)
    for (const resource of fact.resources) {
      const claims = timelines.get(resource) ?? [];
      if (!claims.some((claim) => claim.operationId === fact.operationId))
        claims.push({
          operationId: fact.operationId,
          sequence: fact.sequence,
          revision:
            fact.reads?.find((read) => read.resource === resource)?.revision ?? null,
        });
      timelines.set(resource, claims);
    }
  for (const claims of timelines.values())
    claims.sort((left, right) => left.sequence - right.sequence);
  return timelines;
}

/**
 * Prove, or refuse, that undoing in reverse sequence is safe for this set of
 * steps. A dependency edge exists when a step read a resource another step in
 * the set wrote; the consumer has to be undone first, which in reverse
 * sequence means its own sequence must be the higher one.
 *
 * The closure decides which writers a read can name. A read of something the
 * step did not write is a consultation, so a writer that comes later in the
 * journal is refused rather than guessed at: the plan restores the writer
 * first, and the consumer is rebuilt against a value the undo just replaced.
 * A read of something the step did write is its own before-image, which only
 * an earlier writer produced, and that order is reverse sequence already.
 *
 * What the closure cannot see is a step claiming a revision it never had. Two
 * steps that each wrote one resource and each recorded the same revision for
 * it cannot both be true: the later one started from a state the earlier
 * one's write had already moved past. The plan is refused and both steps are
 * named. An adapter that cannot version what it writes records no revision
 * and makes no such claim, and its steps are reported as unproven rather than
 * as ordered.
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
  const independent: string[] = [];
  for (const fact of facts) if (fact.reads === undefined) independent.push(fact.operationId);
  const byId = new Map(facts.map((fact) => [fact.operationId, fact.sequence]));
  const timelinesByResource = timelines(facts);
  for (const [resource, claims] of timelinesByResource) {
    const versions = new Map<string, Claim>();
    for (const claim of claims) {
      if (claim.revision === null) continue;
      const encoded = canonicalJson(claim.revision);
      const earlier = versions.get(encoded);
      if (earlier)
        return {
          safe: false,
          reason: `${claim.operationId} recorded ${resource} at the revision ${earlier.operationId} had already written past, so one of them claims a state it cannot have read`,
        };
      versions.set(encoded, claim);
    }
  }
  const edges = edgesFrom(facts, timelinesByResource);
  for (const edge of edges) {
    const consumer = byId.get(edge.consumer)!;
    const producer = byId.get(edge.producer)!;
    if (consumer === producer)
      return {
        safe: false,
        reason: `${edge.consumer} and ${edge.producer} share a journal sequence and read each other's writes`,
      };
    if (producer > consumer)
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
 *
 * A read of a resource the reading step did not write is a consultation, and
 * any step that wrote the resource could have produced what it saw, including
 * one that comes later in the journal, which is the case the ordering proof
 * has to refuse.
 *
 * A read of a resource the reading step *did* write is its own before-image.
 * It was taken as the write was prepared, so it observed the state the step
 * started from and only an earlier writer of that resource can have produced
 * it. A later writer cannot, and treating it as if it could is what made two
 * sequential writes to one file unrecoverable, with a claim about a read that
 * never happened. The producer outside the plan cannot be named either, so the
 * writers inside it stand in, and a stand-in is always the earlier of the two:
 * it can hold a branch that need not be held, and it can never release one
 * that must be.
 */
export function provenanceEdges(
  facts: readonly ProvenanceFact[],
): readonly ProvenanceEdge[] {
  return edgesFrom(facts, timelines(facts));
}

function edgesFrom(
  facts: readonly ProvenanceFact[],
  timelinesByResource: ReadonlyMap<string, readonly Claim[]>,
): readonly ProvenanceEdge[] {
  const edges: ProvenanceEdge[] = [];
  const seen = new Set<string>();
  for (const fact of facts) {
    if (fact.reads === undefined) continue;
    for (const read of fact.reads) {
      for (const claim of timelinesByResource.get(read.resource) ?? []) {
        if (claim.operationId === fact.operationId) continue;
        if (claim.sequence > fact.sequence && fact.resources.includes(read.resource))
          continue;
        const key = `${fact.operationId}\u0000${claim.operationId}\u0000${read.resource}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          consumer: fact.operationId,
          producer: claim.operationId,
          resource: read.resource,
        });
      }
    }
  }
  return edges;
}
