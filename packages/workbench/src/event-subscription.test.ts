import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Workbench } from "./index.ts";
import { assertIsolated } from "./test-fixture.ts";

test("workbench state subscriptions are coalesced and removable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-workbench-subscribe-"));
  const env = {
    NOMO_DATA_DIR: root,
    NOMO_LEDGER_DIR: join(root, "ledger"),
  } as NodeJS.ProcessEnv;
  const app = new Workbench(env);
  assertIsolated(root, env);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });

  let calls = 0;
  const unsubscribe = app.subscribe(() => {
    calls += 1;
  });
  app.patchHarnessSettings({ maxQueuedRuns: 2 });
  app.patchHarnessSettings({ maxQueuedRuns: 3 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1, "same-tick mutations coalesce into one invalidation");

  unsubscribe();
  app.patchHarnessSettings({ maxQueuedRuns: 4 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1, "removed listeners are not called");
});
