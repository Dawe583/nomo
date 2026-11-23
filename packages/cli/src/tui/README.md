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
may be distinguished only by colour or by an icon. The Chat transcript has no
outer frame; configurable borders apply to the composer only. Chat keeps the
composer free of mode, message-count and prompt-title labels, and leaves the
terminal background under the user's control.

The interactive workspace opens in Chat. Chat uses a transcript canvas with a
theme-derived composer fixed to the bottom of the terminal. Its input area
starts at one row and auto-grows with wrapped draft text, then shrinks when
needed to preserve the viewport. Ctrl+O cycles agent-activity detail only during
an active run.
Rounded framing uses symmetric corners when supported and square fallbacks on
ASCII terminals.
Framed input keeps the terminal surface transparent. Its rail shows available
context capacity and used percentage; the activity dock shows subagents,
heartbeats and shell commands.
Other screens open as framed, full-screen panels from slash commands or the `/`
command palette, and Escape returns to Chat. There is no Overview panel.
`/runs`, `/status` and `/health` open detail content without restoring a
separate landing screen.

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
`--once` prints a snapshot. Piped, CI, dumb and NO_COLOR output also uses a
plain snapshot without terminal control sequences; set `COLUMNS` and `LINES` to
preview a chosen viewport when output is not attached to a terminal. The watch
authenticates records with the same configured development signer as the proxy.

Keys: j/k or arrows select; Enter opens the record; Escape returns; f cycles
class filters; p pauses display updates; v refreshes verification; ? opens help;
q exits. Exiting leaves the proxy running. The live watch does not offer approval
or replay shortcuts until those actions are actually connected. Existing preview
renderers remain available for the richer planned dashboard.

## Interactive workspace runtime

The CLI renders the workspace with its Node terminal adapter and the live
`WorkspaceTui` renderer. Key input, bracketed paste, terminal resize, signal
handling, suspend/resume, and terminal restoration stay in the runner and
adapter; Workbench remains the owner of provider and action behavior. The
Models view reads the active provider projection, and selecting a model changes
the default for future conversations only.

