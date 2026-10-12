# Spec: NOMO futuristic terminal cockpit

## Status and approval gate

Status: Draft for human review. The capability map below was approved in chat.

This document defines the visual and interaction contract. It does not authorize
UI implementation, backend changes, task planning, or a release. Implementation
starts only after the user approves this specification. A separate implementation
plan follows that approval.

## Objective

Make NOMO's terminal interface a distinctive, high quality operator workspace
for coding-agent conversations and their safety evidence. Keep chat immediate,
while making runs, approvals, agent identity, policy, and signed evidence easy to
inspect and navigate.

The primary user is an operator who must understand what an agent is doing,
what is waiting for a decision, which effects have or have not been confirmed,
and where the supporting evidence lives. Success means the interface feels
visually alive and precise without hiding uncertainty, overwhelming the
transcript, or granting authority to presentation code.

All built-in TUI labels default to English. User messages and stored documents
remain in their original language.

## Research basis and current facts

### OMP reference

The reference audit used the public `can1357/oh-my-pi` source tag `v18.8.9`,
which matches the inspected local OMP version. It covered source and bundled
screenshots, not a live OMP agent session.

Relevant source areas include:

- `packages/tui/src/chat/assistant-message.ts` for streamed Markdown and stable
  message rendering.
- `packages/tui/src/chat/tool-execution.ts` and
  `packages/tui/src/render/tool-card.ts` for tool lifecycle cards, previews, and
  expandable output.
- `packages/tui/src/components/settings-list.ts` and
  `packages/tui/src/overlays/settings-selector.ts` for grouped settings,
  filtering, descriptions, edit controls, mouse interaction, and live preview.
- `packages/tui/src/overlays/ask-dialog.ts` for multi-step questions,
  multi-select, notes, custom input, review, and submit.
- `packages/tui/src/theme/shimmer.ts` for optional animated emphasis.
- `packages/tui/src/chrome/message-frame.ts` for reusable framed messages.

Bundled examples `assets/python.webp`, `assets/ask.webp`, `assets/models.webp`,
`assets/task.webp`, and `assets/lspv.webp` show charts, interactive questions,
model selection, task progress, and tool activity. These are reference examples,
not proof of a live current OMP session. OMP's visual and interaction patterns
are inspiration only. NOMO does not copy its name, logo, assets, or source code.

The installed Prime Agent package includes useful local TUI documentation and
screenshots. Its screenshots show an older Pi interface and are not treated as
proof of the current Prime Agent render.

### NOMO baseline

The read-only audit found these implemented surfaces in the active worktree:

- A main workspace with overview, chat, sessions, documents, ledger, approvals,
  policy, tools, models, usage, and help.
- A separate live feed and hold review path, plus existing workspace approvals.
- A streamed chat renderer with role labels, headings, fenced code, and compact
  tool output. It is not a full Markdown renderer and does not provide rich
  stateful tool cards.
- A settings command for Workbench limits, not a complete searchable settings
  center.
- Safe text sanitizing, signed ledger evidence, explicit approval review,
  verified versus unverified display, keyboard navigation, and PTY tests.
- No main-workspace split inspector, mouse interaction, or fleet identity
  controls. The central workspace renderer and state are concentrated in
  `packages/cli/src/tui/workspace.ts`.

`packages/cli/src/tui/README.md` contains useful contracts but some renderer
claims do not match active command call sites. Before implementation, verify
live call sites again and preserve the read-only audit findings in the change
plan. The TUI remains a distinct terminal product, not a web UI rendered in a
terminal.

The repository is also in the NOMO-only rename workstream. New TUI work must use
canonical NOMO names and the approved state migration contract. Normal startup
uses `~/.nomo`; it does not inspect or write the old state root. Migration stays
an explicit command, not a side effect of opening the TUI.

## Approved capability map

| Module id | Responsibility | Depends on |
|---|---|---|
| `terminal-shell` | Adaptive terminal layout, theme, navigation, reusable UI primitives, focus, and motion policy | Existing TUI and terminal contracts |
| `conversation` | Rich messages, Markdown, code, tables, tool cards, streamed state, and interactive questions | `terminal-shell`, typed session events |
| `operator-cockpit` | Runs, sessions, approvals, policy, tools, models, ledger, and evidence | `terminal-shell`, existing Workbench, policy, and ledger contracts |
| `settings` | Searchable catalog, typed editors, effective values, change status, and safe preview | `terminal-shell`, authoritative settings metadata and persistence |
| `fleet-controls` | Agent inventory, run stop, agent revoke, fleet revoke, and acknowledgement state | `terminal-shell`, `operator-cockpit`, approved product-v1 fleet API and events |

