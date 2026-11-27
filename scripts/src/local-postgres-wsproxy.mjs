// Minimal loopback-only WebSocket to PostgreSQL TCP proxy for isolated tests.
import { createHash } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const debug = (...args) => {
  if (process.env.NOMO_WS_PROXY_DEBUG === "1") console.error("[wsproxy]", ...args);
};

export function localPostgresWsproxyTarget(path, allowedPort = 5432) {
  const url = new URL(path, "http://127.0.0.1");
  if (url.pathname !== "/v1" && url.pathname !== "/v2")
    throw new Error("only the Neon v1/v2 websocket paths are accepted");
  const addresses = url.searchParams.getAll("address");
  if (addresses.length !== 1)
    throw new Error("exactly one target address is required");
  const expected = `127.0.0.1:${allowedPort}`;
  if (addresses[0] !== expected)
    throw new Error("only the disposable loopback PostgreSQL target is accepted");
  return { host: "127.0.0.1", port: allowedPort };
}

export function encodeWebSocketFrame(payload, opcode = 0x2) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

function createFrameParser({ onMessage, onPing, onClose, onError }) {
  let buffer = Buffer.alloc(0);
  let fragmentedOpcode = 0;
  let fragments = [];
  let fragmentedBytes = 0;
  const finishFragmented = (final) => {
    fragments.push(final);
    const message = Buffer.concat(fragments);
    fragmentedOpcode = 0;
    fragments = [];
    fragmentedBytes = 0;
    onMessage(message);
  };
  return (chunk) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    for (;;) {
      if (buffer.length < 2) return;
      const first = buffer[0];
      const second = buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (!masked) return onError(new Error("client websocket frames must be masked"));
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        const wide = buffer.readBigUInt64BE(2);
        if (wide > BigInt(MAX_MESSAGE_BYTES)) return onError(new Error("websocket frame is too large"));
        length = Number(wide);
        offset = 10;
      }
      if (length > MAX_MESSAGE_BYTES) return onError(new Error("websocket frame is too large"));
      if (buffer.length < offset + 4 + length) return;
      const mask = buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
      for (let index = 0; index < payload.length; index += 1)
        payload[index] ^= mask[index % 4];
      buffer = buffer.subarray(offset + 4 + length);

      if (opcode >= 0x8) {
        if (!fin || length > 125) return onError(new Error("invalid websocket control frame"));
        if (opcode === 0x8) onClose(payload);
        else if (opcode === 0x9) onPing(payload);
        else if (opcode !== 0xa) return onError(new Error("unsupported websocket control frame"));
        continue;
      }
      if (opcode === 0) {
        if (!fragmentedOpcode) return onError(new Error("unexpected websocket continuation"));
        fragmentedBytes += length;
        if (fragmentedBytes > MAX_MESSAGE_BYTES) return onError(new Error("websocket message is too large"));
        if (fin) finishFragmented(payload);
        else fragments.push(payload);
      } else if (opcode === 0x1 || opcode === 0x2) {
        if (fragmentedOpcode) return onError(new Error("interleaved websocket message"));
        if (fin) onMessage(payload);
        else {
          fragmentedOpcode = opcode;
          fragments = [payload];
          fragmentedBytes = length;
        }
      } else return onError(new Error("unsupported websocket frame"));
    }
  };
}

export async function startLocalPostgresWsproxy({ port = 5433, allowedPort = 5432 } = {}) {
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    response.writeHead(404, { connection: "close" });
    response.end();
  });
  server.on("upgrade", (request, socket, head) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let targetAddress;
    try {
      targetAddress = localPostgresWsproxyTarget(request.url, allowedPort);
      if (request.headers.upgrade?.toLowerCase() !== "websocket" || !request.headers["sec-websocket-key"])
        throw new Error("a websocket upgrade is required");
    } catch {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    const accept = createHash("sha1")
      .update(request.headers["sec-websocket-key"] + WS_GUID)
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    debug("upgrade", request.url);
    const target = net.createConnection(targetAddress.port, targetAddress.host);
    let closed = false;
    let waitingForWebsocketDrain = false;
    let waitingForTargetDrain = false;
    let websocketCloseQueued = false;
    const closeBoth = () => {
      if (closed) return;
      closed = true;
      target.destroy();
      if (!socket.destroyed && !websocketCloseQueued) {
        websocketCloseQueued = true;
        socket.write(encodeWebSocketFrame(Buffer.alloc(0), 0x8), () => socket.end());
        setTimeout(() => socket.destroy(), 100).unref();
      } else if (!socket.destroyed) socket.end();
    };
    const writeWebsocketFrame = (payload, opcode = 0x2) => {
      if (socket.destroyed) return;
      if (!socket.write(encodeWebSocketFrame(payload, opcode)) && !waitingForWebsocketDrain) {
        waitingForWebsocketDrain = true;
        target.pause();
        socket.once("drain", () => {
          waitingForWebsocketDrain = false;
          target.resume();
        });
      }
    };
    const parse = createFrameParser({
      onMessage: (payload) => {
        if (!target.write(payload) && !waitingForTargetDrain) {
          waitingForTargetDrain = true;
          socket.pause();
          target.once("drain", () => {
            waitingForTargetDrain = false;
            socket.resume();
          });
        }
      },
      onPing: (payload) => writeWebsocketFrame(payload, 0xa),
      onClose: () => {
        debug("close frame");
        writeWebsocketFrame(Buffer.alloc(0), 0x8);
        closeBoth();
      },
      onError: (error) => {
        debug("frame error", error.message);
        closeBoth();
      },
    });
    target.on("connect", () => debug("target connect"));
    target.on("data", (chunk) => {
      debug("target data", chunk.length);
      writeWebsocketFrame(chunk);
    });
    target.on("error", (error) => {
      debug("target error", error.message);
      closeBoth();
    });
    target.on("close", () => {
      debug("target close");
      closeBoth();
    });
    socket.on("data", (chunk) => {
      debug("websocket data", chunk.length);
      parse(chunk);
    });
    socket.on("error", (error) => {
      debug("websocket error", error.message);
      closeBoth();
    });
    socket.on("close", () => {
      debug("websocket close");
      closeBoth();
    });
    if (head.length) parse(head);
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  const actualPort = server.address().port;
  return {
    port: actualPort,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, "close").catch(() => {});
    },
  };
}
