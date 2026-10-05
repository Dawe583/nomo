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
  // The closed paid directory. Named here so a path a reader is pointed at
  // inside it is existence-checked like any other, rather than slipping past a
  // gate that only knows the open side.
  "paid",
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
  // Named by SURFACES-COVERAGE as one of the five files it read in a marketing
  // companion checkout, not as a path in this repository. The same pre-split
  // site tree, the same reason.
  "api/waitlist.ts":
    "pre-split site tree, read in a companion checkout named by SURFACES-COVERAGE",

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

  // The Slack channel implementation moved to the closed `paid/` directory on
  // 2026-10-03, so its Apache 2.0 path is history rather than a broken link.
  // DECISIONS 5 names the old path as the shipped-open collision that closed,
  // and the dated strategy snapshot is an inventory of the tree as it stood
  // that day; neither claim is falsified by the file having moved.
  "packages/policy/src/channels/slack.ts":
    "moved to paid/channels/slack.ts on 2026-10-03; DECISIONS 5 cites the old path as the shipped-open collision this closed",
  "packages/policy/src/channels/slack.test.ts":
    "moved to paid/channels/slack.test.ts on 2026-10-03 with the implementation, and is listed in the dated 2026-09-30 coverage snapshot",

  // Two responsive stylesheets that were merged into `styles.css` and are named
  // by documents that predate the merge. `PLATFORM-REDESIGN-PLAN` and
  // `VOID-DESIGN-SYSTEM-V1` describe a surface that existed, and `MOBILE-LAYOUT-QA`
  // reports measurements taken against it. The reasoning about mobile layout
  // that those documents carry is still the reasoning worth having; the file
  // references are history, and the stylesheet those measurements describe is
  // the same rules under a different filename.
  "apps/control-plane/ui/src/mobile.css":
    "responsive rules merged into styles.css; MOBILE-LAYOUT-QA and VOID-DESIGN-SYSTEM-V1 record measurements taken against the standalone file",
  "apps/control-plane/ui/src/ascii.css":
    "ASCII-art mode merged into styles.css; PLATFORM-REDESIGN-PLAN describes the split that no longer exists",
  // Preserved-lane triage, 2026-10-05. These paths are named in
  // docs/PRESERVED-LANES.md precisely because they do not exist in main: the
  // document's subject is work held only on remote branches, and a citation
  // that resolved would point at something other than what it claims.
  "packages/cli/src/export/verify.ts":
    "held only on preserve/lane-cli-ops and preserve/lane-cli-wire2; recorded in PRESERVED-LANES as unreleased work",
  "packages/cli/src/export/verify.test.ts":
    "held only on preserve/lane-cli-ops and preserve/lane-cli-wire2; recorded in PRESERVED-LANES as unreleased work",
  "packages/cli/src/config/egress.ts":
    "held only on preserve/lane-cli-ops and preserve/lane-cli-wire2; recorded in PRESERVED-LANES as unreleased work",
  "packages/cli/src/config/egress.test.ts":
    "held only on preserve/lane-cli-ops and preserve/lane-cli-wire2; recorded in PRESERVED-LANES as unreleased work",
  "packages/cli/src/doctor/status.ts":
    "held only on preserve/lane-cli-ops and preserve/lane-cli-wire2; recorded in PRESERVED-LANES as unreleased work",
  "packages/cli/src/doctor/status.test.ts":
    "held only on preserve/lane-cli-ops and preserve/lane-cli-wire2; recorded in PRESERVED-LANES as unreleased work",
  "packages/cli/src/version/version.ts":
    "held only on preserve/lane-cli-ops and preserve/lane-cli-wire2; recorded in PRESERVED-LANES as unreleased work",
  "packages/cli/src/version/version.test.ts":
    "held only on preserve/lane-cli-ops and preserve/lane-cli-wire2; recorded in PRESERVED-LANES as unreleased work",
  "docs/plans/2026-09-15-managed-git-recovery.md":
    "the only uniquely-held file on upgrade/git-managed; recorded in PRESERVED-LANES as the one document to salvage from that branch",
  "apps/control-plane/web/styles/mobile-ascii.css":
    "held only on preserve/lane-mobile-ascii, unreferenced by anything in main; recorded in PRESERVED-LANES as finished accessibility work that was never integrated",
  "apps/control-plane/web/components/mobile-ascii.js":
    "held only on preserve/lane-mobile-ascii, unreferenced by anything in main; recorded in PRESERVED-LANES as finished accessibility work that was never integrated",
};

/** Plans nobody maintains any more. Each must announce that at its head. */
const SUPERSEDED = {
  "docs/UI-UX-UPGRADE-PLAN.md": "Superseded, 2026-09-26",
};

const read = (file) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");

/**
 * Backticked values that look like a repository file.
 *
 * A line-number suffix is allowed, because writing `some/file.ts:385` is the
 * natural form of a citation and it is the form the documents actually use.
 * The suffix is captured separately and stripped before the existence check,
 * so a line-numbered citation is verified rather than silently ignored: the
 * pattern used to require a backtick straight after the extension, which meant
 * the most common way to cite a file matched nothing at all.
 */
const PATH_LIKE = new RegExp(
  "`([A-Za-z0-9_][A-Za-z0-9._/-]*\\.(?:ts|tsx|mjs|md|json|yaml|yml|css|sql|py|rs|swift|html|plist|entitlements|png|svg|lock|sh))(?::(\\d+))?`",
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
      if (!Object.hasOwn(INVENTORY, path)) unlisted.push(`${file}: ${dead}`);
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
      if (!Object.hasOwn(INVENTORY, path)) strays.push(`${file}: ${dead}`);
    }
  }
  assert.deepEqual(
    strays,
    [],
    `uninventoried dead references in the context pack:\n${strays.join("\n")}`,
  );
});

