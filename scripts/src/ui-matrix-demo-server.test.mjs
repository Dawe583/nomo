import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startDemoServer } from "./ui-matrix.mjs";

const builtIndex = fileURLToPath(new URL("../../dist/web/index.html", import.meta.url));

test(
  "demo server serves built HTML from a dot prefixed worktree",
  { skip: existsSync(builtIndex) ? false : "dist/web is missing; run node scripts/src/build-web.mjs" },
  async () => {
    const demo = await startDemoServer();
    try {
      const response = await fetch(`${demo.origin}/demo`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /text\/html/);
      assert.match(await response.text(), /<!doctype html>/i);
    } finally {
      await demo.close();
    }
  },
);
