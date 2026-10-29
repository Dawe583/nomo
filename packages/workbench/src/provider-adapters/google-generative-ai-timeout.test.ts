import assert from "node:assert/strict";
import test from "node:test";
import { createProviderClient } from "./factory.ts";

const config = {
  providerId: "google",
  transport: "google-generative-ai" as const,
  baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  auth: { kind: "api-key" as const, apiKey: "fixture-key" },
};

test("Google GenAI reports internal request timeout distinctly", async () => {
  const client = createProviderClient(config, async () => {
    throw new DOMException("The operation timed out.", "TimeoutError");
  });

  await assert.rejects(
    client.complete(
      "gemini-fixture",
      [{ role: "user", content: "go" }],
      [],
      new AbortController().signal,
    ),
    /Provider request timed out\./,
  );
});

test("Google GenAI reports stream timeouts distinctly", async () => {
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
      "gemini-fixture",
      [{ role: "user", content: "go" }],
      [],
      new AbortController().signal,
      () => {},
    ),
    /Provider request timed out\./,
  );
});
