import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

import { runRecoveryCommand } from "./recovery.ts";
import {
  listFileVaultRetention,
  listReservedVaultRetention,
  type RetentionRow,
} from "./recovery-retention.ts";
import { reservedRecoveryVault, localRecoveryVault } from "../../runtime/src/index.ts";
import { devKeyProvider } from "../../ledger/src/sign.ts";

const fixture = async (t: { after: (fn: () => unknown) => void }) => {
  const dir = await mkdtemp(join(tmpdir(), "nomo-recovery-retention-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { TEST_KEY: randomBytes(32).toString("base64") },
    config = join(dir, "nomo-recovery.json");
  await mkdir(join(dir, "project"), { recursive: true });
  await mkdir(join(dir, "state"), { recursive: true });
  await writeFile(
    config,
    JSON.stringify({
      workspace: "test",
      stateDir: "state",
      encryptionKeyEnv: "TEST_KEY",
      filesystem: { root: "project", cooperative: true },
    }),
  );
  await devKeyProvider({
    dir: join(dir, "state", "keys"),
    env: {},
    createIfMissing: true,
  });
  // Both halves of the vault share the state directory: the reserved store
  // keeps filled rows in its sqlite file and the legacy half keeps files and
  // evidence sidecars beside it, so one config drives both surfaces the way
  // a mixed store reads in production.
  const vault = reservedRecoveryVault(
    join(dir, "state", "vault"),
    { local: Buffer.from(env.TEST_KEY, "base64") },
    "local",
  );
  const putReserved = async (value: string): Promise<string> => {
    await vault.put("test", value);
    const rows = await listReservedVaultRetention(vault, "test");
    const row = rows.find((entry) => entry.lifecycle === undefined);
    assert.ok(row !== undefined);
    return row.digest;
  };
  const putFile = async (value: string): Promise<string> => {
    // The legacy half keeps files the legacy writer wrote: the reserved
    // store reads one of them as its key-check sample by decrypting it, so
    // a raw byte file here would make every first reserved-half
    // transaction refuse "Recovery artifact cannot be verified." The
    // artifact content is the ciphertext envelope a real writer leaves.
    const reference = await localRecoveryVault(
      join(dir, "state", "vault"),
      { local: Buffer.from(env.TEST_KEY, "base64") },
      "local",
    ).put("test", value);
    return reference.digest;
  };
  const reservedRows = (): Promise<RetentionRow[]> =>
    listReservedVaultRetention(vault, "test");
  const fileRows = (): Promise<RetentionRow[]> =>
    listFileVaultRetention({
      root: join(dir, "state", "vault"),
      index: join(dir, "state", "retention-index"),
      workspace: "test",
    });
  return {
    dir,
    env,
    config,
    putReserved,
    putFile,
    reservedRows,
    fileRows,
    run: async (argv: readonly string[]) => {
      const lines: string[] = [];
      try {
        const code = await runRecoveryCommand(
          ["retention", ...argv, "--config", config],
          env,
          (line) => lines.push(line),
        );
        return {
          code,
          json: () => JSON.parse(lines.join("\n")) as unknown,
        };
      } catch (error) {
        // A refusal can still print its run object, so the test that
        // asserts the machine contract needs the lines out of the throw.
        (error as Error & { printed: string[] }).printed = lines.slice();
        throw error;
      }
    },
  };
};

test("the list reads an empty workspace as empty halves and exits zero", async (t) => {
  const f = await fixture(t);
  const out = await f.run(["--list"]);
  assert.equal(out.code, 0);
  assert.deepEqual(out.json(), { file: [], reserved: [] });
});

test("a pin records on the reserved half and the list reads it back", async (t) => {
  const f = await fixture(t);
  const digest = await f.putReserved("probe anchor");
  const out = await f.run([
    "--surface",
    "reserved",
    "--pin",
    digest,
    "--as",
    "op-a",
  ]);
  assert.equal(out.code, 0);
  assert.deepEqual(out.json(), {
    surface: "reserved",
    digest,
    transition: "pinned",
    as: "op-a",
    halves: [{ surface: "reserved", outcome: "recorded" }],
  });
  const rows = await f.reservedRows();
  assert.deepEqual(rows[0].lifecycle?.pin, { ownerId: "op-a", kind: "operator" });
});

test("a pin protects the legacy file half and a wrong release refuses", async (t) => {
  const f = await fixture(t);
  const digest = await f.putFile("legacy bytes");
  const out = await f.run([
    "--surface",
    "file",
    "--pin",
    digest,
    "--as",
    "op-a",
    "--kind",
    "recovery",
  ]);
  assert.equal(out.code, 0);
  assert.deepEqual(out.json(), {
    surface: "file",
    digest,
    transition: "pinned",
    as: "op-a",
    halves: [{ surface: "file", outcome: "recorded" }],
  });
  const pinned = (await f.fileRows()).find((row) => row.digest === digest);
  assert.deepEqual(pinned?.lifecycle?.pin, { ownerId: "op-a", kind: "recovery" });
  // The release must name the recorded pin. A stale operator view of who
  // holds the pin must not become the removal of it.
  await assert.rejects(
    f.run(["--surface", "file", "--release", digest, "--pins", "op-b:operator", "--as", "op-r"]),
    /pin does not match/,
  );
  assert.deepEqual(
    (await f.fileRows()).find((row) => row.digest === digest)?.lifecycle?.pin,
    { ownerId: "op-a", kind: "recovery" },
  );
  const released = await f.run([
    "--surface",
    "file",
    "--release",
    digest,
    "--pins",
    "op-a:recovery",
    "--as",
    "op-r",
  ]);
  assert.equal(released.code, 0);
  assert.deepEqual(released.json(), {
    surface: "file",
    digest,
    transition: "released",
    as: "op-r",
    halves: [{ surface: "file", outcome: "recorded" }],
  });
  const after = (await f.fileRows()).find((row) => row.digest === digest);
  assert.deepEqual(after?.lifecycle?.pin, undefined);
  assert.deepEqual(after?.lifecycle?.release?.released, {
    ownerId: "op-a",
    kind: "recovery",
  });
});

test("a release with no recorded pin refuses and records nothing", async (t) => {
  const f = await fixture(t);
  const digest = await f.putFile("unpinned bytes");
  await assert.rejects(
    f.run(["--surface", "file", "--release", digest, "--pins", "op-a:operator", "--as", "op-r"]),
  );
  const rows = await f.fileRows();
  assert.deepEqual(rows.length, 1);
  assert.deepEqual(rows[0].lifecycle, undefined);
});

test("a mark for a digest no healthy store proves refuses", async (t) => {
  const f = await fixture(t);
  await f.putReserved("reserved only");
  const missing = createHash("sha256").update(Buffer.from("ghost")).digest("hex");
  // A default both-surface pin of a digest neither store holds skips both
  // absent halves, so the run refuses loudly rather than pretend the
  // protection moved anywhere.
  await assert.rejects(
    f.run(["--pin", missing, "--as", "op-a"]),
    /No retention surface names the digest/,
  );
  await assert.rejects(
    f.run(["--surface", "reserved", "--pin", missing, "--as", "op-a"]),
    /No retention surface names the digest/,
  );
});

test("the unpinned mark records the collectable record and a pin refuses it", async (t) => {
  const f = await fixture(t);
  const collectable = await f.putFile("already reviewed");
  const pinned = await f.putFile("stays protected");
  const out = await f.run(["--surface", "file", "--mark-unpinned", collectable]);
  assert.equal(out.code, 0);
  assert.deepEqual(out.json(), {
    surface: "file",
    digest: collectable,
    transition: "unpinned",
    halves: [{ surface: "file", outcome: "recorded" }],
  });
  const rows = await f.fileRows();
  assert.deepEqual(rows.find((row) => row.digest === collectable)?.lifecycle, {});
  // A pinned artifact is not released by an unpinned mark: removing a pin
  // is a named release, never a reclassification.
  await f.run(["--surface", "file", "--pin", pinned, "--as", "op-a"]);
  await assert.rejects(
    f.run(["--surface", "file", "--mark-unpinned", pinned]),
    /not released by retention/,
  );
});

test("a sidecar whose artifact collection already removed lists as a ghost row", async (t) => {
  const f = await fixture(t);
  const digest = await f.putFile("collected away");
  await f.run(["--surface", "file", "--mark-unpinned", digest]);
  // The collector removes the artifact bytes and keeps the evidence sidecar,
  // so protection recorded for reviewed bytes outlives the bytes.
  await rm(join(f.dir, "state", "vault", "test", digest));
  const out = await f.run(["--list"]);
  assert.equal(out.code, 0);
  const ghost = (out.json() as { file: RetentionRow[] }).file.find(
    (row) => row.digest === digest,
  );
  // The record names nothing an artifact walk can measure: the ghost row
  // distinguishes a reviewed removal from a digest nobody proved.
  assert.deepEqual(ghost, {
    digest,
    bytes: null,
    artifact: false,
    writtenAt: null,
    lifecycle: {},
  });
});

test("--dry-run is refused on the retention action and records nothing", async (t) => {
  const f = await fixture(t);
  const digest = await f.putReserved("dry run probe");
  await assert.rejects(
    f.run(["--dry-run", "--pin", digest, "--as", "op-dry"]),
    /--dry-run predicts a collect run; a retention transition has no prediction mode/,
  );
  const rows = await f.reservedRows();
  const row = rows.find((entry) => entry.digest === digest);
  assert.ok(row !== undefined);
  assert.equal(row.lifecycle, undefined);
});

test("--dry-run beside --list refuses the same way", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.run(["--dry-run", "--list"]),
    /--dry-run predicts a collect run/,
  );
});

