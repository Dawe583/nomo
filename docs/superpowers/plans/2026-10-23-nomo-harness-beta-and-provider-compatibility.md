# Plán implementace: beta instalace a kompatibilita providerů NOMO

> **Stav:** Implementace specifikace uživatelem výslovně schválena 2026-10-23. Provádět pouze přes jediný harness task graph, po jednom aktivním uzlu a s důkazem pro každý bounded loop. Žádný další subagent před dokončením aktuálního.

**Cíl:** Dodat testerům macOS/Windows instalaci NOMO bez Node/pnpm, soukromou feedback cestu bez telemetrie a kompletní odchozí kompatibilitu všech chat/tiny modelových providerů v připnutých zdrojích OMP/Prime.

**Architektura:** Zachovat Workbench jako jediný runtime. Přidat statický, verzovaný coverage manifest a malé typované transport adaptery; provider metadata a autentizaci držet odděleně od wire protokolů. Využít stávající Tauri aplikaci a privátní GitHub Releases, bez změny TUI a bez veřejného publikování.

**Technologie:** TypeScript, Node.js 24, pnpm workspace, `node:test`, stávající Tauri 2 desktop build a šifrované lokální úložiště. Bez nové běhové závislosti.

**Specifikace:** `docs/superpowers/specs/2026-10-23-nomo-harness-beta-and-provider-compatibility.md`

## Globální omezení

- Zachovat dirty worktree a branch `feat/wp-regress`; žádný reset, stash, přepnutí větve ani široké stage.
- Uživatel nyní výslovně schválil commit a push ověřených Harness změn na `origin/feat/wp-regress`. Soubory TUI, TUI graph ani jiné cizí změny se nesmí stageovat ani publikovat. Bez merge, releasu nebo změny viditelnosti repozitáře.
- Nedotýkat se TUI souborů (`packages/cli/src/tui/**`) ani TUI/task graph větve.
- Žádný SWE-bench, Docker běh, veřejný release, repo visibility změna, telemetry ani provider request.
- Provider tests používají lokální fixture HTTP server a syntetické klíče; nikdy skutečné tokeny.
- Žádné nové runtime závislosti ani import OMP/Prime implementací.
- Staré `compatible` a `anthropic` profily musí zůstat čitelné; chybná migrace nesmí přepsat platnou konfiguraci.
- Klíče a OAuth tokeny se nikdy nevrací UI rendereru, logu, error textu, issue formu, session eventu ani ledgeru.
- Soukromý GitHub Release je samostatná owner approval brána; workflow nesmí nic publikovat automaticky.
- Bez signing credentials se release nesmí vydávat za bezvarovné instalování; credentials se předávají pouze přes CI secrets.

## Výchozí stav a hranice

- Provider runtime: `packages/workbench/src/provider.ts`; configure/persistence: `packages/workbench/src/index.ts`; API route: `apps/control-plane/api/server.ts`; desktop import boundary: `apps/control-plane/api/desktop-setup.ts`; GUI: `apps/control-plane/ui/src/settings.tsx`.
- Provider tests: `packages/workbench/src/provider-stream.test.ts`, `packages/workbench/src/workbench.test.ts` a API tests v `apps/control-plane/api/`.
- Desktop package: `apps/desktop/scripts/build.mjs`, `apps/desktop/src-tauri/**`, runtime smoke `apps/desktop/runtime.test.mjs`; Windows workflow `.github/workflows/desktop-windows.yml`.
- Beta docs: `docs/BETA.md`, `apps/desktop/README.md`; tester feedback: nové `.github/ISSUE_TEMPLATE/feedback.yml`.
- Provider baseline: OMP 18.6.2 (`KnownProvider`, `KnownApi` a provider/auth catalog v read-only `upstream/omp-src`) a Prime 0.10.1 (`KnownApi`, compiled provider transports, Prime Inference v read-only `upstream/prime-src`). Toto jsou zdrojové baseline; neznamenají, že stejné verze jsou aktuálně nainstalované u uživatele.
- OMP deklaruje více odlišných transportů včetně OpenAI Completions/Responses, Anthropic, Bedrock, Google, Ollama a agent-specific API. Prime má navíc Mistral Conversations a vlastního `prime-inference` gateway. Nejde o jednu univerzální URL variantu.

