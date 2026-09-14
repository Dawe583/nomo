# Mobile and accessibility acceptance

Audit date: 14 September 2026. This matrix deliberately distinguishes source
review, automated checks and physical-device acceptance. No physical iOS/Android
device or screen reader is available in this engineering environment.

## Browser verification, 15 September 2026

The Codex in-app browser reproduced focus escape from the deployed empty
Documents dialog. The shared dialog now explicitly wraps Tab/Shift+Tab and
restores its connected opener after React unmounts it. In the isolated local
Workbench, the conversation-options dialog passed forward/backward wrap and
Escape restoration to its opener (Czech labels). This covers the shared
component, not every possible dialog-content combination.

Local Workbench checks at 390x844, 844x390 and 320x720 showed no horizontal
document overflow. A disposable draft survived viewport changes and was cleared
after the test. At 390x844 the public demo send control measured 44x44 CSS pixels
and stayed within the viewport. The marketing hero also rendered without
horizontal overflow at 390px. No real model message was sent. These are browser
viewport checks, not physical keyboard, screen-reader or true 200% zoom results.

The local Windows preview also reproduced rejected JavaScript asset paths and
encrypted-snapshot fsync failure. URL normalization and writable snapshot flushes
were corrected; the local conversation then loaded without the persistence
error. The API suite passes all 12 tests, including asset routing and encoded
Windows-separator refusal. All six encrypted-storage tests pass on Windows,
including injected flush failure, stale-writer refusal and retry.

## Follow-up verification, 15 September 2026

All 32 runtime tests now pass on Windows, including all five previously failing
crash cases. All 39 ledger tests pass, including private Windows ACL creation,
key reload, rejection of an explicit Everyone read grant, and reparse-point
refusal. Windows fixtures use junctions where symlink creation needs elevated
privileges; Linux retains file-symlink coverage. The reserved-vault crash fixture
signals its exact pre-commit point, then the parent kills it; rollback and quota
assertions still run. The proxy bin suite passes all 14 cases with isolated
in-memory signing keys. These suites are included in the Windows/Linux Node
24/26 persistence workflow. This does not claim the full Windows suite passes.

Additional local browser checks at 640x450 (reflow equivalent to a 1280x900
viewport at 200% zoom, not an actual browser-zoom test) passed: no horizontal
overflow, 44x44 visible send control, forward/backward dialog focus wrapping,
and Escape restoration to View options. An unsent disposable draft was used.
No real provider request was made. The user confirmed no physical mobile devices
are available; physical-device and screen-reader acceptance remain unverified.

| Case | Expected result | Source evidence | Physical acceptance |
| --- | --- | --- | --- |
| Compose with keyboard open | Message and send button remain reachable | `styles.css` dynamic viewport and safe-area rules | Pending: iOS Safari and Android Chrome |
| Rotate/navigate with a draft | Draft survives and remains editable | `demo.tsx` and `chat.tsx` sessionStorage draft persistence | Pending: both devices |
| Open documents and Undo preview | Dialog traps keyboard focus; close restores trigger focus | Shared native `Dialog` in `ui.tsx` uses showModal/close | Pending: desktop keyboard and screen reader |
| Cancel/confirm Undo | Cancel does not mutate; confirmation required | `demo.tsx` review dialog and managed-cloud HTTP confirmation test | Pending: both devices and screen reader |
| Provider error/retry | Error announced and draft preserved | `ErrorBox` uses role=alert; composer draft state | Pending: deterministic provider failure |
| Zoom to 200% | No clipped essential controls; all controls reachable | Responsive styles, not acceptance proof | Pending: browser zoom at desktop/mobile widths |

For each pending case record actual device/model, OS, browser/version, screen
reader/version, viewport, zoom, test commit and workspace. Capture a short screen
recording or screenshot, exact actions, expected/actual result and pass/fail.
Use disposable documents and the deterministic local provider, never production
content. Repeat in both themes and English/Czech where labels differ.

Any failure gets a reproduction, affected control, severity, proposed fix and
estimate before being marked resolved. Desktop emulation cannot close physical
keyboard or screen-reader cases. This is not an accessibility certification.
