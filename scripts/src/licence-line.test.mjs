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
 * Every tracked directory in this repository and the licence status DECISIONS
 * section 5 puts it on.
 *
 * The earlier version of this file classified only `packages/*`, which left the
 * deployed server — the directory that reads provider credentials, holds
 * customer documents and makes the paid entitlement decision — in a directory
 * no decision named and no test asserted. The trap is not that its status was
 * wrong; it is that "nobody decided" and "open" are indistinguishable to every
 * reader and to every tool.
 *
 * So this is a partition, not a list. Every tracked top-level directory and
 * every tracked child of `apps/` appears exactly once, and a directory in
 * neither is a failure rather than a silence. That is what makes the status of
 * `cloud/` a decision somebody has to write down.
 *
 * Two real statuses, because there are only two. `open` is the root Apache 2.0
 * licence, which already covers the whole tree; naming a directory here records
 * that nobody has carved it out, and it narrows nothing. `closed` means the
 * directory carries its own `LICENSE` and grants nothing, which is the
 * direction DECISIONS 5 forbids: a feature never moves from open to paid, so a
 * directory only earns `closed` by being named on the paid side there.
 */
const LICENCE_LINE = new Map([
  ["apps", { status: "container", why: "each child is classified on its own line below" }],
  [
    "apps/apple",
    {
      status: "open",
      why: "the macOS client for the local workbench, and it makes no paid decision",
    },
  ],
  [
    "apps/appwrite-mcp",
    {
      status: "open",
      why: "a hosted function that serves the open registry and holds no credential",
    },
  ],
  [
    "apps/control-plane",
    { status: "closed", why: "the hosted control plane, paid and closed" },
  ],
  [
    "apps/desktop",
    {
      status: "open",
      why: "the Tauri client, whose manifest already declares Apache 2.0",
    },
  ],
  [
    "apps/tui-preview",
    { status: "open", why: "a static preview of the TUI with no paid decision in it" },
  ],
  [
    "cloud",
    {
      status: "closed",
      why: "the deployed server: it holds provider credentials and customer documents, and capability-gate.mjs and billing.mjs make the paid entitlement decision",
    },
  ],
  [".agents", { status: "open", why: "repository tooling, covered by the root licence" }],
  [".github", { status: "open", why: "workflow definitions, covered by the root licence" }],
  [".gitlab", { status: "open", why: "issue templates, covered by the root licence" }],
  [".omp", { status: "open", why: "agent tooling, covered by the root licence" }],
  [".opencode", { status: "open", why: "agent definitions, covered by the root licence" }],
  [
    ".playwright-mcp",
    {
      status: "open",
      why: "committed browser logs; the path is gitignored and nothing ships from it",
    },
  ],
  [".prime", { status: "open", why: "agent configuration, covered by the root licence" }],
  [
    "docs",
    { status: "open", why: "the decision log itself, covered by the root licence" },
  ],
  [
    "fixtures",
    { status: "open", why: "test fixtures, covered by the root licence" },
  ],
  [
    "gui-web",
    {
      status: "open",
      why: "the browser front end for the local workbench, and it makes no paid decision",
    },
  ],
  ["marketing", { status: "open", why: "site assets, covered by the root licence" }],
  [
    "packages",
    {
      status: "open",
      why: "the open core, every package of which declares Apache 2.0",
    },
  ],
  [
    "policy",
    { status: "open", why: "a default policy file, covered by the root licence" },
  ],
  [
    "python",
    {
      status: "open",
      why: "void-transport, which declares Apache 2.0 in its pyproject",
    },
  ],
  ["scripts", { status: "open", why: "the local gates, which declare Apache 2.0" }],
  ["site", { status: "open", why: "the marketing site, covered by the root licence" }],
]);

/**
 * The closed side, derived rather than restated.
 *
 * Deriving it is what keeps two views from disagreeing: a directory cannot be
 * closed here and absent from the list the licence test walks, because there is
 * only one place to say so.
 */
const CLOSED = new Map(
  [...LICENCE_LINE].filter(([, entry]) => entry.status === "closed"),
);

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

/**
 * Every file under a directory, recursively, skipping build output.
 *
 * Used to read the import graph rather than to lint it. `node_modules` is
 * skipped because a source file in this repository does not import through it,
 * and a fixture directory is skipped because a fixture is allowed to say
 * anything it likes; the boundary this asserts is about shipped source.
 */
