/**
 * Release gate for the machine-readable capability profile (G-06 / WP-R00).
 *
 * The profile is the only machine-readable statement of what an adapter can
 * recover, so a release that ships an adapter whose profile is missing,
 * invalid or quietly claims more than its evidence must stop here. The gate
 * loads the profiles the CLI actually ships, re-validates them against
 * `void.adapter-capability.v2` instead of trusting the import-time
 * declaration, and refuses a run for an adapter id no profile publishes.
 *
 * It runs as part of `pnpm test` (scripts suite) and standalone:
 *   node --test scripts/src/capability-profile-gate.test.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  certificationStatus,
  validateCapabilityProfile,
} from "../../packages/connectors/src/capability.ts";
import {
  CONFORMANCE_RUNTIME,
  declareProviderProfiles,
  hasProviderProfile,
  resolveProviderProfile,
  sharedConformanceRuntime,
} from "../../packages/connectors/src/capability-profiles.ts";
import {
  filesystemConformanceProfile,
  gitConformanceProfile,
  managedDocumentsConformanceProfile,
  managedPostgresConformanceProfile,
  providerProfiles,
  runConformanceCommand,
} from "../../packages/cli/src/conformance.ts";
import { managedPostgresConformanceIdentity } from "../../packages/connectors/src/postgres/conformance-fixture.ts";

/** Every provider profile the CLI ships, loaded from the shipped source. */
const shipped = [
  filesystemConformanceProfile,
  gitConformanceProfile,
  managedDocumentsConformanceProfile,
  managedPostgresConformanceProfile,
];

test("every shipped provider profile fits void.adapter-capability.v2", () => {
  for (const profile of shipped) {
    assert.deepEqual(
      validateCapabilityProfile(profile),
      [],
      `${profile.adapter.id} does not fit the schema`,
    );
  }
  assert.deepEqual(
    providerProfiles.ids,
    shipped.map((profile) => profile.adapter.id),
  );
});

test("the gate re-declares the shipped set and refuses a certified claim", () => {
  const set = declareProviderProfiles(shipped);
  assert.equal(sharedConformanceRuntime(set), CONFORMANCE_RUNTIME.id);
  for (const profile of set.entries) {
    const label = profile.adapter.id;
    assert.equal(profile.authority, "scope-only", label);
    assert.equal(profile.certification, false, label);
    assert.deepEqual(
      certificationStatus(profile),
      { certified: false, sharedRuntimeChecksOnly: true },
      label,
    );
    assert.equal(profile.conformance.runtime, CONFORMANCE_RUNTIME.id, label);
    assert.equal(profile.conformance.sharedRuntimeChecksOnly, true, label);
    assert.ok(profile.excluded.length > 0, `${label} states what it cannot do`);
  }
  const claimed = {
    ...filesystemConformanceProfile,
    certification: true,
  };
  assert.throws(
    () => declareProviderProfiles([claimed]),
    /a bare true is not evidence/,
  );
  assert.throws(
    () => declareProviderProfiles([{ ...filesystemConformanceProfile, authority: "certified" }]),
    /authority must be "scope-only"/,
  );
  assert.throws(
    () => declareProviderProfiles([{ ...filesystemConformanceProfile, schema: "void.adapter-capability.v1" }]),
    /schema must be "void\.adapter-capability\.v2"/,
  );
});

test("a run for an adapter without a published profile is refused", async () => {
  assert.equal(hasProviderProfile(providerProfiles, "postgres-managed-workbench"), false);
  assert.throws(
    () => resolveProviderProfile(providerProfiles, "postgres-managed-workbench"),
    /no capability profile for adapter "postgres-managed-workbench"/,
  );
  await assert.rejects(
    runConformanceCommand(["--adapter", "postgres-managed-workbench"], () => {
      assert.fail("a run without a capability profile must not report");
    }),
    /no capability profile for "postgres-managed-workbench"/,
  );
});

test("the gate covers the managed PostgreSQL adapter the tree actually builds", () => {
  // Read from the factory, not from a string in this test: the adapter
  // derives its id from the configured workspace, so the id a release would
  // ship is whatever `managedPostgresAdapter` builds. A profile that named a
  // different string, or a set that dropped the profile, fails here instead
  // of shipping the adapter unpublished.
  const identity = managedPostgresConformanceIdentity();
  assert.equal(identity.version, "2");
  assert.deepEqual(managedPostgresConformanceProfile.adapter, identity);
  assert.equal(hasProviderProfile(providerProfiles, identity.id), true);
  assert.equal(
    resolveProviderProfile(providerProfiles, identity.id).adapter.version,
    identity.version,
  );
  // An in-process engine is not a networked cluster, and the durable flags
  // are only true because the receipts live in the managed metadata.
  assert.equal(managedPostgresConformanceProfile.durableExecutionReceipt, true);
  assert.equal(managedPostgresConformanceProfile.durableRecoveryReceipt, true);
  assert.ok(
    managedPostgresConformanceProfile.excluded.includes("server-side-certification"),
    "an in-process engine is not a networked cluster",
  );
});

test("another workspace of the same adapter is refused, because a profile binds one id", async () => {
  // The identity is workspace-scoped, so publishing one profile cannot cover
  // every deployment of this adapter. Refusing a run for an id nothing was
  // measured against beats resolving a profile for it.
  await assert.rejects(
    runConformanceCommand(["--adapter", "postgres-managed-workbench"], () => {
      assert.fail("an unpublished adapter id must not report");
    }),
    /no capability profile for "postgres-managed-workbench"/,
  );
});
