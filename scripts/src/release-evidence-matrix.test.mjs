/**
 * The release evidence matrix is the document the release operator reads to
 * decide what may be advertised. Two things must stay true no matter how the
 * implementation moves: every planned requirement still has a row, and the
 * gates that were never witnessed are still recorded as open. A row quietly
 * deleted or quietly promoted to "Done" is a false release claim, so the
 * invariant is asserted here instead of trusted to review.
 *
 * The source-inspection counts the matrix prints (native unit/UI test cases,
 * Apple version metadata) are checked against the repository, so the document
 * cannot drift away from the tree it describes.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const matrix = readFileSync("docs/RELEASE-1.0.1-MATRIX.md", "utf8");
const gaps = readFileSync("docs/PLAN-GAPS.md", "utf8");
const applePlan = readFileSync("docs/APPLE-APPS-PLAN.md", "utf8");
const windows = readFileSync("docs/WINDOWS-DESKTOP.md", "utf8");

/** ID -> [requirement, owner, acceptance gate] */
const rows = new Map(
  matrix
    .split("\n")
    .filter((line) => /^\| [A-Z]\d\d\.\d\d \|/.test(line))
    .map((line) => {
      const [, id, ...cells] = line.split("|").map((cell) => cell.trim());
      return [id, cells];
    }),
);

const range = (prefix, last) =>
  Array.from({ length: last }, (_, index) => `${prefix}.${String(index + 1).padStart(2, "0")}`);

const requiredRows = [
  ...range("P00", 4),
  ...range("P01", 7),
  ...range("P02", 6),
  ...range("P03", 6),
  ...range("P04", 5),
  ...range("P05", 6),
  ...range("P06", 5),
  ...range("P07", 6),
  ...range("P08", 6),
  ...range("P09", 7),
  ...range("P10", 9),
  ...range("P11", 6),
  ...range("D01", 5),
  ...range("D02", 7),
  ...range("D03", 30),
  ...range("D04", 13),
];

/** Requirement families whose acceptance gate has never been witnessed. */
const stillOpen = [
  ...range("P01", 7),
  ...range("P04", 5),
  ...range("P05", 6),
  ...range("P06", 5),
  ...range("P07", 6),
  ...range("P08", 6),
  ...range("P09", 7),
  ...range("P11", 6),
  "P10.09",
  ...range("D01", 5),
  // D02.07 left this list on 2026-09-26: witnessed by
  // `apps/control-plane/ui/src` at 73/73 and `scripts/src/ui-layout.test.mjs`
  // at 22/22, both re-run against current source, with `dist/web` present so
  // the gallery's four layout tests are measured rather than skipped. The
  // other six D02 rows are unwitnessed and stay here.
  ...range("D02", 6),
  ...range("D03", 30),
  ...range("D04", 13),
];

function countSwiftTestCases(directory) {
  return readdirSync(directory)
    .filter((file) => file.endsWith(".swift"))
    .reduce(
      (total, file) => total + (readFileSync(`${directory}/${file}`, "utf8").match(/^[ \t]*func test/gm) ?? []).length,
      0,
    );
}

test("the matrix keeps one row for every planned requirement", () => {
  for (const id of requiredRows) {
    assert.ok(rows.has(id), `missing requirement row ${id}`);
  }
  assert.deepEqual(
    [...rows.keys()].filter((id) => !requiredRows.includes(id)),
    [],
    "matrix contains rows that are not in the approved plan",
  );
});

test("unwitnessed acceptance gates are still recorded as open", () => {
  for (const id of stillOpen) {
    const gate = rows.get(id)?.[2] ?? "";
    assert.match(gate, /^(Open|Out of scope\/open)\b/, `${id} gate reads as completed: ${gate}`);
  }
});

test("no requirement row claims device-tested evidence", () => {
  for (const [id, cells] of rows) {
    if (id === "P00.01") continue;
    assert.doesNotMatch(cells.join(" "), /device-tested/, id);
  }
});

