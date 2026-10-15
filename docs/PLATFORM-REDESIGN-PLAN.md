# Platform redesign plan: iOS, macOS and web

Status: plan, 2026-09-28. The appearance it implements is defined in
`APPLE-DESIGN-SYSTEM.md`. The sequence it sits in is `ROADMAP-2026-Q4.md`.

## The decision this plan implements

Recorded by the user on 2026-09-28, and superseding the 2026-09-24 answer in
`DECISIONS.md`:

1. Every Apple-platform surface and the web control plane take the system look.
   The warm paper palette, the `Inter` interface face and the custom orange
   accent leave the platform surfaces.
2. macOS gets a SwiftUI target in the same Xcode project as iOS, sharing one
   codebase and one design system, instead of continuing to be a Tauri window
   around a Node sidecar.
3. The terminal is not touched by this work at all. Its ASCII identity, its
   colours and its key bindings are out of scope and must not be migrated toward
   the platform look.

Point 2 reverses a recorded decision, so it is written into `DECISIONS.md` as a
dated amendment in phase 0 rather than only living in this plan. A decision that
contradicts the pack without amending the pack leaves the next reader with two
authorities and no way to tell which is current.

## What exists today

Read from the source on 2026-09-28, with paths, because the plan is only as good
as its starting line.

### iOS

| Fact | Where |
| --- | --- |
| One app target, twelve Swift files, four screens: entry and onboarding, activity list, conversation, settings | `apps/apple/NOMOApp` |
| A real design system already exists: colours, tones, metrics, fonts, state pill, notice, primary button | `apps/apple/NOMOApp/ChatTheme.swift` |
| The theme imports UIKit and builds colours through `Color(uiColor:)`, so it cannot compile for macOS as written | `apps/apple/NOMOApp/ChatTheme.swift` |
| The model is hardcoded read-only and offline: pairing unavailable, actions refused, sessions are two hardcoded placeholders | `apps/apple/NOMOApp/AppModel.swift` |
| The only shipping chat transport throws on every call; the one that returns a transcript is a debug fixture behind a launch argument | `apps/apple/NOMOApp/ChatModel.swift`, `apps/apple/NOMOApp/SampleChatTransport.swift` |
| Onboarding completion is not persisted, so every launch restarts at the entry screen | `apps/apple/NOMOApp/AppModel.swift` |
| Localisation is an `if language == "cs"` branch, not a resource catalog, although the build is told to emit string catalogs | `apps/apple/NOMOApp/AppCopy.swift`, `apps/apple/project.yml` |
| The project is iOS only, with Mac Catalyst explicitly disabled | `apps/apple/project.yml` |
| The generated Xcode project is committed and checked by a script | `apps/apple/NOMO.xcodeproj`, `pnpm apple:project:check` |
| No workflow in the repository builds or tests any Apple target | `.github/workflows/ci.yml` |

The protocol library beside it is in a different state: `CompanionProtocolKit`
is complete, tested with 58 host cases, and declares iOS as its only platform,
so a macOS client has a usable transport contract to build on but no declared
macOS support yet.

### Web

| Fact | Where |
| --- | --- |
| A hand-rolled React client with its own router; two independent shells, the workspace and a forked public demo | `apps/control-plane/ui/src/main.tsx`, `apps/control-plane/ui/src/demo.tsx` |
| Four hand-written stylesheets imported in a fixed order, with no build-time pipeline and no modules | `styles.css`, `ascii.css`, `mobile.css`, `chat.css` |
| Seventeen custom properties, all of them colour or shadow; no spacing token at all; fourteen distinct corner radii and about twenty-nine font sizes as literals | `apps/control-plane/ui/src/styles.css` |
| `ascii.css` and `mobile.css` load after `styles.css` at equal specificity, so they silently defeat five mobile rules including the composer height and the circular send button | `apps/control-plane/ui/src/ascii.css`, `apps/control-plane/ui/src/mobile.css` |
| Ten rendered class names have no rule in any stylesheet, and the welcome emblem and the wordmark are dead weight | `apps/control-plane/ui/src/styles.css`, `apps/control-plane/ui/src/brand.tsx` |
| A display serif is imported and then overridden everywhere, so it never renders | `apps/control-plane/ui/src/ascii.css` |
| Nineteen tests assert markup and CSS by reading the source text and matching regular expressions, which cannot see a cascade conflict | `apps/control-plane/ui/src/compact-layout.test.ts` |
| Accessibility infrastructure is genuinely good: a native dialog with a tab trap and focus restore, an inert overlay, a skip link, viewport handling, reduced motion | `apps/control-plane/ui/src/main.tsx`, `apps/control-plane/ui/src/ui.tsx` |
| Documentation claims about mobile and accessibility are browser-viewport claims, with hardware keyboards, safe areas and screen readers explicitly untested | `docs/MOBILE-LAYOUT-QA.md`, `docs/MOBILE-ACCESSIBILITY-ACCEPTANCE.md` |

