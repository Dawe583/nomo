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
import { createControlPlaneServer } from "../../apps/control-plane/api/server.ts";
import { launchBrowser, openPage } from "./cdp.mjs";

const ROOT = new URL("../../", import.meta.url).pathname;

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
  app.use(express.static(resolve(ROOT, "dist/web")));
  app.get("/demo", (_req, res) => res.sendFile(resolve(ROOT, "dist/web/index.html")));
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

async function measureViewport(page, origin, sessionPath) {
  const rows = [];
  for (const viewport of VIEWPORTS) {
    await page.setViewport(viewport.width, viewport.height);
    await page.goto(origin + sessionPath);
    await waitForApp(page, ".composer .send");
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
      transcriptShare: transcriptHeight !== null && workHeight ? Math.round((transcriptHeight / workHeight) * 1000) / 10 + "%" : null,
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
    report.stackedNotices = { longDraft, attachmentState };

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

    // D04.04 IME composition must not submit or lose characters
    await page.setViewport(1280, 800);
    await page.goto(workspace.origin + sessionPath);
    await waitForApp(page, ".composer .send");
    await page.evaluate(`(() => { const area = document.querySelector(".composer textarea"); area.focus(); return true; })()`);
    for (const [type, key, text] of [
      ["keyDown", "Process", ""],
      ["char", "p", "p"],
      ["char", "ř", "ř"],
    ]) {
      if (type === "char")
        await page.send("Input.insertText", { text });
      else
        await page.send("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, text, windowsVirtualKeyCode: 229 });
    }
    await page.settle();
    const imeValue = await page.evaluate(readDraft);
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Process", code: "Process", windowsVirtualKeyCode: 229 });
    await page.evaluate(setDraft(""));
    report.ime = { value: imeValue };

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
