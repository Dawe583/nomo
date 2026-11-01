import test from "node:test";
import assert from "node:assert/strict";

import {
  dispatchQueuedPrompt,
  escapeOwnedByOverlay,
  normalizePastedPrompt,
  shouldCancelActiveRun,
  WorkspaceInput,
  takeReadyQueuedPrompt,
  signalQuitAction,
} from "./workspace-runner.ts";

test("OpenTUI paste normalizes newlines and removes terminal controls", () => {
  assert.equal(
    normalizePastedPrompt("first\rsecond\x00\x1b[31mred\x9b\x80last\nline"),
    "first\nsecond[31mredlast\nline",
  );
});

test("paste focuses the composer and uses the same control-byte normalization", () => {
  const input = new WorkspaceInput();
  input.paste("first\rsecond\x00\x1b[31mred\nline");
  assert.equal(input.editing, true);
  assert.equal(input.value, "first\nsecond[31mred\nline");
});

test("SIGINT requires a second press within the confirmation window", () => {
  assert.equal(signalQuitAction(1000, 0), "confirm");
  assert.equal(signalQuitAction(1799, 1000), "stop");
  assert.equal(signalQuitAction(1801, 1000), "confirm");
  assert.equal(signalQuitAction(900, 1000), "confirm");
});

test("Escape-owning overlays close before run cancellation; Ctrl+C still cancels", () => {
  for (const owner of [true, false]) {
    assert.equal(
      shouldCancelActiveRun({ ctrl: false, name: "escape" }, owner, false),
      !owner,
    );
  }
  assert.equal(
    shouldCancelActiveRun({ ctrl: false, name: "escape" }, false, false),
    true,
  );
  assert.equal(
    shouldCancelActiveRun({ ctrl: true, name: "c" }, true, false),
    true,
  );
  assert.equal(
    shouldCancelActiveRun({ ctrl: true, name: "c" }, false, false),
    true,
  );
  assert.equal(
    shouldCancelActiveRun({ ctrl: false, name: "escape" }, false, true),
    false,
  );
});

test("an active list filter owns Escape before a running agent does", () => {
  assert.equal(
    escapeOwnedByOverlay({
      confirmation: false,
      palette: false,
      keybindings: false,
      cheatSheet: false,
      filter: "ledger",
    }),
    true,
  );
  assert.equal(
    escapeOwnedByOverlay({
      confirmation: false,
      palette: false,
      keybindings: false,
      cheatSheet: false,
      filter: "",
    }),
    false,
  );
});

test("poller dispatch lock keeps keyboard actions out until dispatch settles", () => {
  let busy = false;
  const ready = (prompt: string | null, workbenchRunning: boolean) =>
    takeReadyQueuedPrompt(
      { queuedPrompt: prompt, takeQueued: () => prompt },
      {
        workbenchRunning,
        hasConfirmation: false,
        runnerBusy: busy,
      },
    );
  assert.equal(ready("later", false), "later");
  busy = true;
  assert.equal(ready("later", false), null);
  busy = false;
  assert.equal(ready("later", false), "later");
});

test("queued dispatch restores text only when sending the prompt fails", async () => {
  const queued: string[] = [];
  const failures: string[] = [];
  let refreshed = 0;
  let fail = true;
  const ui = {
    queuePrompt: (prompt: string) => queued.push(prompt),
    command: async () => {
      if (fail) throw new Error("unknown @path");
    },
  };
  assert.equal(
    await dispatchQueuedPrompt(
      ui,
      "@missing",
      async () => {
        refreshed++;
      },
      (error) => failures.push(String(error)),
    ),
    false,
  );
  assert.deepEqual(queued, ["@missing"]);
  assert.deepEqual(failures, ["Error: unknown @path"]);
  assert.equal(refreshed, 0);

  fail = false;
  assert.equal(
    await dispatchQueuedPrompt(
      ui,
      "next",
      async () => {
        refreshed++;
      },
      () => {},
    ),
    true,
  );
  assert.equal(refreshed, 1);
  assert.deepEqual(queued, ["@missing"]);
});

test("a queued prompt stays queued until Workbench, UI work, and reviews are idle", () => {
  let queued: string | null = "later";
  const ui = {
    get queuedPrompt() {
      return queued;
    },
    takeQueued() {
      const next = queued;
      queued = null;
      return next;
    },
  };
  assert.equal(
    takeReadyQueuedPrompt(ui, {
      workbenchRunning: true,
      hasConfirmation: false,
    }),
    null,
  );
  assert.equal(queued, "later");
  assert.equal(
    takeReadyQueuedPrompt(ui, {
      workbenchRunning: false,
      hasConfirmation: true,
    }),
    null,
  );
  assert.equal(queued, "later");
  assert.equal(
    takeReadyQueuedPrompt(ui, {
      workbenchRunning: false,
      hasConfirmation: false,
      runnerBusy: true,
    }),
    null,
  );
  assert.equal(queued, "later");
  assert.equal(
    takeReadyQueuedPrompt(ui, {
      workbenchRunning: false,
      hasConfirmation: false,
    }),
    "later",
  );
  assert.equal(queued, null);
  assert.equal(
    takeReadyQueuedPrompt(ui, {
      workbenchRunning: false,
      hasConfirmation: false,
    }),
    null,
  );
});
