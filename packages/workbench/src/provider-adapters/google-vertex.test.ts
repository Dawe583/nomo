import test from "node:test";
import assert from "node:assert/strict";
import { createProviderClient } from "./factory.ts";
import { CONFIGURABLE_PROVIDER_DESCRIPTORS, PROVIDER_MODEL_MANIFEST } from "../provider-catalog.ts";

const standardVertex = {
  providerId: "google-vertex",
  transport: "google-vertex",
  baseUrl: "https://us-central1-aiplatform.googleapis.com",
  vertexOptions: {
    mode: "standard",
    projectId: "nomo-test",
    location: "us-central1",
  },
  auth: { kind: "api-key", apiKey: "fixture-only-key" },
} as const;

test("Vertex standard sends a project/location GenerateContent stream with the API key header", async () => {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const client = createProviderClient(standardVertex, async (input, init) => {
    calls.push({ url: new URL(String(input)), init });
    return new Response(
      'data: {"candidates":[{"content":{"parts":[{"text":"Vertex reply"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2,"totalTokenCount":5}}\n\n',
      { headers: { "content-type": "text/event-stream" } },
    );
  });

  const models = await client.models();
  assert.ok(models.some(model => model.id === "gemini-3.5-flash"));
  assert.deepEqual(calls.map(call => call.url.toString()), []);

  const reply = await client.complete(
    "gemini-3.5-flash",
    [{ role: "user", content: "Hello" }],
    [],
    new AbortController().signal,
  );

  assert.equal(reply.message.content, "Vertex reply");
  assert.equal(reply.usage?.total_tokens, 5);
  assert.deepEqual(
    calls.map(call => call.url.toString()),
    ["https://us-central1-aiplatform.googleapis.com/v1/projects/nomo-test/locations/us-central1/publishers/google/models/gemini-3.5-flash:streamGenerateContent?alt=sse"],
  );
  assert.deepEqual(
    calls.map(call => (call.init?.headers as Record<string, string>)["x-goog-api-key"]),
    ["fixture-only-key"],
  );
  assert.deepEqual(calls.map(call => call.url.searchParams.has("key")), [false]);
  assert.doesNotMatch(
    calls.map(call => String(call.init?.body)).join("\n"),
    /fixture-only-key/,
  );
});

test("Vertex rejects mismatched endpoint and unsafe project or location before requests", () => {
  let requests = 0;
  const neverRequest: typeof fetch = async () => {
    requests++;
    throw new Error("invalid Vertex configuration must not request");
  };

  assert.throws(
    () => createProviderClient(
      { ...standardVertex, baseUrl: "https://attacker.example" },
      neverRequest,
    ),
    /Vertex|endpoint|manifest/i,
  );
  assert.throws(
    () => createProviderClient({
      ...standardVertex,
      vertexOptions: { ...standardVertex.vertexOptions, projectId: "../other" },
    }, neverRequest),
    /Vertex|project|manifest/i,
  );
  assert.throws(
    () => createProviderClient({
      ...standardVertex,
      vertexOptions: { ...standardVertex.vertexOptions, location: "us-central1.attacker.example" },
    }, neverRequest),
    /Vertex|location|manifest/i,
  );
  assert.equal(requests, 0);
});

test("Google Vertex identity cannot fall through to generic Chat Completions", () => {
  let requests = 0;
  const neverRequest: typeof fetch = async () => {
    requests++;
    throw new Error("Vertex identity must not use a generic protocol");
  };

  assert.throws(
    () => createProviderClient({
      ...standardVertex,
      transport: "openai-completions",
    }, neverRequest),
    /Google Vertex requires its explicit transport/,
  );
  assert.equal(requests, 0);
});

test("the manifest enables only the pinned Vertex transport and standard setup descriptor", () => {
  const rows = PROVIDER_MODEL_MANIFEST.apiTransports.filter(
    row => row.apiId === "google-vertex",
  );
  assert.deepEqual(rows.map(row => row.source), ["omp", "prime"]);
  assert.ok(rows.every(row => row.status === "implemented"));

  const descriptor = CONFIGURABLE_PROVIDER_DESCRIPTORS.find(
    item => item.providerId === "google-vertex" && item.transport === "google-vertex",
  );
  assert.ok(descriptor);
  assert.equal(descriptor.endpoint, null);
  assert.equal(descriptor.endpointRule, "google-vertex-standard");
  assert.ok(descriptor.models.includes("gemini-3.5-flash"));
});

test("Vertex aborts an in-flight GenerateContent stream without accepting later output", async () => {
  const controller = new AbortController();
  const encoder = new TextEncoder();
  let canceled = false;
  let terminalQueued = false;
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(encoder.encode('data: {"candidates":[{"content":{"role":"model","parts":[{"text":"partial"}]}}]}\n\n'));
    },
    pull(stream) {
      if (terminalQueued) {
        stream.close();
        return;
      }
      terminalQueued = true;
      stream.enqueue(encoder.encode('data: {"candidates":[{"content":{"role":"model","parts":[{"text":"after cancel"}]},"finishReason":"STOP"}]}\n\n'));
    },
    cancel() { canceled = true; },
  });
  const client = createProviderClient(standardVertex, async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  });
  const deltas: string[] = [];

  await assert.rejects(
    client.complete("gemini-3.5-flash", [{ role: "user", content: "stop" }], [], controller.signal, delta => {
      deltas.push(delta);
      controller.abort();
    }),
    error => error instanceof Error && error.name === "AbortError",
  );
  assert.deepEqual(deltas, ["partial"]);
  assert.equal(
    requestUrl,
    "https://us-central1-aiplatform.googleapis.com/v1/projects/nomo-test/locations/us-central1/publishers/google/models/gemini-3.5-flash:streamGenerateContent?alt=sse",
  );
  assert.equal(new Headers(requestInit?.headers).get("x-goog-api-key"), "fixture-only-key");
  assert.equal((requestInit?.signal as AbortSignal).aborted, true);
  assert.equal(canceled, true);
});
