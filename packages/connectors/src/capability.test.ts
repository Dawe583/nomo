import test, { describe } from "node:test";
import assert from "node:assert/strict";

import {
  CAPABILITY_SCHEMA,
  CONFORMANCE_SCHEMA,
  bindsAdapter,
  certificationStatus,
  type CapabilityCertifiedEvidence,
  validateCapabilityProfile,
  type CapabilityProfile,
} from "./capability.ts";

const base: CapabilityProfile = {
  schema: CAPABILITY_SCHEMA,
  adapter: { id: "filesystem.managed", version: "1" },
  authority: "scope-only",
  operations: ["create", "write", "delete"],
  boundary: "cooperative-regular-file-paths",
  maxDecodedBytes: 1024 * 1024,
  recovery: { posix: "bytes-and-mode", win32: "bytes-writable-files-only" },
  durableExecutionReceipt: false,
  durableRecoveryReceipt: false,
  excluded: ["concurrent-external-writers", "shell-effects"],
  conformance: {
    schema: CONFORMANCE_SCHEMA,
    runtime: "void-recovery-runtime",
    fixture: "disposable-local-file-create-write-delete",
    checks: ["restart-and-idempotence", "human-drift", "lost-execution-response"],
    sharedRuntimeChecksOnly: true,
  },
  certification: false,
};

const errorsOf = (profile: unknown): string => validateCapabilityProfile(profile).join("; ");

