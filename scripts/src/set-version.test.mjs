/**
 * The version setter, run as a release runs it.
 *
 * The defect this closes was a version literal repeated in thirteen manifests
 * with a gate pinning the literal, so the first bump broke the release gate
 * instead of the release. What has to hold afterwards is that one argument moves
 * every manifest together, that nothing else in a manifest moves with it, and
 * that a wrong argument is refused before a single file is touched.
 *
 * The tests drive the real script as a process, not the exported functions,
 * because the exit code and the refusal are the interface a release uses. The
 * script locates the tree it belongs to from its own path, so a copy of it in a
 * temporary tree is a release of that tree: no root flag, no test-only mode, and
 * the working copy of this repository is never written to.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");
const script = join(root, "scripts", "src", "set-version.mjs");

/**
 * A tree shaped like this one: the workspace root, two packages, the control
 * plane and the scripts directory, so the derivation under test is exercised
 * rather than restated.
 *
 * The manifests deliberately differ from each other, because the failure this
 * guards against is a setter that re-serialises JSON: four-space indentation, a
 * version that is not the third key, a nested `version` key that must not be
 * touched, and one manifest with no trailing newline.
 */
function fixture() {
  const tree = mkdtempSync(join(tmpdir(), "nomo-set-version-"));
  const manifests = {
    "package.json": `{
  "name": "@void/workspace",
  "version": "0.1.0",
  "private": true,
  "scripts": { "test": "node --test" }
}
`,
    "packages/cli/package.json": `{
    "name": "@void/cli",
    "private": true,
    "license": "Apache-2.0",
    "version": "0.1.0",
    "dependencies": {
        "@nomo/registry": { "version": "0.1.0", "note": "a nested version is not the product version" }
    }
}
`,
    "packages/verifier/package.json": `{
  "name": "@void/verifier",
  "description": "Offline verifier, node built-ins only.",
  "version": "0.1.0",
  "bin": { "nomo-verify": "verify-ledger.mjs" }
}`,
    "apps/control-plane/package.json": `{
  "name": "@void/control-plane-api",
  "version": "0.1.0",
  "private": true
}
`,
    "scripts/package.json": `{
  "name": "@void/scripts",
  "version": "0.1.0",
  "private": true
}
`,
  };
  for (const [path, text] of Object.entries(manifests)) {
    const target = join(tree, path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, text);
  }
  // A package root with no manifest in it, which is what packages/security-notes.md
  // is in this repository, must not be mistaken for a package.
  mkdirSync(join(tree, "packages", "notes"), { recursive: true });
  writeFileSync(join(tree, "packages", "notes", "README.md"), "not a manifest\n");
  const installed = join(tree, "scripts", "src", "set-version.mjs");
  mkdirSync(join(installed, ".."), { recursive: true });
  copyFileSync(script, installed);
  return { tree, installed, manifests };
}

const setVersion = (tree, ...argv) =>
  spawnSync(process.execPath, [join(tree, "scripts", "src", "set-version.mjs"), ...argv], {
    encoding: "utf8",
    timeout: 30_000,
  });

/** Every file in the tree, as path to bytes, so an untouched tree is provable. */
function snapshot(tree) {
  const files = {};
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else files[relative(tree, path)] = readFileSync(path, "utf8");
    }
  };
  walk(tree);
  return files;
}

