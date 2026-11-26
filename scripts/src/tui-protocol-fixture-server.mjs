#!/usr/bin/env node
import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseTuiProtocolMessage,
  serializeTuiProtocolMessage,
} from "../../packages/workbench/src/tui-protocol.ts";

const root = new URL("../..", import.meta.url).pathname;
const fixture = join(root, "scripts/tui-rs-spike/fixtures/snapshot.json");
const initial = JSON.parse(readFileSync(fixture, "utf8"));
const updated = structuredClone(initial);
updated.session.model = "transport-model";
updated.session.runTokenCount = 777;
updated.usage.runTokenCount = 777;
updated.usage.totalTokens = 777;

const encode = (snapshot) => {
  const line = serializeTuiProtocolMessage({ type: "snapshot", snapshot });
  parseTuiProtocolMessage(line);
  return `${line}\n`;
};

const server = createServer((socket) => {
  socket.on("error", () => {});
  socket.write(encode(initial));
  const timer = setTimeout(() => {
    if (!socket.destroyed) socket.write(encode(updated));
  }, 350);
  socket.on("close", () => clearTimeout(timer));
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (typeof address !== "object" || address === null)
    throw new Error("fixture server has no TCP address");
  process.stdout.write(`PORT ${address.port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 100).unref();
  });
