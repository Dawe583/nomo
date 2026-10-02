/**
 * Writes the product version into every manifest the release gate enumerates.
 *
 * The version used to be a literal repeated in thirteen manifests with a gate
 * pinning the literal, so the first bump broke the gate rather than the release
 * (`docs/VERSIONING-AND-UPDATE-PLAN.md`, section 1). The root manifest is now
 * the one source: this script writes the rest of the tree to match it, and
 * `--check` reports a tree that disagrees without writing anything.
 *
 *     node scripts/src/set-version.mjs X.Y.Z
 *     node scripts/src/set-version.mjs X.Y.Z --check
 *     node scripts/src/set-version.mjs --check
 *
 * Three rules make the result reviewable. The argument is three numeric parts
 * and nothing else, because a setter that accepts a range, a `v` prefix or a
 * prerelease is worse than no setter: it would write a value no manifest field
 * can hold. Each file is written through a temporary file in the same directory
 * and renamed, so an interrupted run cannot leave a manifest half written. And
 * only the version line of each file is touched, so a bump is a thirteen-line
 * diff instead of thirteen reformatted manifests.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Three numeric parts. No leading `v`, no prerelease, no range, no leading zero. */
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

const USAGE = "usage: node scripts/src/set-version.mjs X.Y.Z [--check]";

/**
 * The directories whose manifest carries the product version, derived rather
 * than listed.
 *
 * This lives in the setter and the packaging gate imports it, because the only
 * list that matters is one list both sides read: a second copy is a place to
 * forget a package, and a package the setter misses keeps the old number while
 * the gate passes. The module imports nothing of the gate, so the gate's import
 * graph stays acyclic.
 */
export function versionedManifests(root) {
  const packageRoot = join(root, "packages");
  const packages = existsSync(packageRoot)
    ? readdirSync(packageRoot, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isDirectory() &&
            existsSync(join(packageRoot, entry.name, "package.json")),
        )
        .map((entry) => `packages/${entry.name}`)
    : [];
  return [".", ...packages, "apps/control-plane", "scripts"];
}

/** One manifest as a repository-relative path, for messages and for reading. */
const manifestPath = (root, directory) =>
  directory === "." ? join(root, "package.json") : join(root, directory, "package.json");

const displayPath = (directory) =>
  directory === "." ? "package.json" : `${directory}/package.json`;

/**
 * The manifest text with its top-level version replaced, byte for byte
 * elsewhere.
 *
 * The line is found by indentation rather than by parsing and re-serialising,
 * so key order, indentation width, line endings and every unrelated byte of a
 * hand-maintained manifest survive a bump. A manifest whose first key is not at
 * the start of a line has no indentation to match and is refused rather than
 * rewritten, because guessing is how a release gets a corrupt manifest.
 */
export function rewriteVersion(text, version, path) {
  if (JSON.parse(text).version === version) return text;
  const indent = text.match(/^([ \t]*)"[^"\n]*"[ \t]*:/m)?.[1];
  if (indent === undefined) {
    throw Error(`${path} has no top-level key, so its version line cannot be located`);
  }
  const line = new RegExp(
    `^${indent}"version"[ \\t]*:[ \\t]*"[^"\n]*"([ \\t]*,?)([ \\t]*)(\\r?)$`,
    "m",
  );
  const found = text.match(line);
  if (!found) {
    throw Error(`${path} has no top-level "version" line to rewrite`);
  }
  return text.replace(
    line,
    `${indent}"version": "${version}"${found[1]}${found[2]}${found[3]}`,
  );
}

/** The manifests under `root` that are not at `expected`, in tree order. */
export function disagreeingManifests(root, expected) {
  const drifted = [];
  for (const directory of versionedManifests(root)) {
    const { version } = JSON.parse(readFileSync(manifestPath(root, directory), "utf8"));
    if (version !== expected) drifted.push({ path: displayPath(directory), version });
  }
  return drifted;
}

/** Writes `version` into every manifest, returning the paths it changed. */
export function setVersion(root, version) {
  const changed = [];
  for (const directory of versionedManifests(root)) {
    const path = manifestPath(root, directory);
    const text = readFileSync(path, "utf8");
    const rewritten = rewriteVersion(text, version, path);
    if (rewritten === text) continue;
    // Write beside the target and rename over it: a rename inside one directory
    // is atomic, so a run killed halfway leaves the old manifest or the new
    // one, never a truncated file. The temporary is removed on the way out
    // because a failed write is the one case that leaves it behind.
    const temporary = `${path}.set-version.tmp`;
    try {
      writeFileSync(temporary, rewritten);
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
    changed.push(displayPath(directory));
  }
  return changed;
}

function main(argv) {
  const check = argv.includes("--check");
  const [version, ...extra] = argv.filter((argument) => argument !== "--check");
  if (
    extra.length > 0 ||
    (version === undefined && !check) ||
    (version !== undefined && !VERSION.test(version))
  ) {
    console.error(USAGE);
    return 2;
  }
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const expected =
    version ?? JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  if (check) {
    const drifted = disagreeingManifests(root, expected);
    for (const { path, version: found } of drifted) {
      console.error(`${path} is at ${found}, not ${expected}`);
    }
    if (drifted.length > 0) return 1;
    console.log(`every manifest is at ${expected}`);
    return 0;
  }
  const changed = setVersion(root, expected);
  console.log(
    changed.length === 0
      ? `every manifest already at ${expected}`
      : `set ${changed.length} manifests to ${expected}`,
  );
  return 0;
}

// realpath on both sides: a script reached through a symlinked path still is
// this file, and the comparison is the only thing standing between an import
// and a run.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
