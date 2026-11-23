/**
 * The one bundling rule for the NOMO distribution artifact.
 *
 * `packages/cli` is a workspace package whose source reaches its siblings by
 * relative path and whose registry import is `workspace:*`. Neither survives
 * `npm pack`, so the consumer tarball has to arrive as built JavaScript with
 * every sibling inlined. This config is that build, and it is the only place
 * the distribution boundary is written down.
 *
 * No plugin dependency is used, and that is a deliberate finding rather than a
 * shortcut. `@rollup/plugin-typescript` is not installed, and it is not needed:
 * Node strips TypeScript types natively, so `stripTypeScriptTypes` from
 * `node:module` is a complete transform for the syntax this repository writes.
 * It is erasable-only syntax, which strip mode accepts; there is no `enum`,
 * `namespace`, or parameter property anywhere in the graph. Pulling in a plugin
 * to reimplement a builtin the runtime already ships is the expensive path.
 *
 * What stays external is the honest answer to "which dependencies does this
 * artifact own": every declared third-party runtime dependency, plus Node's
 * builtins. Nothing from the workspace is external, because a workspace link is
 * exactly what a consumer cannot resolve.
 */

import { stripTypeScriptTypes } from "node:module";
import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Packages whose `exports` point at raw TypeScript, which npm cannot resolve. */
const WORKSPACE_TYPED = {
  "@nomo/registry": "packages/registry/src/index.ts",
};

/**
 * True for a specifier a consumer's npm has to resolve, and false for one this
 * build inlines. Absolute and relative paths stay in the bundle; bare names
 * stay out of it; a `workspace:*` package is mapped to its source so it is
 * inlined rather than externalised.
 */
export function isExternal(id) {
  if (Object.hasOwn(WORKSPACE_TYPED, id)) return false;
  if (id.startsWith(".") || id.startsWith("/")) return false;
  if (id.startsWith("node:")) return true;
  // Virtual and rollup-internal ids have no package meaning; treat them as
  // in-graph so they are bundled rather than looked up in node_modules.
  if (id.startsWith("\0")) return false;
  return true;
}

/** Rollup plugin: map a workspace-typed specifier to its source entry. */
const workspaceSource = {
  name: "nomo-workspace-source",
  resolveId(source) {
    const entry = WORKSPACE_TYPED[source];
    return entry ? new URL(entry, import.meta.url).pathname : null;
  },
};

/**
 * Rollup plugin: erase TypeScript types with the runtime's own stripper.
 *
 * `sourceUrl` is passed so a syntax error names the file it came from rather
 * than an anonymous transform. Sourcemaps are disabled deliberately: `strip`
 * replaces types with spaces, so the mapping is the identity and emitting one
 * would only add a file to the tarball that cannot be more accurate than the
 * stripped source it describes.
 */
const stripTypes = (sourceRoot) => ({
  name: "nomo-strip-types",
  transform(code, id) {
    if (!/\.(ts|mts|cts)$/.test(id)) return null;
    const relativeId = relative(sourceRoot, id).split(sep).join("/");
    const sourceUrl = relativeId.startsWith("../")
      ? `external/${relativeId.split("/").at(-1)}`
      : relativeId;
    return {
      code: stripTypeScriptTypes(code, { mode: "strip", sourceUrl }),
      map: null,
    };
  },
});

/**
 * The placeholder `packages/cli/src/package-version.ts` carries, and the token
 * the version plugin replaces.
 *
 * Exported so `scripts/src/bundle-cli.mjs` can refuse to write an artifact that
 * still contains it. A bundle stamped with nothing is a version nobody bumped.
 */
export const BUNDLED_VERSION_PLACEHOLDER = "__NOMO_BUNDLED_VERSION__";

/** The manifest whose `version` is the single source of truth for the stamp. */
export function readPackageVersion(base) {
  const path = join(base, "packages/cli/package.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (typeof manifest.version !== "string" || !manifest.version)
    throw new Error(`${path} has no version`);
  return manifest.version;
}

/**
 * Rollup plugin: stamp the manifest version over the bundle placeholder.
 *
 * The artifact can be written to any `--out` directory, and only the shipped
 * `packages/cli/dist` has a manifest one level above it. Without the stamp a
 * bundle elsewhere answered `--version` with ENOENT. The plugin is scoped to the
 * one module that declares the placeholder, so no other literal is rewritten.
 */
const bundleVersion = (version) => ({
  name: "nomo-bundle-version",
  transform(code, id) {
    if (!/(^|\/)packages\/cli\/src\/package-version\.ts$/.test(id)) return null;
    const stamped = code.replaceAll(
      `"${BUNDLED_VERSION_PLACEHOLDER}"`,
      JSON.stringify(version),
    );
    // A renamed or removed placeholder would silently ship an unstamped bundle,
    // so the build stops here instead.
    if (stamped === code)
      throw new Error(
        `packages/cli/src/package-version.ts no longer carries ${BUNDLED_VERSION_PLACEHOLDER}`,
      );
    return { code: stamped, map: null };
  },
});

/**
 * @param {{ root?: string, outDir?: string }} [options]
 * @returns {import("rollup").RollupOptions}
 */
export function bundleOptions({ root, outDir } = {}) {
  const base = root ?? new URL("./", import.meta.url).pathname;
  return {
    input: new URL("packages/cli/bin/nomo.mjs", import.meta.url).pathname,
    external: isExternal,
    plugins: [
      workspaceSource,
      bundleVersion(readPackageVersion(base)),
      stripTypes(base),
    ],
    // A cycle between workspace siblings is a property of the source graph, not
    // a defect in the artifact, and it emits one warning per pair per build.
    onwarn(warning, warn) {
      if (warning.code === "CIRCULAR_DEPENDENCY") return;
      warn(warning);
    },
    treeshake: { moduleSideEffects: true },
  };
}

/**
 * The distribution artifact: an ESM chunk graph rooted at one bin target.
 *
 * Code splitting is a correctness requirement here, not a size preference. The
 * repository's entry point deliberately defers its heavy graph behind a dynamic
 * import so `--help` and `--version` never load a database engine, and
 * `packages/proxy/bin/nomo-proxy.mjs` is imported for its side effect and runs
 * `main()` at module scope. `inlineDynamicImports` inlines a dynamic import's
 * body into the importing scope, which hoists that `main()` call to the top of
 * every invocation: `doctor` printed the proxy usage line and exited 1, and
 * `run` died on `Cannot access 'proxy' before initialization`. Keeping
 * the split preserves both the deferral and the side-effect ordering, and the
 * entry chunk stays a few kB importing only `node:fs`.
 */
export function bundleOutput(outDir) {
  return {
    dir: outDir,
    format: "esm",
    // `nomo.mjs` is the bin target. Rollup keeps the entry's shebang, and a
    // second banner would emit two, so none is added here.
    entryFileNames: "nomo.mjs",
    chunkFileNames: "[name].mjs",
    exports: "none",
    generatedCode: "es2015",
  };
}

export default bundleOptions();
