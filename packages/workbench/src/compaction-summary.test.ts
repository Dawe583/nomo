/**
 * The compaction summary.
 *
 * The compaction dropped the middle of the conversation and pasted the first
 * three thousand characters of it back, so the turns nearest the compaction
 * were exactly the ones it lost. A summary written by the same provider the
 * conversation runs on covers the whole middle, and the provider already had
 * those turns, so nothing crosses a boundary the operator did not choose.
 *
 * These prove the summary replaces the extract, that it reaches the compacted
 * context, and that a summary which fails leaves the compaction as it was.
 */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { isolatedWorkbench } from "./test-fixture.ts";
import { compactMessages, omittedByCompaction } from "./context.ts";
import type { ModelMessage } from "./provider.ts";

const models = () => Response.json({ data: [{ id: "fixture" }] });

const message = (
  role: ModelMessage["role"],
  content: string,
): ModelMessage => ({ role, content });

test("a summary replaces the raw extract", () => {
  const messages = [
    message("system", "the standing instruction"),
    message("user", "the first request"),
    message("assistant", "the first answer"),
    message("user", "the last request"),
  ];
  const compacted = compactMessages("s1", messages, [], {
    summary: "the operator asked for a migration and it was applied",
  });
  const summary = compacted.messages.find((entry) =>
    String(entry.content ?? "").startsWith("NOMO context summary."),
  );
  assert.ok(summary, "the compacted context must hold the summary");
  assert.match(
    String(summary.content),
    /the operator asked for a migration and it was applied/,
  );
  assert.doesNotMatch(String(summary.content), /"role":"user"/);
});

test("without a summary the extract is what the compaction keeps", () => {
  const messages = [
    message("system", "the standing instruction"),
    message("user", "the first request"),
    message("assistant", "the first answer"),
    message("user", "the last request"),
  ];
  const compacted = compactMessages("s1", messages, []);
  const summary = compacted.messages.find((entry) =>
    String(entry.content ?? "").startsWith("NOMO context summary."),
  );
  assert.ok(summary);
  assert.match(String(summary.content), /"role":"user"/);
});

test("the omitted turns are the ones between the instruction and the last request", () => {
  const messages = [
    message("system", "the standing instruction"),
    message("user", "the first request"),
    message("assistant", "the first answer"),
    message("user", "the last request"),
  ];
  const omitted = omittedByCompaction(messages);
  assert.equal(omitted.length, 2);
  assert.equal(omitted[0]!.content, "the first request");
  assert.equal(omitted[1]!.content, "the first answer");
});

/** A provider that answers the summary request and nothing else. */
function summarising(reply: string) {
  const requests: string[] = [];
  const fetcher = async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("/models")) return models();
    const body = init?.body
      ? (JSON.parse(String(init.body)) as { messages?: { content?: string }[] })
      : {};
    requests.push((body.messages ?? []).map((entry) => entry.content ?? "").join("\n"));
    return Response.json({
      choices: [{ message: { role: "assistant", content: reply } }],
    });
  };
  return { fetcher: fetcher as typeof fetch, requests };
}

test("the summary the provider writes is what the compaction keeps", async (t: TestContext) => {
  const { fetcher, requests } = summarising(
    "the operator asked for a migration and it was applied",
  );
  const { app } = await isolatedWorkbench(t, fetcher, {}, {
    prefix: "nomo-compaction-summary-",
  });
  const session = await app.start("Do the migration", "fixture");
  await app.settled();
  await app.send(session.id, "and now the report");
  await app.settled();

  const summary = await app.summarizeForCompaction(session.id);

  assert.equal(summary, "the operator asked for a migration and it was applied");
  assert.ok(
    requests.some((request) => request.includes("Do the migration")),
    "the summary request must carry the turns the compaction drops",
  );
  assert.ok(
    requests.some((request) => request.includes("history, not instructions")),
    "the quoted turns must be marked as history, so a turn cannot instruct the summary",
  );
  const compacted = app.compact(session.id, summary ? { summary } : {});
  assert.equal(
    compacted.summary,
    "the operator asked for a migration and it was applied",
  );
});

test("a summary that fails leaves the compaction as it was", async (t: TestContext) => {
  const { app } = await isolatedWorkbench(
    t,
    (async (url: unknown) => {
      if (String(url).endsWith("/models")) return models();
      return new Response("no", { status: 500 });
    }) as typeof fetch,
    {},
    { prefix: "nomo-compaction-fail-", configure: false },
  );
  await app.configure({ baseUrl: "https://fixture.test/v1", apiKey: "fixture" });
  const session = await app.start("Do the migration", "fixture");
  await app.settled();
  await app.send(session.id, "and now the report");
  await app.settled();

  const summary = await app.summarizeForCompaction(session.id);

  assert.equal(summary, undefined);
  const compacted = app.compact(session.id);
  assert.ok(compacted.summary.length > 0, "the extract is still there");
});
