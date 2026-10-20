import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_TOAST_LIMITS,
  dismissToast,
  expireToasts,
  raiseToast,
  renderToasts,
  type Toast,
  type ToastHost,
} from "./toast.ts";
import { stripAnsi, visibleLength } from "./layout.ts";

function toast(
  id: string,
  tone: Toast["tone"] = "info",
  at = 100,
  ttl = 4000,
  message = id,
  icon = "i",
): Toast {
  return { id, tone, at, ttl, message, icon };
}

function host(...toasts: Toast[]): ToastHost {
  return { toasts, active: toasts[0] };
}

test("raising replaces duplicate ids and resolves negative ttl", () => {
  const original = host(toast("other", "warning"), toast("same"));
  const result = raiseToast(
    original,
    toast("same", "success", 200, -1, "refreshed"),
  );

  assert.equal(result.active?.message, "refreshed");
  assert.equal(result.toasts[0]?.ttl, DEFAULT_TOAST_LIMITS.defaultTtl);
  assert.deepEqual(result.toasts.map(({ id }) => id), ["same", "other"]);
  assert.equal(original.toasts[1]?.message, "same");
  assert.notEqual(result.toasts, original.toasts);
});

test("the queue evicts an old normal toast before pending safety states", () => {
  const original = host(
    toast("notice", "success"),
    toast("approval", "pending", 90, 0),
    toast("blocked", "danger", 80, 0),
  );
  const result = raiseToast(
    original,
    toast("fresh", "info"),
    { max: 3, defaultTtl: 1000 },
  );

  assert.deepEqual(result.toasts.map(({ id }) => id), [
    "fresh",
    "approval",
    "blocked",
  ]);
  assert.deepEqual(original.toasts.map(({ id }) => id), [
    "notice",
    "approval",
    "blocked",
  ]);
});

test("the queue still applies its cap when every toast is safety state", () => {
  const result = raiseToast(
    host(toast("approval", "pending", 90, 0), toast("blocked", "danger", 80, 0)),
    toast("new approval", "pending", 110, 0),
    { max: 2, defaultTtl: 1000 },
  );

  assert.deepEqual(result.toasts.map(({ id }) => id), [
    "new approval",
    "approval",
  ]);
});

test("expiry removes elapsed positive ttl and keeps sticky toasts", () => {
  const original = host(
    toast("fresh", "info", 100, 400),
    toast("sticky", "pending", 90, 0),
  );

  assert.equal(expireToasts(original, 499), original);
  const expired = expireToasts(original, 500);
  assert.deepEqual(expired.toasts.map(({ id }) => id), ["sticky"]);
  assert.equal(expired.active?.id, "sticky");
  assert.deepEqual(original.toasts.map(({ id }) => id), ["fresh", "sticky"]);
});

test("dismiss reveals the next toast and missing ids preserve the host", () => {
  const original = host(toast("first"), toast("second", "warning"));

  assert.equal(dismissToast(original, "missing"), original);
  const dismissed = dismissToast(original, "first");
  assert.deepEqual(dismissed.toasts.map(({ id }) => id), ["second"]);
  assert.equal(dismissed.active?.id, "second");
  assert.deepEqual(dismissToast(dismissed, "second").toasts, []);
});

test("render handles empty queues and narrow widths", () => {
  assert.deepEqual(renderToasts(host(), 40), []);
  assert.deepEqual(renderToasts(host(toast("notice")), 0), []);

  const narrow = renderToasts(host(toast("界界界界界界界界")), 14);
  assert.equal(narrow.length, 1);
  assert.equal(visibleLength(narrow[0]!), 14);
});

test("render sanitizes controls and keeps each toast to one row", () => {
  const rendered = renderToasts(
    host(toast("hostile", "danger", 100, 4000, "first\nsecond\u001b[2J", "\u001b[31m")),
    80,
  );

  assert.equal(rendered.length, 1);
  assert.match(rendered[0]!, /^\? \[DANGER\] first\?second\?\[2J$/);
  assert.doesNotMatch(rendered[0]!, /\u001b/);
});

test("color is opt in and leaves toast text unchanged", () => {
  const current = host(toast("colored", "danger"));
  const plain = renderToasts(current, 40)[0]!;
  const colored = renderToasts(current, 40, { color: true })[0]!;

  assert.doesNotMatch(plain, /\u001b/);
  assert.match(colored, /\u001b\[/);
  assert.equal(stripAnsi(colored), plain);
});
