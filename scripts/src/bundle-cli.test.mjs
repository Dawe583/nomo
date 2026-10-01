import test, { before, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { isBuiltin } from "node:module";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildBundle, DEFAULT_OUT_DIR, ENTRY_FILE } from "./bundle-cli.mjs";

const repoRoot = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, repoRoot), "utf8");

const root = fileURLToPath(new URL("../../", import.meta.url));

/**
 * The built artifact, assembled once for the whole file.
 *
 * The bundle is the unit under test, so it is built here rather than read from
 * the working tree: a stale committed artifact would let this file pass while
 * the bundler that produces it was broken. The build is ~1s and the output goes
 * to a temp directory, so nothing is written inside the repository.
 */
let outDir;
let artifact;
let chunks;
before(async () => {
  outDir = mkdtempSync(join(tmpdir(), "void-bundle-test-"));
  const built = await buildBundle({ root, outDir, quiet: true });
  chunks = built.chunks;
  artifact = readFileSync(join(outDir, ENTRY_FILE), "utf8");
});

process.on("exit", () => {
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

/**
 * Every bare specifier the artifact imports, from any import form.
 *
 * Rollup hoists a dynamic import to a top-level `import()` it emits itself, so a
 * regex over `import`/`export ... from`/`import()`/`require()` covers what the
 * bundle actually asks the runtime to resolve. Missing one of these forms is how
 * a `workspace:*` dependency survives a bundler and still breaks an install.
 */
function bareSpecifiers(code) {
  const forms = [
    /(?:^|[\s;}])(?:import|export)[^\n;]*?\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  const found = new Set();
  for (const form of forms) {
    for (const match of code.matchAll(form)) found.add(match[1]);
  }
  return [...found];
}

describe("the distribution bundle", () => {
  test("builds an executable entry chunk with a Node shebang", () => {
    const file = join(outDir, ENTRY_FILE);
    assert.equal(statSync(file).isFile(), true);
    assert.equal(artifact.split("\n")[0], "#!/usr/bin/env node");
    // A shebang without the exec bit is a bin target npm cannot run directly,
    // and npm only chmods the shim, not the file it points at on every platform.
    assert.ok(statSync(file).mode & 0o111, "the entry chunk is not executable");
  });

  test("emits more than one chunk, because one chunk breaks void run", () => {
    // `void run` imports packages/proxy/bin/void-proxy.mjs for its side effect,
    // and that module runs main() at module scope. inliningDynamicImports folds
    // that call into the importing scope, so `void run` dies on a temporal dead
    // zone error and `void doctor` prints the proxy usage and exits 1. The split
    // is what keeps the entry deferring its graph, so this asserts the shape
    // rather than a size: collapsing the graph is a behavioural regression.
    assert.ok(chunks.length > 1, `expected a chunk graph, got ${chunks.length} chunk`);
    assert.ok(chunks.includes(ENTRY_FILE), "the entry chunk is missing");
  });

  test("the entry chunk defers the command graph instead of inlining it", () => {
    // The bin entry is documented as answering --help and --version without
    // loading the command surface, so the entry imports nothing but Node
    // builtins. A third-party import here means node:sqlite or the MCP SDK is
    // loaded on a help request, which is the regression this split prevents.
    const imports = [...artifact.matchAll(/^import\s.*$/gm)].map((line) => line[0]);
    assert.ok(imports.length > 0, "the entry chunk imports nothing at all");
    for (const line of imports) {
      assert.match(line, /from\s*['"]node:/, `the entry eagerly imports ${line}`);
    }
  });

  test("every chunk is valid JavaScript the runtime can parse", () => {
    // `node --check` is the cheapest proof that type stripping produced parseable
    // output, and it runs on the artifacts themselves rather than on a proxy.
    // Only the entry carries a shebang; a chunk with one would be a syntax error.
    for (const chunk of chunks) {
      execFileSync(process.execPath, ["--check", join(outDir, chunk)], {
        stdio: "pipe",
      });
    }
  });

  test("carries no workspace protocol specifier a consumer cannot resolve", () => {
    // This is the assertion the whole bundler exists for. `@void/registry` is
    // declared `workspace:*`, and npm rejects that protocol outright with
    // EUNSUPPORTEDPROTOCOL, so a single surviving specifier makes the tarball
    // uninstallable no matter how correct the rest of it is. Every chunk is
    // scanned, because the graph is only as self-contained as its laziest file.
    for (const chunk of chunks) {
      const code = readFileSync(join(outDir, chunk), "utf8");
      for (const specifier of bareSpecifiers(code)) {
        assert.ok(
          !specifier.includes("workspace:"),
          `${chunk} still imports ${specifier}, which npm cannot resolve`,
        );
      }
      // A `workspace:*` range can also survive as data rather than as an import,
      // for example a manifest-shaped object inlined from source. The one shape
      // that matters is a specifier npm would try to fetch.
      assert.doesNotMatch(code, /["']workspace:\*/, `${chunk} embeds a workspace range`);
    }
  });


  test("imports no sibling workspace package by name", () => {
    // Every sibling must be inlined. A bare `@void/...` import would resolve in
    // this checkout through the workspace link and nowhere else, so the artifact
    // would prove nothing about a consumer.
    for (const chunk of chunks) {
      const code = readFileSync(join(outDir, chunk), "utf8");
      const workspaceImports = bareSpecifiers(code).filter((specifier) =>
        specifier.startsWith("@void/"),
      );
      assert.deepEqual(
        workspaceImports,
        [],
        `${chunk} still imports workspace packages rather than inlining them: ${workspaceImports.join(", ")}`,
      );
    }
  });

  test("every bare import is a Node builtin or a real published package", () => {
    // Each remaining specifier has to be something a consumer's npm can fetch.
    // The test cannot reach a registry, so it asserts the weaker but still
    // decisive property: nothing resolves back into this repository. That is the
    // failure mode which makes an installed bin reach the source tree.
    for (const chunk of chunks) {
      const code = readFileSync(join(outDir, chunk), "utf8");
      for (const specifier of bareSpecifiers(code)) {
        if (specifier.startsWith(".") || specifier.startsWith("/")) continue;
        if (specifier.startsWith("node:")) {
          assert.ok(
            isBuiltin(specifier),
            `${chunk} imports ${specifier}, which looks like a builtin but is not one`,
          );
          continue;
        }
        assert.ok(
          !specifier.includes("/src/") && !specifier.endsWith(".ts"),
          `${chunk} imports ${specifier}, which reaches into a source path and is not a published package`,
        );
      }
    }
  });

  test("the packed file allowlist ships the artifact and nothing else", () => {
    // A tarball that also carried src, tests or a node_modules tree would put
    // unbuilt TypeScript and workspace links back in front of the consumer.
    const manifest = JSON.parse(read("packages/cli/package.json"));
    assert.deepEqual(manifest.files, ["dist/"]);
    assert.deepEqual(manifest.bin, { void: `./dist/${ENTRY_FILE}` });
  });

  test("the default output directory is the one the manifest ships", () => {
    assert.equal(DEFAULT_OUT_DIR, "packages/cli/dist");
    assert.match(read("packages/cli/package.json"), /"dist\/"/);
  });
});