import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInitCommand } from "./init.ts";

function collect() {
  const out: string[] = [],
    err: string[] = [];
  return {
    out,
    err,
    io: {
      stdout: (line: string) => {
        out.push(line);
      },
      stderr: (line: string) => {
        err.push(line);
      },
    },
  };
}

test("init creates fresh workspace storage and reports paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-init-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const c = collect();
  const code = await runInitCommand(["--data-dir", join(root, "wb")], c.io, {
    env: { HOME: root },
  });
  assert.equal(code, 0);
  assert.ok(existsSync(join(root, "wb", "tui", "workspace.key")));
  assert.ok(c.out.some((line) => line.startsWith("created: ")));
  assert.ok(c.out.some((line) => line.includes("void doctor")));
});

test("init refuses an initialized directory without touching it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-init-twice-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, "wb");
  const first = collect();
  assert.equal(
    await runInitCommand(["--data-dir", dir], first.io, {
      env: { HOME: root },
    }),
    0,
  );
  const second = collect();
  const code = await runInitCommand(["--data-dir", dir], second.io, {
    env: { HOME: root },
  });
  assert.equal(code, 0);
  assert.ok(second.out.some((line) => line.includes("already initialized")));
});

test("init rejects unknown flags with usage and exit two", async () => {
  const c = collect();
  const code = await runInitCommand(["--force"], c.io, { env: {} });
  assert.equal(code, 2);
  assert.match(c.err[0] ?? "", /usage: void init/);
});
