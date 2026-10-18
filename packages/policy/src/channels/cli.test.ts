import test, { describe } from "node:test";
import assert from "node:assert/strict";

import { HoldQueue } from "../hold.ts";
import {
  renderQueue,
  renderHold,
  keyToRelease,
  decideKeypress,
} from "./cli.ts";

const call = {
  tool: "postgres.row.delete",
  klass: "r1",
  blastRadius: 41883,
  ruleIndex: 2,
  rationale: "visible damage, a human looks first",
  args: {},
  notify: ["cli"],
};

describe("the CLI approval channel", () => {
  test("the queue renders oldest first with the seconds left", async () => {
    const queue = new HoldQueue();
    const first = queue.hold(call, 120);
    const second = queue.hold({ ...call, tool: "slack.chat.post_message", blastRadius: undefined }, 120);
    const now = Date.now();
    const view = renderQueue(queue, now);
    assert.equal(view.lines.length, 2);
    assert.ok(view.lines[0]!.includes("postgres.row.delete"));
    assert.ok(view.lines[1]!.includes("unknown"));
    assert.ok(view.lines[0]!.includes("h0001"));
    queue.close();
    await Promise.allSettled([first, second]);
  });

  test("y approves, n denies, anything else decides nothing", () => {
    assert.deepEqual(keyToRelease("y"), { kind: "approved" });
    assert.deepEqual(keyToRelease("n"), { kind: "denied", by: "cli" });
    assert.equal(keyToRelease("q"), null);
    assert.equal(keyToRelease(""), null);
  });

  test("a keypress resolves the row it names", async () => {
    const queue = new HoldQueue();
    const waiting = queue.hold(call, 120);
    const view = renderQueue(queue);
    assert.equal(decideKeypress(queue, view, "n", 0), true);
    const resolution = await waiting;
    assert.equal(resolution.outcome.kind, "released");
    if (resolution.outcome.kind === "released")
      assert.equal(resolution.outcome.release.kind, "denied");
  });

  test("a row that is gone or a key that decides nothing is a no-op", () => {
    const queue = new HoldQueue();
    const view = renderQueue(queue);
    assert.equal(decideKeypress(queue, view, "y", 7), false);
    assert.equal(decideKeypress(queue, view, "x", 0), false);
    queue.close();
  });

  test("renderHold shows the class, the radius and the rationale", () => {
    const line = renderHold(
      {
        ...call,
        id: "h0009",
        heldAt: 1,
        expiresAt: Date.now() + 60_000,
      },
      8,
      Date.now(),
    );
    assert.ok(line.includes("r1"));
    assert.ok(line.includes("41883"));
    assert.ok(line.includes("human looks first"));
  });

  test("renderHold carries the held arguments so the operator decides on values", () => {
    const line = renderHold(
      {
        ...call,
        id: "h0010",
        heldAt: 1,
        expiresAt: Date.now() + 60_000,
        args: { bucket: "acme-invoices", key: "2026/oct-final.pdf" },
      },
      9,
      Date.now(),
    );
    assert.ok(line.includes("acme-invoices"));
    assert.ok(line.includes("2026/oct-final.pdf"));
  });

  test("renderHold redacts secrets in arguments and never prints the value", () => {
    const line = renderHold(
      {
        ...call,
        id: "h0011",
        heldAt: 1,
        expiresAt: Date.now() + 60_000,
        args: { Authorization: "Bearer sekret-999", note: "call Accounting" },
      },
      10,
      Date.now(),
    );
    assert.ok(line.includes("[redacted]"));
    assert.ok(!line.includes("sekret-999"));
  });

  test("renderHold bounds oversized arguments instead of blowing the row", () => {
    const args: Record<string, unknown> = { payload: "x".repeat(500) };
    const line = renderHold(
      {
        ...call,
        id: "h0012",
        heldAt: 1,
        expiresAt: Date.now() + 60_000,
        args,
      },
      11,
      Date.now(),
    );
    assert.ok(line.includes("..."));
    assert.ok(line.length < 400);
  });
});