Build order: establish `terminal-shell`, then build `conversation`,
`operator-cockpit`, and `settings`. Build `fleet-controls` only after its
backend contract is stable. Apply validation and accessibility checks in every
slice, not only at the end.

## Scope

### In scope

- A unified, terminal-native shell for existing NOMO workspace functions.
- Chat as the immediate primary surface, with clear access to operations and
evidence.
- Rich, safe message formatting, streamed output, and interactive tool cards.
- A complete searchable catalog of settings that have authoritative NOMO
  metadata. Each setting clearly states whether it is editable.
- Run, approval, policy, tool, model, session, document, usage, and evidence
  states that the current contracts can support.
- Fleet inventory and controls only when backed by the approved product-v1
  contract. The UI may be designed in advance, but must not simulate missing
  backend capabilities.
- Keyboard-first operation, optional mouse support, responsive terminal
  layouts, color, and controlled motion.

### Out of scope

- Changes to the web or desktop UI.
- Changes to authorization, policy, ledger, approval, or recovery semantics.
- New provider defaults, secret storage, token protocols, or backend APIs.
- Claims of distributed fleet control in the local demo.
- Direct code, brand, or asset copying from OMP.
- Terminal image protocols as a requirement for the core experience.

## Information architecture

The shell has three layers:

1. Primary navigation for Overview, Chat, Runs, Agents, Approvals, and Evidence.
2. Supporting views for Sessions, Documents, Policy, Tools, Models, Usage,
   Settings, and Help.
3. A contextual inspector that shows details for the selected run, agent,
   approval, document, tool, or evidence record without replacing the main
   workspace on wide terminals.

Chat remains one action away and is the first surface when a conversation is
active. With no active conversation, show a useful start state with the composer
ready and a compact operator summary. Do not make the user pass through a
marketing screen.

Navigation badges use counts derived from real data, such as pending approvals
or unresolved outcomes. Hide a badge when the count is unavailable. Never fill
missing data with zero.

Preserve every current workspace capability. Reorganize panels only when the
new route remains discoverable through visible labels, the command palette, and
Help.

## Visual direction

### Design thesis

Create a dark instrument panel around the NOMO aperture identity. Use precise
frames, restrained depth, clear typography, signal-like status cues, and a small
number of bright accents. Keep the transcript calm enough to read for long
sessions. Avoid nested cards, constant glow, decorative telemetry, and visual
noise.

Candidate palette for review:

| Token | Candidate value | Use |
|---|---|---|
| `background` | `#070A10` | Main terminal canvas |
| `surface` | `#101722` | Focused panels and message surfaces |
| `border` | `#263345` | Quiet dividers and inactive frames |
| `text` | `#E8F1FB` | Main text |
| `muted` | `#8999AC` | Timestamps and secondary detail |
| `active` | `#45D8FF` | Keyboard focus, active navigation, live signal |
| `identity` | `#B96BFF` | NOMO identity and selected agent context |
| `assistant` | `#F05BCB` | Assistant accent, used sparingly |
| `hold` | `#FFC15C` | Pending approval and warning |
| `error` | `#FF657B` | Denial, failure, and unsafe state |
| `verified` | `#50D99A` | Verified evidence and confirmed completion |

These are candidate tokens, not final visual measurements. Safety states always
include plain text and a stable marker. Color and shape reinforce the meaning,
but never carry it alone. Keep the existing reversibility and decision labels
visible.

Use the aperture as NOMO's own frame and transition motif. Use single-cell
symbols when supported and readable ASCII fallbacks otherwise. Do not import
OMP's wordmark or Pi icon. Do not make the terminal copy the web application's
visual system.

### Motion and effects

- The default motion is subtle and attached to real activity: a short aperture
  sweep at startup, a low-amplitude live-run pulse, and a brief progress shimmer
  on a genuinely active tool or run.
- Idle screens are static. No looping background animation, flashing, fake
  network activity, or decorative progress.
- Completion, hold, denial, and error states use one short transition. The final
  label remains visible after motion stops.
