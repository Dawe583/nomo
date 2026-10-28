import assert from "node:assert/strict";
import test from "node:test";
import { createProviderClient } from "./factory.ts";

const config = {
  providerId: "ollama",
  transport: "ollama-chat" as const,
  baseUrl: "http://127.0.0.1:11434",
  auth: { kind: "none" as const },
};

test("Ollama NDJSON stream reports body timeouts distinctly", async () => {
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.error(
          new DOMException("The operation timed out.", "TimeoutError"),
        );
      },
    }),
    { headers: { "content-type": "application/x-ndjson" } },
  );
  const client = createProviderClient(config, async () => response);

  await assert.rejects(
    client.complete(
      "qwen3:8b",
      [{ role: "user", content: "go" }],
      [],
      new AbortController().signal,
    ),
    /Provider request timed out\./,
  );
});
