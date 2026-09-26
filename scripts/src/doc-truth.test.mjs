import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Documentation must not point at files that are not there.
 *
 * The site was split out of this repository, which silently invalidated a layer
 * of paths that the context pack, the plans and two package READMEs still named:
 * `api/_registry.ts`, `artifacts/void/src/index.css`, `api/tsconfig.json`. Each
 * of those reads fine and sends a reader into an empty directory. A dead pointer
 * in a plan is annoying; a dead pointer in a runbook is an operator standing in
 * front of a shell with nothing to run.
 *
 * So the check is split by what kind of document it is:
 *
 *   - OPERATIONAL documents get zero tolerance. A dead path is a defect.
 *   - RECORD documents (decisions, plans, matrices) may cite a path that no
 *     longer exists, because a decision log that described only the present tree
 *     would be falsifying its own history. Those paths are listed in INVENTORY
 *     below, each with the reason it is allowed, so the set is visible, reviewable
 *     and cannot grow quietly.
 *
 * The inventory is checked in both directions. A listed path that starts
 * existing is a stale entry and fails, so the list cannot rot into a permanent
 * amnesty, and an unlisted dead path fails too.
 *
 * Superseded plans must carry their marker, so a document nobody maintains cannot
 * quietly become the plan of record again.
 */

/** Directories whose members are repository files a reader may be pointed at. */
const SOURCE_ROOTS = [
  ".github",
  "api",
  "apps",
  "cloud",
  "docs",
  "fixtures",
  "marketing",
  "packages",
  "policy",
  "python",
  "scripts",
  "site",
];

/**
 * Documents a reader follows to run, use, or verify the product. Any dead path
 * in these is a bug in the document, not a historical note.
 */
const OPERATIONAL = [
  "README.md",
  "AGENTS.md",
  "docs/HANDBOOK.md",
  "docs/HANDBOOK.cs.md",
  "docs/OPERATIONS.md",
  "docs/BETA.md",
  "docs/GUI-RULES.md",
  "docs/GUI-COMMANDS.md",
  "docs/TUI-WORKSPACE.md",
  "docs/WINDOWS-DESKTOP.md",
  "docs/RELEASE-1.0.1-MATRIX.md",
  "docs/GUI-UPGRADE-DELIVERY.md",
];

/**
 * Records, plans and audits. Dead paths are allowed only when listed here, with
 * the reason. Every entry was checked by hand on 2026-09-26.
 */
const INVENTORY = {
  // The pre-split site tree. STANDARDS sections 5 and 11 and DECISIONS 6b carry
  // a dated note saying so; the reasoning is retained because the emit-root trap
  // in STANDARDS 5 cost this repository a deploy and still applies to any future
  // server-rendered function tree.
  "api/_registry.ts":
    "pre-split site tree, marked as history in STANDARDS 5/11 and DECISIONS 6b",
  "api/_core.ts":
    "pre-split site tree, the truncated-digest prior art in DECISIONS 3",
  "api/_store.ts":
    "pre-split site tree, the non-transactional append prior art in DECISIONS 2",
  "api/registry.ts":
    "pre-split site tree, the HTTP route named in STANDARDS 5 and DECISIONS 6b",
  "api/_registry_http.ts":
    "pre-split site tree, the query surface named in DECISIONS 6b",
  "api/tsconfig.json":
    "pre-split site tree, the rootDir and emit-layout guards in STANDARDS 5 and DECISIONS 6b",

  // WP deliverables that were scoped and never built. An execution plan naming
  // an unbuilt deliverable is honest; a plan claiming it shipped would not be.
  "docs/registry-changelog.md":
    "WP-04b deliverable, scoped in EXECUTION-PLAN and never built",
  "docs/frames.md":
    "WP-13 deliverable, scoped in EXECUTION-PLAN and never built",

  // Confidential by decision. It must leave the tree before open sourcing, so a
  // pointer to it is a record of the decision, not a broken link to fix.
  "docs/GO-TO-MARKET.md":
    "confidential and deliberately absent from the repository; PLAN-GAPS and PLAN-STATUS say so",

  // Paths the strategy documents name as files that would be new. A proposal
  // that says "new docs/SECURITY.md" is honest; a status document claiming the
  // file shipped would not be. VOID-FUTURE-DIRECTION and REVERSE-WEDGE both
  // work this way, and neither claims any of these landed.
  "docs/AAT-CROSSWALK.md":
    "VOID-FUTURE-DIRECTION proposal for a field-by-field AAT crosswalk; never built",
  "docs/SECURITY.md":
    "VOID-FUTURE-DIRECTION proposal for a public guarantees page; never built, and packages/security-notes.md carries the material that did land",
  "docs/otel-genai-proposal.md":
    "VOID-FUTURE-DIRECTION proposal for an OpenTelemetry GenAI proposal; never published",
  "packages/cli/src/standalone-verify.mjs":
    "VOID-FUTURE-DIRECTION proposal for a standalone verifier entry point; it shipped as packages/verifier/verify-ledger.mjs instead",
  "packages/cli/src/tool-signing.ts":
    "VOID-FUTURE-DIRECTION proposal to sign tool definitions MCPS-style; never built",
  "packages/ledger/src/aat.ts":
    "VOID-FUTURE-DIRECTION proposal for an AAT-shaped bundle; never built, and the ledger keeps its own record shape",
  "packages/ledger/src/assertion.ts":
    "REVERSE-WEDGE proposal for a new assertion body type; never built",
  "packages/ledger/src/assertion.test.ts":
    "REVERSE-WEDGE proposal for the assertion test matrix; never built with the type it would have tested",
  "packages/cli/src/assert.ts":
    "REVERSE-WEDGE proposal for void assertion add and verify subcommands; never built",
  "packages/policy/src/attribution.ts":
    "REVERSE-WEDGE proposal for policy attribution of assertions; never built, and attribution itself shipped as packages/ledger/src/attribution.ts",
  "docs/reference/server-json/official-registry-requirements.md":
    "DISTRIBUTION-PATH cites a vendor requirements document fetched from the web, not a file in this tree",
};

