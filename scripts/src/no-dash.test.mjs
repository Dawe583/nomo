import test from "node:test";
import assert from "node:assert/strict";
import {
  readdirSync,
  readFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
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
]);
// Generated desktop artifacts are not authored text: prepare.mjs bundles the
// API server into src-tauri/resources/runtime/backend.mjs with esbuild, and a
// bundled npm dependency's comment carries an em dash verbatim while no
// repository-authored source does, so the scan would fail on a build output
// forever after the desktop resources are first prepared on any machine.
const GENERATED_PREFIXES = [
  "apps/desktop/src-tauri/resources",
  "apps/desktop/src-tauri/gen",
];
const EXCLUDE_NAMES = new Set(["STANDARDS.md", "pnpm-lock.yaml"]);
// Historical NOMO/YC source records are bound to a separate encrypted manifest.
// The user chose to preserve them unchanged. Only these exact bytes are exempt;
// changing a record with a dash fails until the history is deliberately reconciled.
const HISTORICAL_RECORDS = new Map([
  [
    "docs/strategy/2026-10-27-nomoyc-developer-runbook.md",
    "337f81a53561408030107248defc361bc012bc7bf4c0c73db4d6c194fe9054c1",
  ],
  [
    "docs/strategy/2026-10-27-nomoyc-founder-thesis.md",
    "c71994063f0698a2bfe501e61e4083af2f0077734bfa0ca2410e6a7b51f58dd8",
  ],
  [
    "docs/strategy/2026-10-27-nomoyc-gstack-review-report.md",
    "744e245a184ecfc644dfd1ee55ba43e501608088fff3ea3b62de3dc71b80960a",
  ],
  [
    "docs/strategy/2026-10-27-nomoyc-integrated-roadmap.md",
    "c6ac4bfbf5f79d9e7c38286d27b4006d6fb5ed0b9af49b4f5936ed70848a2c96",
  ],
  [
    "docs/strategy/2026-10-27-nomoyc-market-and-competition.md",
    "f5e9ab82886b7c30ef4216fef898ea724d75b13b06799a55419f9a13544cf13e",
  ],
  [
    "docs/strategy/2026-10-27-nomoyc-segment-scorecard.md",
    "7374ecd818a1ea8c0d7243753a604ceec8f43b42a26146466e8ed557df08d49d",
  ],
  [
    "docs/strategy/2026-10-27-nomoyc-startup-blueprint.md",
    "eb5455cdeef5032150480eae3301e5ff4842fad84ec57d9449c112ab08dd41a6",
  ],
  [
    "docs/strategy/2026-10-28-nomoyc-three-idea-execution-playbook.md",
    "2977830bbe53b2d3e18d0263407d3c2baf9ceb279d859859eac39bddbdc0b513",
  ],
]);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

const EN_DASH = Buffer.from([0xe2, 0x80, 0x93]);
const EM_DASH = Buffer.from([0xe2, 0x80, 0x94]);

function walk(root, dir, found, historical = HISTORICAL_RECORDS) {
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
      walk(root, full, found, historical);
      continue;
    }
    if (!entry.isFile()) continue;
    if (EXCLUDE_NAMES.has(entry.name)) continue;
    let buf;
    try {
      buf = readFileSync(full);
    } catch {
      continue;
    }
    const sample = buf.subarray(0, 1024);
    if (sample.includes(0)) continue;
    if (buf.includes(EN_DASH) || buf.includes(EM_DASH)) {
      const name = relative(root, full).split(/[\\/]/).join("/");
      if (historical.get(name) !== digest(buf)) found.push(name);
    }
  }
}

test("no new em or en dashes outside pinned historical records", () => {
  const root = resolve(import.meta.dirname, "..", "..");
  const found = [];
  walk(root, root, found);
  assert.equal(
    found.length,
    0,
    "em (U+2014) or en (U+2013) dash found in:\n" + found.join("\n"),
  );
});

test("historical exceptions remain byte-identical", () => {
  const root = resolve(import.meta.dirname, "..", "..");
  for (const [name, expected] of HISTORICAL_RECORDS) {
    assert.equal(
      digest(readFileSync(join(root, name))),
      expected,
      `${name} changed`,
    );
  }
});

test("the gate rejects modified historical and new dash content", (t) => {
  const root = mkdtempSync(join(tmpdir(), "nomo-no-dash-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const historical = join(root, "record.md");
  const bytes = Buffer.from(`original ${String.fromCodePoint(0x2013)} record`);
  writeFileSync(historical, bytes);
  const allowed = new Map([["record.md", digest(bytes)]]);
  let found = [];
  walk(root, root, found, allowed);
  assert.deepEqual(found, []);
  writeFileSync(historical, Buffer.concat([bytes, Buffer.from(" changed")]));
  writeFileSync(join(root, "new.md"), bytes);
  mkdirSync(join(root, ".nomo"));
  writeFileSync(join(root, ".nomo", "work-state.json"), bytes);
  found = [];
  walk(root, root, found, allowed);
  assert.deepEqual(found.sort(), ["new.md", "record.md"]);
});
