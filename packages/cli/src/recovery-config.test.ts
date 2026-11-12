/**
 * `Invalid recovery configuration.` was the whole of the diagnosis an operator
 * got. These tests pin what replaced it: a named field, a named adapter, and a
 * pointer at the command that does run the adapter the operator had in mind.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runRecoveryCommand } from "./recovery.ts";

const fixture = async (
  t: { after: (fn: () => unknown) => void },
  config: unknown,
): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "nomo-recovery-doctor-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "nomo-recovery.json");
  await writeFile(path, JSON.stringify(config));
  return path;
};

const inspect = async (path: string): Promise<string> => {
  try {
    await runRecoveryCommand(["inspect", "--config", path], {}, () => {});
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return assert.fail("inspect accepted a configuration it should have refused");
};

const doctor = async (
  path: string,
): Promise<{ code: number; lines: string[] }> => {
  const lines: string[] = [];
  const code = await runRecoveryCommand(["doctor", "--config", path], {}, (line) =>
    lines.push(line),
  );
  return { code, lines };
};

/** The shape from issue #62: the managed-executor config with an adapter list. */
const filesystemShaped = {
  schema: "void.managed-recovery.v1",
  workspace: "dogfood",
  vault: { dir: "/tmp/vd2/vault" },
  journal: { dir: "/tmp/vd2/journal" },
  adapters: [
    { id: "filesystem.managed", kind: "filesystem", roots: ["/tmp/vd2"] },
  ],
};

test("a filesystem-shaped config names the adapter and points at the command that runs it", async (t) => {
  const path = await fixture(t, filesystemShaped);

  const message = await inspect(path);

  assert.match(message, /filesystem\.managed/);
  assert.match(message, /nomo recovery conformance --adapter filesystem\.managed/);
  assert.match(message, /adapters/);
  // The specific reason is still there, not merely a longer sentence.
  assert.match(message, /stateDir is required/);
});

test("an unsupported adapter is distinguished from a malformed field", async (t) => {
  const path = await fixture(t, filesystemShaped);
  const usable = await fixture(t, {
    workspace: "dogfood",
    stateDir: "state",
    encryptionKeyEnv: "KEY",
    mode: "loud",
    filesystem: { root: "project", cooperative: true },
  });

  const unsupported = await inspect(path);
  const malformed = await inspect(usable);

  assert.notEqual(unsupported, malformed);
  assert.match(unsupported, /not a field this command reads/);
  assert.match(malformed, /mode is "loud"/);
  assert.doesNotMatch(malformed, /conformance --adapter/);
});

