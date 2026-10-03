import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { runRecoveryCommand } from "./recovery.ts";

const posixTest = process.platform === "win32" ? test.skip : test;

posixTest("CLI accepts the exclusive relative Git configuration", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "void-cli-git-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "repo");
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.name", "VOID test"]);
  execFileSync("git", ["-C", root, "config", "user.email", "void@example.invalid"]);
  execFileSync("git", ["-C", root, "commit", "--allow-empty", "-qm", "initial"]);
  await writeFile(join(dir, "config.json"), JSON.stringify({ workspace: "test", stateDir: "state", encryptionKeyEnv: "KEY", git: { root: "repo", cooperative: true } }));
  await writeFile(join(dir, "input.json"), JSON.stringify({ workspace: "test", operationId: "op", runId: "run", agentId: "agent", adapterId: "git.managed", arguments: { action: "write", path: "file", base64: "" } }));
  const output: string[] = [];
  assert.equal(await runRecoveryCommand(["inspect", "--config", join(dir, "config.json"), "--input", join(dir, "input.json")], {}, (line) => output.push(line)), 0);
  assert.equal(JSON.parse(output[0]!).request.adapterId, "git.managed");
});


posixTest("CLI rejects malformed and nonexclusive Git configuration before target access", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "void-cli-git-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = join(dir, "input.json"), root = join(dir, "repo"), sentinel = join(root, "sentinel");
  execFileSync("git", ["init", "-q", root]); execFileSync("git", ["-C", root, "config", "user.name", "VOID test"]); execFileSync("git", ["-C", root, "config", "user.email", "void@example.invalid"]);
  await writeFile(sentinel, "unchanged"); execFileSync("git", ["-C", root, "add", "sentinel"]); execFileSync("git", ["-C", root, "commit", "-qm", "sentinel"]);
  await writeFile(input, JSON.stringify({ workspace: "test" }));
  const indexPath = execFileSync("git", ["-C", root, "rev-parse", "--git-path", "index"], { encoding: "utf8" }).trim();
  const unchanged = async () => ({ bytes: await import("node:fs/promises").then(({ readFile }) => readFile(sentinel)), index: await import("node:fs/promises").then(({ readFile }) => readFile(join(root, indexPath))) });
  const before = await unchanged();
  for (const git of [{ root: "", cooperative: true }, { root: "/tmp/repo", cooperative: true }, { root: "../repo", cooperative: true }, { root: "repo", cooperative: false }]) {
    const config = join(dir, `config-${Math.random()}.json`);
    await writeFile(config, JSON.stringify({ workspace: "test", stateDir: "state", encryptionKeyEnv: "KEY", git }));
    await assert.rejects(runRecoveryCommand(["inspect", "--config", config, "--input", input], {}), /git\.(root|cooperative)/, "the refusal must name the field that was refused");
    assert.deepEqual(await unchanged(), before);
  }
  for (const branches of [{}, { git: { root: "repo", cooperative: true }, filesystem: { root: "repo", cooperative: true } }, { git: { root: "repo", cooperative: true }, postgres: { schema: "x", tables: [], urlEnv: "URL" } }, { filesystem: { root: "repo", cooperative: true }, postgres: { schema: "x", tables: [], urlEnv: "URL" } }, { git: { root: "repo", cooperative: true }, filesystem: { root: "repo", cooperative: true }, postgres: { schema: "x", tables: [], urlEnv: "URL" } }]) {
    const config = join(dir, `branches-${Math.random()}.json`);
    await writeFile(config, JSON.stringify({ workspace: "test", stateDir: "state", encryptionKeyEnv: "KEY", ...branches }));
    await assert.rejects(runRecoveryCommand(["inspect", "--config", config, "--input", input], {}), /adapters? (is|are) configured/, "the refusal must say how many adapters were selected, not merely that it was invalid");
    assert.deepEqual(await unchanged(), before);
  }
});