test("one argument moves every manifest the gate enumerates, and nothing else", (t) => {
  const { tree, manifests } = fixture();
  t.after(() => rmSync(tree, { recursive: true, force: true }));
  const before = snapshot(tree);

  const ran = setVersion(tree, "0.2.0");
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(ran.stdout.trim(), "set 5 manifests to 0.2.0");

  for (const path of Object.keys(manifests)) {
    const after = readFileSync(join(tree, path), "utf8");
    // The only difference is the version line: same bytes, same key order,
    // same indentation, same absence of a trailing newline.
    const changed = after
      .split("\n")
      .filter((line, index) => line !== before[path].split("\n")[index]);
    assert.equal(changed.length, 1, `${path} changed more than its version line`);
    assert.match(changed[0], /^\s*"version": "0\.2\.0",?$/);
    assert.equal(after.replace(/^(\s*)"version": "[^"]*"/m, '$1"version": "0.1.0"'), before[path]);
    // And the result is still the manifest it was, not a reserialisation of it.
    assert.equal(JSON.parse(after).name, JSON.parse(before[path]).name);
  }
  // A package root with no manifest is not a manifest, so it is not reported.
  assert.equal(JSON.parse(readFileSync(join(tree, "packages/cli/package.json"), "utf8")).dependencies["@nomo/registry"].version, "0.1.0");
  assert.equal(snapshot(tree)["packages/notes/README.md"], before["packages/notes/README.md"]);
  // The write goes through a temporary file, so one left behind is the visible
  // evidence that the rename path did not run.
  assert.deepEqual(
    Object.keys(snapshot(tree)).filter((path) => path.includes("set-version")),
    ["scripts/src/set-version.mjs"],
    "the atomic write left a temporary file in the tree",
  );
});

test("setting the version a tree already carries writes nothing", (t) => {
  const { tree, manifests } = fixture();
  t.after(() => rmSync(tree, { recursive: true, force: true }));
  assert.equal(setVersion(tree, "0.1.0").status, 0);

  const before = snapshot(tree);
  const again = setVersion(tree, "0.1.0");
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stdout.trim(), "every manifest already at 0.1.0");
  assert.deepEqual(snapshot(tree), before, "a second run rewrote files that already held the version");
  assert.equal(Object.keys(before).length, Object.keys(manifests).length + 2);
});

test("--check is green, then red, then green, and never writes", (t) => {
  const { tree } = fixture();
  t.after(() => rmSync(tree, { recursive: true, force: true }));

  const green = setVersion(tree, "0.1.0", "--check");
  assert.equal(green.status, 0, green.stderr);
  assert.equal(green.stdout.trim(), "every manifest is at 0.1.0");
  const before = snapshot(tree);

  // The red case is a bumped manifest that the gate would reject: the check has
  // to name the file, because a release engineer reads the name, not the count.
  writeFileSync(join(tree, "packages/cli/package.json"), readFileSync(join(tree, "packages/cli/package.json"), "utf8").replace('"version": "0.1.0",', '"version": "0.1.1",'));
  const red = setVersion(tree, "0.1.0", "--check");
  assert.equal(red.status, 1);
  assert.match(red.stderr, /packages\/cli\/package\.json is at 0\.1\.1, not 0\.1\.0/);
  assert.deepEqual(snapshot(tree), { ...before, "packages/cli/package.json": readFileSync(join(tree, "packages/cli/package.json"), "utf8") }, "--check wrote to the tree");

  assert.equal(setVersion(tree, "0.2.0").status, 0);
  const greenAgain = setVersion(tree, "0.2.0", "--check");
  assert.equal(greenAgain.status, 0, greenAgain.stderr);
  assert.equal(greenAgain.stdout.trim(), "every manifest is at 0.2.0");
});

test("an argument that is not three numeric parts is refused before anything is written", (t) => {
  const { tree } = fixture();
  t.after(() => rmSync(tree, { recursive: true, force: true }));
  const before = snapshot(tree);

  for (const argument of ["v0.2.0", "0.2", "0.2.0-rc.1", "^0.2.0", "0.2.x", "latest", "01.2.3", "0.2.0 0.3.0", "--force", ""]) {
    const ran = setVersion(tree, argument);
    assert.equal(ran.status, 2, `${JSON.stringify(argument)} was not refused`);
    assert.match(ran.stderr, /^usage: node scripts\/src\/set-version\.mjs X\.Y\.Z \[--check\]$/m);
    assert.equal(ran.stdout, "", `${JSON.stringify(argument)} printed to stdout`);
    assert.deepEqual(snapshot(tree), before, `${JSON.stringify(argument)} touched a file`);
  }
  // No version and no --check is a usage error too: a bare invocation has to say
  // what it wants rather than quietly rewrite the tree to what it already holds.
  const bare = setVersion(tree);
  assert.equal(bare.status, 2);
  assert.deepEqual(snapshot(tree), before);
});

test("this repository's own manifests are coherent with its root manifest", () => {
  const ran = spawnSync(process.execPath, [script, "--check"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, /^every manifest is at \d+\.\d+\.\d+$/m);
});
