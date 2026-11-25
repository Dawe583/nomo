# NOMO TUI design contract

Read this before adding or changing a screen, rail, chip or pose. Every TUI
work node cites the rule it follows by its heading (for example "DESIGN.md:
slot ladder"). The rules describe the renderer in this directory; when code and
this page disagree, fix one of them in the same change. The renderer stays
hand-written (`docs/DECISIONS.md`, "Terminal component library: not adopted,
2026-11-25"): the frame string is the contract.

## Frame

- `renderWorkspace` returns exactly `rows` lines, each exactly `columns`
  cells wide. Cell width comes from `visibleLength` in `layout.ts`, never
  from `String.length`.
- Every output is cropped to the reported width and height. A row that would
  overflow is fitted, not wrapped by the terminal.
- The renderer never paints a terminal background (`48;` SGR). Colour is
  foreground only; the terminal canvas belongs to the user.

## Rails and widths

- A rail is a single row that starts with its left corner and ends with its
  right corner and is exactly its `width` in cells: `composerTopRail` and
  `composerBottomRail` at every width, the compact review rail at 40 columns.
- The Chat side rail (TODOs, subagents, run receipt) appears only at
  `CHAT_RAIL_MIN_WIDTH` x `CHAT_RAIL_MIN_HEIGHT` (100 x 20) and above, and only
  when it has something real to carry. Its width is 28 % of the frame, clamped
  to 24-34 cells.
- The watch frame stacks below 100 columns, sits side by side from 100 to 159
  and adds a third column at 160 and above (README "Responsive contract").

## Slot ladder

The composer top rail is `╭─ <label> <hint> <slots> ───╮`. The label and the
action hint are required; every other slot is optional and is added whole, in
priority order, only when it fits. A slot that does not fit is dropped whole and
the next, shorter slot is still considered. No slot is clipped mid-word, and no
optional slot may displace the hint or a review key. Empty slots spend no cells.
The order is `COMPOSER_SLOT_LADDER` in `workspace.ts`: queue > attachment >
model > context > pet dock. When the label and the hint do not fit together,
the label gives up whole trailing words (keeping its first) before the hint is
lost. There is no composer mode chip: the mode keeps its status-row pill
(`docs/DECISIONS.md`, "Composer slot ladder and no mode chip, 2026-11-25").

## Drop order

When a frame is short of cells or rows, drop in this order and never clip a
word:

1. decoration (gradient stops, sweep cell, pet bubble, splash);
2. optional rail slots, lowest priority first (slot ladder);
3. secondary facts (second hint clause, trailing status segments);
4. only then fit the remaining text with an ellipsis.

The hint keeps only its first clause at `COMPOSER_HINT_FULL_WIDTH` (56) columns
and below.

## The 40-column rule

At 40 x 12 every screen still shows its title, its primary fact and its
escape or action hint (`Enter send`, `Esc stop`, `Esc dismiss`, `/approvals`,
`y allow · n deny`). At 56 columns and below a hint keeps only its first clause
(`/approvals to review` becomes `/approvals`), so the review rail still reads
`Draft Review required /approvals`. The composer adds no row at 40 columns. The PTY
matrix in `scripts/src/verify-tui-terminal.py` covers 40x12, 80x24, 120x40,
160x45 and 200x48.

## Glyph presets

`NOMO_TUI_SYMBOLS` selects `unicode` (default), `ascii`, `classic` or `nerd`
from `SYMBOL_SETS` in `theme-config.ts`. Every glyph sits next to a text label.
The `ascii` preset is complete: frames use `+ - |`, the context meter uses `#`
and `-`, icons use bracketed letters such as `[Q]`. A new glyph needs a value
in every preset. Kitty graphics icons (Ghostty only) replace a glyph, never the
label.

## Tone vocabulary

Tones are the keys of `ColorPalette` (`Tone` in `theme.ts`): `fg`, `user`,
`accent`, `muted`, `border`, `success`, `warning`, `error`, `info`, `r0`-`r3`,
`ink`, `rule`. Use them by meaning:

- `muted` idle chrome; `accent` focus; `warning` waits on a human;
  `error` a failure the transcript shows; `success` a verified result;
  `info` the local mode.
- Reversibility classes use `r0`-`r3` and always print `[0]`-`[3]`.
- The composer rail tone is decided by `composerRailTone` from real state:
  approval > failed run > focus > idle.

Truecolour may use a quantised gradient (at most 12 stops per row); 256 and 16
colour terminals use one flat tone; monochrome, `NO_COLOR` and
`NOMO_TUI_COLOR=0` print the plain string.

## Colour is never the only carrier

Every fact a frame prints is a string. A monochrome terminal, the ASCII preset
and a frozen motion frame carry the same words as truecolour, Unicode and
animated frames (`a11y.test.ts`). Allow, hold and deny print `[+]`, `[!]` and
`[x]`; a safety state is never distinguished by colour or icon alone; a chip's
meaning is in its text.

## Borders

- Box drawing uses joined corners and one unbroken border at every width.
- The Chat transcript has no outer frame. The composer frame is configurable:
  `rounded` (default), `square` or `double`; a saved `filled` maps to
  `rounded`. ASCII terminals use square `+` corners.
- Other screens open as full-screen framed panels; Escape returns to Chat.

## Motion budget

- One motion frame per 100 ms at most (the runner's motion timer). An idle,
  settled or hidden pet does not repaint; the idle pet steps at 4 fps.
- Every effect is a pure function of the frame counter, so equal counters give
  equal bytes.
- `NOMO_TUI_MOTION=0` and `TERM=dumb` disable motion; reduced motion holds the
  first frame instead of hiding the state. The focus sweep lasts
  `COMPOSER_SWEEP_FRAMES` (6) frames; the streaming cell moves every
  `COMPOSER_STREAM_FRAMES` (8) frames.
- Motion changes a glyph as well as a colour, or carries no meaning at all.

## Pet grid

- NIB is `PET_WIDTH` x `PET_HEIGHT` (9 x 5) cells in every pose and preset; a
  perch needs 6 rows (sprite plus caption).
- The dock caption starts with `▦` and needs at least 9 cells; the bubble needs
  20 columns and 16 rows and is never drawn while an approval or review owns
  the keyboard; the splash needs 30 columns.
- A pose or reaction reads only the pet state, the frame counter and real tool
  or provider names, never a clock, so the pet cannot claim activity the run
  did not report. The pet never adds a row the frame did not reserve.

## Verification

- Unit and snapshot: `node --test --test-concurrency=1 packages/cli/src/tui/*.test.ts`
  (`NOMO_UPDATE_SNAPSHOTS=1` accepts only reviewed frames).
- Real terminal: `python3 scripts/src/verify-tui-terminal.py`.
- Typecheck: `pnpm --filter @nomo/cli typecheck`.
