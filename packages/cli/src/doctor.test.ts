import test from "node:test";
import assert from "node:assert/strict";
import { runDoctorCommand, type DoctorDeps } from "./doctor.ts";

function collect() {
  const out: string[] = [], err: string[] = [];
  return {
    out,
    err,
    io: {
      stdout: (line: string) => { out.push(line); },
      stderr: (line: string) => { err.push(line); },
    },
  };
}
const healthy: DoctorDeps = {
  env: {},
  nodeVersion: "v26.8.1",
  run: async () => "10.33.0",
  writable: async () => "ok",
  present: async () => true,
};

test("doctor passes a healthy environment and exits zero", async () => {
  const c = collect();
  const code = await runDoctorCommand([], c.io, healthy);
  assert.equal(code, 0);
  assert.ok(c.out.some((line) => line.startsWith("PASS node")));
  assert.ok(c.out.some((line) => line.startsWith("PASS pnpm")));
  assert.ok(c.out.some((line) => line.startsWith("PASS data-dir")));
  assert.ok(c.out.at(-1)?.startsWith("doctor: "));
  assert.equal(c.err.length, 0);
});

test("doctor fails an old Node and only warns without pnpm", async () => {
  const c = collect();
  const code = await runDoctorCommand([], c.io, {
    ...healthy,
    nodeVersion: "v22.1.0",
    run: async () => { throw Error("not found"); },
  });
  assert.equal(code, 1);
  assert.ok(c.out.some((line) => line.startsWith("FAIL node")));
  assert.ok(c.out.some((line) => line.startsWith("WARN pnpm")));
});

test("a denied directory fails while missing state only warns", async () => {
  const c = collect();
  const code = await runDoctorCommand([], c.io, {
    ...healthy,
    writable: async () => "denied",
    present: async () => false,
  });
  assert.equal(code, 1);
  assert.ok(c.out.some((line) => line.startsWith("FAIL data-dir")));
  assert.ok(c.out.some((line) => line.startsWith("WARN provider-state")));
});

test("doctor rejects arguments with usage and exit two", async () => {
  const c = collect();
  const code = await runDoctorCommand(["--fix"], c.io, healthy);
  assert.equal(code, 2);
  assert.match(c.err[0] ?? "", /usage: void doctor/);
});
