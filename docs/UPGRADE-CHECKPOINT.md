# VOID completion checkpoint

This increment follows `REVERSE-TOOL-UPGRADE-PLAN.md`, `GUI-UPGRADE-PLAN.md`
and the terminal acceptance requirements in `EXECUTION-PLAN.md`. It is not
completion of the reverse roadmap or certification of every marketing claim.
Product reference remains the pinned `Dawe583/void-empty` revision in the plan.

## Delivered

### Recovery persistence evidence

Twenty new tests inject failures immediately before and after selected journal
appends and encrypted vault writes. A real local signed journal, reservation
vault and disposable SQLite target survive fresh runtime instances. Tests check
forward/inverse effect counts, recovered content, signed receipts, retained
capacity, reconciliation and refusal to repeat uncertain effects. A deliberate
mutation releasing uncertain reservations made four cases fail.

These are persistence-call failures, not physical disk failure, network partition
or PostgreSQL client process death. They do not cover every reserve/release/read
failure or cross-operation provider receipt binding. No production runtime change
was needed for these scenarios. M1 remains a verified subset.

### Terminal safety

`void --help` and `void -h` succeed without creating workspace data. `tui --once`
returns nonzero for invalid proxy evidence as well as managed evidence.
Escape and Ctrl+C cancel only the selected active conversation; viewing an idle
conversation does not cancel another run. The terminal restores raw mode,
alternate screen and bracketed paste on normal exit, handled signals and fatal
exceptions. SIGKILL cannot run a cleanup handler and is not covered by that claim.

Actual PTY tests cover 80, 120 and 200 columns, SIGINT/SIGTERM/SIGHUP, fatal
exceptions, explicit process exit and selected-versus-other conversation state.
Transient macOS PENDIN is excluded from termios comparison; other fields are checked.

### Discoverable document recovery

Conversation context now includes searchable retained operation history, including
paths whose documents were deleted. Editor history reuses the same reviewed Undo
dialog. The server remains the authority for availability, conflict refusal and
execution. No new inverse logic or provider permissions were added to the GUI.

Preview content stays fixed until explicit refresh. Absent documents, empty files
and unavailable content have distinct labels. Pending Undo cannot be dismissed
through Escape, backdrop or the close button, and its ledger link is disabled.
Nested dialogs keep keyboard focus and close only their own layer. Confirmed
recovery refreshes document state while preserving audit history.

This history is scoped to the selected conversation and retained operations, not
a global multi-operation incident planner. Approval still uses the existing
operation-ID confirmation API with server revalidation, not a client-supplied
recovery-plan digest.

## Fresh verification

- `pnpm run check`: typechecks passed; 656 tests in 11 suites passed; 13 cloud
  tests passed and four opt-in integration tests were skipped.
