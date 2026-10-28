import test from "node:test";
import assert from "node:assert/strict";
import { CompatibleProvider } from "../provider.ts";

test("Anthropic stream reports timeouts distinctly", async () => {
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.error(
          new DOMException("The operation timed out.", "TimeoutError"),
        );
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
  const provider = new CompatibleProvider(
    {
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "fixture-secret",
      kind: "anthropic",
    },
    async () => response,
  );

  await assert.rejects(
    provider.complete(
      "claude-fixture",
      [{ role: "user", content: "go" }],
      [],
      new AbortController().signal,
      () => {},
    ),
    /Provider request timed out\./,
  );
});
