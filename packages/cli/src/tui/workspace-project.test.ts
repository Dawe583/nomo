import assert from "node:assert/strict";
import test from "node:test";
import { runWorkspaceTui } from "./workspace-runner.ts";

test("project mode refuses one-shot execution without interactive consent", async () => {
  assert.equal(
    await runWorkspaceTui(["--once", "--project", process.cwd()]),
    2,
  );
});