describe("capability profile schema", () => {
  test("a sound profile validates and stays uncertified at certification:false", () => {
    assert.deepEqual(validateCapabilityProfile(base), []);
    assert.deepEqual(certificationStatus(base), {
      certified: false,
      sharedRuntimeChecksOnly: true,
    });
  });

  test("a missing schema version and a missing adapter version are both refused", () => {
    const { schema: _omitted, ...withoutSchema } = base;
    assert.deepEqual(validateCapabilityProfile(withoutSchema), [
      'schema must be "void.adapter-capability.v2"',
    ]);
    assert.match(
      errorsOf({ ...base, adapter: { id: "filesystem.managed" } }),
      /adapter\.version must be a non-empty string/,
    );
    assert.equal(certificationStatus(withoutSchema as unknown as CapabilityProfile).certified, false);
  });

  test("the retired v1 profile is rejected instead of coerced", () => {
    const v1 = { ...base, schema: "void.adapter-capability.v1" };
    assert.deepEqual(validateCapabilityProfile(v1), [
      'schema must be "void.adapter-capability.v2"',
    ]);
  });

  test("certification:true is refused, and a bare true is not evidence", () => {
    assert.match(
      errorsOf({ ...base, certification: true }),
      /a bare true is not evidence/,
    );
    assert.deepEqual(certificationStatus({ ...base, certification: true } as unknown as CapabilityProfile), {
      certified: false,
      sharedRuntimeChecksOnly: true,
    });
  });

  test("an evidence object needs checks, an ISO timestamp and the same adapter version", () => {
    const evidence: CapabilityCertifiedEvidence = {
      certified: true,
      checks: ["restart-and-idempotence", "human-drift"],
      at: "2026-09-18T00:00:00.000Z",
      adapterVersion: "1",
    };
    assert.deepEqual(validateCapabilityProfile({ ...base, certification: evidence }), []);
    assert.equal(certificationStatus({ ...base, certification: evidence }).certified, true);
    assert.match(errorsOf({ ...base, certification: { ...evidence, checks: [] } }), /must name the checks/);
    assert.match(errorsOf({ ...base, certification: { ...evidence, at: "last tuesday" } }), /ISO run timestamp/);
    assert.match(
      errorsOf({ ...base, certification: { ...evidence, adapterVersion: "2" } }),
      /certification\.adapterVersion must equal adapter\.version/,
    );
    assert.equal(
      certificationStatus({ ...base, certification: { ...evidence, adapterVersion: "2" } }).certified,
      false,
    );
    assert.match(errorsOf({ ...base, certification: { ...evidence, signedBy: "us" } }), /unknown field "signedBy"/);
  });

  test("a certification decision is optional, and a present one has to carry a real date", () => {
    assert.deepEqual(validateCapabilityProfile(base), []);
    assert.deepEqual(
      validateCapabilityProfile({
        ...base,
        certificationDecision: {
          decidedOn: "2026-09-26",
          reason: "the signer and the executor are one principal",
        },
      }),
      [],
    );
    // A format check alone would accept these, because `Date` reads
    // "2026-02-30" as March 2 and "2026-13-45" as nothing at all.
    for (const decidedOn of ["2026-02-30", "2026-13-45", "26-09-2026", "2026-09-26T00:00:00.000Z", "last week"]) {
      assert.match(
        errorsOf({ ...base, certificationDecision: { decidedOn, reason: "because" } }),
        /certificationDecision\.decidedOn must be a real calendar date/,
        decidedOn,
      );
    }
    assert.match(
      errorsOf({ ...base, certificationDecision: { decidedOn: "2026-09-26", reason: "" } }),
      /certificationDecision\.reason must name why/,
    );
    assert.match(
      errorsOf({ ...base, certificationDecision: "2026-09-26" }),
      /certificationDecision must be an object/,
    );
    assert.match(
      errorsOf({ ...base, certificationDecision: { decidedOn: "2026-09-26", verdict: "false" } }),
      /unknown field "verdict"/,
    );
  });

  test("a dated decision does not certify anything by itself", () => {
    const decided: CapabilityProfile = {
      ...base,
      certificationDecision: {
        decidedOn: "2026-09-26",
        reason: "the signer and the executor are one principal",
      },
    };
    assert.deepEqual(certificationStatus(decided), {
      certified: false,
      sharedRuntimeChecksOnly: true,
    });
  });

  test("a misspelled field is refused rather than silently ignored", () => {
    assert.deepEqual(validateCapabilityProfile({ ...base, certifcation: true }), [
      'unknown field "certifcation"',
    ]);
    assert.deepEqual(validateCapabilityProfile({ ...base, sharedRuntimeChecksOnly: true }), [
      'unknown field "sharedRuntimeChecksOnly"',
    ]);
    assert.match(
      errorsOf({ ...base, conformance: { ...base.conformance, sharedChecks: true } }),
      /unknown field "sharedChecks"/,
    );
  });

  test("a profile that claims authorization instead of scope is refused", () => {
    assert.match(
      errorsOf({ ...base, authority: "certified" }),
      /authority must be "scope-only"/,
    );
    assert.equal(certificationStatus({ ...base, authority: "certified" } as unknown as CapabilityProfile).certified, false);
  });

  test("scope fields are type checked, including the byte ceiling", () => {
    assert.match(errorsOf({ ...base, maxDecodedBytes: 0 }), /maxDecodedBytes must be a positive integer/);
    assert.match(errorsOf({ ...base, maxDecodedBytes: 1.5 }), /maxDecodedBytes must be a positive integer/);
    assert.match(errorsOf({ ...base, boundary: "" }), /boundary must be a non-empty string/);
    assert.match(errorsOf({ ...base, durableRecoveryReceipt: "no" }), /durableRecoveryReceipt must be an explicit boolean/);
    assert.match(errorsOf({ ...base, recovery: {} }), /recovery must be a non-empty platform-to-guarantee map/);
  });

  test("an empty operation list is only a platform exclusion", () => {
    assert.match(
      errorsOf({ ...base, operations: [] }),
      /recovery excludes a platform as unsupported/,
    );
    const excludedPlatform: CapabilityProfile = {
      ...base,
      operations: [],
      recovery: { posix: "selected-worktree-bytes", win32: "unsupported" },
    };
    assert.deepEqual(validateCapabilityProfile(excludedPlatform), []);
    assert.match(
      errorsOf({ ...base, conformance: { ...base.conformance, checks: [] } }),
      /conformance\.checks must be a non-empty/,
    );
    assert.match(
      errorsOf({ ...base, conformance: { ...base.conformance, runtime: "" } }),
      /conformance\.runtime must name the runtime/,
    );
    assert.match(
      errorsOf({ ...base, conformance: { ...base.conformance, sharedRuntimeChecksOnly: "yes" } }),
      /conformance\.sharedRuntimeChecksOnly must be an explicit boolean/,
    );
    assert.deepEqual(validateCapabilityProfile(null), ["profile must be an object"]);
  });

  test("a drifted adapter version does not bind", () => {
    assert.equal(bindsAdapter(base, "filesystem.managed", "1"), true);
    assert.equal(bindsAdapter(base, "filesystem.managed", "2"), false);
    assert.equal(bindsAdapter(base, "git.managed", "1"), false);
  });
});
