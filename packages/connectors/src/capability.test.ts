import test, { describe } from "node:test";
import assert from "node:assert/strict";

import {
  CAPABILITY_SCHEMA,
  CONFORMANCE_SCHEMA,
  bindsAdapter,
  certificationStatus,
  validateCapabilityProfile,
  type CapabilityProfile,
} from "./capability.ts";

const base: CapabilityProfile = {
  schema: CAPABILITY_SCHEMA,
  adapter: { id: "filesystem.managed", version: "1" },
  operations: ["create", "write", "delete"],
  boundary: "cooperative-regular-file-paths",
  recovery: { posix: "bytes-and-mode", win32: "bytes-writable-files-only" },
  durableExecutionReceipt: false,
  durableRecoveryReceipt: false,
  excluded: ["concurrent-external-writers", "shell-effects"],
  conformance: {
    schema: CONFORMANCE_SCHEMA,
    fixture: "disposable-local-file-create-write-delete",
    checks: ["restart-idempotence", "human-drift", "lost-response"],
  },
};

describe("capability profile", () => {
  test("sound profile validates but stays uncertified without a certification block", () => {
    assert.deepEqual(validateCapabilityProfile(base), []);
    assert.deepEqual(certificationStatus(base), {
      certified: false,
      sharedRuntimeChecksOnly: true,
    });
  });

  test("certified claim requires checks, timestamp and matching adapter version", () => {
    const certified: CapabilityProfile = {
      ...base,
      certification: {
        certified: true,
        checks: ["restart-idempotence", "human-drift"],
        at: "2026-09-18T00:00:00.000Z",
        adapterVersion: "1",
      },
    };
    assert.deepEqual(validateCapabilityProfile(certified), []);
    assert.deepEqual(certificationStatus(certified).certified, true);
  });

  test("certified:true with empty checks is refused and never certified", () => {
    const fake = {
      ...base,
      certification: { certified: true, checks: [], at: "2026-09-18T00:00:00.000Z" },
    };
    assert.match(
      validateCapabilityProfile(fake).join("; "),
      /must name the checks/,
    );
    assert.deepEqual(certificationStatus(fake as CapabilityProfile).certified, false);
  });

  test("drifted adapter version does not bind", () => {
    assert.equal(bindsAdapter(base, "filesystem.managed", "1"), true);
    assert.equal(bindsAdapter(base, "filesystem.managed", "2"), false);
    assert.equal(bindsAdapter(base, "git.managed", "1"), false);
    const drifted: CapabilityProfile = {
      ...base,
      certification: {
        certified: true,
        checks: ["restart-idempotence"],
        at: "2026-09-18T00:00:00.000Z",
        adapterVersion: "1",
      },
    };
    assert.equal(bindsAdapter({ ...drifted, adapter: { id: "filesystem.managed", version: "2" } }, "filesystem.managed", "2"), true);
    assert.deepEqual(
      validateCapabilityProfile({ ...drifted, adapter: { id: "filesystem.managed", version: "2" } }),
      ["certification.adapterVersion must equal adapter.version"],
    );
  });

  test("missing scope, boundary and receipt flags are explicit errors", () => {
    const broken = {
      ...base,
      operations: [],
      boundary: "",
      durableExecutionReceipt: "no",
    };
    const errors = validateCapabilityProfile(broken);
    assert.match(errors.join("; "), /operations must be a non-empty/);
    assert.match(errors.join("; "), /boundary must be a non-empty/);
    assert.match(errors.join("; "), /durableExecutionReceipt must be an explicit boolean/);
    assert.deepEqual(certificationStatus(broken as unknown as CapabilityProfile).certified, false);
  });

  test("wrong schema and emptied conformance checks fail closed", () => {
    assert.match(
      validateCapabilityProfile({ ...base, schema: "void.adapter-capability.v0" }).join("; "),
      /schema must be/,
    );
    assert.match(
      validateCapabilityProfile({ ...base, conformance: { ...base.conformance, checks: [] } }).join("; "),
      /conformance.checks must be a non-empty/,
    );
    assert.deepEqual(validateCapabilityProfile(null), ["profile must be an object"]);
  });
});
