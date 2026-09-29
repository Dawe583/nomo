import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { renderSwift } from "./generate-swift-tokens.mjs";

/**
 * The Swift token module has to be a function of the token document.
 *
 * `docs/design-tokens.json` is the one machine-readable source, and
 * `apps/apple/VoidDesignSystem` is a consumer of it the same way the web custom
 * properties are. A consumer that can be edited by hand is a second source, and
 * a second source is a drift waiting for the next person to touch the wrong one.
 *
 * So the consumer is generated, the generator is deterministic, and these tests
 * hold both of those facts. The first one compares the file on disk with what
 * the generator produces from the document right now, byte for byte, so a hand
 * edit fails the gate instead of quietly becoming the truth. The rest check
 * that nothing the document carries was dropped in the translation, that nothing
 * extra was invented, and that the module never has to import UIKit or AppKit,
 * which is the condition the macOS target depends on.
 *
 * The contrast pairs are checked twice on purpose. Here the list is compared
 * with the document's, and in the package's own test target every pair is
 * measured against its minimum in both appearances with the package's own WCAG
 * implementation. A pair the document states and the Swift does not measure is a
 * gate that has stopped gating.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const SOURCE = "docs/design-tokens.json";
const PACKAGE = "apps/apple/VoidDesignSystem";
const GENERATED = `${PACKAGE}/Sources/VoidDesignSystem/VoidTokens.generated.swift`;

const read = (file) => readFileSync(join(ROOT, file), "utf8");
const tokens = JSON.parse(read(SOURCE));

/** One generated section, by the markers the generator wraps it in. */
function section(source, name) {
  const begin = `// --- BEGIN GENERATED SECTION: ${name} ---`;
  const end = `// --- END GENERATED SECTION: ${name} ---`;
  const from = source.indexOf(begin);
  const to = source.indexOf(end);
  assert.ok(from >= 0, `the generated file has no ${name} section`);
  assert.ok(to > from, `the ${name} section has no end marker`);
  return source.slice(from + begin.length, to);
}

/**
 * One declaration, up to the brace that closes it at column zero. The generated
 * module puts every type at column zero, so the closing brace is unambiguous
 * and the body can be read without a parser.
 */
function declaration(source, name) {
  const from = source.indexOf(`public enum ${name}`);
  assert.ok(from >= 0, `the generated file declares no ${name}`);
  const to = source.indexOf("\n}", from);
  assert.ok(to > from, `the ${name} declaration has no closing brace`);
  return source.slice(from, to);
}

/** The case names of a generated enum, in the order the document lists them. */
function cases(source, name) {
  return [...declaration(source, name).matchAll(/^ {4}case (\w+)$/gm)].map(
    (match) => match[1],
  );
}

/** Every `static let name: CGFloat = value` in a section, as a name to number map. */
function constants(source, name) {
  const found = new Map();
  for (const [, key, value] of section(source, name).matchAll(
    /static let (\w+): CGFloat = ([\d.]+)/g,
  )) {
    found.set(key, Number(value));
  }
  return found;
}

test("the generated Swift is byte identical to what the generator produces", () => {
  assert.equal(read(GENERATED), renderSwift(tokens));
});

test("every colour role in the document is a case, and nothing else is", () => {
  assert.deepEqual(
    cases(read(GENERATED), "VoidColorRole"),
    Object.keys(tokens.colour.roles),
  );
});

test("every type role in the document is a case, and nothing else is", () => {
  assert.deepEqual(
    cases(read(GENERATED), "VoidTypeRole"),
    Object.keys(tokens.type.roles),
  );
});

test("every weight the document uses is a case, and nothing else is", () => {
  const used = [
    ...new Set(
      Object.values(tokens.type.roles).flatMap((role) =>
        [role.ios, role.macos].flatMap((metrics) =>
          [metrics.weight, metrics.emphasised].filter(Boolean),
        ),
      ),
    ),
  ];
  assert.deepEqual(cases(read(GENERATED), "VoidTypeWeight"), used);
});

