import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const main = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
const ui = readFileSync(new URL("./ui.tsx", import.meta.url), "utf8");
const pages = readFileSync(new URL("./pages.tsx", import.meta.url), "utf8");

test("a run stop shows server acknowledgement, never a local success guess", () => {
  // The dialog gates the ack line on the server response: "acknowledged" only
  // after /stop returns ack: acknowledged, and the scope note names this
  // process as the kill boundary with in-flight work left unknown.
  assert.match(
    pages,
    /result\.ack === "acknowledged" \? "acknowledged" : "unknown"/,
    "ack state follows the server, not a local optimist",
  );
  assert.match(pages, /Kill scope is this process only/);
  assert.match(pages, /stay unknown until their result confirms/);
  // A missing acknowledgement must be rendered as not-success, explicitly.
  assert.match(pages, /No stop acknowledgement yet\. Success is not shown\./);
});

test("the in-flight call stays visible after an acknowledged stop", () => {
  // overview-state carries inFlight even when stopAck is acknowledged, so the
  // operator still sees the call whose result has not landed.
  assert.match(pages, /inFlight|stay unknown until their result confirms/);
});

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

test("the overview page renders the registered agent and its run state", () => {
  // Fleet view (plan Task 7): the overview shows one registered agent and its
  // current run state, falling back to a placeholder / "unknown" when the
  // server has nothing to report.
  assert.match(pages, /data\?\.agentId \?\? /, "agent id rendered with fallback");
  assert.match(pages, /data\?\.runState \?\? t\("neznámý", "unknown"\)/, "run state rendered with unknown fallback");
  assert.match(pages, /data\?\.stopAck === "acknowledged"/, "stop ack status line rendered");
});

test("the overview page shows only metadata fields for latest events", () => {
  // The event row rendering hardcodes a metadata allow-list (kind/at/label/
  // verdict). Slice from the latestEvents block to the end of its list and
  // assert no prompt-carrying field name appears inside it.
  const start = pages.indexOf("data?.latestEvents");
  assert.ok(start >= 0, "latestEvents rendered on the overview");
  const block = pages
    .slice(start, pages.indexOf("</ul>", start))
    .replace(/\/\/[^\n]*/g, "");
  assert.match(block, /kind/, "kind rendered");
  assert.match(block, /at/, "at rendered");
  assert.match(block, /label/, "label rendered");
  assert.match(block, /verdict/, "verdict rendered");
  assert.doesNotMatch(block, /\btext\b|\bpayload\b|\bprompt\b|\btoken\b/);
});

test("in-flight calls show the unknown-until-confirmed note", () => {
  // An unconfirmed dispatched call must never read as resolved; the overview
  // carries the same scope note as the stop dialog.
  assert.match(pages, /Calls already dispatched upstream stay unknown until their result confirms\./);
});
