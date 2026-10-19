import assert from "node:assert/strict";
import { watch } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  canonicalProjectRoot,
  parseProjectCommand,
  projectSandboxConfig,
  runProjectCommand,
} from "./project-sandbox.ts";

const image = process.env.NOMO_PROJECT_SANDBOX_IMAGE;
const runtime = process.env.NOMO_PROJECT_SANDBOX_RUNTIME;

async function project(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "nomo-project-sandbox-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("project root must resolve to a directory", async (t) => {
  const root = await project(t);
  const file = join(root, "not-a-project");
  await writeFile(file, "file");
  await assert.rejects(canonicalProjectRoot(file), /must be a directory/i);
  await assert.doesNotReject(canonicalProjectRoot(root));
});

test("project command accepts one bounded command and rejects extra authority", () => {
  assert.deepEqual(parseProjectCommand({ command: "git status --short" }), {
    command: "git status --short",
  });
  assert.throws(() => parseProjectCommand({ command: " " }), /non-empty/i);
  assert.throws(() => parseProjectCommand({ command: "echo ok", cwd: "/" }), /unexpected/i);
  assert.throws(() => parseProjectCommand({ command: "x".repeat(16_385) }), /size limit/i);
  assert.throws(() => parseProjectCommand({ command: "echo\u0000bad" }), /control/i);
});

test("sandbox requires an explicit supported runtime and immutable local image id", () => {
  assert.throws(
    () => projectSandboxConfig({ NOMO_PROJECT_SANDBOX_RUNTIME: "docker" }),
    /image/i,
  );
  assert.throws(
    () => projectSandboxConfig({
      NOMO_PROJECT_SANDBOX_RUNTIME: "host",
      NOMO_PROJECT_SANDBOX_IMAGE: "sha256:" + "a".repeat(64),
    }),
    /runtime/i,
  );
  assert.throws(
    () => projectSandboxConfig({
      NOMO_PROJECT_SANDBOX_RUNTIME: "docker",
      NOMO_PROJECT_SANDBOX_IMAGE: "node:24",
    }),
    /sha256/i,
  );
});

