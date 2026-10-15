import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { devKeyProvider } from "../../ledger/src/sign.ts";
import { pinVerificationKey } from "../../ledger/src/verify-key.ts";
import { runDoctorCommand, type DoctorDeps } from "./doctor.ts";

function collect() {
  const out: string[] = [], err: string[] = [];
  return {
    out,
    err,
    io: {
      stdout: (line: string) => { out.push(line); },
      stderr: (line: string) => { err.push(line); },
    },
  };
}
const healthy: DoctorDeps = {
  env: {},
  nodeVersion: "v26.8.1",
  run: async () => "10.33.0",
  writable: async () => "ok",
  present: async () => true,
};

test("doctor passes a healthy environment and exits zero", async () => {
  const c = collect();
  const code = await runDoctorCommand([], c.io, healthy);
  assert.equal(code, 0);
  assert.ok(c.out.some((line) => line.startsWith("PASS node")));
  assert.ok(c.out.some((line) => line.startsWith("PASS pnpm")));
  assert.ok(c.out.some((line) => line.startsWith("PASS data-dir")));
  assert.ok(c.out.at(-1)?.startsWith("doctor: "));
  assert.equal(c.err.length, 0);
});

test("doctor fails an old Node and only warns without pnpm", async () => {
  const c = collect();
  const code = await runDoctorCommand([], c.io, {
    ...healthy,
    nodeVersion: "v22.1.0",
    run: async () => { throw Error("not found"); },
  });
  assert.equal(code, 1);
  assert.ok(c.out.some((line) => line.startsWith("FAIL node")));
  assert.ok(c.out.some((line) => line.startsWith("WARN pnpm")));
});

test("a denied directory fails while missing state only warns", async () => {
  const c = collect();
  const code = await runDoctorCommand([], c.io, {
    ...healthy,
    writable: async () => "denied",
    present: async () => false,
  });
  assert.equal(code, 1);
  assert.ok(c.out.some((line) => line.startsWith("FAIL data-dir")));
  assert.ok(c.out.some((line) => line.startsWith("WARN provider-state")));
});

test("doctor init does not mistake the primary encrypted state for a backup", async () => {
  const c = collect();
  await runDoctorCommand(["init"], c.io, healthy);
  assert.ok(c.out.some((line) => line.startsWith("PASS provider-state: primary encrypted state found")));
  assert.ok(c.out.some((line) => line.startsWith("WARN backup-state: no complete recovery backup verified")));
  assert.equal(c.out.some((line) => line.startsWith("PASS backup-state")), false);
});

test("doctor rejects arguments with usage and exit two", async () => {
  const c = collect();
  const code = await runDoctorCommand(["--fix"], c.io, healthy);
  assert.equal(code, 2);
  assert.match(c.err[0] ?? "", /usage: nomo doctor/);
});

/**
 * F12: the trust-file branch of `doctor` had no test at all, so the fix that
 * stopped it reporting a default-path pin as "unset" rested on nothing. These
 * pin the three answers an operator can actually get, because the difference
 * between them is the whole point of the check.
 */
const doctorWith = (env: Readonly<NodeJS.ProcessEnv>) => {
  const c = collect();
  return {
    ...c,
    run: async () =>
      runDoctorCommand([], c.io, {
        env,
        nodeVersion: "v26.8.1",
        run: async () => "10.33.0",
        writable: async () => "ok",
        present: async () => true,
      } satisfies DoctorDeps),
  };
};

test("doctor warns that a default-path trust file is not a pin", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-doctor-trust-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".nomo", "trust"), { recursive: true, mode: 0o700 });
  const key = await devKeyProvider({ dir: join(root, ".nomo", "keys"), env: {} });
  const spki = await key.publicKey(await key.currentKeyId());
  assert.ok(spki !== null);
  await pinVerificationKey(spki, {
    file: join(root, ".nomo", "trust", "verify-ed25519.spki"),
    anchoredFrom: "signing-key-file",
  });

  const c = doctorWith({ HOME: root });
  await c.run();
  const line = c.out.find((entry) => entry.includes("verify-key"));
  assert.ok(line !== undefined, "doctor reported no verify-key line");
  // A `WARN`, not a `PASS`. The file is real and the key is honest, but it
  // shares `~/.nomo/` with the signing key, so anyone who can replace one can
  // replace the other and nothing would notice.
  assert.match(line, /^WARN verify-key: dev-ed25519:[0-9a-f]+ \(trust-file\) at /);
  assert.match(line, /shares ~\/\.nomo\//);
  assert.doesNotMatch(line, /supplied out of band/);
  assert.doesNotMatch(line, /^PASS/);
});

test("doctor passes only a key the operator supplied as a value", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-doctor-pinned-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const key = await devKeyProvider({ dir: join(root, ".nomo", "keys"), env: {} });
  const spki = await key.publicKey(await key.currentKeyId());
  assert.ok(spki !== null);

  const c = doctorWith({ HOME: root, NOMO_VERIFY_KEY: Buffer.from(spki).toString("base64") });
  await c.run();
  const line = c.out.find((entry) => entry.includes("verify-key"));
  assert.ok(line !== undefined);
  // This is the one state where the word is earned: a value, never written to
  // a file the agent can reach.
  assert.match(line, /^PASS verify-key: pinned dev-ed25519:[0-9a-f]+ \(pinned-env\)/);
});

test("doctor warns and names the opt-in when a degraded key resolves", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-doctor-degraded-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const key = await devKeyProvider({ dir: join(root, ".nomo", "keys"), env: {} });

  const c = doctorWith({ HOME: root, NOMO_VERIFY_ALLOW_SIGNING_KEY: "1" });
  await c.run();
  const line = c.out.find((entry) => entry.includes("verify-key"));
  assert.ok(line !== undefined, "doctor reported no verify-key line");
  // `signing-key-provider`, not `signing-key-file`: `doctor` asks for a
  // retained key through a thunk, and the source names where the bytes came
  // from, which is a caller-supplied signer over the same `dev-ed25519.pkcs8`.
  assert.match(line, /^WARN verify-key: DEGRADED dev-ed25519:[0-9a-f]+ \(signing-key-provider\)/);
  // F10: the variable that put the operator in this mode is named on the
  // surface, so an operator who lands here by accident can find the switch.
  // And the switch is at the front of the line, because `doctor` output is
  // read in a terminal and the tail is what gets cut.
  assert.match(line, /DEGRADED dev-ed25519:[0-9a-f]+ \(signing-key-provider\): NOMO_VERIFY_ALLOW_SIGNING_KEY/);
  assert.match(line, /NOMO_VERIFY_ALLOW_SIGNING_KEY/);
});
