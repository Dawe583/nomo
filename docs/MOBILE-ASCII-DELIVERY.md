# Mobile ASCII delivery — 13 September 2026

## Scope and evidence

The reported screenshots show an earlier interface with `sess-demo-01` and
`View chat is not loaded`. A fresh visit to production during this work loaded
the current React application. The old screen could not be reproduced in that
session; a stale tab/cache is a possible explanation, not a verified root cause.
HTML now explicitly uses `no-store` on Vercel and in the local server. Hashed
production assets remain immutable. An already open old tab needs one reload.

## Delivered

- Shared ASCII wordmark, monospace controls, terminal prompt starter actions,
  square surfaces and touch feedback across private chat and public demo.
  The existing VOID aperture and light/dark palette remain recognizable.
  Long responses retain the readable text face. No new runtime dependency.
- One clipped text reveal for the welcome screen. Motion follows the saved
  animation setting and system reduced motion; touch states do not require hover.
- Composer stays inside the available viewport; inputs remain 16 px on mobile.
  Keyboard viewport sizing and safe-area handling are retained.
- Demo appearance and language now use shared persisted state. Previously the
  demo changed the DOM theme directly, so reload lost the selection.
- Rejected demo messages restore the draft. Uncertain retries reuse the request
  identifier; a reconciled accepted message is not automatically resubmitted.
  Drafts persist in the tab. Busy/running guards cover keyboard and form submission.
- Demo startup can be retried. An unavailable demo offers the private workspace.
  Pending runs remain visibly active after a page refresh.
- Dialog padding is no longer treated as a backdrop click. Only clicks outside
  its measured bounds dismiss it. Native modal focus and Escape remain intact.
- Lazy page/chat/document loads have local loading states, preserving the shell
  and context close button. A render/chunk error has an explicit reload action.
- Next GUI plan increment: mobile data tables default to their existing list
  presentation. Explicit table/list preference is retained in navigation history.
  Removed the mobile CSS that forced both choices into the same presentation;
  the table option now really exposes sortable columns. The view-options panel
  previously extended 103 px left of the screen at 320 px. It now occupies
  x=16…304 in the page flow, with all choices reachable.

## Verification

`pnpm check` passed: 592 package/application/script tests and 12 cloud tests;
4 optional cloud integration tests were skipped. After the final changes,
UI typecheck, production Vite build, Nitro/Vercel build and 6 focused static SPA,
demo API and event tests passed.

Browser interaction used disposable local workspaces with explicitly identified
provider fixtures. A chat created a real managed document; its content, revision,
history, Undo preview and completed Undo were inspected. Model selection,
Czech/English, theme and context controls were exercised. The public demo fixture
rejected `FAIL_ONCE` before acceptance: the input was preserved and retry returned
one reply. Theme, language and animation-off state survived reload.

Private chat and public demo response/composer checks at 320×568, 390×844, 430×932, 667×375 and
1440×900 had no page-level horizontal overflow. Composer stayed inside each
viewport, and input font size was 16 px. These checks do not emulate a physical
iPhone keyboard, browser chrome, VoiceOver, or frame rate. Physical-device
acceptance remains necessary; no device-certification claim is made.

Reproduce public demo UI checks without live services:

```sh
pnpm build:web
node scripts/src/preview-mobile-demo.mjs
# Open http://127.0.0.1:8084/demo; submit FAIL_ONCE twice.
```

Private managed-document QA uses `node scripts/src/preview-workspace.mjs`.

## Next work

The larger GUI and reverse-engine plans remain active documents, not completed
milestones. This delivery advances mobile presentation and reliability. The
remaining reverse-engine crash/persistence certification, filesystem/Git support
and multi-operation planning keep their original release gates in
REVERSE-UPGRADE-PROGRESS.md.

## Production confirmation

Commit `c676848` was pushed directly to `main`. Git integration automatically
created production deployment `dpl_GJ8fV9oDSQcaDnhth14LY5bKeKwX`, which reached
READY and owns `https://void-tui.vercel.app`. The production root responds with
`Cache-Control: no-store`. At 390 px, the new ASCII chat and navigation loaded
without console warnings/errors; composer bottom measured 778.5 px within an
844 px viewport. The separate reverse-plan follow-up adds actual SIGKILL tests
for the inverse-commit boundary; see REVERSE-UPGRADE-PROGRESS.md.

### Live provider limitation

A real message was submitted in the visitor-scoped production demo. The demo
accepted the message, but TokenRouter did not complete it. After adding a safe
error classifier and repeating the small smoke request once, the deployed
provider returned HTTP 503. This is an unresolved upstream availability failure,
not a successful live-generation test. The UI now distinguishes provider rate
limits, authentication/model-access errors and other HTTP failures without
exposing provider payloads or credentials. The four demo tests pass, including
error redaction. No provider/model substitution or credential change was made.
A new submission clears the previous server error while it is pending.
