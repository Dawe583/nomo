# Apple-aligned design system for NOMO

Status: contract, 2026-09-28. Approved direction, decided by the user on
2026-09-28: the visual language of every Apple-platform surface and of the web
control plane becomes the system look, and the macOS client becomes a SwiftUI
target in the same project as iOS. The terminal is explicitly out of scope.

This document is the visual and behavioural contract. `PLATFORM-REDESIGN-PLAN.md`
is the work that implements it, and `ROADMAP-2026-Q4.md` is where the work sits
in the wider product sequence. Where this document and those two disagree, this
document defines the appearance and those two define the order.

## Scope

| Surface | In scope | Notes |
| --- | --- | --- |
| iOS app | yes | `apps/apple/NOMOApp`, currently four screens, iOS 17 |
| macOS app | yes | new SwiftUI target in the same Xcode project, does not exist today |
| Web control plane | yes | `apps/control-plane/ui/src`, four hand-written stylesheets |
| Desktop shell (Tauri) | chrome only | the window, menu and update surface follow the same tokens; the web view carries the rest |
| Terminal (TUI) | **no** | the ASCII identity is deliberate and the user excluded it from this work |

The terminal keeps its own language on purpose. It is a different medium with
its own ergonomics, and "looks at home in a terminal" is not the same question as
"looks at home on a Mac". Nothing here may pull the terminal toward the platform
look, and nothing here may pull the platform surfaces back toward ASCII chrome.

## Where the numbers come from

Every value in this document is quoted from Apple's Human Interface Guidelines
so that a reviewer can check it rather than trust it. The guidelines are a
client-rendered application, so the same content is read from the documentation
service the site itself uses:

```
https://developer.apple.com/tutorials/data/design/human-interface-guidelines/<slug>.json
```

`<slug>` is the page name: `typography`, `layout`, `color`, `accessibility`,
`materials`, `dark-mode`, `tab-bars`, `sidebars`, `lists-and-tables`, `modality`,
`feedback`, `loading`, `onboarding`, `gestures`, `entering-data`, `windows`,
`design-principles`. The rendered pages are at
`https://developer.apple.com/design/human-interface-guidelines/<slug>`, and the
adoption guide for the current material system is
`https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass`.

## Foundations

### Type

Dynamic Type is the system, not an option. The guideline's minimum legible body
size for iOS and iPadOS is 17 points with 11 as the floor, and macOS is 13 with
10. NOMO uses semantic roles only, so the whole surface scales when a person
changes the text size.

iOS and iPadOS built-in styles, from the guideline's type table:

| Role | Weight | Size | Leading | Emphasised |
| --- | --- | ---: | ---: | --- |
| Large Title | Regular | 32 | 39 | Bold |
| Title 1 | Regular | 26 | 32 | Bold |
| Title 2 | Regular | 20 | 25 | Bold |
| Title 3 | Regular | 18 | 23 | Semibold |
| Headline | Semibold | 15 | 20 | Semibold |
| Body | Regular | 15 | 20 | Semibold |
| Callout | Regular | 14 | 19 | Semibold |
| Subhead | Regular | 13 | 18 | Semibold |
| Footnote | Regular | 12 | 16 | Semibold |
| Caption 1 | Regular | 11 | 13 | Semibold |
| Caption 2 | Regular | 11 | 13 | Semibold |

macOS built-in styles are one step tighter throughout: Large Title 31/38, Title 1
25/31, Title 2 19/24, Title 3 17/22, Headline 14/19, Body 14/19, Callout 13/18,
Subhead 12/16, Footnote 12/16, Caption 1 and 2 both 11/13. NOMO does not pick
one table for both platforms; it maps roles to the platform's own semantic font,
which is what makes the same screen feel native on each.

