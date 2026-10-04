import { createHash } from "node:crypto";

import type { Probe, ProbeCall, ProbeExecutor, ProbeResult } from "./registry.ts";

export type ProbeCacheEntry = {
  readonly radius: number | undefined;
  readonly facts: Readonly<Record<string, string>> | undefined;
  readonly note: string | undefined;
  readonly when: number;
};

/**
 * Ceiling on retained probe results.
 *
 * A key is `sha256(probeId + call)`, so any two calls differing in one argument
 * mint different keys, and nothing above this layer bounds how many distinct
 * calls a session may issue. The TTL answers "is this entry still usable"; it
 * never removed anything, so an expired entry cost exactly as much as a fresh
 * one and the map only ever grew. This is the bound that closes that.
 *
 * 256 covers the working set of distinct probes a conversation actually issues
 * (the connector probe sets are two apiece) while holding retained facts and
 * notes to a fixed few hundred small records regardless of session length.
 */
export const PROBE_CACHE_MAX_ENTRIES = 256;

export type ProbeCache = {
  readonly run: (probe: Probe, call: ProbeCall, exec: ProbeExecutor) => Promise<ProbeResult>;
  readonly size: () => number;
};

export function probeCache(seconds: number, clock: () => Date): ProbeCache {
  const entries = new Map<string, ProbeCacheEntry>();
  return {
    async run(probe, call, exec) {
      const key = digestCall(probe.id, call);
      const now = clock().getTime();
      const cached = entries.get(key);
      if (cached !== undefined && now - cached.when < seconds * 1000) {
        return { radius: cached.radius, facts: cached.facts, note: cached.note };
      }
      const result = await probe.run(call, exec);
      if (!("error" in result)) {
        // Map preserves insertion order, so the first key is the oldest write.
        // Dropping it makes the next run of that call re-probe, which is the
        // safe direction to lose in: a missing radius is measured again, a
        // stale one is trusted. Eviction therefore reaches entries that are
        // still inside their TTL, and that is deliberate. The alternative is an
        // unbounded map, not a stricter TTL.
        //
        // Only a key that missed the TTL check reaches this write, so the
        // entry the loop removes is never fresher than the one being stored.
        while (entries.size >= PROBE_CACHE_MAX_ENTRIES) {
          const oldest = entries.keys().next();
          if (oldest.done === true) break;
          entries.delete(oldest.value);
        }
        entries.set(key, { radius: result.radius, facts: result.facts, note: result.note, when: now });
      }
      return result;
    },
    size() {
      return entries.size;
    },
  };
}

function digestCall(probeId: string, call: ProbeCall): string {
  return createHash("sha256").update(`${probeId}:${stableJson(call)}`).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}