## Souborová mapa

- `packages/workbench/src/provider-catalog.ts` a `provider-manifest.json`: zdrojové roster a připnutá klasifikace providerů, modelů, autentizace a schopností.
- `scripts/generate-provider-manifest.mjs`: obnova coverage z read-only zdrojů OMP a Prime.
- `packages/workbench/src/provider.ts`: zachovat sdílené typy, normalizaci, bezpečné chyby a kompatibilitu `ProviderConfig`; dispatch vést přes adapter factory.
- `packages/workbench/src/provider-adapters/`: jeden modul pro každou transportní rodinu v manifestu, ne modul pro každého komerčního vendora.
- `packages/workbench/src/provider-catalog.ts`, existující testy katalogu/adapterů a transportní fixtures: manifest, invarianty coverage a chování protokolů.
- `packages/workbench/src/index.ts`: konfigurace, kryptografická persist/reload migrace a lifecycle profilů providerů.
- `apps/control-plane/api/server.ts` a případný nový `apps/control-plane/api/provider-auth.ts`: lokální setup/login API a tok tokenů; renderer token nikdy neuvidí.
- `apps/control-plane/ui/src/settings.tsx`: výběr providera, auth flow, model selection a zobrazení schopností; bez změn TUI.
- `apps/desktop/scripts/build.mjs`, `apps/desktop/src-tauri/**`, desktop workflows a release workflow podle potřeby: desktop artefakty, signing, checksum a chráněný private release.
- `.github/ISSUE_TEMPLATE/feedback.yml`, `docs/BETA.md`, `apps/desktop/README.md`: tester onboarding a ruční feedback bez automatické diagnostiky.

## Fáze 1: provider coverage manifest

### Úkol 1: Zmrazit úplný chat/tiny provider roster

**Akceptace:** Explicitní zdrojový roster OMP `KnownProvider` a Prime `KnownProvider` je uveden ve specifikaci; Prime open-string provider ID se doplní z compiled model catalogu. Každé OMP/Prime provider/API ID z přesných baseline je klasifikováno jako in-scope chat/tiny nebo výslovně out-of-scope ne-chat service s důvodem. Každá in-scope položka má provider ID, zdroj/verzi, model kind, transportní rodinu, default endpoint, discovery, auth, default model a capability map. Prime Inference je explicitní záznam. CI/test porovná checked-in roster s připnutým inventory a selže při duplicitním ID, novém/nezmapovaném provideru/API, neznámém transportu nebo provideru bez adapteru.

**Soubory:** vytvořit `packages/workbench/src/provider-catalog.ts`, `packages/workbench/src/provider-manifest.json` a `scripts/generate-provider-manifest.mjs`; rozšířit `packages/workbench/src/provider-catalog.test.ts`; zapsat výslednou baseline do uvedené specifikace.

**Test:** `node --experimental-strip-types --test packages/workbench/src/provider-catalog.test.ts`. Testy pokrývají uniqueness, 100% roster coverage, povolené auth/protocol hodnoty, validní endpoint policy a přesné počty/version tags extrahované z checked-in manifestu; nekontrolují pouze neprázdné pole.

## Fáze 2: provider contract, persistence a migrace

### Úkol 2: Přidat typed adapter contract a factory

**Akceptace:** `ProviderClient` poskytuje model discovery a completion se streamem, tool call, usage a cancellation. Factory vybere jediný adapter podle manifestu a odmítne neznámý provider/API. `ProviderConfig` se identifikuje provider ID a diskriminovaným auth profilem; existující `compatible` a `anthropic` configy se normalizují bez změny významu.

