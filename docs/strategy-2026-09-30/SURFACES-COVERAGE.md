# Pokrytí dílčího auditu apps / cloud / marketing

Datum: 2026-09-30. Commit: `4c560dd98668da06e24b2189e854203fdcaa80a2`.

**Tento manifest neříká, že každý řádek byl sémanticky zkontrolován.** Všechny tracked soubory v přidělených adresářích byly inventarizovány; všechny textové soubory byly strojově otevřeny pro počty a modulový/symbolový index. Ruční analýza se zaměřila na authority boundary, routes, provider identity, release, onboarding a konkrétní výchozí stavy. Výpisy některých velkých souborů byly nástrojem zkráceny; řádky mimo doložené části se považují za indexované, nikoli přečtené. Žádná runtime/visual/native test evidence není touto dílčí statickou inspekcí prokázána. Root koordinuje testy a audit ostatních složek.

D = ručně inspektované relevantní části, nikoli automaticky celý soubor. I = inventář + text/symbol/keyword index bez úplné sémantické revize. B = metadata binárních artefaktů; video/image nebylo prohlíženo.

| Kategorie | Soubory | Textové řádky |
|---|---:|---:|
| authored source | 151 | 34175 |
| test | 69 | 11911 |
| generated/snapshot/fixture | 11 | 17102 |
| config/docs/metadata | 21 | 627 |
| binary | 6 | — |

Tracked souborů celkem: **258**. Ručně inspektované části: **32 souborů**. „Authored source“ zde znamená klasifikaci podle přípony a umístění, nikoli forenzní určení autora; testy, lockfiles a jasné snapshot/fixtures jsou vedeny zvlášť.

## Další ručně čtené kontexty

- `AGENTS.local.md` a root `package.json`: instrukce a script/dependency index. Novější uživatelův zákaz main write má přednost před historickým main pravidlem.
- `docs/10K-MRR-REALITY-CHECK.md`: čtený revenue model a gates; další připojené GTM/reverse docs částečně kvůli truncation, jejich tvrzení nejsou automaticky znovu ověřena.
- Osm competitor README přes GitHub connector: cílené feature/license texty; primární odkazy a datum v MARKET-RESEARCH.md. Codex sandbox doc je pouze rozcestník. Dvě issue searches: pět výsledků každá; nerozporovaná absence další feature se neodvozuje.
- Marketing companion `/workspace/void-site-audit`, commit `85c6792838f5014818d48e93188342cf3c824c8e`: pouze `void-site-audit/api/waitlist.ts`, `void-site-audit/api/_store.ts` (325–405), `void-site-audit/lib/db/src/schema/traffic.ts`, `void-site-audit/artifacts/void/src/lib/pricing.ts` (1–90), `void-site-audit/artifacts/void/src/sections/pricing.tsx` (118–145); prefix `void-site-audit/` označuje companion checkout, ne cestu v tomto repozitáři. Zbytek pouze cíleně vyhledán. Toto není úplný companion audit.

## Manifest po souborech

