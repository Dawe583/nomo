# VOID GUI design rules

Rewritten 2026-09-28. The approved direction is the system look defined in
`docs/APPLE-DESIGN-SYSTEM.md`, and this file holds no value of its own. Every
colour, size, radius and duration is read from there or from the token source,
so a change to the direction lands in one document instead of in a stack of
dated ones.

It was rewritten because it held three visual directions at once, stacked by
date with no resolution: one naming a specific interface face, one naming a
specific accent, and an undated note deferring to the stylesheet. It also
required a monospaced face for every label, value, caption and status word,
which the interfaces do not use. Those directions now live in the design
system, and what survives is here.

## Where the values live

- `scripts/design/tokens.json` is the single source of the token values, and
  `scripts/src/build-design-tokens.mjs` writes it into
  `apps/control-plane/ui/src/styles.css` and
  `apps/apple/VOIDApp/VoidDesignTokens.swift`. Neither generated file is hand
  edited.
- `scripts/src/design-tokens-source.test.mjs` fails the build when a generated
  block drifts from the source or a colour pair stops clearing the contrast
  minimum. `scripts/src/design-token.test.mjs` fails it when a component grows
  a colour literal.
- A value that does not exist yet is added to the token source. Not to a
  stylesheet, not to the Swift file, and never to a component.

## What a surface may do

- Take its form from the platform and its vocabulary from VOID. A reversibility
  class, a policy decision, a consent state and a run state are the same words
  on every surface, and they are the words the terminal already uses.
- Keep the transcript the primary workspace, with the composer outside the
  bounded status region, so Send is reachable without scrolling the page.
  Secondary controls live in Conversation settings, while the current
  permission source and critical failures stay visible. Context compaction
  stays mounted in the transcript, so closing a dialog cannot discard a
  pending change.
- Reuse the shared components in `apps/control-plane/ui/src/ui.tsx`, which are
  `DataTable`, `Dialog` and `ErrorBox`, along with the shared query client, the
  shell and its named routes. Lists filter on the server, and newer data never
  silently replaces the page a person is reading: it offers Refresh.
- Render model and connector output through the Markdown parser with raw HTML
  disabled, and treat all of it as untrusted. Syntax highlighting loads on
  demand. A completed assistant message replaces the fragments it streamed in,
  tool cards merge by call id with arguments and results intact, and a partial
  call is never executed.
- Preserve unsaved content when a document edit conflicts. The edit carries the
  revision it was read at, and an undo asks the server for a fresh preview
  before it changes anything.
- Say which of signed, verified, unavailable and unknown applies. A catalogue
  entry named Free is not evidence of a zero invoice, and no limit or metric
  is invented to fill a gap.
- Follow the platform for language. A fresh browser starts in English and
  Czech stays available; dates and numbers follow the active locale, while API
  names, model names and conversation content are left as they are.
- Ship the brand mark from `apps/control-plane/ui/src/brand.tsx` and nothing
  else. A letter tile, an ASCII stand-in or a new symbol is not a substitute.

## What a surface may not do

- Name a colour. A component refers to a token, and a component that needs a
  colour the tokens do not carry is asking for a new token, not a literal.
- Carry a state in colour alone. The colour tints the word; the word carries
  the meaning.
- Offer an in-app appearance switch. Appearance belongs to the platform
  setting, and a surface follows it.
- Zoom, scale, or set the whole application in a monospaced face. A
  monospaced face is for code, identifiers and short technical values.
- Shrink a desktop canvas to fit a phone, and never shrink a touch target or
  the input text to save space on a small one. Mobile reduces chrome and
  spacing; target size and input text do not follow it down.
- Hide a failure, a permission source or an unknown to keep a screen tidy.
  Density is never a reason to remove a truth.
- Offer a hover-only affordance. Anything reachable by pointer is reachable by
  keyboard and by touch.
- Let motion be the only signal that something changed, or animate at all when
  the platform asks for reduced motion.

## The terminal is out of scope

The terminal keeps its own language on purpose. It is a different medium with
its own ergonomics, and looking at home in a terminal is not the same question
as looking at home on a Mac. Its ASCII identity, its colours and its key
bindings are outside this work: nothing here migrates it toward the platform
look, and nothing here pulls the platform surfaces back toward ASCII chrome.
Where the surfaces meet, they share vocabulary, not appearance.
