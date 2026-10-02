import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BEGIN, END } from "./build-web.mjs";

/**
 * A decay guard for the web stylesheets.
 *
 * The design system removed the override relationship between three
 * stylesheets, so the cascade is position rather than import order. That fixed
 * the defect and left the real debt visible: the values are literals. Measured
 * against `main` at d3287b8 on 2026-10-02, `styles.css` holds 213 `font-size`
 * declarations and 67 `border-radius` declarations outside the generated token
 * block. The chat stylesheet holds 13 and 5 more.
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
 *
 * This counts declarations. It does not police what a value may be: the gate
 * that says a radius has to be `var(--radius-*)` is
 * `scripts/src/design-source.test.mjs`, and the gate that says nothing outside
 * the roles may hold a colour is `scripts/src/design-token.test.mjs`. Those are
 * shape gates and this one is a quantity gate, which is why all three hold at
 * once without any of them being redundant.
 */

const BUDGET = {
  "styles.css": { "font-size": 213, "border-radius": 67 },
  "chat.css": { "font-size": 13, "border-radius": 5 },
};

const read = (file) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");

const surface = (file) => join("apps", "control-plane", "ui", "src", file);

/**
 * The stylesheet minus the generated block, which is the source's business. A
 * stylesheet that owns no block of its own is all of its own debt, so the block
 * is optional here rather than required.
 *
 * The markers are imported from the generator rather than written out, because
 * a second copy of them is a second thing that can drift. The generator renames
 * its own markers, a gate holding the old pair stops slicing the region out,
 * and then it counts the generated declarations as component debt and reports a
 * number nobody can account for. That is not hypothetical: this file arrived
 * with the pair `design-tokens:start` and `design-tokens:end`, which is what the
 * superseded token generator wrote, and on `main` neither string occurs.
 *
 * One marker without the other, or two regions, is refused rather than treated
 * as no block. A half sliced region is the one shape where the count is quietly
 * wrong instead of loudly so.
 */
