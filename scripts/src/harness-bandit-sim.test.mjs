import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { simulate } from "./harness-bandit-sim.mjs";

const script = fileURLToPath(new URL("./harness-bandit-sim.mjs", import.meta.url));

test("the simulation prefers the better arm and reports samples, regret and the stop reason", () => {
  const report = simulate({ budgetTokens: 200000, seed: 7 });
  assert.equal(report.state.stopReason, "separated");
  assert.ok(report.state.arms[0].samples > report.state.arms[1].samples);
  assert.ok(report.regret > 0);

  const run = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /arm\s+samples\s+rate\s+simple-regret/);
  assert.match(run.stdout, /compaction-75\s+\d+\s+0\.80\s+0\.00/);
  assert.match(run.stdout, /regret=\d+\.\d+ spentTokens=\d+ budgetTokens=200000 stop=separated/);
});

test("usage errors are nonzero and no simulation output is printed", () => {
  const run = spawnSync(process.execPath, [script, "--bogus"], { encoding: "utf8" });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /usage: node scripts\/src\/harness-bandit-sim\.mjs/);
});
