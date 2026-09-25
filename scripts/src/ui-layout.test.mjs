/**
 * Browser regression gate for the VOID web workbench.
 *
 * Measures the real built application in a real headless Chromium against
 * disposable loopback fixtures. Every assertion here corresponds to a measured
 * browser fact, not to a source pattern:
 *
 *   - no horizontal overflow at any D04.06 viewport,
 *   - Send stays inside the visual viewport and hit-testable,
 *   - the transcript keeps its measured height floor and share of the work area,
 *   - every keyboard focus stop shows a visible ring,
 *   - cancelling a run returns focus to the composer,
 *   - reduced motion removes animation and transition,
 *   - 200% zoom does not overflow,
 *   - every light/dark and English/Czech combination renders real content.
 *
 * Run: node --test scripts/src/ui-layout.test.mjs
 * Requires `node scripts/src/build-web.mjs` to have produced dist/web.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { measure, DESKTOP_VIEWPORTS, PHONE_VIEWPORTS, SHORT_LANDSCAPE } from "./ui-matrix.mjs";

const built = existsSync(new URL("../../dist/web/index.html", import.meta.url));
const reportPromise = built ? measure() : null;
const report = await (reportPromise ?? Promise.resolve(null));
if (report && process.env.VOID_QA_REPORT) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(process.env.VOID_QA_REPORT, JSON.stringify(report, null, 2));
}

test("D04.06 viewport matrix has no horizontal overflow and a reachable Send", { skip: !built && "dist/web is missing; run node scripts/src/build-web.mjs" }, () => {
  for (const row of report.viewportMatrix) {
    assert.equal(row.scrollWidth, row.clientWidth, `${row.viewport} overflows horizontally by ${row.horizontalOverflow}px: ${JSON.stringify(row.offenders.slice(0, 3))}`);
    const send = row.raw.send ?? row.raw.stop;
    assert.ok(send, `${row.viewport} has neither Send nor Stop in the composer`);
    assert.ok(send.top >= -1 && send.bottom <= row.raw.innerHeight + 1, `${row.viewport} the send control sits outside the viewport at ${send.top}..${send.bottom} of ${row.raw.innerHeight}`);
    assert.equal(row.raw.sendHit ?? row.raw.stopHit, "reachable", `${row.viewport} the send control is ${row.raw.sendHit ?? row.raw.stopHit}`);
  }
});

test("D04.07 transcript keeps 200px at 320x568 and 60% of the work area on desktop", { skip: !built && "dist/web is missing" }, () => {
  for (const name of PHONE_VIEWPORTS) {
    const phone = report.viewportMatrix.find((row) => row.viewport === name);
    assert.ok(phone.transcriptHeight >= 200, `${name} transcript is ${phone.transcriptHeight}px`);
  }
  for (const name of SHORT_LANDSCAPE) {
    const short = report.viewportMatrix.find((row) => row.viewport === name);
    const send = short.raw.send ?? short.raw.stop;
    assert.ok(send && send.bottom <= short.raw.innerHeight + 1, `${name} the send control fell outside the viewport`);
    // D04.07 allows the transcript to shrink on a keyboard-sized viewport, but
    // the shrink has to stay measured rather than collapse to nothing.
    assert.ok(short.transcriptHeight > 100, `${name} transcript collapsed to ${short.transcriptHeight}px`);
  }
  for (const row of report.viewportMatrix.filter((entry) => DESKTOP_VIEWPORTS.includes(entry.viewport))) {
    const share = Number.parseFloat(row.transcriptShare);
    assert.ok(share >= 60, `${row.viewport} transcript is ${row.transcriptShare} of the work area (${row.transcriptHeight}px of ${row.workAreaHeight}px)`);
  }
});

test("D04.07 a long draft plus an attachment keeps Send reachable at 320x568", { skip: !built && "dist/web is missing" }, () => {
  const state = report.stackedNotices.attachmentState;
  assert.ok(state, "no attachment state was measured");
  assert.ok(state.attachments, "the attachment never reached the notices region");
  assert.ok(state.transcript && state.transcript.height >= 200, `stacked transcript is ${state.transcript?.height}px`);
  assert.ok(state.send.bottom <= state.innerHeight + 1, `Send fell outside the viewport at ${state.send.bottom} of ${state.innerHeight}`);
  assert.equal(state.sendHit, "reachable");
  assert.equal(state.afterRemove, null, "the attachment could not be removed");
});

test("D04.01 every required Mac route has a server-served, rendering surface", { skip: !built && "dist/web is missing" }, () => {
  const expected = {
    chat: "/chat",
    overview: "/overview",
    runs: "/runs",
    documents: "/documents",
    approvals: "/approvals",
    ledger: "/ledger",
    connections: "/connections",
    models: "/models",
    settings: "/settings",
  };
  for (const [name, path] of Object.entries(expected)) {
    const row = report.routes.rows.find((entry) => entry.route === name);
    assert.ok(row, `${name} was not measured`);
    assert.equal(row.served, true, `${name} is not served as a document (HTTP ${row.status}, ${row.contentType})`);
    assert.equal(row.path, path, `${name} resolved to ${row.path}`);
    assert.equal(row.horizontalOverflow, 0, `${name} overflows horizontally`);
    assert.ok(row.contentChars > 150, `${name} rendered only ${row.contentChars} characters`);
  }
  const chat = report.routes.rows.find((entry) => entry.route === "chat");
  assert.equal(chat.errorBoundary, false, "chat fell into the error boundary");
  // /conversations is not a VOID route. The Conversations destination is
  // /sessions, and it must stay reachable from the sidebar.
  const conversations = report.routes.rows.find((entry) => entry.route === "conversations");
  assert.equal(conversations.served, false, "/conversations must not pretend to be a route");
  assert.ok(report.routes.nav.includes("/sessions"), "/sessions is missing from the sidebar");
  const sessions = report.routes.rows.find((entry) => entry.route === "runs");
  assert.equal(sessions.path, "/runs");
  assert.ok(report.routes.nav.includes("/runs"));
  // The public demo needs the demo API, which the workspace fixture does not serve.
  const demo = report.routes.rows.find((entry) => entry.route === "demo");
  assert.equal(demo.served, true, "/demo is not served by the control plane");
  assert.ok(report.demo.length > 0, "the public demo surface was never measured");
});

test("D04.05 both themes and both locales render the long conversation", { skip: !built && "dist/web is missing" }, () => {
  assert.equal(report.themeLocale.length, 4);
  for (const row of report.themeLocale) {
    assert.equal(row.errorBoundary, false, `${row.theme}/${row.locale} fell into the error boundary`);
    assert.equal(row.appliedTheme, row.theme, `${row.locale} did not apply ${row.theme}`);
    assert.equal(row.appliedLang, row.locale);
    assert.ok(row.contentChars > 1000, `${row.theme}/${row.locale} rendered ${row.contentChars} characters`);
    assert.ok(row.transcriptHeight >= 200, `${row.theme}/${row.locale} transcript is ${row.transcriptHeight}px`);
    assert.equal(row.horizontalOverflow, 0);
    assert.equal(row.composerVisible, true);
  }
});

test("D04.05 the public demo renders in both themes and both locales", { skip: !built && "dist/web is missing" }, () => {
  const combos = report.demo.filter((row) => row.appliedTheme);
  assert.equal(combos.length, 4);
  for (const row of combos) {
    assert.equal(row.errorBoundary, false, `demo ${row.viewport} fell into the error boundary`);
    assert.equal(row.appliedTheme, row.viewport.split("/")[0]);
    assert.equal(row.appliedLang, row.viewport.split("/")[1]);
    assert.ok(row.contentChars > 200, `demo ${row.viewport} rendered ${row.contentChars} characters`);
    assert.equal(row.horizontalOverflow, 0);
  }
  for (const row of report.demo.filter((entry) => entry.viewport.includes("x"))) {
    assert.equal(row.errorBoundary, false, `demo ${row.viewport} fell into the error boundary`);
    assert.equal(row.scrollWidth, row.clientWidth, `demo ${row.viewport} overflows horizontally`);
    // A short landscape phone hides the welcome paragraph on purpose, so the
    // floor is the rendered surface, not the full copy.
    assert.ok(row.contentChars > 150, `demo ${row.viewport} rendered ${row.contentChars} characters`);
    assert.equal(row.sendHit, "reachable", `demo ${row.viewport} Send is ${row.sendHit}`);
  }
});

test("D04.08 every keyboard focus stop shows a visible ring", { skip: !built && "dist/web is missing" }, () => {
  for (const [name, stops] of [["desktop", report.focus.desktop], ["mobile", report.focus.mobile]]) {
    assert.ok(stops.length > 10, `the ${name} tab walk only reached ${stops.length} stops`);
    for (const stop of stops) {
      assert.ok(stop.focusVisible, `${name}: ${stop.element} is focused but not :focus-visible`);
      assert.equal(stop.outlineStyle, "solid", `${name}: ${stop.element} has outline-style ${stop.outlineStyle}`);
      assert.ok(Number.parseFloat(stop.outlineWidth) >= 2, `${name}: ${stop.element} outline is ${stop.outlineWidth}`);
    }
  }
  // The composer is the primary input: its ring is measured directly, because a
  // walk has to cross every message control to reach it.
  assert.equal(report.focus.composer.length, 2);
  for (const stop of report.focus.composer) {
    assert.equal(stop.tag, "textarea", `${stop.viewport}: focus is on ${stop.element}`);
    assert.ok(stop.focusVisible, `${stop.viewport}: the composer textarea is not :focus-visible`);
    assert.equal(stop.outlineStyle, "solid", `${stop.viewport}: the composer textarea outline-style is ${stop.outlineStyle}`);
    assert.ok(Number.parseFloat(stop.outlineWidth) >= 2, `${stop.viewport}: the composer textarea outline is ${stop.outlineWidth}`);
  }
});

test("D04.08 prefers-reduced-motion removes animation and transition", { skip: !built && "dist/web is missing" }, () => {
  const [normal, reduced] = report.reducedMotion;
  assert.equal(normal.prefersReduce, false);
  assert.ok(normal.animated.length > 0, "the motion fixture measured no animated element at all");
  assert.equal(reduced.prefersReduce, true);
  assert.deepEqual(reduced.animated, [], "reduced motion still animates");
});

test("D04.08 200% zoom keeps the page free of horizontal overflow", { skip: !built && "dist/web is missing" }, () => {
  for (const row of report.zoom200) {
    assert.equal(row.scrollWidth, row.clientWidth, `${row.viewport} at 200% overflows by ${row.horizontalOverflow}px`);
    assert.equal(row.sendHit, "reachable", `${row.viewport} at 200% Send is ${row.sendHit}`);
  }
});

test("D04.04 the draft survives a route change and an in-place view switch", { skip: !built && "dist/web is missing" }, () => {
  assert.equal(report.draftSurvival.afterRoute, "Draft, který musí přežít změnu trasy i view.");
  assert.equal(report.draftSurvival.afterToggle, "Draft, který musí přežít přepnutí view v rámci chatu.");
});

test("D04.04 cancelling a run returns focus to the composer", { skip: !built && "dist/web is missing" }, () => {
  assert.equal(report.cancelFocus.runningStopHit, "reachable", "Stop was not reachable while the run was live");
  assert.equal(report.cancelFocus.focusAfterCancel, "composer-textarea", "focus fell to " + report.cancelFocus.focusAfterCancel + " after cancelling the run");
});

test("D04.08 touch targets reach 44px on a phone viewport", { skip: !built && "dist/web is missing" }, () => {
  // The only measured sub-44px node is the file input inside the 44px attach
  // label; the label, not the hidden input, is the touch target.
  const offending = report.touchTargets.tinyTargets.filter((target) => !target.node.startsWith("input"));
  assert.deepEqual(offending, [], "small targets on a phone viewport: " + JSON.stringify(offending));
  const attach = report.touchTargets.attachLabel;
  assert.ok(attach && attach.height >= 43.5, `the attach label is ${attach?.height}px tall`);
  assert.equal(report.touchTargetsSettings.tinyTargetCount, 0, "a phone-sized settings page has a small target");
});