test("a release decides from the recorded evidence, not from the artifact bytes", async (t) => {
  const f = await fixture(t);
  const digest = await f.putFile("ghost release");
  await f.run(["--surface", "file", "--pin", digest, "--as", "op-g"]);
  // The operator removes the bytes by hand: the pin record outlives them,
  // and the release still names and drops exactly that pin.
  await rm(join(f.dir, "state", "vault", "test", digest));
  const out = await f.run([
    "--surface",
    "file",
    "--release",
    digest,
    "--pins",
    "op-g:operator",
    "--as",
    "op-g",
  ]);
  assert.equal(out.code, 0);
  const row = (await f.fileRows()).find((entry) => entry.digest === digest);
  assert.ok(row?.lifecycle);
  assert.ok(row.lifecycle.release);
  assert.equal(row.lifecycle.pin, undefined);
});

test("a release over bytes with no recorded evidence still refuses as protected", async (t) => {
  const f = await fixture(t);
  const digest = await f.putFile("unprotected bytes");
  await assert.rejects(
    f.run([
      "--surface",
      "file",
      "--release",
      digest,
      "--pins",
      "op-x:operator",
      "--as",
      "op-x",
    ]),
    /no recorded pin; a release cannot prove/,
  );
  assert.equal(
    (await f.fileRows()).find((entry) => entry.digest === digest)?.lifecycle,
    undefined,
  );
});

