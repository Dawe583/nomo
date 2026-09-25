import test from "node:test";
import assert from "node:assert/strict";
import { holderPid, leaseOf, leaseVerdict } from "./recovery/lease.ts";

const NOW = 1_000_000;
const lease = (holder: string, expiresAt: number) => ({ holder, expiresAt });
const dead = () => false;
const alive = () => true;

test("a lease is only reclaimable when it expired AND its holder is gone", () => {
  // Both conditions, so neither one alone is load bearing.
  assert.deepEqual(leaseVerdict(lease("host:11", NOW - 1), dead, NOW), {
    reclaimable: true,
    holder: "host:11",
  });
  assert.deepEqual(leaseVerdict(lease("host:11", NOW + 1), dead, NOW), {
    reclaimable: false,
    reason: "the lease has not expired",
  });
  assert.deepEqual(leaseVerdict(lease("host:11", NOW - 1), alive, NOW), {
    reclaimable: false,
    reason: "lease holder host:11 is still running",
  });
});

test("an absent or unusable lease blocks, because an unknown owner is not a dead one", () => {
  assert.equal(leaseVerdict(undefined, dead, NOW).reclaimable, false);
  assert.match(leaseVerdict(undefined, dead, NOW).reason, /no lease/);
  assert.equal(leaseVerdict(lease("host", NOW - 1), dead, NOW).reclaimable, false);
  assert.match(leaseVerdict(lease("host", NOW - 1), dead, NOW).reason, /no usable pid/);
  assert.equal(leaseVerdict(lease("host:notapid", NOW - 1), dead, NOW).reclaimable, false);
  assert.equal(leaseVerdict(lease("host:0", NOW - 1), dead, NOW).reclaimable, false);
});

test("the pid is read from the end of the holder, so a labelled host is not a pid", () => {
  assert.equal(holderPid("host:4321"), 4321);
  assert.equal(holderPid("pod-7.example.com:99"), 99);
  assert.equal(holderPid("no-colon"), null);
});

test("a lease is read out of a payload and never invented", () => {
  assert.deepEqual(leaseOf({ checkpoint: 1, lease: { holder: "host:7", expiresAt: 9 } }), {
    holder: "host:7",
    expiresAt: 9,
  });
  for (const payload of [
    null,
    "lease",
    [],
    { checkpoint: 1 },
    { lease: null },
    { lease: { holder: "host:7" } },
    { lease: { holder: "host:7", expiresAt: Number.NaN } },
    { lease: { holder: "host:7", expiresAt: 1, extra: true } },
  ]) {
    assert.equal(leaseOf(payload), undefined, JSON.stringify(payload));
  }
});

test("the default liveness check asks the operating system, and a live pid is alive", () => {
  assert.equal(leaseVerdict(lease("host:0", NOW - 1), undefined, NOW).reclaimable, false);
  // This process is definitionally alive, so its own lease is never reclaimable
  // however old it is.
  assert.equal(
    leaseVerdict(lease(`host:${process.pid}`, 0)).reclaimable,
    false,
  );
});