/** Plans nobody maintains any more. Each must announce that at its head. */
const SUPERSEDED = {
  "docs/UI-UX-UPGRADE-PLAN.md": "Superseded, 2026-09-26",
};

const read = (file) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");

/** Backticked values that look like a repository file. */
const PATH_LIKE = new RegExp(
  "`([A-Za-z0-9_][A-Za-z0-9._/-]*\\.(?:ts|tsx|mjs|md|json|yaml|yml|css|sql|py|rs|swift|html|plist|entitlements|png|svg|lock))`",
  "g",
);

/** Every markdown file in the tree, with the ones the script tests also cover. */
function markdownFiles() {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const path = join(dir, entry.name).replace(/\\/g, "/");
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".md")) found.push(path);
    }
  };
  for (const root of [...SOURCE_ROOTS, "apps/desktop", "apps/control-plane"]) {
    if (existsSync(root)) walk(root);
  }
  for (const name of [
    "README.md",
    "AGENTS.md",
    "AGENTS.local.md",
    "CONTRIBUTING.md",
    "NOTICE",
  ])
    if (existsSync(name)) found.push(name);
  return [...new Set(found)].sort();
}

/**
 * Dead backticked paths in one document, as `path:line` for an actionable error.
 *
 * Only paths under a SOURCE_ROOT are checked. A bare filename is deliberately
 * NOT resolved, because in prose a bare name is nearly always an example rather
 * than a pointer: `dev.yaml` and `strict.yaml` are sample policy files,
 * `plan.md` and `tui-check.md` are example documents, `keychain.rs` belongs to
 * the macOS app in another repository, and the plans are full of proposed module
 * names like `replay.ts` and `cancel.ts` that were never built. That rule was
 * implemented and measured, and it produced about forty findings of which none
 * was a real defect. A gate with that false positive rate gets switched off
 * within a week, and a switched off gate is worse than no gate, so the precise
 * rule stands and the real bare-name defect in STANDARDS 12 is fixed in the text
 * instead.
 */
function deadPaths(text) {
  const dead = [];
  for (const match of text.matchAll(PATH_LIKE)) {
    const target = match[1];
    if (!SOURCE_ROOTS.some((root) => target.startsWith(`${root}/`))) continue;
    if (existsSync(target)) continue;
    dead.push(`${target}:${text.slice(0, match.index).split("\n").length}`);
  }
  return dead;
}

/**
 * Membership pinned by name, not just by count.
 *
 * Mutation testing found the first version of this gate had a real hole: emptying
 * OPERATIONAL or SUPERSEDED made every check in those tests pass, because a loop
 * over nothing asserts nothing. A count is a weak guard, so the documents that
 * carry the product's operational claims are named here and asserted to be listed.
 * Deleting one from OPERATIONAL is now a failure rather than a silent widening.
 */
const CORE_OPERATIONAL = [
  "README.md",
  "docs/HANDBOOK.md",
  "docs/HANDBOOK.cs.md",
  "docs/OPERATIONS.md",
  "docs/BETA.md",
  "docs/GUI-RULES.md",
  "docs/GUI-COMMANDS.md",
  "docs/TUI-WORKSPACE.md",
  "docs/WINDOWS-DESKTOP.md",
  "docs/RELEASE-1.0.1-MATRIX.md",
];

const files = markdownFiles();

test("the scan found real material", () => {
  // Without this, a broken walker makes every assertion below pass on nothing.
  assert.ok(files.length > 80, `only ${files.length} markdown files found`);
  assert.ok(existsSync("docs/STANDARDS.md"));
  assert.ok(existsSync("docs/UI-UX-UPGRADE-PLAN.md"));
});

