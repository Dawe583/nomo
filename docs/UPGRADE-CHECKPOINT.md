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

## Next work, in plan order

1. Finish M1 provider-specific client-crash and persistence certification.
2. R05 Git/rename and R06 durable multi-operation planning/checkpoints.
3. R07 runtime provenance and dependency-aware recovery.
4. R08/R09 executable provider adapters with disposable-service conformance.
5. R10 cloud budgets, R11 staged/cascading cancellation, R12/R13 SDK and enforced
   host boundaries, R14 offline completeness and operational release evidence.

Connected OAuth, registry classifications and fixture tests are not substitutes
for certified provider recovery. No production account mutation, provider
activation or live-service certification was part of this verification.