### The rules that currently conflict

Three visual directions are stacked in `docs/GUI-RULES.md` by date with no
token-level resolution: a 2026-09-23 neutral direction naming `Inter`, a
2026-09-11 paper direction naming a burnt orange, and an undated note pointing
at the stylesheet. `docs/STANDARDS.md` separately requires monospace for every
label and value, which the same file forbids. `docs/GUI-RULES.md` also still
carries a default model provider that `DECISIONS.md` removed.

Phase 0 resolves this by replacing the file with a pointer to
`APPLE-DESIGN-SYSTEM.md`, not by adding a fourth direction.

## Phase 0: the substrate

Nothing is built until the record stops contradicting itself, because a redesign
built on a document with three directions produces three redesigns.

| Task | Acceptance |
| --- | --- |
| Amend `DECISIONS.md` with the 2026-09-28 platform decision, dated after the 2026-09-24 answer it replaces | `node --test scripts/src/doc-truth.test.mjs` passes and the amendment is the last dated section in the file |
| Replace `docs/GUI-RULES.md` with a short pointer to the design system and the rules that survive it | the same test passes; the file no longer names a colour or a font |
| Correct the monospace contradiction in `docs/STANDARDS.md` to the narrower rule the GUI file already states | the standards test passes and both files agree |
| Record the macOS target as superseding the Tauri-only answer, and say what stays: the Tauri shell keeps the Node sidecar for the desktop distribution, the SwiftUI app is the paired client | the decision is in the pack, not only in this plan |
| Extend the Apple project check to a macOS target once it exists | `pnpm apple:project:check` fails when `project.yml` and the generated project disagree |

## Phase 1: one token source, three platforms

The mistake to avoid is writing the palette three times and letting them drift.
The tokens live once, in a machine-readable file in this repository, and each
platform consumes it.

| Task | Acceptance |
| --- | --- |
| One token document with the type ramp, the spacing rhythm, the semantic colour roles, the radii and the control sizes, taken from the guideline tables | a test asserts the token file has no colour literal outside the palette and no spacing value outside the rhythm |
| A Swift package under `apps/apple/` that exposes the tokens through the platform's own semantic types, with no UIKit import | the package builds for iOS and macOS; `swift test` runs on the host |
| A generator that writes the web custom properties from the same document | `node scripts/src/build-web.mjs` regenerates them and `git diff` is empty on a second run |
| The web keeps three token files and no more, as `STANDARDS.md` already requires | the existing design token test passes unchanged |

The existing `ChatTheme.swift` is the reference implementation of the shape:
semantic roles, a measured contrast note next to each non-system colour, and no
literal in a view. What it gets wrong for the new target is the UIKit
dependency and the two hand-picked colours, which the system palette replaces.

## Phase 2: iOS alignment

| Task | Acceptance |
| --- | --- |
| Replace the hand-picked muted text and accent with system roles and the accent colour, keeping the measured ratios as a comment where a measurement still exists | `xcodebuild test` on the existing `NOMOUITests`, which re-measures rendered pixels in both appearances, stays green |
| Move the token module out of `ChatTheme.swift` into the shared package and leave that file as the chat's use of it | the app target no longer imports UIKit in the theme |
| Replace the hand-drawn cards in the entry and settings screens with lists and sections, so selection and disclosure follow the platform | a VoiceOver pass reaches every control by name and the entry screen is reachable in one swipe per section |
| Persist onboarding completion | a relaunch after completing onboarding lands on the activity list, and `NOMOUITests` asserts it |
| Move the Czech and English strings into a string catalog | the app builds with the catalog present, and no source file contains an `if language` branch |
| Add the inspector column on iPad, using the split view the app already has | the detail column is not the phone layout stretched; a screenshot at two widths shows the difference |
| Add a keyboard shortcut for the primary action and verify the one already in the code is reachable | the existing shortcut still fires, and the test names it |

The hardcoded read-only model is not a design problem and this phase does not
change it. The app says what it is, and it says it correctly. Giving it write
scope is a separate, already-decided question that stays answered.

## Phase 3: the macOS target

This is the largest single piece and the reason the plan exists.

| Task | Acceptance |
| --- | --- |
| Add a macOS application target to `apps/apple/project.yml` with its own bundle identifier and no Catalyst | `pnpm apple:project:check` is green and the generated project contains both targets |
| Add macOS to the platform list in the package manifest of `CompanionProtocolKit` | the package builds for macOS and the existing 58 cases still pass on the host |
| Give the macOS target a window with a sidebar and a toolbar instead of a navigation stack | the app launches, the sidebar persists selection, and resizing below the sidebar width adapts rather than clips |
| Compile the chat surface for macOS, which means the theme package must not import UIKit | `xcodebuild -scheme NOMO -destination 'platform=macOS' build` succeeds |
| Support the pointer, the keyboard and the menu bar: every action reachable, every shortcut in the menu, the main menu carrying the app's verbs | a keyboard-only pass reaches approval, undo and export without a pointer |
| Keep the mobile-only affordances out: no bottom tab bar, no touch-only gestures, and every gesture has a menu or button equivalent | the gesture audit in the design system acceptance passes on macOS |
| Decide what the macOS app does about the executor | either it pairs to a paired Mac's executor over the local network like the phone does, or it is stated as a read-only client. It cannot be left implicit |

