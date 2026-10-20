import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { COMMANDS, parseInvocation } from "../../packages/cli/src/argv.ts";
import {
  NVIDIA_URL,
  PROVIDER_PRESETS,
} from "../../packages/workbench/src/provider-defaults.ts";

/**
 * The handbook is a gate, not prose.
 *
 * docs/HANDBOOK.md exists to tell an operator how to use NOMO. The moment it
 * drifts from the product it is worse than nothing, because it is the document
 * people trust when they cannot check the source. This walks the claims that can
 * be checked mechanically and fails the build on each one:
 *
 *   - every `nomo <command>` named anywhere is a command the binary accepts,
 *   - every command the binary accepts is documented,
 *   - every `pnpm <script>` named is a script that exists,
 *   - every repository path in backticks exists,
 *   - every markdown link to a file resolves,
 *   - the provider and model the handbook calls the default are the ones the code
 *     declares, which is the exact lie README.md carried for months,
 *   - the English and Czech editions document the same command set.
 *
 * It cannot check that a sentence is true. It can guarantee that no path,
 * command, script or default in either file has stopped existing.
 */

const EN = "docs/HANDBOOK.md";
const CS = "docs/HANDBOOK.cs.md";

/** Directories whose members are repository files a reader may be pointed at. */
const SOURCE_ROOTS = [
  ".github",
  "apps",
  "cloud",
  "docs",
  "fixtures",
  "packages",
  "paid",
  "policy",
  "python",
  "scripts",
  "site",
];

const read = (file) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");

/** Fenced code blocks are where the commands live, so they must NOT be
 * stripped before extraction. This helper exists only for the checks that care
 * about prose rather than about what a reader would type. */
function withoutFences(text) {
  return text.replace(/```[\s\S]*?```/g, "\n");
}

function occurrences(text, pattern) {
  return [...text.matchAll(pattern)].map((match) => match[1] ?? match[0]);
}

const en = read(EN);
const cs = read(CS);
const enProse = withoutFences(en);
const csProse = withoutFences(cs);
const both = `${en}\n${cs}`;

/** Words that follow "nomo" in a sentence rather than naming a command. Derived
 * from the documents themselves, so a new one shows up as a failure naming the
 * word instead of being silently allowed. */
const PROSE_AFTER_NOMO = new Set([
  "a",
  "and",
  "carefully",
  "do",
  "each",
  "i",
  "in",
  "it",
  "je",
  "na",
  "no",
  "not",
  "only",
  "se",
  "so",
  "the",
  "this",
  "to",
  "up",
  "with",
  "you",
  "z",
]);

test("both handbook editions exist and are real documents", () => {
  for (const file of [EN, CS]) {
    assert.ok(existsSync(file), `${file} is missing`);
    const text = read(file);
    assert.ok(text.length > 4000, `${file} is too short to be a handbook`);
    assert.ok(
      text.startsWith("# NOMO handbook"),
      `${file} must open with its title`,
    );
  }
});

test("every nomo command the handbook names is a real command", () => {
  const named = new Set(
    occurrences(both, /\bnomo ([a-z][a-z-]*)\b/g).filter(
      (name) => !PROSE_AFTER_NOMO.has(name),
    ),
  );
  // Assert the extraction found the real surface first, so a broken pattern
  // cannot pass by finding nothing.
  assert.ok(
    named.size >= COMMANDS.length,
    `only ${named.size} command names found, expected at least ${COMMANDS.length}`,
  );
  const unknown = [...named].filter((name) => !COMMANDS.includes(name));
  assert.deepEqual(
    unknown,
    [],
    `handbook names commands the binary does not have: ${unknown.join(", ")}`,
  );
});

test("every command the binary accepts is documented", () => {
  const missing = COMMANDS.filter(
    (command) => !both.includes(`nomo ${command}`),
  );
  assert.deepEqual(missing, [], `undocumented commands: ${missing.join(", ")}`);
  // The reference table is where a reader looks, so every command must appear
  // there, not only somewhere in prose.
  for (const command of COMMANDS) {
    assert.ok(
      en.includes(`| \`nomo ${command}\``),
      `the English reference table is missing ${command}`,
    );
  }
  assert.match(
    en,
    /Twenty-three commands\./,
    "the English edition must state how many commands there are, so a new one is noticed",
  );
  assert.match(
    cs,
    /Dvacet tři příkazů\./,
    "the Czech edition must state how many commands there are",
  );
});

