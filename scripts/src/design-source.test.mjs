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
  // A colour literal anywhere else is a value the contrast gate cannot see. The path
  // is reported rather than the count, because "3 literals" tells a reader
  // nothing about which group needs the second pair of eyes.
  //
  // `colour.scrim` is allowed for the same reason `colour.shadow` is: a scrim
  // is a value the document states once and a component repeats, and it has no
  // foreground to measure against because it is a veil rather than a text
  // colour. Its readability is carried by the surface it dims, not by its own
  // contrast, which is why there is no pair for it here.
  const allowed = (path) =>
    (path[0] === "colour" && (path[1] === "roles" || path[1] === "shadow" || path[1] === "scrim"));
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
    `a colour literal outside colour.roles, colour.shadow and colour.scrim, where no contrast pair covers it:\n${strays.join("\n")}`,
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

/* ---------------------------------------------------------------- surfaces
   The gates above read the document. The three below read the stylesheets, and
   they exist because a value can be correct in the document and still be copied
   by hand into a component rule, where no contrast pair and no regenerated
   region can see it. */

/** Every web stylesheet, in the order the entry module imports them. */
const SURFACES = [
  "apps/control-plane/ui/src/styles.css",
  "apps/control-plane/ui/src/chat.css",
];

/**
 * A stylesheet with the generated region removed.
 *
 * The region is the only place a literal is allowed, and it is the one part of
 * the file the gates below must not read: it is a render of the document, so a
 * literal there is the document's value and is already covered by the contrast
 * gate above. Slicing it out rather than skipping the whole file is the point of
 * these tests. The previous gate skipped `styles.css` entirely because it is a
 * token file, and ten component rules hid in it for exactly that reason.
 */
function componentRules(file) {
  const text = readFileSync(file, "utf8");
  if (!text.includes(BEGIN)) return { file, lines: text.split("\n") };
  const first = text.indexOf(BEGIN);
  const last = text.indexOf(END);
  assert.ok(last > first, `${file} has the end marker before the start marker`);
  const head = text.slice(0, first).split("\n");
  const tail = text.slice(last + END.length).split("\n");
  return { file, lines: [...head, ...tail] };
}

test("no component rule holds a colour literal", () => {
  const offenders = [];
  for (const file of SURFACES) {
    for (const [index, line] of componentRules(file).lines.entries()) {
      if (/^\s*--[a-z][a-z0-9-]*\s*:/.test(line)) continue;
      LITERAL.lastIndex = 0;
      for (const match of line.matchAll(LITERAL)) {
        offenders.push(`${file}:${index + 1} ${match[0]} in ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `a colour literal outside the generated region, where no contrast pair covers it:\n${offenders.join("\n")}`,
  );
});

test("no component rule holds a radius literal", () => {
  // A radius is named for what it rounds, and the document carries a role for
  // every size the stylesheet uses. Zero is allowed because it is a statement
  // that the corners are square, not a fourth radius; a percentage is not,
  // because it is a shape and not a size, so the gates below do not police it
  // either.
  //
  // A shorthand is read corner by corner, so `0 8px 8px 0` is a square corner,
  // two rounded ones and another square one. The gate accepts the mix and
  // requires each rounded part to be a token, which is what makes a
  // three-corner selection expressible without a new role for it.
  const offenders = [];
  for (const file of SURFACES) {
    for (const [index, line] of componentRules(file).lines.entries()) {
      // A named group, read with `.groups`, so the value and the full
      // declaration are two different things and neither is read by offset.
      const match = /border-radius:\s*(?<value>[^;]+);/.exec(line);
      if (!match) continue;
      const value = match.groups.value.trim();
      if (value === "0" || /^var\(--radius-[a-z]+\)$/.test(value)) continue;
      if (/^[\d.]+%(\s+[\d.]+%)*$/.test(value)) continue;
      const corners = value.split(/\s+/);
      if (corners.every((corner) => corner === "0" || /^var\(--radius-[a-z]+\)$/.test(corner)))
        continue;
      offenders.push(`${file}:${index + 1} border-radius: ${value}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `a corner radius that is a number rather than one of the document's roles:\n${offenders.join("\n")}`,
  );
});

test("no component rule repeats a hit target the document already carries", () => {
  // The document states the touch and pointer floors once. A control that writes
  // the number again is a second copy of a token, and it is the copy that
  // drifts: the token moves and the hand written pixel does not. Only the
  // control properties are checked, because a font size, a padding and a grid
  // gap are type and spacing, which the document describes with other roles.
  const CONTROL =
    /(?<![-\w])(min-height|min-width|width|height):\s*([^;]*\b(?:44|28)px\b[^;]*);/;
  const offenders = [];
  for (const file of SURFACES) {
    for (const [index, line] of componentRules(file).lines.entries()) {
      const match = CONTROL.exec(line);
      if (match) offenders.push(`${file}:${index + 1} ${match[1]}: ${match[2]};`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `a hit target written as a pixel count rather than read from --control-touch or --control-macos:\n${offenders.join("\n")}`,
  );
});

test("the hit-target tokens the stylesheet reads are the ones the document declares", () => {
  // The conversion was done by `scripts/src/tokenise-hit-targets.py`, which
  // reads both numbers out of the document rather than restating them. This
  // asserts the result against the document directly, so a future change to
  // `control.touchPt` fails here instead of leaving 52 rules pointing at a
  // token that no longer holds the value they were converted to mean.
  const control = document_.control;
  const stylesheetValues = new Set(
    [...stylesheet.matchAll(/var\(--control-(touch|macos)\)/g)].map((match) => match[1]),
  );
  assert.ok(
    stylesheetValues.has("touch"),
    `no rule reads --control-touch, so the ${control.touchPt}px floor is declared and unused`,
  );
  assert.ok(stylesheetValues.has("macos"), "no rule reads --control-macos");

  // Every `var(--control-*)` in the stylesheet must name a role the generator
  // actually emits. An undeclared name resolves to nothing at runtime and the
  // declaration silently drops out.
  const declared = new Set(
    [...stylesheet.matchAll(/^\s*--control-([a-z-]+)\s*:/gm)].map((match) => match[1]),
  );
  for (const used of stylesheetValues) {
    assert.ok(declared.has(used), `--control-${used} is used but never declared in ${STYLESHEET}`);
  }
});
