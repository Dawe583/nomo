/**
 * A test that names a product env var the tree no longer reads does not fail.
 * It passes.
 *
 * `packages/workbench/src/index.ts` reads `env.NOMO_DATA_DIR`, and the suites
 * that build a `Workbench` pass `{ NOMO_DATA_DIR: root }` so every write lands
 * in a temporary directory that the suite deletes afterwards. Rename that one
 * variable in the source and leave the tests alone — which is what a VOID→NOMO
 * sweep does to half the tree at a time, and what any single-package rename
 * does — and the harness reads `undefined`, falls back to
 * `~/.void/workbench`, and the suite keeps passing while writing into the
 * operator's real home directory. Every assertion still holds. The corruption
 * is silent and the test suite reports green, which is the worst shape a
 * defect can have: the one signal a reader trusts is the one that lies.
 *
 * Nothing else in this repository can see it. `check-tests.mjs` only knows
 * whether suites passed, and they do. So the check is on the name rather than
 * on the behaviour: every VOID_/NOMO_ identifier in a test file has to appear
 * in a non-test source file as well, or nothing reads it and every value that
 * test sets is decoration.
 *
 * Two deliberate limits, stated rather than papered over.
 *
 * The comparison is against the whole tree, not the enclosing package. Package
 * scoping is provably wrong here: `NOMO_HOOK_COMMANDS` is read only in
 * `packages/workbench/src/index.ts` but set by tests in `packages/cli` and
 * `apps/control-plane`, because the hook contract spans the three. Scoped to a
 * package, this gate would have cried wolf on five such names on its first
 * run, and a gate that cries wolf gets deleted. The cost of the wider
 * comparison is that a rename which leaves a reader of the old name somewhere
 * else in the tree is not caught here; the rename this repository is actually
 * making is a whole-tree one, so it removes the name entirely and is caught.
 *
 * Only identifiers are checked. If a test asserts a documented default, or a
 * name that is read dynamically through `process.env[cfg.someKeyEnv]`, this
 * says nothing about it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");

/**
 * A name only counts as an identifier when the whole token is one.
 *
 * `[A-Z]` after the underscore is what keeps `VOID_0.1.0_aarch64.dmg` — a
 * release filename in a fixture path, in
 * `apps/control-plane/ui/src/desktop-downloads.test.ts` — out of the results,
 * as is the lookahead rejecting a following `.`, `-` or `/`. Both halves are
 * load-bearing: the letter rejects a leading digit, the lookahead rejects a
 * name that is the prefix of a longer dotted path. The lookbehind is what
 * makes `env.NOMO_DATA_DIR` and `env["NOMO_DATA_DIR"]` match.
 */
const ENV_VAR =
  /(?<![A-Za-z0-9_])(?:VOID|NOMO)_[A-Z][A-Z0-9_]*(?![A-Za-z0-9_.\-/])/g;

/**
 * Names that are meant to be unread, with the reason each one is legitimate.
 *
 * Every entry is a name that exists to be observed by a test, a fake binary,
 * or a config string — not consumed by product code. The prefix is not treated
 * as a category: `NOMO_TEST_DATABASE_URL`, `NOMO_TEST_WS_PROXY` and
 * `NOMO_TEST_DATABASE_ISOLATED` carry that prefix and are deliberately absent,
 * because `scripts/src/cloud-test-config.mjs` and
 * `scripts/src/check-managed-cloud.mjs` really do read them. Allowing the
 * prefix would have hidden three live readers behind four dead sentinels.
 *
 * A test below fails when an entry here is no longer used anywhere, so this
 * list cannot quietly become a place where anything goes.
 */