test("the evidence documents print the native test-case counts the tree actually has", () => {
  const unitCases = countSwiftTestCases("apps/apple/VOIDTests");
  const uiCases = countSwiftTestCases("apps/apple/VOIDUITests");

  for (const [name, text] of [
    ["docs/RELEASE-1.0.1-MATRIX.md", matrix],
    ["docs/PLAN-GAPS.md", gaps],
    ["docs/APPLE-APPS-PLAN.md", applePlan],
  ]) {
    // Each document wraps the sentence differently, so compare against the
    // prose with its line wrapping collapsed.
    const prose = text.replace(/\s+/gu, " ");
    assert.match(prose, new RegExp(`\\b${unitCases} \`VOIDTests\` cases`), name);
    assert.match(prose, new RegExp(`\\b${uiCases} \`VOIDUITests\` cases`), name);
  }
});

test("a recorded simulator run is never separated from the current source counts", () => {
  const unitCases = countSwiftTestCases("apps/apple/VOIDTests");
  const uiCases = countSwiftTestCases("apps/apple/VOIDUITests");
  const runClaims = matrix
    .split("\n")
    .filter((line) => /passed `VOID(?:UI)?Tests` \d+\/\d+/.test(line));

  assert.ok(runClaims.length > 0, "the matrix no longer records a simulator run");
  for (const line of runClaims) {
    // A quoted run count that outnumbers the cases in the tree is fabricated
    // evidence, and a run count quoted without the current source counts reads
    // as coverage of the current candidate.
    for (const [, suite, passed, total] of line.matchAll(/passed `(VOID(?:UI)?Tests)` (\d+)\/(\d+)/g)) {
      assert.equal(passed, total, line);
      assert.ok(Number(total) <= (suite === "VOIDTests" ? unitCases : uiCases), line);
    }
    assert.match(line, new RegExp(`\\b${unitCases} \`VOIDTests\``), line);
    assert.match(line, new RegExp(`\\b${uiCases} \`VOIDUITests\``), line);
  }
});

test("the matrix prints the Apple version metadata the project declares", () => {
  const declared = readFileSync("apps/apple/project.yml", "utf8");
  const project = readFileSync("apps/apple/VOID.xcodeproj/project.pbxproj", "utf8");
  const marketing = declared.match(/MARKETING_VERSION:\s*(\S+)/)?.[1];
  const build = declared.match(/CURRENT_PROJECT_VERSION:\s*(\S+)/)?.[1];

  assert.ok(marketing && build);
  assert.match(project, new RegExp(`MARKETING_VERSION = ${marketing.replace(/\./g, "\\.")};`));
  assert.match(project, new RegExp(`CURRENT_PROJECT_VERSION = ${build};`));
  assert.match(matrix, new RegExp(`MARKETING_VERSION=${marketing.replace(/\./g, "\\.")}`));
  assert.match(matrix, new RegExp(`CURRENT_PROJECT_VERSION=${build}`));
  // The Apple project ships no entitlements file, so any matrix sentence that
  // reports an entitlement, App Sandbox or provisioning state would describe
  // something the tree does not contain.
  const entitlements = readdirSync("apps/apple", { recursive: true })
    .filter((entry) => String(entry).endsWith(".entitlements") && !String(entry).includes(".build"));
  assert.deepEqual(entitlements, []);
  assert.match(matrix, /entitlements, or native iOS metadata exists in the repository/);
});

test("the evidence documents keep the physical-device and store boundary explicit", () => {
  const boundary =
    /(physical (?:iPhone|iPad|device)|signed-device|store|TestFlight|provisioning)[^.]{0,90}?(remain|remains|open|unverified|not claimed|is not)/i;

  for (const [name, text] of [
    ["docs/RELEASE-1.0.1-MATRIX.md", matrix],
    ["docs/PLAN-GAPS.md", gaps],
    ["docs/APPLE-APPS-PLAN.md", applePlan],
  ]) {
    // The boundary sentence is line wrapped in these documents, so compare
    // against the prose with its wrapping collapsed.
    assert.match(
      text.replace(/\s+/gu, " "),
      boundary,
      `${name} no longer states that device/store evidence is open`,
    );
  }

  assert.match(
    windows,
    /Windows is out of scope for the VOID 1\.0\.1 delivery/,
    "docs/WINDOWS-DESKTOP.md no longer states the Windows release scope",
  );
  assert.match(
    windows,
    /No Windows download is advertised/,
    "docs/WINDOWS-DESKTOP.md no longer refuses to advertise a Windows download",
  );
});

