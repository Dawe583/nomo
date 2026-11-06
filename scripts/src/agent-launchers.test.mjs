import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

for (const [launcher, binary] of [
  ["scripts/nomo-omp.sh", "omp"],
  ["scripts/nomo-pi.sh", "pi"],
  ["scripts/nomo-prime-agent.sh", "prime-agent"],
]) {
  test(`${launcher} loads the shared contract and preserves arguments`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), "nomo-harness-launch-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const capture = join(dir, "args");
    const command = join(dir, binary);
    writeFileSync(command, '#!/bin/sh\nprintf "%s\\n" "$@" > "$NOMO_TEST_CAPTURE"\n');
    chmodSync(command, 0o755);
    const result = spawnSync("bash", [launcher, "test request"], {
      cwd: resolve("."),
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, NOMO_TEST_CAPTURE: capture },
    });
    assert.equal(result.status, 0, result.stderr);
    const args = readFileSync(capture, "utf8");
    const contract = ["AGENTS.md", "AGENTS.local.md", "docs/agent-contract.md"]
      .map((path) => readFileSync(path, "utf8").trim())
      .join("\n");
    assert.ok(args.includes(contract));
    assert.ok(args.includes("test request"));
    if (binary === "omp") {
      assert.ok(readFileSync(".omp/config.yml", "utf8").match(/approvalMode:\s*yolo/));
      for (const name of ["nomo-workflow", "nomo-pydantic"]) {
        assert.ok(args.includes(readFileSync(`.agents/skills/${name}/SKILL.md`, "utf8").trim()));
      }
    }
    if (binary === "prime-agent" || binary === "pi") {
      assert.ok(args.includes(".agents/skills/nomo-workflow/SKILL.md"));
      assert.ok(args.includes(".agents/skills/nomo-pydantic/SKILL.md"));
    }
    if (binary === "pi") assert.ok(args.includes("--approve"));
  });
}

test("Pi audit launcher restricts tools and rejects option injection", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nomo-pi-audit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const capture = join(dir, "args");
  const command = join(dir, "pi");
  writeFileSync(command, '#!/bin/sh\nprintf "%s\\n" "$@" > "$NOMO_TEST_CAPTURE"\n');
  chmodSync(command, 0o755);
  const options = { cwd: resolve("."), encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, NOMO_TEST_CAPTURE: capture } };
  const run = spawnSync("bash", ["scripts/nomo-pi-audit.sh", "Review this change"], options);
  assert.equal(run.status, 0, run.stderr);
  const args = readFileSync(capture, "utf8");
  assert.match(args, /--no-extensions/);
  assert.match(args, /--no-mcp/);
  assert.match(args, /--tools\nread,grep,find,ls/);
  assert.match(args, /Review this change/);
  const injected = spawnSync("bash", ["scripts/nomo-pi-audit.sh", "--extension", "/tmp/tool.js"], options);
  assert.notEqual(injected.status, 0);
});
