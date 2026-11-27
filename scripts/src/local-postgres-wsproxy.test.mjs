import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import {
  encodeWebSocketFrame,
  localPostgresWsproxyTarget,
  startLocalPostgresWsproxy,
} from "./local-postgres-wsproxy.mjs";

test("the proxy admits only the disposable loopback postgres target", () => {
  assert.deepEqual(
    localPostgresWsproxyTarget("/v1?address=127.0.0.1:5432"),
    { host: "127.0.0.1", port: 5432 },
  );
  assert.deepEqual(
    localPostgresWsproxyTarget("/v2?address=127.0.0.1:5432"),
    { host: "127.0.0.1", port: 5432 },
  );
  for (const path of [
    "/v1",
    "/v3?address=127.0.0.1:5432",
    "/v1?address=127.0.0.1:5433",
    "/v1?address=production.invalid:5432",
    "/v1?address=127.0.0.1:5432&address=127.0.0.1:5432",
  ])
    assert.throws(() => localPostgresWsproxyTarget(path), /loopback|v1\/v2|exactly one/i);
});

test("server websocket frames are unmasked binary frames with exact payload lengths", () => {
  assert.deepEqual(encodeWebSocketFrame(Buffer.from("abc")), Buffer.from([0x82, 0x03, 97, 98, 99]));
  const long = encodeWebSocketFrame(Buffer.alloc(126));
  assert.equal(long[0], 0x82);
  assert.equal(long[1], 126);
  assert.equal(long.readUInt16BE(2), 126);
});

test("a websocket client reaches a loopback TCP echo service byte for byte", async (t) => {
  const echo = net.createServer((socket) => socket.pipe(socket));
  echo.listen(0, "127.0.0.1");
  await once(echo, "listening");
  const echoPort = echo.address().port;
  const proxy = await startLocalPostgresWsproxy({ port: 0, allowedPort: echoPort });
  t.after(async () => {
    await proxy.close();
    echo.close();
  });

  const socket = new WebSocket(
    `ws://127.0.0.1:${proxy.port}/v1?address=127.0.0.1:${echoPort}`,
  );
  const payload = new Uint8Array([0, 1, 2, 250, 251, 252]);
  const echoed = new Promise((resolve, reject) => {
    socket.addEventListener("message", async (event) => {
      const bytes = event.data instanceof Blob
        ? new Uint8Array(await event.data.arrayBuffer())
        : new Uint8Array(event.data);
      resolve(bytes);
    }, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.send(payload);
  assert.deepEqual([...await echoed], [...payload]);
  socket.close();
});

test("a target-side close is forwarded as a websocket close, not an abnormal transport error", async (t) => {
  const echo = net.createServer((socket) => {
    socket.once("data", () => socket.end());
  });
  echo.listen(0, "127.0.0.1");
  await once(echo, "listening");
  const echoPort = echo.address().port;
  const proxy = await startLocalPostgresWsproxy({ port: 0, allowedPort: echoPort });
  t.after(async () => {
    await proxy.close();
    echo.close();
  });
  const socket = new WebSocket(
    `ws://127.0.0.1:${proxy.port}/v1?address=127.0.0.1:${echoPort}`,
  );
  let errors = 0;
  socket.addEventListener("error", () => { errors += 1; });
  const closed = new Promise((resolve) => {
    socket.addEventListener("close", (event) => resolve(event), { once: true });
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.send(new Uint8Array([1]));
  await closed;
  assert.equal(errors, 0, "target EOF must not surface as an abnormal websocket error");
});
