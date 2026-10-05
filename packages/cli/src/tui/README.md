# VOID terminal interface

The terminal interface has three surfaces because they solve different problems.

1. `renderInlineCall` writes one append-only line into the terminal shared with
   the wrapped agent. It never moves the cursor and it remains readable when
   piped.
2. `renderWatchFrame` owns the alternate screen in a second terminal. It shows
   the live write path, the selected decision record, measured risk, service
   health and the verified ledger head.
3. `renderHoldPrompt` temporarily owns the shared terminal only while a blocking
   hold guarantees that the wrapped agent is waiting. It shows the information
   required for a decision and accepts one explicit keypress.

The renderers accept data. They do not fetch, classify, approve, replay or
verify anything themselves. Those actions remain in the packages that own the
domain behaviour.

## Visual contract

The workspace frame uses box drawing with joined corners, one unbroken border
at every width. Tabs, modes and status carry single cell icons, always next to
a text label. Colour follows the site palette, but it is redundant information:

| class | marker | truecolour |
| ----- | ------ | ---------- |
| R0    | `[0]`  | `#5cc094`  |
| R1    | `[1]`  | `#2997ff`  |
| R2    | `[2]`  | `#dcbc63`  |
| R3    | `[3]`  | `#f47a88`  |

Allow, hold and deny additionally carry `[+]`, `[!]` and `[x]`. No safety state
may be distinguished only by colour or by an icon. The prompt box border is
mode aware (normal, accept, plan) and always states the mode in text.

The memorable visual element is the accountable write-path line:

```text
# intent -> # classify -> # decide -> . seal
```

It answers the operator's first question during latency or failure: where is
this call right now?

## Responsive contract

- Below 100 columns, activity and detail stack vertically.
- From 100 to 159 columns, activity and the decision record sit side by side.
- At 160 columns and above, risk and health signals become a third column.
- Every output is cropped to the reported terminal width and height.
- Tool ids truncate from the left, preserving the resource and action suffix.

## Capability contract

`detectCapabilities` is the only module that reads TTY and environment state.
Piped output, `TERM=dumb`, `CI` and `NO_COLOR` contain no escape sequences.
Interactive output selects truecolour, 256 colour or 16 colour once and passes
the result into every renderer.

## TUIStudio source

The editable source designs live in `packages/cli/design/`:

- `void-operations.tui`, the 120 by 40 operations screen
- `void-hold.tui`, the 76 by 18 human decision modal

TUIStudio export is still an alpha feature, so the production renderer is
maintained here rather than generated. The `.tui` files are the visual source
of truth and remain loadable in TUIStudio for layout work.

## Preview

```sh
pnpm --filter @void/cli run tui:preview -- 80 40
pnpm --filter @void/cli run tui:preview -- 120 40 --hold
pnpm --filter @void/cli run tui:preview -- 200 48 --modal
node scripts/tui-capture.mjs --cols 80 --cols 120 --cols 200
node scripts/tui-degrade.mjs
node scripts/tui-raw-mode-safety.mjs
```

Preview fixtures contain no payloads or credentials. Production call arguments
must never enter this render model.

## Known limitation

WP-09b's fourth exit criterion, `node scripts/moment.mjs --tui`, cannot run
yet: it needs the WP-05 hold path and the WP-08 blast radius. What will prove
it is the WP-05 moment resolved with one keypress in the terminal the agent
already runs in. Until then the render model is proven by the scripts above.

## Live ledger watch

`node packages/cli/bin/void.mjs watch --workspace default` now runs a real,
read-only ledger view. `--ledger /path/to/file.jsonl` selects a file directly;
`--once` prints a snapshot. Piped, CI, dumb and NO_COLOR output also uses a
plain snapshot without terminal control sequences. The watch authenticates
records with the same configured development signer as the proxy.

Keys: j/k or arrows select; Enter opens the record; Escape returns; f cycles
class filters; p pauses display updates; v refreshes verification; ? opens help;
q exits. Exiting leaves the proxy running. The live watch does not offer approval
or replay shortcuts until those actions are actually connected. Existing preview
renderers remain available for the richer planned dashboard.

## Workspace keys

The workspace prompt follows the reference terminal: Enter sends; Shift+Enter,
Alt+Enter, Ctrl+J or backslash+Enter inserts a newline; Esc stops a run; Esc Esc
clears input or opens checkpoints when empty; Shift+Tab or Alt+M cycles modes;
Ctrl+R searches history; Ctrl+O toggles tool output; Ctrl+L redraws, twice
clears; Ctrl+S stashes input; Ctrl+G opens the editor; Meta+P opens models;
Ctrl+C clears, cancels or exits; Ctrl+D exits from empty input. Ctrl+B
background tasks, image paste, suspend and Vim editing have no VOID equivalent.
`/conformance [adapter]` runs the disposable adapter checks behind the TUI.
`/providers` lists model providers including local open models.
`/harness cloud|prime-agent` switches the agent harness; detection reads
PATH only and never executes anything.
`/settings` lists every harness limit with the value in force and the range it
may be set within; `/settings key value` sets one. The table is generated from
`packages/workbench/src/harness-settings.ts`, so a limit without a declared
consumer cannot appear here.

### Aperture identity

The GUI header uses the exact SVG paths and viewBox from `Dawe583/void-empty`, `artifacts/void/src/components/site/shell.tsx` (Brand). The PWA icon copies `artifacts/void/public/void-aperture-mark.svg`. `brand.ts` rasterizes those same brackets, square, and center dot into terminal half blocks, with an orange inner square when color is available. The mark remains monochrome with NO_COLOR and in redirected output.
