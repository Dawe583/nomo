import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = new URL("../..", import.meta.url).pathname;
const spike = join(root, "scripts/tui-rs-spike");
const binary = join(spike, "target/debug/nomo-tui-rs-spike");
const snapshots = JSON.parse(
  readFileSync(
    join(root, "packages/cli/src/tui/test/visual-snapshots.json"),
    "utf8",
  ),
);

const sizes = [
  [40, 12],
  [52, 16],
  [80, 24],
  [120, 40],
  [160, 45],
  [200, 48],
];
const presets = ["ascii", "unicode", "nerd"];

const {
  parseTuiProtocolMessage,
  serializeTuiProtocolMessage,
} = await import("../../packages/workbench/src/tui-protocol.ts");

test("Rust Help spike matches canonical hashes through a snapshot-shaped input", () => {
  execFileSync("cargo", ["build", "--offline", "--quiet"], {
    cwd: spike,
    stdio: "pipe",
  });
  for (const preset of presets) {
    for (const [columns, rows] of sizes) {
      const fixture = join(spike, "fixtures/snapshot.json");
      const frame = execFileSync(
        binary,
        [String(columns), String(rows), preset, fixture],
        { encoding: "utf8" },
      );
      const lines = frame.split("\n");
      assert.equal(lines.length, rows, `${preset} ${columns}x${rows} row count`);
      assert.ok(
        lines.every((line) => line.length === columns),
        `${preset} ${columns}x${rows} exact visible width`,
      );
      const sha256 = createHash("sha256").update(frame, "utf8").digest("hex");
      assert.equal(
        sha256,
        snapshots.frames[`help@${columns}x${rows}`].sha256,
        `${preset} ${columns}x${rows} frame hash`,
      );
    }
  }

  const fixture = join(spike, "fixtures/snapshot.json");
  const snapshot = JSON.parse(readFileSync(fixture, "utf8"));
  const wire = serializeTuiProtocolMessage({ type: "snapshot", snapshot });
  assert.deepEqual(parseTuiProtocolMessage(wire).event, {
    type: "snapshot",
    snapshot,
  });
  const directory = mkdtempSync(join(tmpdir(), "nomo-rust-wire-"));
  try {
    const envelopePath = join(directory, "snapshot.ndjson");
    writeFileSync(envelopePath, wire, "utf8");
    const frame = execFileSync(binary, ["80", "24", "unicode", envelopePath], {
      encoding: "utf8",
    });
    assert.equal(
      createHash("sha256").update(frame, "utf8").digest("hex"),
      snapshots.frames["help@80x24"].sha256,
      "TypeScript-serialized envelope accepted by Rust",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