function outsideTokens(file) {
  const text = read(file);
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (start < 0 && end < 0) return text.replace(/\/\*[\s\S]*?\*\//g, "");
  if (start < 0 || end <= start)
    throw new Error(
      `${file} has one generated-region marker and not the other, so the token block cannot be excluded and every count here would be wrong`,
    );
  if (text.indexOf(BEGIN, start + 1) !== -1 || text.indexOf(END, end + 1) !== -1)
    throw new Error(
      `${file} has a second generated region, so the generator would replace only the first and the gate would measure a stale block`,
    );
  const outside = text.slice(0, start) + text.slice(end + END.length);
  return outside.replace(/\/\*[\s\S]*?\*\//g, "");
}

const count = (source, pattern) => [...source.matchAll(pattern)].length;

/**
 * Every rule whose selector list names one of the three root elements, with the
 * declarations it makes and the at-rule enclosing it.
 *
 * Rules are read by walking the braces rather than by searching for `:root`
 * beside a `{`. The search needed a `}` or the start of the file in front of the
 * selector to anchor it, and in `styles.css` the generated block opens the file
 * behind a run of `@import` lines, so that anchor was never satisfied and the
 * block was never inspected. The check reported nothing while the very
 * declarations it exists to forbid sat two lines above it. Walking the stack has
 * no such blind spot, and it reaches a root rule nested in a `@media` as
 * readily as one at the top level.
 *
 * Neither stylesheet carries a brace inside a string or a `url()`, which is
 * what lets the braces be the nesting. That is asserted below, so a stylesheet
 * that starts using one fails here instead of quietly making the scanner read
 * the wrong rules.
 */
function rootRules(source) {
  const open = [];
  const found = [];
  let start = 0;
  for (let at = 0; at < source.length; at++) {
    const brace = source[at];
    if (brace !== "{" && brace !== "}") continue;
    // What sits between the last boundary and this brace is a prelude only once
    // the statements in front of it are cut away. `styles.css` opens with ten
    // `@import` statements, so reading the whole run as the prelude makes the
    // first rule look like an at-rule and drops it, which is the same blindness
    // the anchored search had.
    const run = source.slice(start, at);
    const statement = Math.max(run.lastIndexOf(";"), run.lastIndexOf("}"));
    const prelude = run.slice(statement + 1).trim();
    if (brace === "{") {
      open.push(prelude);
      start = at + 1;
      continue;
    }
    const own = open.pop();
    const body = source.slice(start, at);
    start = at + 1;
    if (own === undefined || own.startsWith("@")) continue;
    const selectors = own.split(",").map((selector) => selector.trim());
    if (selectors.some((selector) => /^(?::root|html|body)$/.test(selector)))
      found.push({
        selector: own,
        body,
        at: open.length > 0 ? open[open.length - 1] : null,
      });
  }
  return found;
}

/**
 * The root type sizes that are not the token block's, named rather than allowed
 * by shape. A bare exemption is invisible, so each entry carries the file, the
 * at-rule, the selector and the reason, and an entry that stops matching is
 * itself a failure.
 */
const ROOT_TYPE_EXEMPT = [
  {
    file: "styles.css",
    at: "@media (max-width: 767px)",
    selector: ":root",
    why: "the mobile composition steps the interface down one size for a thumb-scale layout; it is scoped to the breakpoint rather than layered over the whole document, which is the shape this gate exists to catch",
  },
];

const keyOf = (file, at, selector) => `${file}|${at ?? ""}|${selector}`;

/** The type declarations a rule body makes, as `property: value` strings. */
function typeDeclarations(body) {
  return [
    ...body.matchAll(/(?:^|[;{])\s*((?:font-size|line-height)\s*:[^;]*)/g),
  ].map((match) => match[1].trim());
}

for (const [file, budget] of Object.entries(BUDGET)) {
  test(`${file} does not grow its literal budget`, () => {
    const source = outsideTokens(surface(file));
    const measured = {
      "font-size": count(source, /font-size:\s*[^;]+;/g),
      "border-radius": count(source, /border-radius:\s*[^;]+;/g),
    };
    for (const [kind, ceiling] of Object.entries(budget))
      assert.ok(
        measured[kind] <= ceiling,
        `${file} has ${measured[kind]} ${kind} literals, over the budget of ${ceiling}. A new value belongs in docs/design-tokens.json, not here; if the budget should fall, change it in this file so the diff shows why.`,
      );
  });

  test(`${file} takes its type from the token block`, () => {
    // The generated block owns the interface size and line height. A rule that
    // sets either on body or root is re-deciding it, which is how the identity
    // layer came to defeat the platform font in the first place. The one
    // exception is named above, so a second one has to be written down.
    const exempt = new Set(
      ROOT_TYPE_EXEMPT.filter((entry) => entry.file === file).map((entry) =>
        keyOf(entry.file, entry.at, entry.selector),
      ),
    );
    const used = new Set();
    for (const rule of rootRules(outsideTokens(surface(file)))) {
      const declared = typeDeclarations(rule.body);
      if (declared.length === 0) continue;
      const key = keyOf(file, rule.at, rule.selector);
      if (exempt.has(key)) {
        used.add(key);
        continue;
      }
      assert.fail(
        `${file} sets ${declared.join(" and ")} on ${rule.selector}${rule.at ? ` inside ${rule.at}` : ""}, which the token block owns`,
      );
    }
    const stale = [...exempt].filter((key) => !used.has(key));
    assert.deepEqual(
      stale,
      [],
      `these named root-type exemptions no longer match a rule, so they are stale entries to delete:\n${stale.join("\n")}`,
    );
  });
}

test("neither stylesheet hides a brace from the rule scanner", () => {
  // The scanner above treats every brace as a block boundary, which is only
  // sound while no brace appears inside a string or a `url()`. Asserted here
  // because the failure it would cause is invisible: the scanner would read the
  // wrong rules and report no violation, which is the same outcome as a
  // stylesheet that is genuinely clean.
  for (const file of Object.keys(BUDGET)) {
    const text = read(surface(file)).replace(/\/\*[\s\S]*?\*\//g, "");
    // A CSS string does not span a line, so the quote pairing is per line.
    // Letting `[^"]*` cross lines instead would pair the closing quote of one
    // `@import` with the opening quote of the next and report every brace in
    // between as being inside a string.
    for (const string of text.match(/"[^"\n]*"/g) ?? [])
      assert.doesNotMatch(
        string,
        /[{}]/,
        `${file} has a brace inside a string, so the rule scanner cannot read it`,
      );
    assert.doesNotMatch(
      text,
      /url\([^)]*[{}]/,
      `${file} has a brace inside a url(), so the rule scanner cannot read it`,
    );
  }
});

test("the rule scanner finds a root rule at the top of a file, behind an at-rule", () => {
  // Proved on a fixture, because `chat.css` legitimately declares no root rule
  // at all. A per-file "the scanner found something" assertion would have to be
  // false for that file to mean anything, and a scanner that finds nothing
  // passes every stylesheet, which is the one failure this whole file cannot be
  // allowed to have.
  const fixture =
    '@import "a.css";\n:root { font-size: 15px; }\n@media (min-width: 1px) { body { line-height: 2 } }\n.card { font-size: 2rem }\n';
  const found = rootRules(fixture);
  assert.deepEqual(
    found.map((rule) => [rule.selector, rule.at]),
    [
      [":root", null],
      ["body", "@media (min-width: 1px)"],
    ],
    "the scanner missed a root rule or invented one",
  );
  assert.equal(typeDeclarations(found[0].body).length, 1);
  assert.equal(typeDeclarations(found[1].body).length, 1);
  assert.equal(
    rootRules(".card { font-size: 2rem }").length,
    0,
    "the scanner reported a rule that is not a root rule",
  );
});

test("the token block is the only place the document's type size is set on the root", () => {
  // The three expectations are read out of the document rather than written
  // down, because the document is where the value is decided. A literal `15px`
  // here would be a second place the interface size lives, and the generator
  // would keep emitting the document's answer while this gate quietly checked a
  // number it had remembered instead. The assertions on the document's own shape
  // are what stop that degrading into "both are absent".
  const type = JSON.parse(read("docs/design-tokens.json")).type;
  assert.equal(
    typeof type.webBodyPx,
    "number",
    "docs/design-tokens.json carries no type.webBodyPx for the web to render",
  );
  assert.equal(
    typeof type.webBodyLineHeight,
    "number",
    "docs/design-tokens.json carries no type.webBodyLineHeight",
  );
  assert.match(
    type.interfaceFont,
    /-apple-system/,
    "the document's interface face is not the platform font",
  );

  const text = read(surface("styles.css"));
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  assert.ok(
    start >= 0 && end > start,
    `${surface("styles.css")} has no generated region, so the interface type size is set nowhere`,
  );
  const block = text.slice(start, end);
  assert.match(block, new RegExp(`font-size:\\s*${type.webBodyPx}px`));
  assert.match(block, new RegExp(`line-height:\\s*${type.webBodyLineHeight}`));
  assert.match(block, /-apple-system/);
});
