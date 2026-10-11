import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const main = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
const ui = readFileSync(new URL("./ui.tsx", import.meta.url), "utf8");
const pages = readFileSync(new URL("./pages.tsx", import.meta.url), "utf8");
const approvalReview = readFileSync(new URL("./approval-review.tsx", import.meta.url), "utf8");

test("approval review shows a redacted target and the exact identity binding", () => {
  assert.match(approvalReview, /record\.operationSummary/);
  for (const field of [
    "operationId",
    "operationDigest",
    "policyVersion",
    "policyDigest",
    "operatorId",
    "principalId",
    "agentId",
    "runId",
    "workspaceId",
    "upstreamId",
    "schemaDigest",
  ]) assert.match(approvalReview, new RegExp(`binding\.${field}`));
  assert.match(approvalReview, /No safe summary is available/);
  assert.match(approvalReview, /Local process OS account/);
  assert.match(approvalReview, /do not authenticate the caller/);
  assert.match(approvalReview, /any local process that can reach the port/);
  assert.doesNotMatch(approvalReview, /record\.(args|arguments)/);
});

test("a run stop shows server acknowledgement, never a local success guess", () => {
  assert.match(
    pages,
    /result\.ack === "acknowledged" \? "acknowledged" : "unknown"/,
    "ack state follows the server, not a local optimist",
  );
  assert.match(pages, /Kill scope is this process only/);
  assert.match(pages, /Unresolved calls are shown separately\./);
  assert.match(pages, /No stop acknowledgement yet\. Success is not shown\./);
});

test("the active-run count and unresolved calls use separate fields", () => {
  assert.match(pages, /Running or stopping runs/);
  assert.match(pages, /Run count, not call count/);
  assert.match(pages, /state\.unresolvedCalls/);
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

test("the overview page separates the registered agent from its run ID", () => {
  assert.match(pages, /state\.agentId \?\? /, "agent id rendered with fallback");
  assert.match(pages, /state\.runId \?\? /, "run ID rendered separately");
  assert.match(pages, /state\.runState \?\? t\("neznámý", "unknown"\)/, "run state rendered with unknown fallback");
  assert.match(pages, /state\.stopAck === "acknowledged"/, "stop ack status line rendered");
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

test("unconfirmed calls are separate from the active-run count", () => {
  assert.match(pages, /state\.unresolvedCalls/);
  assert.match(pages, /Unconfirmed tool calls/);
  assert.match(pages, /Unresolved calls are shown separately\./);
});