test("project sandbox refuses root before starting the runtime", async (t) => {
  if (!process.getuid || !process.getgid) {
    t.skip("requires POSIX user and group IDs");
    return;
  }
  const root = await project(t);
  const emptyBin = join(root, "empty-bin");
  await mkdir(emptyBin);
  const originalPath = process.env.PATH;
  const originalGetuid = process.getuid;
  const originalGetgid = process.getgid;
  process.env.PATH = emptyBin;
  process.getuid = () => 0;
  process.getgid = () => 0;
  try {
    await assert.rejects(
      runProjectCommand({
        projectRoot: root,
        command: "true",
        config: projectSandboxConfig({
          NOMO_PROJECT_SANDBOX_RUNTIME: "docker",
          NOMO_PROJECT_SANDBOX_IMAGE: `sha256:${"a".repeat(64)}`,
        }),
        timeoutMs: 1_000,
      }),
      /must not run as root/i,
    );
  } finally {
    process.getuid = originalGetuid;
    process.getgid = originalGetgid;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});

test("aborting container creation still removes a possibly created container", async (t) => {
  if (!process.getuid || !process.getgid) {
    t.skip("requires POSIX user and group IDs");
    return;
  }
  const root = await project(t);
  const bin = join(root, "bin");
  const runtimeLog = join(root, "runtime.jsonl");
  await mkdir(bin);
  await writeFile(runtimeLog, "");
  const runner = join(root, "fake-runtime.mjs");
  const runtime = join(bin, "docker");
  await writeFile(
    runner,
    `import { appendFileSync, watch } from "node:fs";
const args = process.argv.slice(2);
const log = process.env.NOMO_FAKE_RUNTIME_LOG;
if (!log) process.exit(2);
appendFileSync(log, JSON.stringify(args) + "\\n");
if (args[0] === "create") {
  process.stdout.write("${"a".repeat(64)}\\n");
  watch(log);
}
`,
  );
  const quotedNode = process.execPath.replaceAll("'", "'\\''");
  await writeFile(
    runtime,
    `#!/bin/sh
exec '${quotedNode}' '${runner}' "$@"
`,
    { mode: 0o755 },
  );
  const runtimeWatcher = watch(runtimeLog);
  const runtimeStarted = new Promise<void>((resolve, reject) => {
    runtimeWatcher.once("change", resolve);
    runtimeWatcher.once("error", reject);
  });

  const previousPath = process.env.PATH;
  const previousLog = process.env.NOMO_FAKE_RUNTIME_LOG;
  const originalGetuid = process.getuid;
  const originalGetgid = process.getgid;
  const controller = new AbortController();
  process.env.PATH = bin;
  process.env.NOMO_FAKE_RUNTIME_LOG = runtimeLog;
  process.getuid = () => 1000;
  process.getgid = () => 1000;
  const running = runProjectCommand({
    projectRoot: root,
    command: "true",
    config: projectSandboxConfig({
      NOMO_PROJECT_SANDBOX_RUNTIME: "docker",
      NOMO_PROJECT_SANDBOX_IMAGE: `sha256:${"a".repeat(64)}`,
    }),
    timeoutMs: 1_000,
    signal: controller.signal,
  });
  try {
    await Promise.race([
      runtimeStarted,
      running.then(() => {
        throw new Error("The fake runtime ended before it started creation.");
      }),
    ]);
    controller.abort();
    await assert.rejects(running, /could not run the command|cleanup failed/i);
    const commands = (await readFile(runtimeLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(commands.length, 2);
    const [create, cleanup] = commands as [string[], string[]];
    assert.equal(create[0], "create");
    assert.equal(cleanup[0], "rm");
    assert.equal(cleanup[2], create[create.indexOf("--name") + 1]);
  } finally {
    controller.abort();
    await running.catch(() => undefined);
    runtimeWatcher.close();
    process.getuid = originalGetuid;
    process.getgid = originalGetgid;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousLog === undefined) delete process.env.NOMO_FAKE_RUNTIME_LOG;
    else process.env.NOMO_FAKE_RUNTIME_LOG = previousLog;
  }
});

test("a configured container enforces isolation and bounds output and runtime", {
  skip: !runtime || !image,
}, async (t) => {
  const root = await project(t);
  const previous = process.env.NOMO_PROJECT_TEST_SECRET;
  process.env.NOMO_PROJECT_TEST_SECRET = "must-not-enter-container";
  try {
    const config = projectSandboxConfig({
      NOMO_PROJECT_SANDBOX_RUNTIME: runtime,
      NOMO_PROJECT_SANDBOX_IMAGE: image,
    });
    const command = [
      "printf inside > marker.txt",
      "printf 'sandbox-output\\n'",
      "test \"$(id -u)\" -ne 0",
      "test ! -w /etc",
      "test ! -S /var/run/docker.sock",
      "test -z \"${NOMO_PROJECT_TEST_SECRET-}\"",
      "node -e 'fetch(\"https://example.com\", { signal: AbortSignal.timeout(1500) }).then(() => process.exit(18), () => process.exit(0))'",
    ].join(" && ");
    const result = await runProjectCommand({
      projectRoot: root,
      command,
      config,
      timeoutMs: 20_000,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.timedOut, false);
    assert.equal(await readFile(join(root, "marker.txt"), "utf8"), "inside");
    assert.match(result.stdout, /sandbox-output/);

    const failed = await runProjectCommand({
      projectRoot: root,
      command: "exit 17",
      config,
      timeoutMs: 20_000,
    });
    assert.equal(failed.exitCode, 17);

    const outputLimit = await runProjectCommand({
      projectRoot: root,
      command: "yes x | head -c 40000",
      config,
      timeoutMs: 20_000,
    });
    assert.equal(outputLimit.outputTruncated, true);
    assert.ok(Buffer.byteLength(outputLimit.stdout) <= 32_768);

    const timeout = await runProjectCommand({
      projectRoot: root,
      command: "sleep 10",
      config,
      timeoutMs: 500,
    });
    assert.equal(timeout.timedOut, true);
    assert.notEqual(timeout.exitCode, 0);
  } finally {
    if (previous === undefined) delete process.env.NOMO_PROJECT_TEST_SECRET;
    else process.env.NOMO_PROJECT_TEST_SECRET = previous;
  }
});
