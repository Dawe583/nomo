# Compact GUI verification, 2026-09-23

## Implemented

Shared web and desktop React shell now uses neutral surfaces, compact spacing,
NOMO grid branding and restrained orange accents. Secondary conversation
settings moved to the existing accessible dialog. Notices scroll separately from
the composer form. Context compaction stays mounted in the transcript. Explicit
public demo routes do not poll private workspace APIs. No dependency or backend
contract change was needed.

## Browser evidence

Disposable loopback fixtures use synthetic credentials and injected/local model
responses. No real provider calls or production mutations were used.

Configured empty chat transcript heights: 320x568: 341.5px; 390x844: 617.5px;
430x932: 705.5px; 768x1024: 789.5px; 1024x768: 533.5px; 1280x800: 565.5px;
1440x900: 665.5px. The desktop transcript uses 78% of its 852px work area.
The equivalent missing-provider 320x568 baseline was 2.5px; new layout is 291.8px.
Do not compare configured fixture numbers to missing-provider baseline as a pure
CSS percentage improvement.

At 320x568 a 14-line draft keeps Send at y510..554. Composer client and scroll
height both 239px, so the form does not need nested scrolling. Missing-provider
landscape 844x390 keeps Send at y326..370. Long URL content has no horizontal
page overflow. All nine secondary routes were checked at 320px in English;
Czech chat/overview were checked across the viewport matrix. This is not an
exhaustive route/theme/locale/state cross-product.

Dialog Escape restores focus to the opener. Documents/context closes settings
before opening the inspector. Local model fixture sends a real tool request,
completes a workspace document write and exposes its history. Public demo fixture
checks rejected-request draft preservation, retry, Markdown table/code rendering
and Documents/menu access at 320, 390 and 1440 widths.

Stable screenshot evidence lives in the session artifact `visual-audit` directory:
`final-{chat|overview}-{320|390|1440}-{dark|light}.png`, long-draft, missing-provider
and demo captures. Exact CDP device metrics were used. Early CLI-cropped mobile
screenshots are invalid and superseded. Reduced-motion captures were used to
avoid screenshots during entry animations.

## Automated and native evidence

Latest UI source tests: 51 passed; final UI typecheck passed. These are narrow contract regressions, not
mounted React or accessibility certification. Desktop runtime test passed.
Production cloud build and final macOS .app/.dmg packaging passed.
The final packaged desktop and mobile-sized WKWebView smoke tests passed again.
Repository `pnpm run check` passed: 1207 workspace tests, cloud49 passed with
4 unchanged optional skips. The final UI-only relocation was additionally checked
with fresh typecheck, all51 UI tests, browser stress and rebuilt cloud/native assets.

Native macOS desktop and mobile-sized WKWebView smoke tests passed on the first
consolidated build: bundled runtime, real rendered WebView, toolbar/tool selection
and Blob export. These do not certify iOS, Android, Windows or a physical phone.
The macOS artifact is ad-hoc signed, not Apple notarized. A Git push does not
replace an installed desktop application.

## Explicit limits

Actual browser 200% zoom could not be activated reliably; 720x450 layout reflow is
only a proxy. Physical keyboard/safe areas and VoiceOver/TalkBack were not tested.
Real incremental provider streaming, rate limiting, recovery failures and live
pending approval are now driven in the browser run, and the four of them are
asserted from measured facts rather than from unit coverage: a streamed reply
read in the transcript while the run is still live, a 429 refused in the
composer with Send disabled and cleared by the next good reply, a held tool call
decided by one click in the browser, and a recovery that cannot apply rendered
as a conflict with the newer revision left byte for byte. A state that cannot be
driven is named in the output and recorded as a todo, never as a pass. Physical
keyboard, safe areas and VoiceOver/TalkBack were still not tested, and no claim
of universal flawless UI or full hardware certification is made.

## Final correction checks

After rebuilding, the explicit demo route issued only demo API requests, with
zero private requests and zero console errors/warnings on a successful send.
At 320px all composer actions meet 44px minimum width: settings44, command44,
attachment44, context44, model60.4 and send44. No page overflow. Screenshot
`final2-chat-320-dark.png` supersedes the earlier toolbar capture.

## Combined content stress

A synthetic DOM stress test exposed additive height from notices, attachments
and open tool details. These now share one bounded keyboard-scrollable region;
the input, Send and command palette remain outside it. The synthetic scenario
is layout evidence only, not a real pending-approval or recovery workflow test.
Synthetic IME composition plus Enter preserved the Japanese draft without
submitting. Physical IME remains unverified.

Final combined 320x568 stress retains 231.8px transcript (previous failed stress:
23.8px), with a shared 102.2px notices region. Send stays y510..554. Actual tool
selection via menu and actual 42-byte attachment upload/removal passed.

Latest built attachment removal target measured 44x44px and removed the uploaded
attachment on click. Both independent reviewers report no remaining confirmed
blocker in their tested scope.
