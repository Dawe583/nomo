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

test("focus ring uses a semantic token and neutral halo", () => {
  const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
  assert.match(css, /--focus:/);
  assert.match(css, /:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus\)/s);
  assert.match(css, /:focus-visible\s*\{[^}]*box-shadow:\s*0 0 0 4px var\(--canvas\)/s);
});

test("permission controls use built-in locale text", () => {
  const source = readFileSync(new URL("./permission-mode.tsx", import.meta.url), "utf8");
  assert.match(source, /const t = useText\(\)/);
  assert.match(source, /aria-label=\{t\("Režim oprávnění", "Permission mode"\)\}/);
  assert.doesNotMatch(source, /aria-label="Permission mode"/);
});

test("native dialog exposes modal semantics", () => {
  const source = readFileSync(new URL("./ui.tsx", import.meta.url), "utf8");
  assert.match(source, /aria-modal="true"/);
});

test("composer notices announce changes politely", () => {
  const source = readFileSync(new URL("./chat.tsx", import.meta.url), "utf8");
  assert.match(source, /className="composer-notices"[^>]*aria-live="polite"/);
});

test("compact navigation and checkbox labels keep 44px targets", () => {
  const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
  // Asserted against the token rather than the literal. The 44px these two rules
  // carry is `--control-touch`, whose value is 44, and a test that matched the
  // digits would fail the moment someone did the right thing and read the
  // token, which is the same failure the design-source gate exists to end.
  const touch = "min-height:\\s*var\\(--control-touch\\)";
  assert.match(css, new RegExp(`\\.sidebar a:not\\(\\.brand a\\)\\s*\\{[^}]*${touch}`, "s"));
  assert.match(css, new RegExp(`label:has\\(input\\[type="checkbox"\\]\\)\\s*\\{[^}]*${touch}`, "s"));
});

test("built-in chat metadata is localized without touching authored content", () => {
  const source = readFileSync(new URL("./chat.tsx", import.meta.url), "utf8");
  assert.match(source, /t\("cena neznámá", "cost unknown"\)/);
  assert.match(source, /t\("Místní PC", "Local PC"\)/);
  assert.match(source, /t\("Místní NOMO", "NOMO Local"\)/);
  assert.match(source, /t\("NOMO Cloud", "NOMO Cloud"\)/);
  assert.doesNotMatch(source, /\? " · cost unknown"/);
  assert.doesNotMatch(source, /\? "prime-agent · Local PC"/);
  assert.doesNotMatch(source, /\? "NOMO Local"/);
});

test("branch intent keeps one stable idempotency key across retries", () => {
  const source = readFileSync(new URL("./chat.tsx", import.meta.url), "utf8");
  assert.match(source, /branchRequestKey/);
  assert.match(source, /idempotencyKey:\s*branchRequestKey\.current/);
  assert.match(source, /idempotencyKey:\s*`\$\{branchRequestKey\.current\}:followup`/);
  assert.doesNotMatch(source, /branches",\s*"POST",\s*\{[\s\S]*idempotencyKey:\s*crypto\.randomUUID\(\)/);
});
test("built-in command and hooks labels use the active locale", () => {
  const commandMenu = readFileSync(new URL("./command-menu.tsx", import.meta.url), "utf8");
  assert.match(commandMenu, /t\("r1 · Zpět", "r1 · Undo"\)/);
  assert.match(commandMenu, /t\("r0 · Čtení", "r0 · Read"\)/);
  assert.doesNotMatch(commandMenu, /\?\s*"r[01] · (?:Undo|Read)"/);
  const controls = readFileSync(new URL("./workspace-controls.tsx", import.meta.url), "utf8");
  assert.match(controls, /<h2>\{t\("Hooky", "Hooks"\)\}<\/h2>/);
  assert.doesNotMatch(controls, /<h2>Hooks<\/h2>/);
});

test("icon-only controls use the shared semantic icon vocabulary", () => {
  const source = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
  const chat = readFileSync(new URL("./chat.tsx", import.meta.url), "utf8");
  assert.match(source, /<Icon name="compose" \/>/);
  assert.match(source, /<Icon name="search" \/>/);
  assert.match(source, /<Icon name="settings" \/>/);
  assert.match(chat, /<Icon name="more" \/>/);
  assert.match(chat, /<Icon name="send" \/>/);
  assert.match(chat, /<Icon name="stop" \/>/);
  assert.doesNotMatch(chat, /className="chat-options-trigger"[\s\S]{0,160}>⋯/);
});