- **Soubory:** upravit `packages/workbench/src/provider.ts`; vytvořit `packages/workbench/src/provider-adapters/types.ts` a `provider-adapters/factory.ts`; rozšířit `packages/workbench/src/provider-stream.test.ts`; persistence testy v `packages/workbench/src/workbench.test.ts`.

**Test:** `node --experimental-strip-types --test packages/workbench/src/provider-stream.test.ts packages/workbench/src/workbench.test.ts`; ověřit round-trip starých configů, provider switching, restart a bezpečné selhání bez ztráty předchozí konfigurace.

## Fáze 3: transportní adaptery

Každý následující úkol je samostatný bounded loop: nejprve fixture test, ověřený failing-before, minimální implementace, focused test, záznam graph evidence. Neprovádět paralelní úpravy shared provider factory.

### Úkol 3: OpenAI Chat Completions a kompatibilní gateway

**Soubory:** vytvořit `packages/workbench/src/provider-adapters/openai-completions.ts` a test vedle něj; přidat descriptor mapping v `provider-catalog.ts`.

**Akceptace:** zachovat tools, streaming chunk boundaries, usage, cancellation, max token fields a error/redaction chování; podporovat provider metadata/headers jen explicitně. Přímý OpenAI host funguje jen přes OpenAI descriptor; custom URL zůstává pod HTTPS/loopback a redirect zákazem.

**Test:** `node --experimental-strip-types --test packages/workbench/src/provider-adapters/openai-completions.test.ts` s fake HTTP serverem pro text, tool call, malformed SSE, truncated output, non-2xx, timeout a cizí redirect.

### Úkol 4: OpenAI Responses, Azure Responses a Codex Responses

**Soubory:** `packages/workbench/src/provider-adapters/openai-responses.ts` a lokální test; descriptor/auth mapping.

**Akceptace:** mapovat role, input/output blocks, tools, streaming event types, usage, cancellation a response IDs; neplést Responses se Chat Completions. Codex/OAuth je povolen jen při dokumentovaném a povoleném login flow.

**Test:** fixtures pro textové i tool eventy, neúplný stream, error a credential isolation.

### Úkol 5: Anthropic Messages

**Soubory:** extrahovat současnou větev z `provider.ts` do `provider-adapters/anthropic-messages.ts`; zachovat její současné kontrakty.

**Akceptace:** žádná behaviorální regrese; správné system/developer role mapování, tool result IDs, SSE, usage, cancellation a key header.

**Test:** stávající Anthropic stream cases přes nový adapter plus error, truncation a persisted-config regression.

### Úkol 6: Google Generative AI, Gemini CLI a Vertex

**Soubory:** nový `provider-adapters/google-generative-ai.ts` a případně oddělené transportní moduly jen pokud se wire protokoly liší; catalog mappings a fixtures.

**Akceptace:** model-specific auth, tool declarations/results, multimodal input, function calls, stream, usage a reasoning controls podle manifestu; Gemini CLI tokeny nejsou zaměnitelné s API key.

**Test:** lokální fixtures pro každou wire/auth variantu a absence nepodporovaného content blocku.

### Úkol 7: Amazon Bedrock Converse Stream

**Soubory:** nový `provider-adapters/bedrock-converse-stream.ts`, bezpečné auth signing module pouze po zdrojové/spec review, provider descriptor a fixtures.

**Akceptace:** podepsat request oficiálním AWS SigV4 pomocí `node:crypto`; žádné statické AWS secrets v URL, logu ani rendereru. Nepsat zkrácený/falešný podpis; chování ověřit proti AWS publikovaným signing vectors.

**Test:** deterministická lokální signing/request fixture; bez AWS účtu nebo sítě.

### Úkol 8: Mistral Conversations a Ollama Chat

**Soubory:** `provider-adapters/mistral-conversations.ts`, `provider-adapters/ollama-chat.ts` a fixture tests.

