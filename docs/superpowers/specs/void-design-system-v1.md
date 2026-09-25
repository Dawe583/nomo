# VOID design system v1

Status: D01 source and design audit, 2026-09-24. This document describes the current web surface and two coherent directions for user review. It does not implement a UI, change routes, change product behavior, add an Apple build, or make a release-ready claim.

D01.05 is **pending user approval**. No direction in this document is approved for implementation.

## 1. Audit basis and boundaries

The audit used the current source and the existing verification records:

- `docs/GUI-UPGRADE-PLAN.md`
- `docs/GUI-UPGRADE-AUDIT.md`
- `docs/GUI-COMPACT-VERIFICATION.md`
- `docs/GUI-RULES.md`
- `apps/control-plane/ui/src/main.tsx`
- `apps/control-plane/ui/src/pages.tsx`
- `apps/control-plane/ui/src/chat.tsx`
- `apps/control-plane/ui/src/documents.tsx`
- `apps/control-plane/ui/src/settings.tsx`
- `apps/control-plane/ui/src/integrations.tsx`
- `apps/control-plane/ui/src/ui.tsx`
- `apps/control-plane/ui/src/styles.css`
- `apps/control-plane/ui/src/mobile.css`
- `apps/control-plane/ui/src/compact-layout.test.ts`

The current application is a React and TypeScript Vite client in `apps/control-plane/ui`. The same build is consumed by the local server, desktop package, and Vercel-facing deployment. The retained `apps/control-plane/web` source is a compatibility reference, not the starting point for new UI work.

The current compact direction is already part of the contract. The following constraints remain fixed for both proposed directions:

- Chat is the primary workspace.
- The transcript is bounded and scrollable without moving Send outside the viewport.
- Composer status, notices, attachments, and expanded tool details share a bounded keyboard-scrollable region; the input, Send, and command palette remain outside it.
- Context compaction remains mounted in the transcript when settings or other dialogs close.
- Minimum touch target is 44pt. Mobile controls do not shrink below 44pt.
- Mobile input text remains at least 16px. Chrome and spacing may reduce; target size and input readability do not.
- Body text uses the system sans ramp. Monospace is limited to code, identifiers, and short technical values.
- Instrument Serif is reserved for welcome or strong display headings, not data-heavy pages.
- One restrained orange action accent is retained. Color is not the only carrier of state.
- System, light, and dark appearance use the same semantic token model.
- The existing aperture brand mark, navigation vocabulary, route slugs, and server-controlled safety states are not silently replaced.
- Motion is limited to action feedback and state transitions. Reduced motion remains supported through the existing preference and `prefers-reduced-motion` behavior.
- No design direction invents provider capability, usage, price, verification, approval, or recovery state.

Current compact evidence is bounded and factual. The verification record reports no horizontal page overflow at the checked viewports, 44pt composer actions at 320px, successful dialog focus restoration, and synthetic IME composition coverage. It does not certify physical keyboards, VoiceOver, TalkBack, real pending approvals, or physical phone behavior. D01 must not convert that evidence into a universal accessibility claim.

## 2. Current route inventory

The route map is defined in `main.tsx`. The table below records source-observed routes and their current purpose. A route being present is not evidence that every state or backend capability is available on every deployment.

| Route | Current component | Current purpose | Current route-level states and boundaries |
| --- | --- | --- | --- |
| `/chat/new` | `Chat` with no session id | New conversation and composer | Provider notice, capability and agent loading, draft persistence, queued state, model picker, attachments, command menu, disabled input while blocked, and explicit provider/setup notices. |
| `/chat/:id` | `Chat` with session id | Existing conversation | Session detail, transcript, runs, approvals, workspace context, provider snapshot, run state, draft, attachments, new-message follow state, recovery status, and conversation options. |
| `/overview` | `Overview` | Workspace attention and recent work | Overview query, unknown metrics, recent sessions table, error state, scope/status details, and links to sessions, runs, approvals, and documents. |
| `/sessions` | `Sessions` | Conversation history | Archived filter, server-backed table, edit dialog, archive confirmation, empty state, and row navigation to chat. Deletion is not presented as an available route. |
| `/runs` | `Runs` | Runs and activity | State filter, overview count or explicit unknown, run table, detail dialog, stop request, stopping state, unknown outcome warning, error state, and navigation to the owning conversation. |
| `/documents` | `Documents` | Documents and retained document history | Server-backed document table, selected document, editor/preview, revision, conflict and error handling, operation history, search, multi-selection only when recovery jobs are advertised, Undo preview, and applied state. |
| `/approvals` | `Approvals` | Approval inbox | Pending/all filter, polling refresh, risk-first ordering, empty state, selected approval review, server-side expiry and decision conflict behavior, and sanitized rationale. |
| `/ledger` | `Ledger` | Signed audit evidence | Server-backed filters, table/list view, verification scope, verification progress, detail, and explicit unverified or unavailable states. |
| `/connections` | `Integrations` | Tools and connections | Cloud-only notice, loading, connected, setup-required, disconnected, reconnect, refresh, permissions, tools, provider setup, and callback result states. |
| `/models` | `Models` | Models and usage | Provider/model list, availability, selection, usage and unknown/unverified values. A model name containing Free is not treated as a zero-cost fact without evidence. |
| `/settings` | `Settings` | Workspace and host preferences | Appearance, locale, send behavior, agent preference, provider configuration, workspace controls, desktop information, and explicit setup warnings. |
| `/demo` | `PublicDemo` | Public demo | Isolated from private workspace polling before provider authentication; synthetic public fixture state only. |