Web mapping. The web control plane must use the platform's UI font, resolved by
the platform rather than downloaded: `-apple-system` first on Apple platforms,
then `BlinkMacSystemFont`, then `Segoe UI`, then `system-ui`. A web font is
loaded only for code, identifiers and numeric columns, where a monospaced face
carries meaning rather than brand. This replaces the current hard-coded `Inter`
in `styles.css` and the `Instrument Serif` import that `ascii.css` already
overrides, so the serif never rendered at all.

### Colour

Colour is semantic or it does not exist. No component may name a colour. The
palette is the platform's:

| Role | iOS and iPadOS | macOS | Web |
| --- | --- | --- --- | --- |
| Canvas | `systemBackground` | `windowBackgroundColor` | `-apple-system` system background, light and dark |
| Surface | `secondarySystemBackground` | `underPageBackgroundColor` | secondary system background |
| Raised surface | `tertiarySystemBackground` | `controlBackgroundColor` | tertiary system background |
| Primary text | `label` | `labelColor` | `-apple-system` label colour |
| Secondary text | `secondaryLabel` | `secondaryLabelColor` | secondary label |
| Separator | `separator` | `separatorColor` | separator |
| Accent | accent colour, not a custom orange | `controlAccentColor` | `-apple-system` accent colour |

Contrast is a gate, not a preference. The guideline's WCAG-derived minimums are
4.5:1 for text up to 17 points, 3:1 at 18 points and above, and 3:1 for bold
text at any size. Every pairing the design system introduces is measured in both
appearances, and the measurement is a test, not a comment. The existing iOS
theme already does this: `ChatTheme.swift` records the measured ratios for its
muted text and accent, and `NOMOUITests` re-measures rendered pixels. That
practice moves to the web, where it does not exist yet.

Three colour rules that are not negotiable here:

- **No state is carried by colour alone.** A reversibility class, a policy
  decision, a connector consent state and a run state are always text first.
  Colour tints; the word carries the meaning. This is already true of the iOS
  `NomoStatePill` and stays true everywhere.
- **No app-specific appearance toggle.** The guideline calls this out directly:
  an in-app light and dark switch asks a person to configure two settings and
  makes a correct app look broken. The web control plane today switches on
  `:root[data-theme]`; that becomes `prefers-color-scheme` with a single
  explicit override the system already owns.
- **Increase Contrast and Reduce Transparency are tested settings, not edge
  cases.** Every colour pair and every material is checked in both appearances
  with both settings on separately and together.

NOMO drops its warm paper palette (`#f8f7f4` canvas, `#252420` ink, `#a93805`
accent) on the platform surfaces. That palette stays in the terminal, where it
was never a competing identity.

### Spacing and shape

A 4 point rhythm: 4, 8, 12, 16, 24, 32. The existing `NomoMetrics` already uses
it on iOS and the web has no spacing token at all today, which is why the same
concept appears at fourteen different radii and twenty-nine font sizes across
the stylesheets.

Two guideline constants apply outside the rhythm. Standard horizontal spacing
is 40 points, and the minimum vertical spacing between unrelated content groups
is 100 points. The transcript keeps a readable measure rather than running edge
to edge on a wide window; the guideline's unfocused content widths are 860, 560,
410, 320, 260, 217 and 184 points for the standard size classes, and NOMO picks
the one that fits the column rather than the platform.

Control hit targets are a floor, not a suggestion: 44 by 44 points on iOS and
iPadOS, 28 by 28 on macOS, and a 20 by 20 absolute minimum on macOS. The web
converts the same rule to 44 CSS pixels for touch, while keeping pointer targets
comfortable on a trackpad.

Corners are concentric with their container, which is what the current design
system's single 8 point radius cannot express. Cards, sheets, toolbars and
windows therefore each take the radius that matches the element that contains
them, following the guideline's guidance on shape continuity.

### Materials and layering

Two layers, kept apart, because that separation is the entire point of the
current material system:

- **The functional layer** is navigation and controls: tab bars, sidebars,
  toolbars, sheets, popovers, menus, and the buttons in them. Here the system
  material applies, and custom backgrounds are removed so the system's own
  behaviour (including the scroll edge effect that keeps content legible as it
  passes under a bar) is not fought.
