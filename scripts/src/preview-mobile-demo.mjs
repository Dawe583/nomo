// Disposable browser QA for the public demo; no real credentials or provider calls.
import express from "express";
import { resolve } from "node:path";
import { demoRouter } from "../../cloud/demo.mjs";
Object.assign(process.env, {
  VOID_PUBLIC_DEMO: "1",
  VOID_DEMO_NVIDIA_KEY: "qa-fixture",
  VOID_SECRET_KEY: "mobile-qa-only-".repeat(4),
  VOID_LOCAL_TEST: "1",
});
const values = new Map();
let tail = Promise.resolve();
const app = express();
app.use(express.json());
let rejected = false;
app.post("/api/demo/message", (req, res, next) => {
  if (req.body.prompt === "FAIL_ONCE" && !rejected) {
    rejected = true;
    return res
      .status(503)
      .json({
        message:
          "QA fixture: message rejected before acceptance. Retry the preserved draft.",
      });
  }
  next();
});
app.use(
  "/api/demo",
  demoRouter({
    read: async (key) => values.get(key),
    write: async (key, value) => {
      values.set(key, structuredClone(value));
    },
    transaction: async (_key, run) => {
      const next = tail.then(() => run({}));
      tail = next.catch(() => {});
      return next;
    },
    encrypt: JSON.stringify,
    decrypt: JSON.parse,
    provider: () => ({
      redact: (value) => value,
      complete: async () => ({
        message: {
          role: "assistant",
          content:
            "QA fixture: demo message accepted.\n\n| State | Result |\n| --- | --- |\n| Reply | Complete |\n\n```text\n[ok] mobile demo\n```",
        },
      }),
    }),
  }),
);
app.use("/api", (_req, res) =>
  res
    .status(401)
    .json({ message: "Private workspace is outside this QA fixture." }),
);
app.use(express.static(resolve("dist/web")));
app.get("/demo", (_req, res) => res.sendFile(resolve("dist/web/index.html")));
const server = app.listen(8084, "127.0.0.1", () =>
  console.log(
    "Disposable public-demo QA: http://127.0.0.1:8084/demo; FAIL_ONCE tests draft recovery.",
  ),
);
function close() {
  server.closeAllConnections();
  server.close();
}
process.once("SIGINT", close);
process.once("SIGTERM", close);
