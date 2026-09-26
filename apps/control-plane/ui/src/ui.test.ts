import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const main = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
const ui = readFileSync(new URL("./ui.tsx", import.meta.url), "utf8");

test("a session change remounts the conversation, so an open branch dialog cannot outlive it", () => {
  // The branch dialog carries the seq and the prompt of the conversation it was
  // opened in, and posts them to /api/sessions/<id>/branches. It can only reach
  // another session's route if the Chat instance survives the navigation, so
  // the identity of that instance has to change with the session. This is the
  // root fix; anything that lets a branch dialog outlive its session is a
  // regression of it.
  assert.match(
    main,
    /page === "chat" && sessionId && sessionId !== "new" \? sessionId : undefined;/,
    "the route's session segment is the conversation identity",
  );
  assert.match(main, /<Chat\s*\n\s*key=\{chatId \?\? "new"\}/);
  // One mount, and it is not the generic page slot.
  assert.equal((main.match(/<Chat\b/g) ?? []).length, 1);
});

test("the generic page slot cannot be where that identity is fixed", () => {
  // `PageComponent` renders whatever `pageMap[page]` holds, and Chat is not in
  // that map: a key added to the slot would never observe a session change, so
  // it would fix nothing and would still remount every routed page.
  assert.match(ui, /export function PageComponent\(/);
  const pageMap = main.slice(
    main.indexOf("const pageMap"),
    main.indexOf("const queryClient"),
  );
  assert.ok(pageMap.length > 0, "the page map is readable");
  assert.doesNotMatch(pageMap, /\bchat\b/, "chat is not a page-map entry");
  // `PageProps` carries no route parameter, so no page in the map can tell two
  // paths that resolve to it apart. A route-derived key here would be inert for
  // every page that exists, and would remount one — discarding a typed provider
  // key, a half-filled connector or an open document review — the first time a
  // hand-typed sub-path differed from the bare one.
  const pageProps = ui.slice(
    ui.indexOf("export type PageProps"),
    ui.indexOf("export function PageComponent"),
  );
  assert.deepEqual(
    [...pageProps.matchAll(/^ {2}(\w+)\??:/gm)].map((match) => match[1]),
    ["navigate", "appearance", "setAppearance", "locale", "setLocale"],
    "no routed page receives a route parameter",
  );
});
