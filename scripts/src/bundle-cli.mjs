#!/usr/bin/env node
/**
 * Build the consumer-installable CLI artifact.
 *
 * Runs as a program rather than being a bare config file, because the two
 * things a release needs from a bundler are not "it configured": the artifact
 * has to land on disk, and the build has to fail loudly. A `rollup -c` that
 * prints warnings and writes nothing is exactly the failure this exists to
 * prevent.
 *
 *   usage: node scripts/src/bundle-cli.mjs [--out <dir>] [--quiet]
 *
 * Exits 0 on success, 1 on a build or write failure, 2 on bad usage.
 */

import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { rollup } from "rollup";

import { bundleOptions, bundleOutput } from "../../rollup.config.mjs";

const USAGE = "usage: node scripts/src/bundle-cli.mjs [--out <dir>] [--quiet]";

/** Where the built artifact lands unless `--out` says otherwise. */
export const DEFAULT_OUT_DIR = "packages/cli/dist";

/** The single file the packed tarball ships and the bin maps to. */
export const ENTRY_FILE = "nomo.mjs";

const parseArgs = (argv) => {
  let outDir = DEFAULT_OUT_DIR;
  let quiet = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--quiet") quiet = true;
    else if (arg === "--out") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`--out needs a directory\n${USAGE}`);
      outDir = value;
      index += 1;
    } else if (arg === "--help" || arg === "-h") throw new Error(USAGE);
    else throw new Error(`unknown argument ${arg}\n${USAGE}`);
  }
  return { outDir, quiet };
};

/**
 * Build the bundle and write every chunk to `outDir`.
 *
 * The output directory is cleared first so a chunk left by an earlier build
 * cannot survive into a tarball as dead weight. The result is a chunk graph
 * rather than one file, because collapsing it breaks `nomo run`; see
 * `bundleOutput` in rollup.config.mjs for the measured reason.
 *
 * @param {{ root?: string, outDir?: string, quiet?: boolean }} [options]
 * @returns {Promise<{ file: string, bytes: number, chunks: string[] }>}
 */
export async function buildBundle({ root, outDir = DEFAULT_OUT_DIR, quiet = false } = {}) {
  const base = resolve(root ?? new URL("../..", import.meta.url).pathname);
  const out = resolve(base, outDir);

  const bundle = await rollup(bundleOptions({ root: base }));
  try {
    const { output } = await bundle.generate(bundleOutput(out));
    const chunks = output.filter((entry) => entry.type === "chunk");
    if (chunks.length === 0) throw new Error("rollup emitted no chunks");
    const entryChunk = chunks.find((chunk) => chunk.isEntry);
    if (!entryChunk) throw new Error("rollup emitted no entry chunk");

    // Cleared first, so a chunk from an earlier build cannot survive into a
    // tarball as dead weight and then be imported by a chunk that no longer
    // needs it.
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    for (const chunk of chunks) {
      writeFileSync(join(out, chunk.fileName), chunk.code, { mode: 0o755 });
    }

    const file = join(out, entryChunk.fileName);
    if (!quiet) {
      const total = chunks.reduce((sum, chunk) => sum + chunk.code.length, 0);
      const kb = (total / 1024).toFixed(0);
      console.log(
        `built ${file} (${chunks.length} chunks, ${kb} kB total)`,
      );
      for (const chunk of chunks) {
        console.log(`  ${chunk.fileName} ${(chunk.code.length / 1024).toFixed(0)} kB`);
      }
    }
    return { file, bytes: entryChunk.code.length, chunks: chunks.map((c) => c.fileName) };
  } finally {
    await bundle.close();
  }
}

// Only run when invoked as a program; importing this module must not build.
if (process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await buildBundle(options);
    if (!result.file || !existsSync(result.file)) throw new Error("build produced no file");
    if (statSync(result.file).size === 0) throw new Error("build produced an empty file");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error instanceof Error && error.message.includes("usage:") ? 2 : 1;
  }
}