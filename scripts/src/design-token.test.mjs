import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * STANDARDS section 11 as a gate.
 *
 * The design system has four token files, and nothing else may hold a colour.
 * That is not a style preference: it is the only reason the theme toggle works
 * and the only thing keeping separately maintained surfaces from drifting
 * apart. The concrete failure this gate prevents has already happened twice in
 * this repository. `ui.tsx` hardcoded the browser chrome colour as a hex pair
 * that had to be kept in step with `styles.css` by hand, and the static
 * `meta name="theme-color"` in the control plane entry document had drifted to
 * the site palette, so the browser chrome flashed the wrong colour on every load
 * under a page that was not the site.
 *
 * A `meta content` attribute cannot read a CSS variable, so the static value
 * has to stay a literal. The honest response to an exception you cannot remove
 * is to pin it, not to stop checking: this asserts the static value equals the
 * canvas token of the stylesheet that owns the page.
 */

const TOKENS = [
  {
    file: "apps/control-plane/ui/src/styles.css",
    canvas: "--canvas",
    surface: "apps/control-plane/ui",
  },
  {
    file: "apps/control-plane/web/workbench.css",
    canvas: "--paper",
    surface: "apps/control-plane/web",
  },
  { file: "site/styles.css", canvas: "--paper", surface: "site" },
  {
    file: "site/whitepaper/colors.css",
    canvas: "--wp-white",
    surface: "site/whitepaper",
  },
];

/**
 * Files that may hold a colour literal, each with the reason. A bare name here is
 * how an exemption becomes invisible, so the list is asserted to be short.
 */
const LITERAL_EXEMPT = new Map([
  ["site/icon.svg", "brand geometry, fixed by STANDARDS 11"],
  [
    "apps/control-plane/web/icon.svg",
    "the same brand mark, shipped beside the pages it serves",
  ],
]);

const STYLESHEETS = [
  "apps/control-plane/ui/src/styles.css",
  "apps/control-plane/ui/src/chat.css",
  "apps/control-plane/web/workbench.css",
  "site/styles.css",
  "site/whitepaper/colors.css",
];

const read = (file) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const tokenFiles = new Set(TOKENS.map((token) => token.file));

/** A colour literal. `transparent`, `currentColor` and `inherit` are not colours. */
const LITERAL = new RegExp(
  "#[0-9a-fA-F]{8}\\b|#[0-9a-fA-F]{6}\\b|#[0-9a-fA-F]{3,4}\\b|\\brgba?\\(|\\bhsla?\\(",
  "g",
);

/** The token's value in the default, light theme, from the first declaration. */
function lightCanvas(spec) {
  const text = read(spec.file);
  const match = new RegExp(`${spec.canvas}\\s*:\\s*([^;}]+)`).exec(text);
  assert.ok(match, `${spec.file} does not declare ${spec.canvas}`);
  return normalise(match[1]);
}

const normalise = (value) =>
  value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/^#(\w{3})$/, "#$1");

test("the four token files are the ones the standard names", () => {
  assert.equal(
    TOKENS.length,
    4,
    "a fifth token file must be added here, with a reason",
  );
  for (const spec of TOKENS) {
    assert.ok(existsSync(spec.file), `${spec.file} is missing`);
    assert.ok(existsSync(spec.surface), `${spec.surface} is missing`);
    assert.ok(
      read(spec.file).includes(spec.canvas),
      `${spec.file} no longer declares ${spec.canvas}`,
    );
  }
  // A stylesheet that declares tokens but is not in the list would be a fifth
  // place to change a colour, so the count is pinned rather than trusted.
  const declaring = STYLESHEETS.filter((file) =>
    /^\s*--[a-z][a-z0-9-]*\s*:\s*#[0-9a-fA-F]{3,8}/m.test(read(file)),
  );
  const unlisted = declaring.filter((file) => !tokenFiles.has(file));
  assert.deepEqual(
    unlisted,
    [],
    `these stylesheets declare hex tokens but are not token files: ${unlisted.join(", ")}`,
  );
});

