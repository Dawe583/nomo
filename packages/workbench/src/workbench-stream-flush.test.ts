import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import { isolatedWorkbench, type WorkbenchFixture } from "./test-fixture.ts";
import type { ProviderAdapterConfig } from "./provider-adapters/types.ts";

/**
 * A provider chunk that is never followed by another one still has to reach
 * the transcript on its own clock. The workbench flushes buffered text when
 * the next chunk arrives, so a lone chunk used to stay invisible until the
 * turn ended: the answer had arrived and the screen said nothing.
 */
const descriptor: ProviderAdapterConfig = {
  providerId: "openai",
  transport: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  auth: { kind: "api-key", apiKey: "fixture-provider-secret" },
  model: "gpt-4.1",
};

const sse = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;

const completed = (text: string) => ({
  type: "response.completed",
  response: {
    id: "resp_fixture",
    status: "completed",
    output: text
      ? [{ type: "message", content: [{ type: "output_text", text }] }]
      : [],
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
  },
});

const settle = async (fixture: WorkbenchFixture, id: string) => {
  for (let poll = 0; poll < 400 && fixture.app.get(id)?.status === "running"; poll++)
    await delay(10);
  return fixture.app.get(id)!;
};

test("a lone streamed chunk becomes visible without a following chunk", async (t) => {
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Measured from the chunk's own arrival: startup and request setup are not
  // what the flush timer is responsible for.
  let chunkAt: number | undefined;
  const fetcher: typeof fetch = async (url) => {
    if (String(url).endsWith("/models"))
      return Response.json({ data: [{ id: "gpt-4.1" }] });
    // The completion event is withheld until the test has seen the delta.
    // A workbench that only flushes on the next chunk therefore deadlocks
    // here instead of quietly passing.
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        chunkAt = Date.now();
        controller.enqueue(
          encoder.encode(
            sse({ type: "response.output_text.delta", delta: "Slow answer." }),
          ),
        );
        await released;
        controller.enqueue(encoder.encode(sse(completed("Slow answer."))));
        controller.close();
      },
    });
    return new Response(body, {
      headers: { "content-type": "text/event-stream" },
    });
  };
  const fixture = await isolatedWorkbench(t, fetcher, {}, {
    configure: false,
    prefix: "nomo-stream-flush-",
  });
  await fixture.app.configure(descriptor);
  try {
    const started = await fixture.app.start("Question.", "gpt-4.1");
    let visibleAt: number | undefined;
    for (let poll = 0; poll < 100 && visibleAt === undefined; poll++) {
      const session = fixture.app.get(started.id);
      if (
        session?.events.some(
          (event) => event.type === "message.delta" && event.text === "Slow answer.",
        )
      )
        visibleAt = Date.now();
      else await delay(5);
    }
    assert.ok(
      visibleAt !== undefined,
      "the lone chunk must reach the transcript before the next chunk",
    );
    assert.ok(chunkAt !== undefined, "the fixture chunk must have been sent");
    assert.ok(
      visibleAt - chunkAt < 150,
      `first delta visible ${visibleAt - chunkAt} ms after the chunk, expected under 150 ms`,
    );
    assert.equal(
      fixture.app.get(started.id)?.status,
      "running",
      "the delta is visible while the turn is still running",
    );
    release();
    const session = await settle(fixture, started.id);
    assert.equal(session.status, "idle");
    const finished = session.events.filter(
      (event) => event.type === "message.completed" && event.kind === "assistant",
    );
    assert.deepEqual(
      finished.map((event) => event.text),
      ["Slow answer."],
      "the completed message carries the whole answer once",
    );
    const deltas = session.events.filter((event) => event.type === "message.delta");
    assert.equal(
      deltas.map((event) => event.text).join(""),
      "Slow answer.",
      "the final flush must not repeat text already shown",
    );
  } finally {
    release();
  }
});
