#!/usr/bin/env node
import { createServer } from "node:net";
import {
  parseTuiProtocolMessage,
  serializeTuiProtocolMessage,
  tuiSnapshotFromWorkbench,
} from "../../packages/workbench/src/tui-protocol.ts";

const sessionView = (model, runTokenCount) => ({
  id: "sess-visual",
  workspace: "ws-sess-visual",
  model,
  title: "Transport fixture",
  createdAt: "2026-01-02T03:04:01.000Z",
  updatedAt: "2026-01-02T03:04:10.000Z",
  status: "idle",
  events: [],
  runId: "run-transport",
  continuationCount: 0,
  runTokenCount,
  contextMessages: 4,
  provider: "fixture",
});

const snapshotFor = (model, runTokenCount) => {
  const session = sessionView(model, runTokenCount);
  return tuiSnapshotFromWorkbench(
    {
      allViews: () => [session],
      approvals: () => [],
    },
    {
      sessionId: session.id,
      provider: { providerId: "fixture", status: "ready", model },
    },
  );
};

const initial = snapshotFor("fixture-model", 120);
const updated = snapshotFor("transport-model", 777);

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
