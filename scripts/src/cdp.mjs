// Minimal Chrome DevTools Protocol driver for local VOID web UI measurement.
// No new dependency: Node's global WebSocket plus the Chromium binary already
// cached on this machine. Everything binds to 127.0.0.1 only.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const CACHE = join(homedir(), "Library/Caches/ms-playwright");

export function findChromium() {
  if (process.env.VOID_QA_CHROMIUM) return process.env.VOID_QA_CHROMIUM;
  const candidates = [];
  const dirs = existsSync(CACHE) ? readdirSync(CACHE) : [];
  for (const dir of dirs.filter((d) => d.startsWith("chromium_headless_shell")).sort().reverse())
    candidates.push(join(CACHE, dir, "chrome-mac-arm64", "chrome-headless-shell"));
  for (const dir of dirs.filter((d) => d.startsWith("chromium-")).sort().reverse())
    candidates.push(join(CACHE, dir, "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents/MacOS/Google Chrome for Testing"));
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error("No local Chromium binary found; set VOID_QA_CHROMIUM.");
  return found;
}

export async function launchBrowser() {
  const profile = join(tmpdir(), "void-qa-chrome-" + process.pid);
  const child = spawn(findChromium(), [
    "--headless=new",
    "--remote-debugging-port=0",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    "--disable-extensions",
    "--user-data-dir=" + profile,
    "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const endpoint = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("Chromium did not expose a debugging port")), 30000);
    child.stderr.on("data", (chunk) => {
      buffer += chunk;
      const match = buffer.match(/ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-f0-9-]+/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    child.once("error", reject);
  });
  return {
    endpoint,
    close() {
      child.kill("SIGKILL");
      try {
        rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // A killed Chromium can still hold profile files; the temp dir is disposable.
      }
    },
  };
}

class Channel {
  constructor(socket, sessionId) {
    this.socket = socket;
    this.sessionId = sessionId;
    this.next = 1;
    this.pending = new Map();
    this.listeners = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        if (message.error) entry.reject(new Error(message.error.message));
        else entry.resolve(message.result);
        return;
      }
      const handlers = this.listeners.get(message.method);
      if (handlers) for (const handler of handlers) handler(message.params);
    });
  }
  send(method, params = {}) {
    const id = this.next++;
    const payload = { id, method, params };
    if (this.sessionId) payload.sessionId = this.sessionId;
    this.socket.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error("CDP timeout: " + method));
      }, 60000);
    });
  }
  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(handler);
  }
  once(method, handler) {
    const wrapper = (...args) => {
      const list = this.listeners.get(method);
      list.splice(list.indexOf(wrapper), 1);
      handler(...args);
    };
    this.on(method, wrapper);
  }
}

export async function openPage(endpoint) {
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const root = new Channel(socket, null);
  const { targetId } = await root.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await root.send("Target.attachToTarget", { targetId, flatten: true });
  const page = new Channel(socket, sessionId);
  page.targetId = targetId;
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  page.consoleMessages = [];
  page.errors = [];
  page.on("Runtime.consoleAPICalled", (params) => {
    if (params.type === "warning" || params.type === "error")
      page.consoleMessages.push({
        level: params.type,
        text: (params.args || []).map((a) => a.value ?? a.description ?? a.type).join(" "),
      });
  });
  page.on("Runtime.exceptionThrown", (params) => {
    page.errors.push(params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? "error");
  });
  page.evaluate = async (expression) => {
    const result = await page.send("Runtime.evaluate", {
      expression: "(" + expression + ")",
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (result.exceptionDetails)
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  page.setViewport = (width, height, extra = {}) =>
    page.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: width,
      screenHeight: height,
      ...extra,
    });
  page.setColorScheme = (scheme) => page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
  page.setReducedMotion = (reduce) =>
    page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: reduce ? "reduce" : "no-preference" }] });
  page.goto = async (url) => {
    page.consoleMessages.length = 0;
    page.errors.length = 0;
    const loaded = new Promise((resolve) => {
      const handler = () => resolve();
      page.once("Page.loadEventFired", handler);
    });
    await page.send("Page.navigate", { url });
    await loaded;
    await page.settle();
  };
  page.settle = () =>
    page.evaluate(
      "new Promise(r => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 150))), 50))",
    );
  page.key = async (key, code, keyCode, text) => {
    const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
    await page.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", text, ...base });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await page.settle();
  };
  page.tab = (shift) => page.key("Tab", "Tab", 9, "\t");
  page.close = () => root.send("Target.closeTarget", { targetId: page.targetId });
  return page;
}

export async function withBrowser(run) {
  const browser = await launchBrowser();
  try {
    return await run(await openPage(browser.endpoint));
  } finally {
    browser.close();
  }
}