test("a halted transition prints its run before the refusal", async (t) => {
  const f = await fixture(t);
  const digest = await f.putFile("file only");
  await f.run(["--surface", "file", "--pin", digest, "--as", "op-r"]);
  const failure = await f
    .run(["--release", digest, "--pins", "op-r:operator", "--as", "op-r"])
    .then(
      () => null,
      (error: Error & { printed?: string[] }) => error,
    );
  assert.ok(failure);
  // The prose still composes what landed beside what refused.
  assert.match(
    failure.message,
    /file recorded; reserved: Recovery artifact is unavailable/,
  );
  // The machine contract carries the same truth as JSON on stdout, so the
  // landed half is reconcilable without a human reading stderr.
  const run = JSON.parse((failure.printed ?? []).join("\n")) as {
    digest: string;
    halves: { surface: string; outcome: string }[];
    refusals: string[];
  };
  assert.equal(run.digest, digest);
  assert.deepEqual(run.halves, [{ surface: "file", outcome: "recorded" }]);
  assert.deepEqual(
    run.refusals,
    ["reserved: Recovery artifact is unavailable; lifecycle was not recorded."],
  );
  const row = (await f.fileRows()).find((entry) => entry.digest === digest);
  assert.ok(row?.lifecycle?.release);
});

test("grammar refusals name what is missing", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run([]), /exactly one/);
  await assert.rejects(f.run(["--list", "--pin", "a".repeat(64)]), /exactly one/);
  await assert.rejects(f.run(["--pin", "nothex"]), /sha256/);
  await assert.rejects(f.run(["--pin", "a".repeat(64)]), /--as/);
  await assert.rejects(
    f.run(["--pin", "a".repeat(64), "--as", "op-a", "--kind", "custodian"]),
    /kind must be/,
  );
  await assert.rejects(
    f.run(["--release", "a".repeat(64), "--as", "op-a"]),
    /--pins/,
  );
  await assert.rejects(
    f.run(["--release", "a".repeat(64), "--as", "op-a", "--pins", "badformat"]),
    /--pins/,
  );
});

