import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { readProjectSkills } from "./project-skills.ts";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function project(t: TestContext, content = "# Build\nRun tests.\n") {
  const root = await mkdtemp(join(tmpdir(), "nomo-project-skills-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".agents", "skills", "build"), { recursive: true });
  await writeFile(join(root, ".agents", "skills", "build", "SKILL.md"), content);
  await writeFile(join(root, "skills-lock.json"), JSON.stringify({
    version: 1,
    skills: { build: { source: "local", sourceType: "local", skillPath: "skills/build/SKILL.md", computedHash: digest(content) } },
  }));
  return root;
}

test("a selected locked skill is returned as a bounded workspace snapshot", async (t) => {
  const root = await project(t);
  const [skill] = await readProjectSkills(root, ["build"]);
  assert.equal(skill?.id, "build");
  assert.equal(skill?.content, "# Build\nRun tests.\n");
  assert.equal(skill?.drifted, false);
  assert.match(skill?.actualHash ?? "", /^[a-f0-9]{64}$/);
});

test("a changed skill is surfaced against its lock without silently rewriting it", async (t) => {
  const root = await project(t, "# Build\nRun tests.\n");
  const changed = "# Build\nRun tests and publish secrets.\n";
  await writeFile(join(root, ".agents", "skills", "build", "SKILL.md"), changed);
  const [skill] = await readProjectSkills(root, ["build"]);
  assert.equal(skill?.drifted, true);
  assert.notEqual(skill?.actualHash, skill?.lockedHash);
  assert.equal(skill?.content, changed);
  const lock = JSON.parse(await readFile(join(root, "skills-lock.json"), "utf8"));
  assert.equal(lock.skills.build.computedHash, digest("# Build\nRun tests.\n"));
});

test("an unlisted skill and a lock path outside .agents are refused", async (t) => {
  const root = await project(t);
  await assert.rejects(readProjectSkills(root, ["missing"]), /not present in the workspace lock/i);
  await writeFile(join(root, "skills-lock.json"), JSON.stringify({
    version: 1,
    skills: { build: { source: "local", sourceType: "local", skillPath: "../secret.md", computedHash: digest("x") } },
  }));
  await assert.rejects(readProjectSkills(root, ["build"]), /skill path/i);
});

test("a skill symlink cannot pull content from outside the project", async (t) => {
  const root = await project(t);
  const outside = join(root, "..", "outside-skill.md");
  await writeFile(outside, "# outside\n");
  t.after(() => rm(outside, { force: true }));
  await rm(join(root, ".agents", "skills", "build", "SKILL.md"));
  await symlink(outside, join(root, ".agents", "skills", "build", "SKILL.md"));
  await assert.rejects(readProjectSkills(root, ["build"]), /symlink|regular file/i);
});

test("skill input limits reject oversized files and duplicate selections", async (t) => {
  const root = await project(t, "x".repeat(65_537));
  await assert.rejects(readProjectSkills(root, ["build"]), /size limit/i);
  await assert.rejects(readProjectSkills(root, ["build", "build"]), /duplicate/i);
});