- A motion-off setting disables nonessential animation. The canonical future
  environment key is `NOMO_TUI_MOTION=0`; implementation must verify it against
  the current rename contract before adding it.
- The explicit monochrome option remains `NOMO_TUI_COLOR=0`. An interactive TUI
  uses its full theme by default even when `NO_COLOR=1`, as requested. Redirected
  or noninteractive output remains plain.
- No animation may block input, delay a decision, or claim that an operation
  completed.

## Layout and responsive behavior

The composer stays visible and reachable. The top status area carries the
current workspace, run state, and important warnings. The bottom status line
carries the active model, session, agent, context use, and counts only when those
values are available from a trusted source.

| Terminal size | Layout |
|---|---|
| 160 columns or more | Left navigation, central work area, and right contextual inspector |
| 120 to 159 columns | Compact left navigation and central work area; inspector opens as a side sheet |
| 80 to 119 columns | Compact tab navigation and one main view; inspector opens as a full-width sheet |
| Below 80 columns | Focused single view with a short status line and no persistent side panes |
| Below 20 rows | Hide decoration and secondary metrics; keep the active state, critical warning, composer, and required decision controls visible |

All widths use terminal cell measurements, not JavaScript string length. Long
content wraps or scrolls within its pane. It must not push the composer offscreen,
corrupt frame borders, or cause a hidden approval control. Resize preserves
selection, draft text, and the selected evidence record.

At 160 columns or more, the intended hierarchy is:

```text
╭─ NOMO / OPERATOR COCKPIT ──────────────────────────────────────────────────────────────╮
│ Overview  Chat  Runs  Agents  Approvals  Evidence  Settings                 ● RUNNING  │
├──────────────────────┬──────────────────────────────────────┬───────────────────────────┤
│ Navigation and counts│ Conversation or selected work view   │ Contextual inspector      │
│                      │                                      │ Run, agent, approval,      │
│                      │ Rich messages and tool cards         │ policy, or evidence detail │
├──────────────────────┴──────────────────────────────────────┴───────────────────────────┤
│ Model  Session  Agent  Context  Approvals  Evidence status                               │
├─ NOMO / WRITE A PROMPT ──────────────────────────────────────────────────────────────────┤
│ > Composer draft                                                                        │
╰─────────────────────────────────────────────────────────────────────────────────────────╯
```

The preview is conceptual. Actual cell widths, small terminal behavior, and
color fallbacks must be verified with the repository's terminal preview and
PTY tooling before approval of the implementation.

## Conversation and message rendering

### Message hierarchy

- User, assistant, tool, system status, and error messages have distinct text
  labels and restrained frame treatment.
- Assistant output renders Markdown structure: headings, paragraphs, lists,
  emphasis, inline code, fenced code, block quotes, links, and supported tables.
- Preserve message timestamps and stable ordering where present. Do not add
  timestamps or author identities that the event does not provide.
- Streaming content updates without duplicating deltas or moving the viewport
  when the user is reading history. A visible follow-to-bottom state makes live
  following explicit.
- The composer remains pinned during streaming, history navigation, and approval
  review.

### Code, tables, and artifacts

- Code blocks show the language when known, stable line wrapping, and readable
  syntax color. Unknown languages still render safely as code.
- A narrow terminal may wrap a code line only when the layout marks the wrap;
  otherwise provide a horizontal scroll or a clear truncation indicator.
- Tables preserve their headings and values. They may use compact columns or a
  horizontal viewport. A chart may appear only when the data is present and the
  rendering is deterministic. Never infer values or add a chart based on a
  guess.
- Links remain text unless the terminal advertises a safe link capability.
  Attachments and images retain a plain-text fallback. Inline image support is
  optional and is not required for completion.
- Render Markdown through a parser with raw HTML disabled. Treat model, tool,
  connector, document, and provider output as untrusted text.

### Tool cards

Each tool call has one stable card with:

- Tool name and safe operation summary.
- A visible lifecycle label such as pending, running, partial, complete,
  warning, error, or unknown, only when the source contract supports it.
- Duration, file count, progress, and result count only when measured data is
  available.
- A concise preview, expandable output, and explicit copy or open actions only
  when supported by the terminal and the owning feature.
- Error and warning summaries visible even when details are collapsed.

Group repeated read-only operations when the source provides a reliable grouping
key. Do not merge separate writes or approvals into one ambiguous card. Approval
requests open the approval review flow; a tool card does not approve a call.

