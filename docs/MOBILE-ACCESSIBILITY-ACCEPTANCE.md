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

## Remaining engineering verification

The broader Windows runtime run passed 33 of 38 storage/runtime tests. Five
crash-process cases remain failing: two child-process timeouts, two development
key reload failures because POSIX mode 0600 does not describe Windows ACLs, and
one POSIX SIGKILL exit-status assertion. Do not interpret the focused Windows CI
gate as complete Windows crash/restart certification. Follow-up: implement and
test Windows development-key ACL validation, then adapt the process fixtures
without weakening key-access checks or skipping recovery assertions. Estimated
1 to 2 days, subject to Windows ACL and subprocess behavior. The existing proxy
suite also hung in the full local Windows run; Linux CI remains the full-suite
gate. Physical-device cases below still require actual devices and evidence.

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
