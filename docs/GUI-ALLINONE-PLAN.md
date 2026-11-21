# NOMO all-in-one GUI plan

Goal: one NOMO application that operators use all day. It keeps the
reversibility core (classify, decide, signed ledger, verified undo,
offline attestation) and adds the daily driver surfaces of Hermes Agent
Desktop, with the operator's real tools preconfigured: the 16 MCP
servers from prime-agent, the 3 opencode MCP servers, prettier, and the
prime-agent bridge. Nothing here invents business intent and nothing
autonomously touches a production account (STANDARDS 7).

Non-goals: copying any codebase (licenses forbid it), background
subagent fleets, cloud hosting, billing, Vim emulation, image paste.
Each has one honest line below and stays out of the phases.

## 1. Baseline this plan builds on

- Desktop: Tauri 2, macOS 13.5 plus Windows x64, bundled Node 24,
  loopback backend, ad-hoc signature only (`apps/desktop/README.md`).
- Web control plane: chat, sessions, documents, ledger browser,
  approvals, policy, tools, models, usage, settings
  (`apps/control-plane/ui/src`).
- TUI: full Claude parity for keys and commands, verified undo,
  conformance, attest, standalone offline verifier
  (`packages/cli/src/tui`).
- Shared core: one Workbench, one signed ledger, one registry. GUI, TUI
  and desktop read the same state; no surface keeps its own copy.
- prime-agent binary present on the operator machine with 16 MCP
  servers: ccxt-markets, chrome-devtools, cloudflare-cloud,
  coingecko-markets, context7, dbhub-readonly, fetch, figma-cloud,
  github, linear-cloud, notion-cloud, playwright, sentry-cloud,
  supabase, vercel-cloud, xcodebuild.
- opencode user config: tokenharbor provider, chrome-devtools,
  playwright, fetch MCP, prettier formatter, prime-model-sync plugin.

## 2. Hermes feature map to NOMO equivalents

| Hermes surface                     | NOMO equivalent                                         | State                      |
| ---------------------------------- | ------------------------------------------------------- | -------------------------- |
| Chat-first window, left sidebar    | Control plane chat plus sessions                        | Exists, needs F1 polish    |
| Same sessions everywhere           | Shared Workbench across TUI, GUI, desktop               | Exists                     |
| Streaming tool activity            | Live feed, run status                                   | Exists, needs preview rail |
| Right preview rail                 | New: document, diff and tool output rail                | Missing, F1                |
| Drag and drop attach               | New: file drop quotes managed document context          | Missing, F2                |
| Composer history and queue edit    | TUI has both; GUI needs queue edit                      | Partial, F1                |
| Context meter with breakdown       | TUI has counts; GUI needs meter plus categories         | Partial, F1                |
| Model picker in composer           | Exists in TUI; GUI picker needs effort presets          | Partial, F2                |
| Artifacts gallery                  | New: searchable outputs with session jump back          | Missing, F3                |
| Git review pane with commit and PR | Read-only diff exists; commit and PR are new            | Partial, F3                |
| Memory graph                       | Taint graph exists as helpers only; needs product graph | Missing, F4                |
| Cron scheduled jobs                | No equivalent; needs real queue, stays planned          | Missing, F5                |
| Profiles (isolated configs)        | No equivalent; needs storage partitions                 | Missing, F5                |
| Skills browse and manage           | No equivalent; registry of connector skills             | Missing, F4                |
| Command palette (Cmd+K)            | New: actions, pages, sessions, models, themes           | Missing, F2                |
| Status bar with toggles            | New: model, approvals, ctx, ledger head                 | Missing, F1                |
| Session search by id               | Exists in TUI; GUI needs it                             | Partial, F2                |
| Provider and key settings          | Exists; needs local model first run wizard              | Partial, F2                |
| MCP servers settings               | Exists; needs one click connect per server              | Partial, F2                |
| Plugin SDK                         | Out of scope; explicit non-goal for this plan           | Excluded                   |

## 3. Default preconfigured tools

Principle: every default tool ships with a registry classification,
a policy default and an Undo story, or it does not ship. The default
policy holds everything that is not R0; unknown tools stay denied.

