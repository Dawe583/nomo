import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";

import { Workbench, WORKBENCH_VIEW_MAX_EVENT_BYTES } from "../../../packages/workbench/src/index.ts";
import { listenControlPlane, CONTROL_PLANE_SSE_DRAIN_TIMEOUT_MS } from "./server.ts";

/**
 * A provider whose reply is large enough that a session's retained events
 * exceed what a stalled socket absorbs without backpressure, which is the
 * state a subscriber that stopped reading leaves the control plane in.
 */
function bigReplyFetcher(bytes: number): typeof fetch {
  const content = "m".repeat(bytes);
  return async (url) =>
    String(url).endsWith("/models")
      ? Response.json({ data: [{ id: "fixture" }] })
      : Response.json({
          choices: [{ message: { role: "assistant", content } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
}

/**
 * Seed a persisted session with more event bytes than a socket will absorb,
 * then return the directory the control plane reloads it from.
 */
async function seedHeavySession(
  turns: number,
  replyBytes: number,
): Promise<{ readonly dir: string; readonly id: string; readonly events: number }> {
  const dir = await mkdtemp(join(tmpdir(), "nomo-api-sse-"));
  const wb = new Workbench(
    { NOMO_DATA_DIR: dir, NOMO_PERMISSION_MODE: "normal" },
    bigReplyFetcher(replyBytes),
  );
  await wb.configure({ baseUrl: "https://fixture.test/v1", apiKey: "fixture" });
  const started = await wb.start("first", "fixture");
  await wb.settled();
  for (let turn = 1; turn < turns; turn += 1) {
    wb.send(started.id, `turn ${turn}`);
    await wb.settled();
  }
  const events = wb.get(started.id)?.events.length ?? 0;
  await wb.shutdown();
  return { dir, id: started.id, events };
}

/**
 * A subscriber that reads the stream until it has data and then stops
 * reading: the client the transport bounds exist for. Once the server
 * refuses, the buffered bytes drain and the socket ends.
 */
function stallingSubscriber(port: number, path: string) {
  const socket = net.connect(port, "127.0.0.1");
  let received = 0;
  const stalled = new Promise<void>((resolve) => {
    socket.once("data", (chunk: Buffer) => {
      received += chunk.length;
      // Stop reading here; everything after this has to be absorbed by the
      // server's buffers.
      socket.pause();
      resolve();
    });
  });
  socket.on("connect", () => {
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: text/event-stream\r\n\r\n`,
    );
  });
  return { socket, stalled, bytesRead: () => received };
}

test("a session stream refuses a subscriber that stopped reading", async (t) => {
  const { dir, id, events } = await seedHeavySession(60, 30_000);
  const server = await listenControlPlane({
    env: { NOMO_DATA_DIR: dir, NOMO_PERMISSION_MODE: "normal" },
  });
  const stalling = stallingSubscriber(server.port, `/api/sessions/${id}/stream`);
  t.after(async () => {
    stalling.socket.destroy();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  assert.ok(events > 1, `the seeded session must have events to stream, had ${events}`);

  await stalling.stalled;
  assert.ok(stalling.bytesRead() > 0, "the stream must have delivered frames before stalling");

  // While the stalled stream holds the session, another subscriber is refused.
  // Once the server refuses the stalled one, the stream ends and the session
  // is released: that release is how the refusal is visible rather than silent.
  const deadline = Date.now() + CONTROL_PLANE_SSE_DRAIN_TIMEOUT_MS + 15_000;
  let released = false;
  while (Date.now() < deadline && !released) {
    await delay(250);
    const probe = await fetch(`http://127.0.0.1:${server.port}/api/sessions/${id}/stream`, {
      headers: { accept: "text/event-stream" },
    });
    released = probe.status !== 409;
    if (released) await probe.body?.cancel();
  }
  assert.ok(
    released,
    "a subscriber that stopped reading was buffered for the life of the connection",
  );

  // The heartbeat went with it: a fresh subscriber sees one heartbeat per
  // tick, not two, so the refused stream's interval is gone rather than left
  // rescanning the session forever.
  const fresh = await fetch(`http://127.0.0.1:${server.port}/api/sessions/${id}/stream`, {
    headers: { accept: "text/event-stream" },
  });
  assert.equal(fresh.status, 200);
  const body = fresh.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  // Bounded by a timer, not by the loop clock: a read that blocks past the
  // window must not stretch the count it is asserting on.
  await Promise.race([
    (async () => {
      for (;;) {
        const { value, done } = await body.read();
        if (done) return;
        text += decoder.decode(value, { stream: true });
      }
    })(),
    delay(3_500),
  ]);
  await body.cancel().catch(() => undefined);
  const heartbeats = text.split(": heartbeat").length - 1;
  assert.ok(
    heartbeats >= 1 && heartbeats <= 4,
    `expected one heartbeat per tick from a single live stream, saw ${heartbeats}`,
  );
});

test("a second concurrent subscriber to one session is refused with 409", async (t) => {
  const { dir, id } = await seedHeavySession(1, 16);
  const server = await listenControlPlane({
    env: { NOMO_DATA_DIR: dir, NOMO_PERMISSION_MODE: "normal" },
  });
  const first = await fetch(`http://127.0.0.1:${server.port}/api/sessions/${id}/stream`, {
    headers: { accept: "text/event-stream" },
  });
  t.after(async () => {
    await first.body?.cancel().catch(() => undefined);
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  assert.equal(first.status, 200);

  const second = await fetch(`http://127.0.0.1:${server.port}/api/sessions/${id}/stream`, {
    headers: { accept: "text/event-stream" },
  });
  assert.equal(second.status, 409, "a second concurrent subscriber must be refused");
  const body = await second.json() as { readonly error: string };
  assert.equal(body.error, "session_stream_in_use");
});

test("a session view drops its oldest events at a named byte ceiling", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nomo-api-view-ceiling-"));
  const wb = new Workbench(
    { NOMO_DATA_DIR: dir, NOMO_PERMISSION_MODE: "normal" },
    bigReplyFetcher(30_000),
  );
  t.after(async () => {
    wb.close();
    await rm(dir, { recursive: true, force: true });
  });
  await wb.configure({ baseUrl: "https://fixture.test/v1", apiKey: "fixture" });
  const started = await wb.start("first", "fixture");
  await wb.settled();
  const firstSeq = wb.get(started.id)?.events[0]?.seq;
  for (let turn = 1; turn < 90; turn += 1) {
    wb.send(started.id, `turn ${turn}`);
    await wb.settled();
  }
  const events = wb.get(started.id)?.events ?? [];
  const bytes = events.reduce(
    (sum, event) => sum + Buffer.byteLength(JSON.stringify(event)),
    0,
  );
  assert.ok(
    bytes <= WORKBENCH_VIEW_MAX_EVENT_BYTES,
    `the view retained ${bytes} bytes of events, ceiling is ${WORKBENCH_VIEW_MAX_EVENT_BYTES}`,
  );
  assert.ok(
    events.length > 0,
    "the ceiling must drop the oldest events, not the session's history entirely",
  );
  assert.ok(
    events[0]!.seq > (firstSeq ?? 1),
    "the oldest events are the ones dropped",
  );
});