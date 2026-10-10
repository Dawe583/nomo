import test, { describe } from "node:test";
import assert from "node:assert/strict";

import {
  CAPABILITY_SCHEMA,
  CONFORMANCE_SCHEMA,
  type CapabilityProfile,
} from "./capability.ts";
import {
  CONFORMANCE_RUNTIME,
  CapabilityProfileError,
  declareProviderProfiles,
  hasProviderProfile,
  resolveProviderProfile,
  sharedConformanceRuntime,
} from "./capability-profiles.ts";

const profileFor = (id: string, version = "1"): CapabilityProfile => ({
  schema: CAPABILITY_SCHEMA,
  adapter: { id, version },
  authority: "scope-only",
  operations: ["write"],
  boundary: "cooperative-regular-file-paths",
  maxDecodedBytes: 1024 * 1024,
  recovery: { posix: "bytes-and-mode", win32: "bytes-writable-files-only" },
  durableExecutionReceipt: false,
  durableRecoveryReceipt: false,
  excluded: ["concurrent-external-writers"],
  conformance: {
    schema: CONFORMANCE_SCHEMA,
    runtime: CONFORMANCE_RUNTIME.id,
    fixture: "disposable-local-file-create-write-delete",
    checks: ["restart-and-idempotence", "human-drift"],
    sharedRuntimeChecksOnly: true,
  },
  certification: false,
});

const set = declareProviderProfiles([profileFor("filesystem.managed"), profileFor("git.managed")]);

describe("per-provider capability profile set", () => {
  test("each provider keeps its own profile and scope", () => {
    assert.deepEqual(set.ids, ["filesystem.managed", "git.managed"]);
    const filesystem = resolveProviderProfile(set, "filesystem.managed");
    const git = resolveProviderProfile(set, "git.managed");
    assert.notEqual(filesystem, git);
    assert.equal(git.boundary, "cooperative-regular-file-paths");
    assert.equal(filesystem.adapter.version, "1");
  });

  test("an adapter id without a profile is refused, with the published ids", () => {
    assert.equal(hasProviderProfile(set, "postgres-managed-workbench"), false);
    assert.throws(
      () => resolveProviderProfile(set, "postgres-managed-workbench"),
      (error: unknown) => {
        assert.ok(error instanceof CapabilityProfileError);
        assert.match(error.message, /no capability profile for adapter "postgres-managed-workbench"/);
        assert.match(error.message, /published: filesystem\.managed, git\.managed/);
        return true;
      },
    );
  });

  test("a profile that does not fit the schema refuses the whole set", () => {
    assert.throws(
      () => declareProviderProfiles([profileFor("filesystem.managed"), { ...profileFor("git.managed"), schema: "void.adapter-capability.v1" }]),
      (error: unknown) => {
        assert.ok(error instanceof CapabilityProfileError);
        assert.match(error.message, /capability profile for git\.managed does not fit/);
        assert.match(error.message, /schema must be "void\.adapter-capability\.v2"/);
        return true;
      },
    );
    assert.throws(
      () => declareProviderProfiles([]),
      /must declare at least one adapter/,
    );
  });

  test("two profiles for one adapter id are a declaration error, not last-one-wins", () => {
    assert.throws(
      () => declareProviderProfiles([profileFor("git.managed", "1"), profileFor("git.managed", "2")]),
      /duplicate capability profile for "git\.managed": versions 1 and 2/,
    );
  });

  test("a provider bound to another runtime is refused instead of sharing a claim", () => {
    const foreign = profileFor("git.managed");
    assert.throws(
      () =>
        declareProviderProfiles([
          profileFor("filesystem.managed"),
          {
            ...foreign,
            conformance: { ...foreign.conformance, runtime: "postgres-managed-runtime" },
          },
        ]),
      /binds runtime "postgres-managed-runtime", the set declares "nomo-recovery-runtime"/,
    );
  });

  test("a declared sharedRuntimeChecksOnly that contradicts the certification status is refused", () => {
    const certified = profileFor("git.managed");
    const claim = {
      ...certified,
      certification: {
        certified: true,
        checks: ["restart-and-idempotence"],
        at: "2026-09-18T00:00:00.000Z",
        adapterVersion: "1",
      },
    } satisfies CapabilityProfile;
    assert.throws(
      () => declareProviderProfiles([profileFor("filesystem.managed"), claim]),
      /capability profile for "git\.managed" declares sharedRuntimeChecksOnly true but its certification status says false/,
    );
  });

  test("a set declared against another runtime refuses the profiles that bind this one", () => {
    assert.throws(
      () => declareProviderProfiles([profileFor("git.managed")], { id: "postgres-managed-runtime" }),
      /binds runtime "nomo-recovery-runtime", the set declares "postgres-managed-runtime"/,
    );
  });

  test("the published set names the one runtime every provider ran on", () => {
    assert.equal(sharedConformanceRuntime(set), CONFORMANCE_RUNTIME.id);
    assert.deepEqual(
      set.entries.map((profile) => profile.conformance.runtime),
      [CONFORMANCE_RUNTIME.id, CONFORMANCE_RUNTIME.id],
    );
  });
});
