/**
 * Workbench module inventory.
 *
 * Merge d7b55f38 deleted seventeen files under `packages/workbench/src` and
 * dropped six re-exports from `index.ts`. The deletions were visible in the
 * diff. The modules that survived with nobody left to import them were not:
 * `goals.ts`, `plan.ts`, `session-search.ts`, `agent-messages.ts`,
 * `web-tools.ts` and `project-context-files.ts` still exist, still compile and
 * are still exercised by their own unit tests, so the suite stayed green while
 * the capability itself became unreachable. A whole feature can be merged out of
 * existence and nothing local objects.
 *
 * So this gate asks one question per module: does any non-test file outside the
 * module itself import it? The importer roots are the places that can legitimately
 * reach a workbench module — the workbench itself (including its subdirectories,
 * which is where the provider adapters live), the CLI, the control plane and the
 * scripts. Test files are excluded from both sides: a module that only its own
 * test imports has no production caller, which is exactly the defect.
 *
 * A module with no importer is either a defect or a known, named exception. The
 * exceptions live in ORPHANS with the reason they are allowed, so the set is
 * visible and reviewable rather than an amnesty nobody reads. The list is checked
 * in both directions: an unlisted orphan fails, and a listed module that gains an
 * importer fails as a stale entry. An allowlist that can only grow is how a gate
 * quietly stops gating.
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Where the modules under inspection live. Top level only, by design. */
const WORKBENCH_SRC = "packages/workbench/src";

/**
 * Every place a workbench module may be imported from. The workbench is scanned
 * recursively because its provider adapters live one directory down and a module
 * imported only by an adapter is wired, not orphaned.
 */
const IMPORTER_ROOTS = [
  WORKBENCH_SRC,
  "packages/cli/src",
  "apps/control-plane",
  "scripts",
];

/** Build output and vendored trees. Nothing in these is a source importer. */
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  "out",
  ".next",
  ".turbo",
  ".git",
]);

const SOURCE_FILE = /\.(ts|tsx|mts|cts|mjs|cjs|js)$/;
const TEST_FILE = /\.(test|spec)\.(ts|tsx|mts|cts|mjs|cjs|js)$/;

/**
 * Known orphans, each with the reason it is allowed to exist unwired.
 *
 * Every entry here is a restoration debt recorded by the merge, not a decision
 * that the module is dead. When the wiring comes back, the entry must go: the
 * stale-entry test enforces that, so the list cannot become a permanent waiver.
 */
const ORPHANS = new Map([
  [
    "test-fixture.ts",
    // Not the same case as the six above: a fixture is test scaffolding, not a
    // capability, so it needs no production importer. If a non-test file ever
    // imports it, the stale-entry test fires and the remedy is to stop the
    // fixture leaking into production, not to delete this reason.
    "test-only helper: imported by 48 *.test.ts files and by nothing else, so it " +
      "needs no production importer; a non-test importer would be a fixture leak",
  ],
]);

/** A specifier written after `from`, as in `import x from "./y.ts"`. */
const FROM_SPECIFIER = /\bfrom\s*["']([^"']+)["']/g;
/** A dynamic import, as in `await import("./y.ts")`. */
const DYNAMIC_SPECIFIER = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
/** A side-effect import, as in `import "./y.ts"`. */
const BARE_SPECIFIER = /^\s*import\s+["']([^"']+)["']/g;

const posix = (path) => path.split("\\").join("/");

/** Source files under one relative root, as repository-relative posix paths. */
function walk(dir, found = []) {
  const absolute = join(ROOT, dir);
  if (!existsSync(absolute)) return found;
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = posix(join(dir, entry.name));
    if (entry.isDirectory()) walk(path, found);
    else if (SOURCE_FILE.test(entry.name)) found.push(path);
  }
  return found;
}

