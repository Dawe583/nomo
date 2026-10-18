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
import { reservedRecoveryVault } from "../../runtime/src/index.ts";
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
    const digest = createHash("sha256")
      .update(Buffer.from(value, "utf8"))
      .digest("hex");
    // The health reader walks this namespace and asserts the modes its
    // writers leave behind, so the fixture writes what a legacy writer
    // writes: a 0700 directory and 0600 artifacts.
    await mkdir(join(dir, "state", "vault", "test"), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(join(dir, "state", "vault", "test", digest), Buffer.from(value), {
      mode: 0o600,
    });
    return digest;
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
      const code = await runRecoveryCommand(
        ["retention", ...argv, "--config", config],
        env,
        (line) => lines.push(line),
      );
      return { code, json: () => JSON.parse(lines.join("\n")) as unknown };
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

test("a mark of an absent artifact refuses where the store cannot prove it", async (t) => {
  const f = await fixture(t);
  await f.putReserved("reserved only");
  const missing = createHash("sha256").update(Buffer.from("ghost")).digest("hex");
  // The file half has no such artifact, so a default both-surface pin must
  // refuse loudly rather than pretend both stores were protected.
  await assert.rejects(
    f.run(["--pin", missing, "--as", "op-a"]),
    /unavailable/,
  );
  await assert.rejects(
    f.run(["--surface", "reserved", "--pin", missing, "--as", "op-a"]),
    /unavailable/,
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
