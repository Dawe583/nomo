import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const manifest = (path) => JSON.parse(read(path));
const packageDirs = readdirSync(new URL("packages/", root), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(new URL(`packages/${entry.name}/package.json`, root)))
  .map((entry) => `packages/${entry.name}`);
const directories = [".", ...packageDirs, "apps/control-plane", "scripts"];

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
    assert.match(data.name, /^@void\/[a-z0-9]+(?:-[a-z0-9]+)*$/);
    if (directory.startsWith("packages/")) {
      assert.equal(data.name, `@void/${directory.slice("packages/".length)}`);
    }
    assert.equal(data.version, "0.1.0");
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
  void: "packages/cli/bin/void.mjs",
  "void-proxy": "packages/proxy/bin/void-proxy.mjs",
};

test("root bin mappings resolve to the development entrypoints", () => {
  assert.deepEqual(manifest("package.json").bin, bins);
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
  assert.match(release, /Credential-blocked git push/);
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
