import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const EXCLUDE_DIRS = new Set([
  "node_modules",
  ".git",
  ".nomo",
  "dist",
  ".agents",
  "skills",
  ".opencode",
  ".vercel",
  "target",
  "omp-src",
  "prime-src",
  ".build",
  ".cache",
  // Machine-generated repository understanding indexes. They are scanned
  // artifacts, not authored interface or documentation text.
  ".ua",
]);
// Generated desktop artifacts are not authored text: prepare.mjs bundles the
// API server into src-tauri/resources/runtime/backend.mjs with esbuild, and a
// bundled npm dependency's comment carries an em dash verbatim while no
// repository-authored source does, so the scan would fail on a build output
// forever after the desktop resources are first prepared on any machine.
const GENERATED_PREFIXES = [
  "apps/desktop/src-tauri/resources",
  "apps/desktop/src-tauri/gen",
  "packages/cli/.nomo-composer-build.gPvVla",
];
const EXCLUDE_NAMES = new Set(["STANDARDS.md", "pnpm-lock.yaml"]);
// These source documents are integrity-pinned by the encrypted strategy
// manifest. Preserve their original typography and verify their bytes there.
const INTEGRITY_PINNED_TEXT = new Set([
  "docs/strategy/2026-10-27-nomoyc-developer-runbook.md",
  "docs/strategy/2026-10-27-nomoyc-founder-thesis.md",
  "docs/strategy/2026-10-27-nomoyc-gstack-review-report.md",
  "docs/strategy/2026-10-27-nomoyc-integrated-roadmap.md",
  "docs/strategy/2026-10-27-nomoyc-market-and-competition.md",
  "docs/strategy/2026-10-27-nomoyc-segment-scorecard.md",
  "docs/strategy/2026-10-27-nomoyc-startup-blueprint.md",
  "docs/strategy/2026-10-28-nomoyc-three-idea-execution-playbook.md",
]);
const EN_DASH = Buffer.from([0xe2, 0x80, 0x93]);
const EM_DASH = Buffer.from([0xe2, 0x80, 0x94]);

function walk(root, dir, found) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const rel = relative(root, full);
      const parts = rel.split(/[\\/]/);
      if (parts.some((p) => EXCLUDE_DIRS.has(p))) continue;
      if (
        GENERATED_PREFIXES.some(
          (prefix) => rel === prefix || rel.startsWith(prefix + "/"),
        )
      )
        continue;
      walk(root, full, found);
      continue;
    }
    if (!entry.isFile()) continue;
    if (INTEGRITY_PINNED_TEXT.has(relative(root, full).replace(/\\/g, "/")))
      continue;
    if (EXCLUDE_NAMES.has(entry.name)) continue;
    let buf;
    try {
      buf = readFileSync(full);
    } catch {
      continue;
    }
    const sample = buf.subarray(0, 1024);
    if (sample.includes(0)) continue;
    if (buf.includes(EN_DASH) || buf.includes(EM_DASH))
      found.push(relative(root, full));
  }
}

test("no em or en dash anywhere except STANDARDS.md", () => {
  const root = resolve(import.meta.dirname, "..", "..");
  const found = [];
  walk(root, root, found);
  assert.equal(
    found.length,
    0,
    "em (U+2014) or en (U+2013) dash found in:\n" + found.join("\n"),
  );
});