The existing route names, navigation labels, form identities, API names, and model IDs are treated as compatibility constraints. D01 proposes a visual system around them, not a new information architecture.

## 3. Current shell and shared state inventory

The shell in `main.tsx` currently coordinates:

- locale: `cs` or `en`, persisted locally and synchronized with preferences;
- appearance: `system`, `light`, or `dark`;
- motion preference: on or off, with reduced-motion support;
- online/offline state;
- provider probe and authentication gate;
- protected-query enablement after the provider probe succeeds;
- workspace token, connecting state, and connection error;
- sidebar width, collapsed state, mobile drawer, and context panel width;
- header options, global search, and search query;
- popstate navigation and workspace query preservation;
- viewport height updates while editing on mobile.

The current shell uses a desktop sidebar, bounded work area, optional context panel, topbar, mobile drawer, and safe-area-aware mobile navigation. The existing focus handling covers dialogs, drawers, Escape, and restoring focus after a panel or dialog closes.

Shared UI primitives in `ui.tsx` include:

- `useApi` with query state, retry, polling interval, and protected-query enablement;
- `Badge` for state labels with a value and optional title;
- `ErrorBox` for request errors;
- `Empty` for explicit empty states;
- native `Dialog` with modal focus trap, Escape handling, and opener focus restoration;
- `JsonDetail` and `RedactedJson` for evidence views;
- `DataTable` with server search, cursor history, page size, sorting, hidden columns, list/table view, row detail, and refreshable query state.

The current data-table contract is a key design-system dependency. Visual direction work must retain server-side search and pagination, preserve the visible page when data refreshes, and keep list/table switching explicit on narrow screens.

## 4. Current surface inventory

### Chat

`chat.tsx` is the primary work surface. It contains:

- rich Markdown rendering with raw HTML disabled;
- on-demand syntax highlighting, copy, wrap, and download code actions;
- user, assistant, and tool event presentation;
- tool cards, selected-tool details, run status, approval review, and recovery status;
- provider and permission notices;
- model picker, favorites, search, and provider snapshot display;
- session draft, queued state, attachments, project, background mode, retry, branch, follow/new-message state;
- context compaction;
- command menu for new, plan, review, tools, model, context, undo, approvals, ledger, export, and stop where applicable.

The composer and bounded notices region are the highest-value existing compact contract. A future direction may change surrounding hierarchy, but it must not reintroduce a first-screen composer below the fold or place expanded tool details in the submit path.

### Data pages

`pages.tsx` provides Sessions, Overview, Runs, Approvals, Ledger, and Models. The common pattern is a concise page introduction, a server-backed data surface, explicit loading or error handling, and detail in a native dialog or row detail. Approvals and runs deliberately display risk and unknown outcomes instead of collapsing them into a generic success state.

### Documents and recovery review

`documents.tsx` provides a document table, selected document, document history, search, multi-operation recovery review where advertised, and single-operation Undo preview. The UI must continue to distinguish a preview from an applied recovery and must not add a false Undo affordance when `canApply` is not true.

### Settings and connections

`settings.tsx` and `integrations.tsx` cover provider, agent, appearance, locale, send behavior, tool connections, OAuth callbacks, permissions, and setup requirements. Credentials are not visual design material. A design direction may improve grouping and hierarchy, but it must not place secret values in labels, previews, diagnostics, screenshots, or client-visible logs.

