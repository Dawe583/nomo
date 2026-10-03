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
  const dir = await mkdtemp(join(tmpdir(), "void-recovery-doctor-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "void-recovery.json");
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
  assert.match(message, /void recovery conformance --adapter filesystem\.managed/);
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
  assert.match(text, /field adapters: 1 entry \(ignored, not read by void recovery\)/);
  assert.match(text, /field vault: block with 1 field\(s\) \(ignored/);
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

test("doctor never prints the encryption key, only the variable that holds it", async (t) => {
  const path = await fixture(t, {
    workspace: "dogfood",
    stateDir: "state",
    encryptionKeyEnv: "VOID_VAULT_KEY",
    filesystem: { root: "project", cooperative: true },
  });

  const { lines } = await doctor(path);
  const text = lines.join("\n");

  assert.match(text, /field encryptionKeyEnv: VOID_VAULT_KEY \(config,/);
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

test("a missing workspace field is named rather than summed into one verdict", async (t) => {
  const path = await fixture(t, {
    stateDir: "state",
    encryptionKeyEnv: "KEY",
    postgres: { schema: "void", tables: [], urlEnv: "URL" },
  });
  const message = await inspect(path);

  assert.match(message, /workspace is required/);
  assert.doesNotMatch(message, /conformance --adapter/);
});