/**
 * The pointer must not carry the values it points away from.
 *
 * `GUI-RULES.md` stacked three visual directions by date, named colours and
 * named fonts, and `STANDARDS.md` separately required monospace for every
 * label, which the same file forbids elsewhere. Both were corrected by hand
 * once and both drift back within a release, because a document that repeats a
 * value is one more place to fix it. The design system owns the values and the
 * token file owns the system, so the gate is that the pointer owns none: a
 * literal, or a family from a direction a decision already removed, fails.
 *
 * Naming the word "monospaced" is not the defect, because the surviving rule
 * needs it, so the standards check looks for a statement pairing it with an
 * interface word the old rule covered. A decision log needs the same ordering,
 * because the newest answer governs and a replacement written above the one it
 * replaces leaves the pack with two authorities and no way to tell which is
 * current.
 */

/** Faces a superseded direction named, and the platform faces a claim cannot. */
const SUPERSEDED_FACES = [
  "Inter",
  "Instrument Serif",
  "JetBrains Mono",
  "SF Pro",
  "system-ui",
];

/** Interface words the removed monospace rule covered. */
const INTERFACE_WORDS = [
  "label",
  "kicker",
  "tag",
  "button",
  "table header",
  "caption",
  "number",
  "status word",
];

/** The newest decision in the pack. Renaming that heading renames this. */
const NEWEST_DECISION =
  "## Hosted recovery execution is the paid side; the proof stays free, 2026-10-04";

const MONO_FOR_INTERFACE = /\bmono\w*/i;
const NAMES_INTERFACE_WORD = new RegExp(
  `\\b(?:${INTERFACE_WORDS.join("|")})\\b`,
  "i",
);

test("the pointer names no value, and the newest decision is the last one", () => {
  // Pinned by count, because a loop over an emptied list asserts nothing. That
  // hole is why the document lists above carry CORE_OPERATIONAL.
  assert.ok(
    SUPERSEDED_FACES.length >= 5,
    `SUPERSEDED_FACES lists only ${SUPERSEDED_FACES.length} faces, so a named font can pass`,
  );
  assert.ok(
    INTERFACE_WORDS.length >= 8,
    `INTERFACE_WORDS lists only ${INTERFACE_WORDS.length} words, so the monospace check covers almost nothing`,
  );

  // Global, so a family name wrapped across a line break is still one match,
  // the way deadPaths scans a whole document rather than a line at a time.
  const literals = [
    [/#[0-9a-f]{3,8}\b/gi, "a hex colour"],
    [/\b(?:rgba?|hsla?)\(/gi, "an rgb or hsl literal"],
    [
      new RegExp(
        `\\b(?:${SUPERSEDED_FACES.map((face) => face.replace(" ", "\\s+")).join("|")})\\b`,
        "gi",
      ),
      "a named font family",
    ],
  ];
  const claims = [];
  const gui = read("docs/GUI-RULES.md");
  for (const [pattern, what] of literals) {
    for (const match of gui.matchAll(pattern)) {
      const line = gui.slice(0, match.index).split("\n").length;
      claims.push(`docs/GUI-RULES.md:${line}: ${what}: ${match[0]}`);
    }
  }
  assert.deepEqual(
    claims,
    [],
    `the GUI pointer restates a value the design system owns:\n${claims.join("\n")}\n` +
      "Delete the value and point at docs/APPLE-DESIGN-SYSTEM.md instead.",
  );

  // Statement by statement, not line by line: the removed rule wrapped between
  // "mono for everything else:" and the list of interface words, so a per-line
  // scan passed the exact text this gate exists to reject. A bullet, and the
  // wrapped lines inside it, is the unit a reader takes the rule in.
  const BULLET = /^\s*[-*+] /;
  const lines = read("docs/STANDARDS.md").split("\n");
  const offenders = [];
  let start = 0;
  for (let i = 0; i <= lines.length; i++) {
    const bullet = i < lines.length && BULLET.test(lines[i]);
    const blank = i < lines.length && lines[i].trim() === "";
    if (!bullet && !blank && i !== lines.length) continue;
    const statement = lines.slice(start, i).join(" ");
    if (MONO_FOR_INTERFACE.test(statement) && NAMES_INTERFACE_WORD.test(statement))
      offenders.push(`docs/STANDARDS.md:${start + 1}`);
    // A bullet opens the next statement; a blank line only closes this one.
    start = bullet ? i : i + 1;
  }
  assert.deepEqual(
    offenders,
    [],
    `these statements require a monospaced face for interface text:\n${offenders.join("\n")}\n` +
      "A monospaced face is for code, identifiers and numeric columns.",
  );

  // Phase 0 row 1 promised this ordering and nothing enforced it, so the newest
  // answer is pinned by name rather than by position in a table somewhere else.
  const dated = [
    ...read("docs/DECISIONS.md").matchAll(/^## .*\d{4}-\d{2}-\d{2}.*$/gm),
  ].map((match) => match[0].trim());
  assert.ok(
    dated.length > 0,
    "docs/DECISIONS.md has no dated section, so no decision is pinned as current",
  );
  assert.equal(
    dated.at(-1),
    NEWEST_DECISION,
    `the last dated section in docs/DECISIONS.md is "${dated.at(-1)}", not "${NEWEST_DECISION}", so the log ends on a decision a later one already replaced`,
  );
});
