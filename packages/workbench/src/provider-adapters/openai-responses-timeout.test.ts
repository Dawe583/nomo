import assert from "node:assert/strict";
import test from "node:test";
import { createProviderClient } from "./factory.ts";
import type { ProviderAdapterConfig } from "./types.ts";

const config: ProviderAdapterConfig = {
  providerId: "openai",
  transport: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  auth: { kind: "api-key", apiKey: "fixture-key" },
};

test("OpenAI Responses reports internal request timeout distinctly", async () => {
  const client = createProviderClient(config, async () => {
    throw new DOMException("The operation timed out.", "TimeoutError");
  });
  await assert.rejects(
    client.complete(
      "gpt-fixture",
      [{ role: "user", content: "go" }],
      [],
      new AbortController().signal,
    ),
    /Provider request timed out\./,
  );
});

test("OpenAI Responses reports stream timeouts distinctly", async () => {
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
      "gpt-fixture",
      [{ role: "user", content: "go" }],
      [],
      new AbortController().signal,
      () => {},
    ),
    /Provider request timed out\./,
  );
});
