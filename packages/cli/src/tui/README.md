# NOMO terminal interface

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

The workspace uses the supplied NOMO logo image in terminals that support the
Kitty graphics protocol; other terminals get a NOMO text fallback. It keeps
the panel chrome inset at standard and wide sizes and never sets terminal
background colors. The default palette uses white text with coral and turquoise
accents. NOMO keeps its own controls and terminology.

Tabs, modes, and status pair symbols with text. Safety states never depend on
color alone:

| class | marker | truecolour |
| ----- | ------ | ---------- |
| R0    | `[0]`  | `#5cc094`  |
| R1    | `[1]`  | `#2997ff`  |
| R2    | `[2]`  | `#dcbc63`  |
| R3    | `[3]`  | `#f47a88`  |

Allow, hold, and deny additionally carry `[+]`, `[!]`, and `[x]`. The mode
remains named in the status row when color is disabled.

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
Piped output, `TERM=dumb` and `CI` contain no escape sequences. Setting
`NOMO_TUI_COLOR=0` disables color styling only; interactive terminal control
sequences remain. Interactive output ignores inherited `NO_COLOR` and selects
truecolour, 256 colour or 16 colour once for every renderer.

## TUIStudio source

The editable source designs live in `packages/cli/design/`:

- `nomo-operations.tui`, the 120 by 40 operations screen
- `nomo-hold.tui`, the 76 by 18 human decision modal

TUIStudio export is still an alpha feature, so the production renderer is
maintained here rather than generated. The `.tui` files are the visual source
of truth and remain loadable in TUIStudio for layout work.

## Preview

```sh
pnpm --filter @nomo/cli run tui:preview -- 80 40
pnpm --filter @nomo/cli run tui:preview -- 120 40 --hold
pnpm --filter @nomo/cli run tui:preview -- 200 48 --modal
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

`node packages/cli/bin/nomo.mjs watch --workspace default` now runs a real,
read-only ledger view. `--ledger /path/to/file.jsonl` selects a file directly;
`--once` prints a snapshot. Piped, CI, dumb and explicit
`NOMO_TUI_COLOR=0` output also uses a plain snapshot without terminal control
sequences. The watch authenticates records with the same configured development signer as the proxy.

Keys: j/k or arrows select; Enter opens the record; Escape returns; f cycles
class filters; p pauses display updates; v refreshes verification; ? opens help;
q exits. Exiting leaves the proxy running. The live watch does not offer approval
or replay shortcuts until those actions are actually connected. Existing preview
renderers remain available for the richer planned dashboard.

## Workspace keys

The workspace editor uses Prime Agent's sparse terminal-editor layout while
keeping NOMO's existing key behavior. Enter sends by default;
`/settings sendBehavior mod-enter` persists the choice to require Ctrl+Enter to
send, while Shift+Enter, Alt+Enter, Ctrl+J or a trailing backslash plus Enter
inserts a newline.
Esc stops a run; Esc Esc clears input or opens checkpoints when empty; Tab or
Left/Right cycles panels without losing a chat draft. Narrow terminal tabs show the selected panel and its
position; wider terminals show nearby panels. Shift+Tab or Alt+M cycles modes;
Ctrl+R searches history; Ctrl+O toggles tool output; Ctrl+L redraws, twice
clears; Ctrl+S stashes input; Ctrl+G opens the editor; Meta+P opens models;
Ctrl+C clears, cancels or exits; Ctrl+D exits from empty input. Ctrl+B
background tasks, image paste and suspend have no NOMO equivalent.

`NOMO_TUI_VIM=1` opts into modal composer editing; the default stays unchanged.
The composer starts in normal mode: `i`, `a`, `A`, and `I` enter insert mode;
`h/j/k/l`, `w/b`, `0`, and `$` move; `x` deletes forward; Enter sends. Escape
leaves insert mode, except an active run keeps the existing Escape-to-cancel
behavior.

### Configurable shortcuts

Set `NOMO_TUI_KEYBINDINGS` to a JSON object mapping any of `redraw`,
`toggle-tools`, `search-history`, `stash`, `external-editor`, and `show-todos`
to a `Ctrl+letter` binding. Example:

```sh
export NOMO_TUI_KEYBINDINGS='{"redraw":"Ctrl+V"}'
```

Unknown actions, malformed JSON, reserved keys, or conflicts reject the whole
override and keep the defaults; the TUI shows a notice. `/keybindings` lists
the active values. Confirmation, cancellation, quit, prompt editing, and
unmapped keys are not configurable. Vim composer support is opt-in as described
above and leaves the terminal lifecycle unchanged.

`/conformance [adapter]` runs the disposable adapter checks behind the TUI.
`/providers` lists model providers including local open models.
`/harness cloud|prime-agent` switches the agent harness; detection reads
PATH only and never executes anything.
`/verify` refreshes the signed ledger check. Its quick-view row shows the last
completion time in this TUI process only; the timestamp is not persisted.
`/settings` searches effective preferences and lists every harness limit with
the value in force. `/settings search TEXT` searches them, `/settings KEY VALUE`
sets a supported limit, and `/settings sendBehavior enter|mod-enter` persists the
composer behavior. Document and session tree leaves retain their source IDs;
Enter folds a selected folder or opens the highlighted record. Arrows scroll an
opened detail, or replace a live document preview with the next selection. The limits table is
generated from `packages/workbench/src/harness-settings.ts`, so a limit without
a declared consumer cannot appear here.

### Shortcut legend

The workspace renders a persistent shortcut legend above the borderless
editor surface. Every shortcut shows a single-cell icon, a key label, and an
action description. Icons are color coded by category: nav uses info, edit uses
warning, action uses accent, mode uses success, panel uses muted, approval uses
error.
The legend is context sensitive: it shows different hints while editing,
while a confirmation is showing, while a run is active, and while approvals are
pending. The legend respects `NOMO_TUI_COLOR=0` (monochrome) and
`NOMO_TUI_MOTION=0` (no animation).

Icon categories:

- nav (`⇥`): Tab switches panels, Enter opens, Esc goes back, arrows navigate
- edit (`✎`): Ctrl+R searches history, Ctrl+O toggles tool output, Ctrl+T
  toggles todos, Ctrl+J inserts a newline
- action (`⚡`): y accepts, n rejects, u undoes, `/queue` queues
- mode (`◆`): Shift+Tab or Alt+M cycles modes
- panel (`◈`): Tab cycles panels
- approval (`!`): a approves and d denies while approvals are pending

The catalog and renderer live in `packages/cli/src/tui/shortcuts.ts`, covered
by `packages/cli/src/tui/workspace-shortcuts.test.ts`.

### NOMO identity

`brand.ts` displays the supplied `nomo-logo.png` through Kitty graphics where
supported. Other terminals use the NOMO text fallback; the mark is never
redrawn or synthesized.

### Appearance themes

`/theme` lists the supported color palettes and symbol presets. `/theme preview <color> <symbols>` applies a temporary preview and keeps the selected values visible in the theme list. Press Enter to keep the preview for the current process; `/theme reset` restores the environment defaults.

Persist a choice with `NOMO_TUI_THEME` and `NOMO_TUI_SYMBOLS` in the shell environment. The Workbench appearance preference is separate. The default palette uses white foreground text with coral and turquoise accents. All palettes leave the terminal background to the user's terminal; `NOMO_TUI_COLOR=0` remains readable in monochrome.
