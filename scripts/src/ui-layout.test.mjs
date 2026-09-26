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
 *   - every light/dark and English/Czech combination renders real content,
 *   - an IME composition neither submits nor loses characters,
 *   - a stacked long draft, attachment and selected tool keep Send reachable.
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

test("D04.07 the transcript share is re-derived at every viewport, not only on desktop", { skip: !built && "dist/web is missing" }, () => {
  // One floor per viewport class. The percentages are recomputed from the two
  // measured pixel values, so a recorded string can never carry a stale claim.
  const floors = { phone: 65, tablet: 75, landscape: 70, desktop: 70, "short-landscape": 45 };
  const seen = [];
  for (const row of report.viewportMatrix) {
    assert.ok(row.transcriptHeight > 0, `${row.viewport} has no measured transcript height`);
    assert.ok(row.workAreaHeight > 0, `${row.viewport} has no measured work area height`);
    const derived = Math.round((row.transcriptHeight / row.workAreaHeight) * 1000) / 10;
    assert.ok(
      Math.abs(derived - Number.parseFloat(row.transcriptShare)) < 0.05,
      `${row.viewport} recorded ${row.transcriptShare} but the pixels derive ${derived}%`,
    );
    const floor = floors[row.kind];
    assert.ok(floor !== undefined, `${row.viewport} has no transcript-share floor for kind ${row.kind}`);
    assert.ok(
      derived >= floor,
      `${row.viewport} transcript is ${derived}% of the work area (${row.transcriptHeight}px of ${row.workAreaHeight}px), floor ${floor}%`,
    );
    seen.push(row.viewport);
  }
  assert.equal(seen.length, 9, "the share table must cover the whole D04.06 viewport set");
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

test("D04.07 the selected tool row is reachable from the palette and keeps Send reachable at 320x568", { skip: !built && "dist/web is missing" }, () => {
  const state = report.stackedNotices.toolState;
  const expanded = report.stackedNotices.toolExpandedState;
  assert.ok(state, "no selected tool row was measured");
  assert.ok(state.selectedTool, "the selected tool row never reached the composer notices region");
  assert.equal(state.selectedToolOpen, false, "the prepared request must not open by itself");
  assert.ok(state.noticesText.includes("jen připraveno"), "the row does not say that nothing has run: " + state.noticesText);
  assert.ok(state.transcript && state.transcript.height >= 200, `stacked transcript is ${state.transcript?.height}px`);
  assert.ok(state.send.bottom <= state.innerHeight + 1, `Send fell outside the viewport at ${state.send.bottom} of ${state.innerHeight}`);
  assert.equal(state.scrollWidth, state.clientWidth, "the selected tool row overflows horizontally");
  assert.equal(state.sendHit, "reachable");
  // Opening the schema is the worst case for the bounded notices region.
  assert.ok(expanded, "the expanded tool row was not measured");
  assert.equal(expanded.selectedToolOpen, true, "the selected tool row did not expand");
  assert.ok(expanded.selectedTool.height > state.selectedTool.height, "expanding the row did not add content");
  assert.ok(expanded.send.bottom <= expanded.innerHeight + 1, `Send fell outside the viewport at ${expanded.send.bottom} of ${expanded.innerHeight} when the tool row was expanded`);
  assert.equal(expanded.sendHit, "reachable", `Send is ${expanded.sendHit} with the tool row expanded`);
  assert.ok(expanded.transcript && expanded.transcript.height >= 140, `transcript collapsed to ${expanded.transcript?.height}px with the tool row expanded`);
});

test("D04.04 an IME composition keeps its characters and does not submit", { skip: !built && "dist/web is missing" }, () => {
  const ime = report.ime;
  // The composition is real: the browser itself produced these keydowns and
 // reported isComposing, so this is not a synthetic flag the app handed us.
  assert.equal(ime.composing.draft, "př", "the composition never reached the composer");
  const duringKey = ime.duringComposition.keys.at(-1);
  assert.ok(duringKey, "no keydown was recorded during the composition");
  assert.equal(duringKey.key, "Enter");
  assert.equal(duringKey.ctrl, true, "the composing key was not the one that always submits");
  assert.equal(duringKey.isComposing, true, "Chromium did not report an open composition");
  assert.equal(ime.duringComposition.draft, "př", "Enter during a composition lost or changed the draft");
  assert.equal(ime.duringComposition.focused, true, "focus left the composer during a composition");
  // Same key, same modifiers, composition closed: now it must send.
  assert.equal(ime.submitted.keys.at(-1).isComposing, false, "the composition was still open after commit");
  assert.equal(ime.submitted.draft, "", "the draft survived a send it triggered");
  assert.equal(ime.settled.keys.length, 2, "the composer received a third key");
  // The durable claim is checked on the server, not in a DOM row count a
  // refetch can change: the composed text was stored exactly once, and only
  // the key after the composition closed could have stored it. The stored
  // text carries the permission prefix the composer prepends by design.
  const stored = ime.userMessages.filter((text) => text.endsWith(ime.text));
  assert.equal(stored.length, 1, "the composed text was stored " + stored.length + " times, expected once");
  assert.equal(ime.userMessages.at(-1).endsWith(ime.text), true, "the newest stored user message is not the composed one: " + JSON.stringify(ime.userMessages.at(-1)));
  assert.equal(ime.committed.draft, ime.text, "committing the composition lost characters");
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

// ------------------------------------------------------------ D02.07 gallery
// The internal gallery documents the shipped components, so it is held to the
// same measured gates as the application. Each assertion is a browser fact.

test("D02.07 the gallery is a served, internal page outside the user navigation", { skip: !built && "dist/web is missing" }, () => {
  assert.equal(report.gallery.path, "/gallery", "the harness measured " + report.gallery.path);
  // Served as a document, not a 404 and not a redirect. The allowlist lives in
  // apps/control-plane/api/server.ts:619; without it the page would not exist.
  assert.equal(report.gallery.served.status, 200, `${report.gallery.path} answered HTTP ${report.gallery.served.status}`);
  assert.match(
    report.gallery.served.type ?? "",
    /text\/html/,
    `${report.gallery.path} is not served as a document: ${report.gallery.served.type}`,
  );
  const reach = report.gallery.reach;
  assert.match(reach.title, /galerie komponent|component gallery/i, "the browser tab does not read as internal: " + reach.title);
  assert.equal(reach.root, true, "the gallery root never rendered at " + report.gallery.path);
  assert.equal(reach.internalNotice, true, "the gallery has no internal notice");
  assert.equal(reach.internalNoticeRole, "note", "the internal notice is announced as " + reach.internalNoticeRole);
  assert.ok(reach.internalNoticeChars > 40, `the internal notice reads "${reach.internalNoticeChars}" characters, too short to say the page is internal`);
  // It replaces the shell, so there is no sidebar and no mobile nav to link to
 // it. If either appears, the gate leaked into ordinary navigation.
  assert.equal(reach.sidebar, false, "the gallery rendered inside the application shell");
  assert.equal(reach.mobileNav, false, "the gallery rendered the mobile navigation");
  assert.equal(reach.dialogOpen, false, "a dialog was already open on load");
  assert.ok(
    report.routes.nav.every((href) => !String(href).includes("gallery")),
    "the gallery is linked from the application navigation: " + JSON.stringify(report.routes.nav),
  );
  assert.deepEqual(
    reach.sections,
    ["buttons", "fields", "choices", "status", "provider", "surfaces", "dialog", "icons"],
    "the gallery sections are: " + JSON.stringify(reach.sections),
  );
});

test("D02.07 the gallery fetches no workspace data", { skip: !built && "dist/web is missing" }, () => {
  // The gallery mounts from Root, before App, so none of the provider,
  // session, approval, overview or capability probes ever fire. If the gate
  // moves back inside App, this goes red with a real request list.
  assert.deepEqual(
    report.gallery.apiRequests,
    [],
    "the gallery issued API requests: " + JSON.stringify(report.gallery.apiRequests),
  );
  // It must still be a real built bundle, not an empty document.
  assert.ok(
    report.gallery.allRequests.some((url) => url.startsWith("/assets/")),
    "the gallery loaded no application bundle: " + JSON.stringify(report.gallery.allRequests),
  );
});

test("D02.07 the gallery renders no credential in the DOM", { skip: !built && "dist/web is missing" }, () => {
  // The evidence block feeds a synthetic secret through RedactedJson. If the
  // key-based or the value-based redaction ever stops applying, the string
  // lands in the serialised DOM and this goes red.
  assert.equal(report.gallery.reach.secretInDom, false, "a synthetic API key reached the gallery DOM");
  assert.equal(report.gallery.reach.bearerInDom, false, "a synthetic bearer token reached the gallery DOM");
  // Redaction must not be a blanket blur: the non-secret sibling survives.
  assert.equal(report.gallery.reach.redactionShown, true, "the evidence block shows no [redacted] marker");
  assert.equal(report.gallery.reach.keptPublicValue, true, "redaction removed a value that is not a secret");
});

test("D02.07 the gallery has no horizontal overflow at any D04.06 viewport", { skip: !built && "dist/web is missing" }, () => {
  assert.equal(report.gallery.viewports.length, 9);
  for (const row of report.gallery.viewports) {
    assert.equal(row.errorBoundary, false, `gallery ${row.viewport} fell into the error boundary`);
    assert.equal(row.scrollWidth, row.clientWidth, `gallery ${row.viewport} overflows horizontally by ${row.horizontalOverflow}px: ${JSON.stringify(row.offenders.slice(0, 3))}`);
    assert.ok(row.contentChars > 1200, `gallery ${row.viewport} rendered only ${row.contentChars} characters`);
  }
});

test("D02.07 the gallery renders its real sections in light and dark", { skip: !built && "dist/web is missing" }, () => {
  assert.equal(report.gallery.themes.length, 2);
  for (const row of report.gallery.themes) {
    assert.equal(row.appliedTheme, row.theme, `the gallery did not apply ${row.theme}`);
    assert.equal(row.errorBoundary, false, `the ${row.theme} gallery fell into the error boundary`);
    assert.equal(row.horizontalOverflow, 0, `the ${row.theme} gallery overflows horizontally`);
    assert.ok(row.contentChars > 1200, `the ${row.theme} gallery rendered ${row.contentChars} characters`);
    assert.ok(row.offenderCount === 0, `the ${row.theme} gallery has overflowing nodes: ${JSON.stringify(row.offenders.slice(0, 3))}`);
  }
});

test("D02.07 every gallery focus stop shows a visible ring", { skip: !built && "dist/web is missing" }, () => {
  for (const [name, stops] of [["desktop", report.gallery.focus.desktop], ["mobile", report.gallery.focus.mobile]]) {
    assert.ok(stops.length > 8, `the ${name} gallery walk only reached ${stops.length} stops`);
    for (const stop of stops) {
      assert.ok(stop.focusVisible, `gallery ${name}: ${stop.element} is focused but not :focus-visible`);
      assert.equal(stop.outlineStyle, "solid", `gallery ${name}: ${stop.element} has outline-style ${stop.outlineStyle}`);
      assert.ok(Number.parseFloat(stop.outlineWidth) >= 2, `gallery ${name}: ${stop.element} outline is ${stop.outlineWidth}`);
    }
  }
});

test("D02.07 the gallery honours prefers-reduced-motion", { skip: !built && "dist/web is missing" }, () => {
  const [normal, reduced] = report.gallery.reducedMotion;
  assert.equal(normal.prefersReduce, false);
  assert.ok(normal.animated.length > 0, "the gallery fixture measured no animated element at all");
  assert.equal(reduced.prefersReduce, true);
  assert.deepEqual(reduced.animated, [], "the gallery still animates under reduced motion");
});

test("D02.07 the gallery has no horizontal overflow at 200% zoom", { skip: !built && "dist/web is missing" }, () => {
  for (const row of report.gallery.zoom200) {
    assert.equal(row.scrollWidth, row.clientWidth, `the gallery at 200% in ${row.viewport} (${row.cssViewport}) overflows by ${row.horizontalOverflow}px: ${JSON.stringify(row.offenders.slice(0, 3))}`);
  }
});

test("D02.07 every gallery touch target reaches 44px on a phone viewport", { skip: !built && "dist/web is missing" }, () => {
  // The application sizes a checkbox at 20px and its wrapping label at 44px
  // (styles.css:126-142), so the label is the target. Every other control has
  // to reach 44px on its own.
  for (const target of report.gallery.touchTargets) {
    if (!target.node.startsWith("input"))
      assert.fail(`small target in the gallery on a phone viewport: ${JSON.stringify(target)}`);
    assert.ok(
      target.labelHeight !== null && target.labelHeight >= 43.5,
      `the ${target.node} is ${target.width}x${target.height} and its label is ${target.labelHeight}px, so nothing reaches 44px`,
    );
  }
});

test("D03.01 the shared DataTable refresh exposes a pending state", { skip: !built && "dist/web is missing" }, () => {
  const refresh = report.dataTableRefresh;
  assert.equal(refresh.settled.found, true, "the shared DataTable refresh button was never rendered");
  assert.equal(refresh.heldCount > 0, true, "the refetch was never held, so no pending state could be observed");
  // Before the fix the button stayed enabled through the whole refetch, so a
  // second click could start another one.
  assert.equal(refresh.settled.disabled, false, "the refresh button is permanently disabled, so it can never refresh");
  assert.equal(refresh.during.disabled, true, `the refresh button stayed enabled while ${refresh.heldCount} requests were in flight: ${JSON.stringify(refresh.during)}`);
  assert.equal(refresh.during.ariaBusy, "true", `the pending refresh is not announced: aria-busy is ${refresh.during.ariaBusy}`);
  // Releasing the held request has to restore the control, or the page would
  // deadlock after one refresh.
  assert.equal(refresh.released.disabled, false, "the refresh button stayed disabled after the refetch completed");
});