- **The content layer** is everything a person reads: the transcript, lists,
  tables, documents, code. Here the standard materials apply for separation
  within the content, and the new dynamic material is explicitly avoided. The
  guideline is blunt about this: using it in the content layer produces
  complexity and a confused hierarchy.

The practical consequence for NOMO: adopting the current Apple look on the
platform surfaces is mostly a matter of *removing* custom chrome, not adding
glass. The web control plane's hand-drawn shadows on the composer, dialogs,
palette and floating controls are exactly the custom effects the adoption guide
says to drop, because the system bars already provide the separation.

Liquid Glass is adopted only where a standard component already provides it, and
never on a custom control unless the control is the app's single most important
one. There is no such control in NOMO today.

### Motion

Motion is feedback, never information. The existing 0.15 second interaction
duration stays, and it applies to interaction feedback only: a press, a state
change that is already stated in text, a sheet appearing. A duration must not be
the only signal that something changed, because Reduce Motion turns it off and
the meaning has to survive.

All motion respects the reduced-motion preference on every platform. The web
already has that wiring in three places and one place that violates its own
stated rule; the redesign has one gate instead of four.

## Components

### Navigation

Navigation is a distinct functional layer, clearly separated from content. That
is the guideline's first navigation rule and it is a structural change for the
web control plane, which today mixes its sidebar, top bar and work area into one
grid.

- **iOS and iPadOS**: a navigation split view with a sidebar; the sidebar
  adapts automatically on compact widths rather than being a tab bar that
  changes shape. The transcript is the primary column. On iPad the detail
  column becomes an inspector rather than a stretched phone layout.
- **macOS**: a window with a sidebar, a toolbar, and a content area. A single
  primary window, with auxiliary windows for anything that is a distinct task
  (a ledger record, a recovery plan) rather than a modal over the main one.
- **Web**: a sidebar on wide viewports, a tab bar on narrow ones, and the same
  contents in both. The guideline warns against an overflow "More" tab because
  it hides navigation, so the tab set is capped rather than allowed to spill.
- **Nothing becomes an action.** A tab bar navigates. An action on the current
  view belongs in a toolbar or a control, not in the navigation layer.

A tab bar stays visible while navigating; it is hidden only under a modal, which
is temporary and self-contained.

### Lists and tables

Ledger entries, runs, sessions, approvals and connectors are tabular data, and
the guideline's preference is text in a list or table over a grid of images or
custom cards. Selection gives persistent highlight when the row navigates, and
a brief highlight plus a checkmark when the row selects an option. Deletion and
reordering are allowed where they make sense, with a confirmation that names the
thing being removed.

### Modality

Modality is chosen by what the interaction is, not by convenience:

| Situation | Component | NOMO examples |
| --- | --- | --- |
| Critical information, and the app must not proceed without an answer | alert | a ledger verification failure, a sealed session that cannot be opened |
| A scoped task in front of the current context | sheet | reviewing a recovery plan, confirming a connector removal |
| A set of choices about the thing just acted on | action sheet or menu | Undo, retry, export |
| A small set of actions anchored to a control | popover or menu | the record actions in a ledger row |

Destructive and irreversible actions always name the object, the effect, and
what would be lost. "Delete" is never a button label on its own. Undo, where it
exists, is offered before the confirmation for everything that has an inverse.

### Feedback

Feedback matches significance to delivery. Status is passive and lives in the
interface. A warning that could cost data interrupts. A result that needs no
attention never uses an alert. Where the interface uses colour for status it
also uses text, and where it uses text it also carries the state in a
screen-reader-visible element.

Loading shows something immediately: placeholder structure at the measured size,
never a blank region, because blank reads as broken. The person can keep working
while a long operation runs, and an operation that cannot be cancelled shows its
state rather than blocking the surface.

### Empty and error states

