import assert from "node:assert/strict";
import test from "node:test";
import { createProviderClient } from "./factory.ts";

const config = {
  providerId: "mistral",
  transport: "mistral-conversations" as const,
  baseUrl: "https://api.mistral.ai",
  auth: { kind: "api-key" as const, apiKey: "mistral-fixture-secret" },
};

test("Mistral Conversations reports stream timeouts distinctly", async () => {
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
  const client = createProviderClient(config, async () => response);

  await assert.rejects(
    client.complete(
      "mistral-fixture",
      [{ role: "user", content: "go" }],
      [],
      new AbortController().signal,
      () => {},
    ),
    /Provider request timed out\./,
  );
});
