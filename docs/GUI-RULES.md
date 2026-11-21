# NOMO GUI design rules

Status: pointer, 2026-09-29. The appearance contract is
`APPLE-DESIGN-SYSTEM.md`, its values are generated from `design-tokens.json`,
and the web GUI work is sequenced in `GUI-UPGRADE-PLAN.md`;
`PLATFORM-REDESIGN-PLAN.md` is superseded since 2026-11-21. This file names no
colour, no font and no provider on purpose: it stacked three directions that
restated values with a home already. They were a neutral direction dated
2026-09-23, a paper palette direction dated 2026-09-11 with an external
Apple reference, and a 2026-09-11 refinement naming three self-hosted web
fonts. A default model provider sat here too, until `DECISIONS.md` removed it on
2026-09-26. Nothing is archived; both named files carry the dates.

## Structure

- The shared React application lives in `apps/control-plane/ui` and Vite
  emits `dist/web`. The retained `apps/control-plane/web` source is a
  compatibility reference, not a starting point.
- Chat is the primary workspace. The composer form sits outside the bounded,
  keyboard-scrollable transcript, so the viewport never scrolls to reach
  Send. Context compaction stays mounted in the transcript, so closing a
  dialog cannot reset a pending mutation.
- Use the shared shell and the named routes, and keep panels bounded.
- Dialogs are native modal dialogs; they restore focus after closing or
  replacing controls, and a background surface takes no input behind an overlay.

## Content and boundaries

- Reuse `DataTable`, `Dialog`, `ErrorBox` and the query client. Lists filter on
  the server, and the displayed page survives newer data arriving.
- A completed assistant message replaces its streamed fragments. Merge
  tool cards by call ID, keep arguments and results, and never execute a
  partial call. Render Markdown through the parser with raw HTML disabled;
  model and connector output is untrusted.
- A document edit requires the displayed revision. A conflict preserves
  unsaved content, and Undo takes a fresh preview that updates the editor
  revision.
- Distinguish signed, verified, unavailable and unknown. A catalog entry
  that says free is not evidence of a zero invoice, and no limit or metric is
  invented.
- There is no default model provider: the product asks on first use, and
  credentials stay server-side behind the authenticated HttpOnly session.
- A fresh browser gets English, with Czech offered from the header and
  Settings, and a stored preference is respected. Dates and numbers follow
  the active locale.
- The terminal is out of scope and keeps its own identity: nothing may pull
  it toward the platform look.
- The only approved logo is the aperture mark in
  `apps/control-plane/ui/src/brand.tsx`; preserve its exact SVG geometry,
  use no ASCII or letter-tile substitute, and treat the rule as provenance
  rather than a direction.

## Validation

Run `pnpm run typecheck`, `pnpm test`, `pnpm build:web` and the relevant
browser flow, and `pnpm desktop:test` for a shared runtime change. Check the
320 px layout, the desktop layout, keyboard controls and long content.