### Interactive questions

Question surfaces support single-select, multi-select, custom input, per-answer
notes, and a review step when the owning tool supplies those controls. The
footer states the keys for the current control. Cancel and submit stay distinct.
A timed question shows its remaining time and timeout result. No option is
selected on the user's behalf unless the source marks it recommended, and a
recommendation remains visibly distinct from a submitted answer.

## Operator cockpit and safety surfaces

### Overview and runs

Overview prioritizes the active run, pending approvals, unresolved outcomes,
recent sessions, and verified evidence. The center panel is a real activity feed,
not a generated diagram. The inspector names the selected run, model, agent,
workspace, last event, and reconciliation state only when those fields exist.

Progress displays the backend value when present. A missing value reads
`unknown`, not `0%`. A stopped run does not imply that an already dispatched tool
call was cancelled. A missing completion result remains unresolved.

### Approvals

Approval review presents a safe operation summary, agent and run identity when
provided, workspace and scope, policy class, rationale, expiry, and evidence
state. Raw arguments and secret-bearing content do not enter the review surface.

The operator sees separate steps for review, explicit approve or deny, accepted
or queued decision, and eventual tool result. A decision accepted by the
Workbench or queued to a proxy is not shown as a completed write. Expired,
already-resolved, and failed decisions remain explicit. No keypress or mode
setting silently approves a request.

### Policy, tools, and evidence

Policy and tool pages explain the active decision and connector state using
existing contracts. Unknown tools, missing policy, missing verification keys,
and unavailable data remain visible as unknown or unavailable. The UI does not
classify a tool or verify a signature itself.

Evidence detail shows record identity, sequence, chain result, signature result,
verification key identity, and source when available. Keep verified,
integrity-only, unverified, unavailable, and unknown states distinct. Never use
`verified` without naming the verification scope that supports the claim.

## Fleet controls

Fleet controls have a strict capability gate. The local demo exposes only the
local identity and kill behavior it actually implements. It must label the scope
as local and make no claim of distributed fleet acknowledgement or kill SLA.

After the approved product-v1 API and events exist, an agent detail may show
principal binding, workspace, credential status, revocation generation, active
runs, and acknowledgements. Tokens and credentials are never displayed.

Keep these actions separate:

1. Stop one run.
2. Revoke one agent.
3. Revoke the fleet.

Before a destructive action, show the exact target scope, expected enforcement
nodes, already-dispatched calls, and possible unresolved outcomes. Require an
explicit confirmation. Show success only after every expected active enforcement
node acknowledges the relevant revocation generation. A disconnected node
remains unresolved, not revoked. A dispatched tool call may finish after stop or
revoke; the interface never says that its side effect was undone.

If no approved API exists, show no action button. An unavailable explanation is
better than a disabled control that implies unsupported behavior.

## Searchable Settings

Settings is a full-screen searchable workspace, not a flat help listing.

### Catalog and search

- Search across every exposed setting by display name, canonical key, category,
  help text, safe current value, and allowed choices.
- Search results show the category and match count. Selecting a result opens its
  detail and moves to its owning category when search closes.
- Categories are Appearance, Interaction, Conversation, Models and Providers,
  Policy and Approvals, Tools and Connectors, Workspace and Storage, Privacy,
  Agents and Fleet, and Diagnostics. A category appears only when the
  authoritative registry contains settings for it.
- The selected row keeps its value visible. A changed marker identifies a value
  that differs from its declared default.

### Setting detail and editing

Each setting exposes its canonical key, human label, description, effective
value, default, source, editability, validation state, and restart requirement
when known. Sources may include built-in default, user configuration, workspace
configuration, environment, runtime, or an external managed policy. Do not infer
a source from a value.

Use typed editors for supported booleans, choices, text, numbers, and lists.
Validate before applying. Preserve the draft and show the validation message on
failure. Viewing Settings never mutates process environment or global state.
Only an existing authoritative persistence path may save a setting. If a setting
has no safe editor or persistence path, show it as read-only with the reason.

Secrets are never shown, copied, searched, or revealed. A secret setting may
show only `configured` or `not configured` and its safe source. Settings and
search fixtures contain no credentials.

Theme changes preview immediately. Applying persists only through the
supported settings path. Cancel restores the prior preview. Other runtime
settings may preview only when the owning service guarantees that behavior.

## Input, focus, and interaction