const TEST_ONLY_ENV_VARS = [
  {
    name: "NOMO_ENV_PROBE_SECRET",
    why: "packages/proxy/src/bin.test.ts sets it to prove the parent environment reaches the child verbatim. The assertion is about pass-through, so the probe must be readable by nobody.",
  },
  {
    name: "NOMO_HEALTH_KEY",
    why: "A value of the `encryptionKeyEnv` config field in packages/cli/src/recovery-health.test.ts. The recovery code reads `process.env[cfg.encryptionKeyEnv]`, so this string is configuration data, never a lookup of its own.",
  },
  {
    name: "NOMO_QA_REPORT",
    why: "scripts/src/ui-layout.test.mjs treats it as an opt-in destination for its own JSON report. The harness reads it, not the product.",
  },
  {
    name: "NOMO_TEST_ARGV_LOG",
    why: "Read by the fake `node` that packages/cli's install-void.test.mjs writes into its fixture bin directory, not by the launcher under test.",
  },
  {
    name: "NOMO_TEST_PACKAGED",
    why: "apps/desktop/runtime.test.mjs uses it to switch between the packaged Tauri binary and the source checkout. Set in CI, read by the test's own guard.",
  },
  {
    name: "NOMO_TEST_PID_LOG",
    why: "Read by the fake `node` in install-void.test.mjs; the launcher under test never sees it.",
  },
  {
    name: "NOMO_TEST_PNPM_LOG",
    why: "Read by the fake `pnpm` in install-void.test.mjs.",
  },
  {
    name: "NOMO_TEST_STDIN_LOG",
    why: "Read by the fake `node` in install-void.test.mjs.",
  },
  {
    name: "NOMO_TUI_ENV_PROBE",
    why: "packages/cli/src/tui/workspace-parity.test.ts prints it with `printenv` inside a TUI command to prove the environment reaches the subprocess. Same pass-through probe as NOMO_ENV_PROBE_SECRET.",
  },
  {
    name: "NOMO_VAULT_KEY",
    why: "A value of the `encryptionKeyEnv` config field in packages/cli/src/recovery-config.test.ts, asserted through the rendered config text. Same reason as NOMO_HEALTH_KEY.",
  },
  {
    name: "NOMO_APPWRITE_PROJECT_ID",
    why: "cloud/env.test.mjs uses it to prove the auth config does not alias an Appwrite project ID onto the gateway seal key. A synthetic identifier proving the boundary, not a setting an operator types.",
  },
  {
    name: "NOMO_NOT_HOME",
    why: "packages/ledger/src/env-compat.test.ts uses it to prove the legacy fallback does not alias a name that merely starts with NOMO_. Synthetic boundary fixture, never read by product code.",
  },
  {
    name: "NOMO_A_B",
    why: "packages/ledger/src/env-compat.test.ts checks that legacyEnvKey maps only the prefix. Synthetic fixture for the prefix boundary; never read by product code.",
  },
  {
    name: "VOID_A_B",
    why: "The legacy spelling of the hypothetical NOMO_A_B above, used to exercise legacyEnvKey against a non-aligned name.",
  },
];

const ALLOWED = new Set(TEST_ONLY_ENV_VARS.map((entry) => entry.name));

/** Every VOID_/NOMO_ name the given product source reads. */
const knownEnvVars = (sourceText) => {
  const found = new Set(Array.from(sourceText.matchAll(ENV_VAR), (match) => match[0]));
  // `envValue(env, NOMO_*)` falls back to the matching `VOID_*` spelling at
  // runtime (the rename left the legacy env names in place for operators
  // whose config still carries them). Expand the known set accordingly, so a
  // test that exercises the legacy spelling is not flagged as naming a name
  // nothing reads.
  const alias = (envVar) => `VOID_${envVar.slice("NOMO_".length)}`;
  for (const name of [...found]) {
    if (name.startsWith("NOMO_")) found.add(alias(name));
  }
  return found;
};

/**
 * Names the test file uses that no source file reads, each with the line it
 * appears on. `known` is the set `knownEnvVars` returns.
 */
const findUnknownEnvVars = (testSource, known, allowed = ALLOWED) => {
  const findings = [];
  const lines = testSource.split("\n");
  for (let i = 0; i < lines.length; i += 1)
    for (const match of lines[i].matchAll(ENV_VAR)) {
      if (known.has(match[0]) || allowed.has(match[0])) continue;
      findings.push({ name: match[0], line: i + 1, text: lines[i].trim() });
    }
  return findings;
};

/** The same check against source text, for callers holding the corpus. */
const unknownEnvVars = (testSource, knownSource) =>
  findUnknownEnvVars(testSource, knownEnvVars(knownSource));

/**
 * The report a reader has to act on without opening anything else: the path,
 * the line, the name, and what happens if nobody fixes it. A gate that names
 * only the variable leaves the reader to grep for it, and a gate that names
 * only the consequence leaves them guessing which line caused it.
 */
