#!/usr/bin/env node
/**
 * Opt-in real-provider smoke.
 *
 * The fixture provider proves the streaming and tool paths without a network.
 * It cannot prove that a real endpoint speaks the same protocol, so this script
 * makes exactly one minimal request and prints only facts that cannot leak the
 * credential or the prompt: HTTP status, latency, and token counts.
 *
 * It is opt-in by construction: with no credential in the environment it prints
 * SKIP and exits 0, so a gate can call it without a key and without a false
 * green.
 *
 *   NOMO_SMOKE_API_KEY   the key (never printed, never logged)
 *   NOMO_SMOKE_BASE_URL  OpenAI-compatible base, default OpenCode Zen
 *   NOMO_SMOKE_MODEL     default "muse-spark-1.3-contributor-free"
 *
 * Exit codes: 0 = answered or skipped, 1 = the provider answered with a
 * non-2xx status or the request failed.
 */
const baseUrl = (process.env.NOMO_SMOKE_BASE_URL || "https://opencode.ai/zen/v1").replace(/\/+$/, "");
const model = process.env.NOMO_SMOKE_MODEL || "muse-spark-1.3-contributor-free";
const apiKey = process.env.NOMO_SMOKE_API_KEY || "";

if (!apiKey) {
  console.log("SKIP provider-smoke: NOMO_SMOKE_API_KEY is not set, so nothing was sent.");
  process.exit(0);
}

const startedAt = Date.now();
let response;
try {
  response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      // One short turn: enough to prove the protocol, small enough that a
      // smoke costs a fraction of a cent.
      messages: [{ role: "user", content: "Reply with the single word: ready" }],
      // A reasoning model spends tokens before it writes an answer, so a
      // 16-token ceiling returns an empty message with finish_reason=length.
      max_tokens: 256,
      stream: false,
    }),
    signal: AbortSignal.timeout(30_000),
  });
} catch (error) {
  console.error(
    `FAIL provider-smoke: request failed after ${Date.now() - startedAt} ms (${error instanceof Error ? error.name : "unknown"}).`,
  );
  process.exit(1);
}

const latency = Date.now() - startedAt;
if (!response.ok) {
  // The status and the provider's own error code are safe; the body is not
  // printed because it can echo the request.
  let code = "";
  try {
    const body = await response.json();
    code = typeof body?.error?.code === "string" ? ` code=${body.error.code}` : "";
  } catch {
    code = "";
  }
  console.error(`FAIL provider-smoke: status ${response.status} after ${latency} ms${code}.`);
  process.exit(1);
}

let body;
try {
  body = await response.json();
} catch {
  console.error(`FAIL provider-smoke: status 200 but the body was not JSON (${latency} ms).`);
  process.exit(1);
}

const choice = Array.isArray(body?.choices) ? body.choices[0] : undefined;
const text = typeof choice?.message?.content === "string" ? choice.message.content.trim() : "";
if (!text) {
  const reason = typeof choice?.finish_reason === "string" ? choice.finish_reason : "unknown";
  console.error(
    `FAIL provider-smoke: status 200 but no assistant text (${latency} ms, finish_reason=${reason}).`,
  );
  process.exit(1);
}

const usage = body?.usage ?? {};
const reported = ["prompt_tokens", "completion_tokens", "total_tokens"].filter(
  (key) => typeof usage[key] === "number",
);
console.log(
  `PASS provider-smoke: ${model} answered in ${latency} ms; ` +
    `reply ${text.length} chars; usage ${reported.length ? reported.map((key) => `${key}=${usage[key]}`).join(" ") : "not reported"}.`,
);