**Akceptace:** nezaměnit Mistral Conversations s OpenAI-compatible chat endpointem; Ollama používá lokální loopback HTTP a model discovery bez povinného klíče.

### Úkol 9: OpenRouter a další routing/gateway transportní varianty

**Soubory:** adapter moduly podle inventory (`openrouter` a varianty proxy gateway), katalog a transport testy.

**Akceptace:** zachovat gateway-specific headers/routing metadata, respektovat model capability metadata a nepřenášet provider-specific požadavky na jiné hosty.

### Úkol 10: Agent-specific chat transports

**Soubory:** samostatné moduly z inventory pro Cursor, Factory Droid, GitLab Duo, Devin, Apple Foundation Models a další in-scope special transporty; klasifikaci platformní dostupnosti zapsat do manifestu.

**Akceptace:** každé API ID, které baseline deklaruje pro chat/tiny model, má reálný adapter nebo explicitně doložený blocker. Nesmí se převést na generic completions jen kvůli shodnému názvu modelu. Agent-protocol auth nesmí převzít cizí lokální CLI credential bez explicitního uživatelského souhlasu. Platformně nepodporovaný provider je ve UI nedostupný s konkrétním důvodem.

### Úkol 11: Prime Inference gateway

**Soubory:** provider descriptor/adapters, lokální katalog/fixture tests a config migration.

**Akceptace:** model roster se aktualizuje bezpečným provider API, používá Prime Inference auth, validuje živý katalog proti statickému schematu/coverage a explicitně odmítne stale/private IDs bez entitlementu. Žádný privátní/internal model ID se nepřidává do sdíleného zdrojového katalogu.

## Fáze 4: credential lifecycle a GUI setup

### Úkol 12: Provider API-key a OAuth/login lifecycle

**Soubory:** `packages/workbench/src/index.ts`; nový backend `apps/control-plane/api/provider-auth.ts`; úpravy `apps/control-plane/api/server.ts`; auth/secret tests v obou modulech.

**Akceptace:** provider setup, login start/callback/device polling, token refresh, disconnect/revoke, cancel, expiry a nepodařený save jsou explicitní state transitions. Token je dostupný pouze backendu a šifrovaně uložen; renderer dostává pouze safe status. Provider switch se při chybě atomicky vrací k předchozímu working configu.

**Test:** injected auth fixture serveru bez browseru a externí sítě; testovat PKCE/state, nonce, expiry, refresh race, revoke, host mismatch, log redaction, restart persistence.

### Úkol 13: Nastavení provideru v GUI

**Soubory:** `apps/control-plane/ui/src/settings.tsx`, relevantní UI tests, API tests a desktop first-run docs.

**Akceptace:** každý in-scope provider jde vybrat podle jména, ukáže podporovaný login a modely, ověří spojení a označí unsupported capabilities. Chyba přihlášení nesmaže předchozí aktivní provider. Žádný TUI soubor se nezmění.

**Test:** deterministický UI/API test napojený na fixture provider; ověřit přístupnost ovládacích prvků a bezpečné zobrazení chyb bez tokenu.

**Kontrolní bod H38: typované nastavení:** Settings a `/api/provider` předávají a ukládají typované `providerId`, transport, endpoint, model a autentizaci pouze pro kombinace výslovně povolené manifestem. Manifestové Settings nezobrazuje statické AWS klíče Bedrocku a typed `/api/provider` odmítá `aws-credentials`: manifest uvádí jen native, host a credential-chain autentizaci. Backend před šifrovaným uložením ověřuje autentizaci i endpoint; neplatný požadavek zachová aktivního providera. Důkazy: Workbench/API testy, workspace typecheck, docs-truth 9/9, produkční GUI build a browser smoke 91 položek s OpenAI Responses formulářem; bez provider requestu. H38 uzavírá jen dosažitelnou část konfigurace. Lokální commit `f60ff53a5a80d6c1c911f2632330eb26e83fa834`; push blokuje neplatný HTTPS token a chybějící SSH public key, remote zůstává `e3888210ac84f4242f09f259979911169a2011b7`. Úkol 13 zůstává otevřený kvůli provider-specific OAuth/loginu, ověření spojení, upozornění na schopnosti a úplnému pokrytí providerů v rozsahu; H31-H33 zůstávají blokované.