posixTest("CLI worktree recovery round trip persists across fresh commands", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "void-cli-git-roundtrip-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "repo"), config = join(dir, "config.json"), input = join(dir, "input.json");
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.name", "VOID test"]);
  execFileSync("git", ["-C", root, "config", "user.email", "void@example.invalid"]);
  await writeFile(join(root, "file"), "before");
  execFileSync("git", ["-C", root, "add", "file"]); execFileSync("git", ["-C", root, "commit", "-qm", "initial"]);
  await writeFile(config, JSON.stringify({ workspace: "test", stateDir: "state", encryptionKeyEnv: "KEY", git: { root: "repo", cooperative: true } }));
  const request = { workspace: "test", operationId: "op", runId: "run", agentId: "agent", adapterId: "git.managed", arguments: { action: "write", path: "file", base64: Buffer.from("after").toString("base64") } };
  await writeFile(input, JSON.stringify(request));
  const env = { KEY: Buffer.alloc(32, 7).toString("base64") }, call = async (args: string[]) => { const lines: string[] = []; const code = await runRecoveryCommand(args, env, (line) => lines.push(line)); return { code, value: JSON.parse(lines[0]!) }; };
  const inspected = await call(["inspect", "--config", config, "--input", input]);
  assert.equal((await call(["execute", "--config", config, "--input", input, "--approve", inspected.value.approvalDigest])).code, 0);
  assert.equal(await import("node:fs/promises").then(({ readFile }) => readFile(join(root, "file"), "utf8")), "after");
  await writeFile(input, JSON.stringify({ workspace: "test", operationId: "op" }));
  const planned = await call(["plan", "--config", config, "--input", input]);
  await writeFile(input, JSON.stringify(planned.value));
  assert.equal((await call(["apply", "--config", config, "--input", input, "--approve", planned.value.digest])).code, 0);
  assert.equal((await call(["apply", "--config", config, "--input", input, "--approve", planned.value.digest])).code, 0);
  assert.equal(await import("node:fs/promises").then(({ readFile }) => readFile(join(root, "file"), "utf8")), "before");
  await writeFile(input, JSON.stringify({ workspace: "test", operationId: "op" }));
  assert.equal((await call(["reconcile-recovery", "--config", config, "--input", input])).value.status, "restored");
});


posixTest("CLI index recovery round trip restores staged entry and worktree bytes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "void-cli-git-index-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "repo"), config = join(dir, "config.json"), input = join(dir, "input.json");
  execFileSync("git", ["init", "-q", root]); execFileSync("git", ["-C", root, "config", "user.name", "VOID test"]); execFileSync("git", ["-C", root, "config", "user.email", "void@example.invalid"]);
  await writeFile(join(root, "file"), "before", { mode: 0o755 }); execFileSync("git", ["-C", root, "add", "file"]); execFileSync("git", ["-C", root, "commit", "-qm", "initial"]); await writeFile(join(root, "file"), "after", { mode: 0o755 });
  await writeFile(config, JSON.stringify({ workspace: "test", stateDir: "state", encryptionKeyEnv: "KEY", git: { root: "repo", cooperative: true } }));
  const env = { KEY: Buffer.alloc(32, 8).toString("base64") }, call = async (args: string[]) => { const lines: string[] = []; const code = await runRecoveryCommand(args, env, (line) => lines.push(line)); return { code, value: JSON.parse(lines[0]!) }; };
  await writeFile(input, JSON.stringify({ workspace: "test", operationId: "stage", runId: "run", agentId: "agent", adapterId: "git.managed", arguments: { action: "stage", path: "file" } }));
  const inspected = await call(["inspect", "--config", config, "--input", input]); await call(["execute", "--config", config, "--input", input, "--approve", inspected.value.approvalDigest]);
  assert.equal(execFileSync("git", ["-C", root, "show", ":file"], { encoding: "utf8" }), "after");
  await writeFile(input, JSON.stringify({ workspace: "test", operationId: "stage" })); const plan = await call(["plan", "--config", config, "--input", input]); await writeFile(input, JSON.stringify(plan.value)); await call(["apply", "--config", config, "--input", input, "--approve", plan.value.digest]);
  assert.equal(execFileSync("git", ["-C", root, "show", ":file"], { encoding: "utf8" }), "before");
  assert.equal(await import("node:fs/promises").then(({ readFile }) => readFile(join(root, "file"), "utf8")), "after");
});