An empty state names what would be here and the one action that creates it. An
error state says what failed, whether anything was changed, and what the person
can do next. Neither uses a generic message, and neither offers a retry that
cannot help.

## Accessibility acceptance

These are the gates. A phase is not done until each one is demonstrated by a
command whose output was read, or by a recorded run on hardware.

| Gate | Criterion | Where it is proven |
| --- | --- | --- |
| Text scaling | the interface remains usable at 200 percent text, with no clipped text and no overlapping controls | iOS and macOS: accessibility inspector run; web: 200 percent browser zoom plus the largest Dynamic Type equivalent |
| Minimum text | nothing renders below 11 points on iOS or 10 on macOS except a legal or code caption | a rendered-pixel test in the existing UI test suite |
| Contrast | 4.5:1 up to 17 points, 3:1 at 18 points or bold, in both appearances, with Increase Contrast on | the existing pixel measurement in `NOMOUITests`, extended to the web |
| Colour independence | every state, class and decision is readable with no colour at all | a greyscale render of each state |
| VoiceOver | every control has a name, every custom view is an accessibility element, the transcript navigates by message | a recorded VoiceOver pass on iOS and macOS |
| Keyboard | every action reachable on macOS and on the web, with a visible focus indicator at 3:1 against its background | a keyboard-only pass per surface |
| Hit targets | 44 by 44 on touch, 28 by 28 on macOS, no target smaller | an automated audit on the web, an inspector audit on Apple platforms |
| Reduce Motion | nothing conveys meaning through movement alone | the preference on, every flow walked |
| Reduce Transparency | every material-dependent surface stays legible | the preference on, both appearances |
| Reduced transparency and contrast together | no surface disappears | the combination pass |

## Platform mapping

| Concern | iOS | macOS | Web |
| --- | --- | --- | --- |
| Minimum hit target | 44 by 44 points | 28 by 28 points | 44 CSS pixels for touch |
| Body text default | 15 points (Body) | 13 points | 15 CSS pixels, 1.5 line height |
| Window or screen | full screen | resizable window with a minimum size | viewport, with the safe-area insets honoured |
| Navigation | split view with an adaptable sidebar | sidebar plus toolbar | sidebar, tab bar below the compact breakpoint |
| Appearance | system | system | `prefers-color-scheme` |
| Contrast setting | Increase Contrast | Increase Contrast | `prefers-contrast` |
| Motion setting | Reduce Motion | Reduce Motion | `prefers-reduced-motion` |
| Transparency setting | Reduce Transparency | Reduce Transparency | `prefers-reduced-transparency`, honoured in the material layer |
| Cursor | system default | pointer affordances are not load-bearing | no hover-only affordance, pointer where the platform shows one |
| Text entry | system keyboard, Dynamic Type | system keyboard, no Dynamic Type | the platform's own controls, no custom text input |

## What NOMO adds on top

The platform gives the form. NOMO gives the vocabulary, and the vocabulary does
not change with the platform:

- A reversibility class is r0, r1, r2 or r3, always written as text, never as a
  colour alone.
- A policy decision is allow, hold or deny, and a denial names the rule, the
  class, and what approval would require. A generic refusal is a defect.
- A connector consent state is staged, probed or confirmed, and only a confirmed
  connector contributes tools to a conversation.
- A run state is running, awaiting approval, stopped or unknown, and "unknown"
  is a real answer that the interface must be able to show.
- Code, identifiers, digests and ledger entries are monospaced. Nothing else is,
  except in the terminal, where everything is.

These are the same words the terminal uses. Consistency of vocabulary across the
surfaces is the one thing the redesign must not lose while it is gaining
consistency of form.

## Deliberately not adopted

- The new dynamic material on custom controls, or in the content layer.
- A web font for interface text.
- An in-app appearance switch on any surface.
- A second navigation pattern that is not an adaptation of the first, so the
  sidebar and the tab bar carry the same destinations.
- Colour literals in components, on any platform. A component that needs a new
  colour is a component that needs a new token.
- Any change to the terminal's visual language.