const describeFinding = (file, finding) =>
  `${file}:${finding.line} names ${finding.name}, and no source file in this repository reads it.\n` +
  `    ${finding.text}\n` +
  `  Nothing consumes ${finding.name}, so the value this line sets is never read and the code\n` +
  "  falls back to its default. For a data directory that default is the operator's real\n" +
  "  ~/.void/workbench, so the suite writes into a real home directory and still passes: no\n" +
  "  assertion in it can report this. Either rename the variable here to the name the source\n" +
  "  actually reads, or delete it if the source no longer has that setting at all.";

const SKIP_DIRS = new Set([
  ".git",
  ".worktrees",
  ".next",
  ".turbo",
  ".vercel",
  "DerivedData",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
]);

const CODE_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".mjs",
  ".mts",
  ".py",
  ".rs",
  ".sh",
  ".swift",
  ".ts",
  ".tsx",
]);

/** Every file under the repository root, relative and sorted, minus build output. */
const walk = (dir = root) => {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(path));
    else found.push(relative(root, path));
  }
  return found.sort();
};

/** Reads the tree once so the integration test does not re-walk per file. */
const readTree = () => {
  const files = walk();
  const read = (file) => readFileSync(join(root, file), "utf8");
  const tests = files.filter(
    (file) =>
      file.includes(".test.") &&
      !EXEMPT.has(file) &&
      CODE_EXTENSIONS.has(file.slice(file.lastIndexOf("."))),
  );
  const sources = files.filter(
    (file) =>
      !file.includes(".test.") &&
      CODE_EXTENSIONS.has(file.slice(file.lastIndexOf("."))),
  );
  return {
    tests,
    sources,
    known: knownEnvVars(sources.map(read).join("\n")),
    readTest: (file) => read(file),
  };
};

test("a variable the source reads is not reported", () => {
  const testSource = [
    'import { test } from "node:test";',
    'test("writes stay in the fixture", () => {',
    "  const root = mkdtempSync(join(tmpdir(), 'void-wb-'));",
    "  new Workbench({ NOMO_DATA_DIR: root });",
    "});",
  ].join("\n");
  const knownSource =
    "const dir = env.NOMO_DATA_DIR ?? join(home(), '.void', 'workbench');";
  assert.deepEqual(unknownEnvVars(testSource, knownSource), []);
});

test("a variable no source reads is reported on the line that sets it", () => {
  const testSource = [
    "const root = mkdtempSync(join(tmpdir(), 'void-wb-'));",
    "const workbench = new Workbench({ NOMO_DATA_DIR: root, NOMO_LEGACY_ROOT: root });",
    "assert.equal(workbench.root(), root);",
  ].join("\n");
  const knownSource = "const dir = env.NOMO_DATA_DIR ?? join(home(), '.void');";
  const findings = unknownEnvVars(testSource, knownSource);
  assert.deepEqual(findings, [
    {
      name: "NOMO_LEGACY_ROOT",
      line: 2,
      text: "const workbench = new Workbench({ NOMO_DATA_DIR: root, NOMO_LEGACY_ROOT: root });",
    },
  ]);
});
/**
 * The one file exempt from its own scan.
 *
 * Every other test file names variables the source reads. This one has to name
 * variables the source does not, because those are the fixtures the unit tests
 * are built from. Exempt by exact path rather than by shape — "skip any file
 * whose names are synthetic" would describe every file in the tree — and a
 * test below asserts the list has not grown, which is the only way an
 * exemption like this stays honest.
 */
const SELF = relative(root, import.meta.filename);
const EXEMPT = new Set([SELF]);

test("the report names the file, the line, the variable and the consequence", () => {
  const report = describeFinding(
    "packages/workbench/src/tool-catalog.test.ts",
    {
      name: "NOMO_LEGACY_ROOT",
      line: 42,
      text: "new Workbench({ NOMO_DATA_DIR: root, NOMO_LEGACY_ROOT: root });",
    },
  );
  assert.match(report, /packages\/workbench\/src\/tool-catalog\.test\.ts:42/);
  assert.match(report, /NOMO_LEGACY_ROOT/);
  assert.match(report, /real home directory/);
  // The quoted line is what turns "a variable is wrong" into "change this".
  assert.match(
    report,
    /new Workbench\(\{ NOMO_DATA_DIR: root, NOMO_LEGACY_ROOT: root \}\)/,
  );
});

