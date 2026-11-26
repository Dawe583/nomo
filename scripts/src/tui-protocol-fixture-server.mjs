#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workbench } from "../../packages/workbench/src/index.ts";
import {
  parseTuiProtocolMessage,
  serializeTuiProtocolMessage,
  tuiSnapshotFromWorkbench,
} from "../../packages/workbench/src/tui-protocol.ts";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const runner = (host) => ({
  describe: () => ({
    id: `host-${host}`,
    displayName: `Fixture ${host}`,
    provider: "fixture",
    endpoint: "https://fixture.invalid",
    dataTransfer: "remote",
    dataSent: ["task", "system-prompt"],
    profiles: [],
    execution: "local",
    toolAccess: "unmediated",
    workspaceMode: "opaque",
    cancellation: "may-be-unknown",
  }),
  start: async () => {
    const runId = randomUUID();
    async function* events() {
      yield { type: "status", runId, sequence: 1, status: "starting" };
      await delay(300);
      yield { type: "status", runId, sequence: 2, status: "running" };
      await delay(300);
      yield { type: "assistant-message", runId, sequence: 3, text: `${host} complete` };
      await delay(300);
      yield { type: "terminal", runId, sequence: 4, status: "completed" };
    }
    return {
      id: runId,
      events: events(),
      respondToTool: async () => {
        throw new Error("Host fixture exposes no mediated tools.");
      },
    };
  },
  cancel: async () => "confirmed",
});

const root = mkdtempSync(join(tmpdir(), "nomo-wb-transport-"));
const app = new Workbench({
  NOMO_DATA_DIR: join(root, "data"),
  NOMO_LEDGER_DIR: join(root, "ledger"),
  TMPDIR: root,
});
app.registerHostRunner(runner("fixture-live"));

const cwdDigest = `sha256:${createHash("sha256").update(root).digest("hex")}`;
const startHostRun = async (host) => {
  const preview = await app.prepareHostRun({
    sourceId: `fixture:${host}`,
    host,
    task: `Produce the ${host} transport fixture.`,
    cwdDigest,
  });
  return app.startHostRun({
    consentId: preview.id,
    consentDigest: preview.consentDigest,
  });
};

const live = await startHostRun("fixture-live");

const snapshotFor = () =>
  tuiSnapshotFromWorkbench(app, {
    sessionId: live.id,
    provider: { status: "unavailable" },
  });

const encode = (snapshot) => {
  const line = serializeTuiProtocolMessage({ type: "snapshot", snapshot });
  parseTuiProtocolMessage(line);
  return `${line}\n`;
};

const server = createServer((socket) => {
  socket.on("error", () => {});
  let last = "";
  const publish = () => {
    if (socket.destroyed) return;
    const line = encode(snapshotFor());
    if (line !== last) {
      socket.write(line);
      last = line;
    }
  };
  publish();
  const timer = setInterval(publish, 100);
  socket.on("close", () => clearInterval(timer));
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (typeof address !== "object" || address === null)
    throw new Error("fixture server has no TCP address");
  process.stdout.write(`PORT ${address.port}\n`);
});

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  server.close();
  await app.shutdown().catch(() => {});
  rmSync(root, { recursive: true, force: true });
  process.exit(0);
};
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    void shutdown();
    setTimeout(() => process.exit(0), 500).unref();
  });
