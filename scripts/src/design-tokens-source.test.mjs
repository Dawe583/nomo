import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  loadTokens,
  cssBlock,
  swiftBlock,
} from "./build-design-tokens.mjs";

/**
 * The design system has one source and two consumers, and this is the gate that
 * keeps it that way.
 *
 * The web and the native clients previously each carried their own values: the
 * web held seventeen colour properties and no spacing token at all, and the
 * iOS theme held two hand-picked colours with the measured ratios written next
 * to them in a comment. A comment is not a check. This file measures the
 * contrast from the values themselves, so a colour that stops clearing the
 * guideline's minimum fails the build rather than shipping.
 *
 * The minimums are the guideline's, quoted in
 * `docs/APPLE-DESIGN-SYSTEM.md`: 4.5:1 for text up to 17 points, 3:1 at 18
 * points and above or for bold text. Every text role here is body or smaller,
 * so 4.5:1 is the number that applies, and that is the one asserted.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const WEB = join(ROOT, "apps", "control-plane", "ui", "src", "styles.css");
const NATIVE = join(ROOT, "apps", "apple", "VOIDApp", "VoidDesignTokens.swift");
const START = "/* design-tokens:start */";
const END = "/* design-tokens:end */";

const tokens = loadTokens();
const read = (file) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");

/** WCAG relative luminance, from the sRGB coefficients. */
function luminance(hex) {
  const channels = [1, 3, 5].map((offset) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(foreground, background) {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test("the generated web block matches the token source", () => {
  const web = read(WEB);
  const start = web.indexOf(START);
  const end = web.indexOf(END);
  assert.ok(start >= 0 && end > start, "the stylesheet carries both generated markers");
  assert.equal(
    web.slice(start, end + END.length),
    cssBlock(tokens),
    "the web token block has drifted from scripts/design/tokens.json; run node scripts/src/build-design-tokens.mjs",
  );
});

test("the generated native file matches the token source", () => {
  assert.equal(
    read(NATIVE),
    `${swiftBlock(tokens)}\n`,
    "the native token file has drifted from scripts/design/tokens.json; run node scripts/src/build-design-tokens.mjs",
  );
});

test("running the generator twice changes nothing", () => {
  const before = [read(WEB), read(NATIVE)];
  execFileSync(process.execPath, [join(ROOT, "scripts", "src", "build-design-tokens.mjs")], {
    cwd: ROOT,
  });
  assert.deepEqual([read(WEB), read(NATIVE)], before);
});

test("every text role clears the guideline minimum in both appearances", () => {
  // Every pairing a text role can sit on, named rather than generated, because
  // a role that nobody can place on a background is a role with no rule.
  const pairings = [
    ["ink", "canvas"],
    ["ink", "surface"],
    ["ink", "raised"],
    ["muted", "canvas"],
    ["muted", "surface"],
    ["muted", "raised"],
    ["action", "canvas"],
    ["action", "surface"],
    ["danger", "canvas"],
    ["danger", "surface"],
    ["good", "canvas"],
    ["good", "surface"],
    ["on-action", "action"],
  ];
  for (const appearance of ["light", "dark"]) {
    for (const [foreground, background] of pairings) {
      const ratio = contrast(
        tokens.color[foreground][appearance],
        tokens.color[background][appearance],
      );
      assert.ok(
        ratio >= 4.5,
        `${foreground} on ${background} (${appearance}) is ${ratio.toFixed(2)}:1, under the 4.5:1 minimum`,
      );
    }
  }
});

test("the focus ring is visible against both surfaces", () => {
  for (const appearance of ["light", "dark"]) {
    for (const background of ["canvas", "surface"]) {
      const ratio = contrast(
        tokens.color.focus[appearance],
        tokens.color[background][appearance],
      );
      assert.ok(
        ratio >= 3,
        `the focus ring on ${background} (${appearance}) is ${ratio.toFixed(2)}:1, under the 3:1 minimum for a non-text indicator`,
      );
    }
  }
});

test("the spacing is a 4 point rhythm and the targets are floors", () => {
  for (const [name, value] of Object.entries(tokens.space))
    assert.equal(value % 4, 0, `space${name} is ${value}, which is off the 4 point rhythm`);
  assert.ok(tokens.control.touch >= 44, "the touch target floor is 44 points");
  assert.ok(tokens.control.pointer >= 28, "the macOS control floor is 28 points");
  assert.ok(tokens.control.macosMin >= 20, "the macOS absolute minimum is 20 points");
  assert.equal(tokens.layout.horizontalSpacing, 40);
  assert.equal(tokens.layout.minimumVerticalSpacing, 100);
});

test("the type ramp is the guideline's own numbers", () => {
  // The table this mirrors is quoted in docs/APPLE-DESIGN-SYSTEM.md. Only the
  // values a view can actually read are asserted here: the floors and the
  // web mapping, because those are the ones a mistake would ship.
  assert.equal(tokens.type.body.ios[0], 15);
  assert.equal(tokens.type.body.macos[0], 14);
  assert.equal(tokens.type.largeTitle.ios[0], 32);
  assert.equal(tokens.type.$iosMin, 11);
  assert.equal(tokens.type.$macosMin, 10);
  assert.equal(tokens.type.$webBodySize, 15);
  assert.equal(tokens.type.$webLineHeight, 1.5);
  assert.ok(tokens.type.$webMin >= 13, "interface text never drops below 13 pixels on the web");
  for (const [name, style] of Object.entries(tokens.type)) {
    if (name.startsWith("$")) continue;
    for (const platform of ["ios", "macos"]) {
      assert.ok(
        style[platform][0] >= (platform === "ios" ? tokens.type.$iosMin : tokens.type.$macosMin),
        `${name} on ${platform} is ${style[platform][0]}, under that platform's floor`,
      );
      assert.ok(
        style[platform][1] > style[platform][0],
        `${name} on ${platform} has leading that does not exceed its size`,
      );
    }
  }
});

test("the generator refuses to guess where the tokens belong", () => {
  // A missing marker would otherwise mean a silent no-op, which is the one
  // outcome this whole arrangement exists to prevent: three surfaces agreeing
  // with each other and the source disagreeing with all three.
  const before = read(WEB);
  try {
    writeFileSync(WEB, before.replace(START, "/* marker removed */"));
    assert.throws(
      () => execFileSync(process.execPath, [join(ROOT, "scripts", "src", "build-design-tokens.mjs")], { cwd: ROOT, stdio: "pipe" }),
      /marker/,
    );
  } finally {
    writeFileSync(WEB, before);
  }
});
