import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { REGISTRY_DISCLAIMER } from "../../packages/registry/src/index.ts";

/**
 * DECISIONS section 5 as a gate.
 *
 * The licence line is the commercial structure of the product, and a structure
 * that lives only in a decision log decays quietly. This asserts the parts that
 * can be checked mechanically, and it asserts one trap that is otherwise waiting
 * to be sprung.
 *
 * The trap: every package here is marked `private: true`, so nothing can be
 * published, and DECISIONS 5 rests its entire distribution argument on the
 * packages being installable without a sales call. Flipping that flag is the
 * obvious next move and it is also the wrong one. Nine of the packages point
 * `exports` at TypeScript source and none of the twelve has a build script, so
 * publishing them would ship source that Node cannot run. The check below refuses
 * any package that claims to be publishable without a build, which turns "someone
 * flipped the flag" into a failed test rather than a broken release.
 */

const ROOT = "packages";

/**
 * Directories that are the closed, paid side and carry their own licence.
 *
 * Pinned by name in the drift test, not merely iterated: emptying a map makes a
 * loop over it assert nothing, which is the same hole mutation testing found in
 * the documentation gate.
 */
const CLOSED = new Map([
  ["apps/control-plane", "the hosted control plane, paid and closed"],
]);

/** Packages the decision log places on the open side. */
const OPEN_CORE = [
  "registry",
  "ledger",
  "policy",
  "proxy",
  "cli",
  "connectors",
];

/** The open packages, restated so dropping one from OPEN_CORE is a failure. */
const REQUIRED_OPEN = [
  "registry",
  "ledger",
  "policy",
  "proxy",
  "cli",
  "connectors",
  "verifier",
];

const read = (file) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const readJson = (file) => JSON.parse(read(file));

/** Prose is hard wrapped, so a phrase can straddle a line break. Folding
 * whitespace before matching is what stops a rewrap from failing a gate, and the
 * same bug hid in the handbook gate until it was mutation tested. */
const flat = (text) => text.replace(/\s+/g, " ");

const packages = readdirSync(ROOT)
  .filter((name) => existsSync(join(ROOT, name, "package.json")))
  .sort()
  .map((name) => ({
    name,
    dir: join(ROOT, name),
    manifest: readJson(join(ROOT, name, "package.json")),
  }));

test("the root licence is the Apache 2.0 text, unmodified", () => {
  assert.ok(existsSync("LICENSE"), "no LICENSE at the repository root");
  const licence = read("LICENSE");
  assert.match(licence, /Apache License/);
  assert.match(licence, /Version 2\.0, January 2004/);
  assert.match(
    licence,
    /TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION/,
  );
  assert.match(
    licence,
    /APPENDIX: How to apply the Apache License to your work/,
  );
  // The unmodified text is 201 lines plus a trailing newline. A truncated copy
  // would still match the four assertions above.
  const lines = licence.split("\n").length;
  assert.ok(
    lines >= 200,
    `LICENSE is only ${lines} lines, so the Apache text is truncated`,
  );
  // And the root manifest has to agree with the file, or npm shows a licence the
  // repository does not grant.
  assert.equal(readJson("package.json").license, "Apache-2.0");
});

test("the NOTICE carries the registry disclaimer verbatim", () => {
  // Amendment four: the caveat travels with the data wherever the data goes.
  // The only thing between an illustrative classification and a false assurance
  // is this sentence, so it is checked by words rather than trusted.
  const notice = read("NOTICE");
  assert.ok(
    flat(notice).includes(flat(REGISTRY_DISCLAIMER)),
    `NOTICE does not carry REGISTRY_DISCLAIMER verbatim.\n  expected: ${REGISTRY_DISCLAIMER}`,
  );
  assert.match(
    notice,
    /Apache License/,
    "NOTICE must name the licence it travels with",
  );
  // The vendor endorsement disclaimer is a separate claim and is easy to drop.
  assert.match(
    flat(notice),
    /No vendor named in the registry has reviewed or endorsed/,
    "NOTICE must state that no vendor endorsed its classification",
  );
});

test("every open-core package declares Apache 2.0", () => {
  for (const name of OPEN_CORE) {
    const entry = packages.find((p) => p.name === name);
    assert.ok(entry, `packages/${name} is gone but the open core needs it`);
    assert.equal(
      entry.manifest.license,
      "Apache-2.0",
      `packages/${name} must declare Apache-2.0`,
    );
    assert.ok(
      existsSync(join(entry.dir, "README.md")),
      `packages/${name} has no README, so nobody knows what it is for`,
    );
  }
});