const NUMBER_WORDS = {
  Two: 2,
  Three: 3,
  Four: 4,
  Five: 5,
  Six: 6,
  Seven: 7,
  Eight: 8,
  Nine: 9,
  Ten: 10,
  Eleven: 11,
  Twelve: 12,
};
const SPELLED = Object.keys(NUMBER_WORDS).join("|");
const ADAPTERS = [
  "filesystem.managed",
  "git.managed",
  "managed-documents",
  "postgres-managed-conformance",
];
// The matrix records superseded runs on purpose, so a count only counts when
// the sentence around it is not marked as history. The window is kept short
// so an unrelated "earlier" in the same sentence cannot silence a live claim.
const SUPERSEDED = /\b(?:superseded|earlier|previously|prior|historical|stale|only|used to|no longer)\b/iu;

/**
 * The desktop crate's macOS test count, counted the way `cargo test` counts
 * it: every `#[test]` in `apps/desktop/src-tauri/src` except the ones inside
 * a module gated `#[cfg(all(test, windows))]`, which no macOS host can build
 * or run. Derived from the source so it tracks the tree.
 */
function countRustTestCases(directory) {
  return readdirSync(directory)
    .filter((file) => file.endsWith(".rs"))
    .reduce((total, file) => {
      const lines = readFileSync(`${directory}/${file}`, "utf8").split("\n");
      const windowsOnly = new Set();
      for (const [index, line] of lines.entries()) {
        if (!/^\s*#\[cfg\(all\(test, windows\)\)\]/u.test(line)) continue;
        let depth = 0;
        let opened = false;
        for (let end = index; end < lines.length; end += 1) {
          for (const character of lines[end]) {
            if (character === "{") {
              depth += 1;
              opened = true;
            } else if (character === "}") depth -= 1;
          }
          if (opened && depth === 0) {
            for (let skipped = index + 1; skipped < end; skipped += 1) windowsOnly.add(skipped);
            break;
          }
        }
      }
      return (
        total +
        lines.filter((line, index) => !windowsOnly.has(index) && line.includes("#[test]")).length
      );
    }, 0);
}

/**
 * `void recovery conformance` emits one scenario per declared operation, so
 * an adapter's scenario count is the operation list in its capability
 * profile.
 *
 * The count is read from the published profile rather than parsed out of the
 * source text. Text parsing missed the postgres profile entirely, because its
 * adapter id is derived from the factory at import rather than written as a
 * literal and its operation list lives in another module, so a profile could
 * be added to the release and this gate would have gone on checking the other
 * three. That is the same defect the profile itself was added to fix: an
 * adapter nothing names.
 *
 * A profile that publishes no operations on this platform is skipped rather
 * than compared, because `git.managed` deliberately publishes none on Windows
 * and this matrix records the macOS run.
 */
async function conformanceScenarioCounts() {
  const { providerProfiles } = await import("../../packages/cli/src/conformance.ts");
  const { resolveProviderProfile } = await import(
    "../../packages/connectors/src/capability-profiles.ts"
  );
  return ADAPTERS.map((id) => {
    const profile = resolveProviderProfile(providerProfiles, id);
    if (profile === undefined) throw new Error(`no published profile for ${id}`);
    return [id, profile.operations.length];
  }).filter(([, count]) => count > 0);
}

/** Collapses the wrapping while remembering the source line of every character. */
function collapseWrapping(text) {
  let prose = "";
  const lineOf = [];
  let line = 1;
  let collapsed = false;
  for (const character of text) {
    if (/\s/u.test(character)) {
      if (!collapsed) {
        prose += " ";
        lineOf.push(line);
        collapsed = true;
      }
      if (character === "\n") line += 1;
      continue;
    }
    collapsed = false;
    prose += character;
    lineOf.push(line);
  }
  return { prose, lineOf };
}

/** The clause holding `at`, which runs to the next sentence or table cell. */
function clauseAt(prose, at) {
  let start = at;
  let end = prose.length;
  for (let index = at; index >= 0; index -= 1) {
    if (/[;|]/u.test(prose[index]) || (prose[index] === "." && prose[index + 1] === " ")) {
      start = index + 1;
      break;
    }
  }
  for (let index = at; index < prose.length; index += 1) {
    if (/[;|]/u.test(prose[index]) || (prose[index] === "." && prose[index + 1] === " ")) {
      end = index;
      break;
    }
  }
  return [prose.slice(start, end).trim(), start, end];
}

/** Every way the matrix states the size of a named, countable suite. */
function suiteCountPatterns() {
  const patterns = [
    ["desktop rust crate", /`cargo test`\s+(\d+)\/\d+/gu],
    ["desktop rust crate", /desktop crate is (\d+)\/\d+/gu],
    ["VOIDTests", /(\d+)\s+`VOIDTests`(?:\s+source)?\s+cases/gu],
    ["VOIDTests", /`VOIDTests`\s+(\d+)\/\d+/gu],
    ["VOIDTests", /`VOIDTests\s+(\d+)\/\d+`/gu],
    ["VOIDUITests", /(\d+)\s+`VOIDUITests`(?:\s+source)?\s+cases/gu],
    ["VOIDUITests", /`VOIDUITests`\s+(\d+)\/\d+/gu],
    ["VOIDUITests", /`VOIDUITests\s+(\d+)\/\d+`/gu],
  ];
  for (const adapter of ADAPTERS) {
    const id = adapter.replace(/\./gu, "\\.");
    patterns.push([adapter, new RegExp(`\`${id}\`[^.\`]{0,60}?(\\d+)\\/\\d+`, "gu")]);
    patterns.push([adapter, new RegExp(`\`${id}\`[^|\`]{0,240}?(${SPELLED}) conformance scenarios`, "gu")]);
    // "4 scenarios, 32 checks, 0 failed" and the older "37 scenarios passed"
    // and "19 passed" all state how many scenarios the adapter has. Collecting
    // every phrasing keeps this line under the same guard as the table rows.
    patterns.push([adapter, new RegExp(`\`${id}\`[^.\`]{0,80}?(\\d+) scenarios`, "gu")]);
    patterns.push([adapter, new RegExp(`\`${id}\`[^.\`]{0,80}?(\\d+) passed`, "gu")]);
  }
  return patterns;
}

test("every suite count the matrix states is the count the tree has, once", async () => {
  const expected = new Map([
    ["VOIDTests", countSwiftTestCases("apps/apple/VOIDTests")],
    ["VOIDUITests", countSwiftTestCases("apps/apple/VOIDUITests")],
    ["desktop rust crate", countRustTestCases("apps/desktop/src-tauri/src")],
    ...(await conformanceScenarioCounts()),
  ]);
  const { prose, lineOf } = collapseWrapping(matrix);
  const stated = new Map([...expected.keys()].map((suite) => [suite, []]));

  for (const [suite, pattern] of suiteCountPatterns()) {
    for (const match of prose.matchAll(pattern)) {
      const count = NUMBER_WORDS[match[1]] ?? match[1];
      if (count === undefined) continue;
      const at = match.index + match[0].lastIndexOf(match[1]);
      const [clause, start, end] = clauseAt(prose, at);
      if (SUPERSEDED.test(prose.slice(Math.max(start, at - 60), at))) continue;
      if (SUPERSEDED.test(prose.slice(at, Math.min(end, at + 100)))) continue;
      stated.get(suite)?.push({ count: Number(count), line: lineOf[at], clause });
    }
  }

  for (const [suite, claims] of stated) {
    const numbers = [...new Set(claims.map((claim) => claim.count))];
    const said = claims
      .map((claim) => `  line ${claim.line}: ${claim.count} — ${claim.clause.slice(0, 90)}`)
      .join("\n");
    assert.ok(claims.length > 0, `the matrix no longer states a count for ${suite}`);
    assert.deepEqual(
      numbers.length > 1 ? [`${suite} is given ${numbers.length} different sizes:\n${said}`] : [],
      [],
      `the matrix must not let two sentences disagree about ${suite}`,
    );
    assert.equal(
      numbers[0],
      expected.get(suite),
      `the matrix says ${suite} has ${numbers[0]}, the tree has ${expected.get(suite)}:\n${said}`,
    );
  }
});
