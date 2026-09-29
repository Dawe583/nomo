import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { BEGIN, END, generateWebTokens, renderWebTokens } from "./build-web.mjs";

/**
 * The token document as a gate, rather than as documentation.
 *
 * `docs/design-tokens.json` exists to stop the palette being written three
 * times, and the only thing that makes a shared source shared is that it cannot
 * quietly grow a second vocabulary. Three ways that happens are asserted here.
 *
 * A colour literal outside `colour.roles` and `colour.shadow` means a value has
 * been added that the contrast gate below never measured, so it ships unproven.
 * A spacing value outside the rhythm means the 4 point grid has stopped being a
 * grid. A contrast ratio the document records but the test does not reproduce
 * means the number in the document is decoration: this repository has already
 * had a hand-maintained ratio drift away from the colour it described, and the
 * whole point of moving to a machine-readable source is that the measurement is
 * computed rather than remembered.
 *
 * The last test is the one that makes the others binding on the web. A generator
 * that runs but whose output nobody compares is a suggestion, and the byte
 * comparison here is what turns a hand edit in the stylesheet into a failing
 * test rather than a surprise at the next build.
 */

const SOURCE = "docs/design-tokens.json";
const STYLESHEET = "apps/control-plane/ui/src/styles.css";
const GENERATOR = "scripts/src/build-web.mjs";

const document_ = JSON.parse(readFileSync(SOURCE, "utf8"));
const stylesheet = readFileSync(STYLESHEET, "utf8");

/**
 * A colour literal in any notation the stylesheets could use. `transparent`,
 * `currentColor` and named colours are excluded because they are not values a
 * palette can disagree about, and a gate that flagged them would be noise a
 * reader learns to ignore.
 */
const LITERAL =
  /#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3,4}\b|\brgba?\(|\bhsla?\(|\boklch\(|\boklab\(|\bcolor\(/g;

/** Every leaf of the document with the path that reaches it. */
function leaves(node, path = []) {
  if (node === null || typeof node !== "object") return [[path, node]];
  if (Array.isArray(node))
    return node.flatMap((value, index) => leaves(value, [...path, index]));
  return Object.entries(node).flatMap(([key, value]) =>
    leaves(value, [...path, key]),
  );
}

test("the document carries the five groups phase 1 names", () => {
  // Named rather than inferred, because an empty group satisfies a shape check
  // and produces a stylesheet block that silently lacks a scale.
  const groups = {
    "colour.roles": document_.colour.roles,
    "type.roles": document_.type.roles,
    "spacing.rhythm": document_.spacing.rhythm,
    "radii.roles": document_.radii.roles,
    "control.touchPt": document_.control.touchPt,
  };
  for (const [name, value] of Object.entries(groups)) {
    assert.ok(value !== undefined && value !== null, `${SOURCE} has no ${name}`);
  }
  assert.ok(
    Object.keys(document_.colour.roles).length >= 11,
    "the colour roles have been cut down, and the stylesheet still maps each one",
  );
  assert.ok(
    document_.type.roles.body && document_.type.roles.headline,
    "the type ramp has lost the roles the interface is built from",
  );
  assert.equal(
    document_.spacing.rhythm.length,
    6,
    "the web emits one --space token per rhythm step, so the count is the token count",
  );
  assert.ok(
    document_.type.interfaceFont && document_.type.codeFont,
    "the web needs both faces: the platform UI font and the platform mono face",
  );
});

test("no colour literal sits outside the roles and the shadows", () => {
  // A literal anywhere else is a value the contrast gate cannot see. The path
  // is reported rather than the count, because "3 literals" tells a reader
  // nothing about which group needs the second pair of eyes.
  const allowed = (path) =>
    path[0] === "colour" && (path[1] === "roles" || path[1] === "shadow");
  const strays = [];
  for (const [path, value] of leaves(document_)) {
    if (typeof value !== "string") continue;
    LITERAL.lastIndex = 0;
    for (const match of value.matchAll(LITERAL)) {
      if (!allowed(path)) strays.push(`${path.join(".")}: ${match[0]}`);
    }
  }
  assert.deepEqual(
    strays,
    [],
    `a colour literal outside colour.roles and colour.shadow, where no contrast pair covers it:\n${strays.join("\n")}`,
  );
});

test("every spacing value is a rhythm step, or one of the two documented constants", () => {
  // The two exceptions are the guideline's own and are named in the document's
  // spacing note. They are spelled out here rather than allowed by index, so
  // renaming one of them in the document fails this instead of silently moving
  // the exemption to a different number.
  const rhythm = document_.spacing.rhythm;
  const exceptions = {
    contentGap: document_.spacing.contentGap,
    sectionGap: document_.spacing.sectionGap,
  };
  for (const [name, value] of Object.entries(exceptions)) {
    assert.ok(
      !rhythm.includes(value),
      `spacing.${name} is ${value}, which is already a rhythm step, so the exemption is redundant`,
    );
  }
  const stray = [];
  for (const [path, value] of leaves(document_.spacing)) {
    if (typeof value !== "number") continue;
    if (path[0] === "rhythm") continue;
    if (path[0] === "measure") continue;
    if (Object.values(exceptions).includes(value)) continue;
    stray.push(`${path.join(".")}: ${value}`);
  }
  assert.deepEqual(
    stray,
    [],
    `these spacing values are neither a rhythm step nor one of the two documented constants:\n${stray.join("\n")}`,
  );
  assert.equal(
    rhythm.length,
    new Set(rhythm).size,
    "the rhythm repeats a step, so two --space tokens would hold the same value",
  );
});