The last row is the honest one. A macOS app with a sidebar and no content is a
shell, and shipping it as if it were a client would repeat the mistake the
documents already criticise elsewhere. If the paired-client role is not ready,
the app says so on launch, in the same words the iOS entry screen uses.

## Phase 4: the web rebuild

The web is where the largest amount of hand-written surface is, and where the
current cascade actively fights the design system.

| Task | Acceptance |
| --- | --- |
| One stylesheet per concern with no override layer: delete the override relationship between `styles.css`, `ascii.css` and `mobile.css` by folding their rules into the file that owns the concern | the five currently defeated mobile rules apply; a viewport test asserts the composer height, the top bar height and the send button shape at 320, 390, 768 and 1440 pixels |
| Replace the seventeen colour and shadow properties with the generated semantic tokens, and delete every colour literal outside the token file | the existing design token test passes and a new assertion fails on any literal in a component rule |
| Introduce the spacing, radius and type scales as tokens, and remove the fourteen radii and twenty-nine font sizes as literals | a test counts the remaining literals and requires one per role |
| Adopt the platform appearance, contrast, motion and transparency preferences, and remove the in-app appearance toggle | a screenshot at both appearances with the contrast preference on shows no surface disappearing |
| Rebuild navigation as one structure that is a sidebar on wide viewports and a tab bar on narrow ones, with the same destinations in both | a test walks every destination from both presentations |
| Give the public demo the same components as the workspace instead of being a second shell | the demo has no private shell markup of its own |
| Remove the ten class names that have no rule, and the dead wordmark | a test parses the rendered class names and fails on one without a rule |
| Replace the nineteen source-text regular-expression tests with assertions against the rendered result | the test count drops and the coverage claim changes accordingly; the source-text tests are deleted, not kept |

The last row is deliberate. A test that reads CSS and matches a regular
expression asserts that a string still appears, not that a person can read the
result. The compact layout contract in those tests is real and is preserved,
expressed as measurements on the rendered element.

## Phase 5: acceptance and evidence

| Task | Acceptance |
| --- | --- |
| Run the full accessibility gate from the design system on all three surfaces and record the result | a table of the ten gates, each with a command or a recorded run whose output was read |
| Add Apple builds to CI, including the host-side package tests and a simulator run for iOS | the workflow file exists, is green on a pushed commit, and the matrix row stops saying the Apple results rest on console-log scraping |
| Add visual regression at three widths and both appearances | a diff that changes the design system in a way nobody intended fails the build |
| Re-measure the web's contrast in both appearances, the way the iOS suite already measures its own | the measured ratios are in the test output, not in a comment |
| Update the mobile and accessibility documents to say what was actually tested on hardware | `docs/MOBILE-LAYOUT-QA.md` and `docs/MOBILE-ACCESSIBILITY-ACCEPTANCE.md` no longer describe a browser viewport as a device |

## Sequence and size

| Phase | Depends on | Rough size | What it proves |
| --- | --- | --- | --- |
| 0 substrate | nothing | small | the record stops contradicting itself |
| 1 tokens | 0 | small | one source for three platforms |
| 2 iOS | 1 | medium | the design system works on the platform it already runs on |
| 3 macOS | 1, 2 | large | the second platform exists and is not a stretched phone |
| 4 web | 1 | large | the web stops fighting its own stylesheet |
| 5 acceptance | 2, 3, 4 | medium | the claims are evidenced rather than asserted |

The unit of work is the session the repository already uses: two to four hours,
three a week. Phase 3 alone is roughly twenty sessions, and saying otherwise
would be the kind of estimate this repository has already been burned by.

Phases 2, 3 and 4 touch different files and can be interleaved once phase 1
lands. They must not be merged into one change: the review cost of a
cross-platform visual change is already high, and bundling three of them makes
it unreviewable.

## What this plan does not do

- It does not change the terminal.
- It does not give the phone or the Mac write scope. That is answered elsewhere
  and stays answered.
- It does not touch the recovery engine, the ledger, the policy engine or the
  proxy. None of them have a user interface.
- It does not pursue the Mac App Store, notarisation, TestFlight or an external
  beta. Those are distribution questions with their own external gates.
- It does not migrate the data model, the storage format or any wire format.
  The companion protocol stays frozen at `void.companion.v1`; adding a macOS
  client is not a reason to revise it.
