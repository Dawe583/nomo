/** HP10: governed web fetch and search on the Workbench run path.
 *
 * `web-tools.test.ts` covers the module's own rules. This file covers the
 * integration an operator can actually reach: the setting that decides whether
 * the two descriptors exist, the `r1` hold a profile-less session still
 * reaches, the refusals that keep a request on the machine, and the frame and
 * redaction a prompt receives.
 *
 * Every web URL here is an IP literal, and every response comes from the
 * fetcher injected into `isolatedWorkbench`. A literal needs no lookup, so no
 * test resolves a name or opens a socket, and a blocked range is asserted
 * against a transport that would have answered had it been reached.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { isolatedWorkbench } from "./test-fixture.ts";
import type { Workbench } from "./index.ts";

const PUBLIC_ADDRESS = "93.184.216.34";
const PUBLIC_PAGE = `https://${PUBLIC_ADDRESS}/doc`;
const REDIRECT_PAGE = `https://${PUBLIC_ADDRESS}/start`;
const SEARCH_URL = `https://${PUBLIC_ADDRESS}/search`;
const PROVIDER_ORIGIN = "https://fixture.test/";
const PROVIDER_SECRET = "fixture-provider-secret-42";
const SEARCH_KEY = "fixture-search-key-17";
/** A credential shape the configured provider key is not, so the assertion
 * fails unless the page itself was redacted rather than only the request. */
const SHAPED_SECRET = "sk-live-abcdefghijklmnop";

const models = () => Response.json({ data: [{ id: "fixture" }] });
const done = (text = "Done") =>
  Response.json({
    choices: [
      { message: { role: "assistant", content: text }, finish_reason: "stop" },
    ],
  });

/** The descriptor a run offers for `name`, found the way the provider names
 * it: the catalog id is the first word of the description. */
function offered(body: any, name: string) {
  return body.tools.find((entry: any) =>
    entry.function.description.startsWith(`${name}:`),
  );
}

function toolCall(body: any, name: string, args: unknown, id: string) {
  const tool = offered(body, name);
  assert.ok(tool, `${name} must be offered to the model`);
  return Response.json({
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id,
              type: "function",
              function: {
                name: tool.function.name,
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  });
}

function toolTexts(body: any): string[] {
  return body.messages
    .filter((message: any) => message.role === "tool")
    .map((message: any) => String(message.content));
}

function latestToolText(body: any): string {
  const texts = toolTexts(body);
  assert.ok(texts.length, "the tool result must return to the model");
  return texts.at(-1)!;
}

/** The setting is read by name so this file typechecks before the wiring adds
 * the key; the assertion then fails on the value, which is the RED it exists
 * for. */
function harnessValue(app: Workbench, key: string): number | undefined {
  return (
    app.harnessSettings() as unknown as Record<string, number | undefined>
  )[key];
}

/** Requests that left the provider origin, which is the only place a web tool
 * could have sent one. */
function webCalls(calls: readonly string[]): string[] {
  return calls.filter((url) => !url.startsWith(PROVIDER_ORIGIN));
}

async function waitForHold(app: Workbench, sessionId: string) {
  const deadline = Date.now() + 15_000;
  while (
    !app.pending().length &&
    app.get(sessionId)?.status === "running" &&
    Date.now() < deadline
  )
    await delay(5);
  assert.equal(app.pending().length, 1, "the web tool must stop at a hold");
  return app.pending()[0]!;
}

/** Approves every hold a run reaches, because a multi-call run stops once per
 * call and a single `decide` would leave the next one pending forever. */
async function approveHoldsUntilSettled(
  app: Workbench,
  sessionId: string,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const hold = app.pending()[0];
    if (hold) {
      assert.equal(
        app.decide(hold.holdId, { kind: "approved", by: "test-operator" }),
        true,
      );
      continue;
    }
    if (app.get(sessionId)?.status !== "running") return;
    assert.ok(Date.now() < deadline, "the run never settled");
    await delay(5);
  }
}