const walk = (dir) => {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "__fixtures__") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
};

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
  for (const [dir, entry] of CLOSED) {
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
    // The specific identifier rather than the bare string "SPDX-License-Identifier",
    // which `apps/control-plane` already satisfied. A closed directory carrying
    // only that string could be carrying the open identifier and would still pass,
    // which is precisely the failure a licence line cannot have.
    assert.match(
      licence,
      /SPDX-License-Identifier: LicenseRef-VOID-Proprietary/,
      `${dir} must be identified as LicenseRef-VOID-Proprietary, which is what apps/control-plane declares`,
    );
    assert.ok(entry.why.length > 20, `${dir} needs a reason in the gate`);
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
  // And both closed directories are named, so emptying CLOSED is a failure
  // rather than a loop over nothing, and so dropping `cloud` from it cannot
  // quietly reopen the deployed server.
  assert.ok(
    CLOSED.size >= 2,
    "the closed-side list is empty, so nothing is checked as paid",
  );
  for (const dir of ["apps/control-plane", "cloud"]) {
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

test("the licence line covers every directory in the tree", () => {
  // The partition. `git ls-files` rather than readdirSync, because the question is
  // what the repository contains rather than what a build happened to leave
  // behind: a stale `dist/` must not decide a licence status, and a directory
  // staged for its first commit must fail before it lands. `-co` includes
  // untracked files, `--exclude-standard` drops what `.gitignore` already drops.
  //
  // Entries are filtered against the filesystem on purpose. `git ls-files`
  // reports a path that has been deleted from the working tree but whose removal
  // is not yet staged, and a licence gate that fails because somebody is
  // mid-delete is a gate people stop reading. What exists on disk and is tracked
  // or staged must be classified; a path that is gone is the other tests'
  // business, and one of them already says a classified directory that vanished
  // is a failure.
  const tracked = execFileSync(
    "git",
    ["ls-files", "-co", "--exclude-standard"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  )
    .split("\n")
    .filter((file) => file && existsSync(file));
  assert.ok(tracked.length > 0, "git ls-files returned nothing to classify");

  const topLevel = [
    ...new Set(
      tracked
        .filter((file) => file.includes("/"))
        .map((file) => file.split("/")[0]),
    ),
  ].sort();

  // Every top-level directory is classified. This is the assertion the issue was
  // opened for: `cloud/` was in this tree, held provider credentials and customer
  // documents, and no decision named it and no test looked at it.
  const undecided = topLevel.filter((dir) => !LICENCE_LINE.has(dir));
  assert.deepEqual(
    undecided,
    [],
    `these top-level directories have no licence status in the gate. Give each one the status DECISIONS section 5 puts it on. Undecided is not a status, and quietly reading one as open is how the deployed server ended up unclassified.\n${undecided.join("\n")}`,
  );

  // And every child of `apps/`, because that directory holds a closed surface and
  // four open ones and cannot honestly be classified as a single thing.
  for (const name of readdirSync("apps").sort()) {
    if (!statSync(join("apps", name)).isDirectory()) continue;
    const path = `apps/${name}`;
    assert.ok(
      LICENCE_LINE.has(path),
      `${path} has no licence status in the gate. An unclassified app is not an open app.`,
    );
  }

  // Nothing classified that is not in the tree, so a rename cannot leave the gate
  // asserting a boundary that no longer exists.
  for (const dir of LICENCE_LINE.keys()) {
    assert.ok(
      existsSync(dir) && statSync(dir).isDirectory(),
      `${dir} is classified in the gate but is not a directory in the tree`,
    );
  }

  // A reason for every classification, and a status from the fixed set. A bare
  // status is an assertion nobody can check, which is the state this file exists
  // to end.
  for (const [dir, entry] of LICENCE_LINE) {
    assert.ok(
      typeof entry.why === "string" && entry.why.length > 20,
      `${dir} is classified as ${entry.status} with no reason given`,
    );
    assert.ok(
      ["open", "closed", "container"].includes(entry.status),
      `${dir} carries an unknown status ${entry.status}`,
    );
  }

  // `container` grants nothing on its own and earns that by classifying its
  // children, which the loop above already checked. Assert it is not being used
  // as a way to avoid answering.
  assert.equal(LICENCE_LINE.get("apps").status, "container");
  for (const [dir, entry] of LICENCE_LINE) {
    if (entry.status !== "container") continue;
    assert.ok(
      readdirSync(dir).some((name) => statSync(join(dir, name)).isDirectory()),
      `${dir} is a container with nothing in it, so the status is doing no work`,
    );
  }
});

test("the paid entitlement decision lives inside a closed directory", () => {
  // The classification is only worth something if the thing being classified is
  // where the paid decision actually is. `cloud/capability-gate.mjs` is the
  // enforcement point and `cloud/billing.mjs` is the merchant of record behind
  // it. If either moved into an open directory, the gate would be asserting a
  // boundary the code does not follow, and this is the check that notices.
  for (const file of ["cloud/capability-gate.mjs", "cloud/billing.mjs"]) {
    assert.ok(existsSync(file), `${file} is gone, so this gate has lost its subject`);
    const owner = file.split("/")[0];
    assert.equal(
      LICENCE_LINE.get(owner)?.status,
      "closed",
      `${file} makes the paid entitlement decision, so ${owner} must be classified closed`,
    );
  }
  // And the closed directory's own licence says so, so a reader who opens
  // `cloud/` finds the same identifier `apps/control-plane` declares rather than
  // a second dialect of closed.
  assert.match(
    read(join("cloud", "LICENSE")),
    /SPDX-License-Identifier: LicenseRef-VOID-Proprietary/,
  );
});

test("no open package imports from the closed cloud server", () => {
  // The direction of the dependency is what makes a closed directory a boundary
  // rather than a label. `cloud/` reads the open core, which is correct and is
  // what lets the hosted server be built out of parts a reviewer can read. The
  // reverse would put a paid decision inside an Apache 2.0 file.
  //
  // `apps/control-plane` is deliberately not covered here. `packages/cli` and
  // `packages/workbench` already import `desktop-setup.ts` and `commands.ts` out
  // of it, which predates this work and is a real leak. Closing it means moving
  // code across the boundary, which is a separate work package, so it is named
  // here rather than quietly omitted or quietly asserted as fine.
  const offenders = [];
  for (const name of OPEN_CORE) {
    const dir = join(ROOT, name, "src");
    assert.ok(existsSync(dir), `packages/${name} has no src directory to scan`);
    for (const file of walk(dir)) {
      if (!/\.(ts|tsx|mts|mjs)$/.test(file)) continue;
      for (const match of read(file).matchAll(/from\s+["']([^"']+)["']/g)) {
        const specifier = match[1];
        if (specifier.startsWith(".") && /(^|\/)cloud\//.test(specifier)) {
          offenders.push(`${file} imports ${specifier}`);
        }
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `the open core must not import from the closed cloud server:\n${offenders.join("\n")}`,
  );
});