/** The modules under inspection: top-level `.ts` files, tests excluded. */
function moduleNames() {
  return readdirSync(join(ROOT, WORKBENCH_SRC), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !TEST_FILE.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort();
}

/**
 * Import specifiers on one file, line by line.
 *
 * Comment lines are skipped before matching, because a doc comment that quotes
 * an import statement would otherwise count as a caller and hide a real orphan.
 * That is the one direction this gate must not fail in.
 */
function specifiers(text) {
  const found = [];
  for (const line of text.split("\n")) {
    const head = line.trimStart();
    if (head.startsWith("//") || head.startsWith("*") || head.startsWith("/*"))
      continue;
    for (const match of line.matchAll(FROM_SPECIFIER)) found.push(match[1]);
    for (const match of line.matchAll(DYNAMIC_SPECIFIER)) found.push(match[1]);
    for (const match of line.matchAll(BARE_SPECIFIER)) found.push(match[1]);
  }
  return found;
}

/**
 * The repository path a specifier names, before the extension is settled.
 *
 * Relative specifiers are normalised against the importing file with `path.join`,
 * which resolves `..` the same way the compiler does. A non-relative specifier is
 * only accepted when it spells out the workbench source path, which is what a
 * package alias or a root-relative import would look like.
 */
function targetPath(importer, specifier) {
  if (specifier.startsWith(".")) return posix(join(dirname(importer), specifier));
  const at = specifier.indexOf(`${WORKBENCH_SRC}/`);
  return at === -1 ? null : specifier.slice(at);
}

/**
 * The `.ts` file a repository path refers to.
 *
 * `./x.js` maps to `./x.ts` because that is how a NodeNext ESM import of a
 * TypeScript source file is written, and an extensionless specifier resolves the
 * same way under the classic rule. Anything else is left alone so it cannot
 * match a module that does not exist.
 */
function asTypeScript(path) {
  if (path === null) return null;
  if (path.endsWith(".ts")) return path;
  if (/\.(js|mjs|cjs)$/.test(path)) return path.replace(/\.(js|mjs|cjs)$/, ".ts");
  if (/\.(tsx|mts|cts)$/.test(path)) return null;
  return `${path}.ts`;
}

/** Importers per module, plus the scan totals the tests print. */
function inventory() {
  const modules = moduleNames();
  const importers = new Map(modules.map((name) => [name, new Set()]));
  let filesScanned = 0;
  let edges = 0;
  for (const root of IMPORTER_ROOTS) {
    for (const file of walk(root)) {
      if (TEST_FILE.test(file)) continue;
      filesScanned += 1;
      for (const specifier of specifiers(readFileSync(join(ROOT, file), "utf8"))) {
        const target = asTypeScript(targetPath(file, specifier));
        if (target === null || !target.startsWith(`${WORKBENCH_SRC}/`)) continue;
        const name = target.slice(WORKBENCH_SRC.length + 1);
        if (!importers.has(name) || file === target) continue;
        importers.get(name).add(file);
        edges += 1;
      }
    }
  }
  return { modules, importers, filesScanned, edges };
}

const scan = inventory();
const orphaned = scan.modules.filter(
  (name) => scan.importers.get(name).size === 0,
);

/**
 * Modules whose wiring is load-bearing for the scan itself.
 *
 * A resolver that silently matches nothing would report every module as orphaned
 * and be caught by the allowlist, but a resolver that is merely narrower than the
 * codebase would under-count quietly. These floors pin the shapes the repository
 * actually uses: `index.ts` is imported by the CLI, the control plane and the
 * workbench fixture; `provider.ts` and `harness-settings.ts` are imported by the
 * adapters one directory down; `workspace.ts` is imported by the CLI TUI and a
 * script.
 */
const WIRED_FLOOR = new Map([
  ["index.ts", 5],
  ["provider.ts", 10],
  ["harness-settings.ts", 10],
  ["workspace.ts", 3],
]);

test("no workbench module is orphaned", (t) => {
  // Without these, a broken walker or a resolver that matches nothing makes the
  // assertion at the end pass on an empty set.
  assert.ok(
    scan.modules.length >= 40,
    `found only ${scan.modules.length} modules under ${WORKBENCH_SRC}`,
  );
  assert.ok(
    scan.filesScanned >= 200,
    `scanned only ${scan.filesScanned} non-test files, so the walker is not seeing the tree`,
  );
  assert.ok(
    scan.edges >= 100,
    `resolved only ${scan.edges} workbench imports, so the specifier resolver is not matching`,
  );
  assert.equal(
    scan.importers.size,
    scan.modules.length,
    "the importer map does not cover every module, so a missing key would read as wired",
  );
  for (const [name, floor] of WIRED_FLOOR) {
    assert.ok(scan.importers.has(name), `${name} is no longer a scanned module`);
    const count = scan.importers.get(name).size;
    assert.ok(
      count >= floor,
      `${name} has ${count} importers, below the floor of ${floor}; the resolver has narrowed`,
    );
  }

  t.diagnostic(
    `scanned ${scan.filesScanned} non-test files across ${IMPORTER_ROOTS.length} roots, ` +
      `resolved ${scan.edges} workbench import edges, found ${scan.modules.length} modules ` +
      `and ${orphaned.length} with no importer`,
  );
  t.diagnostic(
    `importers per module: ${scan.modules
      .map((name) => `${name} ${scan.importers.get(name).size}`)
      .join(", ")}`,
  );

  const unlisted = orphaned.filter((name) => !ORPHANS.has(name));
  assert.deepEqual(
    unlisted,
    [],
    `these workbench modules are imported by no non-test file, so the capability ` +
      `they carry is unreachable:\n${unlisted.join("\n")}\n` +
      "Wire the module, or add it to ORPHANS with the reason it is allowed unwired.",
  );
});

test("the orphan allowlist is not stale", (t) => {
  const gone = [];
  const wired = [];
  const unreasoned = [];
  for (const [name, reason] of ORPHANS) {
    if (!scan.modules.includes(name)) gone.push(name);
    if ((scan.importers.get(name)?.size ?? 0) > 0) wired.push(name);
    if (typeof reason !== "string" || reason.trim().length < 20)
      unreasoned.push(`${name}: ${JSON.stringify(reason)}`);
  }

  t.diagnostic(
    `allowlist: ${ORPHANS.size} entries, ${orphaned.length} modules currently orphaned, ` +
      `${wired.length} entries with an importer, ${gone.length} entries with no file`,
  );

  assert.deepEqual(
    unreasoned,
    [],
    `these allowlist entries do not name why they are allowed:\n${unreasoned.join("\n")}`,
  );
  assert.deepEqual(
    gone,
    [],
    `these allowlist entries name a module that no longer exists:\n${gone.join("\n")}`,
  );
  assert.deepEqual(
    wired,
    [],
    `these modules have an importer again, so their allowlist entries are stale and ` +
      `must be removed:\n${wired.join("\n")}`,
  );
});