#### Kontrolní bod H39: zveřejnění schopností modelu

Nastavení zobrazuje schopnosti vybraného manifestového modelu pouze z ověřených dat manifestu. Rozhraní rozlišuje podporované, nepodporované, neznámé a rozporné údaje; chybějící či rozporná metadata nikdy neprezentuje jako podporovaná. Přístup je pouze lokální a bez provider requestu. RED/GREEN API test pokrývá přesný model, neznámý model, konflikt pinned katalogů a nulový počet provider requestů; testy existující suite katalogu a API ověřují regresi. Settings má přístupné zobrazení a browser smoke. H39 neuzavírá celý Úkol 13 ani blokátory H21/H31-H33.


## Fáze 5: tester feedback

### Úkol 14: Soukromý issue form a quickstart

**Soubory:** vytvořit `.github/ISSUE_TEMPLATE/feedback.yml`; aktualizovat `docs/BETA.md` a `apps/desktop/README.md`.

**Akceptace:** tester s repo read access najde feedback link, může nahlásit reprodukovatelný problém, form nepožaduje API URL, prompt, response, session transcript, project files ani secrets. Soukromé issue zůstává v private repo. Žádné automatické uploady či telemetrie.

**Test:** YAML/schema validation zavedená v projektu nebo statická fixture test; ruční kontrola formu v GitHub preview se provede až s ownerem, bez odeslání issue.

## Fáze 6: soukromé desktop balíčky

### Úkol 15: macOS build workflow a install smoke

**Soubory:** vytvořit `.github/workflows/desktop-macos.yml`; upravit desktop build/release docs podle zjištěné CI konfigurace.

**Akceptace:** sestavit arm64 a x64 artefakty, spustit desktop tests a clean runner install/runtime smoke, vypočítat SHA-256. Signing/notarization pouze přes owner-provided GitHub secrets; bez nich workflow vytvoří pouze zřetelně interní unsigned artifact, nikoli bezvarovný release.

### Úkol 16: Windows build/release hardening

**Soubory:** upravit `.github/workflows/desktop-windows.yml`, pokud je to nutné; jinak jej ponechat.

**Akceptace:** existing NSIS install smoke zůstane, artifact obsahuje SHA-256, balíček spustí fixture provider setup, odinstalace nemění cizí soubory. Code signing je pouze volitelně owner secrets; žádný secret do logu.

### Úkol 17: Private release approval gate

**Soubory:** vytvořit nebo upravit `.github/workflows/desktop-release.yml` a `apps/desktop/README.md`.

**Akceptace:** workflow je ručně spuštěný a release job je chráněn GitHub environment approval; žádná push/tag událost sama nic nevydá. Release je jen pro soukromé repo a obsahuje verze, platformy, podpisový stav, checksumy, známé OS varování a private feedback link. Do schválení se workflow pouze testuje jako artifact build; release se nepublikuje.

## Fáze 7: systémové ověření a předání

### Úkol 18: Provider coverage a cross-platform acceptance

- **Soubory:** všechny dotčené provider tests, `packages/workbench/src/workbench.test.ts`, `apps/control-plane/api/server.test.ts`, desktop runtime tests a testy nastavení.

**Akceptace:** 100 % manifest coverage; plné relevantní Workbench/API/UI/desktop suites; typecheck; macOS i Windows packaged clean-install smoke. Nevolat reálné providery. Ověřit, že `packages/cli/src/tui/**` a TUI graph nemají změny, ale nepoužívat široký reset/stash.

**Příkazy:**

```sh
node --experimental-strip-types --test packages/workbench/src/provider-catalog.test.ts packages/workbench/src/provider-stream.test.ts packages/workbench/src/workbench.test.ts
pnpm --filter @void/workbench run typecheck
pnpm --dir apps/desktop test
pnpm --dir apps/desktop build
```