- `pnpm run test:tui`: 15 Node tests and expanded real PTY checks passed.
- `node scripts/src/e2e-arc.mjs all`: passed the SDK, approval and ledger arc.
- `pnpm run build`: Vite, Nitro and cloud artifact validation passed. Existing
  large-bundle warnings remain; no performance certification is implied.
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --offline`:
  four native tests passed.
- `pnpm --dir apps/desktop run prepare:runtime` and
  `VOID_TEST_PACKAGED=1 pnpm run desktop:test`: fresh bundled Node 24.21.0 runtime,
  shared web assets, foreign-origin refusal and owner shutdown passed on macOS arm64.
- `node apps/desktop/scripts/build.mjs --bundles app`: built
  `apps/desktop/src-tauri/target/release/bundle/macos/VOID.app` with an ad-hoc
  local signature. Not notarized and not a published installer.
- The built executable passed `--smoke-test` and `--smoke-mobile`: bundled
  runtime, rendered native WebView, Blob download and mobile toolbar checks.
  These native smoke checks do not repeat the browser's document recovery flow.

Playwright against a disposable local provider fixture verified 1280x720 and
390x844 flows: create/delete through real managed tools, discover deletion,
preview/cancel without mutation, exact-content restoration and repeated-Undo
refusal. A deliberately delayed real POST proved busy dismissal protection.
Preview stayed unchanged across a focus event and query invalidation. A human
edit after preview caused a conflict, preserved the newer content and disabled
retry until refresh. Nested editor/context keyboard and focus behavior passed.
The page had no horizontal overflow at those two tested widths.

Browser checks used DOM and real API state, not screenshots: screenshot capture
timed out. Chrome DevTools was unavailable because its profile was already owned;
Playwright provided the independent browser. Existing local `/api/integrations`
404 fallback messages remain. Physical phones, screen readers, complete visual
regression, Windows native build and notarization were not verified here.

## Concurrent upstream integration

GitHub main advanced to `6534b04` during this work. Its adapter conformance
command and Windows cooperative filesystem checks were preserved and merged,
not overwritten. The final counts above include both sets of changes. See
`ADAPTER-CONFORMANCE.md` for that separately delivered capability and its limits.
The combined source passed the full typecheck/test and web/cloud build gates.

## Current reverse tool increment

### Cooperative filesystem rename

`filesystem.managed` now captures and recovers a rename between two validated
regular file paths. The source must exist and the destination must be absent.
The plan binds both resource revisions, survives restart, restores exact bytes
and POSIX mode, and refuses detected destination drift, ABA, source recreation,
symlinks and hardlinks. Literal version 1 write and delete captures remain
recoverable by the additive adapter.

Rename is verified only on POSIX. Windows refuses it before dispatch. Node has no
portable atomic no replace rename primitive. A concurrent external writer can
still create a destination or recreate a source after the final check and have
it replaced by native rename. The adapter is therefore limited to an explicitly
cooperative workspace with external concurrent writers excluded. This is not a
universal filesystem interception or Git recovery claim.

### Persistent recovery jobs

The local runtime now persists a signed plan for one run or an explicit operation
list. The digest binds the full plan and exact journal sequence and hash boundary.
Apply loads that stored plan, executes successful operations in reverse journal
order, records every checkpoint and resumes after restart without repeating a
confirmed inverse. Conflict stops later steps. Unknown recovery requires explicit
reconciliation. Missing local prerequisites produce a redacted, resumable paused
state that keeps forward writes blocked.

Only one recovery job can be active in a workspace. Signed job payloads validate
outer and embedded identity, digest, checkpoint bounds, outcome prefix and
residual shape. Cloud managed documents and local/retained MCP/SDK hosts expose
the same constrained plan/status/apply job surface on that runner. This slice has
no dependency closure, time or checkpoint selection, branch continuation,
scheduler, lease, external fencing or cloud MCP job surface. Any forward operation
after planning makes the preview stale. Older binaries do not read job entries,
so mixed runtime versions are unsupported.

### Truthful local capability surfaces

The local control plane now returns explicit `supported:false` responses for
`/api/agents`, `/api/integrations` and `/api/demo/status` instead of expected
404 responses. Settings hide unavailable cloud agent controls and link to the
published beta 4 macOS and Windows assets. CLI and proxy package documentation
now describes runnable commands, transports, replay and recovery requirements,
and current unsupported marketing examples without promoting metadata to
recovery evidence.

### Managed Git recovery

`git.managed` version 1 adds structured POSIX worktree create, write, delete and
rename plus logical index stage and unstage. Capture binds repository layout,
HEAD, the selected worktree state and index entries. Worktree recovery preserves
unrelated staging when selected endpoint entries remain exact. Index recovery
conservatively conflicts on any later index generation change, preserving human
state instead of weakening selected-entry ABA checks.

Index installation uses an owned real `index.lock`, a private copied index,
strict version 2 parsing, complete logical manifest checks and atomic install.
The adapter refuses sparse, split, unmerged, unsupported flag or extension
profiles, active Git operations, Git administrative aliases, symlinks,
hardlinks and submodule paths. Fixed Git plumbing has bounded redacted output
and disables prompts, hooks, filters, credential helpers and lazy fetching.

This remains a cooperative POSIX subset. Stage can retain selected bytes as a
dangling content-addressed Git blob until garbage collection. Git has no
operation-specific durable receipt here, so both response-loss reconciliation
paths remain unknown. Windows, process death, power loss, commits, history,
branches, remotes, directories and noncooperative writers are excluded. See
`MANAGED-GIT.md` for the exact contract.

### Integrated verification

- `pnpm run check` passed all typechecks and 709 workspace tests. The cloud group
  passed 13 offline tests and skipped four opt in live integration tests.
- `pnpm test:reverse` passed 550 core tests: ledger 49, policy 75, registry 38,
  proxy 80, connectors 119, runtime 63, CLI 88, SDK 10 and workbench 28.
- Focused integrated recovery job tests passed 12 of 12. Focused rename suites
  passed 20 tests with one Windows specific test skipped on macOS.
- The final Git adapter, CLI, MCP and conformance suite passed 40 tests with one
  Windows-only refusal skipped on macOS. Independent security and conformance
  reviews returned GO after adversarial fixes.
- The disposable `git.managed` command passed six POSIX scenarios and all 48
  shared runtime checks. Its report explicitly sets `certification:false` and
  `sharedRuntimeChecksOnly:true`.
- `pnpm run build` passed Vite, Nitro, workflow and cloud artifact validation.
  The existing large web chunk warning remains and is not a performance claim.
- A credential empty local server returned the three capability responses with
  HTTP 200. Playwright loaded settings, connections and demo with no console
  errors, showed the unavailable cloud fallbacks and found both beta 4 links.

No production account, live provider, secret or external mutation was used.
The four live integration skips, physical Windows execution, installer signing,
notarization and download execution remain outside this evidence.

## Next work, in plan order

1. Finish M1 provider specific client crash and persistence certification.
2. Design append-only managed commit recovery using a new revert commit or
   recovery PR, with no reset or force push.
3. R07 runtime provenance and dependency aware recovery.
4. R08 and R09 executable provider adapters with disposable service conformance.
5. R10 cloud budgets, R11 staged and cascading cancellation, R12 and R13 SDK and
   enforced host boundaries, then R14 operational release evidence.

Connected OAuth, registry classifications and fixture tests are not substitutes
for certified provider recovery. No production account mutation, provider
activation or live service certification was part of this verification.
