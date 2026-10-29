import assert from "node:assert/strict";
import test from "node:test";
import { CompatibleProvider } from "./provider.ts";

const config = {
  baseUrl: "https://api.tokenrouter.com/v1",
  apiKey: "fixture-secret",
};

test("OpenAI-compatible JSON response reports body timeouts distinctly", async () => {
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.error(
          new DOMException("The operation timed out.", "TimeoutError"),
        );
      },
    }),
    { headers: { "content-type": "application/json" } },
  );
  const provider = new CompatibleProvider(config, async () => response);

  await assert.rejects(provider.models(), /Provider request timed out\./);
});