test("every use of an unknown name is reported, so a rename cannot hide in a long file", () => {
  const testSource = [
    "process.env.NOMO_GONE_ONE = a;",
    "",
    "process.env.NOMO_GONE_TWO = b;",
  ].join("\n");
  const findings = unknownEnvVars(testSource, "const dir = env.NOMO_DATA_DIR;");
  assert.deepEqual(
    findings.map((finding) => [finding.name, finding.line]),
    [
      ["NOMO_GONE_ONE", 1],
      ["NOMO_GONE_TWO", 3],
    ],
  );
});

test("an allowlisted test-only name is accepted, and only that exact name", () => {
  const knownSource = "const dir = env.NOMO_DATA_DIR;";
  assert.deepEqual(
    unknownEnvVars("process.env.NOMO_TEST_PACKAGED = '1';", knownSource),
    [],
  );
  // The point of naming them individually rather than allowing the NOMO_TEST_
  // prefix: one character away from a real name is a typo, not a sentinel.
  assert.deepEqual(
    unknownEnvVars(
      "process.env.NOMO_TEST_PACKAGED_LOG = '1';",
      knownSource,
    ).map((f) => f.name),
    ["NOMO_TEST_PACKAGED_LOG"],
  );
});

test("a release filename is not read as an env var", () => {
  const testSource = [
    "/desktop-v0\\.1\\.0-beta\\.4\\/VOID_0\\.1\\.0_aarch64\\.dmg$/,",
    'assert.ok(url.pathname.includes("desktop-v0.1.0"));',
  ].join("\n");
  assert.deepEqual(
    unknownEnvVars(testSource, "const dir = env.NOMO_DATA_DIR;"),
    [],
  );
});

test("NOMO_ names are held to the same standard as VOID_ ones", () => {
  const knownSource = "const dir = env.NOMO_DATA_DIR ?? join(home(), '.nomo');";
  assert.deepEqual(
    unknownEnvVars("new Workbench({ NOMO_DATA_DIR: root });", knownSource),
    [],
  );
  assert.deepEqual(
    unknownEnvVars(
      "new Workbench({ NOMO_DATA_DIR: root, NOMO_SOMETHING_ELSE: root });",
      knownSource,
    ).map((finding) => finding.name),
    ["NOMO_SOMETHING_ELSE"],
  );
});

test("the scan reaches the test tree instead of passing because it read nothing", () => {
  const tree = readTree();
  assert.ok(
    tree.tests.length > 100,
    `expected the scan to see the repository's test files, saw ${tree.tests.length}`,
  );
  assert.ok(
    tree.tests.includes("packages/workbench/src/tool-catalog.test.ts"),
    "the recursive walk missed a nested test file",
  );
  // If the corpus were empty every name below would be unknown, and the
  // integration test would fail for the wrong reason. Prove it is populated.
  assert.ok(
    tree.known.has("NOMO_DATA_DIR"),
    "the source corpus lost NOMO_DATA_DIR, so the whole comparison is vacuous",
  );
});

test("no test in this repository names an env var the tree does not read", () => {
  const tree = readTree();
  const findings = tree.tests.flatMap((file) =>
    findUnknownEnvVars(tree.readTest(file), tree.known).map((finding) =>
      describeFinding(file, finding),
    ),
  );
  assert.deepEqual(findings, [], `\n${findings.join("\n\n")}`);
});

test("every allowlisted name is still in use, so the list cannot become a dumping ground", () => {
  const tree = readTree();
  const inUse = new Set();
  for (const file of tree.tests)
    for (const match of tree.readTest(file).matchAll(ENV_VAR))
      inUse.add(match[0]);
  const stale = TEST_ONLY_ENV_VARS.filter((entry) => !inUse.has(entry.name));
  assert.deepEqual(
    stale.map((entry) => `${entry.name} (${entry.why})`),
    [],
    "these allowlist entries no longer appear in any test file: delete them rather than leaving the gate with unexplained exemptions",
  );
});

test("the only file this gate does not check is this one", () => {
  // The exemption above exists because this file's fixtures are unknown names
  // by construction. Any second entry is a test the gate has stopped reading,
  // and it would be invisible to every test in this file.
  assert.deepEqual([...EXEMPT], [SELF]);
});
