import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import { runRecoveryCommand, type RecoveryMode } from "./recovery.ts";

/** A real workspace, a real config and a real retained key. Nothing is faked:
 * the mode is enforced by the same `authorize` path an operator hits. */
async function workspace(t: import("node:test").TestContext, mode?: RecoveryMode) {
  const dir = await mkdtemp(join(tmpdir(), "void-mode-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "project"));
  await writeFile(join(dir, "project", "notes.md"), "User original");
  const config = join(dir, "config.json");
  await writeFile(config, JSON.stringify({
    workspace: "test",
    stateDir: "state",
    encryptionKeyEnv: "TEST_KEY",
    filesystem: { root: "project", cooperative: true },
    ...(mode === undefined ? {} : { mode }),
  }));
  const input = join(dir, "input.json");
  await writeFile(input, JSON.stringify({
    workspace: "test",
    operationId: "op",
    runId: "run",
    agentId: "agent",
    adapterId: "filesystem.managed",
    arguments: { action: "write", path: "notes.md", base64: Buffer.from("Agent edit").toString("base64") },
  }));
  return { dir, config, input, env: { TEST_KEY: randomBytes(32).toString("base64") } };
}

const executeWith = (w: Awaited<ReturnType<typeof workspace>>, approve: boolean) => {
  let digest = "";
  return runRecoveryCommand(
    ["inspect", "--config", w.config, "--input", w.input],
    w.env,
    (s) => { digest = (JSON.parse(s) as { approvalDigest: string }).approvalDigest; },
  ).then(async () => runRecoveryCommand(
    ["execute", "--config", w.config, "--input", w.input, ...(approve ? ["--approve", digest] : [])],
    w.env,
    () => {},
  ));
};

test("the default mode is normal, so an unconfigured workspace behaves exactly as before", async (t) => {
  const w = await workspace(t, undefined);
  assert.equal(await executeWith(w, true), 0);
  assert.equal(await readFile(join(w.dir, "project", "notes.md"), "utf8"), "Agent edit");
});

test("plan mode refuses dispatch even with the exact approval digest", async (t) => {
  const w = await workspace(t, "plan");
  assert.equal(await executeWith(w, true), 1);
  assert.equal(
    await readFile(join(w.dir, "project", "notes.md"), "utf8"),
    "User original",
    "a restricted mode must leave the file exactly as it was",
  );
});

test("audit mode refuses dispatch too, and the mode is reported by health", async (t) => {
  const w = await workspace(t, "audit");
  assert.equal(await executeWith(w, true), 1);
  assert.equal(await readFile(join(w.dir, "project", "notes.md"), "utf8"), "User original");

  let health: Record<string, unknown> = {};
  await runRecoveryCommand(["health", "--config", w.config], w.env, (s) => { health = JSON.parse(s) as Record<string, unknown>; });
  assert.equal(health.mode, "audit", "an operator must be able to see the effective mode");
});

test("an unknown mode is refused rather than ignored", async (t) => {
  const w = await workspace(t, undefined);
  const config = JSON.parse(await readFile(w.config, "utf8")) as Record<string, unknown>;
  await writeFile(w.config, JSON.stringify({ ...config, mode: "loud" }));
  await assert.rejects(
    runRecoveryCommand(["health", "--config", w.config], w.env, () => {}),
    /Invalid recovery configuration/,
  );
});