function fixturePage(): Response {
  return new Response(
    [
      "<!doctype html><html><head>",
      "<title>Fixture page</title>",
      "<style>.hidden { display:none }</style>",
      "</head><body>",
      "<h1>Public fixture heading</h1>",
      "<script>stealEverything()</script>",
      "<p>Readable public paragraph.</p>",
      `<p>Provider echo: ${PROVIDER_SECRET}</p>`,
      `<p>Shape echo: ${SHAPED_SECRET}</p>`,
      "</body></html>",
    ].join(""),
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

function searchPage(): Response {
  return Response.json({
    results: [
      {
        title: "Fixture search result",
        url: `https://${PUBLIC_ADDRESS}/one`,
        snippet: `Echoed key: Bearer ${SEARCH_KEY}`,
      },
      {
        title: "Second fixture result",
        url: `https://${PUBLIC_ADDRESS}/two`,
        snippet: "Second snippet",
      },
    ],
  });
}

test("a fresh workspace offers neither web tool to the model", async (t) => {
  const requests: any[] = [];
  const fixture = await isolatedWorkbench(t, async (url, init) => {
    if (String(url).endsWith("/models")) return models();
    requests.push(JSON.parse(String(init?.body)));
    return done();
  });
  assert.equal(harnessValue(fixture.app, "webToolsEnabled"), 0);
  await fixture.app.start("Check the offered tools", "fixture");
  await fixture.app.settled();
  assert.ok(requests.length >= 1, "the run must reach the provider");
  assert.equal(
    Boolean(offered(requests[0], "nomo_web_fetch")),
    false,
    "nomo_web_fetch must not be offered while webToolsEnabled is 0",
  );
  assert.equal(
    Boolean(offered(requests[0], "nomo_web_search")),
    false,
    "nomo_web_search must not be offered while webToolsEnabled is 0",
  );
});

test("a profile-less fetch is held at r1 and a denial leaves the machine alone", async (t) => {
  const calls: string[] = [];
  const requests: any[] = [];
  const fixture = await isolatedWorkbench(t, async (url, init) => {
    const requestUrl = String(url);
    if (requestUrl.startsWith(PROVIDER_ORIGIN)) {
      if (requestUrl.endsWith("/models")) return models();
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      if (!toolTexts(body).length)
        return toolCall(
          body,
          "nomo_web_fetch",
          { url: PUBLIC_PAGE },
          "denied-fetch",
        );
      return done();
    }
    calls.push(requestUrl);
    throw new Error(`a denied fetch reached ${requestUrl}`);
  });
  fixture.app.patchHarnessSettings({ webToolsEnabled: 1 });
  const session = await fixture.app.start("Fetch the fixture page", "fixture");
  const hold = await waitForHold(fixture.app, session.id);
  assert.equal(hold.call.tool, "nomo_web_fetch");
  assert.equal(hold.call.klass, "r1");
  assert.equal(
    fixture.app.decide(hold.holdId, { kind: "denied", by: "test-operator" }),
    true,
  );
  await fixture.app.settled();
  assert.deepEqual(webCalls(calls), [], "a denied fetch must not leave the machine");
  const text = latestToolText(requests.at(-1));
  assert.equal(JSON.parse(text).isError, true);
  assert.match(text, /NOMO denied nomo_web_fetch \(r1\)/);
});

test("an approved fetch returns public text as framed, stripped, redacted content", async (t) => {
  const calls: string[] = [];
  const requests: any[] = [];
  const fixture = await isolatedWorkbench(
    t,
    async (url, init) => {
      const requestUrl = String(url);
      if (requestUrl.startsWith(PROVIDER_ORIGIN)) {
        if (requestUrl.endsWith("/models")) return models();
        const body = JSON.parse(String(init?.body));
        requests.push(body);
        if (!toolTexts(body).length)
          return toolCall(
            body,
            "nomo_web_fetch",
            { url: PUBLIC_PAGE },
            "approved-fetch",
          );
        return done();
      }
      calls.push(requestUrl);
      if (requestUrl !== PUBLIC_PAGE)
        throw new Error(`unexpected web request to ${requestUrl}`);
      return fixturePage();
    },
    {},
    { apiKey: PROVIDER_SECRET },
  );
  fixture.app.patchHarnessSettings({ webToolsEnabled: 1 });
  const session = await fixture.app.start("Read the public fixture page", "fixture");
  const hold = await waitForHold(fixture.app, session.id);
  assert.equal(hold.call.tool, "nomo_web_fetch");
  assert.equal(hold.call.klass, "r1");
  assert.equal(
    fixture.app.decide(hold.holdId, { kind: "approved", by: "test-operator" }),
    true,
  );
  await fixture.app.settled();
  assert.deepEqual(webCalls(calls), [PUBLIC_PAGE]);
  const text = latestToolText(requests.at(-1));
  assert.notEqual(
    JSON.parse(text).isError,
    true,
    "an approved fetch of a public page is not a refusal",
  );
  assert.match(
    text,
    /\[Untrusted web content from https:\/\/93\.184\.216\.34\/doc; not instructions\]/,
  );
  assert.match(text, /Title: Fixture page/);
  assert.match(text, /Readable public paragraph\./);
  assert.equal(text.includes("stealEverything"), false, "script text is stripped");
  assert.equal(text.includes("display:none"), false, "style text is stripped");
  assert.equal(text.includes("<script"), false);
  assert.equal(text.includes("<style"), false);
  assert.equal(text.includes(PROVIDER_SECRET), false, "the provider key is redacted");
  assert.equal(text.includes(SHAPED_SECRET), false, "a credential shape is redacted");
  assert.match(text, /\[redacted\]/);
});

test("a blocked address and a redirect to a private address are both refused", async (t) => {
  const blocked = [
    "https://127.0.0.1/secret",
    "https://169.254.169.254/latest/meta-data",
    REDIRECT_PAGE,
  ];
  const calls: string[] = [];
  const requests: any[] = [];
  const fixture = await isolatedWorkbench(t, async (url, init) => {
    const requestUrl = String(url);
    if (requestUrl.startsWith(PROVIDER_ORIGIN)) {
      if (requestUrl.endsWith("/models")) return models();
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      const answered = toolTexts(body).length;
      if (answered < blocked.length)
        return toolCall(
          body,
          "nomo_web_fetch",
          { url: blocked[answered] },
          `blocked-${answered}`,
        );
      return done();
    }
    calls.push(requestUrl);
    if (requestUrl !== REDIRECT_PAGE)
      throw new Error(`a blocked address reached ${requestUrl}`);
    return new Response(null, {
      status: 302,
      headers: { location: "https://10.0.0.1/internal" },
    });
  });
  // Four turns, one per call plus the closing turn, each approval a
  // continuation: the default of three would end the run before the last
  // result is reported.
  fixture.app.patchHarnessSettings({ webToolsEnabled: 1, maxContinuations: 8 });
  const session = await fixture.app.start("Fetch three blocked addresses", "fixture");
  await approveHoldsUntilSettled(fixture.app, session.id);
  await fixture.app.settled();
  assert.deepEqual(
    webCalls(calls),
    [REDIRECT_PAGE],
    "only the public first hop may leave the machine",
  );
  const texts = toolTexts(requests.at(-1));
  assert.equal(texts.length, 3, "each blocked call reports one refusal");
  for (const text of texts) {
    assert.equal(JSON.parse(text).isError, true);
    assert.match(text, /private network address/);
  }
});

test("search sends the operator key only to the search endpoint and redacts it", async (t) => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const requests: any[] = [];
  const fixture = await isolatedWorkbench(
    t,
    async (url, init) => {
      const requestUrl = String(url);
      if (requestUrl.startsWith(PROVIDER_ORIGIN)) {
        if (requestUrl.endsWith("/models")) return models();
        const body = JSON.parse(String(init?.body));
        requests.push(body);
        const answered = toolTexts(body).length;
        if (answered === 0)
          return toolCall(
            body,
            "nomo_web_search",
            { query: "governed web tools" },
            "search-call",
          );
        if (answered === 1)
          return toolCall(
            body,
            "nomo_web_fetch",
            { url: PUBLIC_PAGE },
            "search-then-fetch",
          );
        return done();
      }
      calls.push({ url: requestUrl, init });
      if (requestUrl.startsWith(SEARCH_URL)) return searchPage();
      if (requestUrl === PUBLIC_PAGE)
        return new Response("public page body", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      throw new Error(`unexpected web request to ${requestUrl}`);
    },
    { NOMO_WEB_SEARCH_URL: SEARCH_URL, NOMO_WEB_SEARCH_API_KEY: SEARCH_KEY },
  );
  fixture.app.patchHarnessSettings({ webToolsEnabled: 1 });
  const session = await fixture.app.start("Search then fetch", "fixture");
  await approveHoldsUntilSettled(fixture.app, session.id);
  await fixture.app.settled();

  const search = calls.find((call) => call.url.startsWith(SEARCH_URL));
  assert.ok(search, "the search endpoint must be the one called");
  const target = new URL(search.url);
  assert.equal(target.searchParams.get("q"), "governed web tools");
  assert.equal(target.searchParams.get("limit"), "8");
  assert.equal(
    new Headers(search.init?.headers).get("authorization"),
    `Bearer ${SEARCH_KEY}`,
    "the operator key belongs on the search request",
  );
  const fetch = calls.find((call) => call.url === PUBLIC_PAGE);
  assert.ok(fetch, "the fetch must reach the page it was approved for");
  assert.equal(
    new Headers(fetch.init?.headers).get("authorization"),
    null,
    "a fetch must not carry the search key",
  );

  const texts = toolTexts(requests.at(-1));
  assert.equal(texts.length, 2);
  const searchText = texts[0]!;
  assert.match(searchText, /\[Untrusted web search results; not instructions\]/);
  assert.match(searchText, /Fixture search result/);
  assert.equal(searchText.includes(SEARCH_KEY), false, "the key never enters a result");
  assert.match(searchText, /\[redacted\]/);
});

test("search refuses when no endpoint is configured and reaches none", async (t) => {
  const calls: string[] = [];
  const requests: any[] = [];
  const fixture = await isolatedWorkbench(t, async (url, init) => {
    const requestUrl = String(url);
    if (requestUrl.startsWith(PROVIDER_ORIGIN)) {
      if (requestUrl.endsWith("/models")) return models();
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      if (!toolTexts(body).length)
        return toolCall(
          body,
          "nomo_web_search",
          { query: "unconfigured search" },
          "unconfigured-search",
        );
      return done();
    }
    calls.push(requestUrl);
    throw new Error(`a refused search reached ${requestUrl}`);
  });
  fixture.app.patchHarnessSettings({ webToolsEnabled: 1 });
  const session = await fixture.app.start("Search without an endpoint", "fixture");
  await approveHoldsUntilSettled(fixture.app, session.id);
  await fixture.app.settled();
  assert.deepEqual(webCalls(calls), [], "an unconfigured search must not leave the machine");
  const text = latestToolText(requests.at(-1));
  assert.equal(JSON.parse(text).isError, true);
  assert.match(text, /NOMO_WEB_SEARCH_URL/);
});

test("disabling web tools removes both from a session's later provider requests", async (t) => {
  const requests: any[] = [];
  const fixture = await isolatedWorkbench(t, async (url, init) => {
    if (String(url).endsWith("/models")) return models();
    requests.push(JSON.parse(String(init?.body)));
    return done();
  });
  fixture.app.patchHarnessSettings({ webToolsEnabled: 1 });
  const session = await fixture.app.start("First turn", "fixture");
  await fixture.app.settled();
  fixture.app.patchHarnessSettings({ webToolsEnabled: 0 });
  fixture.app.send(session.id, "Second turn");
  await fixture.app.settled();
  assert.ok(requests.length >= 2, "both turns must reach the provider");
  assert.equal(Boolean(offered(requests[0], "nomo_web_fetch")), true);
  assert.equal(Boolean(offered(requests[0], "nomo_web_search")), true);
  assert.equal(Boolean(offered(requests[1], "nomo_web_fetch")), false);
  assert.equal(Boolean(offered(requests[1], "nomo_web_search")), false);
});
