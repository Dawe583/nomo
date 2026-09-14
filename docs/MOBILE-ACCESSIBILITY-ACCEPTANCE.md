# Mobile and accessibility acceptance

Audit date: 14 September 2026. This matrix deliberately distinguishes source
review, automated checks and physical-device acceptance. No physical iOS/Android
device or screen reader is available in this engineering environment.

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