test("the document lists are populated and the core ones are still listed", () => {
  assert.ok(
    OPERATIONAL.length >= 10,
    `OPERATIONAL lists only ${OPERATIONAL.length} documents, so the strict check covers almost nothing`,
  );
  // Pinned by count as well as by membership: emptying CORE_OPERATIONAL would
  // otherwise make the membership check below pass on nothing, which is the same
  // hole one level down. Mutation testing found it there first.
  assert.ok(
    CORE_OPERATIONAL.length >= 8,
    `CORE_OPERATIONAL lists only ${CORE_OPERATIONAL.length} documents, so dropping one from OPERATIONAL is invisible`,
  );
  const dropped = CORE_OPERATIONAL.filter(
    (file) => !OPERATIONAL.includes(file),
  );
  assert.deepEqual(
    dropped,
    [],
    `these operational documents are no longer strictly checked:\n${dropped.join("\n")}`,
  );
  assert.equal(
    new Set(CORE_OPERATIONAL).size,
    CORE_OPERATIONAL.length,
    "CORE_OPERATIONAL has a duplicate, so the membership check is weaker than it reads",
  );
  assert.ok(
    Object.keys(INVENTORY).length >= 8,
    `INVENTORY lists only ${Object.keys(INVENTORY).length} paths`,
  );
  assert.ok(
    Object.keys(SUPERSEDED).length >= 1,
    "SUPERSEDED is empty, so no plan is checked for its marker",
  );
  assert.ok(
    "docs/UI-UX-UPGRADE-PLAN.md" in SUPERSEDED,
    "the superseded GUI plan is no longer tracked",
  );
});

test("no operational document points at a file that does not exist", () => {
  const broken = [];
  for (const file of OPERATIONAL) {
    assert.ok(
      existsSync(file),
      `${file} is listed as operational but is missing`,
    );
    for (const dead of deadPaths(read(file)))
      broken.push(`${file}: ${dead}`);
  }
  assert.deepEqual(
    broken,
    [],
    `operational documentation points at files that are not there:\n${broken.join("\n")}`,
  );
});

test("every dead path in a record document is inventoried with a reason", () => {
  const unlisted = [];
  const seen = new Set();
  for (const file of files) {
    if (OPERATIONAL.includes(file)) continue;
    for (const dead of deadPaths(read(file))) {
      seen.add(dead);
      const path = dead.slice(0, dead.lastIndexOf(":"));
      if (!(path in INVENTORY)) unlisted.push(`${file}: ${dead}`);
    }
  }
  assert.deepEqual(
    unlisted,
    [],
    `these references do not resolve and are not in the inventory:\n${unlisted.join("\n")}\n` +
      "Either fix the path, or add it to INVENTORY with a reason if it is real history.",
  );
  assert.ok(
    seen.size > 0,
    "no dead references at all; the scan is probably broken",
  );
});

test("the inventory is not stale", () => {
  // A listed path that now exists is an entry nobody deleted. This is what stops
  // the inventory from becoming a permanent waiver.
  const resolved = Object.keys(INVENTORY)
    .filter((path) => existsSync(path))
    .sort();
  assert.deepEqual(
    resolved,
    [],
    `these inventoried paths exist again, so the entries are stale:\n${resolved.join("\n")}`,
  );
  for (const [path, reason] of Object.entries(INVENTORY)) {
    assert.ok(
      typeof reason === "string" && reason.length > 20,
      `inventory entry ${path} needs a reason a reviewer can act on`,
    );
  }
});

test("every superseded plan says so at its head", () => {
  for (const [file, marker] of Object.entries(SUPERSEDED)) {
    assert.ok(
      existsSync(file),
      `${file} is listed as superseded but is missing`,
    );
    const head = read(file).split("\n").slice(0, 20).join("\n");
    assert.ok(
      head.includes(marker),
      `${file} no longer carries "${marker}" near its head, so a reader cannot tell it is not the plan of record`,
    );
    // And it must point at the plans that replaced it, or the notice is only a
    // dead end.
    assert.match(
      head,
      /PLAN-STATUS\.md/,
      `${file} must point at the plans of record`,
    );
  }
});

test("the pre-split note is in the standards sections that need it", () => {
  // STANDARDS is authoritative and live, so a path it names must either resolve
  // or be covered by a visible note. This pins the note to both sections, because
  // a note in section 5 does not warn a reader who arrived at section 11.
  const standards = read("docs/STANDARDS.md");
  const sections = standards.split(/\n(?=## )/);
  for (const number of ["5", "11"]) {
    const section = sections.find((text) => text.startsWith(`## ${number}.`));
    assert.ok(section, `STANDARDS section ${number} is gone`);
    assert.match(
      section,
      /no longer\s+exist|Tree status/s,
      `STANDARDS section ${number} names pre-split paths without saying they are gone`,
    );
  }
});

test("the inventory covers every pre-split path the pack still names", () => {
  // A guard on the guard: if someone adds a new `api/...` reference to the context
  // pack, it must arrive with its own inventory entry rather than joining the old
  // ones silently.
  const pack = [
    "docs/STANDARDS.md",
    "docs/DECISIONS.md",
    "docs/BUILD-PLAN.md",
    "docs/EXECUTION-PLAN.md",
  ];
  const strays = [];
  for (const file of pack) {
    for (const dead of deadPaths(read(file))) {
      const path = dead.slice(0, dead.lastIndexOf(":"));
      if (!(path in INVENTORY)) strays.push(`${file}: ${dead}`);
    }
  }
  assert.deepEqual(
    strays,
    [],
    `uninventoried dead references in the context pack:\n${strays.join("\n")}`,
  );
});
