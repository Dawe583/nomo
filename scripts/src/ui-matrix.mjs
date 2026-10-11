// Real browser measurement for the VOID web workbench (D04.01, D04.04 - D04.08).
//
//   node scripts/src/build-web.mjs
//   node scripts/src/ui-matrix.mjs            # markdown report on stdout
//   node scripts/src/ui-matrix.mjs --json out.json
//
// Starts its own disposable control plane plus a local model fixture on
// 127.0.0.1, drives a real headless Chromium over the DevTools Protocol and
// prints measured pixels. No external service and no new dependency.
import { createServer } from "node:http";
import express from "express";
import { resolve } from "node:path";
import { demoRouter } from "../../cloud/demo.mjs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createControlPlaneServer } from "../../apps/control-plane/api/server.ts";
import { recoveryStateLabel } from "../../apps/control-plane/ui/src/recovery-review.ts";
import { launchBrowser, openPage } from "./cdp.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

export const DESKTOP_VIEWPORTS = ["1024x768", "1280x800", "1440x900"];
export const PHONE_VIEWPORTS = ["320x568", "390x844", "430x932"];
export const SHORT_LANDSCAPE = ["667x375"];

// D04.06 lists these web widths plus a short landscape phone.
const VIEWPORTS = [
  { name: "320x568", width: 320, height: 568, kind: "phone" },
  { name: "390x844", width: 390, height: 844, kind: "phone" },
  { name: "430x932", width: 430, height: 932, kind: "phone" },
  { name: "768x1024", width: 768, height: 1024, kind: "tablet" },
  { name: "834x1112", width: 834, height: 1112, kind: "tablet" },
  { name: "1024x768", width: 1024, height: 768, kind: "landscape" },
  { name: "1280x800", width: 1280, height: 800, kind: "desktop" },
  { name: "1440x900", width: 1440, height: 900, kind: "desktop" },
  { name: "667x375", width: 667, height: 375, kind: "short-landscape" },
];

const REQUIRED_ROUTES = [
  "chat", "overview", "conversations", "runs", "documents",
  "approvals", "ledger", "connections", "models", "settings", "demo",
];

// D02.07 internal gallery. It is a served SPA path, added to the allowlist in
// apps/control-plane/api/server.ts and to the rewrites in vercel.json. It is
// deliberately absent from the application `routes` table, so it is never in
// the sidebar and never in the command palette.
export const GALLERY_PATH = "/gallery";

// The gallery replaces the shell, so these are the selectors that prove it is
// reachable and that it is not part of the user navigation.
const GALLERY_ROOT = '.gallery[data-gallery="components"]';
const GALLERY_SECTION = ".gallery-section";

// A synthetic credential shaped so redact.ts matches it by value as well as by
// key name. The gallery must never render it.
const GALLERY_SECRET = "sk-live-0000111122223333";

// A long, realistic assistant answer so the transcript is never an empty hero.
const LONG_REPLY = [
  "## Migration plan",
  "",
  "The existing workspace keeps its documents, ledger and approval history. This plan only",
  "adds the review surface and leaves every written file reversible.",
  "",
  "| Stage | Owner | Evidence |",
  "| --- | --- | --- |",
  "| Inventory | operator | document list export |",
  "| Review | reviewer | approval diff |",
  "| Apply | workspace tool | ledger entry with inverse |",
  "",
  "```ts",
  "const reviewed = await listDocuments({ scope: \"retained-history\" });",
  "for (const document of reviewed.documents) console.log(document.path);",
  "```",
  "",
  "### Open questions",
  "",
  "1. Should the ledger keep the inverse operation or only the applied write?",
  "2. How long does an approval hold before it expires?",
  "3. Which surfaces need the same density at 320 pixels?",
  "",
  "The answer stays long enough to force the transcript into real scrolling,",
  "which is exactly the condition the height contract is written for.",
].join("\n");

// The four states this harness has to drive are properties of a real provider
// conversation, not of a page. A fixture that can only answer instantly and
// unconditionally cannot produce any of them, so the behaviour is switched
// explicitly by the measurement that needs it and reset in a `finally`, and
// the chunk count of the last streamed answer is kept so the report can be
// checked against what the endpoint really sent.
const providerBehaviour = { mode: "tool-flow", retryAfter: 5, lastChunks: 0 };

// The streamed answer is a list of sentences so the pieces the provider sends
// are exactly these strings, and the answer they reassemble into is
// `STREAMED_ANSWER`. No tool call, so every character on screen came from the
// stream rather than from a second turn.
const STREAMED_SENTENCES = [
  "Streaming is not a complete response rendered late.",
  "Each sentence below reaches the transcript while the run is still open,",
  "so a reader watches the answer arrive instead of inferring that it did.",
  "The provider sends these in order and never resends one of them.",
  "A dropped piece would leave a gap the finished text cannot hide,",
  "because the finished text is the same string the provider streamed.",
  "Nothing is written into the page after the fact.",
  "The browser reads a real event stream and renders what the server sent.",
];
const STREAMED_ANSWER = STREAMED_SENTENCES.join(" ");

// The revision the operator saves before recovering the earlier write. A
// recovery has to refuse to undo a document it no longer matches, so this is
// the content that must survive the failed recovery untouched.
const NEWER_REVISION = "# Project plan\n\n1. Define the scope.\n2. Build the smallest useful version.\n3. Record what the recovery refused to undo.\n";

/** Send STREAMED_ANSWER as an event stream, one frame per sentence.
 *
 * A non-streaming request still gets the same words: the run has to be able to
 * reach a completed state either way, and what is under measurement is the
 * framing, not the text. A closed socket is a cancelled run, not a crash. */
async function streamAnswer(response, streamed) {
  if (!streamed) {
    response.setHeader("content-type", "application/json");
    providerBehaviour.lastChunks = 0;
    return response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: STREAMED_ANSWER } }] }));
  }
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
  const write = (payload) => {
    if (response.writableEnded || response.destroyed) return false;
    response.write("data: " + JSON.stringify(payload) + "\n\n");
    return true;
  };
  providerBehaviour.lastChunks = STREAMED_SENTENCES.length;
  for (const [index, sentence] of STREAMED_SENTENCES.entries()) {
    await new Promise((r) => setTimeout(r, 600));
    if (!write({ choices: [{ index: 0, delta: { content: index === 0 ? sentence : " " + sentence } }] })) return;
  }
  if (!write({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { total_tokens: Math.ceil(STREAMED_ANSWER.length / 4) } })) return;
  response.write("data: [DONE]\n\n");
  response.end();
}

async function startFixture() {
  const model = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/models")
      return response.end(JSON.stringify({ data: [{ id: "qa-fixture", name: "QA fixture" }] }));
    let raw = "";
    for await (const part of request) raw += part;
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      response.statusCode = 400;
      return response.end("{}");
    }
    if (providerBehaviour.mode === "rate-limit") {
      response.statusCode = 429;
      response.setHeader("retry-after", String(providerBehaviour.retryAfter));
      return response.end(JSON.stringify({ error: { type: "rate_limit_exceeded", message: "Too many requests for this key." } }));
    }
    if (providerBehaviour.mode === "stream") return streamAnswer(response, input.stream === true);
    const messages = Array.isArray(input.messages) ? input.messages : [];
    const last = messages.at(-1) ?? { role: "user" };
    const write = (Array.isArray(input.tools) ? input.tools : []).find((tool) =>
      (tool.function?.description ?? "").startsWith("void_workspace_write:"),
    );
    // A slow reply keeps a real "running" state observable for Stop and cancel.
    if (process.env.VOID_QA_SLOW) await new Promise((r) => setTimeout(r, 8000));
    const message = last.role === "tool"
      ? { role: "assistant", content: LONG_REPLY }
      : write
        ? {
            role: "assistant",
            content: "QA fixture: writing the plan through the real VOID document tool.",
            tool_calls: [{
              id: "qa-" + Date.now(),
              type: "function",
              function: {
                name: write.function.name,
                arguments: JSON.stringify({
                  path: "plan.md",
                  content: "# Project plan\n\n1. Define the scope.\n2. Build the smallest useful version.\n",
                }),
              },
            }],
          }
        : { role: "assistant", content: LONG_REPLY };
    providerBehaviour.lastChunks = 0;
    response.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  return { model, port: model.address().port };
}

export async function startDemoServer() {
  // demoRouter reads its capability flags per request, so the demo environment
  // has to stay in place for the whole measurement run.
  const previous = { ...process.env };
  Object.assign(process.env, {
    VOID_PUBLIC_DEMO: "1",
    VOID_DEMO_NVIDIA_KEY: "qa-fixture",
    VOID_SECRET_KEY: "ui-matrix-only-".repeat(4),
    VOID_LOCAL_TEST: "1",
  });
  const values = new Map();
  const app = express();
  const webRoot = resolve(ROOT, "dist/web");
  app.use(express.json());
  app.use(
    "/api/demo",
    demoRouter({
      read: async (key) => values.get(key),
      write: async (key, value) => {
        values.set(key, structuredClone(value));
      },
      transaction: async (_key, run) => run({}),
      encrypt: JSON.stringify,
      decrypt: JSON.parse,
      provider: () => ({
        redact: (value) => value,
        complete: async () => ({
          message: { role: "assistant", content: LONG_REPLY },
        }),
      }),
    }),
  );
  app.use(express.static(webRoot));
  // A relative path keeps Express from treating the worktree parent as a dotfile.
  app.get("/demo", (_req, res) => res.sendFile("index.html", { root: webRoot }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  return {
    origin: "http://127.0.0.1:" + server.address().port,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => {
          process.env = previous;
          r();
        });
      }),
  };
}

