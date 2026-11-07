/**
 * ASCII status-tag helpers: presentational, data-tone to plain text only.
 *
 * Built against hand-written fake elements rather than a DOM dependency, the
 * same convention app.test.mjs already uses for createApp. Each fake exposes
 * only the handful of methods the module actually calls, named so a missing
 * call shows up as a thrown TypeError pointing at the right method.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { asciiStatusScan, asciiStatusTag } from "./mobile-ascii.js";

function fakeDocument() {
  return {
    createElement(tag) {
      const el = {
        tagName: tag,
        className: "",
        attrs: {},
        setAttribute(name, value) { el.attrs[name] = String(value); },
        getAttribute(name) { return el.attrs[name] ?? null; },
      };
      return el;
    },
  };
}

function fakeElement({ tone, existingTag = false } = {}) {
  const ownerDocument = fakeDocument();
  const prepended = [];
  const el = {
    ownerDocument,
    attrs: tone === undefined ? {} : { "data-tone": tone },
    getAttribute(name) { return el.attrs[name] ?? null; },
    querySelector(selector) {
      assert.equal(selector, ":scope > .status-tag");
      return existingTag ? { className: "status-tag" } : null;
    },
    prepend(node) { prepended.push(node); el.firstChild = node; },
    prepended,
  };
  return el;
}

test("a known tone gets its short label, and prepends rather than appends", () => {
  const el = fakeElement({ tone: "warn" });
  asciiStatusTag(el);
  assert.equal(el.prepended.length, 1);
  const tag = el.prepended[0];
  assert.equal(tag.tagName, "span");
  assert.equal(tag.className, "status-tag");
  assert.equal(tag.getAttribute("data-label"), "!");
  assert.equal(tag.getAttribute("aria-hidden"), "true");
});

test("every documented tone maps to its label, and an unknown tone is a question mark", () => {
  for (const [tone, label] of [["ok", "OK"], ["info", "i"], ["warn", "!"], ["bad", "x"]]) {
    const el = fakeElement({ tone });
    asciiStatusTag(el);
    assert.equal(el.prepended[0].getAttribute("data-label"), label);
  }
  const unknown = fakeElement({ tone: "mystery" });
  asciiStatusTag(unknown);
  assert.equal(unknown.prepended[0].getAttribute("data-label"), "?");
});

test("calling it twice does not double the tag, so a re-render stays idempotent", () => {
  const el = fakeElement({ tone: "ok", existingTag: true });
  asciiStatusTag(el);
  assert.equal(el.prepended.length, 0, "a tag already present must not be duplicated");
});

test("an element with no data-tone still gets a tag, because bad is the honest default", () => {
  const el = fakeElement();
  asciiStatusTag(el);
  assert.equal(el.prepended[0].getAttribute("data-label"), "?");
});

test("asciiStatusTag tolerates a null or non-element argument", () => {
  assert.doesNotThrow(() => asciiStatusTag(null));
  assert.doesNotThrow(() => asciiStatusTag(undefined));
});

test("asciiStatusScan tags every [data-tone] node under a root and reports the count", () => {
  const calls = [];
  const nodes = [fakeElement({ tone: "ok" }), fakeElement({ tone: "bad" })];
  const root = {
    querySelectorAll(selector) {
      calls.push(selector);
      return nodes;
    },
  };
  const count = asciiStatusScan(root);
  assert.deepEqual(calls, ["[data-tone]"]);
  assert.equal(count, 2);
  assert.equal(nodes[0].prepended[0].getAttribute("data-label"), "OK");
  assert.equal(nodes[1].prepended[0].getAttribute("data-label"), "x");
});

test("asciiStatusScan tolerates a root with no querySelectorAll, and reports zero", () => {
  assert.equal(asciiStatusScan(null), 0);
  assert.equal(asciiStatusScan({}), 0);
});