Platformní install smokes běží jen na odpovídajících CI runners a bez skutečného provider credentialu. Konečná full suite se spustí jednou po dokončení všech implementačních tasks.

## Approval gates a otevřené blokery

1. Uživatel dne 2026-10-23 výslovně schválil implementaci tohoto plánu a specifikace.
2. Owner udělí testerům GitHub read access sám. Žádná změna repo visibility.
3. Apple Developer ID/notarization a Windows code signing vyžadují owner credentials v chráněných CI secrets; bez nich je „zero-warning easy install“ nesplněný externí blocker.
4. Každý nepovolený nebo nedokumentovaný provider auth flow zastaví daný adapter. Žádné napodobení skrytého loginu ani použití lokálního OMP/Prime tokenu bez souhlasu.
5. H19 project secret boundary zůstává nezávisle blokovaná; implementace coding workspace capability se nezačne, dokud její vlastní návrh není schválen.
6. Aktuální user approval umožňuje commit a push pouze revidovaných a ověřených Harness změn na `origin/feat/wp-regress`; neumožňuje TUI změny, merge, release, změnu přístupů ani skutečné provider requesty.

### Úkol 19: Ověřit a publikovat Harness-only větev

**Soubory:** pouze Harness soubory už změněné v pracovním stromu; nikdy `packages/cli/src/tui/**` ani `.nomo/work-state.json`.

**Akceptace:** současný Harness diff projde cílenými provider, Workbench, API, UI a desktop fixture testy, docs-truth testem i `pnpm run typecheck`; každý publikovaný soubor patří schválenému Harness rozsahu; žádný secret, TUI soubor ani cizí změna není v commitu; remote `origin/feat/wp-regress` ukazuje na ověřený commit.

- [x] Znovu načíst status a diff v `feat/wp-regress`; rozdělit Harness cesty od TUI a všeho mimo Harness.
- [x] Spustit `pnpm --filter @void/workbench test`.
- [x] Spustit `node --experimental-strip-types --test apps/control-plane/api/server.test.ts`.
- [x] Spustit `pnpm --filter @void/control-plane-ui test`.
- [x] Spustit `node --test apps/desktop/runtime.test.mjs apps/desktop/release.test.mjs`.
- [x] Spustit `node --test scripts/src/doc-truth.test.mjs`; opravit jen doložené Harness dead/stale odkazy.
- [x] Spustit `pnpm run typecheck`; při selhání zastavit, určit jedinou příčinu a neopakovat bez opravy.
- [x] Prohlédnout celý staged kandidát včetně nových souborů; ověřit secret redaction, endpoint policy, workflow approval, checksum a TUI absenci.
- [x] Stageovat jen ověřené Harness cesty; před commitem zkontrolovat celý staged diff a seznam staged paths.
- [x] Vytvořit dva kohezi zachovávající commity: (1) Workbench runtime, provider transporty a API/UI dohromady, protože sdílejí provider dispatch a `index.ts`; (2) desktop beta distribuci, onboarding, specifikaci, plán a předání. Pushnout pouze ověřený `HEAD` na `origin/feat/wp-regress`. Commity: `92d66fd`, `7c341d2`.
- [x] Ověřit remote SHA vůči lokálnímu `HEAD`; zaznamenat přesné příkazy, výsledky a neověřené GA podmínky. `git ls-remote origin refs/heads/feat/wp-regress` i `git rev-parse HEAD` vrátily `7c341d25709ae4992daf8c6ea691e9e0989fe6ae`; remote CI a instalovaný smoke zůstávají neověřené.

**Zastavit:** při souběžné změně Harness souboru, test/typecheck selhání, secret nálezu, nejasném vlastnictví cesty, změně remote větve nebo pokusu zahrnout TUI/cizí změnu. Neprovádět merge, release ani reálné provider volání.
