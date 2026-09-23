# Compact GUI implementation plan

Status: implementation and available verification complete; release in progress.
See `docs/GUI-COMPACT-VERIFICATION.md` for exact evidence and open platform gates.

## Goal

Make conversation the dominant workspace on web, packaged desktop and mobile.
Use neutral Claude Code inspired hierarchy with VOID branding. Preserve all
backend contracts, permission truth, recovery controls and accessible input.
Do not use page zoom or transform scaling. No new dependencies.

## Ordered delivery

1. [x] Baseline and fixture. Inspect `scripts/src/preview-workspace.mjs` and
   provider configuration. Repair the explicitly fake provider routing without
   real credentials. Build fresh web assets and measure every target viewport.
2. [x] Shared shell. Update `ui/src/styles.css`, `ascii.css`, `mobile.css` and
   `main.tsx`. Neutral light/dark tokens, sans UI, 48px header, approximately
   224px sidebar, optional inspector, mobile drawers. Remove competing oversized
   identity overrides rather than introducing another CSS override file.
3. [x] Composer and chat. Update `chat.tsx` and shared status presentation.
   Group project, agent and permission options in accessible on-demand controls.
   Keep actual permission source, errors and approval actions available. Compact
   welcome, messages and tool cards. Preserve draft, IME, stop and streaming.
4. [x] Secondary surfaces. Review `ui.tsx`, `pages.tsx`, `documents.tsx`,
   `settings.tsx`, `integrations.tsx`, `demo.tsx`. Compact dashboard, shared tables,
   mobile lists, dialogs and demo consistently. No functionality deletion.
5. [ ] Regression and visual checks (available checks passed; hardware, actual
   zoom and live streaming/approval limits remain explicitly open). Add node:test regressions before behavior
   changes. Verify built app at 320x568, 390x844, 430x932, 768x1024, 834x1112,
   1024x768, 1280x800, 1440x900 and short landscape. Both themes/locales.
   Check empty, populated, missing provider, error, streaming, approval, long
   code/table/URL/name, multi-line input, keyboard, focus, Escape, zoom 200%,
   reduced motion. Capture screenshots and geometry, inspect console.
6. [ ] Native and release (builds and native smokes passed; push pending). Run UI tests, repository typecheck/check, web/cloud
   build, desktop runtime tests and available native build/smoke. Reuse the two
   existing reviewers. Fix findings and reverify. Commit/push verified changes
   to main and verify deployment. Report native artifact separately from web.

## Acceptance

- Basic 320x568 chat retains at least 200px transcript and reachable composer.
- Normal desktop chat retains at least 60% work area for transcript.
- No unintended horizontal overflow, clipped controls or obscured composer.
- UI text approximately 13-14px, messages 15-16px, mobile inputs at least 16px.
- Mobile touch targets at least 44px; text contrast at least 4.5:1.
- Critical errors and permission/approval truth are not hidden for density.
- No changes to real credentials, production data or provider defaults.
- Browser emulation is not physical phone or native WKWebView evidence.

## Verification commands

`node --test --test-reporter=tap apps/control-plane/ui/src/*.test.ts`
`pnpm run check`
`pnpm run build`
`pnpm desktop:test`
`pnpm desktop:build` when the native toolchain is available.

Use existing disposable preview and isolated browser profiles for interaction
checks. No authenticated production mutations. Record exact evidence and any
platform limitation before claiming completion.
