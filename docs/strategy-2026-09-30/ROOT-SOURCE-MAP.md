# Mapa CLI, workbench, skriptů, CI a download stránky

Automatický strukturální průchod textových souborů na baseline `4c560dd`. Symboly a počty testových deklarací jsou navigační index, nikoli důkaz sémantického přečtení nebo spuštění. Přesný rozsah ručního auditu uvádí ROOT-AUDIT.md. Binární fonty nejsou zdrojový kód.

| Soubor | Řádky | První deklarace | Testové deklarace |
|---|---:|---|---:|
| `.github/workflows/ci.yml` | 173 | — | 0 |
| `.github/workflows/cloud-integration.yml` | 72 | — | 0 |
| `.github/workflows/desktop-windows.yml` | 48 | — | 0 |
| `.github/workflows/manifest.yml` | 40 | — | 0 |
| `.github/workflows/pages.yml` | 38 | — | 0 |
| `packages/cli/README.md` | 73 | — | 0 |
| `packages/cli/bin/nomo.mjs` | 50 | argv, flag, parsed | 0 |
| `packages/cli/design/nomo-hold.tui` | 55 | — | 0 |
| `packages/cli/design/nomo-operations.tui` | 152 | — | 0 |
| `packages/cli/package.json` | 42 | — | 0 |
| `packages/cli/src/agent.ts` | 57 | runAgentCommand | 0 |
| `packages/cli/src/approve.test.ts` | 174 | call, fixture | 11 |
| `packages/cli/src/approve.ts` | 76 | ApproveCommandIo, ApproveCommandOptions, runApproveCommand, runApprovalsCommand, parseArgs, message | 0 |
| `packages/cli/src/argv.ts` | 57 | COMMANDS, Command, ParsedInvocation, parseInvocation | 0 |
| `packages/cli/src/batch3.test.ts` | 28 | fixtureDirectory | 1 |
| `packages/cli/src/classify.test.ts` | 153 | s3Delete, pgUpdate | 13 |
| `packages/cli/src/classify.ts` | 163 | TranscriptCall, ClassifyOutcome, ClassifyReport, classifyCall, classifyTranscript, formatClassifyReport, parseTranscript, REGISTRY_SIZE | 0 |
| `packages/cli/src/config.test.ts` | 56 | collect | 3 |
| `packages/cli/src/config.ts` | 77 | ConfigIo, ConfigDeps, ConfigEntry, resolveConfig, runConfigCommand | 0 |
| `packages/cli/src/conformance.test.ts` | 411 | — | 13 |
| `packages/cli/src/conformance.ts` | 569 | filesystemOperations, filesystemConformanceProfile, filesystemConformanceFixture, gitConformanceProfile, GitScenario, gitConformanceFixture, managedDocumentsConformanceProfile, managedPostgresConformanceProfile | 0 |
| `packages/cli/src/dispatch.ts` | 149 | packageVersion, runCommand | 0 |
| `packages/cli/src/doctor.test.ts` | 161 | collect, healthy, doctorWith | 8 |
| `packages/cli/src/doctor.ts` | 294 | DoctorIo, DoctorDeps, Status, message, defaultRun, defaultWritable, defaultPresent, runDoctorCommand | 0 |
| `packages/cli/src/evidence-integrity.test.ts` | 156 | workspace, scratch, seed, collect | 5 |
| `packages/cli/src/export-bundle.test.ts` | 452 | WORKSPACE, Fixture, operationEvent, fixture, run, lines, exportBundle, manifestOf | 13 |
| `packages/cli/src/export-bundle.ts` | 884 | BUNDLE_SCHEMA, CAPABILITY_SCHEMA, VAULT_MANIFEST_SCHEMA, MANIFEST_FILE, BUNDLE_SECTIONS, BundleSectionName, SECTION_FILES, bundleCategories | 0 |
| `packages/cli/src/feed.test.ts` | 119 | firstPage, secondPage | 5 |
| `packages/cli/src/feed.ts` | 116 | FeedCommandIo, FeedCommandOptions, runFeedCommand, closeActiveFeedWatch, FeedArgs, parseFeedArgs, defaultLedgerPath, printPage | 0 |
| `packages/cli/src/index.test.ts` | 32 | — | 3 |
| `packages/cli/src/index.ts` | 66 | COMMANDS, Command, ParsedInvocation, parseInvocation | 0 |
| `packages/cli/src/init.test.ts` | 113 | collect | 4 |
| `packages/cli/src/init.ts` | 150 | InitIo, InitDeps, message, InitOptions, resolveInitOptions, INIT_USAGE, pinVerifyKey, runInitCommand | 0 |
| `packages/cli/src/mcp-reverse-exercise.ts` | 200 | ORIGINAL, PATCHED, payload, bin, policy, runMcpReverseExercise | 0 |
| `packages/cli/src/metrics.ts` | 375 | METRICS_SCHEMA, DECISIONS, OTHER_DECISION, MetricSample, MetricsReport, CollectMetricsOptions, LedgerScan, decisionOf | 0 |
| `packages/cli/src/operations.test.ts` | 27 | — | 1 |
| `packages/cli/src/operations.ts` | 188 | LEDGER_FLAGS, BUNDLE_FLAGS, ATTEST_FLAGS, METRICS_FLAGS, Invocation, parse, ledgerTarget, ledgerPath | 0 |
| `packages/cli/src/postgres.ts` | 17 | postgresExecutor | 0 |
| `packages/cli/src/recovery-filesystem.test.ts` | 749 | backupTool, BackupHistory, BackupToolResult, toolJson, runBackupTool, backupToolFailure, copyBackup, planFailureCategory | 3 |
| `packages/cli/src/recovery-git.test.ts` | 92 | posixTest | 0 |
| `packages/cli/src/recovery-health.test.ts` | 207 | fixture | 5 |
| `packages/cli/src/recovery-health.ts` | 330 | RecoveryHealthStatus, RecoveryHealthReport, HealthInput, isMissing, numberField, addRepair, markUnavailable, legacyBytes | 0 |
| `packages/cli/src/recovery-job.test.ts` | 175 | — | 1 |
| `packages/cli/src/recovery-mcp.test.ts` | 528 | — | 6 |
| `packages/cli/src/recovery-mcp.ts` | 510 | Runtime, RecoveryErrorCategory, RecoveryErrorPayload, safeErrorMessages, RecoveryMcpError, errorMessage, classifyError, errorResult | 0 |
| `packages/cli/src/recovery-mode.test.ts` | 84 | workspace, executeWith | 4 |
| `packages/cli/src/recovery-paths.test.ts` | 36 | — | 1 |
| `packages/cli/src/recovery-paths.ts` | 48 | canonicalDestination, assertRecoveryStateOutsideRoot | 0 |
| `packages/cli/src/recovery.ts` | 411 | RecoveryMode, MODES, Config, runRecoveryCommand | 0 |
| `packages/cli/src/replay.test.ts` | 532 | argsDigest, snapshotDigest, page, reference, plan, manifestDir, fakeConnector, persistedFixture | 26 |
| `packages/cli/src/replay.ts` | 498 | SnapshotReference, ConnectorCall, InverseStep, InversePlan, DriftChange, ReplayRefusal, ApplyReport, RestoreReceipt | 0 |
| `packages/cli/src/s3.ts` | 25 | s3Executor | 0 |
| `packages/cli/src/taint.test.ts` | 151 | page, graph, options, record, node, ledgerFile | 5 |
| `packages/cli/src/taint.ts` | 163 | TaintCommandIo, TaintCommandOptions, TaintArgs, ResolvedLedger, USAGE, runTaintCommand, parseTaintArgs, needValue | 0 |
| `packages/cli/src/tui/README.md` | 122 | filters | 0 |
| `packages/cli/src/tui/approvals.ts` | 49 | HeldCall, countdown, radius, approvalsView | 0 |
| `packages/cli/src/tui/brand.ts` | 28 | pixel, brandHeader | 0 |
| `packages/cli/src/tui/caps.ts` | 71 | CapabilityStream, positive, detectCapabilities | 0 |
| `packages/cli/src/tui/fixtures.ts` | 126 | startedAt, previewState, previewHold | 0 |
| `packages/cli/src/tui/index.ts` | 10 | — | 0 |
| `packages/cli/src/tui/inline.ts` | 28 | renderInlineCall | 0 |
| `packages/cli/src/tui/layout.ts` | 349 | ANSI_PATTERN, UNPRINTABLE, sanitizeText, stripAnsi, cellWidth, visibleLength, fit, pad | 0 |
| `packages/cli/src/tui/live.test.ts` | 78 | view | 4 |
| `packages/cli/src/tui/live.ts` | 96 | LiveView, liveRecords, renderLiveFeed | 0 |
| `packages/cli/src/tui/modal.ts` | 182 | renderHoldPrompt, HoldResolution, RawInput, promptForHold | 0 |
| `packages/cli/src/tui/preview.ts` | 39 | ILLUSTRATIVE, dimensions, width, height, detected, capabilities, state | 0 |
| `packages/cli/src/tui/runtime.ts` | 103 | WatchRuntimeOptions, WatchRuntime | 0 |
| `packages/cli/src/tui/theme.ts` | 126 | NOMO_PALETTE, CLASS_MARKER, DECISION_MARKER, Tone, ANSI_16, ANSI_256, trueColor, paint | 0 |
| `packages/cli/src/tui/tui.test.ts` | 591 | capabilities | 35 |
| `packages/cli/src/tui/types.ts` | 143 | ReversibilityClass, CallDecision, CallStatus, PipelineStage, InterceptedCall, PendingHold, ResolvedState, ResolvedHold | 0 |
| `packages/cli/src/tui/views.ts` | 118 | renderHelp, renderReplayPreview, renderLedgerVerification | 0 |
| `packages/cli/src/tui/visual-states.test.ts` | 98 | — | 5 |
| `packages/cli/src/tui/watch.ts` | 424 | CONTEXT_THRESHOLD_AMBER, CONTEXT_THRESHOLD_RED, STAGES, stageLine, header, activityRows, detailRows, metrics | 0 |
| `packages/cli/src/tui/workspace-approval.test.ts` | 172 | — | 1 |
| `packages/cli/src/tui/workspace-controls.test.ts` | 477 | fixture | 12 |
| `packages/cli/src/tui/workspace-mcp.test.ts` | 320 | SECRET, assistant, upstream, workspace | 9 |
| `packages/cli/src/tui/workspace-parity.test.ts` | 1152 | assistantFetcher, fixtureApp | 49 |
| `packages/cli/src/tui/workspace-proxy.test.ts` | 77 | — | 1 |
| `packages/cli/src/tui/workspace-proxy.ts` | 132 | ProxyWorkspace | 0 |
| `packages/cli/src/tui/workspace-runner.ts` | 1106 | WorkspaceShortcut, workspaceShortcut, ChordTracker, nextPromptRow, WorkspaceInput, runWorkspaceTui | 0 |
| `packages/cli/src/tui/workspace-terminal.test.ts` | 68 | exec, binary | 4 |
| `packages/cli/src/tui/workspace.test.ts` | 962 | — | 34 |
| `packages/cli/src/tui/workspace.ts` | 3572 | WORKSPACE_TABS, WorkspaceTab, WORKSPACE_VIEWS, workspaceTab, Item, Confirmation, json, text | 0 |
| `packages/cli/src/verify.test.ts` | 137 | workspace, Body, seedLedger | 5 |
| `packages/cli/src/verify.ts` | 273 | VerifyCommandIo, VerifyCommandOptions, VerifyArgs, USAGE, ResolvedVerifyKey, runVerifyCommand, parseVerifyArgs, resolveVerifyKey | 0 |
| `packages/cli/src/watch.test.ts` | 39 | — | 4 |
| `packages/cli/src/watch.ts` | 182 | resolveLedgerPath, runWatchCommand | 0 |
| `packages/cli/tsconfig.json` | 18 | — | 0 |
| `packages/workbench/README.md` | 81 | — | 0 |
| `packages/workbench/package.json` | 35 | — | 0 |
| `packages/workbench/src/agents.test.ts` | 94 | profile, fixture, models, response | 5 |
| `packages/workbench/src/agents.ts` | 100 | AgentProfile, Hook, CompactionResult, AGENT_LIMITS, validateAgentProfile, validateHook | 0 |
| `packages/workbench/src/connector.test.ts` | 250 | catalogServer, provider, connectorState | 7 |
| `packages/workbench/src/context.test.ts` | 25 | — | 2 |
| `packages/workbench/src/context.ts` | 45 | compactMessages | 0 |
| `packages/workbench/src/default-agent.test.ts` | 81 | — | 1 |
| `packages/workbench/src/gui.test.ts` | 440 | — | 14 |
| `packages/workbench/src/gui.ts` | 517 | page, sessionPatch, preferencePatch, documentView, filterRows, MAX_QUEUED_RUNS, PermissionMode, DEFAULT_LOCAL_PERMISSION_MODE | 0 |
| `packages/workbench/src/index.ts` | 2542 | SessionEvent, SessionView, RETIRED_MODEL_IDS, DEFAULT_POLICY, AGENT_PRESETS, denialText, reversalFor, UnknownToolOutcome | 0 |
| `packages/workbench/src/lifecycle.test.ts` | 149 | — | 4 |
| `packages/workbench/src/managed-documents.test.ts` | 221 | fixture | 6 |
| `packages/workbench/src/managed-documents.ts` | 223 | Input, managedDocumentAdapter | 0 |
| `packages/workbench/src/mcp.ts` | 109 | validateEndpoint, McpConfig, McpTool, rpc, catalog | 0 |
| `packages/workbench/src/parity-runtime.test.ts` | 143 | complete | 4 |
| `packages/workbench/src/permission-authority.test.ts` | 125 | models, complete, configured | 6 |
| `packages/workbench/src/policy-review.test.ts` | 185 | mcpServer, callingProvider, DELETE_TOOL, DELETE, facts, denyDeletes, allowAll, confirmedConnector | 4 |
| `packages/workbench/src/provider-defaults.test.ts` | 164 | freeModel, workspace | 5 |
| `packages/workbench/src/provider-defaults.ts` | 100 | FREE_MODEL_BY_ORIGIN, NVIDIA_URL, TOKENROUTER_URL, OPENCODE_ZEN_URL, PROVIDER_PRESETS | 0 |
| `packages/workbench/src/provider-native.test.ts` | 24 | — | 1 |
| `packages/workbench/src/provider-retry.test.ts` | 81 | config, freeModel, answer | 5 |
| `packages/workbench/src/provider-stream.test.ts` | 180 | config, frame, stream | 7 |
| `packages/workbench/src/provider.ts` | 190 | ProviderRequestError, ProviderKind, ProviderConfig, normalizeProviderConfig, Model, ModelMessage, ToolCall, ModelReply | 0 |
| `packages/workbench/src/recovery-jobs.test.ts` | 143 | fixture | 7 |
| `packages/workbench/src/recovery-jobs.ts` | 40 | RecoveryRequest, RecoveryApply, identity, recoveryRequest, runtimeSelection, recoveryOperationMap, recoveryPreview, recoveryResult | 0 |
| `packages/workbench/src/request-digest.test.ts` | 144 | MODEL, conversation, TOOLS, wholeHistory, incremental | 3 |
| `packages/workbench/src/reversal-record.test.ts` | 181 | MODEL, PROFILE, Body, governedSession | 3 |
| `packages/workbench/src/safety-boundaries.test.ts` | 80 | fixture, paused | 4 |
| `packages/workbench/src/storage.test.ts` | 96 | directory, deadPid | 6 |
| `packages/workbench/src/storage.ts` | 98 | LocalStorage, acquireLock, sameFile | 0 |
| `packages/workbench/src/tool-catalog.test.ts` | 48 | — | 4 |
| `packages/workbench/src/tool-catalog.ts` | 18 | toolCatalog | 0 |
| `packages/workbench/src/workbench.test.ts` | 1303 | secret, reply, root | 30 |
| `packages/workbench/src/workspace.test.ts` | 86 | write | 6 |
| `packages/workbench/src/workspace.ts` | 120 | WorkspaceOperation, WorkspaceState, WorkspaceResult, WorkspaceTransition, WorkspaceUndoPreview, WORKSPACE_LIMITS, workspaceTools, createWorkspace | 0 |
| `packages/workbench/tsconfig.json` | 1 | — | 0 |
| `scripts/fresh-install.sh` | 57 | — | 0 |
| `scripts/ledger-verify.mjs` | 142 | root, ledger, entries, dir, keyDir, signer, workspace, store | 0 |
| `scripts/package.json` | 25 | — | 0 |
| `scripts/src/agentic-reverse-exercise.mjs` | 207 | WORKSPACE, MODE, ORIGINAL, PATCHED, HUMAN, base64, revision, runAgenticReverseExercise | 0 |
| `scripts/src/agentic-reverse-exercise.test.mjs` | 27 | — | 3 |
| `scripts/src/bench.mjs` | 242 | summarize, forward, append, declaredFacts, classify, main | 0 |
| `scripts/src/bench.test.mjs` | 79 | execute, script, run, assertMetrics | 3 |
| `scripts/src/build-web.mjs` | 284 | GENERATOR, SOURCE, STYLESHEET, BEGIN, END, ROLE_PROPERTIES, declare, roleDeclarations | 0 |
| `scripts/src/capability-profile-gate.test.mjs` | 194 | shipped, assertDatedCertificationDecision | 5 |
| `scripts/src/cdp.mjs` | 250 | chromiumCandidates, findChromium, chromiumAvailable, launchBrowser, Channel, openPage, withBrowser | 0 |
| `scripts/src/check-apple-project.mjs` | 110 | root, apple, projectDirectory, generatedPlist, writtenElsewhere, excluded, generated, scratch | 0 |
| `scripts/src/check-cloud-build.mjs` | 29 | output, json, file, config, staticRoot, html, assets, apiRoot | 0 |
| `scripts/src/check-cloud-integration.mjs` | 72 | root, run, output | 0 |
| `scripts/src/check-cloud.mjs` | 127 | fixture, base | 0 |
| `scripts/src/check-managed-cloud.mjs` | 132 | testUrl, target, secret, fixture, server, listen, close, id | 0 |
| `scripts/src/check-protocol-fixtures.test.mjs` | 49 | fixtureRoot, outcomes | 1 |
| `scripts/src/check-registry-mirror.mjs` | 73 | root, canonical, sitePath, mirror, body, a, b, digest | 0 |
| `scripts/src/check-reverse-engine.mjs` | 16 | root, packages | 0 |
| `scripts/src/check-tests-timeout.test.mjs` | 141 | root, runner, runGate, outputOf | 6 |
| `scripts/src/check-tests.mjs` | 402 | root, packagesDir, DEFAULT_SUITE_TIMEOUT_MS, suiteTimeoutMs, results, suites, cloudDir, pythonSuites | 0 |
| `scripts/src/ci-time-budgets.test.mjs` | 104 | everyWorkflow, perStepBudgeted, jobs | 0 |
| `scripts/src/cloud-boundaries.test.mjs` | 131 | — | 4 |
| `scripts/src/cloud-test-config.mjs` | 48 | validateCloudTestEnvironment, validateCloudTestProxy, configureCloudTest | 0 |
| `scripts/src/cloud-test-config.test.mjs` | 60 | url | 3 |
| `scripts/src/cloud-test-preload.mjs` | 2 | — | 0 |
| `scripts/src/companion-fixtures.mjs` | 539 | protocol, outcomes, rootFields, implementationFields, requestFields, operations, mutations, responseFields | 0 |
| `scripts/src/companion-fixtures.test.mjs` | 234 | digest, root | 7 |
| `scripts/src/design-source-swift.test.mjs` | 241 | ROOT, SOURCE, PACKAGE, GENERATED, read, tokens, section, declaration | 12 |
| `scripts/src/design-source.test.mjs` | 421 | SOURCE, STYLESHEET, GENERATOR, document_, stylesheet, LITERAL, leaves, luminance | 10 |
| `scripts/src/design-token.test.mjs` | 439 | TOKENS, LITERAL_EXEMPT, STYLESHEETS, read, tokenFiles, LITERAL, lightCanvas, normalise | 11 |
| `scripts/src/doc-truth.test.mjs` | 525 | SOURCE_ROOTS, OPERATIONAL, INVENTORY, SUPERSEDED, read, PATH_LIKE, markdownFiles, deadPaths | 9 |
| `scripts/src/docs-release.test.mjs` | 52 | writtenFiles | 3 |
| `scripts/src/e2e-arc.mjs` | 205 | root, fixturesPolicy, fixturesUpstream, rawFacts, strictFacts, strictFactsPath, passLines, failures | 0 |
| `scripts/src/e2e-connectors.mjs` | 403 | encoder, decoder, passLines, failures, pass, fail, check, runAllChecks | 0 |
| `scripts/src/e2e-connectors.test.mjs` | 38 | — | 5 |
| `scripts/src/e2e-final.mjs` | 485 | root, rootPath, passLines, failures, notes, pass, fail, note | 0 |
| `scripts/src/e2e-final.test.mjs` | 29 | execFileAsync, script, root | 1 |
| `scripts/src/e2e.mjs` | 249 | passLines, failures, pass, fail, check, ScriptInput, waitFor, strictFactsPath | 0 |
| `scripts/src/e2e.test.mjs` | 17 | — | 1 |
| `scripts/src/fixtures/managed-postgres-crash-worker.mjs` | 71 | config, url, pool, connect, signer, runtime | 0 |
| `scripts/src/gateway.test.mjs` | 47 | response | 1 |
| `scripts/src/generate-swift-tokens.mjs` | 545 | GENERATOR, SOURCE, TARGET, BEGIN, END, HEADER, RESERVED, identifier | 0 |
| `scripts/src/handbook.test.mjs` | 419 | EN, CS, SOURCE_ROOTS, read, withoutFences, occurrences, en, cs | 13 |
| `scripts/src/licence-line.test.mjs` | 421 | ROOT, CLOSED, OPEN_CORE, REQUIRED_OPEN, read, readJson, flat, packages | 9 |
| `scripts/src/load-proxy.mjs` | 63 | durationMs, pendingTimers, upstream, server, address, url, started, deadline | 0 |
| `scripts/src/moment.mjs` | 150 | here, root, policyText, loaded, args, scenarios, checkedDecision, runScenario | 0 |
| `scripts/src/moment.test.mjs` | 50 | execFileAsync, moment, runMoment | 2 |
| `scripts/src/preinstall.mjs` | 27 | root, agent | 0 |
| `scripts/src/preview-beta.mjs` | 30 | root, temp, model, app, stop | 0 |
| `scripts/src/preview-cloud.mjs` | 28 | app | 0 |
| `scripts/src/preview-mobile-demo.mjs` | 71 | values, app, server, close | 0 |
| `scripts/src/preview-workspace.mjs` | 46 | port, modelPort, directory, model, app, close | 0 |
| `scripts/src/prime-bridge.mjs` | 254 | primeArguments, primeEvent, runBridge | 0 |
| `scripts/src/prime-bridge.test.mjs` | 39 | — | 1 |
| `scripts/src/provision-cloud.mjs` | 52 | — | 0 |
| `scripts/src/recovery-backup.mjs` | 325 | manifestName, digestPattern, categories, RecoveryBackupError, refuse, sha256, fileDigest, portable | 0 |
| `scripts/src/release-evidence-matrix.test.mjs` | 396 | matrix, gaps, applePlan, windows, rows, range, requiredRows, stillOpen | 8 |
| `scripts/src/release-packaging.test.mjs` | 404 | root, read, manifest, packageDirs, directories, PUBLISHABLE, bins, CLEAN_INSTALL_RUN | 7 |
| `scripts/src/tokenise-hit-targets.py` | 106 | — | 0 |
| `scripts/src/ui-layout.test.mjs` | 539 | gateGap, skip, reportPromise, report, undriven, stateSkip | 29 |
| `scripts/src/ui-matrix.mjs` | 1862 | ROOT, DESKTOP_VIEWPORTS, PHONE_VIEWPORTS, SHORT_LANDSCAPE, VIEWPORTS, REQUIRED_ROUTES, GALLERY_PATH, GALLERY_ROOT | 0 |
| `scripts/src/verify-cloud-deployment.mjs` | 78 | secrets, url, request | 0 |
| `scripts/src/verify-gui-deployment.mjs` | 204 | target, secrets, directory, headers, request | 0 |
| `scripts/src/verify-ledger-standalone.test.mjs` | 67 | exec, script, dir, keys, key, store, keyId, spki | 3 |
| `scripts/src/verify-managed-postgres.mjs` | 815 | url, pool, suffix, root, connect, db | 0 |
| `scripts/src/verify-tui-terminal.py` | 282 | app, session, write, write, initialize | 0 |
| `scripts/team/prime-poll.sh` | 12 | — | 0 |
| `scripts/team/prime-spawn.sh` | 20 | — | 0 |
| `scripts/tui-capture.mjs` | 73 | root, preview, ansi, widths, quote, runInPty | 0 |
| `scripts/tui-degrade.mjs` | 85 | root, preview, widths, cases, emoji, control, unexpectedUnicode, quote | 0 |
| `scripts/tui-raw-mode-safety.mjs` | 49 | root, preview, quote, runInPty | 0 |
| `site/fonts/Instrument-Serif-LICENSE.txt` | 93 | — | 0 |
| `site/fonts/Inter-LICENSE.txt` | 93 | — | 0 |
| `site/fonts/JetBrains-Mono-LICENSE.txt` | 93 | — | 0 |
| `site/icon.svg` | 1 | — | 0 |
| `site/index.html` | 300 | — | 0 |
| `site/styles.css` | 500 | — | 0 |
