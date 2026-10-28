import assert from "node:assert/strict";
import test from "node:test";
import { createProviderClient } from "./factory.ts";

test("compatible catalog timeout is reported as a timeout", async () => {
  const client = createProviderClient(
    { baseUrl: "https://provider.test/v1", apiKey: "fixture-key" },
    async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    },
  );

  await assert.rejects(client.models(), /Provider request timed out\./);
});
