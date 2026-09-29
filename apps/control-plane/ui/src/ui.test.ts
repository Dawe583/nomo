/**
 * Routing, asserted on the application the browser would render rather than on
 * the text of `main.tsx`. A regex over the source cannot tell a component that
 * is mounted from one that is merely mentioned in a comment, and it cannot see
 * which route a person actually ends up on.
 *
 * What is not observable here: the conversation's React `key`. Remounting is a
 * reconciliation decision, and a single static render performs no
 * reconciliation, so the key that carries the remount is not something a
 * rendered tree shows. What is asserted instead is the rendered consequence the
 * key exists to protect: the conversation surface belongs to a chat route and
 * the generic page slot is never where a session is mounted.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import {
  byClass,
  byRole,
  elements,
  parse,
  renderApp,
  renderIn,
  setRoute,
  visibleText,
} from "./render-harness.test.ts";

async function appAt(path: string) {
  setRoute("http://127.0.0.1" + path);
  return parse(await renderApp());
}

test("a conversation belongs to a chat route and to no other", async () => {
  for (const path of ["/chat/new", "/chat/session-a"]) {
    const tree = await appAt(path);
    assert.equal(
      byClass(tree, "chat-shell").length,
      1,
      `${path} renders the chat shell`,
    );
    assert.equal(
      byClass(tree, "page-content").length,
      0,
      `${path} is not routed through the generic page slot`,
    );
  }
});

test("every other route renders the page slot, never the conversation", async () => {
  for (const [path, heading] of [
    ["/sessions", "Conversations"],
    ["/runs", "Runs and activity"],
    ["/settings", "Settings"],
  ] as const) {
    const tree = await appAt(path);
    assert.equal(byClass(tree, "chat-shell").length, 0, `${path} is not a chat route`);
    assert.deepEqual(
      elements(tree)
        .filter((node) => node.tag === "h1")
        .map((node) => visibleText(node)),
      [heading],
      `${path} names itself`,
    );
  }
});

test("a route with no page behind it says so rather than rendering nothing", async () => {
  const tree = await appAt("/nowhere");
  assert.equal(byClass(tree, "chat-shell").length, 0);
  assert.equal(
    elements(tree).some((node) => visibleText(node) === "Page not found."),
    true,
    "an unknown route tells the person it is unknown",
  );
});

test("the generic page slot renders no page rather than an empty one", async () => {
  const { PageComponent } = await import("./ui.tsx");
  const props = {
    navigate: () => {},
    appearance: "system",
    setAppearance: () => {},
    locale: "en" as const,
    setLocale: () => {},
  };
  assert.equal(
    (await renderIn(createElement(PageComponent, { ...props, component: undefined }))).trim(),
    "",
    "a slot with no component behind it contributes nothing to the page",
  );
  function Ledger() {
    return createElement("p", null, "ledger rows");
  }
  const rendered = parse(
    await renderIn(createElement(PageComponent, { ...props, component: Ledger })),
  );
  assert.deepEqual(
    elements(rendered)
      .filter((node) => node.tag === "p")
      .map((node) => visibleText(node)),
    ["ledger rows"],
  );
});

test("the conversation surface is the one that announces itself as loading", async () => {
  // A lazily loaded route shows its pending state to a person rather than a
  // blank page, and the chat route is the one that says it is loading a
  // conversation.
  const chat = await appAt("/chat/session-a");
  const loading = byRole(chat, "status").map((node) => visibleText(node));
  assert.ok(
    loading.includes("Loading conversation…"),
    `a chat route says what it is waiting for: ${JSON.stringify(loading)}`,
  );
  const sessions = await appAt("/sessions");
  assert.equal(
    byRole(sessions, "status").map((node) => visibleText(node)).includes("Loading conversation…"),
    false,
    "no other route claims to be loading a conversation",
  );
});