test("no package claims to be publishable without a way to produce its files", () => {
  // The trap this whole gate exists for. `private: true` is what currently stops
  // a broken release, and it is a flag somebody will eventually flip.
  //
  // A build script is one way to be publishable, not the only one. The verifier is
  // publishable precisely because it does not need one: it is a single executable
  // file of Node built-ins. So the rule is about the files that would ship rather
  // than about whether tsc ever ran. A package may skip a build only when nothing
  // in its file list needs compiling and no entry point is TypeScript. Anything
  // else ships source the runtime cannot load.
  const offenders = [];
  for (const { name, dir, manifest } of packages) {
    if (manifest.private === true) continue;
    const hasBuild = Boolean(manifest.scripts?.build);

    for (const entry of manifest.files ?? []) {
      if (/\.(ts|tsx)$/.test(entry) && !hasBuild) {
        offenders.push(
          `packages/${name} publishes ${entry} with no build script`,
        );
      }
    }

    const entries = [];
    for (const field of ["main", "module"]) {
      if (typeof manifest[field] === "string") entries.push(manifest[field]);
    }
    for (const value of Object.values(manifest.exports ?? {})) {
      if (typeof value === "string") entries.push(value);
      else if (value && typeof value === "object") {
        for (const [key, target] of Object.entries(value)) {
          if (
            ["types", "import", "require", "default"].includes(key) &&
            typeof target === "string"
          ) {
            entries.push(target);
          }
        }
      }
    }
    for (const entry of entries) {
      if (!/\.(mjs|cjs|js|json)$/.test(entry) && !hasBuild) {
        offenders.push(
          `packages/${name} points an entry point at ${entry} with no build script`,
        );
      }
      if (!existsSync(join(dir, entry))) {
        offenders.push(
          `packages/${name} entry point ${entry} does not exist on disk`,
        );
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these packages would publish source the runtime cannot load:\n${offenders.join("\n")}`,
  );
});

test("the verifier package is independent and would survive publication", () => {
  const dir = "packages/verifier";
  assert.ok(
    existsSync(join(dir, "package.json")),
    "the verifier has no package manifest",
  );
  const manifest = readJson(join(dir, "package.json"));

  // Amendment two. Zero dependencies, not zero VOID dependencies.
  assert.deepEqual(
    manifest.dependencies ?? {},
    {},
    "the verifier must have no runtime dependencies",
  );
  assert.deepEqual(
    manifest.devDependencies ?? {},
    {},
    "the verifier must have no dev dependencies",
  );

  // Nothing from this repository, so independence is structural and not promised.
  const source = read(join(dir, "verify-ledger.mjs"));
  const imports = [
    ...source.matchAll(/^\s*import[^;]*?from\s+["']([^"']+)["']/gm),
  ].map((match) => match[1]);
  const relative = imports.filter((specifier) => specifier.startsWith("."));
  assert.deepEqual(
    relative,
    [],
    `the verifier must import nothing relative, so a copy of the one file still works: ${relative.join(", ")}`,
  );
  for (const specifier of imports) {
    assert.ok(
      specifier.startsWith("node:"),
      `the verifier imports ${specifier}, which is not a Node built-in`,
    );
  }

  // It is publishable today because it needs no build: one executable file.
  assert.equal(
    manifest.private,
    undefined,
    "the verifier should be publishable",
  );
  assert.ok(
    manifest.bin?.["void-verify"],
    "the verifier declares no void-verify bin",
  );
  assert.ok(
    existsSync(join(dir, manifest.bin["void-verify"])),
    "the declared bin does not exist on disk",
  );
  assert.equal(manifest.license, "Apache-2.0");
  assert.ok(
    (manifest.files ?? []).includes("verify-ledger.mjs"),
    "the published file list would omit the verifier itself",
  );

  // The permanence commitment is written down, not implied.
  const readme = flat(read(join(dir, "README.md")));
  assert.match(
    readme,
    /zero dependencies/i,
    "the README must state the zero dependency commitment",
  );
  assert.match(
    readme,
    /will not acquire a build step/i,
    "the README must state the no build commitment",
  );
  assert.match(
    readme,
    /tamper \*\*evident\*\*/,
    "the README must state that the ledger is tamper evident, not tamper proof",
  );
});

test("the verifier selftest still passes where it now lives", () => {
  // Run it as a child process rather than trusting that a move preserved behaviour.
  // A non-zero exit throws, which is the point: a broken selftest fails here.
  const result = execFileSync(
    process.execPath,
    ["packages/verifier/verify-ledger.mjs", "--selftest"],
    { encoding: "utf8" },
  );
  // execFileSync returns the string itself. Reading .stdout here would assert
  // against undefined, which is a check that passes for the wrong reason.
  assert.match(result, /SELFTEST PASS roundtrip/);
  assert.match(result, /SELFTEST PASS tamper refused/);
  assert.match(result, /SELFTEST PASS wrong key refused/);
  assert.match(result, /SELFTEST PASS integrity-only/);
});

test("the closed side is marked closed", () => {
  for (const [dir, reason] of CLOSED) {
    assert.ok(
      existsSync(join(dir, "LICENSE")),
      `${dir} carries no licence of its own`,
    );
    const licence = read(join(dir, "LICENSE"));
    assert.match(
      licence,
      /not licensed under the Apache License/i,
      `${dir} must say the root licence does not cover it`,
    );
    assert.match(
      licence,
      /SPDX-License-Identifier/,
      `${dir} must carry an SPDX identifier`,
    );
    assert.ok(reason.length > 10, `${dir} needs a reason in the gate`);
  }
  // The closed UI must not claim an open licence it does not have.
  const ui = readJson("apps/control-plane/ui/package.json");
  assert.notEqual(
    ui.license,
    "Apache-2.0",
    "the control plane UI is closed, so it must not declare the open licence",
  );
});

test("the open core and the paid side are both documented for a reader", () => {
  const readme = flat(read("README.md"));
  assert.match(readme, /## Licence/, "the README has no licence section");
  assert.match(
    readme,
    /never moves from open to paid/,
    "the README must state the rule that holds the line",
  );
  assert.match(
    readme,
    /No support obligation/,
    "DECISIONS 5 requires the README to state there is no support obligation",
  );
  assert.match(
    readme,
    /tamper \*\*evident\*\*/,
    "the README must not hide the tamper proof limitation",
  );

  const contributing = flat(read("CONTRIBUTING.md"));
  assert.match(
    contributing,
    /Signed-off-by/,
    "contributing must require a DCO sign off",
  );
  assert.match(
    contributing,
    /no CLA|deliberately no CLA/i,
    "amendment three is DCO not CLA, and the file must say which",
  );
  assert.match(
    contributing,
    /Registry data pull requests/i,
    "registry data contributions are the easiest valuable contribution and must be named",
  );
  assert.match(
    contributing,
    /prior agreement/i,
    "connector contributions require prior agreement",
  );
  assert.match(
    contributing,
    /described use case/i,
    "feature requests need a described use case",
  );
  assert.match(
    contributing,
    /No support obligation/,
    "the maintenance bound must be stated where contributors will read it",
  );
});

test("the classification lists did not drift from the tree", () => {
  // Both lists name directories. A rename in either direction has to fail here
  // rather than quietly changing what the licence line covers.
  assert.ok(
    packages.length >= 9,
    `only ${packages.length} packages found under ${ROOT}`,
  );
  const names = packages.map((entry) => entry.name);
  // Every open package is named in both places. Without this, deleting a name from
  // OPEN_CORE narrows what the licence line claims and nothing fails, which is the
  // exact failure this gate exists to prevent.
  for (const expected of REQUIRED_OPEN) {
    assert.ok(
      OPEN_CORE.includes(expected) || expected === "verifier",
      `packages/${expected} must stay on the open-core list in the gate`,
    );
    assert.ok(
      names.includes(expected),
      `packages/${expected} is in the tree but unlisted here`,
    );
  }
  // And the paid side is named, so emptying CLOSED is a failure rather than a
  // loop over nothing.
  assert.ok(
    CLOSED.size >= 1,
    "the closed-side list is empty, so nothing is checked as paid",
  );
  for (const dir of ["apps/control-plane"]) {
    assert.ok(
      CLOSED.has(dir),
      `${dir} must stay on the closed list in the gate`,
    );
  }
  for (const expected of ["runtime", "sdk", "workbench"]) {
    assert.ok(
      names.includes(expected),
      `packages/${expected} is in the tree but unlisted here`,
    );
  }
  for (const entry of packages) {
    assert.ok(
      statSync(entry.dir).isDirectory(),
      `packages/${entry.name} is not a directory`,
    );
  }
  for (const dir of CLOSED.keys()) {
    assert.ok(existsSync(dir), `${dir} is listed as closed but is gone`);
  }
});