test("a mark lands where a store proves the digest and reports both halves", async (t) => {
  const f = await fixture(t);
  const fileDigest = await f.putFile("probe file value");
  const out = await f.run(["--pin", fileDigest, "--as", "op-p"]);
  // The digest only exists in the file store: the reserved half reports
  // its absence instead of refusing a protection the run recorded.
  assert.equal(out.code, 0);
  assert.deepEqual(out.json(), {
    surface: "both",
    digest: fileDigest,
    transition: "pinned",
    as: "op-p",
    halves: [
      { surface: "file", outcome: "recorded" },
      { surface: "reserved", outcome: "absent" },
    ],
  });
  const rows = await f.fileRows();
  assert.deepEqual(rows.find((row) => row.digest === fileDigest)?.lifecycle, {
    pin: { ownerId: "op-p", kind: "operator" },
  });
});

test("a half failure discloses what the run recorded before refusing", async (t) => {
  // The fixture vault persists a non-default capacity, and the config
  // states none: every CLI worker that reaches the reserved store is the
  // mismatched worker the contract refuses, which a real move repairs.
  const dir = await mkdtemp(join(tmpdir(), "nomo-recovery-retention-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { TEST_KEY: randomBytes(32).toString("base64") },
    config = join(dir, "nomo-recovery.json");
  await mkdir(join(dir, "project"), { recursive: true });
  await mkdir(join(dir, "state"), { recursive: true });
  await writeFile(
    config,
    JSON.stringify({
      workspace: "test",
      stateDir: "state",
      encryptionKeyEnv: "TEST_KEY",
      filesystem: { root: "project", cooperative: true },
    }),
  );
  await devKeyProvider({
    dir: join(dir, "state", "keys"),
    env: {},
    createIfMissing: true,
  });
  await reservedRecoveryVault(
    join(dir, "state", "vault"),
    { local: Buffer.from(env.TEST_KEY, "base64") },
    "local",
    { maxTotalBytes: 131072, maxArtifactBytes: 32768 },
  ).put("test", "seed");
  const reference = await localRecoveryVault(
    join(dir, "state", "vault"),
    { local: Buffer.from(env.TEST_KEY, "base64") },
    "local",
  ).put("test", "probe file value");
  const digest = reference.digest;
  const lines: string[] = [];
  await assert.rejects(
    runRecoveryCommand(
      ["retention", "--pin", digest, "--as", "op-p", "--config", config],
      env,
      (line) => lines.push(line),
    ),
    /file recorded; reserved: Vault worker states .* but the vault persists .{1,80}\./,
  );
});

test("a release keeps exact refusals for a digest no surface proves", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.run(["--release", "d".repeat(64), "--as", "op-r", "--pins", "op-r:operator"]),
    /Recovery artifact is unavailable/,
  );
});
