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
import { fileURLToPath } from "node:url";

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
  if (id.startsWith(".") || id.startsWith("/") || /^[A-Za-z]:[\\/]/.test(id))
    return false;
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
    return entry ? fileURLToPath(new URL(entry, import.meta.url)) : null;
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
const stripTypes = {
  name: "nomo-strip-types",
  transform(code, id) {
    if (!/\.(ts|mts|cts)$/.test(id)) return null;
    return {
      code: stripTypeScriptTypes(code, { mode: "strip", sourceUrl: id }),
      map: null,
    };
  },
};

/**
 * @param {{ root?: string, outDir?: string }} [options]
 * @returns {import("rollup").RollupOptions}
 */
export function bundleOptions({ root, outDir } = {}) {
  const base = root ?? fileURLToPath(new URL("./", import.meta.url));
  return {
    input: fileURLToPath(new URL("packages/cli/bin/nomo.mjs", import.meta.url)),
    external: isExternal,
    plugins: [workspaceSource, stripTypes],
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