- Documents (R0 read, R1 write with captured Undo): built in, on.
- The 16 prime-agent MCP servers: connected through the managed
  connector flow with per-connector policy files. Read-only servers
  (dbhub-readonly, fetch, context7) default to narrower rules; money
  and mutation servers (github, vercel-cloud, supabase, linear-cloud,
  notion-cloud, sentry-cloud, cloudflare-cloud, coingecko-markets,
  ccxt-markets, figma-cloud) default to hold with rationale.
- Browser automation (playwright, chrome-devtools): hold by default,
  one active session, no speculative execution.
- xcodebuild: hold by default, macOS only, refuses without Xcode.
- prettier: format on save for managed documents, R1 with Undo.
- prime-agent bridge: harness setting (cloud or prime-agent), present
  in TUI `/harness` and GUI settings, same persisted preference.
- No credentials in the repo, docs, browser storage or logs. Keys live
  in OS keychain (desktop) or mode-0600 files (CLI), same as today.

## 4. Reversibility core stays visible in every view

- Approvals show class, radius with exact, bounded or unknown
  precision, matched registry case, rule id and rationale.
- Undo always previews a diff, states the drift check, rechecks before
  applying, and signs the recovery.
- Ledger browser verifies chain and signatures; export plus
  attestation verify with the standalone script without this software.
- Conformance report per adapter ships in the build it describes.
- Denials name the rule id, the class and the approval path.

## 5. Phases with exit criteria

Every phase ends with commands that run, green on main, pushed.
No phase starts until the previous gate is green.

### F1: command deck (chat, rail, meter, status, queue)

- Right preview rail for the open document, unified diff and the
  latest tool result, side by side with chat.
- Context meter with per-category tokens in chat; queue editing for
  prompts sent during a run.
- Status bar: model, approvals count, ctx, ledger head, theme toggle.
- Exit: `pnpm --filter @nomo/control-plane-ui typecheck`,
  `node scripts/src/check-tests.mjs` green, manual pass on 13 inch
  and 4K widths with keyboard only.

### F2: find and configure (palette, search, providers, MCP)

- Cmd+K palette: actions, pages, sessions by id, models, themes.
- First-run provider wizard with local models (Ollama, LM Studio)
  detected, not assumed.
- One click MCP connect per default server with its policy file shown
  before enabling; failed validation blocks with the reason.
- Drag and drop files quote managed document context on send.
- Exit: palette and wizard covered by UI tests; MCP refusal test per
  server; check-tests green.

### F3: ship from the app (artifacts, git review)

- Artifacts gallery with session jump back, download and open actions.
- Git pane: branch status, uncommitted and branch diffs, stage,
  revert (append-only revert commit, never reset or force push),
  commit message generation, PR through `gh` only when installed.
- Exit: disposable-repo tests for revert and PR refusal paths;
  check-tests green.

### F4: knowledge (skills, taint graph)

- Skills registry: browse, enable, disable connector skills with the
  policy shown; no silent skill file execution.
- Taint graph view: descendant closure of operations ordering
  recovery, read from real ledger data.
- Exit: graph matches planner order on fixtures; skills tests green.

### F5: time and isolation (cron, profiles)

- Cron needs a real queue with durable leases; profiles need storage
  partitions. Both depend on R06 and R10 planning and budget work.
- Exit: queue and partition design doc plus one executable scheduler
  test against disposable targets; no mocks where a real clock or
  process boundary is the claim.

### F6: release gates (devices, access, signatures)

- Physical Android keyboards, screen readers, 200 percent
  zoom, measured LCP, INP and CLS, documented rollback.
- Windows installer smoke, Linux packaging smoke.
- Exit: acceptance matrix fully ticked with device names and build
  numbers; nothing illustrative ships as proven.

## 6. Explicitly not in this plan

- Background subagent fleets and speculative execution: conflicts
  with the single active run guarantee; needs R06 plus R11.
- Cloud hosting, billing and multiuser RBAC: separate product track.
- Vim emulation, image paste, suspend: documented TUI non-equivalents.
- Python transport and provider sandboxes: R12, needs EXT resources.
- Site claim audit and pricing: human decisions, G-00 and G-08 scope.

## 7. External resources that block phases

Physical Android devices; Windows and Linux machines;
disposable AWS, Supabase, GitHub and Vercel targets; npm scope
ownership and release authorization; production KMS. Nothing
autonomous touches a production account, a customer-visible surface
or real money.