- Preserve existing working shortcuts unless a separate review approves a
  change.
- Tab and Shift+Tab navigate primary surfaces. Arrow keys and j/k move through
  lists. Enter opens or activates the selected item. Escape returns one level
  or cancels the current draft, with its current meaning displayed in the
  footer.
- Slash commands keep completion and descriptions. Settings search accepts
  typed input and shows a clear way to edit or exit the query.
- Every interactive component has visible focus, visible selected state, and a
  short contextual key hint. Mouse support is optional and never replaces
  keyboard access.
- Keyboard focus stays within an open modal or full-screen review. Closing it
  returns focus to the item that opened it.
- A shortcut that requests stop is not described as rollback or guaranteed
  cancellation.

## Terminal safety, accessibility, and performance

- All untrusted text passes through terminal-control and width sanitizing before
  rendering. Never render model-supplied ANSI, OSC, cursor movement, bidi
  overrides, or hidden control characters.
- Keep labels for every state. No safety outcome depends only on color, icon,
  border, or animation. Maintain a legible monochrome rendering.
- Respect terminal width, height, color depth, and Unicode width. Provide an
  ASCII fallback for nonessential symbols. Do not require a Nerd Font.
- The interactive theme uses truecolor, 256-color, or 16-color output according
  to capability. `NOMO_TUI_COLOR=0` selects monochrome. Noninteractive output
  contains no terminal control sequences.
- Motion is optional, bounded, and off when configured. A static screen retains
  all status and focus information.
- Reuse existing render caches and dirty-frame behavior where possible. Never
  redraw the entire screen once per streamed token if a bounded component update
  is enough. Animation must not increase polling or create a busy loop while
  idle.
- Keep terminal raw-mode restoration, signal handling, resize behavior, and
  shutdown cleanup intact.

## Architecture boundaries

- `Workbench`, policy, proxy, and ledger remain the sources of truth. UI code
  formats typed state and events only.
- Rendering never authorizes, classifies, signs, verifies, dispatches, replays,
  or mutates a policy decision.
- New render components live under `packages/cli/src/tui/`. The raw input loop
  and terminal lifecycle remain in the runner. Domain actions stay in the
  existing Workbench and owning packages.
- Split the central workspace into small render and interaction components
  aligned with the approved capability map. Do not replace it with a web stack
  or make a single new monolithic renderer.
- Use existing TypeScript and terminal primitives first. No new runtime
  dependency without explicit approval.
- Use `node:test` only. Do not add UI test dependencies.
- Keep the settings catalog declarative and typed. A setting does not become
  editable merely because a renderer can draw an input.

## Project structure and commands

Expected implementation boundary:

- `packages/cli/src/tui/`: terminal shell, render components, theme, capability
  handling, and input integration.
- `packages/cli/src/tui/*.test.ts`: pure rendering and interaction tests.
- `scripts/src/verify-tui-terminal.py` and the existing TUI scripts: PTY and
  terminal lifecycle verification.
- `docs/superpowers/specs/`: this approved specification.

Commands to run after implementation, in sequence:

```sh
pnpm run typecheck
pnpm run test:tui
pnpm test
pnpm run tui:preview -- 80 24
node scripts/tui-capture.mjs --cols 80 --cols 120 --cols 200
node scripts/tui-degrade.mjs
node scripts/tui-raw-mode-safety.mjs
python3 scripts/src/verify-tui-terminal.py
```

Recheck the preview command and canonical package names after the NOMO-only
rename. The first three commands are the required code verification gates.
The remaining commands cover visual capture, degradation, and terminal safety.
Run checks sequentially to keep machine load bounded.

## Testing strategy

1. Pure rendering tests cover each view at 80, 120, and 160 columns and short
   heights. Assert cell width, frame closure, selected state, and no accidental
   horizontal overflow.
2. Message tests cover headings, lists, links, tables, code fences, incomplete
   streamed Markdown, untrusted escape sequences, long lines, and hidden control
   characters.
3. Tool-card tests cover every supported phase, collapse and expand, late result,
   streaming update, error visibility, and truthful metadata when values are
   absent.
4. Settings tests cover category navigation, fuzzy search, match counts,
   category jump, typed editor validation, change markers, source labels,
   cancel and apply, read-only values, and secret non-disclosure.
