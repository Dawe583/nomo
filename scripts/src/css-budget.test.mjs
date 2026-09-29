import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A decay guard for the web stylesheets.
 *
 * The design system removed the override relationship between three
 * stylesheets, so the cascade is position rather than import order. That fixed
 * the defect and left the real debt visible: the values are literals. The
 * stylesheet holds 241 font-size literals, 79 border-radius declarations, and
 * several hundred spacing declarations written in pixels. The chat stylesheet
 * holds 13 and 5 more.
 *
 * Migrating those to the token source is several sessions of work and cannot be
 * done in one change without making the diff unreviewable. A budget is the
 * honest instrument in the meantime: the count may fall, and it may never rise.
 * This is the same shape as the per-step CI time budgets, which exist for the
 * same reason, that is, because a number nobody watches is a number that
 * regresses quietly.
 *
 * The number is read from the file, so lowering a budget is a change somebody
 * made on purpose and the diff shows it.
 */

const START = "/* design-tokens:start */";
const END = "/* design-tokens:end */";

/**
 * The budget, and what it was measured on 2026-09-28. Each entry is the count
 * of literal declarations outside the generated token block.
 */
const BUDGET = {
  "styles.css": { "font-size": 241, "border-radius": 79 },
  "chat.css": { "font-size": 13, "border-radius": 5 },
};

const read = (file) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");

/**
 * The stylesheet minus the generated block, which is the source's business.
 * A stylesheet that owns no block of its own is all of its own debt, so the
 * markers are optional here rather than required.
 */
function outsideTokens(file) {
  const text = read(file);
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  if (start < 0 || end <= start) return text.replace(/\/\*[\s\S]*?\*\//g, "");
  const outside = text.slice(0, start) + text.slice(end + END.length);
  return outside.replace(/\/\*[\s\S]*?\*\//g, "");
}

function count(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

for (const [file, budget] of Object.entries(BUDGET)) {
  const path = join("apps", "control-plane", "ui", "src", file);

  test(`${file} does not grow its literal budget`, () => {
    const source = outsideTokens(path);
    const measured = {
      "font-size": count(source, /font-size:\s*[^;]+;/g),
      "border-radius": count(source, /border-radius:\s*[^;]+;/g),
    };
    for (const [kind, ceiling] of Object.entries(budget))
      assert.ok(
        measured[kind] <= ceiling,
        `${file} has ${measured[kind]} ${kind} literals, over the budget of ${ceiling}. A new value belongs in scripts/design/tokens.json, not here; if the budget should fall, change it in this file so the diff shows why.`,
      );
  });

  test(`${file} takes its type from the token block`, () => {
    // The generated block owns the interface size and line height. A rule that
    // sets either on body or root is re-deciding it, which is how the identity
    // layer came to defeat the platform font in the first place.
    const source = outsideTokens(path);
    const root = /(^|\})\s*(:root|html|body)\s*\{([^}]*)\}/g;
    for (const match of source.matchAll(root)) {
      assert.doesNotMatch(
        match[3],
        /(font-size|line-height)\s*:/,
        `${file} sets a type size on ${match[2]}, which the token block owns`,
      );
    }
  });
}

test("the token block is the only place a type size is set on the root", () => {
  const text = read(join("apps", "control-plane", "ui", "src", "styles.css"));
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  assert.ok(start >= 0 && end > start);
  const block = text.slice(start, end);
  assert.match(block, /font-size:\s*15px/);
  assert.match(block, /line-height:\s*1\.5/);
  assert.match(block, /-apple-system/);
});