| Soubor | Řádky | Kategorie | Rozsah |
|---|---:|---|---|
| `apps/apple/CompanionProtocolKit/Package.swift` | 17 | authored source | I — textový index |
| `apps/apple/CompanionProtocolKit/Sources/CompanionProtocolKit/CompanionCachePolicy.swift` | 265 | authored source | I — textový index |
| `apps/apple/CompanionProtocolKit/Sources/CompanionProtocolKit/CompanionEnvelope+Decoding.swift` | 65 | authored source | I — textový index |
| `apps/apple/CompanionProtocolKit/Sources/CompanionProtocolKit/CompanionEnvelope.swift` | 126 | authored source | I — textový index |
| `apps/apple/CompanionProtocolKit/Sources/CompanionProtocolKit/CompanionHTTPClient.swift` | 376 | authored source | I — textový index |
| `apps/apple/CompanionProtocolKit/Sources/CompanionProtocolKit/DeviceCredentialStore.swift` | 143 | authored source | I — textový index |
| `apps/apple/CompanionProtocolKit/Sources/CompanionProtocolKit/Diagnostics.swift` | 37 | authored source | I — textový index |
| `apps/apple/CompanionProtocolKit/Sources/CompanionProtocolKit/EventModels.swift` | 186 | authored source | I — textový index |
| `apps/apple/CompanionProtocolKit/Sources/CompanionProtocolKit/EventReconnector.swift` | 156 | authored source | I — textový index |
| `apps/apple/CompanionProtocolKit/Sources/CompanionProtocolKit/Handshake.swift` | 75 | authored source | I — textový index |
| `apps/apple/CompanionProtocolKit/Sources/CompanionProtocolKit/JSONValue.swift` | 45 | authored source | I — textový index |
| `apps/apple/CompanionProtocolKit/Sources/CompanionProtocolKit/KeychainStore.swift` | 72 | authored source | I — textový index |
| `apps/apple/CompanionProtocolKit/Sources/CompanionProtocolKit/OperationStatus.swift` | 160 | authored source | I — textový index |
| `apps/apple/CompanionProtocolKit/Sources/CompanionProtocolKit/ProtocolContractDecoder.swift` | 100 | authored source | I — textový index |
| `apps/apple/CompanionProtocolKit/Tests/CompanionProtocolKitTests/CacheAndRemovalTests.swift` | 235 | test | I — textový index |
| `apps/apple/CompanionProtocolKit/Tests/CompanionProtocolKitTests/CompanionCoreTests.swift` | 97 | test | I — textový index |
| `apps/apple/CompanionProtocolKit/Tests/CompanionProtocolKitTests/EnvelopeAdapterTests.swift` | 390 | test | I — textový index |
| `apps/apple/CompanionProtocolKit/Tests/CompanionProtocolKitTests/PairedDeviceSecurityTests.swift` | 395 | test | I — textový index |
| `apps/apple/CompanionProtocolKit/Tests/CompanionProtocolKitTests/ProtocolContractDecoderTests.swift` | 169 | test | I — textový index |
| `apps/apple/CompanionProtocolKit/Tests/CompanionProtocolKitTests/SecurityRegressionTests.swift` | 200 | test | I — textový index |
| `apps/apple/Fixtures/Protocol/capability-handshake.json` | 133 | generated/snapshot/fixture | I — textový index |
| `apps/apple/Fixtures/Protocol/conflict.json` | 68 | generated/snapshot/fixture | I — textový index |
| `apps/apple/Fixtures/Protocol/denied.json` | 55 | generated/snapshot/fixture | I — textový index |
| `apps/apple/Fixtures/Protocol/revoked.json` | 52 | generated/snapshot/fixture | I — textový index |
| `apps/apple/Fixtures/Protocol/succeeded.json` | 62 | generated/snapshot/fixture | I — textový index |
| `apps/apple/Fixtures/Protocol/unknown.json` | 68 | generated/snapshot/fixture | I — textový index |
| `apps/apple/Fixtures/Protocol/unsupported-version.json` | 55 | generated/snapshot/fixture | I — textový index |
| `apps/apple/VOID.xcodeproj/project.pbxproj` | 600 | generated/snapshot/fixture | I — textový index |
| `apps/apple/VOID.xcodeproj/project.xcworkspace/contents.xcworkspacedata` | 7 | config/docs/metadata | I — textový index |
| `apps/apple/VOIDApp/AppCopy.swift` | 286 | authored source | I — textový index |
| `apps/apple/VOIDApp/AppModel.swift` | 179 | authored source | D — ručně vybrané části |
| `apps/apple/VOIDApp/ChatCopy.swift` | 176 | authored source | I — textový index |
| `apps/apple/VOIDApp/ChatMessageRow.swift` | 271 | authored source | I — textový index |
| `apps/apple/VOIDApp/ChatModel.swift` | 376 | authored source | D — ručně vybrané části |
| `apps/apple/VOIDApp/ChatTheme.swift` | 217 | authored source | I — textový index |
| `apps/apple/VOIDApp/ChatView.swift` | 480 | authored source | I — textový index |
| `apps/apple/VOIDApp/Info.plist` | 29 | config/docs/metadata | I — textový index |
| `apps/apple/VOIDApp/MarkdownText.swift` | 523 | authored source | I — textový index |
| `apps/apple/VOIDApp/OnboardingView.swift` | 333 | authored source | I — textový index |
| `apps/apple/VOIDApp/RootView.swift` | 76 | authored source | I — textový index |
| `apps/apple/VOIDApp/SampleChatTransport.swift` | 197 | authored source | D — ručně vybrané části |
| `apps/apple/VOIDApp/SessionDetailView.swift` | 86 | authored source | I — textový index |
| `apps/apple/VOIDApp/VOIDApp.swift` | 13 | authored source | I — textový index |
| `apps/apple/VOIDTests/VOIDAppTests.swift` | 135 | test | I — textový index |
| `apps/apple/VOIDUITests/VOIDUITests.swift` | 771 | test | I — textový index |
| `apps/apple/VoidDesignSystem/Package.swift` | 17 | authored source | I — textový index |
| `apps/apple/VoidDesignSystem/Sources/VoidDesignSystem/VoidAppearance.swift` | 34 | authored source | I — textový index |
| `apps/apple/VoidDesignSystem/Sources/VoidDesignSystem/VoidContrast.swift` | 67 | authored source | I — textový index |
| `apps/apple/VoidDesignSystem/Sources/VoidDesignSystem/VoidControlSize.swift` | 36 | authored source | I — textový index |
| `apps/apple/VoidDesignSystem/Sources/VoidDesignSystem/VoidPalette.swift` | 86 | authored source | I — textový index |
| `apps/apple/VoidDesignSystem/Sources/VoidDesignSystem/VoidRadii.swift` | 22 | authored source | I — textový index |
| `apps/apple/VoidDesignSystem/Sources/VoidDesignSystem/VoidSpacing.swift` | 29 | authored source | I — textový index |
| `apps/apple/VoidDesignSystem/Sources/VoidDesignSystem/VoidTokens.generated.swift` | 495 | authored source | I — textový index |
| `apps/apple/VoidDesignSystem/Sources/VoidDesignSystem/VoidType.swift` | 93 | authored source | I — textový index |
| `apps/apple/VoidDesignSystem/Tests/VoidDesignSystemTests/VoidContrastTests.swift` | 73 | test | I — textový index |
| `apps/apple/VoidDesignSystem/Tests/VoidDesignSystemTests/VoidControlSizeTests.swift` | 52 | test | I — textový index |
| `apps/apple/VoidDesignSystem/Tests/VoidDesignSystemTests/VoidPaletteTests.swift` | 88 | test | I — textový index |
| `apps/apple/VoidDesignSystem/Tests/VoidDesignSystemTests/VoidShadowTests.swift` | 24 | test | I — textový index |
| `apps/apple/VoidDesignSystem/Tests/VoidDesignSystemTests/VoidSpacingTests.swift` | 60 | test | I — textový index |
| `apps/apple/VoidDesignSystem/Tests/VoidDesignSystemTests/VoidTypeTests.swift` | 57 | test | I — textový index |
| `apps/apple/project.yml` | 73 | config/docs/metadata | I — textový index |
| `apps/appwrite-mcp/README.md` | 94 | config/docs/metadata | D — ručně vybrané části |
| `apps/appwrite-mcp/requirements.txt` | 1 | config/docs/metadata | I — textový index |
| `apps/appwrite-mcp/scripts/generate-snapshot.py` | 66 | authored source | I — textový index |
| `apps/appwrite-mcp/scripts/verify-deploy-shape.py` | 212 | authored source | I — textový index |
| `apps/appwrite-mcp/src/app.py` | 350 | authored source | I — textový index |
| `apps/appwrite-mcp/src/appwrite_mcp/__init__.py` | 5 | authored source | I — textový index |
| `apps/appwrite-mcp/src/appwrite_mcp/auth.py` | 78 | authored source | I — textový index |
| `apps/appwrite-mcp/src/appwrite_mcp/dispatch.py` | 292 | authored source | I — textový index |
| `apps/appwrite-mcp/src/appwrite_mcp/snapshot_builder.py` | 67 | authored source | I — textový index |
| `apps/appwrite-mcp/src/appwrite_mcp/transport.py` | 145 | authored source | I — textový index |
| `apps/appwrite-mcp/src/appwrite_mcp/void_data.py` | 591 | authored source | I — textový index |
| `apps/appwrite-mcp/src/appwrite_mcp/void_snapshot.json` | 10516 | generated/snapshot/fixture | I — textový index |
| `apps/appwrite-mcp/src/main.py` | 17 | authored source | I — textový index |
| `apps/appwrite-mcp/tests/__init__.py` | 33 | test | I — textový index |
| `apps/appwrite-mcp/tests/support_context.py` | 149 | test | I — textový index |
| `apps/appwrite-mcp/tests/test_auth_boundary.py` | 172 | test | I — textový index |
| `apps/appwrite-mcp/tests/test_hosted_endpoint.py` | 460 | test | I — textový index |
| `apps/appwrite-mcp/tests/test_preconditions.py` | 112 | test | I — textový index |
| `apps/appwrite-mcp/tests/test_source_independence.py` | 223 | test | I — textový index |
| `apps/control-plane/LICENSE` | 23 | config/docs/metadata | I — textový index |
| `apps/control-plane/api/auth.ts` | 17 | authored source | I — textový index |
| `apps/control-plane/api/beta.test.ts` | 45 | test | I — textový index |
| `apps/control-plane/api/companion/companion.test.ts` | — | binary | B — pouze metadata |
| `apps/control-plane/api/companion/devices.ts` | 192 | authored source | I — textový index |
| `apps/control-plane/api/companion/diagnostics.ts` | 97 | authored source | I — textový index |
| `apps/control-plane/api/companion/envelope.test.ts` | 581 | test | I — textový index |
| `apps/control-plane/api/companion/envelope.ts` | 579 | authored source | I — textový index |
| `apps/control-plane/api/companion/idempotency.ts` | 107 | authored source | I — textový index |
| `apps/control-plane/api/companion/invitations.ts` | 254 | authored source | I — textový index |
| `apps/control-plane/api/companion/operations.ts` | 91 | authored source | I — textový index |
| `apps/control-plane/api/companion/routes.ts` | 246 | authored source | D — ručně vybrané části |
| `apps/control-plane/api/companion/store.ts` | 93 | authored source | D — ručně vybrané části |
| `apps/control-plane/api/desktop-setup.test.ts` | 160 | test | I — textový index |
| `apps/control-plane/api/desktop-setup.ts` | 88 | authored source | I — textový index |
| `apps/control-plane/api/local-approvals.ts` | 25 | authored source | I — textový index |
| `apps/control-plane/api/parity.test.ts` | 122 | test | I — textový index |
| `apps/control-plane/api/remote-gateway.mjs` | 69 | authored source | I — textový index |
| `apps/control-plane/api/server.test.ts` | 390 | test | I — textový index |
| `apps/control-plane/api/server.ts` | 791 | authored source | D — ručně vybrané části |
| `apps/control-plane/api/session-cookie.mjs` | 3 | authored source | I — textový index |
| `apps/control-plane/api/static-spa.test.ts` | 56 | test | I — textový index |
| `apps/control-plane/api/verify-key.test.ts` | 339 | test | I — textový index |
| `apps/control-plane/package.json` | 26 | config/docs/metadata | I — textový index |
| `apps/control-plane/tsconfig.json` | 11 | config/docs/metadata | I — textový index |
| `apps/control-plane/ui/index.html` | 18 | authored source | I — textový index |
| `apps/control-plane/ui/package.json` | 29 | config/docs/metadata | I — textový index |
| `apps/control-plane/ui/src/account-gate.tsx` | 249 | authored source | D — ručně vybrané části |
| `apps/control-plane/ui/src/account-sign-in.test.ts` | 261 | test | I — textový index |
| `apps/control-plane/ui/src/account-sign-in.ts` | 271 | authored source | I — textový index |
| `apps/control-plane/ui/src/agent-input.test.ts` | 75 | test | I — textový index |
| `apps/control-plane/ui/src/agent-input.ts` | 44 | authored source | I — textový index |
| `apps/control-plane/ui/src/api.ts` | 47 | authored source | D — ručně vybrané části |
| `apps/control-plane/ui/src/approval-diff.test.ts` | 67 | test | I — textový index |
| `apps/control-plane/ui/src/approval-diff.ts` | 129 | authored source | I — textový index |
| `apps/control-plane/ui/src/approval-review.tsx` | 263 | authored source | I — textový index |
| `apps/control-plane/ui/src/approval-text.ts` | 36 | authored source | I — textový index |
| `apps/control-plane/ui/src/brand.tsx` | 21 | authored source | I — textový index |
| `apps/control-plane/ui/src/chat-composer.test.ts` | 139 | test | I — textový index |
| `apps/control-plane/ui/src/chat-composer.ts` | 94 | authored source | I — textový index |
| `apps/control-plane/ui/src/chat-stream.test.ts` | 136 | test | I — textový index |
| `apps/control-plane/ui/src/chat-stream.ts` | 108 | authored source | I — textový index |
| `apps/control-plane/ui/src/chat.css` | 280 | authored source | I — textový index |
| `apps/control-plane/ui/src/chat.tsx` | 1629 | authored source | D — ručně vybrané části |
| `apps/control-plane/ui/src/command-menu.tsx` | 116 | authored source | I — textový index |
| `apps/control-plane/ui/src/commands.test.ts` | 26 | test | I — textový index |
| `apps/control-plane/ui/src/commands.ts` | 74 | authored source | I — textový index |
| `apps/control-plane/ui/src/compact-layout.test.ts` | 124 | test | I — textový index |
| `apps/control-plane/ui/src/demo.tsx` | 608 | authored source | I — textový index |
| `apps/control-plane/ui/src/desktop-downloads.test.ts` | 31 | test | I — textový index |
| `apps/control-plane/ui/src/desktop-downloads.ts` | 6 | authored source | D — ručně vybrané části |
| `apps/control-plane/ui/src/document-history.test.ts` | 41 | test | I — textový index |
| `apps/control-plane/ui/src/document-history.ts` | 24 | authored source | I — textový index |
| `apps/control-plane/ui/src/documents.tsx` | 582 | authored source | I — textový index |
| `apps/control-plane/ui/src/draft-state.test.ts` | 80 | test | I — textový index |
| `apps/control-plane/ui/src/draft-state.ts` | 32 | authored source | I — textový index |
| `apps/control-plane/ui/src/events.test.ts` | 93 | test | I — textový index |
| `apps/control-plane/ui/src/events.ts` | 75 | authored source | I — textový index |
| `apps/control-plane/ui/src/gallery-path.ts` | 22 | authored source | I — textový index |
| `apps/control-plane/ui/src/gallery.test.ts` | 37 | test | I — textový index |
| `apps/control-plane/ui/src/gallery.tsx` | 421 | authored source | I — textový index |
| `apps/control-plane/ui/src/icons.tsx` | 54 | authored source | I — textový index |
| `apps/control-plane/ui/src/integrations.tsx` | 555 | authored source | D — ručně vybrané části |
| `apps/control-plane/ui/src/ledger-detail.tsx` | 176 | authored source | I — textový index |
| `apps/control-plane/ui/src/ledger-verify.tsx` | 148 | authored source | I — textový index |
| `apps/control-plane/ui/src/main.tsx` | 1126 | authored source | D — ručně vybrané části |
| `apps/control-plane/ui/src/overview-state.test.ts` | 48 | test | I — textový index |
| `apps/control-plane/ui/src/overview-state.ts` | 27 | authored source | I — textový index |
| `apps/control-plane/ui/src/pages.tsx` | 639 | authored source | D — ručně vybrané části |
| `apps/control-plane/ui/src/permission-mode.test.ts` | 77 | test | I — textový index |
| `apps/control-plane/ui/src/permission-mode.tsx` | 178 | authored source | I — textový index |
| `apps/control-plane/ui/src/recovery-dialog.tsx` | 301 | authored source | I — textový index |
| `apps/control-plane/ui/src/recovery-review.test.ts` | 124 | test | I — textový index |
| `apps/control-plane/ui/src/recovery-review.ts` | 85 | authored source | I — textový index |
| `apps/control-plane/ui/src/redact.test.ts` | 92 | test | I — textový index |
| `apps/control-plane/ui/src/redact.ts` | 112 | authored source | I — textový index |
| `apps/control-plane/ui/src/session-context.tsx` | 126 | authored source | I — textový index |
| `apps/control-plane/ui/src/settings.tsx` | 835 | authored source | D — ručně vybrané části |
| `apps/control-plane/ui/src/status-label.test.ts` | 20 | test | I — textový index |
| `apps/control-plane/ui/src/status-label.ts` | 38 | authored source | I — textový index |
| `apps/control-plane/ui/src/styles.css` | 3730 | authored source | I — textový index |
| `apps/control-plane/ui/src/ui.test.ts` | 50 | test | I — textový index |
| `apps/control-plane/ui/src/ui.tsx` | 604 | authored source | D — ručně vybrané části |
| `apps/control-plane/ui/src/verify-scope.test.ts` | 97 | test | I — textový index |
| `apps/control-plane/ui/src/verify-scope.ts` | 126 | authored source | I — textový index |
| `apps/control-plane/ui/src/workspace-controls.tsx` | 290 | authored source | D — ručně vybrané části |
| `apps/control-plane/ui/src/workspace-state.test.ts` | 73 | test | I — textový index |
| `apps/control-plane/ui/src/workspace-state.ts` | 84 | authored source | I — textový index |
| `apps/control-plane/ui/src/workspace-status.tsx` | 62 | authored source | I — textový index |
| `apps/control-plane/ui/tsconfig.json` | 15 | config/docs/metadata | I — textový index |
| `apps/control-plane/ui/vite.config.ts` | 12 | authored source | I — textový index |
| `apps/control-plane/web/app.js` | 325 | authored source | I — textový index |
| `apps/control-plane/web/app.test.mjs` | 201 | test | I — textový index |
| `apps/control-plane/web/approvals.html` | 33 | authored source | I — textový index |
| `apps/control-plane/web/cloud-settings.js` | 33 | authored source | I — textový index |
| `apps/control-plane/web/control-plane-pages.test.mjs` | 73 | test | I — textový index |
| `apps/control-plane/web/feed.html` | 36 | authored source | I — textový index |
| `apps/control-plane/web/icon.svg` | 1 | config/docs/metadata | I — textový index |
| `apps/control-plane/web/index.html` | 52 | authored source | I — textový index |
| `apps/control-plane/web/ledger.html` | 36 | authored source | I — textový index |
| `apps/control-plane/web/manifest.webmanifest` | 1 | config/docs/metadata | I — textový index |
| `apps/control-plane/web/sessions.js` | 134 | authored source | I — textový index |
| `apps/control-plane/web/theme.js` | 11 | authored source | I — textový index |
| `apps/control-plane/web/workbench.css` | 239 | authored source | I — textový index |
| `apps/control-plane/web/workspace-ui.js` | 47 | authored source | I — textový index |
| `apps/desktop/.gitignore` | 6 | config/docs/metadata | I — textový index |
| `apps/desktop/README.md` | 160 | config/docs/metadata | D — ručně vybrané části |
| `apps/desktop/package.json` | 34 | config/docs/metadata | I — textový index |
| `apps/desktop/pnpm-lock.yaml` | 411 | generated/snapshot/fixture | I — textový index |
| `apps/desktop/pnpm-workspace.yaml` | 5 | config/docs/metadata | I — textový index |
| `apps/desktop/release.test.mjs` | 154 | test | I — textový index |
| `apps/desktop/runtime.mjs` | 39 | authored source | D — ručně vybrané části |
| `apps/desktop/runtime.test.mjs` | 60 | test | I — textový index |
| `apps/desktop/scripts/build-policy.mjs` | 116 | authored source | I — textový index |
| `apps/desktop/scripts/build.mjs` | 23 | authored source | I — textový index |
| `apps/desktop/scripts/prepare.mjs` | 60 | authored source | I — textový index |
| `apps/desktop/src-tauri/Cargo.lock` | 5082 | generated/snapshot/fixture | I — textový index |
| `apps/desktop/src-tauri/Cargo.toml` | 25 | config/docs/metadata | I — textový index |
| `apps/desktop/src-tauri/build.rs` | 3 | authored source | I — textový index |
| `apps/desktop/src-tauri/src/diagnostics.rs` | 160 | authored source | I — textový index |
| `apps/desktop/src-tauri/src/downloads.rs` | 37 | authored source | I — textový index |
| `apps/desktop/src-tauri/src/keychain.rs` | 454 | authored source | I — textový index |
| `apps/desktop/src-tauri/src/main.rs` | 485 | authored source | D — ručně vybrané části |
| `apps/desktop/src-tauri/tauri.conf.json` | 23 | config/docs/metadata | D — ručně vybrané části |
| `apps/desktop/src-tauri/tauri.windows.conf.json` | 1 | config/docs/metadata | I — textový index |
| `apps/desktop/ui/index.html` | 1 | authored source | I — textový index |
| `apps/tui-preview/index.html` | 36 | authored source | I — textový index |
| `cloud/0001-account-ownership.sql` | 231 | authored source | I — textový index |
| `cloud/0002-immutable-function-search-path.sql` | 2 | authored source | I — textový index |
| `cloud/account-isolation.test.mjs` | 105 | test | I — textový index |
| `cloud/account-routes.test.mjs` | 607 | test | I — textový index |
| `cloud/account.mjs` | 625 | authored source | I — textový index |
| `cloud/account.test.mjs` | 419 | test | I — textový index |
| `cloud/appwrite.mjs` | 450 | authored source | I — textový index |
| `cloud/appwrite.test.mjs` | 372 | test | I — textový index |
| `cloud/auth.mjs` | 92 | authored source | D — ručně vybrané části |
| `cloud/auth.test.mjs` | 103 | test | I — textový index |
| `cloud/demo.mjs` | 417 | authored source | D — ručně vybrané části |
| `cloud/demo.test.mjs` | 219 | test | I — textový index |
| `cloud/gui.test.mjs` | 275 | test | I — textový index |
| `cloud/integrations.mjs` | 303 | authored source | D — ručně vybrané části |
| `cloud/integrations.test.mjs` | 229 | test | I — textový index |
| `cloud/mcp.mjs` | 1 | authored source | I — textový index |
| `cloud/oauth-state.mjs` | 84 | authored source | I — textový index |
| `cloud/oauth.mjs` | 220 | authored source | D — ručně vybrané části |
| `cloud/oauth.test.mjs` | 141 | test | I — textový index |
| `cloud/owner.mjs` | 57 | authored source | D — ručně vybrané části |
| `cloud/owner.test.mjs` | 639 | test | I — textový index |
| `cloud/prime.mjs` | 236 | authored source | I — textový index |
| `cloud/prime.test.mjs` | 157 | test | I — textový index |
| `cloud/provider.mjs` | 117 | authored source | D — ručně vybrané části |
| `cloud/provider.test.mjs` | 143 | test | I — textový index |
| `cloud/recovery-routes.mjs` | 91 | authored source | I — textový index |
| `cloud/recovery-routes.test.mjs` | 174 | test | I — textový index |
| `cloud/recovery.mjs` | 437 | authored source | D — ručně vybrané části |
| `cloud/recovery.test.mjs` | 228 | test | I — textový index |
| `cloud/schema.sql` | 46 | authored source | D — ručně vybrané části |
| `cloud/schema.test.mjs` | 33 | test | I — textový index |
| `cloud/seed-appwrite.mjs` | — | binary | B — pouze metadata |
| `cloud/server.mjs` | 1322 | authored source | D — ručně vybrané části |
| `cloud/steps.mjs` | 523 | authored source | I — textový index |
| `cloud/steps.test.mjs` | 92 | test | I — textový index |
| `cloud/store.mjs` | 485 | authored source | D — ručně vybrané části |
| `cloud/store.test.mjs` | 13 | test | I — textový index |
| `cloud/vercel-integration.mjs` | 346 | authored source | I — textový index |
| `cloud/vercel-integration.test.mjs` | 195 | test | I — textový index |
| `cloud/workflow.mjs` | 22 | authored source | I — textový index |
| `marketing/teaser/.gitignore` | 1 | config/docs/metadata | I — textový index |
| `marketing/teaser/README.md` | 62 | config/docs/metadata | D — ručně vybrané části |
| `marketing/teaser/VOID-TEASER-1080x1920.mp4` | — | binary | B — pouze metadata |
| `marketing/teaser/VOID-TEASER-V2-3D-1080x1920.mp4` | — | binary | B — pouze metadata |
| `marketing/teaser/VOID-TEASER-V2-cover.jpg` | — | binary | B — pouze metadata |
| `marketing/teaser/VOID-TEASER-cover.jpg` | — | binary | B — pouze metadata |
| `marketing/teaser/finish.py` | 225 | authored source | I — textový index |
| `marketing/teaser/finish_v2.py` | 73 | authored source | I — textový index |
| `marketing/teaser/scene.py` | 193 | authored source | I — textový index |
| `marketing/teaser/scene_v2.py` | 352 | authored source | I — textový index |
| `marketing/teaser/verify.py` | 18 | authored source | I — textový index |
