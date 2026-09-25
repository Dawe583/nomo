/**
 * A real VOID proxy HTTP endpoint, spawned for the Python integration test.
 *
 * The server is the repository's own `createHttpRequestRelay` from
 * `packages/proxy/src/relay/http-requests.ts` -- the server side of the wire
 * `packages/proxy/src/transport/http.ts` speaks -- wired to a real stdio
 * upstream process through `spawnUpstream` from
 * `packages/proxy/src/transport/stdio.ts`. Nothing about the protocol is
 * reimplemented here: this file only binds two repo modules to a port and
 * reports that port on stdout.
 *
 * Usage: node void_proxy_http.mjs <upstream-command-json> <listen-port>
 * Prints one line: {"port":<n>} then stays up until stdin closes or it is
 * signalled.
 */
import { createServer } from "node:http";
import { spawnUpstream } from "../../../../packages/proxy/src/transport/stdio.ts";
import { createHttpRequestRelay } from "../../../../packages/proxy/src/relay/http-requests.ts";

const [commandJson, portText] = process.argv.slice(2);
if (commandJson === undefined || portText === undefined) {
  throw new Error("usage: node void_proxy_http.mjs <command-json> <port>");
}
const command = JSON.parse(commandJson);
if (!Array.isArray(command) || command.length === 0 || typeof command[0] !== "string") {
  throw new Error("upstream command must be a non-empty string array");
}
const port = Number(portText);
if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
  throw new Error("listen port must be a valid TCP port");
}

let relay;
const upstream = spawnUpstream(command, process.env, {
  events: {
    onMessage(line) {
      relay.receiveUpstreamLine(line);
    },
    onClose(code, signal) {
      relay.close();
      process.stdout.write(JSON.stringify({ upstreamClosed: { code, signal } }) + "\n");
      process.exit(0);
    },
    onError(error) {
      process.stderr.write(`upstream error: ${error.message}\n`);
    },
  },
  stderr: process.stderr,
});
relay = createHttpRequestRelay({ upstream, maxPendingRequests: 16, requestTimeoutMs: 60_000 });

const server = createServer((request, response) => {
  void relay.handle(request, response);
});
server.on("clientError", (_error, socket) => {
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\n\r\n");
});

await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
const address = server.address();
if (address === null || typeof address === "string") {
  throw new Error("server did not bind a TCP port");
}
process.stdout.write(JSON.stringify({ port: address.port }) + "\n");

// The parent closes stdin to shut the endpoint down: a held call and the
// upstream child both need the process to end deterministically.
process.stdin.on("end", () => {
  relay.close();
  upstream.close();
  server.closeAllConnections();
  server.close(() => process.exit(0));
});
process.stdin.resume();