5. Approval and fleet tests cover explicit confirmation, exact scope, queued vs
   completed status, expiry, unknown outcomes, disconnected enforcement nodes,
   and in-flight calls. Tests assert that rendering never invokes a decision or
   backend action.
6. PTY tests cover interactive color despite `NO_COLOR=1`, explicit monochrome,
   plain redirected output, keyboard navigation, paste sanitizing, resize, raw
   mode restoration, cancellation, and shutdown.
7. Integration tests use only fixtures or disposable targets. No autonomous
   test touches a production account.
8. Visual review uses deterministic captures at narrow, medium, and wide sizes.
   Captures contain fixture data only. Review readability, visual hierarchy,
   motion-off state, and the distinction between verified and unknown outcomes.

No numeric coverage target is defined by the current project contract. Tests
must assert the behaviors above and may not be weakened to make the redesign
pass.

## Code style

Use pure formatting functions for view output and small stateful components only
where interaction requires retained state. Keep labels explicit and data-derived.

```ts
function decisionLabel(decision: CallDecision): string {
  switch (decision) {
    case "allow":
      return "ALLOW";
    case "hold":
      return "HOLD";
    case "deny":
      return "DENY";
  }
}
```

This example uses the existing `CallDecision` contract. Rendering may label a
decision, but it does not make or authorize that decision.

## Boundaries

### Always

- Keep chat, run state, approval, and evidence connected to their owning typed
  contracts.
- Display unavailable, unverified, queued, in-flight, and unknown states
  honestly.
- Preserve keyboard access, terminal cleanup, secret redaction, and explicit
  approval.
- Keep the composer reachable and keep untrusted output inert.

### Ask first

- Adding a dependency, changing a public Workbench event or API, changing
  authorization or approval semantics, adding a new persistent setting, or
  changing a keybinding contract.
- Making a fleet control available before product-v1 acknowledgement semantics
  are approved.
- Changing the terminal's distinct NOMO identity or adding terminal image or
  clipboard protocols.

### Never

- Treat presentation code as a policy or identity authority.
- Show a token, credential, raw secret-bearing argument, or secret value.
- Claim a write, stop, revoke, or fleet operation completed without its required
  result or acknowledgement evidence.
- Report a dispatched action as cancelled or rolled back without evidence.
- Infer cost, progress, verification, permission, or fleet reach from missing
  data.
- Copy OMP branding, assets, or source code.

## Success criteria

The specification is ready for implementation only when the user approves it.
After approval, implementation is complete only when all criteria below pass:

1. The active TUI has a chat-first, adaptive NOMO shell with the approved
   aperture identity and the final reviewed palette.
2. The conversation view safely renders Markdown, code, tables, streamed
   messages, and expandable tool cards without losing errors or changing
   meaning.
3. The operator can navigate current runs, sessions, approvals, policy, tools,
   models, documents, usage, and evidence without losing existing functions.
4. Settings search covers every setting in the authoritative UI catalog. Every
   result identifies its category, effective value, source, and editability.
   Secret values never appear.
5. Fleet actions appear only when backed by a reviewed product-v1 contract.
   Run stop, agent revoke, and fleet revoke remain separate, with truthful
   acknowledgement and in-flight states.
6. Keyboard navigation remains complete. Mouse behavior, if added, has keyboard
   parity.
7. Color-off, reduced-motion, narrow terminal, short terminal, and redirected
   output states remain understandable and safe.
8. Existing terminal safety, Workbench, approval, policy, and ledger behavior
   remains unchanged by the UI refactor.
9. Focused TUI tests, `pnpm run typecheck`, and `pnpm test` pass. PTY and visual
   captures show no broken frames, hidden controls, leaked secrets, or false
   success claims.
10. The final diff contains no new dependency, no weakened test, no secret, and
    no noncanonical NOMO product setting.

## Open questions for review

1. Are the candidate cyan, violet, magenta, amber, red, and green tokens the
   right NOMO direction, or should one accent dominate more strongly?
2. Should the initial state always open Chat, or open Overview when there is no
   active session? This draft proposes Chat when a session is active and a
   composer-ready start view otherwise.
3. Which existing NOMO settings should be editable from the terminal, and which
   should remain read-only? The catalog must not invent persistence behavior.
4. Should mouse support be included in the first implementation slice or follow
   keyboard parity as a later enhancement?
5. Which terminal image or clipboard capabilities, if any, should be considered
   after the text-first experience is complete?
