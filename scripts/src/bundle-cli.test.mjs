import test, { before, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { isBuiltin } from "node:module";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
let packageDir;
let outDir;
let artifact;
let chunks;
before(async () => {
  packageDir = mkdtempSync(join(tmpdir(), "nomo-bundle-test-"));
  outDir = join(packageDir, "dist");
  writeFileSync(
    join(packageDir, "package.json"),
    read("packages/cli/package.json"),
  );
  const built = await buildBundle({ root, outDir, quiet: true });
  chunks = built.chunks;
  artifact = readFileSync(join(outDir, ENTRY_FILE), "utf8");
});

process.on("exit", () => {
  if (packageDir) rmSync(packageDir, { recursive: true, force: true });
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
  test("keeps the active workspace renderer on Node and local chunks", () => {
    assert.ok(
      chunks.includes("workspace-runner.mjs"),
      "workspace runner chunk is missing",
    );
    const code = readFileSync(join(outDir, "workspace-runner.mjs"), "utf8");
    for (const specifier of bareSpecifiers(code)) {
      if (specifier.startsWith(".") || specifier.startsWith("/")) continue;
      assert.ok(
        isBuiltin(specifier),
        `workspace renderer imports non-Node dependency ${specifier}`,
      );
    }
  });

  test("builds an executable entry chunk with a Node shebang", () => {
    const file = join(outDir, ENTRY_FILE);
    assert.equal(statSync(file).isFile(), true);
    assert.equal(artifact.split("\n")[0], "#!/usr/bin/env node");
    // A shebang without the exec bit is a bin target npm cannot run directly,
    // and npm only chmods the shim, not the file it points at on every platform.
    assert.ok(statSync(file).mode & 0o111, "the entry chunk is not executable");
  });

  test("emits more than one chunk, because one chunk breaks nomo run", () => {
    // `nomo run` imports packages/proxy/bin/nomo-proxy.mjs for its side effect,
    // and that module runs main() at module scope. inliningDynamicImports folds
    // that call into the importing scope, so `nomo run` dies on a temporal dead
    // zone error and `nomo doctor` prints the proxy usage and exits 1. The split
    // is what keeps the entry deferring its graph, so this asserts the shape
    // rather than a size: collapsing the graph is a behavioural regression.
    assert.ok(
      chunks.length > 1,
      `expected a chunk graph, got ${chunks.length} chunk`,
    );
    assert.ok(chunks.includes(ENTRY_FILE), "the entry chunk is missing");
  });

  test("the entry chunk defers the command graph instead of inlining it", () => {
    // The bin entry is documented as answering --help and --version without
    // loading the command surface, so it must not statically import anything
    // but Node builtins. Zero static imports is the strictest form of that:
    // --version reaches its reader through a local chunk, so no third-party
    // module and no SQLite engine is loaded on a help or version request.
    const imports = [...artifact.matchAll(/^import\s.*$/gm)].map(
      (line) => line[0],
    );
    for (const line of imports) {
      assert.match(
        line,
        /from\s*['"]node:/,
        `the entry eagerly imports ${line}`,
      );
    }
    // The graph is deferred rather than absent, which is what keeps `nomo run`
    // and `nomo doctor` working: it stays reachable through a dynamic import.
    assert.match(
      artifact,
      /\bimport\(\s*['"]\.\/dispatch\.mjs['"]\s*\)/,
      "the entry does not defer the command graph",
    );
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
    // Workspace package @nomo/registry uses workspace:*, which npm rejects with
    // EUNSUPPORTEDPROTOCOL. One surviving specifier makes the tarball unusable.
    // Scan every chunk because one import is enough to break consumer installs.
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
      assert.doesNotMatch(
        code,
        /["']workspace:\*/,
        `${chunk} embeds a workspace range`,
      );
    }
  });

  test("imports no sibling workspace package by name", () => {
    // Every sibling must be inlined. A bare workspace-package import would resolve
    // this checkout through the workspace link and nowhere else, so the artifact
    // would prove nothing about a consumer.
    for (const chunk of chunks) {
      const code = readFileSync(join(outDir, chunk), "utf8");
      const workspaceImports = bareSpecifiers(code).filter(
        (specifier) =>
          specifier.startsWith("@void/") || specifier.startsWith("@nomo/"),
      );
      assert.deepEqual(
        workspaceImports,
        [],
        `${chunk} still imports workspace packages rather than inlining them: ${workspaceImports.join(", ")}`,
      );
    }
  });

  test("includes the Workbench provider catalog required at runtime", () => {
    const bundled = join(outDir, "provider-manifest.json");
    assert.ok(
      existsSync(bundled),
      "the runtime chunk needs provider-manifest.json",
    );
    assert.deepEqual(
      readFileSync(bundled),
      readFileSync(join(root, "packages/workbench/src/provider-manifest.json")),
    );
  });

  test("every external package used by the bundle is a CLI runtime dependency", () => {
    const manifest = JSON.parse(read("packages/cli/package.json"));
    const runtimeDependencies = new Set(
      Object.keys(manifest.dependencies ?? {}),
    );
    const packageRoot = (specifier) => {
      if (specifier.startsWith("@"))
        return specifier.split("/").slice(0, 2).join("/");
      return specifier.split("/")[0];
    };
    const imports = new Set();
    for (const chunk of chunks) {
      const code = readFileSync(join(outDir, chunk), "utf8");
      for (const specifier of bareSpecifiers(code)) {
        if (specifier.startsWith(".") || specifier.startsWith("node:"))
          continue;
        imports.add(packageRoot(specifier));
      }
    }
    for (const name of imports) {
      assert.ok(
        runtimeDependencies.has(name),
        `${name} is imported by the packaged CLI but is not declared in packages/cli dependencies`,
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

  test("npm packs only the manifest, distribution chunks and licensed icons", () => {
    // A tarball that also carried src, tests or a node_modules tree would put
    // unbuilt TypeScript and workspace links back in front of the consumer.
    const manifest = JSON.parse(read("packages/cli/package.json"));
    assert.deepEqual(manifest.files, ["dist/"]);
    assert.deepEqual(manifest.bin, { nomo: `./dist/${ENTRY_FILE}` });
    const packed = JSON.parse(
      execFileSync("npm", ["pack", "--dry-run", "--json"], {
        cwd: packageDir,
        encoding: "utf8",
      }),
    );
    const files = packed[0].files.map(({ path }) => path).sort();
    const icons = readdirSync(join(outDir, "icons")).map(
      (icon) => `dist/icons/${icon}`,
    );
    assert.deepEqual(
      files,
      [
        ...chunks.map((chunk) => `dist/${chunk}`),
        "dist/provider-manifest.json",
        ...icons,
        "package.json",
      ].sort(),
    );
  });

  test("the staged executable answers help and version from a clean consumer cwd", () => {
    const consumer = mkdtempSync(join(tmpdir(), "nomo-consumer-test-"));
    try {
      const bin = join(outDir, ENTRY_FILE);
      const help = spawnSync(bin, ["--help"], {
        cwd: consumer,
        encoding: "utf8",
      });
      assert.ifError(help.error);
      assert.equal(help.status, 0, help.stderr);
      assert.match(help.stdout, /^usage: nomo /);
      assert.equal(help.stderr, "");

      const version = spawnSync(bin, ["--version"], {
        cwd: consumer,
        encoding: "utf8",
      });
      assert.ifError(version.error);
      assert.equal(version.status, 0, version.stderr);
      const manifest = JSON.parse(read("packages/cli/package.json"));
      assert.equal(version.stdout, `nomo ${manifest.version}\n`);
      assert.equal(version.stderr, "");
    } finally {
      rmSync(consumer, { recursive: true, force: true });
    }
  });

  test("answers version and config from a bare --out directory", async () => {
    // `--out` is any directory, so the artifact can land somewhere with no
    // packages/cli/package.json one level above it. Reading the manifest there
    // answered `--version` with ENOENT /private/tmp/package.json. The build
    // stamps the version into the bundle, so the manifest stays an optimisation
    // for the shipped layout rather than a requirement for the artifact.
    const parent = mkdtempSync(join(tmpdir(), "nomo-bare-out-test-"));
    const bare = join(parent, "out");
    try {
      await buildBundle({ root, outDir: bare, quiet: true });
      // Third-party dependencies stay external on purpose, so the artifact
      // resolves them from a consumer's node_modules. The parent is exactly
      // that fixture, and decisively carries no package.json.
      symlinkSync(
        join(root, "packages/cli/node_modules"),
        join(parent, "node_modules"),
      );
      const bin = join(bare, ENTRY_FILE);
      const manifest = JSON.parse(read("packages/cli/package.json"));

      const version = spawnSync(bin, ["--version"], {
        cwd: parent,
        encoding: "utf8",
      });
      assert.ifError(version.error);
      assert.equal(version.status, 0, version.stderr);
      assert.equal(version.stdout, `nomo ${manifest.version}\n`);
      assert.doesNotMatch(version.stderr, /ENOENT/);

      // `config` is the other reader: it reaches the same version through the
      // dispatcher, which is why the fix has to be one shared helper rather
      // than a special case in the entry point.
      const config = spawnSync(bin, ["config"], {
        cwd: parent,
        encoding: "utf8",
      });
      assert.ifError(config.error);
      assert.equal(config.status, 0, config.stderr);
      const stamped = manifest.version.replaceAll(".", "\\.");
      assert.match(
        config.stdout,
        new RegExp(`^version: ${stamped} \\(package\\)$`, "m"),
      );
      assert.doesNotMatch(config.stderr, /ENOENT/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("the default output directory is the one the manifest ships", () => {
    assert.equal(DEFAULT_OUT_DIR, "packages/cli/dist");
    assert.match(read("packages/cli/package.json"), /"dist\/"/);
  });
});
