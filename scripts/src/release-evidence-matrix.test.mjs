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
  ...range("D02", 7),
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
