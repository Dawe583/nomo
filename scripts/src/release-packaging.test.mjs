import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { versionedManifests } from "./set-version.mjs";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const manifest = (path) => JSON.parse(read(path));
// The setter owns this list, so the gate and the script that writes a version
// cannot disagree about which manifests carry one.
const directories = versionedManifests(fileURLToPath(root));
const ROOT_VERSION = manifest("package.json").version;

/**
 * The invariant is that every manifest moves together, not that the number is
 * one particular value, so the comparison below is against the root manifest.
 * This is the only place a version has to look like a version at all, and the
 * shape is the release policy's own: three numeric parts, no prerelease.
 */
test("the root manifest carries a three-part numeric product version", () => {
  assert.match(
    ROOT_VERSION,
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/,
    `the root manifest is at ${ROOT_VERSION}, which is not a version every manifest can be moved to`,
  );
});

/**
 * Packages allowed to be publishable, and why.
 *
 * The one hard rule here is that nothing publishes with sloppy metadata, and a
 * blanket "private: true" was how this repository enforced it. `packages/verifier`
 * is the exception because it is a single executable file of Node built-ins: it
 * needs no build, so there is nothing that could ship broken. Every other
 * assertion in the rule still applies to it, and adding a second entry means
 * somebody wrote down a reason.
 */
const PUBLISHABLE = new Map([
  [
    "packages/verifier",
    "one executable file of Node built-ins, no build step, so it cannot ship source the runtime cannot load",
  ],
]);

for (const directory of directories) {
  test(`${directory} ${PUBLISHABLE.has(directory) ? "is publishable with" : "stays private with"} coherent development release metadata`, () => {
    const data = manifest(`${directory}/package.json`);
    assert.match(data.name, /^@nomo\/[a-z0-9]+(?:-[a-z0-9]+)*$/);
    if (directory.startsWith("packages/")) {
      assert.equal(data.name, `@nomo/${directory.slice("packages/".length)}`);
    }
    assert.equal(
      data.version,
      ROOT_VERSION,
      `${directory} is at ${data.version}, so it did not move with the root manifest at ${ROOT_VERSION}`,
    );
    if (PUBLISHABLE.has(directory)) {
      // Only the private flag is relaxed. Everything below still applies, and the
      // reason has to exist, or this is a silent exemption.
      assert.notEqual(data.private, true, `${directory} is listed publishable, so it must not also be private`);
      assert.ok(
        (PUBLISHABLE.get(directory) ?? "").length > 20,
        `${directory} needs a reason a reviewer can weigh`,
      );
    } else {
      assert.equal(data.private, true);
    }
    assert.equal(data.engines.node, ">=24");
    assert.equal(typeof data.description, "string");
    assert.ok(data.description.length > 20);
    assert.ok(Array.isArray(data.keywords) && data.keywords.length >= 2);
    if (directory !== ".") {
      assert.deepEqual(data.repository, {
        type: "git",
        url: "git+https://github.com/Dawe583/void.git",
        directory,
      });
      assert.equal(data.homepage, `https://github.com/Dawe583/void/tree/main/${directory}`);
    }
  });
}

const bins = {
  nomo: "packages/cli/bin/nomo.mjs",
  "nomo-proxy": "packages/proxy/bin/nomo-proxy.mjs",
};

test("root bin mappings resolve to the development entrypoints", () => {
  assert.deepEqual(manifest("package.json").bin, bins);
});