test("the spacing rhythm is the document's rhythm, and every step has a name", () => {
  const generated = read(GENERATED);
  const named = constants(generated, "VoidSpacing");
  const rhythm = [
    ...section(generated, "VoidSpacing").matchAll(
      /static let rhythm: \[CGFloat\] = \[([\d., ]+)\]/g,
    ),
  ].map((match) => match[1].split(",").map(Number));
  assert.deepEqual(rhythm, [tokens.spacing.rhythm]);
  for (const step of tokens.spacing.rhythm) {
    assert.equal(named.get(`step${step / 4}`), step, `no name carries ${step}`);
  }
  assert.equal(
    [...named.keys()].filter(
      (key) => key.startsWith("step") && /^\d+$/.test(key.slice(4)),
    ).length,
    tokens.spacing.rhythm.length,
    "the generated file names a step the document does not carry",
  );
});

test("the spacing constants outside the rhythm are the ones the document states", () => {
  const named = constants(read(GENERATED), "VoidSpacing");
  assert.equal(named.get("contentGap"), tokens.spacing.contentGap);
  assert.equal(named.get("sectionGap"), tokens.spacing.sectionGap);
});

test("every radius role in the document is a case, and nothing else is", () => {
  assert.deepEqual(
    cases(read(GENERATED), "VoidRadiusRole"),
    Object.keys(tokens.radii.roles),
  );
});

test("every control size in the document is a constant, and nothing else is", () => {
  const expected = new Map([
    ["touchPoints", tokens.control.touchPt],
    ["macOSPoints", tokens.control.macosPt],
    ["macOSMinimumPoints", tokens.control.macosMinimumPt],
    ["webTouchPixels", tokens.control.webTouchPx],
  ]);
  assert.deepEqual(constants(read(GENERATED), "VoidControlMetrics"), expected);
});

test("the contrast pairs in the generated file are the document's, in order", () => {
  const pairs = [
    ...section(read(GENERATED), "VoidContrastPair").matchAll(
      /VoidContrastPair\(name: "([^"]+)", foreground: \.(\w+), background: \.(\w+), minimum: ([\d.]+)\)/g,
    ),
  ].map(([, name, foreground, background, minimum]) => ({
    name,
    foreground,
    background,
    minimum: Number(minimum),
  }));
  assert.deepEqual(
    pairs,
    tokens.colour.contrast.map((pair) => ({ ...pair })),
  );
});

test("no Swift file in the package imports UIKit or AppKit", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(ROOT, dir), {
      withFileTypes: true,
    })) {
      const path = `${dir}/${entry.name}`;
      // Build products are copies of these files, not sources, and walking
      // them would only measure how long the last build took.
      if (entry.name === ".build") continue;
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".swift")) {
        const text = readFileSync(join(ROOT, path), "utf8");
        for (const [index, line] of text.split("\n").entries()) {
          if (/^\s*import\s+(UIKit|AppKit)\b/.test(line)) {
            offenders.push(`${path}:${index + 1} ${line.trim()}`);
          }
        }
      }
    }
  };
  walk(PACKAGE);
  assert.deepEqual(
    offenders,
    [],
    `platform colour imports:\n${offenders.join("\n")}`,
  );
});

test("the package's own test target measures every contrast pair", (t) => {
  const toolchain = spawnSync("swift", ["--version"], { encoding: "utf8" });
  if (toolchain.error || toolchain.status !== 0) {
    // The gate runs on a Linux job with no Swift toolchain, so the measurement
    // belongs to the package's own suite rather than to this one. The list
    // itself is still compared with the document above.
    t.skip("no Swift toolchain on this host");
    return;
  }
  const result = spawnSync(
    "swift",
    [
      "test",
      "--package-path",
      join(ROOT, PACKAGE),
      "--filter",
      "VoidContrastTests",
    ],
    { encoding: "utf8", timeout: 900_000 },
  );
  assert.equal(
    result.status,
    0,
    `the Swift contrast gate did not pass:\n${result.stdout}${result.stderr}`,
  );
  assert.match(result.stdout, /Executed \d+ tests, with 0 failures/);
});

test("the generated file is bracketed by markers naming the generator and the document", () => {
  const text = read(GENERATED);
  assert.match(
    text,
    /^\/\/ --- BEGIN GENERATED BY scripts\/src\/generate-swift-tokens\.mjs FROM docs\/design-tokens\.json ---$/m,
  );
  assert.match(
    text,
    /^\/\/ --- END GENERATED BY scripts\/src\/generate-swift-tokens\.mjs FROM docs\/design-tokens\.json ---$/m,
  );
});
