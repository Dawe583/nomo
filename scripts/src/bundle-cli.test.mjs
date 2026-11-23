import test, { before, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { isBuiltin } from "node:module";
import {
  chmodSync,
  existsSync,
  mkdirSync,
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

/**
 * One MCP session over the stdio transport, spoken as newline-delimited
 * JSON-RPC.
 *
 * The SDK client is a CLI runtime dependency and this package does not declare
 * it, so the test speaks the protocol the transport actually reads rather than
 * borrowing a client from another package's node_modules. That is also the
 * stronger assertion: what has to work is the handshake an MCP host performs,
 * not what one SDK build happens to send.
 */
function mcpSession(bin, args, env) {
  const child = spawn(process.execPath, [bin, ...args], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  let buffer = "";
  let stderr = "";
  let nextId = 1;
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    for (
      let index = buffer.indexOf("\n");
      index >= 0;
      index = buffer.indexOf("\n")
    ) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const settle = pending.get(message.id);
      if (!settle) continue;
      pending.delete(message.id);
      settle(message);
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const request = (method, params) => {
    const id = nextId;
    nextId += 1;
    return new Promise((resolve, reject) => {
      // A server that refused to serve has already exited, so a bounded wait
      // is what turns that into the refusal text instead of a hung suite.
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`no response to ${method}\n${stderr}`));
      }, 30_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  };
  return {
    request,
    notify(method) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
    },
    stderr: () => stderr,
    close() {
      child.stdin.end();
      child.kill();
    },
  };
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

  test("completes the recovery MCP handshake from a bare --out directory with a retained key", async () => {
    // The question `--version` and `config` could not answer: the bundle has to
    // serve the recovery MCP surface from the same bare layout, with the
    // retained signing key it must adopt rather than mint. A server that cannot
    // read that key refuses to serve, so a silent regeneration here would be a
    // second identity over the same signed history.
    const parent = mkdtempSync(join(tmpdir(), "nomo-bare-mcp-test-"));
    const bare = join(parent, "out");
    const workspace = join(parent, "project");
    const state = join(parent, "state");
    const keys = join(state, "keys");
    const keyFile = join(keys, "dev-ed25519.pkcs8");
    const config = join(parent, "recovery.json");
    let session;
    try {
      await buildBundle({ root, outDir: bare, quiet: true });
      symlinkSync(
        join(root, "packages/cli/node_modules"),
        join(parent, "node_modules"),
      );
      mkdirSync(workspace, { recursive: true });
      writeFileSync(join(workspace, "file.txt"), "before\n");
      // The key and its directory are created the way the ledger hardening
      // expects them (0700 parent, 0600 file): a retained key refused for its
      // permissions would prove nothing about the bundle.
      mkdirSync(keys, { recursive: true, mode: 0o700 });
      chmodSync(state, 0o700);
      chmodSync(keys, 0o700);
      const { privateKey } = generateKeyPairSync("ed25519");
      writeFileSync(
        keyFile,
        privateKey.export({ format: "der", type: "pkcs8" }),
        { mode: 0o600 },
      );
      const retainedKey = readFileSync(keyFile);

      writeFileSync(
        config,
        JSON.stringify({
          workspace: "test",
          agentId: "bundle-test-agent",
          stateDir: "state",
          encryptionKeyEnv: "TEST_RECOVERY_KEY",
          filesystem: { root: "project", cooperative: true },
          policyPath: "policy.yaml",
        }),
      );
      // The rules an operator would write to allow a reversible write and
      // refuse everything else, so the execute below is policy-authorized
      // rather than a test-only bypass.
      writeFileSync(
        join(parent, "policy.yaml"),
        [
          "version: 1",
          "rules:",
          "  - match: { class: [r0, r1] }",
          "    decision: allow",
          "  - match: {}",
          "    decision: deny",
          "",
        ].join("\n"),
      );

      const manifest = JSON.parse(read("packages/cli/package.json"));
      // The vault key is retained state, so it is minted once here and handed
      // to the server rather than left to whatever a second process invents.
      const vaultKey = randomBytes(32).toString("base64");
      session = mcpSession(
        join(bare, ENTRY_FILE),
        ["recovery", "serve", "--config", config],
        { ...process.env, TEST_RECOVERY_KEY: vaultKey },
      );

      const initialized = await session.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "bundle-handshake", version: "1" },
      });
      assert.equal(initialized.error, undefined, session.stderr());
      assert.equal(initialized.result.serverInfo.name, "nomo-recovery");
      // The version comes from the build stamp in a directory with no manifest
      // above it, which is the one reader that already had to change.
      assert.equal(initialized.result.serverInfo.version, manifest.version);
      session.notify("notifications/initialized");

      const listed = await session.request("tools/list", {});
      assert.equal(listed.error, undefined, session.stderr());
      assert.deepEqual(
        listed.result.tools.map(({ name }) => name).sort(),
        [
          "nomo_execute",
          "nomo_reconcile",
          "nomo_recovery_apply",
          "nomo_recovery_apply_job",
          "nomo_recovery_plan",
          "nomo_recovery_plan_job",
          "nomo_recovery_reconcile",
          "nomo_recovery_status_job",
        ],
      );

      // A round trip is what separates "the server answered" from "the bundled
      // runtime, journal and vault work": initialize alone never opens SQLite.
      const executed = JSON.parse(
        (
          await session.request("tools/call", {
            name: "nomo_execute",
            arguments: {
              operationId: "bundle-op",
              runId: "bundle-run",
              mutation: {
                action: "write",
                path: "file.txt",
                base64: Buffer.from("bundled\n").toString("base64"),
              },
            },
          })
        ).result.content[0].text,
      );
      assert.equal(executed.status, "succeeded", session.stderr());
      assert.equal(
        readFileSync(join(workspace, "file.txt"), "utf8"),
        "bundled\n",
      );

      const planned = JSON.parse(
        (
          await session.request("tools/call", {
            name: "nomo_recovery_plan",
            arguments: { operationId: "bundle-op" },
          })
        ).result.content[0].text,
      );
      assert.match(planned.digest, /^[a-f0-9]{64}$/);

      const applied = JSON.parse(
        (
          await session.request("tools/call", {
            name: "nomo_recovery_apply",
            arguments: { plan: planned },
          })
        ).result.content[0].text,
      );
      assert.equal(applied.status, "restored", session.stderr());
      assert.equal(
        readFileSync(join(workspace, "file.txt"), "utf8"),
        "before\n",
      );

      // Adopted, not regenerated: the same bytes are on disk after a full
      // session, so the server never created a replacement identity.
      assert.deepEqual(readFileSync(keyFile), retainedKey);
      assert.doesNotMatch(
        session.stderr(),
        /ENOENT|__NOMO_|Retained recovery signing key is unavailable/,
      );
    } finally {
      session?.close();
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
