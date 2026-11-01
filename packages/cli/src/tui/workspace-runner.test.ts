import test from "node:test";
import assert from "node:assert/strict";

import { signalQuitAction } from "./workspace-runner.ts";

test("SIGINT requires a second press within the confirmation window", () => {
  assert.equal(signalQuitAction(1000, 0), "confirm");
  assert.equal(signalQuitAction(1799, 1000), "stop");
  assert.equal(signalQuitAction(1801, 1000), "confirm");
  assert.equal(signalQuitAction(900, 1000), "confirm");
});
