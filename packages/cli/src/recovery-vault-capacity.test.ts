import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { runRecoveryCommand } from "./recovery.ts";
import { reservedRecoveryVault } from "../../runtime/src/index.ts";
import { devKeyProvider } from "../../ledger/src/sign.ts";
import type { VaultCapacity } from "../../runtime/src/reserved-vault.ts";

const fixture = async (
  t: { after: (fn: () => unknown) => void },
  persisted: VaultCapacity,
) => {
  const dir = await mkdtemp(join(tmpdir(), "nomo-recovery-capacity-"));
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
  // The persisted capacity is what an earlier writer left behind, not what
  // the config says: the fixture writes a real vault at the capacity each
  // test states, so a move has something honest to compare against.
  const vault = reservedRecoveryVault(
    join(dir, "state", "vault"),
    { local: Buffer.from(env.TEST_KEY, "base64") },
    "local",
    persisted,
  );
  return {
    dir,
    env,
    config,
    vault,
    run: async (argv: readonly string[]) => {
      const lines: string[] = [];
      const code = await runRecoveryCommand(
        ["vault-capacity", ...argv, "--config", config],
        env,
        (line) => lines.push(line),
      );
      return { code, json: () => JSON.parse(lines.join("\n")) as unknown };
    },
  };
};

const SMALL: VaultCapacity = { maxTotalBytes: 256, maxArtifactBytes: 64 };

test("an operator move commits the ceiling and its migration row", async (t) => {
  const f = await fixture(t, SMALL);
  await f.vault.put("test", "probe artifact");
  const out = await f.run([
    "--from",
    "256:64",
    "--to",
    "512:128",
    "--as",
    "op-a",
  ]);
  assert.equal(out.code, 0);
  // The quota counts the vault's shelf, not the plaintext: the stored
  // canonical value plus the GCM expansion, both documented fixed forms, is
  // what the report must measure.
  const stored = JSON.stringify("probe artifact").length + 28;
  assert.deepEqual(out.json(), {
    from: { maxTotalBytes: 256, maxArtifactBytes: 64 },
    to: { maxTotalBytes: 512, maxArtifactBytes: 128 },
    usedBytes: stored,
    reservations: 0,
  });
  // The strongest proof the move happened: a worker built at the new ceiling
  // accepts writes while a worker still built at the old one is rejected.
  const moved = reservedRecoveryVault(
    join(f.dir, "state", "vault"),
    { local: Buffer.from(f.env.TEST_KEY, "base64") },
    "local",
    { maxTotalBytes: 512, maxArtifactBytes: 128 },
  );
  await moved.put("test", "fits the moved ceiling");
  await assert.rejects(
    f.vault.put("test", "refused by the old worker"),
    /Vault capacity differs from its persisted configuration\./,
  );
});

test("a stale belief about the held capacity refuses and moves nothing", async (t) => {
  const f = await fixture(t, SMALL);
  await f.vault.put("test", "probe artifact");
  await assert.rejects(
    f.run(["--from", "999:64", "--to", "512:128", "--as", "op-a"]),
    /does not match the capacity the vault holds/,
  );
  // The compare-and-swap ran in one transaction that never updated the
  // settings row, so the old worker still writes.
  await f.vault.put("test", "the old worker persists");
});

test("a move below the bytes already stored refuses with the count", async (t) => {
  const f = await fixture(t, SMALL);
  await f.vault.put("test", "probe artifact");
  // The refusal names the ciphertext bytes the vault really holds, so the
  // assertion computes what the store would count, 16 quoted plus the GCM
  // expansion, and states a ceiling below that.
  const held = JSON.stringify("probe artifact").length + 28;
  assert.ok(held < 256);
  await assert.rejects(
    f.run(["--from", "256:64", "--to", `${held - 1}:64`, "--as", "op-a"]),
    new RegExp(
      `cannot lower the total below the ${held} bytes the vault holds`,
    ),
  );
});

test("grammar refusals name what is missing", async (t) => {
  const f = await fixture(t, SMALL);
  await assert.rejects(f.run(["--to", "512:128", "--as", "op-a"]), /--from/);
  await assert.rejects(
    f.run(["--from", "256", "--to", "512:128", "--as", "op-a"]),
    /<maxTotalBytes>:<maxArtifactBytes>/,
  );
  await assert.rejects(
    f.run(["--from", "256:64", "--to", "0:128", "--as", "op-a"]),
    /positive integers/,
  );
  await assert.rejects(
    f.run(["--from", "256:64", "--to", "512:128"]),
    /--as <id>/,
  );
});
