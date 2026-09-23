import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const chat = readFileSync(new URL("./chat.tsx", import.meta.url), "utf8");

test("secondary composer settings live in a named modal outside the form", () => {
  assert.match(chat, /className="chat-options-trigger"/);
  assert.match(chat, /chatOptions &&/);
  const form = chat.slice(chat.indexOf('className="composer"'), chat.indexOf("</form>"));
  assert.doesNotMatch(form, /PermissionModeSwitch/);
  const modal = chat.slice(chat.indexOf("{chatOptions &&"));
  assert.match(modal, /PermissionModeSwitch/);
  assert.match(modal, /new-session-options/);
});

test("alerts scroll separately from the composer form", () => {
  assert.match(chat, /className="composer-notices"/);
  const notices = chat.slice(chat.indexOf('className="composer-notices"'), chat.indexOf('className="composer"'));
  assert.match(notices, /PermissionBanner/);
  assert.match(notices, /ProviderNotice/);
  const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /\.composer-wrap \{ max-height: 44%/);
  assert.match(css, /\.composer-notices\s*\{[^}]*overflow-y: auto/s);
});

test("context compaction remains mounted outside the options dialog", () => {
  const modalStart = chat.indexOf("{chatOptions &&");
  const contextIndex = chat.indexOf("<SessionContext");
  assert.ok(contextIndex >= 0 && modalStart >= 0);
  assert.ok(contextIndex < modalStart);
  assert.match(chat, /setChatOptions\(false\); onContext\(\)/);
});

test("explicit public demo disables private workspace polling", () => {
  const main = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
  assert.match(main, /useApi\("\/api\/provider", path !== "\/demo"\)/);
  assert.match(main, /const privateQueries = path !== "\/demo" && !needsAuth/);
  assert.match(main, /useApi\("\/api\/preferences", privateQueries\)/);
  assert.match(main, /useApi\("\/api\/overview", privateQueries\)/);
});

test("tool details and attachments share the bounded notices region", () => {
  const form = chat.slice(chat.indexOf('className="composer"'), chat.indexOf("</form>"));
  assert.doesNotMatch(form, /className="selected-tool"|className="attachments"/);
  const notices = chat.slice(chat.indexOf('className="composer-notices"'), chat.indexOf('className="composer"'));
  assert.match(notices, /className="selected-tool"/);
  assert.match(notices, /className="attachments"/);
});