test("checkout launchers expose the same TUI entrypoint on POSIX and Windows", () => {
  const posix = read("nomo");
  const windows = read("nomo.cmd");
  assert.match(posix, /^#!\/bin\/sh\n/);
  assert.match(posix, /packages\/cli\/bin\/nomo\.mjs/);
  assert.match(posix, /exec node .*"\$@"/);
  assert.ok(lstatSync(new URL("../../nomo", import.meta.url)).mode & 0o111);
  assert.match(windows, /^@echo off\r?\n/);
  assert.match(windows, /packages\\cli\\bin\\nomo\.mjs/);
  assert.match(windows, /%\*/);
  assert.match(manifest("package.json").scripts.nomo, /packages\/cli\/bin\/nomo\.mjs/);
});

for (const [name, path] of Object.entries(bins)) {
  test(`${name} has an executable Node shebang and valid syntax`, () => {
    assert.equal(read(path).split("\n")[0], "#!/usr/bin/env node");
    const checked = spawnSync(process.execPath, ["--check", fileURLToPath(new URL(path, root))], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.ifError(checked.error);
    assert.equal(checked.status, 0, checked.stderr);
  });
}

/**
 * The cheap half of the clean install, kept deliberately beside the
 * expensive one below.
 *
 * The clean install is the only check that can prove a bin runs as a program
 * once packed and installed, and it costs an npm pack, an offline install
 * and a process spawn. This one reads a line of a file in the working tree
 * and costs nothing, so a missing interpreter line should never survive to
 * the expensive check. It cannot replace that check: a shebang on the source
 * says nothing about whether the `files` allowlist ships the file, whether
 * npm links it into `.bin`, or whether the installed copy still works. Both
 * exist because each fails on something the other cannot see.
 */
for (const directory of PUBLISHABLE.keys()) {
  test(`${directory} bin targets start with an interpreter line`, () => {
    const data = manifest(`${directory}/package.json`);
    const targets = Object.values(data.bin ?? {});
    assert.ok(targets.length > 0, `${directory} is publishable, so it must declare a bin`);
    for (const target of targets) {
      const path = `${directory}/${target.replace(/^\.\//, "")}`;
      assert.match(
        read(path),
        /^#![^\n]*\bnode\b/,
        `${path} is the target of the ${data.name} bin and has no interpreter line, so the installed bin would fail to execute`,
      );
    }
  });
}

/**
 * How each publishable package is proved to run once installed.
 *
 * "It installs" is only checkable against a command, so a package cannot
 * join PUBLISHABLE without also saying here what to execute and what the
 * output has to contain. The regular expression is the evidence: without it
 * an exit code of zero from a binary that printed nothing, or that exited
 * zero because it never got past its own argument parsing, would pass.
 */
const CLEAN_INSTALL_RUN = new Map([
  [
    "packages/verifier",
    {
      args: ["--selftest"],
      expect: /^SELFTEST PASS all six checks$/m,
    },
  ],
]);

/**
 * The clean install, for every package allowed to publish.
 *
 * The metadata checks above prove a manifest is coherent. That is not the
 * same as proving the artifact works, and the difference is exactly where
 * this repository has been wrong before: a package can carry a correct
 * name, version, bin and files allowlist and still ship a tarball no
 * consumer can execute. So each publishable package is packed, installed
 * into a temporary directory outside this repository, and its installed bin
 * is run for real.
 *
 * Three properties of the install are deliberate. It is offline, with the
 * registry pointed at a discard port, so a missing dependency fails here
 * rather than passing on a machine with a warm cache or quietly reaching the
 * network. The sandbox is under the system temp directory, so no tarball,
 * node_modules or scratch tree is ever written inside the repository. And
 * the installed package is required to be a real directory rather than a
 * symlink, because a workspace link would resolve the bin back to the
 * source tree and make the assertion prove nothing.
 */
for (const directory of PUBLISHABLE.keys()) {
  test(`${directory} packs, installs outside the workspace, and its installed bin runs`, () => {
    const run = CLEAN_INSTALL_RUN.get(directory);
    assert.ok(
      run,
      `${directory} is publishable, so it needs a CLEAN_INSTALL_RUN entry saying how to start it`,
    );
    const data = manifest(`${directory}/package.json`);
    const binNames = Object.keys(data.bin ?? {});
    assert.ok(
      binNames.length > 0,
      `${directory} is publishable, so it must declare a bin a consumer can execute`,
    );

    const packageDir = fileURLToPath(new URL(`${directory}/`, root));
    const sandbox = mkdtempSync(join(tmpdir(), "nomo-release-clean-install-"));
    try {
      // Pack from the package directory into the sandbox, never into the
      // repository: the tarball is the artefact under test and a stray one
      // left in the tree is a release hazard, not a test artefact.
      const packed = spawnSync(
        "npm",
        ["pack", "--pack-destination", sandbox, "--json"],
        { cwd: packageDir, encoding: "utf8", timeout: 120_000 },
      );
      assert.ifError(packed.error);
      assert.equal(packed.status, 0, `npm pack failed: ${packed.stderr}`);
      const [{ filename, files }] = JSON.parse(packed.stdout);
      const tarball = join(sandbox, filename);
      assert.ok(
        files.some((entry) => entry.path === "package.json"),
        `npm pack produced a tarball with no manifest: ${JSON.stringify(files)}`,
      );

      // A consumer's own manifest, so npm resolves this install as a
      // standalone project rather than walking up into the workspace.
      const consumer = join(sandbox, "consumer");
      rmSync(consumer, { recursive: true, force: true });
      writeFileSync(
        join(sandbox, "package.json"),
        `${JSON.stringify({ name: "nomo-clean-install-probe", version: "0.0.0", private: true }, null, 2)}\n`,
      );
      const installed = spawnSync(
        "npm",
        ["install", "--no-save", "--no-audit", "--no-fund", "--offline", tarball],
        {
          cwd: sandbox,
          encoding: "utf8",
          timeout: 120_000,
          env: {
            ...process.env,
            npm_config_registry: "http://127.0.0.1:9/",
            npm_config_offline: "true",
          },
        },
      );
      assert.ifError(installed.error);
      assert.equal(
        installed.status,
        0,
        `clean install of ${filename} failed with no network available: ${installed.stderr}`,
      );

      const installedDir = join(sandbox, "node_modules", data.name);
      // A workspace link resolves back into this repository, so the run below
      // would prove the source tree rather than the packed tarball. The
      // resolved path has to stay inside the sandbox for the evidence to
      // mean what the test says it means.
      const link = realpathSync(installedDir);
      assert.ok(
        !lstatSync(installedDir).isSymbolicLink(),
        `the installed ${data.name} is a symlink, so it is a workspace link and not a packed copy`,
      );
      assert.ok(
        link.startsWith(realpathSync(sandbox) + "/"),
        `the installed ${data.name} resolved to ${link}, outside the clean install directory, so the run would prove the source tree and not the tarball`,
      );

      for (const binName of binNames) {
        const installedBin = join(sandbox, "node_modules", ".bin", binName);
        assert.ok(
          existsSync(installedBin),
          `installing ${filename} produced no ${binName} executable`,
        );
        const ran = spawnSync(installedBin, run.args, {
          cwd: sandbox,
          encoding: "utf8",
          timeout: 120_000,
        });
        assert.ifError(ran.error);
        assert.equal(
          ran.status,
          0,
          `the installed ${binName} exited ${ran.status} in a clean install of ${filename}: ${ran.stderr || ran.stdout}`,
        );
        assert.match(ran.stdout, run.expect);
        console.log(
          `installed ${data.name}@${data.version} as ${filename} (${files.length} files) and ran ${binName} ${run.args.join(" ")}: ${ran.stdout.trim().split("\n").pop()}`,
        );
      }
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
}

test("every package that is not publishable is private, and nothing ships without a written reason", () => {
  // The clean install above covers PUBLISHABLE and only PUBLISHABLE, so this
  // is what stops a package being un-privated into a silent gap: dropping the
  // private flag without adding a PUBLISHABLE entry and a CLEAN_INSTALL_RUN
  // command fails here rather than shipping an untested artefact.
  const unlisted = directories.filter(
    (directory) => manifest(`${directory}/package.json`).private !== true,
  );
  assert.deepEqual(
    [...unlisted].sort(),
    [...PUBLISHABLE.keys()].sort(),
    `a package is publishable without being listed, with a reason, and a clean install run: ${unlisted.join(", ")}`,
  );
  for (const directory of directories) {
    if (!PUBLISHABLE.has(directory)) {
      assert.equal(
        manifest(`${directory}/package.json`).private,
        true,
        `${directory} is not listed publishable, so it stays private until somebody writes down a reason`,
      );
    }
  }
});

test("license metadata follows the existing license or reports its absence", () => {
  const release = read("docs/RELEASE.md");
  if (!existsSync(new URL("LICENSE", root))) {
    assert.match(release, /(?:missing|absent|no) (?:root )?LICENSE/i);
    return;
  }
  assert.match(read("LICENSE"), /Apache License\s+Version 2\.0/);
  for (const directory of directories) {
    assert.equal(manifest(`${directory}/package.json`).license, "Apache-2.0");
  }
});

test("release notes keep the source distribution and runtime limits visible", () => {
  const release = read("docs/RELEASE.md");
  assert.match(release, /private: true/);
  assert.match(release, /node_modules/);
  assert.match(release, /22\.18/);
  // The blocker used to read "Credential-blocked git push", which was false:
  // pushing works. What does not work is remote CI, so the assertion names
  // that instead of a claim the tree contradicts.
  assert.match(release, /Remote CI does not run/);
  assert.match(release, /Real-service e2e/);
  assert.match(release, /Publish CI/);
  for (const path of ["docs/RELEASE.md", "packages/proxy/docs/interface.md"]) {
    assert.doesNotMatch(read(path), /[\u2013\u2014]/);
  }
});

/**
 * The MCP registry manifest, checked against the schema the registry
 * publishes rather than against taste.
 *
 * `server.json` is what a registry client and a security reviewer read, and
 * nothing else in this repository reads it, so a field dropped here is
 * invisible to every other test. The required list is the schema's own:
 * `ServerDetail` requires `name`, `description` and `version`, and the
 * `Repository` it points at requires `url` and `source`. `title` and
 * `repository.subfolder` are not required by the pinned 2025-09-29 revision,
 * but they are what the official format documents and what makes the
 * manifest usable: a monorepo entry without `subfolder` points every reader
 * at the repository root instead of at the server.
 *
 * `mcpName` is deliberately absent from this list. It is not a `server.json`
 * field at all: the registry verifies npm ownership by reading `mcpName` out
 * of the published package's `package.json` and requiring it to equal the
 * server name. It becomes real when a package is published, not before.
 */
const MCP_MANIFEST = "server.json";
const mcpManifest = manifest(MCP_MANIFEST);

const readPath = (source, path) =>
  path.reduce((node, key) => (node === undefined ? undefined : node[key]), source);

test("the MCP registry manifest declares every field its schema requires", () => {
  const required = [
    "name",
    "description",
    "title",
    "version",
    "repository.url",
    "repository.source",
    "repository.subfolder",
  ];
  for (const path of required) {
    const value = readPath(mcpManifest, path.split("."));
    assert.equal(
      typeof value,
      "string",
      `server.json: ${path} is absent, and the registry will not publish it`,
    );
    assert.ok(
      value.trim().length > 0,
      `server.json: ${path} is empty, and the registry will not publish it`,
    );
  }
});

test("the MCP registry manifest is publishable as written", () => {
  // Reverse-DNS name, exactly one slash, and the pattern the schema states.
  assert.match(mcpManifest.name, /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
  // The registry authenticates an `io.github.<owner>` namespace against the
  // GitHub account, so a name that drifts from the repository URL is a
  // namespace this publisher cannot prove.
  const owner = new URL(mcpManifest.repository.url).pathname.split("/")[1];
  assert.ok(
    mcpManifest.name.toLowerCase().startsWith(`io.github.${owner.toLowerCase()}/`),
    `server.json: name ${mcpManifest.name} does not claim the ${owner} GitHub namespace it publishes under`,
  );
  // The schema bounds the description and rejects a version range: a registry
  // has to resolve one artefact, not a class of them.
  assert.ok(mcpManifest.description.length <= 100);
  assert.doesNotMatch(mcpManifest.version, /[\^~><*]|latest|\bx\b|\d+\.x/i);
  // A subfolder is resolved by whoever clones the repository, so a path that
  // does not exist here is a 404 for every user and no failure for us.
  const subfolder = mcpManifest.repository.subfolder;
  assert.doesNotMatch(
    subfolder,
    /^\/|\.\.|\\/,
    "server.json: subfolder must be a clean relative path",
  );
  assert.ok(
    existsSync(new URL(`${subfolder}/`, root)),
    `server.json: repository.subfolder ${subfolder} is not a directory in this repository`,
  );
});

test("every MCP package entry names how it is downloaded and launched", () => {
  // There is no package entry yet and there must not be one: this server is
  // launched with a command from a workspace that is not published, and a
  // guessed version is worse than no entry. The rule is stated so the entry
  // that eventually appears cannot arrive half filled.
  for (const entry of mcpManifest.packages ?? []) {
    for (const field of ["registryType", "identifier", "transport"]) {
      assert.ok(entry[field], `server.json: a packages entry is missing ${field}`);
    }
    assert.ok(
      entry.transport?.type === "stdio" || entry.transport?.url,
      "server.json: a package transport must be stdio or name a url",
    );
  }
});