## 5. Shared design-system contract for D01

Both directions below use the following non-negotiable rules.

### Tokens

Use semantic tokens rather than repeated literals. The minimum token groups are:

- canvas, surface, raised surface, and overlay;
- text, muted text, inverse text;
- line, focus line, and selection;
- action, action-hover, action-pressed, and on-action;
- success, warning, danger, unavailable, and unknown;
- spacing steps based on the existing 4/8/12/16/24/32px rhythm;
- radius steps matching the existing 2px table, 4-6px form/dialog, and deliberate control geometry;
- typography roles for display, page title, section title, body, compact UI, metadata, code, and identifier;
- motion durations limited to approximately 120-180ms for direct interaction feedback.

No direction introduces a second palette, gradient family, or unrelated icon system. A future implementation must use the existing brand mark and existing icon/component conventions.

### Components

The shared system should promote only repeated contracts:

- shell and navigation;
- page header and section header;
- compact data table and mobile list row;
- status and evidence badge;
- dialog and drawer;
- notice, error, empty, stale, and unavailable states;
- action button and link;
- filter/search toolbar;
- code block and redacted JSON viewer;
- tool card and approval card;
- document editor, revision conflict, and Undo review.

A component is not ready for promotion merely because it has a prop. Its API should describe visual intent, size, state, and safe content composition, not leak route-specific layout decisions.

### States

Every interactive and data surface must have explicit treatment for:

- loading;
- empty;
- error;
- offline;
- stale;
- permission-required;
- unavailable;
- unknown;
- conflict;
- stopped or stopping;
- denied or expired approval;
- unknown tool or unknown recovery outcome;
- successful but unverified evidence.

Unknown is not zero. An absent receipt is not proof that no effect occurred. These are data semantics and cannot be softened by visual styling.

## 6. Direction A: Operational Clarity

Status: proposal, pending user approval.

### Intent

Keep the current compact neutral surface and make operational hierarchy more explicit. This direction treats VOID as a focused work console: calm neutral canvas, one orange action accent, compact evidence rows, and restrained motion. It borrows functional principles from dense product interfaces without copying another product's branding.

### Visual language

- neutral light and dark surfaces with the existing semantic color model;
- orange reserved for active navigation, primary action, focus, and selected state;
- no decorative gradients, glass, or large shadow stacks;
- one radius grammar per surface, with compact tables and controls retaining the existing 2-7px range;
- information separated by spacing, dividers, and alignment before card containers;
- monospace used only for code, operation IDs, digests, and short state values;
- Instrument Serif reserved for welcome/display moments;
- system sans for all ordinary UI and message copy.

### Layout

Desktop:

- retain the shared shell, bounded transcript, independent sidebar/context scrolling, and adjustable panel widths;
- keep the transcript text column at the current readable range;
- use a stronger topbar hierarchy for workspace, route, connection state, and pending approvals;
- make current run, unknown outcome, and permission state visible without opening a dialog;
- keep tool details collapsed by default and available beside the transcript or in context.

Tablet:

- use a narrow sidebar or drawer;
- keep the transcript usable at 480px minimum when context is open;
- open context as an overlay or a dedicated surface rather than placing it below a long transcript;
- preserve table-to-list behavior and keyboard focus order.

Mobile:

- keep the current one-scroll transcript, bounded notices region, fixed composer, and safe-area navigation;
- keep the 44pt touch target rule and 16px input text;
- use a drawer for navigation and a full-screen or full-width panel for document/diff context;
- keep filters in a sheet or compact toolbar with the selected filter visible;
- preserve draft, scroll position, and route detail across orientation and context changes.

### Component emphasis

- data rows remain compact but gain a stronger first-column hierarchy;
- status badges always include text; color is supplementary;
- notices use a clear title, stable state, and action;
- approvals remain risk-first and never become a generic notification list;
- Undo remains a reviewed operation with a fresh server preview;
- loading states follow the shape of the eventual row, panel, or transcript content.

### Accessibility and motion

- semantic headings remain in order;
- native dialogs and buttons remain the interaction baseline;
- every icon-only control has an accessible name;
- focus rings are visible in both themes and never rely on orange alone;
- normal text meets 4.5:1 contrast; large text and necessary UI graphics meet 3:1;
- keyboard shortcuts do not bypass focus restoration or closed-overlay handling;
- motion is limited to panel, dialog, pressed, and status transitions;
- `prefers-reduced-motion` and the existing motion-off preference disable nonessential animation.