test("doctor lists what was read, what was required and missing, and what is ignored", async (t) => {
  const path = await fixture(t, filesystemShaped);

  const { code, lines } = await doctor(path);
  const text = lines.join("\n");

  assert.equal(code, 1);
  assert.match(text, /field workspace: dogfood \(config\)/);
  assert.match(text, /field stateDir: \(absent\) \(required, not found\)/);
  assert.match(text, /field adapters: \(not shown\) \(ignored, not read by nomo recovery; value omitted\)/);
  assert.match(text, /field vault: \(not shown\) \(ignored/);
  assert.doesNotMatch(text, /\/tmp\/vd2/);
  assert.match(text, /problem: /);
  assert.match(text, /configuration: not usable/);
});

test("doctor reports a usable configuration without refusing it", async (t) => {
  const path = await fixture(t, {
    workspace: "dogfood",
    stateDir: "state",
    encryptionKeyEnv: "KEY",
    filesystem: { root: "project", cooperative: true },
  });

  const { code, lines } = await doctor(path);

  assert.equal(code, 0);
  assert.match(lines.join("\n"), /configuration: usable/);
  assert.match(lines.join("\n"), /adapters configured: filesystem/);
});

test("doctor names a malformed vaultCapacity before any executor opens the vault", async (t) => {
  const path = await fixture(t, {
    workspace: "dogfood",
    stateDir: "state",
    encryptionKeyEnv: "KEY",
    vaultCapacity: { maxTotalBytes: "1GiB", maxArtifactBytes: 1024 },
    filesystem: { root: "project", cooperative: true },
  });

  const { code, lines } = await doctor(path);
  const text = lines.join("\n");

  assert.equal(code, 1);
  assert.match(text, /problem: vaultCapacity\.maxTotalBytes is 1GiB/);
  assert.match(text, /it must be a whole number from 1 to/);
});

test("a whole-number vaultCapacity is usable and a zero maxArtifactBytes is refused by name", async (t) => {
  const usable = await fixture(t, {
    workspace: "dogfood",
    stateDir: "state",
    encryptionKeyEnv: "KEY",
    vaultCapacity: { maxTotalBytes: 3156, maxArtifactBytes: 1024 },
    filesystem: { root: "project", cooperative: true },
  });
  const zero = await fixture(t, {
    workspace: "dogfood",
    stateDir: "state",
    encryptionKeyEnv: "KEY",
    vaultCapacity: { maxTotalBytes: 3156, maxArtifactBytes: 0 },
    filesystem: { root: "project", cooperative: true },
  });

  const ok = await doctor(usable);
  assert.equal(ok.code, 0);
  assert.match(ok.lines.join("\n"), /configuration: usable/);

  const refused = await doctor(zero);
  assert.equal(refused.code, 1);
  assert.match(
    refused.lines.join("\n"),
    /vaultCapacity\.maxArtifactBytes is 0/,
  );
});

test("doctor never prints the encryption key, only the variable that holds it", async (t) => {
  const path = await fixture(t, {
    workspace: "dogfood",
    stateDir: "state",
    encryptionKeyEnv: "NOMO_VAULT_KEY",
    filesystem: { root: "project", cooperative: true },
  });

  const { lines } = await doctor(path);
  const text = lines.join("\n");

  assert.match(text, /field encryptionKeyEnv: NOMO_VAULT_KEY \(config,/);
  // The report names the variable and says where the key itself lives: a
  // diagnostic that echoed a key would be the defect, not the fix.
  assert.match(text, /the key itself is never in this file/);
  assert.doesNotMatch(text, /BEGIN PRIVATE KEY/);
});

test("a filesystem root is refused by name the way a git root always was", async (t) => {
  const path = await fixture(t, {
    workspace: "dogfood",
    stateDir: "state",
    encryptionKeyEnv: "KEY",
    filesystem: { root: "../elsewhere", cooperative: true },
  });

  const message = await inspect(path);

  assert.match(message, /filesystem\.root holds "\.\."/);
  assert.match(message, /stays inside the workspace/);
});
test("a leading ./ on a root is accepted, because it is not a traversal", async (t) => {
  // The shape the Python transport fixture writes, and the shape any operator
  // writes when they mean "this directory, relative to the config file". It is
  // not a traversal, and refusing it broke `python/nomo-transport` outright:
  // the relay could not start, so nine integration tests never ran and the
  // suite reported 75 passing instead of 84.
  const path = await fixture(t, {
    workspace: "dogfood",
    stateDir: "./state",
    encryptionKeyEnv: "KEY",
    filesystem: { root: "./workspace", cooperative: true },
  });

  const report = await doctor(path);
  assert.equal(report.code, 0, report.lines.join("\n"));
  assert.match(report.lines.join("\n"), /configuration: usable/);
  assert.doesNotMatch(await inspect(path), /filesystem\.root/);
});

test("a traversal inside the root is still refused after the leading ./ is normalised", async (t) => {
  // The normalisation must not become a hole: `./a/../../b` still walks out.
  const path = await fixture(t, {
    workspace: "dogfood",
    stateDir: "./state",
    encryptionKeyEnv: "KEY",
    filesystem: { root: "./a/../../b", cooperative: true },
  });

  const message = await inspect(path);

  assert.match(message, /filesystem\.root holds "\.\."/);
  assert.match(message, /stays inside the workspace/);
});


test("a missing workspace field is named rather than summed into one verdict", async (t) => {
  const path = await fixture(t, {
    stateDir: "state",
    encryptionKeyEnv: "KEY",
    postgres: { schema: "nomo", tables: [], urlEnv: "URL" },
  });
  const message = await inspect(path);

  assert.match(message, /workspace is required/);
  assert.doesNotMatch(message, /conformance --adapter/);
});