async function startWorkspace(fixturePort) {
  const directory = await mkdtemp(join(tmpdir(), "void-ui-matrix-"));
  const app = createControlPlaneServer({
    env: {
      VOID_DATA_DIR: directory,
      VOID_LEDGER_DIR: join(directory, "ledger"),
      VOID_PERMISSION_MODE: "normal",
    },
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  const port = app.address().port;
  const origin = "http://127.0.0.1:" + port;
  const configured = await fetch(origin + "/api/provider", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      baseUrl: "http://127.0.0.1:" + fixturePort + "/v1",
      apiKey: "qa-fixture-key",
      kind: "compatible",
    }),
  });
  if (!configured.ok) throw new Error("Fixture provider rejected: " + configured.status);
  return {
    origin,
    close: async () => {
      app.closeAllConnections();
      await new Promise((resolve) => app.close(resolve));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------- page probes

const PROBE = `() => {
  const el = document.documentElement;
  const round = (n) => Math.round(n * 100) / 100;
  const box = (node) => {
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return { top: round(r.top), right: round(r.right), bottom: round(r.bottom), left: round(r.left), width: round(r.width), height: round(r.height) };
  };
  const name = (node) => node
    ? node.tagName.toLowerCase() + (typeof node.className === "string" && node.className ? "." + node.className.trim().split(/\\s+/).join(".") : "") +
      (node.getAttribute("aria-label") ? "[" + node.getAttribute("aria-label") + "]" : "")
    : null;
  const sendButton = document.querySelector(".composer .send");
  const stopButton = [...document.querySelectorAll(".composer-actions button")]
    .find((b) => /Zastavit|Stop the run/.test(b.getAttribute("aria-label") || ""));
  const transcript = document.querySelector(".transcript") || document.querySelector(".demo-transcript");
  const work = document.querySelector(".chat-container") || document.querySelector(".chat-shell");
  const hitTest = (node) => {
    if (!node) return null;
    const r = node.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return "outside-viewport";
    const top = document.elementFromPoint(x, y);
    return top && (node === top || node.contains(top) || top.contains(node)) ? "reachable" : "covered:" + name(top);
  };
  const offenders = [];
  for (const node of document.querySelectorAll("body *")) {
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const r = node.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.right > el.clientWidth + 1 || r.left < -1)
      offenders.push({ node: name(node), left: round(r.left), right: round(r.right), width: round(r.width) });
  }
  const tiny = [];
  for (const node of document.querySelectorAll("button, a[href], input, select, textarea, summary, [role=button]")) {
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || node.disabled) continue;
    const r = node.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    // Half a pixel of tolerance: a declared 44px target can land on 43.9996px
    // through fractional layout, which is rounding rather than a smaller target.
    if (r.width < 43.5 || r.height < 43.5)
      tiny.push({
        node: name(node),
        width: Math.round(r.width * 1000) / 1000,
        height: Math.round(r.height * 1000) / 1000,
        text: (node.innerText || "").trim().slice(0, 24),
      });
  }
  return {
    path: location.pathname,
    lang: el.lang,
    theme: el.dataset.theme,
    motion: el.dataset.motion,
    clientWidth: el.clientWidth,
    scrollWidth: el.scrollWidth,
    innerWidth: innerWidth,
    innerHeight: innerHeight,
    errorBoundary: !!document.querySelector(".app-recovery"),
    recovery: document.querySelector(".app-recovery")?.innerText?.trim().slice(0, 80) ?? null,
    navLabels: [...document.querySelectorAll(".sidebar nav a, .mobile-nav a")].map((a) => a.getAttribute("href")),
    heading: document.querySelector("h1, .page-title, .welcome h1")?.innerText?.trim().slice(0, 90) ?? null,
    contentChars: (document.querySelector("main")?.innerText ?? document.body.innerText).trim().length,
    transcript: box(transcript),
    transcriptOverflow: transcript ? transcript.scrollHeight - transcript.clientHeight : null,
    work: box(work),
    composer: box(document.querySelector(".composer")),
    textarea: box(document.querySelector(".composer textarea")),
    send: box(sendButton),
    sendNode: name(sendButton),
    sendDisabled: sendButton ? sendButton.disabled : null,
    sendHit: hitTest(sendButton),
    stop: box(stopButton),
    stopHit: hitTest(stopButton),
    notices: box(document.querySelector(".composer-notices")),
    attachLabel: box(document.querySelector(".attach-button")),
    noticesText: (document.querySelector(".composer-notices")?.innerText ?? "").trim().slice(0, 200),
    attachments: box(document.querySelector(".attachments")),
    selectedTool: box(document.querySelector(".selected-tool")),
    offenders: offenders.slice(0, 10),
    offenderCount: offenders.length,
    tinyTargets: tiny.slice(0, 24),
    tinyTargetCount: tiny.length,
    activeElement: name(document.activeElement),
  };
}`;

const DEMO_PROBE = `() => {
  const el = document.documentElement;
  const round = (n) => Math.round(n * 100) / 100;
  const box = (node) => {
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return { top: round(r.top), right: round(r.right), bottom: round(r.bottom), left: round(r.left), width: round(r.width), height: round(r.height) };
  };
  const transcript = document.querySelector(".demo-transcript");
  const area = document.querySelector(".demo-composer textarea");
  const send = [...document.querySelectorAll(".demo-composer button")].pop();
  const hitTest = (node) => {
    if (!node) return null;
    const r = node.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return "outside-viewport";
    const top = document.elementFromPoint(x, y);
    return top && (node === top || node.contains(top) || top.contains(node)) ? "reachable" : "covered";
  };
  return {
    theme: el.dataset.theme,
    lang: el.lang,
    clientWidth: el.clientWidth,
    scrollWidth: el.scrollWidth,
    errorBoundary: !!document.querySelector(".app-recovery"),
    heading: document.querySelector(".demo-welcome h1, h1")?.innerText?.trim().slice(0, 80) ?? null,
    contentChars: document.body.innerText.trim().length,
    transcript: box(transcript),
    textarea: box(area),
    send: box(send),
    sendHit: hitTest(send),
  };
}`;
const DEMO_PROBE_CALLED = "(" + DEMO_PROBE + ")()";

const PROBE_CALLED = "(" + PROBE + ")()";

const setDraft = (text) => `(() => {
  const area = document.querySelector(".composer textarea");
  if (!area) return null;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(area, ${JSON.stringify(text)});
  area.dispatchEvent(new Event("input", { bubbles: true }));
  return area.value;
})()`;

const readDraft = `(() => document.querySelector(".composer textarea")?.value ?? null)()`;

// --------------------------------------------------------------- tab walk

const FOCUS_STYLE = `() => {
  const node = document.activeElement;
  if (!node || node === document.body) return { element: "body" };
  const style = getComputedStyle(node);
  const r = node.getBoundingClientRect();
  const parent = node.parentElement;
  const parentStyle = parent ? getComputedStyle(parent) : null;
  return {
    element: node.tagName.toLowerCase() +
      (typeof node.className === "string" && node.className ? "." + node.className.trim().split(/\\s+/).join(".") : "") +
      (node.getAttribute("aria-label") ? "[" + node.getAttribute("aria-label") + "]" : ""),
    text: (node.innerText || node.value || "").trim().slice(0, 26),
    outlineStyle: style.outlineStyle,
    outlineWidth: style.outlineWidth,
    outlineColor: style.outlineColor,
    boxShadow: style.boxShadow === "none" ? "none" : style.boxShadow.slice(0, 60),
    borderColor: style.borderColor,
    focusVisible: node.matches(":focus-visible"),
    tag: node.tagName.toLowerCase(),
    parentBoxShadow: parentStyle ? (parentStyle.boxShadow === "none" ? "none" : parentStyle.boxShadow.slice(0, 60)) : null,
    parentBorderColor: parentStyle ? parentStyle.borderColor : null,
    rect: { width: Math.round(r.width), height: Math.round(r.height) },
  };
}`;

// ------------------------------------------------------------------ helpers

// The workspace routes and the public demo are lazy chunks, so a load event is
// not proof of a rendered surface.
async function waitForApp(page, selector, extra) {
  const condition = selector
    ? `!!document.querySelector(${JSON.stringify(selector)})`
    : `!document.querySelector(".app-loading") && !!document.querySelector("#root")?.firstElementChild`;
  const settled = extra ? ` && ${extra}` : "";
  for (let i = 0; i < 150; i++) {
    if (await page.evaluate(`(() => ${condition}${settled})()`)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  const state = await page.evaluate(
    `(() => ({
      url: location.href,
      root: document.getElementById("root")?.innerHTML.slice(0, 400) ?? null,
      loading: !!document.querySelector(".app-loading"),
      text: document.body.innerText.trim().slice(0, 200),
    }))()`,
  );
  throw new Error(
    "The surface never rendered" + (selector ? ": " + selector : "") + " " + JSON.stringify(state) + " console=" + JSON.stringify(page.consoleMessages.slice(0, 4)) + " errors=" + JSON.stringify(page.errors.slice(0, 4)),
  );
}

async function tabWalk(page, steps, delay = 40) {
  await page.evaluate(`(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); return true; })()`);
  const seen = [];
  let blanks = 0;
  for (let i = 0; i < steps; i++) {
    await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
    await new Promise((r) => setTimeout(r, delay));
    const state = await page.evaluate(FOCUS_CALLED);
    if (!state || !state.element || state.element === "body") {
      // A frame can land before the browser applied focus; only stop when the
      // document really keeps the focus nowhere.
      if (++blanks >= 2 && seen.length > 0) break;
      continue;
    }
    blanks = 0;
    if (seen.length > 2 && state.element === seen[0].element && state.text === seen[0].text) break;
    seen.push(state);
  }
  return seen;
}

const FOCUS_CALLED = "(" + FOCUS_STYLE + ")()";

function ringVisible(state) {
  if (state.outlineStyle && state.outlineStyle !== "none" && parseFloat(state.outlineWidth) >= 1) return "outline";
  if (state.boxShadow && state.boxShadow !== "none") return "box-shadow";
  if (state.parentBoxShadow && state.parentBoxShadow !== "none") return "parent-box-shadow";
  return null;
}

/** Wait until the transcript geometry stops moving, and say whether it did.
 *
 * The old gate read the layout once, immediately after `waitForApp` returned.
 * `waitForApp` proves a node exists, not that the boxes around it have reached
 * their final size: the composer's textarea autosizes in an effect, the
 * notices region is `display: none` until a query fills it and its contents
 * change the composer's height, and the transcript is a `flex: 1` sibling of
 * that composer, so a composer still growing means a transcript still
 * shrinking. Under CPU contention the single read landed mid-settle and the
 * share came out lower than the layout's real resting value.
 *
 * So the harness now waits for the geometry to repeat itself instead of
 * assuming it has. Two consecutive identical readings of the transcript and
 * work-area boxes are the evidence that the layout has settled; anything else
 * is reported as unsettled with the reason, and the caller records that as
 * outstanding rather than asserting on a mid-animation number.
 *
 * `fonts.ready` is awaited because the interface and display faces load with
 * `font-display: swap`: before the swap lands, text measures in the fallback
 * face and the transcript is a different height. */
const LAYOUT_SAMPLE = `() => {
  const round = (n) => Math.round(n * 100) / 100;
  const box = (node) => (node ? round(node.getBoundingClientRect().height) : null);
  const transcript = document.querySelector(".transcript");
  const work = document.querySelector(".chat-container") || document.querySelector(".chat-shell");
  return {
    transcriptHeight: box(transcript),
    workAreaHeight: box(work),
    fontsLoaded: document.fonts.status === "loaded",
  };
}`;

const LAYOUT_SAMPLE_CALLED = "(" + LAYOUT_SAMPLE + ")()";

const sameLayout = (a, b) =>
  a.transcriptHeight === b.transcriptHeight && a.workAreaHeight === b.workAreaHeight;

/** The settling evidence for one viewport.
 *
 * `settled` is a measurement, not an inference: it is true only when two
 * readings taken a full frame apart agreed to the hundredth of a pixel. When
 * they did not, `reason` names what was still moving so the gap is visible
 * rather than folded into a bogus assertion. */
async function awaitSettledLayout(page, tries = 40, gapMs = 60) {
  const fontsReady = await page
    .evaluate("document.fonts.ready.then(() => true).catch(() => false)")
    .catch(() => false);
  let previous = null;
  let last = null;
  let readings = 0;
  for (let i = 0; i < tries; i++) {
    // Two animation frames, not one: a single frame can be scheduled before
    // the style and layout that frame is meant to flush have been applied.
    await page.evaluate(
      "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 0))))",
    );
    const sample = await page.evaluate(LAYOUT_SAMPLE_CALLED);
    readings++;
    last = sample;
    if (previous && sameLayout(previous, sample))
      return {
        settled: true,
        reason: null,
        readings,
        fontsReady,
        transcriptHeight: sample.transcriptHeight,
        workAreaHeight: sample.workAreaHeight,
      };
    previous = sample;
    await new Promise((r) => setTimeout(r, gapMs));
  }
  const reason =
    !last || last.transcriptHeight === null || last.workAreaHeight === null
      ? "the transcript or the work area had no box to measure"
      : `the layout never held still: ${readings} readings, last ${last.transcriptHeight}px of ${last.workAreaHeight}px`;
  return {
    settled: false,
    reason,
    readings,
    fontsReady,
    transcriptHeight: last?.transcriptHeight ?? null,
    workAreaHeight: last?.workAreaHeight ?? null,
  };
}

async function measureViewport(page, origin, sessionPath) {
  const rows = [];
  for (const viewport of VIEWPORTS) {
    await page.setViewport(viewport.width, viewport.height);
    await page.goto(origin + sessionPath);
    await waitForApp(page, ".composer .send");
    // Settle before measuring. The probe below and the share recorded from it
    // both read one layout; taking that layout before it stopped moving is how
    // a mid-animation height came to be asserted as a resting one.
    const settle = await awaitSettledLayout(page);
    const result = await page.evaluate(PROBE_CALLED);
    const transcriptHeight = result.transcript ? result.transcript.height : null;
    const workHeight = result.work ? result.work.height : null;
    rows.push({
      viewport: viewport.name,
      kind: viewport.kind,
      clientWidth: result.clientWidth,
      scrollWidth: result.scrollWidth,
      horizontalOverflow: result.scrollWidth - result.clientWidth,
      transcriptHeight,
      workAreaHeight: workHeight,
      // The share is derived here, once, from the two pixels measured on the
      // same read. A gate that recomputed it from the same two numbers and
      // compared the two results was comparing one number with itself, so the
      // recorded claim and the evidence behind it cannot drift apart.
      transcriptShare: transcriptHeight !== null && workHeight ? Math.round((transcriptHeight / workHeight) * 1000) / 10 + "%" : null,
      settle,
      sendTop: result.send ? result.send.top : null,
      sendBottom: result.send ? result.send.bottom : null,
      sendHeight: result.send ? result.send.height : null,
      sendHit: result.sendHit,
      stopPresent: !!result.stop,
      stopHit: result.stopHit,
      inViewport: result.send ? result.send.top >= -1 && result.send.bottom <= result.innerHeight + 1 : null,
      offenders: result.offenders,
      offenderCount: result.offenderCount,
      tinyTargets: result.tinyTargets,
      tinyTargetCount: result.tinyTargetCount,
      notices: result.notices,
      raw: result,
    });
  }
  return rows;
}

async function measureThemesAndLocales(page, origin, sessionPath) {
  const rows = [];
  for (const theme of ["light", "dark"]) {
    for (const locale of ["en", "cs"]) {
      await page.setViewport(1280, 800);
      await page.goto(origin + sessionPath);
    await waitForApp(page, ".composer .send");
      await page.evaluate(`(() => {
        localStorage.setItem("void-appearance", ${JSON.stringify(theme)});
        localStorage.setItem("void-locale", ${JSON.stringify(locale)});
        return true;
      })()`);
      await page.goto(origin + sessionPath);
    await waitForApp(page, ".composer .send");
      const result = await page.evaluate(PROBE_CALLED);
      rows.push({
        theme,
        locale,
        appliedTheme: result.theme,
        appliedLang: result.lang,
        errorBoundary: result.errorBoundary,
        recovery: result.recovery,
        heading: result.heading,
        contentChars: result.contentChars,
        transcriptHeight: result.transcript ? result.transcript.height : null,
        horizontalOverflow: result.scrollWidth - result.clientWidth,
        composerVisible: result.send ? result.send.bottom <= result.innerHeight + 1 : null,
      });
    }
  }
  await page.evaluate(`(() => { localStorage.removeItem("void-appearance"); localStorage.removeItem("void-locale"); return true; })()`);
  return rows;
}

async function measureRoutes(page, origin) {
  const nav = await page.evaluate(
    `(() => [...document.querySelectorAll(".sidebar nav a")].map((a) => a.getAttribute("href")))()`,
  );
  const rows = [];
  await page.setViewport(1280, 800);
  for (const route of REQUIRED_ROUTES) {
    // Ask the server first: a destination the control plane does not serve is
    // not a route, however the client-side fallback renders.
    const served = await page.evaluate(
      "fetch(" + JSON.stringify("/" + route) + ", { headers: { accept: 'text/html' } })" +
        ".then((r) => r.text().then((body) => ({ status: r.status, type: r.headers.get('content-type'), document: body.trimStart().toLowerCase().startsWith('<!doctype html') })))" +
        ".catch((e) => ({ status: 0, type: null, document: false, error: String(e) }))",
    );
    if (!served.document) {
      rows.push({
        route,
        path: "/" + route,
        inNav: nav.includes("/" + route),
        served: false,
        status: served.status,
        contentType: served.type,
        errorBoundary: null,
        heading: null,
        contentChars: served.status ? null : 0,
        horizontalOverflow: null,
      });
      continue;
    }
    await page.goto(origin + "/" + route);
    // The workspace preview has no public demo, so /demo settles on the
    // "demo unavailable" surface rather than the app shell.
    await waitForApp(page, ".shell, .app-recovery");
    const result = await page.evaluate(PROBE_CALLED);
    rows.push({
      route,
      path: result.path,
      inNav: nav.includes("/" + route),
      served: true,
      status: served.status,
      errorBoundary: result.errorBoundary,
      heading: result.heading,
      contentChars: result.contentChars,
      horizontalOverflow: result.scrollWidth - result.clientWidth,
      chatPresent: !!result.transcript,
    });
  }
  return { nav, rows };
}

async function seedConversation(page, origin) {
  await page.setViewport(1280, 800);
  await page.goto(origin + "/chat");
  await waitForApp(page);
  for (let i = 0; i < 3; i++) {
    await page.evaluate(setDraft(
      "Popiš prosím migrační plán pro VOID workbench, včetně doložitelného ledger záznamu a vratné operace. Bod " + (i + 1) + ".",
    ));
    await page.settle();
    await page.evaluate(`(() => {
      const button = document.querySelector(".composer .send");
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()`);
    for (let waited = 0; waited < 40; waited++) {
      await new Promise((r) => setTimeout(r, 500));
      const busy = await page.evaluate(`(() => {
        const send = document.querySelector(".composer .send");
        return !!(document.querySelector(".thinking, .demo-thinking") || (send && send.disabled));
      })()`);
      if (!busy) break;
    }
    await page.settle();
  }
  return page.evaluate(`(() => location.pathname)()`);
}

// ------------------------------------------------------ live runtime states
// Streaming, a provider refusal, a recovery that cannot apply and a pending
// approval are properties of a real conversation. Each one is driven through
// the built application against the real control plane, and everything
// recorded below is either read out of the running page or returned by the
// server that answered it. A state that cannot be driven honestly is recorded
// as not driven with the reason, never as a pass and never as a weaker
// assertion.

const runStateProbe = (origin, id) =>
  fetch(origin + "/api/sessions/" + id)
    .then((r) => (r.ok ? r.json() : null))
    .then((body) => body?.session ?? null);

/** The run's own state as the server holds it, or null when it says nothing. */
const runState = async (origin, id) => {
  const session = await runStateProbe(origin, id);
  return session?.state ?? session?.status ?? null;
};

/** Send a prompt and wait for the run it started to settle.
 *
 * The wait is the server's, not the DOM's: while a run is live the composer
 * swaps Send for Stop, so a disabled button is a request in flight rather than
 * a run in progress, and a missing button is a run in progress rather than a
 * finished one. Only the session's own state answers the question. */
async function sendAndWait(page, origin, prompt) {
  await page.evaluate(setDraft(prompt));
  await page.settle();
  const sent = await page.evaluate(`(() => {
    const button = document.querySelector(".composer .send");
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  if (!sent) return null;
  const id = await currentSessionId(page);
  if (!id) return null;
  const settled = await settleRun(origin, id, ["idle", "failed", "stopped", "unknown"]);
  await page.settle();
  return { id, settled };
}

/** The session id of the conversation the page is on, once a send created it. */
async function currentSessionId(page) {
  for (let i = 0; i < 80; i++) {
    const id = await page.evaluate(
      `(() => location.pathname.match(/^\\/chat\\/([a-f0-9-]+)$/) ?.[1] ?? null)()`,
    );
    if (id) return id;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

async function settleRun(origin, id, states, tries = 120) {
  for (let i = 0; i < tries; i++) {
    const session = await runStateProbe(origin, id);
    if (session && states.includes(session.state ?? session.status)) return session;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

const LAST_ASSISTANT = `(() => {
  const rows = [...document.querySelectorAll(".message.assistant .prose")];
  const text = rows.at(-1)?.innerText ?? "";
  return {
    // A markdown renderer decides its own line breaks; the claim under test is
    // which characters arrived, not where the renderer wrapped them.
    text: text.replace(/\\s+/g, " ").trim(),
    arriving: !!document.querySelector(".message.assistant.arriving"),
    flag: document.querySelector(".message.assistant .stream-flag")?.innerText?.trim() ?? null,
  };
})()`;

/** D04.04 streaming, read while the run that produced it is still open. */
async function measureStreaming(page, origin) {
  await page.setViewport(390, 844);
  await page.goto(origin + "/chat/new");
  await waitForApp(page, ".composer .send");
  providerBehaviour.mode = "stream";
  try {
    await page.evaluate(setDraft("Napiš odpověď, která dorazí po částech."));
    await page.settle();
    await page.evaluate(`(() => { document.querySelector(".composer .send").click(); return true; })()`);
    const id = await currentSessionId(page);
    if (!id) return { driven: false, reason: "the send never produced a conversation to read" };
    const partials = [];
    // The transcript read and the run state have to be read together, or the
    // two are sampled at two different moments and paired up afterwards. The
    // server marks the run done as soon as the provider's stream ends, while
    // the browser still renders the last frames for a moment afterwards, so a
    // reading taken in that gap is a finished reply and not a mid-stream one.
    // Reading the state on both sides of the read is what makes "the run was
    // still producing while this text was on screen" a claim about the same
    // instant instead of a claim about two of them.
    let terminalReading = null;
    let sawLiveRun = false;
    for (let i = 0; i < 60; i++) {
      const before = await runState(origin, id);
      const reading = await page.evaluate(LAST_ASSISTANT);
      const after = await runState(origin, id);
      if (reading.text) {
        const observed = {
          text: reading.text,
          arriving: reading.arriving,
          flag: reading.flag,
          runStateBefore: before,
          runStateAfter: after,
        };
        if (before === "running" && after === "running") {
          sawLiveRun = true;
          // One reading per distinct length: a re-render that changed nothing
          // is not evidence that anything arrived.
          if (partials.at(-1)?.text !== reading.text) partials.push(observed);
        } else if (sawLiveRun && !terminalReading) {
          // The first text read with the run already terminal is kept as the
          // evidence that the finished reply is what the run left behind, and
          // it is not counted as a mid-stream reading. A state read before the
          // run was ever seen live is not an ending, it is a queue the run
          // started out in, so it is not recorded as one.
          terminalReading = observed;
        }
        if (after !== "running" && partials.length) break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    const settled = await settleRun(origin, id, ["idle", "failed", "stopped", "unknown"]);
    await page.settle();
    // The server calls the run done a moment before the browser has painted
    // the last frame of it, so the finished reply is read once the transcript
    // has stopped changing rather than at one arbitrary millisecond after the
    // server settled. Bounded, and it never looks at what it expects to find.
    let completed = await page.evaluate(LAST_ASSISTANT);
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const next = await page.evaluate(LAST_ASSISTANT);
      const stable = next.text === completed.text;
      completed = next;
      if (stable) break;
    }
    const events = await fetch(origin + "/api/sessions/" + id + "/events?after=0")
      .then((r) => r.json())
      .then((body) => body.items ?? []);
    return {
      driven: true,
      answer: STREAMED_ANSWER,
      streamedChars: STREAMED_ANSWER.length,
      chunkCount: providerBehaviour.lastChunks,
      partials,
      completed: completed.text,
      finalState: settled?.state ?? settled?.status ?? null,
      deltaEvents: events.filter((e) => e.type === "message.delta").length,
      terminalReading,
    };
  } finally {
    providerBehaviour.mode = "tool-flow";
  }
}

const RATE_LIMIT_PROBE = `(() => {
  const send = document.querySelector(".composer .send");
  const transcript = document.querySelector(".transcript");
  const el = document.documentElement;
  const notice = [...document.querySelectorAll(".composer-notices p.notice")]
    .map((p) => p.innerText.trim())
    .find((text) => /rate limit/i.test(text)) ?? null;
  const r = send?.getBoundingClientRect();
  const hit = (() => {
    if (!r || !r.width || !r.height) return null;
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return top && (send === top || send.contains(top) || top.contains(send)) ? "reachable" : "covered";
  })();
  const offenders = [];
  for (const node of document.querySelectorAll(".composer-notices *")) {
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const box = node.getBoundingClientRect();
    if (!box.width && !box.height) continue;
    if (box.right > el.clientWidth + 1 || box.left < -1)
      offenders.push({ node: node.tagName.toLowerCase() + "." + String(node.className || ""), left: Math.round(box.left), right: Math.round(box.right) });
  }
  return {
    notice,
    sendDisabled: send ? send.disabled : null,
    send: r ? { top: Math.round(r.top), bottom: Math.round(r.bottom) } : null,
    sendHit: hit,
    innerHeight,
    transcriptHeight: transcript ? Math.round(transcript.getBoundingClientRect().height) : null,
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    offenders,
  };
})()`;

/** D04.04 a provider refusal the composer has to survive and then clear. */
async function measureRateLimit(page, origin) {
  await page.setViewport(320, 568);
  await page.goto(origin + "/chat/new");
  await waitForApp(page, ".composer .send");
  providerBehaviour.mode = "rate-limit";
  let id;
  try {
    await page.evaluate(setDraft("Zpráva, kterou poskytovatel odmítne."));
    await page.settle();
    await page.evaluate(`(() => { document.querySelector(".composer .send").click(); return true; })()`);
    id = await currentSessionId(page);
    if (!id) return { driven: false, reason: "the refused send never produced a conversation" };
    await settleRun(origin, id, ["failed", "idle", "stopped", "unknown"]);
    await page.settle();
    let during = null;
    for (let i = 0; i < 40 && !during?.notice; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const probe = await page.evaluate(RATE_LIMIT_PROBE);
      if (probe.notice) during = probe;
    }
    if (!during) return { driven: false, reason: "the 429 refusal never reached the composer notices" };
    const events = await fetch(origin + "/api/sessions/" + id + "/events?after=0")
      .then((r) => r.json())
      .then((body) => body.items ?? []);
    const failure = [...events].reverse().find((e) => e.type === "run.error");
    const session = await runStateProbe(origin, id);
    const provider = await fetch(origin + "/api/provider").then((r) => r.json());
    // The refusal is temporary, and the only honest way to show that is a real
    // reply after it. Send stays disabled until the server's own retry time
    // passes, so this waits the refusal out rather than reaching past it.
    providerBehaviour.mode = "tool-flow";
    for (let i = 0; i < 60; i++) {
      const probe = await page.evaluate(RATE_LIMIT_PROBE);
      if (!probe.notice && probe.sendDisabled === false) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const afterRun = await sendAndWait(page, origin, "Zpráva po odmítnutí limitu.");
    if (!afterRun) return { driven: false, reason: "the composer never accepted a message after the refusal" };
    // A cleared draft is not proof that the composer works again, because an
    // empty composer is disabled for an unrelated reason. A real draft is:
    // only the refusal can keep Send disabled from here.
    await page.evaluate(setDraft("Koncept, který se po odmítnutí musí poslat."));
    await page.settle();
    // The client refetches a settled session on its own schedule, so the
    // composer can still be showing Stop for a while after the server called
    // the run done. This waits for the control the assertion is about, and
    // keeps the last reading either way so a composer that never comes back
    // fails rather than passing on a timeout.
    let after = null;
    for (let i = 0; i < 80; i++) {
      after = await page.evaluate(RATE_LIMIT_PROBE);
      if (after.sendDisabled === false) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const afterAssistant = await page.evaluate(LAST_ASSISTANT);
    return {
      driven: true,
      status: failure?.payload?.status ?? null,
      retryAfter: providerBehaviour.retryAfter,
      runError: failure?.payload ?? null,
      notice: during.notice,
      sendDisabled: during.sendDisabled,
      send: during.send,
      sendHit: during.sendHit,
      innerHeight: during.innerHeight,
      transcriptHeight: during.transcriptHeight,
      horizontalOverflow: during.scrollWidth - during.clientWidth,
      offenders: during.offenders,
      providerStatus: provider.status,
      failedRun: session?.state ?? session?.status ?? null,
      after: {
        notice: after.notice,
        sendDisabled: after.sendDisabled,
        completed: afterAssistant.text,
        providerStatus: (await fetch(origin + "/api/provider").then((r) => r.json())).status,
      },
      afterSession: afterRun.id,
    };
  } finally {
    providerBehaviour.mode = "tool-flow";
  }
}


/** D04.04 a held tool call, pending in the server and decided in the browser. */
async function measureApproval(page, origin) {
  await page.setViewport(1280, 800);
  // A custom agent profile is what puts a managed write through the operator
  // policy: without a profile the workspace tools are not classified, so
  // nothing would ever be held and the state could not exist.
  await page.goto(origin + "/settings");
  await waitForApp(page, "form input[name=id]");
  const created = await page.evaluate(`(() => {
    const form = [...document.querySelectorAll("form")].find((f) => f.querySelector("[name=allowedTools]"));
    if (!form) return false;
    const set = (name, value) => {
      const field = form.querySelector("[name=" + name + "]");
      if (!field) return false;
      const proto = field.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype
        : field.tagName === "SELECT" ? window.HTMLSelectElement.prototype
        : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(field, value);
      field.dispatchEvent(new Event(field.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
      return true;
    };
    set("id", "qa-approver");
    set("name", "QA approver");
    set("systemPrompt", "Write the plan document through the managed workspace tool.");
    set("allowedTools", "void_workspace_write\\nvoid_workspace_read");
    set("maxTurns", "4");
    set("maxContextTokens", "32768");
    form.requestSubmit();
    return true;
  })()`);
  if (!created) return { driven: false, reason: "the agent profile form was not on the settings page" };
  let profileReady = null;
  for (let i = 0; i < 40 && !profileReady; i++) {
    await new Promise((r) => setTimeout(r, 200));
    profileReady = await fetch(origin + "/api/agents")
      .then((r) => r.json())
      .then((body) => (body.profiles ?? []).some((p) => p.id === "qa-approver"));
  }
  if (!profileReady) return { driven: false, reason: "the agent profile was never stored" };

  await page.goto(origin + "/chat/new");
  await waitForApp(page, ".composer .send");
  // The agent for a new conversation lives in the conversation settings
  // dialog, so the operator opens it and picks the profile there.
  await page.evaluate(`(() => { document.querySelector(".chat-options-trigger").click(); return true; })()`);
  await waitForApp(page, 'dialog[open] option[value="qa-approver"]');
  const chosen = await page.evaluate(`(() => {
    const select = [...document.querySelectorAll("dialog[open] select")]
      .find((node) => [...node.options].some((option) => option.value === "qa-approver"));
    if (!select) return null;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
    setter.call(select, "qa-approver");
    select.dispatchEvent(new Event("change", { bubbles: true }));
    const value = select.value;
    document.querySelector("dialog[open] .dialog-heading button")?.click();
    return value;
  })()`);
  if (chosen !== "qa-approver") return { driven: false, reason: "the agent profile could not be selected on a new conversation" };
  await page.settle();
  await page.evaluate(setDraft("Zapiš plán do dokumentu přes nástroj."));
  await page.settle();
  await page.evaluate(`(() => { document.querySelector(".composer .send").click(); return true; })()`);
  const id = await currentSessionId(page);
  if (!id) return { driven: false, reason: "the held tool call never produced a conversation" };

  const INLINE_APPROVAL = `(() => {
    const node = document.querySelector(".composer-notices .inline-approval");
    return node ? node.innerText.trim() : null;
  })()`;
  let before = null;
  let seenAt = 0;
  for (let i = 0; i < 80 && !before; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const inline = await page.evaluate(INLINE_APPROVAL);
    if (inline) {
      before = inline;
      seenAt = Date.now();
    }
  }
  if (!before) return { driven: false, reason: "the held tool call never appeared in the composer" };
  const holds = await fetch(origin + "/api/approvals").then((r) => r.json());
  const hold = (holds.approvals ?? [])[0] ?? null;
  const held = await runStateProbe(origin, id);
  const documents = await fetch(origin + "/api/documents?sessionId=" + id).then((r) => r.json());
  const beforeState = {
    inline: before,
    holdStatus: hold?.status ?? null,
    expiresInSeconds: hold?.expiresAt ? Math.round((hold.expiresAt - Date.now()) / 1000) : null,
    runState: held?.state ?? held?.status ?? null,
    toolWritten: (documents.items ?? documents.documents ?? []).length > 0,
  };

  await page.evaluate(`(() => {
    const node = document.querySelector(".composer-notices .inline-approval button");
    if (!node) return false;
    node.click();
    return true;
  })()`);
  await waitForApp(page, "dialog[open] .approval-facts");
  const dialog = await page.evaluate(`(() => {
    const node = document.querySelector("dialog[open]");
    const approve = [...node.querySelectorAll(".actions button")].find((b) => /Approve/.test(b.innerText));
    return {
      tool: node.querySelector("h2, h3")?.innerText?.trim() ?? null,
      klass: node.querySelector(".approval-facts")?.innerText ?? "",
      workspace: node.querySelector(".approval-facts")?.innerText ?? "",
      approveDisabled: approve ? approve.disabled : null,
    };
  })()`);
  const decidedAt = Date.now();
  await page.evaluate(`(() => {
    const approve = [...document.querySelectorAll("dialog[open] .actions button")].find((b) => /Approve/.test(b.innerText));
    if (!approve || approve.disabled) return false;
    approve.click();
    return true;
  })()`);
  const settled = await settleRun(origin, id, ["idle", "failed", "stopped", "unknown"]);
  await page.settle();
  for (let i = 0; i < 20; i++) {
    if (!(await page.evaluate(INLINE_APPROVAL))) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const history = await fetch(origin + "/api/approvals?history=true").then((r) => r.json());
  const records = history.approvals ?? history.items ?? [];
  const decided = records.find((a) => a.holdId === (hold?.holdId ?? null)) ?? null;
  const stillPending = (await fetch(origin + "/api/approvals").then((r) => r.json()))
    .approvals.some((a) => a.holdId === (hold?.holdId ?? null));
  const written = await fetch(origin + "/api/documents?sessionId=" + id).then((r) => r.json());
  const assistant = await page.evaluate(LAST_ASSISTANT);
  return {
    driven: true,
    tool: dialog.tool,
    workspace: (dialog.workspace.match(/Workspace:\s*(\S+)/) ?? [])[1] ?? null,
    // Pending means the operator could still have said no: the record has to
    // sit in the server unread long enough for a decision to be a decision.
    pendingMs: decidedAt - seenAt,
    before: beforeState,
    dialog: {
      tool: dialog.tool,
      klass: (dialog.klass.match(/Class:\s*(\S+)/) ?? [])[1] ?? null,
      workspace: (dialog.workspace.match(/Workspace:\s*(\S+)/) ?? [])[1] ?? null,
      approveDisabled: dialog.approveDisabled,
    },
    after: {
      holdStatus: decided?.status ?? null,
      stillPending,
      inlineGone: (await page.evaluate(INLINE_APPROVAL)) === null,
      toolWritten: (written.items ?? written.documents ?? []).length > 0,
      runState: settled?.state ?? settled?.status ?? null,
      completed: assistant.text,
    },
  };
}

/** D04.07 a recovery the operator approves and the server cannot apply. */
async function measureRecovery(page, origin) {
  await page.setViewport(1280, 800);
  await page.goto(origin + "/chat/new");
  await waitForApp(page, ".composer .send");
  const started = await sendAndWait(page, origin, "Napiš plán do dokumentu, abych mohl zkusit obnovu.");
  if (!started) return { driven: false, reason: "the conversation that owns the document never started" };
  const id = started.id;
  const written = await fetch(origin + "/api/documents?sessionId=" + id).then((r) => r.json());
  const rows = written.items ?? written.documents ?? [];
  if (!rows.length) return { driven: false, reason: "the run left no document to recover" };
  const path = rows[0].path;

  // The operator moves the document on before recovering the earlier write.
  // That is the real cause of a conflict, and the recovery refuses to undo a
  // document it no longer matches.
  await page.evaluate(`(() => {
    const button = document.querySelector('button[aria-label="Open context"]');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  await waitForApp(page, "section.document-history");
  const edited = await page.evaluate(`(() => {
    const row = [...document.querySelectorAll(".data-block tbody tr")]
      .find((node) => (node.querySelector("td")?.innerText ?? "").trim() === ${JSON.stringify(path)});
    // The row itself carries no handler; the operator opens the document with
    // the control the table puts at the end of the row.
    const open = row?.querySelector("button[aria-label]");
    if (!open) return false;
    open.click();
    return true;
  })()`);
  if (!edited) return { driven: false, reason: "the document row could not be opened in the context panel" };
  await waitForApp(page, "dialog[open] .document-editor, dialog[open] .document-preview");
  const openTab = await page.evaluate(`(() => {
    const tab = [...document.querySelectorAll("dialog[open] .toolbar button")].find((b) => /Edit/.test(b.innerText));
    if (!tab) return false;
    tab.click();
    return true;
  })()`);
  if (!openTab) return { driven: false, reason: "the document editor has no edit mode" };
  await waitForApp(page, "dialog[open] textarea.document-editor");
  const revised = NEWER_REVISION;
  await page.evaluate(`(() => {
    const area = document.querySelector("dialog[open] textarea.document-editor");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(area, ${JSON.stringify(revised)});
    area.dispatchEvent(new Event("input", { bubbles: true }));
    return area.value;
  })()`);
  await page.settle();
  const saved = await page.evaluate(`(() => {
    const button = [...document.querySelectorAll("dialog[open] .toolbar ~ button.primary, dialog[open] button.primary")]
      .find((b) => /Save new revision/.test(b.innerText));
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  if (!saved) return { driven: false, reason: "the new document revision could not be saved" };
  for (let i = 0; i < 40; i++) {
    const document_ = await fetch(origin + "/api/sessions/" + id + "/documents?path=" + encodeURIComponent(path)).then((r) => r.json());
    if (document_?.document?.content === revised) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  await page.evaluate(`(() => {
    const close = document.querySelector("dialog[open] .dialog-close, dialog[open] button[aria-label]");
    if (close) { close.click(); return true; }
    document.querySelector("dialog[open]")?.close();
    return false;
  })()`);
  await page.settle();

  // The oldest write to the path is the one a recovery can still name, and
  // the newest one is what makes it fail. The history section renders before
  // its rows arrive, so this polls rather than reading one instant.
  let ticked = null;
  for (let i = 0; i < 60 && !ticked; i++) {
    ticked = await page.evaluate(`(() => {
      const rows = [...document.querySelectorAll(".document-operation-list li")];
      const target = rows.filter((row) => (row.innerText || "").includes(${JSON.stringify(path)}) && /write/.test(row.innerText)).at(-1);
      if (!target) return null;
      const box = target.querySelector("input[type=checkbox]");
      if (!box || box.checked) return null;
      box.click();
      return target.querySelector("code")?.innerText?.trim() ?? null;
    })()`);
    if (!ticked) await new Promise((r) => setTimeout(r, 250));
  }
  if (!ticked) return { driven: false, reason: "no recorded write to the document could be selected for recovery" };
  const opened = await page.evaluate(`(() => {
    const button = [...document.querySelectorAll(".document-history .actions button")]
      .find((b) => /Preview recovery of selected changes/.test(b.innerText));
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  if (!opened) return { driven: false, reason: "the recovery preview could not be opened" };
  await waitForApp(page, "dialog[open] .recovery-evidence, dialog[open] .error");
  const plan = await page.evaluate(`(() => {
    const node = document.querySelector("dialog[open]");
    return {
      shown: !!node.querySelector(".recovery-evidence"),
      steps: node.querySelectorAll(".recovery-review ol > li").length,
      applyDisabled: [...node.querySelectorAll(".actions button")].find((b) => /Approve and apply/.test(b.innerText))?.disabled ?? null,
    };
  })()`);
  if (!plan.shown || !plan.steps) return { driven: false, reason: "the recovery plan held no executable step" };
  const approved = await page.evaluate(`(() => {
    const button = [...document.querySelectorAll("dialog[open] .actions button")].find((b) => /Approve and apply/.test(b.innerText));
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  if (!approved) return { driven: false, reason: "the recovery apply control was not operable" };
  let outcome = null;
  for (let i = 0; i < 60 && !outcome; i++) {
    await new Promise((r) => setTimeout(r, 250));
    outcome = await page.evaluate(`(() => {
      const node = document.querySelector("dialog[open]");
      if (!node) return null;
      const result = node.querySelector(".recovery-result");
      const error = node.querySelector(".error");
      if (!result && !error) return null;
      return {
        attribute: result?.getAttribute("data-outcome") ?? null,
        label: result?.querySelector("h3")?.innerText?.trim() ?? null,
        error: result ? null : error?.innerText?.trim() ?? null,
        text: node.innerText,
      };
    })()`);
  }
  if (!outcome) return { driven: false, reason: "the recovery neither settled nor refused in the browser" };
  const jobId = await page.evaluate(`(() => document.querySelector("dialog[open] .recovery-review p code")?.innerText?.trim() ?? null)()`);
  const serverStatus = jobId
    ? await fetch(origin + "/api/sessions/" + id + "/recovery-jobs/" + encodeURIComponent(jobId))
        .then((r) => (r.ok ? r.json() : null))
        .then((body) => body?.status ?? null)
    : null;
  const current = await fetch(origin + "/api/sessions/" + id + "/documents?path=" + encodeURIComponent(path)).then((r) => r.json());
  return {
    driven: true,
    path,
    operationId: ticked,
    jobId,
    stepCount: plan.steps,
    planShown: plan.shown,
    approved,
    status: outcome.attribute,
    dialogText: outcome.text,
    outcomeLabel: outcome.label,
    outcomeError: outcome.error,
    label: recoveryStateLabel(outcome.attribute, "en"),
    successLabel: recoveryStateLabel("restored", "en"),
    serverStatus,
    documentPreserved: (current?.document?.content ?? null) === revised,
    documentContent: current?.document?.content ?? null,
    expectedContent: revised,
  };
}

// --------------------------------------------------------------------- main

async function measureDemo(page, demo) {
  const rows = [];
  for (const viewport of VIEWPORTS) {
    await page.setViewport(viewport.width, viewport.height);
    await page.goto(demo.origin + "/demo");
    await waitForApp(page, ".demo-composer", "document.body.innerText.trim().length > 150");
    const result = await page.evaluate(DEMO_PROBE_CALLED);
    rows.push({
      viewport: viewport.name,
      clientWidth: result.clientWidth,
      scrollWidth: result.scrollWidth,
      horizontalOverflow: result.scrollWidth - result.clientWidth,
      transcriptHeight: result.transcript ? result.transcript.height : null,
      sendHit: result.sendHit,
      contentChars: result.contentChars,
      errorBoundary: result.errorBoundary,
      theme: result.theme,
      lang: result.lang,
    });
  }
  for (const theme of ["light", "dark"]) {
    for (const locale of ["en", "cs"]) {
      await page.setViewport(1280, 800);
      await page.goto(demo.origin + "/demo");
      await waitForApp(page, ".demo-composer", "document.body.innerText.trim().length > 150");
      await page.evaluate(
        `(() => { localStorage.setItem("void-appearance", ${JSON.stringify(theme)}); localStorage.setItem("void-locale", ${JSON.stringify(locale)}); return true; })()`,
      );
      await page.goto(demo.origin + "/demo");
      await waitForApp(page, ".demo-composer");
      const result = await page.evaluate(DEMO_PROBE_CALLED);
      rows.push({
        viewport: theme + "/" + locale,
        appliedTheme: result.theme,
        appliedLang: result.lang,
        contentChars: result.contentChars,
        errorBoundary: result.errorBoundary,
        heading: result.heading,
        horizontalOverflow: result.scrollWidth - result.clientWidth,
      });
    }
  }
  await page.evaluate(`(() => { localStorage.removeItem("void-appearance"); localStorage.removeItem("void-locale"); return true; })()`);
  return rows;
}

// D02.07: the internal gallery has to pass the same gates as the application
// it documents, so it is measured with the same probe at the same viewports.
async function measureGallery(page, origin) {
  const path = GALLERY_PATH;
  const load = async (width, height) => {
    await page.setViewport(width, height);
    await page.goto(origin + path);
    await waitForApp(page, GALLERY_ROOT);
    return page.evaluate(PROBE_CALLED);
  };
  const pick = (result) => ({
    clientWidth: result.clientWidth,
    scrollWidth: result.scrollWidth,
    horizontalOverflow: result.scrollWidth - result.clientWidth,
    errorBoundary: result.errorBoundary,
    heading: result.heading,
    contentChars: result.contentChars,
    offenders: result.offenders,
    offenderCount: result.offenderCount,
    tinyTargets: result.tinyTargets,
    tinyTargetCount: result.tinyTargetCount,
  });

  // Reachable, served as a document, and clearly not a product surface: it
  // replaces the shell, so no sidebar and no mobile nav can link to it.
  const served = await fetch(origin + path);
  await served.arrayBuffer();
  const requests = [];
  page.on("Network.requestWillBeSent", (params) =>
    requests.push(params.request.url.replace(origin, "")),
  );
  await page.send("Network.enable");
  await page.setViewport(1280, 800);
  await page.goto(origin + path);
  await waitForApp(page, GALLERY_ROOT);
  const reach = await page.evaluate(`(() => ({
    root: !!document.querySelector(${JSON.stringify(GALLERY_ROOT)}),
    internalNotice: !!document.querySelector("[data-internal-gallery]"),
    internalNoticeRole: document.querySelector("[data-internal-gallery]")?.getAttribute("role") ?? null,
    internalNoticeChars: (document.querySelector("[data-internal-gallery]")?.innerText ?? "").trim().length,
    sidebar: !!document.querySelector(".sidebar"),
    mobileNav: !!document.querySelector(".mobile-nav"),
    sections: [...document.querySelectorAll(${JSON.stringify(GALLERY_SECTION)})].map((node) => node.id),
    dialogOpen: !!document.querySelector("dialog[open]"),
    title: document.title,
    // The synthetic credential is fed through RedactedJson. Scanning the
    // serialised DOM catches it in an attribute, not just in visible text.
    secretInDom: document.documentElement.outerHTML.includes(${JSON.stringify(GALLERY_SECRET)}),
    bearerInDom: document.documentElement.outerHTML.includes("abcdef0123456789"),
    redactionShown: (document.querySelector(".json")?.innerText ?? "").includes("[redacted]"),
    keptPublicValue: (document.querySelector(".json")?.innerText ?? "").includes("public-value"),
  }))()`);
  await page.send("Network.disable");
  const apiRequests = requests.filter((url) => url.startsWith("/api/"));

  // D04.06 viewport matrix: the same nine viewports as the application.
  const viewports = [];
  for (const viewport of VIEWPORTS) {
    const result = await load(viewport.width, viewport.height);
    viewports.push({ viewport: viewport.name, kind: viewport.kind, ...pick(result) });
  }

  // D04.05 both themes render the real sections, not an empty shell.
  const themes = [];
  for (const theme of ["light", "dark"]) {
    await page.setViewport(1280, 800);
    await page.goto(origin + path);
    await page.evaluate(`(() => { localStorage.setItem("void-appearance", ${JSON.stringify(theme)}); return true; })()`);
    const result = await load(1280, 800);
    themes.push({ theme, appliedTheme: result.theme, ...pick(result) });
  }
  await page.evaluate(`(() => { localStorage.removeItem("void-appearance"); return true; })()`);

  // D04.08 every keyboard focus stop shows a visible ring.
  await load(1280, 800);
  const desktopFocus = await tabWalk(page, 220);
  await load(390, 844);
  const mobileFocus = await tabWalk(page, 220);

  // D04.08 reduced motion removes animation and transition.
  const motionRows = [];
  for (const reduce of [false, true]) {
    await page.setViewport(1280, 800);
    await page.setReducedMotion(reduce);
    await load(1280, 800);
    motionRows.push(await page.evaluate(`(() => ({
      prefersReduce: matchMedia("(prefers-reduced-motion: reduce)").matches,
      motionFlag: document.documentElement.dataset.motion,
      animated: [...document.querySelectorAll("body *")]
        .map((node) => ({ node: node.tagName.toLowerCase() + (typeof node.className === "string" && node.className ? "." + node.className.trim().split(/\\s+/)[0] : ""), style: getComputedStyle(node) }))
        .filter((entry) => entry.style.animationName !== "none" || entry.style.transitionDuration !== "0s")
        .slice(0, 12)
        .map((entry) => ({ node: entry.node, animation: entry.style.animationName, duration: entry.style.animationDuration, transition: entry.style.transitionDuration })),
    }))()`));
  }
  await page.setReducedMotion(false);

  // D04.08 200% zoom == half the CSS viewport.
  const zoom200 = [];
  for (const viewport of VIEWPORTS) {
    const result = await load(Math.floor(viewport.width / 2), Math.floor(viewport.height / 2));
    zoom200.push({
      viewport: viewport.name,
      cssViewport: Math.floor(viewport.width / 2) + "x" + Math.floor(viewport.height / 2),
      clientWidth: result.clientWidth,
      scrollWidth: result.scrollWidth,
      horizontalOverflow: result.scrollWidth - result.clientWidth,
      offenders: result.offenders,
    });
  }

  // D04.08 touch targets on a phone viewport. The application sizes a checkbox
  // at 20px and its wrapping label at 44px (styles.css:126-142), so the label
  // is the measured target. Record the label box so the assertion can check
  // that contract instead of exempting every input.
  const phone = await load(390, 844);
  const touchTargets = await page.evaluate(`(() => [...document.querySelectorAll("button, a[href], input, select, textarea, summary, [role=button]")]
    .map((node) => {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || node.disabled) return null;
      const r = node.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      if (r.width >= 43.5 && r.height >= 43.5) return null;
      const label = node.closest("label");
      const box = label ? label.getBoundingClientRect() : null;
      return {
        node: node.tagName.toLowerCase() + (typeof node.className === "string" && node.className ? "." + node.className.trim().split(/\\s+/).join(".") : ""),
        width: Math.round(r.width * 1000) / 1000,
        height: Math.round(r.height * 1000) / 1000,
        text: (node.innerText || "").trim().slice(0, 24),
        labelHeight: box ? Math.round(box.height * 100) / 100 : null,
      };
    })
    .filter(Boolean))()`);

  return {
    path,
    served: { status: served.status, type: served.headers.get("content-type") },
    reach,
    apiRequests,
    allRequests: requests,
    viewports,
    themes,
    focus: {
      desktop: desktopFocus.map((stop) => ({ ...stop, ring: ringVisible(stop) })),
      mobile: mobileFocus.map((stop) => ({ ...stop, ring: ringVisible(stop) })),
    },
    reducedMotion: motionRows,
    zoom200,
    touchTargets,
  };
}

// D03.01 pending/disabled on the shared DataTable refresh. The refetch is held
// open with Fetch interception so the pending state is observed rather than
// raced against a loopback server that answers in under a millisecond.
async function measureDataTableRefresh(page, origin) {
  await page.setViewport(1280, 800);
  await page.goto(origin + "/documents");
  await waitForApp(page, ".data-block .toolbar button");
  const READ = `(() => {
    const node = [...document.querySelectorAll(".data-block .toolbar button")]
      .find((button) => /Obnovit|Refresh/.test(button.innerText || ""));
    if (!node) return { found: false };
    const r = node.getBoundingClientRect();
    return {
      found: true,
      disabled: node.disabled,
      ariaBusy: node.getAttribute("aria-busy"),
      text: (node.innerText || "").trim().slice(0, 24),
      hitTest: (() => {
        if (!r.width || !r.height) return "zero-size";
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return top && (node === top || node.contains(top) || top.contains(node)) ? "reachable" : "covered";
      })(),
    };
  })()`;
  const settled = await page.evaluate(READ);

  const held = [];
  page.on("Fetch.requestPaused", (params) => held.push(params.requestId));
  await page.send("Fetch.enable", { patterns: [{ urlPattern: "*/api/*" }] });
  await page.evaluate(`(() => {
    const node = [...document.querySelectorAll(".data-block .toolbar button")]
      .find((button) => /Obnovit|Refresh/.test(button.innerText || ""));
    node.click();
    return true;
  })()`);
  // Poll for the render that the held request forces. Recording the miss is
  // meaningful: the assertion fails rather than silently passing.
  let during = null;
  for (let i = 0; i < 40; i++) {
    await page.settle();
    const state = await page.evaluate(READ);
    if (state.found && state.disabled) {
      during = state;
      break;
    }
    during ??= state;
  }
  await page.send("Fetch.disable");
  for (const requestId of held)
    await page.send("Fetch.continueRequest", { requestId }).catch(() => {});
  // DataTable also polls on an interval, so sample until the control settles
  // rather than reading one instant. The assertion is that the control comes
  // back, not that it is idle at one particular millisecond.
  let released = await page.evaluate(READ);
  for (let i = 0; i < 20 && released.disabled; i++) {
    await new Promise((r) => setTimeout(r, 200));
    await page.settle();
    released = await page.evaluate(READ);
  }
  return { settled, during, released, heldCount: held.length };
}

export async function measure() {
  const fixture = await startFixture();
  const workspace = await startWorkspace(fixture.port);

  const demo = await startDemoServer();
  const browser = await launchBrowser();
  let page;
  const report = { origin: workspace.origin, startedAt: new Date().toISOString(), viewport: {} };
  try {
    page = await openPage(browser.endpoint);
    const sessionPath = await seedConversation(page, workspace.origin);
    report.sessionPath = sessionPath;

    // D04.01 route matrix
    report.routes = await measureRoutes(page, workspace.origin);

    // D02.07 internal component gallery, held to the same gates
    report.gallery = await measureGallery(page, workspace.origin);

    // D03.01 shared DataTable refresh pending state
    report.dataTableRefresh = await measureDataTableRefresh(page, workspace.origin);

    // D04.05 theme x locale
    report.themeLocale = await measureThemesAndLocales(page, workspace.origin, sessionPath);

    // D04.06 / D04.07 viewport matrix with a real conversation loaded
    report.viewportMatrix = await measureViewport(page, workspace.origin, sessionPath);

    // D04.07 stacked notices: long draft + attachment + selected tool
    await page.setViewport(320, 568);
    await page.goto(workspace.origin + sessionPath);
    await waitForApp(page, ".composer .send");
    const longDraft = Array.from({ length: 14 }, (_, i) =>
      "Řádek " + (i + 1) + ": dlouhý rozpracovaný koncept zprávy, který musí přežít změnu obrazovky i trasy.",
    ).join("\n");
    await page.evaluate(setDraft(longDraft));
    await page.settle();
    const attachment = join(tmpdir(), "void-ui-matrix-attachment.md");
    await writeFile(attachment, "# Přiložený dokument\n\nObsah pro ověření výšky composeru.\n");
    const inputNode = await page.evaluate(
      `(() => { const input = document.querySelector('.attach-button input[type=file]'); return input ? 1 : 0; })()`,
    );
    let attachmentState = null;
    if (inputNode) {
      const { root } = await page.send("DOM.getDocument", { depth: -1, pierce: true });
      const { nodeId } = await page.send("DOM.querySelector", {
        nodeId: root.nodeId,
        selector: ".attach-button input[type=file]",
      });
      await page.send("DOM.setFileInputFiles", { nodeId, files: [attachment] });
      await page.settle();
      await new Promise((r) => setTimeout(r, 400));
      await page.settle();
      attachmentState = await page.evaluate(PROBE_CALLED);
      const removeButton = await page.evaluate(
        `(() => { const b = document.querySelector(".attachments button"); if (!b) return null; b.click(); return b.innerText.trim().slice(0, 30); })()`,
      );
      await page.settle();
      await new Promise((r) => setTimeout(r, 300));
      await page.settle();
      attachmentState.afterRemove = await page.evaluate(
        `(() => document.querySelector(".attachments")?.innerText.trim() ?? null)()`,
      );
      attachmentState.removeControl = removeButton;
    }
    await rm(attachment, { force: true });

    // D04.07 the selected tool row, stacked with the same long draft. The row
    // is reached the way a user reaches it: through the command palette, not
    // by writing state into the DOM.
    const toolName = await page.evaluate(`(() => {
      const area = document.querySelector(".composer textarea");
      if (!area) return null;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(area, "/");
      area.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    let toolState = null;
    let toolExpandedState = null;
    if (toolName) {
      let picked = false;
      for (let i = 0; i < 40 && !picked; i++) {
        picked = await page.evaluate(`(() => {
          const entry = [...document.querySelectorAll(".command-results > button")].find((b) => b.querySelector(".command-glyph")?.textContent === "⌘");
          if (!entry) return false;
          entry.click();
          return true;
        })()`);
        if (!picked) {
          await page.settle();
          await new Promise((r) => setTimeout(r, 150));
        }
      }
      await page.settle();
      // chooseCommand seeds the draft with the tool prompt; the long draft is
      // appended to that exact prefix so the prepared request stays selected.
      const toolPromptText = await page.evaluate(readDraft);
      await page.evaluate(setDraft(toolPromptText + "\n" + longDraft));
      await page.settle();
      toolState = await page.evaluate(PROBE_CALLED);
      toolState.selectedToolOpen = await page.evaluate(
        `(() => !!document.querySelector(".selected-tool[open]"))()`,
      );
      await page.evaluate(
        `(() => { const row = document.querySelector(".selected-tool > summary"); if (!row) return false; row.click(); return true; })()`,
      );
      await page.settle();
      toolExpandedState = await page.evaluate(PROBE_CALLED);
      toolExpandedState.selectedToolOpen = await page.evaluate(
        `(() => !!document.querySelector(".selected-tool[open]"))()`,
      );
    }
    report.stackedNotices = { longDraft, attachmentState, toolState, toolExpandedState };

    // D04.04 draft survives a route change and a reload
    await page.setViewport(1280, 800);
    await page.goto(workspace.origin + sessionPath);
    await waitForApp(page, ".composer .send");
    const beforeRoute = await page.evaluate(readDraft);
    await page.evaluate(setDraft("Draft, který musí přežít změnu trasy i view."));
    await page.settle();
    await page.goto(workspace.origin + "/settings");
    await waitForApp(page);
    await page.goto(workspace.origin + sessionPath);
    await waitForApp(page, ".composer .send");
    const afterRoute = await page.evaluate(readDraft);
    // A view switch that keeps Chat mounted: the collapse toggle on the shell.
    await page.evaluate(setDraft("Draft, který musí přežít přepnutí view v rámci chatu."));
    await page.settle();
    const beforeToggle = await page.evaluate(readDraft);
    await page.evaluate(`(() => {
      const button = document.querySelector(".collapse-button");
      if (!button) return false;
      button.click();
      return true;
    })()`);
    await page.settle();
    const afterToggle = await page.evaluate(readDraft);
    report.draftSurvival = { beforeRoute, afterRoute, beforeToggle, afterToggle };

    // D04.04 IME composition. Input.imeSetComposition starts a real
    // composition, so the keydown the composer sees really carries
    // isComposing. The pair to compare is the same key before and after the
    // composition closes: only the flag differs, and only one may submit.
    await page.setViewport(1280, 800);
    await page.goto(workspace.origin + sessionPath);
    await waitForApp(page, ".composer .send");
    await page.evaluate(setDraft(""));
    await page.settle();
    await page.evaluate(`(() => {
      const area = document.querySelector(".composer textarea");
      if (!area) return false;
      area.focus();
      window.__voidKeys = [];
      // A recorder, never a canceller: preventing the default here would hide
      // exactly the behaviour under test.
      area.addEventListener("keydown", (e) => {
        window.__voidKeys.push({ key: e.key, isComposing: e.isComposing, ctrl: e.ctrlKey, meta: e.metaKey });
      });
      return true;
    })()`);
    const imeText = "překlávesa";
    const enterKey = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 2 };
    const enter = async () => {
      await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", text: "\r", ...enterKey });
      await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...enterKey });
      await page.settle();
    };
    const sessionEvents = () =>
      fetch(
        workspace.origin +
          "/api/sessions/" +
          sessionPath.split("/").pop() +
          "/events?after=0",
      )
        .then((r) => r.json())
        .then((body) =>
          (body.items ?? [])
            .filter((e) => e.kind === "user")
            .map((e) => String(e.text ?? "").trim()),
        );
    const readComposition = () =>
      page.evaluate(`(() => ({
        draft: document.querySelector(".composer textarea")?.value ?? null,
        focused: document.activeElement?.matches(".composer textarea") === true,
        // The newest user row by its content, not a row count: a refetch can
        // add and drop rows, but the sent text either arrived or it did not.
        lastUser: [...document.querySelectorAll(".message.user .prose")].map((node) => node.innerText.trim()).at(-1) ?? null,
        keys: window.__voidKeys ?? [],
      }))()`);
    await page.send("Input.imeSetComposition", { text: "př", selectionStart: 2, selectionEnd: 2 });
    await page.settle();
    const composing = await readComposition();
    const messagesBefore = composing.messages;
    // Ctrl+Enter always submits, so this isolates the composition guard from
    // the send-behaviour preference.
    await enter();
    const duringComposition = await readComposition();
    // insertText commits the composition and fires compositionend.
    await page.send("Input.insertText", { text: imeText });
    await page.settle();
    const committed = await readComposition();
    await enter();
    const submitted = await readComposition();
    // The fixture answers immediately; wait for the run this send started so
    // the transcript has settled and the cancel-focus measurement below starts
    // from a clean composer.
    for (let waited = 0; waited < 40; waited++) {
      if (!(await page.evaluate(`(() => !!document.querySelector(".composer .send:disabled"))()`))) break;
      await new Promise((r) => setTimeout(r, 250));
      await page.settle();
    }
    report.ime = {
      text: imeText,
      composing,
      duringComposition,
      committed,
      submitted,
      // The durable claim is on the server, not in a row count: the composing
      // key must leave the stored user messages untouched, and the same key
      // after the composition closed must add one carrying the composed text.
      settled: await readComposition(),
      userMessages: await sessionEvents(),
      messagesBefore,
    };

    // D04.04 focus after cancelling a stream
    process.env.VOID_QA_SLOW = "1";
    await page.setViewport(1280, 800);
    await page.goto(workspace.origin + sessionPath);
    await waitForApp(page, ".composer .send");
    await page.evaluate(setDraft("Běh, který zruším, abych ověřil fokus po zrušení."));
    await page.settle();
    await page.evaluate(`(() => { document.querySelector(".composer .send").click(); return true; })()`);
    for (let waited = 0; waited < 40; waited++) {
      await new Promise((r) => setTimeout(r, 250));
      const running = await page.evaluate(`(() => !!document.querySelector(".composer-actions button[aria-label]")?.closest("form") && [...document.querySelectorAll(".composer-actions button")].some((b) => /Zastavit|Stop the run/.test(b.getAttribute("aria-label") || "")))()`);
      if (running) break;
    }
    const runningState = await page.evaluate(PROBE_CALLED);
    await page.evaluate(`(() => {
      const button = [...document.querySelectorAll(".composer-actions button")].find((b) => /Zastavit|Stop the run/.test(b.getAttribute("aria-label") || ""));
      if (!button) return false;
      button.click();
      return true;
    })()`);
    for (let waited = 0; waited < 40; waited++) {
      await new Promise((r) => setTimeout(r, 250));
      const gone = await page.evaluate(`(() => ![...document.querySelectorAll(".composer-actions button")].some((b) => /Zastavit|Stop the run/.test(b.getAttribute("aria-label") || "")))()`);
      if (gone) break;
    }
    await page.settle();
    report.cancelFocus = {
      runningStop: runningState.stop,
      runningStopHit: runningState.stopHit,
      focusAfterCancel: await page.evaluate(`(() => {
        const node = document.activeElement;
        if (node === document.body) return "body";
        if (node.matches(".composer textarea")) return "composer-textarea";
        return node.tagName.toLowerCase() + "." + (typeof node.className === "string" ? node.className : "");
      })()`),
    };
    delete process.env.VOID_QA_SLOW;

    // D04.08 keyboard focus walk
    await page.setViewport(1280, 800);
    await page.goto(workspace.origin + sessionPath);
    await waitForApp(page, ".composer .send");
    const desktopFocus = await tabWalk(page, 220);
    await page.setViewport(320, 568);
    await page.goto(workspace.origin + sessionPath);
    await waitForApp(page, ".composer .send");
    const mobileFocus = await tabWalk(page, 220);
    // The composer textarea is the primary input, so measure its ring directly
    // instead of relying on the walk to reach it past every message control.
    const composerRing = [];
    for (const [width, height] of [[1280, 800], [390, 844]]) {
      await page.setViewport(width, height);
      await page.goto(workspace.origin + sessionPath);
      await waitForApp(page, ".composer .send");
      // A programmatic focus does not reliably earn :focus-visible, so start
      // from the tabbable notices region and walk in with a real Tab key.
      await page.evaluate(`(() => {
        const notices = document.querySelector(".composer-notices");
        (notices ?? document.body).focus();
        return true;
      })()`);
      for (let i = 0; i < 4; i++) {
        await page.key("Tab", "Tab", 9, "\t");
        if (await page.evaluate(`(() => document.activeElement?.matches(".composer textarea") === true)()`)) break;
      }
      composerRing.push({ viewport: width + "x" + height, ...(await page.evaluate(FOCUS_CALLED)) });
    }
    report.focus = {
      desktop: desktopFocus.map((s) => ({ ...s, ring: ringVisible(s) })),
      mobile: mobileFocus.map((s) => ({ ...s, ring: ringVisible(s) })),
      composer: composerRing.map((s) => ({ ...s, ring: ringVisible(s) })),
    };

    // D04.08 reduced motion
    const motionRows = [];
    for (const reduce of [false, true]) {
      await page.setViewport(1280, 800);
      await page.setReducedMotion(reduce);
      await page.goto(workspace.origin + sessionPath);
    await waitForApp(page, ".composer .send");
      motionRows.push(await page.evaluate(`(() => {
        const animated = [...document.querySelectorAll("body *")]
          .map((node) => ({ node: node.tagName.toLowerCase() + (typeof node.className === "string" && node.className ? "." + node.className.trim().split(/\\s+/)[0] : ""), style: getComputedStyle(node) }))
          .filter((entry) => entry.style.animationName !== "none" || entry.style.transitionDuration !== "0s")
          .slice(0, 12)
          .map((entry) => ({ node: entry.node, animation: entry.style.animationName, duration: entry.style.animationDuration, transition: entry.style.transitionDuration }));
        return { prefersReduce: matchMedia("(prefers-reduced-motion: reduce)").matches, motionFlag: document.documentElement.dataset.motion, animated };
      })()`));
    }
    await page.setReducedMotion(false);
    report.reducedMotion = motionRows;

    // D04.08 200% zoom == half the CSS viewport
    const zoomRows = [];
    for (const viewport of VIEWPORTS) {
      const width = Math.floor(viewport.width / 2);
      const height = Math.floor(viewport.height / 2);
      await page.setViewport(width, height);
      await page.goto(workspace.origin + sessionPath);
    await waitForApp(page, ".composer .send");
      const result = await page.evaluate(PROBE_CALLED);
      zoomRows.push({
        viewport: viewport.name,
        cssViewport: width + "x" + height,
        clientWidth: result.clientWidth,
        scrollWidth: result.scrollWidth,
        horizontalOverflow: result.scrollWidth - result.clientWidth,
        offenders: result.offenders,
        transcriptHeight: result.transcript ? result.transcript.height : null,
        sendHit: result.sendHit,
      });
    }
    report.zoom200 = zoomRows;

    // D04.04/D04.07 the four live states, each driven through the built
    // application on a conversation of its own. The refusal runs last: a
    // provider that is still refusing blocks every later send, so leaving it
    // until the end keeps the other three from being measured through a
    // composer that is not allowed to transmit. The locale is pinned so the
    // exact strings under test are the ones an operator would read.
    await page.evaluate(`(() => { localStorage.setItem("void-locale", "en"); return true; })()`);
    // A state whose measurement broke is a state that was not driven, and the
    // reason travels with it into the gate's output. Letting the throw escape
    // would fail the whole report instead of naming this one hole.
    const drive = async (name, run) => {
      try {
        return await run();
      } catch (error) {
        return {
          driven: false,
          reason: name + " could not be driven: " + (error instanceof Error ? error.message : String(error)),
        };
      }
    };
    report.liveStates = {
      streaming: await drive("streaming", () => measureStreaming(page, workspace.origin)),
      approval: await drive("approval", () => measureApproval(page, workspace.origin)),
      recovery: await drive("recovery", () => measureRecovery(page, workspace.origin)),
      rateLimit: await drive("rateLimit", () => measureRateLimit(page, workspace.origin)),
    };
    await page.evaluate(`(() => { localStorage.removeItem("void-locale"); return true; })()`);

    // D04.01/D04.05/D04.06 for the public demo surface
    report.demo = await measureDemo(page, demo);

    // D04.08 touch targets on a phone viewport with a conversation loaded
    await page.setViewport(390, 844);
    await page.goto(workspace.origin + sessionPath);
    await waitForApp(page, ".composer .send");
    report.touchTargets = await page.evaluate(PROBE_CALLED);
    await page.setViewport(390, 844);
    await page.goto(workspace.origin + "/settings");
    await waitForApp(page);
    report.touchTargetsSettings = await page.evaluate(PROBE_CALLED);
  } finally {
    if (page) await page.close().catch(() => {});
    browser.close();
    fixture.model.closeAllConnections?.();
    await new Promise((resolve) => fixture.model.close(resolve));
    await workspace.close();
    await demo.close();
  }
  return report;
}

if (import.meta.filename === process.argv[1]) {
  const jsonIndex = process.argv.indexOf("--json");
  const report = await measure();
  if (jsonIndex !== -1) await writeFile(process.argv[jsonIndex + 1], JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
