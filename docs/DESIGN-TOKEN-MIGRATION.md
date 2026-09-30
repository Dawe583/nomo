# Design-source gate: closed

Written 2026-09-30 against `main` at `910a154`. This document records what the
three design-source gates in `scripts/src/design-source.test.mjs` found, and
what closing them actually required. It replaces the earlier version of this
file, which described the same debt as still open.

`apps/control-plane/ui/src/styles.css` was **unmodified at HEAD** when this was
measured. None of this was a regression; it was debt the gates correctly found
in code that predates them.

## The rule the whole thing rests on

Every conversion here maps a value to a token that **holds that same value**.
That is the only reason it was safe to do without a browser open:

- 52 `44px` / `28px` hit targets to `--control-touch` / `--control-macos`
- 59 corner radii to a role for each of their own pixel values
- six highlight.js colours to three roles carrying the same light and dark
  values
- three `rgba(18, 16, 10, 0.5)` scrims to a role holding that exact value
- one dead `var(--ink, #252420)` fallback removed

Nothing rounds, nothing approximates, nothing is a judgement about how a thing
should look. Where a judgement was needed, the answer was to **add the role the
stylesheet already implied**, and the additions are listed below with the
measurement that justified each one.

## Hit targets — 52

`44px` and `28px` restated in `min-height`, `min-width`, `width` and `height`,
restating values the document already publishes once as `control.touchPt` 44
and `control.macosPt` 28. Converted by `scripts/src/tokenise-hit-targets.py`,
which reads both numbers out of the document rather than restating them.
`--check` fails rather than writes, and a test asserts the tokens the
stylesheet reads are the ones the generator declares.

## Corner radii — 59, and the document grew seven roles

The document carried six roles. The stylesheet used fourteen distinct sizes.
Five mapped exactly; the rest did not, and **the honest answer was that the
document was behind the code**, not that the code was wrong.

| Value | Was | Role now | How often |
| ---: | --- | --- | ---: |
| 3px | none | `--radius-hairline` | 3 |
| 4px | `inline` | `--radius-inline` | 5 |
| 5px | none | `--radius-compact` | 18 |
| 6px | `control` | `--radius-control` | 4 |
| 7px | none | `--radius-chip` | 2 |
| 8px | none | `--radius-popover` | 6 |
| 9px, 10px | `card` (10) | `--radius-card` | 5 |
| 12px | `sheet` | `--radius-sheet` | 4 |
| 14px | none | `--radius-panel` | 3 |
| 18px | none | `--radius-drawer` | 1 |
| 20px | none | `--radius-overlay` | 2 |
| 22px | none | `--radius-full` | 1 |
| 24px | none | `--radius-sheetcap` | 1 |

Eighteen uses of 5px is a decision, not a rounding error. Six uses of 8px on
dialogs and popovers is a decision too. The `radii.note` in the document now
says so, which is the record that stops the next person from "tidying" it back
to a grid.

The 24px role is the one this table did not have, and it is there because of a
defect rather than a decision. The mobile dialog used 24px at HEAD and was
mapped to `--radius-full`, which is 22px, so the bottom sheet came back 2px
squarer than it had been, in the one document that promised no value had
changed. A 24px role holding 24px is the fix; moving `full` to 24px would have
been the wrong one, because three other surfaces already use it.

A shorthand is read corner by corner, so `0 var(--radius-overlay)
var(--radius-overlay) 0` is a square corner, two rounded ones and another square
one. The gate accepts that mix and requires each rounded part to be a token,
which is what makes a three-corner selection expressible without a role for it.

`50%` is not a role and never will be: it is a shape, not a size, and five rules
use it for circles and capsules.

## Syntax colours — 6 literals, 3 roles, and the measurement

These were highlight.js values the document had no role for. Reading them
changed the conclusion: they are **paired light and dark appearances of three
roles**, not six unrelated colours, which is exactly the shape `colour.roles`
already models.

| Role | Light | Dark |
| --- | --- | --- |
| `syntaxKeyword` | `#a63d0c` | `#ee985e` |
| `syntaxString` | `#356344` | `#a0c798` |
| `syntaxNumber` | `#75509a` | `#c4a9e2` |

All six already cleared the bar, measured against both surfaces in both
appearances before the roles were added:

| Role | light/canvas | light/surface | dark/canvas | dark/surface |
| --- | ---: | ---: | ---: | ---: |
| `syntaxKeyword` | 6.37 | 5.71 | 9.29 | 7.53 |
| `syntaxString` | 6.95 | 6.23 | 11.12 | 9.01 |
| `syntaxNumber` | 6.23 | 5.58 | 10.12 | 8.20 |

Every pair exceeds 4.5:1 comfortably and is comparable to `accent` (7.56) and
`danger` (5.38) on the same backgrounds, so nothing was tuned and nothing was
invented. Six contrast pairs were added — each role against canvas and against
surface — and the existing gate recomputes all of them.

On the Apple side the same three roles were added to the generated Swift module
and to `VoidPalette.platformColor`, where they resolve to `nil` for the same
reason `danger` and `good` do: there is no platform semantic colour for source
punctuation, and taking a default would silently undo a measurement.

## The scrim — 3 literals, 1 role, its own section

`rgba(18, 16, 10, 0.5)` appeared three times, and it is a full-bleed veil rather
than a drop shadow. The document's `colour.shadow` family is all
`0 <offset> <blur> rgb(0 0 0 / a)` drop shadows, and a scrim has neither an
offset nor a blur, so putting it there would have been a type error in a JSON
document. It has its own `colour.scrim` section and its own `--scrim-modal`
property.

The same value in both appearances is deliberate. A veil that darkens more in
dark mode removes the distinction between a dimmed surface and a black canvas.
Measured over the surfaces it covers, it leaves 3.56:1 against canvas and 3.48:1
against surface, which is why it reads as depth rather than as a line.

## One dead fallback removed

`color: var(--ink, #252420)` on `.command-palette`. `--ink` is emitted by the
generator in both appearances, so the fallback can never apply — and it was a
second copy of a colour the document already states, which is the last thing
the gate exists to refuse. Removed rather than tokenised, because a fallback for
a variable that always exists is not a fallback.

## What is not claimed

No browser was opened and no visual inspection was performed. The conversions
are provably value-preserving by construction, and the counts are measured from
the file, but nothing here is a claim about how the surface looks. A pixel of
difference is possible if a token's value ever stops matching the role it
replaced, and the hit-target test guards exactly that case.

## What a follow-up should check

The six contrast pairs are new measurements and the seven radius roles are new
precedent. Both are one browser session away from being confirmed visually, and
neither is one that changes a value.