/** The WCAG 2.1 relative luminance of a `#rrggbb` value. */
function luminance(hex) {
  const digits = hex.replace("#", "");
  assert.match(
    digits,
    /^[0-9a-fA-F]{6}$/,
    `${hex} is not a six digit hex colour, and the luminance formula needs three channels`,
  );
  const channel = (value) => {
    const raw = parseInt(value, 16) / 255;
    return raw <= 0.04045 ? raw / 12.92 : ((raw + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel(digits.slice(0, 2)) +
    0.7152 * channel(digits.slice(2, 4)) +
    0.0722 * channel(digits.slice(4, 6))
  );
}

/** The contrast ratio between two colours, higher over lower. */
function contrast(foreground, background) {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort(
    (a, b) => b - a,
  );
  return (lighter + 0.05) / (darker + 0.05);
}

test("every recorded contrast pair recomputes, in both appearances", () => {
  // The ratio is computed rather than read back, and the measured numbers are
  // printed, because a gate whose failure message is only "expected 4.5 to be
  // greater than or equal to 4.49" leaves a reader guessing which pairing moved.
  // Reading the printed column is how a reader tells a genuine regression from a
  // minimum that was set too high in the first place.
  const rows = [];
  const failing = [];
  for (const entry of document_.colour.contrast) {
    for (const appearance of ["light", "dark"]) {
      const foreground = document_.colour.roles[entry.foreground]?.[appearance];
      const background = document_.colour.roles[entry.background]?.[appearance];
      assert.ok(
        foreground && background,
        `${SOURCE} names the ${entry.name} pair but the document carries no ${appearance} value for it`,
      );
      const ratio = contrast(foreground, background);
      const measured = ratio.toFixed(2);
      rows.push(
        `  ${appearance.padEnd(5)} ${entry.name.padEnd(26)} ${measured.padStart(6)} : 1   minimum ${entry.minimum}`,
      );
      if (ratio < entry.minimum) {
        failing.push(
          `${entry.name} in ${appearance} is ${measured}:1, below its stated minimum of ${entry.minimum}:1 (${foreground} on ${background})`,
        );
      }
    }
  }
  console.log(
    `\nmeasured contrast, recomputed from ${SOURCE}:\n${rows.join("\n")}\n`,
  );
  assert.deepEqual(
    failing,
    [],
    `a contrast pair the document records as passing does not:\n${failing.join("\n")}`,
  );
});

test("the stylesheet's generated block is what the generator produces", () => {
  // Byte for byte, so a hand edit in the region fails even when it is a valid
  // declaration: the region is a build artefact, and an edit that survives one
  // build and vanishes on the next is worse than one that is rejected outright.
  const expected = renderWebTokens(document_).trimEnd();
  const start = stylesheet.indexOf(BEGIN);
  const end = stylesheet.indexOf(END);
  assert.ok(start !== -1 && end !== -1, `${STYLESHEET} has no generated region`);
  assert.equal(
    stylesheet.indexOf(BEGIN, start + 1),
    -1,
    `${STYLESHEET} has a second begin marker, so the generator would replace only the first region and leave a stale copy behind`,
  );
  const actual = stylesheet.slice(start, end + END.length);
  assert.equal(
    actual,
    expected,
    `${STYLESHEET} does not match what ${GENERATOR} produces from ${SOURCE}. Change the document and rebuild, or restore the generated text.`,
  );
});

test("a regeneration writes the same bytes and adds no diff", () => {
  // The acceptance condition for a generator: running it again changes nothing.
  // Without this, a timestamp, an iteration over an unordered collection, or a
  // formatting difference would pass every other test here and produce a diff
  // on every build that nobody reads.
  //
  // The diff is compared before and after rather than asserted empty, because
  // the tree is legitimately dirty while the change that introduced the tokens
  // is still being written, and a test that fails on an unrelated uncommitted
  // edit is a test people learn to run selectively. What must hold either way is
  // that a regeneration adds nothing: on a clean tree, which is what CI and the
  // acceptance run use, the second diff is empty, because the first one is.
  const diff = () => {
    const result = spawnSync("git", ["diff", "--", STYLESHEET], {
      encoding: "utf8",
    });
    assert.ok(
      result.status === 0 || result.status === 1,
      `git diff could not be run: ${result.stderr}`,
    );
    return result.stdout;
  };

  const tracked = spawnSync("git", ["ls-files", "--error-unmatch", STYLESHEET], {
    encoding: "utf8",
  });
  assert.equal(
    tracked.status,
    0,
    `${STYLESHEET} is not tracked, so an empty diff proves nothing about it`,
  );

  const before = readFileSync(STYLESHEET, "utf8");
  const diffBefore = diff();
  generateWebTokens();
  const after = readFileSync(STYLESHEET, "utf8");
  const diffAfter = diff();

  assert.equal(
    after,
    before,
    `${GENERATOR} is not deterministic: a second run changed ${STYLESHEET}`,
  );
  assert.equal(
    diffAfter,
    diffBefore,
    `a regeneration changed the committed state of ${STYLESHEET}, so the generated text is stale or the generator is not deterministic:\n${diffAfter}`,
  );
  if (diffBefore === "") {
    assert.equal(diffAfter, "", "git diff is not empty on a clean tree");
  }
});