### Risks and trade-offs

- The direction can feel too quiet for a first-time operator if empty and unavailable states are understated.
- Compact data density can become hard to scan unless the first column, status text, and row actions remain explicit.
- A strong neutral palette can reduce visual distinction between surfaces without careful token contrast.

## 7. Direction B: Evidence First

Status: proposal, pending user approval.

### Intent

Make the audit and reversibility story the visual center of the workspace while retaining the compact chat. This direction gives evidence, provenance, and outcome state more visual weight, without turning the product into a dashboard or a terminal pastiche.

### Visual language

- same neutral light/dark surfaces and one orange action accent;
- evidence edges and markers use restrained line treatment rather than decorative cards;
- approval, dispatch, recovery, and ledger states receive a compact status rail or evidence label;
- typographic contrast is stronger between the transcript and its evidence metadata, while ordinary UI remains sans;
- Instrument Serif remains limited to welcome and major display headings;
- JetBrains Mono remains limited to code, IDs, digests, and machine-readable values;
- no fake terminal screenshots, fake telemetry, or invented system diagrams.

### Layout

Desktop:

- retain the shared shell and compact transcript;
- make the current operation state a narrow, persistent evidence rail around or beside the composer context, not a permanent second dashboard;
- show the active run, last durable receipt, approval requirement, and recovery availability as explicit short lines;
- open full JSON, ledger, diff, and document history in the existing detail surfaces;
- use the context panel for selected evidence instead of duplicating it in the transcript.

Tablet:

- keep the evidence rail collapsed by default;
- expose selected evidence in the context overlay or a focused detail surface;
- maintain a single readable transcript and explicit return path.

Mobile:

- use the same transcript-first composition as Direction A;
- represent evidence as compact status rows in the bounded notices region and a full-screen detail view for JSON, ledger, diff, and recovery review;
- keep primary action, Send, and command controls outside scroll regions;
- do not use color-only rails or status dots.

### Component emphasis

- status rows use explicit labels such as signed, verified, unavailable, unknown, conflict, and pending approval;
- evidence detail always identifies scope, source, timestamp, and whether the result is proof or only an observation;
- tool cards emphasize state and provenance before raw arguments;
- ledger rows emphasize sequence, scope, verification range, and record link without presenting a partial page as complete history;
- recovery review keeps plan digest, operation identity, current applicability, and the applied result in the same flow;
- settings and connections use grouped sections and explicit setup state, never credential previews.

### Accessibility and motion

- all evidence state labels remain available as text;
- semantic status roles are used for asynchronous status and alert conditions;
- focus moves to a newly opened detail and returns to the triggering control;
- data tables retain a list mode on mobile and do not depend on cell position alone for labels;
- no animation is used to imply that unknown evidence became verified;
- reduced motion preserves the same state sequence with immediate updates.

### Risks and trade-offs

- Evidence emphasis can make the chat feel more technical than the conversational brief.
- Persistent evidence can compete with the transcript unless it remains compact and collapses on mobile.
- Status rails can become another card grammar if not kept as lines, labels, and dividers.

## 8. D01.05 user approval gate

D01.05 remains **pending user approval**. Before implementation work begins, the user needs to choose whether the next design effort follows:

1. Direction A, Operational Clarity;
2. Direction B, Evidence First;
3. a deliberate combination with one shared visual grammar and an explicitly named priority;
4. neither direction, with a new bounded direction requested separately.

The approval decision must also settle:

- whether the current route slugs and navigation labels remain unchanged;
- whether the current neutral/orange palette remains the only palette;
- whether serif headings remain limited to welcome and major display moments;
- whether the current compact transcript and bounded notices region are mandatory for the next implementation slice;
- whether D01.05 approval authorizes only token and primitive work, or also route-level composition changes;
- which evidence states must be visible in the first viewport;
- which mobile and tablet widths receive the next visual verification pass.

No implementation may infer approval from the existence of this document. No screenshots, product-code changes, Apple build, or release claim are part of D01.05.

## 9. Evidence limits

This is a source/design audit. It does not claim:

- physical-device layout certification;
- VoiceOver or TalkBack certification;
- 200 percent browser zoom certification;
- real provider streaming or live pending-approval behavior;
- server-side pagination correctness beyond the current source contract;
- complete history verification beyond the recorded scope;
- visual approval of either proposed direction;
- implementation readiness or release readiness.

Any future D01 implementation must keep those limits visible and attach new evidence to the specific change rather than extending the current audit claim.