test("no component holds a colour literal", () => {
  const files = [];
  const add = (path) => files.push(path.replace(/\\/g, "/"));
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(tsx|ts|css|html|svg)$/.test(entry.name)) add(path);
    }
  };
  for (const dir of [
    "apps/control-plane/ui/src",
    "apps/control-plane/web",
    "site",
  ]) {
    if (existsSync(dir)) walk(dir);
  }
  // The Vite entry document sits beside src/, not inside it.
  for (const entry of readdirSync("apps/control-plane/ui", {
    withFileTypes: true,
  })) {
    if (entry.isFile() && entry.name.endsWith(".html")) {
      add(join("apps/control-plane/ui", entry.name));
    }
  }

  const offenders = [];
  for (const file of files) {
    if (tokenFiles.has(file)) continue;
    if (LITERAL_EXEMPT.has(file)) continue;
    const text = read(file);
    // The one place a literal is unavoidable: a meta content attribute. It is
    // pinned to the canvas token by the next test, not waved through here.
    const withoutMeta = text.replace(
      /(<meta\s+name="theme-color"\s+content=")[^"]*(")/g,
      "$1$2",
    );
    LITERAL.lastIndex = 0;
    for (const match of withoutMeta.matchAll(LITERAL)) {
      const line = withoutMeta.slice(0, match.index).split("\n").length;
      offenders.push(`${file}:${line} ${match[0]}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `colour literals outside a token file:\n${offenders.join("\n")}`,
  );
});

test("the exemption list stays short", () => {
  // Every exemption is a decision someone can abuse. Three is already generous.
  assert.ok(
    LITERAL_EXEMPT.size <= 3,
    `there are ${LITERAL_EXEMPT.size} literal exemptions; each needs a justification here`,
  );
  for (const [file, reason] of LITERAL_EXEMPT) {
    assert.ok(existsSync(file), `${file} is exempted but does not exist`);
    assert.ok(
      reason.length > 15,
      `${file} needs a reason a reviewer can weigh`,
    );
  }
});

test("every static theme-color equals the canvas token of the page it belongs to", () => {
  const pages = [];
  for (const spec of TOKENS) {
    if (!existsSync(spec.surface)) continue;
    for (const entry of readdirSync(spec.surface, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".html")) {
        pages.push({
          file: join(spec.surface, entry.name).replace(/\\/g, "/"),
          spec,
        });
      }
    }
  }
  assert.ok(pages.length >= 5, `only ${pages.length} pages found to check`);
  const wrong = [];
  for (const page of pages) {
    const match = /<meta\s+name="theme-color"\s+content="([^"]*)"/.exec(
      read(page.file),
    );
    if (!match) {
      wrong.push(`${page.file} has no theme-color meta`);
      continue;
    }
    const expected = lightCanvas(page.spec);
    if (normalise(match[1]) !== expected) {
      wrong.push(
        `${page.file} says ${match[1]}, ${page.spec.file} ${page.spec.canvas} is ${expected}`,
      );
    }
  }
  assert.deepEqual(wrong, [], `theme-color has drifted:\n${wrong.join("\n")}`);
});

test("the control plane reads its chrome colour from the token, not a literal", () => {
  // The runtime half of the same contract: the meta value is set from the token
  // after the theme attribute, so it follows the theme rather than a hardcoded
  // pair. A literal here is the defect that started this.
  const source = read("apps/control-plane/ui/src/ui.tsx");
  const setContent = source.slice(
    source.indexOf('meta[name="theme-color"]') - 400,
  );
  assert.ok(
    setContent.includes("--canvas"),
    "ui.tsx no longer reads the --canvas token for the browser chrome colour",
  );
  const body = setContent.slice(0, 600);
  assert.equal(
    /setAttribute\("content",\s*dark\s*\?/.test(body),
    false,
    "ui.tsx sets the theme colour from a hardcoded light/dark pair again",
  );
});

test("every keyframe is v- prefixed", () => {
  const bare = [];
  for (const file of STYLESHEETS) {
    for (const match of read(file).matchAll(/@keyframes\s+([\w-]+)/g)) {
      if (!match[1].startsWith("v-")) bare.push(`${file}: ${match[1]}`);
    }
  }
  assert.deepEqual(
    bare,
    [],
    `keyframes must carry the v- prefix, because Tailwind ships ping, spin, pulse and bounce:\n${bare.join("\n")}`,
  );
});

test("every animation reference resolves to a keyframe that exists", () => {
  const defined = new Set();
  for (const file of STYLESHEETS) {
    for (const match of read(file).matchAll(/@keyframes\s+([\w-]+)/g))
      defined.add(match[1]);
  }
  const timing = new Set([
    "infinite",
    "linear",
    "ease",
    "ease-in",
    "ease-out",
    "ease-in-out",
    "both",
    "forwards",
    "backwards",
    "alternate",
    "running",
    "paused",
    "normal",
    "reverse",
    "none",
    "s",
    "ms",
    "steps",
    "start",
    "end",
    "cubic-bezier",
    "important",
  ]);
  const dangling = [];
  for (const file of STYLESHEETS) {
    const text = read(file);
    for (const match of text.matchAll(
      /animation(?:-name)?\s*:\s*([^;}]+)[;}]/g,
    )) {
      for (const name of match[1].matchAll(/([\w-]+)/g)) {
        const id = name[1];
        if (timing.has(id) || /^\d/.test(id)) continue;
        if (!defined.has(id)) {
          dangling.push(`${file}: animation names ${id}, which is not defined`);
        }
      }
    }
  }
  assert.deepEqual(dangling, [], dangling.join("\n"));
});

test("no keyframe is dead", () => {
  // Two keyframes survived in the control plane with no reference at all. A
  // keyframe nobody animates is a rename waiting to be half done.
  const defined = new Map();
  for (const file of STYLESHEETS) {
    for (const match of read(file).matchAll(/@keyframes\s+([\w-]+)/g)) {
      defined.set(match[1], file);
    }
  }
  const referenced = new Set();
  for (const file of STYLESHEETS) {
    for (const match of read(file).matchAll(
      /animation(?:-name)?\s*:\s*([^;}]+)[;}]/g,
    )) {
      for (const name of match[1].matchAll(/([\w-]+)/g))
        referenced.add(name[1]);
    }
  }
  // Any file that mentions the name counts, so a name used through a composed
  // shorthand or a custom property is not reported as dead.
  const dead = [...defined].filter(([name]) => {
    if (referenced.has(name)) return false;
    for (const file of STYLESHEETS) {
      const uses = read(file).split(name).length - 1;
      const definitions = (
        read(file).match(new RegExp(`@keyframes ${name}\\b`, "g")) ?? []
      ).length;
      if (uses > definitions) return false;
    }
    return true;
  });
  assert.deepEqual(
    [...dead].map(([name, file]) => `${file}: ${name}`),
    [],
    "these keyframes are defined and never referenced",
  );
});

test("every var() reference resolves, or carries an explicit fallback", () => {
  // An undefined custom property does not error. The declaration using it is
  // simply dropped, so a border disappears or a colour falls back to inherited
  // with nothing in the log. styles.css shipped `color: var(--text)` where the
  // token is `--ink`, and the rule was silently dead.
  //
  // A fallback makes a reference legal, which is how the viewport metrics work:
  // the shell sets --mobile-height, --sidebar-width and --context-width at
  // runtime, and the stylesheet must still lay out before that happens.
  const declared = new Set();
  for (const file of STYLESHEETS) {
    // workbench.css writes several declarations on one line, so anchoring to the
    // start of a line reads only the first and reports live tokens as undefined.
    for (const match of read(file).matchAll(
      /(--[a-z][a-z0-9-]*)\s*:\s*[^;{}]+/g,
    )) {
      declared.add(match[1]);
    }
  }
  assert.ok(declared.size >= 20, `only ${declared.size} tokens found declared`);

  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const path = join(dir, entry.name).replace(/\\/g, "/");
      if (entry.isDirectory()) walk(path);
      else if (/\.(css|tsx)$/.test(entry.name)) files.push(path);
    }
  };
  for (const dir of [
    "apps/control-plane/ui/src",
    "apps/control-plane/web",
    "site",
  ]) {
    if (existsSync(dir)) walk(dir);
  }

  const dangling = [];
  for (const file of files) {
    const text = read(file);
    for (const match of text.matchAll(
      /var\(\s*(--[a-z][a-z0-9-]*)\s*([^)]*)\)/g,
    )) {
      const [, token, rest] = match;
      if (rest.trimStart().startsWith(",")) continue; // explicit fallback
      if (declared.has(token)) continue;
      const line = text.slice(0, match.index).split("\n").length;
      dangling.push(`${file}:${line} ${token}`);
    }
  }
  assert.deepEqual(
    dangling,
    [],
    `these tokens are used without a fallback and declared nowhere, so the rule using them is dropped:\n${dangling.join("\n")}`,
  );
});

test("the component paths section 11 tells a reader to read exist", () => {
  // The F3 dead-path gate missed these because a bare `sections/hold.tsx` is not
  // under a source root, so nothing could check it. Parsing the sentence itself
  // is the targeted fix: edit it to name a file that is gone and this fails.
  const standards = read("docs/STANDARDS.md");
  const sentence = standards
    .split("\n")
    .filter(
      (line) =>
        /read `apps\/control-plane\/ui\/src\//.test(line) ||
        /^`(?:recovery-dialog|pages)/.test(line.trim()),
    )
    .join(" ");
  assert.ok(
    sentence.length > 40,
    "the read-before-you-build sentence is gone from STANDARDS 11",
  );
  const base = "apps/control-plane/ui/src";
  const names = [...sentence.matchAll(/`([^`]+\.tsx)`/g)].map(
    (match) => match[1],
  );
  assert.ok(
    names.length >= 3,
    `only ${names.length} components named for a reader to read`,
  );
  const missing = names.filter((name) => {
    const direct = join(base, name);
    return !existsSync(direct) && !existsSync(name);
  });
  assert.deepEqual(
    missing,
    [],
    `STANDARDS 11 tells a reader to read files that do not exist: ${missing.join(", ")}`,
  );
});

test("the scan found real material", () => {
  // Without this a broken walker or pattern makes every assertion above pass on
  // nothing, which is exactly the failure the mutation harness hunts.
  let keyframes = 0;
  for (const file of STYLESHEETS) {
    keyframes += (read(file).match(/@keyframes\s+/g) ?? []).length;
  }
  assert.ok(keyframes >= 7, `only ${keyframes} keyframes found`);
  assert.ok(
    lightCanvas(TOKENS[0]).startsWith("#"),
    "the control plane canvas token is not a hex colour",
  );
  assert.ok(
    read("apps/control-plane/ui/src/styles.css").includes("--shadow-composer"),
    "the shadow tokens are gone, so the five elevated surfaces have no token to read",
  );
  assert.ok(LITERAL_EXEMPT.size >= 1, "the brand exemption disappeared");
});
