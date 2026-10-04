import test, { describe } from "node:test";
import assert from "node:assert/strict";

import { probeCache, PROBE_CACHE_MAX_ENTRIES } from "./cache.ts";
import type { Probe } from "./registry.ts";

describe("probe cache", () => {
  test("memoizes and expires with a fake clock", async () => {
    let now = 1_000;
    let runs = 0;
    const cache = probeCache(10, () => new Date(now));
    const probe: Probe = {
      id: "demo",
      async run() {
        runs += 1;
        return { radius: runs, facts: { seen: String(runs) }, note: `run ${runs}` };
      },
    };
    const call = { tool: "x", args: { table: "a" } };

    assert.deepEqual(await cache.run(probe, call, {}), { radius: 1, facts: { seen: "1" }, note: "run 1" });
    now = 5_000;
    assert.deepEqual(await cache.run(probe, call, {}), { radius: 1, facts: { seen: "1" }, note: "run 1" });
    now = 12_000;
    assert.deepEqual(await cache.run(probe, call, {}), { radius: 2, facts: { seen: "2" }, note: "run 2" });
    assert.equal(runs, 2);
    assert.equal(cache.size(), 1);
  });

  // A probe key hashes the probe id together with the whole call, so two calls
  // that differ in a single argument mint two different keys. Nothing in the
  // call path bounds how many distinct calls a session may make, so an
  // unbounded map is a leak driven by caller-chosen arguments. The TTL decides
  // whether an entry is usable; only the count of retained entries needs a
  // ceiling, and the ceiling has to be observable so a test can assert the
  // bound rather than wait out a clock.
  test("caps retained entries at the named ceiling under 1000 distinct calls", async () => {
    assert.equal(typeof PROBE_CACHE_MAX_ENTRIES, "number");
    assert.ok(PROBE_CACHE_MAX_ENTRIES > 0 && PROBE_CACHE_MAX_ENTRIES < 1000, "the ceiling must bind below the number of distinct calls");

    const cache = probeCache(3_600, () => new Date(1_000));
    const probe: Probe = {
      id: "count",
      async run(call) {
        return { radius: Number(call.args.rows ?? 0), facts: { table: String(call.args.table) } };
      },
    };

    for (let index = 0; index < 1000; index += 1) {
      await cache.run(probe, { tool: "postgres.query", args: { table: "t", rows: index } }, {});
    }

    assert.ok(
      cache.size() <= PROBE_CACHE_MAX_ENTRIES,
      `cache retained ${cache.size()} entries, above the ceiling of ${PROBE_CACHE_MAX_ENTRIES}`,
    );
    assert.ok(cache.size() > 0, "a bound that evicts everything is not a cache");
  });

  // The ceiling can drop an entry that has not reached its TTL yet. That costs
  // one re-probe, which is the safe direction to be wrong in: a missing radius
  // is re-measured, a stale one is trusted. These assertions pin both halves,
  // so a future change cannot quietly serve a dropped value or evict the
  // newest key instead of the oldest.
  test("evicts oldest-first and an evicted entry re-probes instead of going stale", async () => {
    let runs = 0;
    const cache = probeCache(3_600, () => new Date(1_000));
    const probe: Probe = {
      id: "demo",
      async run() {
        runs += 1;
        return { radius: runs };
      },
    };

    assert.deepEqual(await cache.run(probe, { tool: "x", args: { table: "a" } }, {}), { radius: 1 });

    // The clock never advances, so every entry written below is still inside
    // its TTL when the ceiling forces the oldest one out.
    for (let index = 0; index < PROBE_CACHE_MAX_ENTRIES; index += 1) {
      await cache.run(probe, { tool: "x", args: { table: `filler-${index}` } }, {});
    }

    assert.equal(cache.size(), PROBE_CACHE_MAX_ENTRIES);
    const before = runs;
    assert.deepEqual(
      await cache.run(probe, { tool: "x", args: { table: "a" } }, {}),
      { radius: before + 1 },
      "an evicted entry must re-probe rather than answer from a dropped value",
    );

    // The key written last before the overflow survived it, which is only true
    // if eviction removes the oldest entry rather than an arbitrary one. A hit
    // comes back in the stored shape (radius plus optional facts and note),
    // so it did not re-run the probe.
    const newest = { tool: "x", args: { table: `filler-${PROBE_CACHE_MAX_ENTRIES - 1}` } };
    const beforeHit = runs;
    assert.deepEqual(await cache.run(probe, newest, {}), { radius: PROBE_CACHE_MAX_ENTRIES + 1, facts: undefined, note: undefined });
    assert.equal(runs, beforeHit, "the newest entry must still be cached, not re-probed");
  });

  // The eviction loop is driven by the TTL miss that just happened, so the
  // entry it drops is never fresher than the one being written. This pins that:
  // re-probing an expired key at the ceiling drops a peer that is *older*, and
  // leaves a newer peer alone. A loop that dropped the newest key instead would
  // pass a size check and still discard the freshest evidence.
  test("evicts an entry older than the one being written, never a fresher one", async () => {
    let now = 1_000;
    const cache = probeCache(10, () => new Date(now));
    const probe: Probe = {
      id: "demo",
      async run(call) {
        return { radius: Number(call.args.id) };
      },
    };

    // "old" is the first write, so it is the oldest entry. Everything else is
    // written later and is therefore the fresher peer that must survive.
    await cache.run(probe, { tool: "x", args: { id: 1 } }, {});
    now = 5_000;
    for (let index = 0; index < PROBE_CACHE_MAX_ENTRIES - 1; index += 1) {
      await cache.run(probe, { tool: "x", args: { id: 100 + index } }, {});
    }
    assert.equal(cache.size(), PROBE_CACHE_MAX_ENTRIES);

    // Advance past the first key's TTL only, then re-probe it at the ceiling.
    now = 12_000;
    await cache.run(probe, { tool: "x", args: { id: 1 } }, {});

    assert.equal(cache.size(), PROBE_CACHE_MAX_ENTRIES, "a refresh must leave the map at the ceiling, not above it");
    // The peer written just before the ceiling still answers from cache.
    const before = await cache.run(probe, { tool: "x", args: { id: 100 + PROBE_CACHE_MAX_ENTRIES - 2 } }, {});
    assert.deepEqual(before, { radius: 100 + PROBE_CACHE_MAX_ENTRIES - 2, facts: undefined, note: undefined });
  });
});