The CLI bundles semantic [Iconoir](https://github.com/iconoir-icons/iconoir)
tab, provider and Settings graphics with its MIT license and attribution.
Ghostty loads the bundled 48 × 48 PNGs through the Kitty graphics protocol. A
complete local tab icon pack in `NOMO_TUI_ICONS_DIR` or the NOMO data directory
takes precedence. It may include `provider.dark.png` and `provider.light.png`
to customize the provider mark, and any subset of semantic overrides named
`<iconoir-name>.dark.png` and `<iconoir-name>.light.png`; unspecified semantic
icons use the bundled artwork. Other terminals keep text labels and the
selected Unicode/ASCII symbols. See [`icons/ATTRIBUTION.md`](./icons/ATTRIBUTION.md)
for the semantic mapping and license. Interactive mode runs directly on Node
24 and later without a runtime re-exec.

### Semantic icon presets

`NOMO_TUI_SYMBOLS=nerd` selects named Codicons glyphs from the Nerd Fonts 3.5.1
glyph map for screen categories, status, Chat activity, and Settings. It needs a
compatible Nerd Font installed in the terminal. Use `NOMO_TUI_SYMBOLS=unicode`
or `NOMO_TUI_SYMBOLS=ascii` when the terminal shows missing private-use glyphs.
The default remains `unicode`; NOMO does not assume a patched font or probe the
user's terminal font. Each glyph sits beside a text label, and activity counts
remain tied to runtime data. The glyph map is derived from the project's
published names and code points, not from locally drawn icons.
Settings headings and every supported TUI/Workbench control use a semantic
icon from the selected preset: run limits, tokens, prompts, queues, network
requests, tools, hooks, retries, context, refinement and model selection each
have a matching symbol, with ASCII/Unicode fallbacks.
Panel titles use the same semantic preset for Models, review, keybindings,
shortcuts, and each workspace area.

Source: [Nerd Fonts glyph sets and code points](https://github.com/ryanoasis/nerd-fonts/wiki/Glyph-Sets-and-Code-Points)
and [Nerd Fonts glyph map](https://github.com/ryanoasis/nerd-fonts/blob/master/glyphnames.json).
Iconoir terminal graphics use bundled, licensed artwork only in Ghostty. Other
terminals use the semantic glyph preset and text label as a fallback.

## Workspace keys

In Chat, Enter sends; Shift+Enter, Alt+Enter, Ctrl+J or backslash+Enter inserts
a newline; Esc stops a run; Esc Esc clears input or opens checkpoints when
empty; Shift+Tab cycles local modes; Ctrl+P opens the command palette while
editing; Up/Down browse prompt history in a one-line composer; Alt+M opens the
provider/model picker for future conversations;
Alt+P chooses a model for the current conversation from that conversation's
existing provider catalog. It is available only while the conversation is
idle; running, queued, unknown, or unreconciled sessions cannot switch models.
Ctrl+R searches history; Ctrl+O cycles Compact, Details and Expanded agent
activity only during an active run, without changing composer height;
Ctrl+Shift+O hides or shows tool activity and saves the choice for the next session; Ctrl+L redraws, twice
clears; Ctrl+S stashes input; Ctrl+G opens the editor; Ctrl+C clears, cancels or
exits; Ctrl+D exits from empty input. Alt+Shift+C copies the current Chat
prompt to the system clipboard. Alt+Shift+P toggles local plan mode and
restores the previous local mode when turned off. Ctrl+Z suspends the foreground NOMO job
on POSIX; run `fg` in the shell to resume it. Windows does not support this key.

In a framed panel, Enter opens a selected conversation, toggles a tree group or
folder, or opens the selected row. Escape returns to Chat; Tab also returns to
Chat from a panel and focuses the composer in Chat. In the Models picker,
Tab and Shift+Tab switch focus between providers and models without closing it.
Left/Right pages a tree and does not switch screens. Every printable character filters a supported list,
including letters used by former single-key actions. Up/Down wraps flat
selections or moves through a tree; Home/End jump to either end;
PageUp/PageDown pages a selection and scrolls an open detail. Escape closes a
detail before clearing the active filter, then returns to Chat. Click a normal
row to open it; mouse hover highlights without changing the keyboard selection.
`/resume NUMBER|ID` opens a conversation; `/document PATH` opens a document.
Alt+M and Alt+P open model selection; Alt+M changes the future default, while
Alt+P changes only the current conversation and keeps its provider. The picker
supports cursor editing, Home/End,
paging by visible rows, Ctrl+U to clear the search, and Esc to close. Tab,
Shift+Tab, and Left/Right switch between the provider and model panes. Its wheel
scrolls without changing selection; a second click activates a model. Ctrl+P
opens the command palette while editing; Alt+M opens the default picker and
Alt+P the current-conversation picker. The Models panel lists configured provider profiles and the connected
provider's available catalog; inactive profiles do not expose model catalogs
through the current Workbench contract. The mouse wheel scrolls Chat and detail
views or moves list selections. Drag over non-clickable text to select it; hold
Shift while dragging across clickable rows. NOMO copies the selection when the
mouse button is released. Ctrl+B
background tasks, image paste, and Vim editing have no NOMO equivalent.
`/conformance [adapter]` runs the disposable adapter checks behind the TUI.
`/providers` lists model providers including local open models.
`NOMO_TUI_KEYBINDINGS` may override the six workspace Ctrl-letter actions as a JSON object, for example `{"redraw":"Ctrl+V"}`. Unknown actions, reserved control letters, and duplicate bindings are rejected as a whole; the built-in bindings stay in effect.
`/harness cloud|prime-agent` switches the agent harness; detection reads
PATH only and never executes anything.
`/settings` opens a grouped interactive panel for every currently supported
appearance, composer, motion, workspace-shortcut, and Workbench control. The
focused row has a visible `>` cursor and reverse-video highlight, and the
selected-control summary is highlighted with its current value and description. Type to filter, use
Up/Down, Home/End, PageUp/PageDown, mouse wheel, or click to move selection;
Ctrl+Left/Right jumps between Appearance, Interaction, and Harness groups when
the filter is empty; with a filter, it moves the filter caret.
Left/Right changes choices, Enter edits or applies, and Space applies a choice.
Text and numeric editors show a caret; Escape cancels an edit, clears an active
filter, then returns to Chat. Click a focused row again to activate it; a
double-click also activates. Clicking another row cancels an unsaved editor.
Appearance choices and validated workspace-shortcut overrides save to local
TUI state, with explicit `NOMO_TUI_*` environment variables taking precedence.
Workbench run limits and refinement settings use the local Workbench settings
store. `/settings key value` remains
available for direct setting updates. Only settings with a live NOMO consumer
are shown.

### Shortcut legend

The workspace frame renders a persistent shortcut legend at the bottom of the
frame. Every shortcut shows a single cell icon plus a key label plus an action
description. Icons are color coded by category: nav uses info, edit uses
warning, action uses accent, mode uses success, panel uses muted, approval uses
error. The legend is context sensitive: it shows different hints while editing,
while a confirmation is showing, while a run is active, and while approvals are
pending. The legend respects terminal color capabilities, `NO_COLOR`,
`NOMO_TUI_COLOR=0` (monochrome) and `NOMO_TUI_MOTION=0` (no animation). The
renderer leaves terminal-wide background colors untouched.

Icon categories:

- nav (`⇥`): slash commands open panels, Escape returns to Chat, arrows navigate
- edit (`✎`): Ctrl+R searches history, Ctrl+O cycles agent activity during a run,
  Ctrl+Shift+O toggles tool activity visibility, Ctrl+T transposes characters
  while editing; outside the composer it opens TODOs, Ctrl+J inserts a newline
- action (`⚡`): y accepts, n rejects, u undoes, `/queue` queues
- mode (`◆`): Shift+Tab cycles local modes
- panel (`◈`): Tab returns to Chat from a panel
- approval (`!`): Enter reviews a pending decision; y/n respond after review
- model (`◐`): Alt+M chooses the future default; Alt+P chooses the current conversation model; Ctrl+P opens the command palette while editing

The catalog and renderer live in `packages/cli/src/tui/shortcuts.ts`, covered
by `packages/cli/src/tui/workspace-shortcuts.test.ts`.

### TUI identity

The CLI TUI uses the six-by-six NOMO grid mark from `site/icon.svg`, with the
same coral and cyan accent cells. It is drawn directly in terminal text and
does not load a raster image.
