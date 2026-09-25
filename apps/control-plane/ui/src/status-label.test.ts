import test from "node:test";
import assert from "node:assert/strict";
import { statusLabel } from "./status-label.ts";

const english = (cs: string, en: string) => en;
const czech = (cs: string, en: string) => cs;

test("built-in lifecycle states use the active locale", () => {
  assert.equal(statusLabel("running", english), "Running");
  assert.equal(statusLabel("awaiting-approval", czech), "Čeká na schválení");
  assert.equal(statusLabel("failed", czech), "Selhal");
  assert.equal(statusLabel("unknown", english), "Outcome unknown");
});

test("built-in policy values localize while server-specific values stay unchanged", () => {
  assert.equal(statusLabel("approved", english), "Approved");
  assert.equal(statusLabel("deny", czech), "Zamítnout");
  assert.equal(statusLabel("future-server-state", english), "future-server-state");
  assert.equal(statusLabel(undefined, english), "—");
});