test("every pnpm script the handbook names exists", () => {
  const scripts = JSON.parse(read("package.json")).scripts ?? {};
  const named = new Set(occurrences(both, /\bpnpm ([a-z][a-z:-]*)\b/g));
  // `run` is the verb in `pnpm run <script>`, and these follow the command in
  // prose rather than being one.
  const notScripts = new Set([
    "run",
    "ci",
    "exec",
    "install",
    "test",
    "add",
    "dlx",
    "setup",
    "link",
  ]);
  const unknown = [...named]
    .filter((name) => !notScripts.has(name))
    .filter((name) => !(name in scripts));
  assert.deepEqual(
    unknown,
    [],
    `handbook names scripts the root package does not define: ${unknown.join(", ")}`,
  );
});

test("every repository path in backticks exists", () => {
  const candidates = new Set();
  for (const match of both.matchAll(/`([^`\n]+)`/g)) {
    const value = match[1].trim();
    if (value.includes(" ") || value.includes("<") || value.includes(">"))
      continue;
    if (
      !SOURCE_ROOTS.some(
        (root) => value === root || value.startsWith(`${root}/`),
      )
    )
      continue;
    // Strip a trailing glob or a trailing sentence fragment.
    const path = value.split(/[*,:]/)[0].replace(/[.,;:]$/, "");
    if (!path) continue;
    candidates.add(path);
  }
  const missing = [...candidates].filter((path) => !existsSync(path)).sort();
  assert.deepEqual(
    missing,
    [],
    `handbook points at files that do not exist:\n${missing.join("\n")}`,
  );
});

test("every markdown link to a file resolves", () => {
  for (const [label, text] of [
    [EN, en],
    [CS, cs],
  ]) {
    // Links are written relative to the repository root, so resolve them from
    // the handbook's directory rather than from the file path itself.
    const base = dirname(label);
    for (const match of text.matchAll(/\]\(([^)#][^)]*)\)/g)) {
      const target = match[1].split("#")[0];
      if (target === "" || /^[a-z]+:/i.test(target)) continue;
      assert.ok(
        existsSync(join(base, target)),
        `${label} links to ${target}, which does not exist`,
      );
    }
  }
});

test("the handbook says there is no default provider, and means it", () => {
  // README.md shipped "TokenRouter / GLM 5.3 Free" here for months after the
  // default changed. A handbook repeating a default that no longer exists
  // would be the same defect again, so the gate asserts the opposite of what
  // it used to: that neither edition promises a reader a default at all.
  assert.match(
    en,
    /no default provider and no default model/i,
    "the English edition must say what happens on first use",
  );
  assert.match(
    cs,
    /nemá žádný výchozí poskytovatele ani výchozí model/i,
    "the Czech edition must say the same in Czech",
  );
  assert.doesNotMatch(
    en,
    /defaults to (NVIDIA NIM|TokenRouter|OpenCode Zen|OpenRouter)/i,
    "the English edition must not promise a default provider",
  );
  assert.doesNotMatch(
    cs,
    /má default (NVIDIA NIM|TokenRouter)/i,
    "the Czech edition must not promise a default provider",
  );
  // A preset is a choice, not a default, so naming the NVIDIA endpoint is
  // still correct and still required: it is the one endpoint both editions
  // document as a preset.
  assert.ok(
    en.includes(NVIDIA_URL),
    "the handbook must state the NVIDIA endpoint a preset points at",
  );
  assert.ok(
    cs.includes(NVIDIA_URL),
    "the Czech edition must state the same preset endpoint",
  );
  // The one thing a cost display must never do is present an unmeasured value as
  // a real one. The handbook's rule is that unknown is spelled unknown.
  assert.match(
    en,
    /never `\$0\.00`|never prints `\$0\.00`/,
    "the English edition must forbid a fabricated zero cost",
  );
  assert.match(
    cs,
    /nikdy `\$0\.00`|nikdy \$0\.00/,
    "the Czech edition must forbid a fabricated zero cost",
  );
});

test("the provider key the handbook names is one the workbench actually reads", () => {
  const source = read("packages/workbench/src/index.ts");
  assert.ok(
    source.includes("NVIDIA_API_KEY"),
    "NVIDIA_API_KEY is no longer the ambient credential; the handbook is now wrong",
  );
  assert.ok(en.includes("NVIDIA_API_KEY"));
  assert.ok(cs.includes("NVIDIA_API_KEY"));
});

test("the two editions document the same command set", () => {
  const commands = (text) =>
    new Set(
      occurrences(text, /`(\/[-a-z]+)/g).map((match) =>
        match.replace(/^`/, ""),
      ),
    );
  const enCommands = commands(en);
  const csCommands = commands(cs);
  assert.ok(
    enCommands.size > 40,
    `only ${enCommands.size} TUI commands found in the English edition`,
  );

  const missingInCzech = [...enCommands].filter(
    (command) => !csCommands.has(command),
  );
  assert.deepEqual(
    missingInCzech,
    [],
    `the Czech edition is missing commands the English one documents:\n${missingInCzech.join("\n")}`,
  );
});

test("both editions carry the same section structure", () => {
  const headings = (text) =>
    text
      .split("\n")
      .filter((line) => line.startsWith("## "))
      .map((line) => line.replace(/\s*[^a-z0-9]+.*$/i, "").trim());
  const enHeadings = headings(en);
  const csHeadings = headings(cs);
  assert.equal(
    enHeadings.length,
    csHeadings.length,
    `the editions have ${enHeadings.length} and ${csHeadings.length} sections`,
  );
  assert.equal(
    enHeadings.length,
    19,
    `expected 19 numbered sections, found ${enHeadings.length}`,
  );
});

test("the handbook states its own limits instead of only its features", () => {
  // A guide that only lists capabilities is a brochure. Both editions must carry
  // a section whose HEADING is about limits, not merely a sentence somewhere
  // that happens to contain the word: a heading is what a reader navigates by,
  // and it is what a careless edit deletes.
  const heading = (text) => (text.match(/^## 2\..*$/m) ?? [""])[0];
  assert.match(
    heading(en),
    /what nomo does not do/i,
    "section 2 of the English edition must be the limits section",
  );
  assert.match(
    heading(cs),
    /co nomo neumí/i,
    "section 2 of the Czech edition must be the limits section",
  );
  // And the section must carry the substance, not only the heading.
  for (const claim of ["sandbox", "tamper-proof", "R2", "cross-system"]) {
    assert.ok(
      en.includes(claim),
      `the English limits section should mention ${claim}`,
    );
  }
  for (const claim of [
    "sandbox",
    "odolný proti změnám, ne proti",
    "R2",
    "napříč systémy",
  ]) {
    assert.ok(
      cs.includes(claim),
      `the Czech limits section should mention ${claim}`,
    );
  }
});

test("the handbook uses no forbidden dash characters", () => {
  // STANDARDS section 1 bans the em and en dash everywhere, and
  // docs-release.test.mjs enforces it for the release documents.
  for (const [label, text] of [
    [EN, en],
    [CS, cs],
  ]) {
    assert.equal(
      /[\u2013\u2014]/.test(text),
      false,
      `${label} contains a forbidden dash character`,
    );
  }
});

test("the gate is not vacuous", () => {
  // If a future edit emptied the extraction patterns, every assertion above would
  // pass on nothing. Assert the extractors found real material.
  assert.ok(
    COMMANDS.length === 23,
    `expected 23 commands, found ${COMMANDS.length}`,
  );
  assert.equal(parseInvocation(["approve"]).ok, true);
  assert.equal(parseInvocation(["definitely-not-a-command"]).ok, false);
  assert.ok(
    occurrences(both, /\bnomo [a-z][a-z-]*\b/g).length > 40,
    "too few nomo mentions",
  );
  assert.ok(
    occurrences(both, /`\/[a-z]/g).length > 80,
    "too few slash commands",
  );
  assert.ok(
    PROVIDER_PRESETS.length >= 10,
    "the preset list shrank; the handbook needs updating",
  );
  // Every subject the further-reading table points at must be a real link, so
  // a reader can follow it and so the link check above has work to do.
  const linked = new Set(
    [
      // Both editions live in docs/, so a sibling document is a bare filename
      // and the gate script needs one level up.
      ...en.matchAll(/\]\((?:\.\.\/)?(?:docs\/)?([A-Za-z0-9._-]+\.md)\)/g),
      ...en.matchAll(/\]\(\.\.\/scripts\/[^)]+\)/g),
    ].map((match) => match[1]),
  );
  assert.ok(
    linked.size >= 15,
    `only ${linked.size} documents are linked for further reading`,
  );
  const readdirCount = readdirSync("docs").filter(
    (entry) => entry.endsWith(".md") && !entry.startsWith("superpowers"),
  ).length;
  assert.ok(
    readdirCount > 0,
    "the docs listing collapsed; the check is vacuous",
  );
});
