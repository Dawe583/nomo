# Plán implementace: beta instalace a kompatibilita providerů NOMO

> **Stav:** Implementace specifikace uživatelem výslovně schválena 2026-10-23. Provádět pouze přes jediný harness task graph, po jednom aktivním uzlu a s důkazem pro každý bounded loop. Žádný další subagent před dokončením aktuálního.
> **Aktualizace rozsahu 2026-10-27:** Uživatel nechce desktopovou aplikaci. Úkoly 15-17, desktopová část Úkolu 18 a H34 jsou mimo cíl. Nespouštět Xcode, Tauri build ani desktopový instalační smoke test. Existující `apps/desktop/**` ponechat bez změn, jejich odstranění nebylo požadováno. OpenAI kompatibilita zůstává odchozí podle schválené specifikace.


**Cíl:** Dodat testerům jednoduchou cestu k místnímu webovému Harnessu a CLI ze soukromého repozitáře, soukromou feedback cestu bez telemetrie a odchozí kompatibilitu všech chat/tiny modelových providerů v připnutých zdrojích OMP/Prime. Nativní desktopová aplikace není cílem.

**Architektura:** Zachovat Workbench jako jediný runtime. Používat statický coverage manifest a typované transportní adaptéry; provider metadata a autentizaci držet odděleně od wire protokolů. Testovací cestou je lokální webové GUI a CLI ze zdrojového repozitáře. Bez desktopové aplikace a veřejného publikování.

**Technologie:** TypeScript, Node.js 24, pnpm workspace, `node:test` a stávající lokální Control Plane. Bez nové běhové závislosti a bez desktopového buildu.

**Specifikace:** `docs/superpowers/specs/2026-10-23-nomo-harness-beta-and-provider-compatibility.md`

## Globální omezení

- Zachovat dirty worktree a branch `feat/wp-regress`; žádný reset, stash, přepnutí větve ani široké stage.
- Žádný commit, push, merge ani release bez samostatného výslovného schválení. TUI a cizí změny se nesmí stageovat ani publikovat.
- Nedotýkat se TUI souborů (`packages/cli/src/tui/**`) ani TUI/task graph větve.
- Žádný SWE-bench, Docker běh, veřejný release, repo visibility změna, telemetry ani provider request.
- Provider tests používají lokální fixture HTTP server a syntetické klíče; nikdy skutečné tokeny.
- Žádné nové runtime závislosti ani import OMP/Prime implementací.
- Staré `compatible` a `anthropic` profily musí zůstat čitelné; chybná migrace nesmí přepsat platnou konfiguraci.
- Klíče a OAuth tokeny se nikdy nevrací UI rendereru, logu, error textu, issue formu, session eventu ani ledgeru.
- Žádná release pipeline ani desktop distribuce není součástí aktuální práce; nic se nevydává a nevyžadují se podpisové certifikáty.

## Výchozí stav a hranice

- Provider runtime: `packages/workbench/src/provider.ts`; configure/persistence: `packages/workbench/src/index.ts`; API route: `apps/control-plane/api/server.ts`; GUI: `apps/control-plane/ui/src/settings.tsx`.
- Provider tests: `packages/workbench/src/provider-stream.test.ts`, `packages/workbench/src/workbench.test.ts` a API tests v `apps/control-plane/api/`.
- Existující `apps/desktop/**` a desktopové workflow zůstávají beze změn; nejsou cílem sestavení, distribuce ani smoke testů.
- Beta docs: `docs/BETA.md`; tester feedback: `.github/ISSUE_TEMPLATE/feedback.yml`.
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
- Existující `apps/desktop/**` a desktop workflow jsou pouze zachované historické zdroje, ne soubory tohoto plánu.
- `.github/ISSUE_TEMPLATE/feedback.yml` a `docs/BETA.md`: tester onboarding a ruční feedback bez automatické diagnostiky.

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

**Následná bezpečnostní oprava H57:** Bedrock adaptér už nepřebírá `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` ani `AWS_SESSION_TOKEN` z ambientního `process.env`; bez credentials předaných typovaným descriptor-em selže uzavřeně. Redakce výstupů AgentRunneru nyní rozpoznává i proměnnou `AWS_ACCESS_KEY_ID`. Syntetické regresní testy pokrývají oba případy. Manifestový/API kontrakt H38 se nemění a plný Bedrock credential-chain setup ani parita providerů tím nejsou dokončeny. Ověření: Workbench suite 756 passed / 2 skipped, workspace typecheck, cílený API gate test 1/1; bez provider requestů a skutečných credentials.

**Rozhodnutí H58 (uživatel schválil):** Bedrock používá serverovou `defaultProvider` z `@aws-sdk/credential-provider-node`, nikoli statické credentials v provider descriptoru. Přímá závislost Workbenchu se připne na verzi `3.972.83`, která už je v workspace lockfile jako transitive závislost AWS CLI S3 klienta; jde o výslovnou výjimku z původního zákazu nových runtime závislostí. Typ autentizace bude `aws-credential-chain`, povolený pouze manifestem pro Bedrock; API odmítne statické `aws-credentials`. Nastavení vysvětlí, že při výslovném výběru chainu backend používá standardní host zdroje AWS SDK, včetně prostředí, SSO, sdílených profilů, web identity a ECS/EC2 metadata. Credentials se neukládají; chybějící chain selže uzavřeně a zachová předchozího providera. Regrese používají pouze syntetické credentials, izolovaný proces a HTTP request stub. Oficiální zdroje: [AWS SDK pro Node.js credentials](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html), [AWS SDK v3 credential providers](https://github.com/aws/aws-sdk-js-v3/blob/main/packages/credential-providers/README.md).

**Výsledek implementace H58:** Bedrock přijímá jen manifestem povolené `{ kind: "aws-credential-chain" }`; UI popisuje host chain včetně env, AWS profilu/SSO, web identity, ECS/EC2 a možného `credential_process`. Statický `aws-credentials` zůstává odmítnutý, neúspěšná konfigurace zachová předchozího providera a uložený stav neobsahuje vyřešené credentials. Ověření: Workbench 758 passed / 0 failed / 2 skipped; Control Plane API 33/33; UI 138/138, včetně cíleného 3/3 auth-mapper testu; `pnpm run typecheck`; čistý `env -i` browser smoke zobrazil české upozornění, na šířce 390 px bez overflow, bez chyb konzole a pouze s lokálními requesty. Connect formulář se při smoke neposlal. Izolované automatické testy používají syntetická credentials a fetch stub.

**Bezpečnostní výhrada H58:** První UI smoke spustil API s inherited prostředím. Načtení Settings volá `GET /api/provider` → `Workbench.providerState()`, který může při přítomném `NVIDIA_API_KEY` automaticky zkusit provider discovery. UI ukázalo odmítnuté credentials; serverové logy neprokazují, zda request opustil proces. Proto nelze potvrdit stop podmínku „žádný provider request / žádný přístup k credentials“. Procesy byly zastaveny a dočasná data smazána; žádný další credential/provider pokus neproběhl. Následný P2 review zjistil, že manifestový submit neobnovoval `busy` a výjimka z auth mapperu mohla obejít `catch/finally`; mapper je nyní uvnitř `try` a `finally` vždy nastaví `busy=false` a vyčistí API key. Následná read-only revize potvrdila opravu a nenašla další problém. UI suite 138/138 a workspace typecheck prošly; po zamítnutí browser eval nebylo možné změnu interaktivně ověřit a nástroj nebyl obcházen. H58 je implementačně hotový, ale zůstává blokovaný kvůli neověřitelné podmínce bez externího requestu. Read-only review také upozornilo, že refresh zajišťuje SDK a nebyl samostatně ověřen; auth mapper má cílený test, nikoli plný formulářový E2E test. H21 nadále neznamená plnou provider paritu.

**Rozhodnutí H63 (uživatel zvolil):** `GET /api/provider` volá
`providerState({ probeEnvironment: false })`, takže při obsluze tohoto
požadavku nečte properties environment credentials a nespouští environment
provider discovery ani fetch. Control Plane může environment objekt Workbenchi
předat už při konstrukci přes spread; toto rozhodnutí netvrdí, že proces
prostředí nikdy nepřečte nebo nekopíruje. Settings nabízí explicitní tlačítko,
které přes `POST /api/provider/probe-environment` ověří dostupné NVIDIA nebo
DashScope credentials na serveru. Defaultní `Workbench.providerState()` a
zahájení relace zachovávají dosavadní environment resolver, aby se nezměnilo
chování ostatních hostitelů. Testy používají pouze syntetické klíče a stub
fetch. Tato změna neodvozuje nic nového o předchozím H58 smoke; jeho nejistota
zůstává.


#### Kontrolní bod H39: zveřejnění schopností modelu

Nastavení zobrazuje schopnosti vybraného manifestového modelu pouze z ověřených dat manifestu. Rozhraní rozlišuje podporované, nepodporované, neznámé a rozporné údaje; chybějící či rozporná metadata nikdy neprezentuje jako podporovaná. Přístup je pouze lokální a bez provider requestu. RED/GREEN API test pokrývá přesný model, neznámý model, konflikt pinned katalogů a nulový počet provider requestů; testy existující suite katalogu a API ověřují regresi. Settings má přístupné zobrazení a browser smoke. H39 neuzavírá celý Úkol 13 ani blokátory H21/H31-H33.


## Fáze 5: tester feedback

### Úkol 14: Soukromý issue form a quickstart

- **Soubory:** vytvořit `.github/ISSUE_TEMPLATE/feedback.yml`; aktualizovat pouze `docs/BETA.md`.

**Akceptace:** tester s repo read access najde feedback link, může nahlásit reprodukovatelný problém, form nepožaduje API URL, prompt, response, session transcript, project files ani secrets. Soukromé issue zůstává v private repo. Žádné automatické uploady či telemetrie.

**Test:** YAML/schema validation zavedená v projektu nebo statická fixture test; ruční kontrola formu v GitHub preview se provede až s ownerem, bez odeslání issue.

## Historická fáze 6: soukromé desktop balíčky (mimo aktuální cíl)
Desktop buildy, Xcode, instalované smoke testy a release jsou vyřazené z další práce. Následující úkoly a jejich historické záznamy nejsou aktuální plán; existující zdrojové soubory zachovat.

### Úkol 15: macOS build workflow a install smoke

**Soubory:** vytvořit `.github/workflows/desktop-macos.yml`; upravit desktop build/release docs podle zjištěné CI konfigurace.

**Akceptace:** sestavit arm64 a x64 artefakty, spustit desktop tests a clean runner install/runtime smoke, vypočítat SHA-256. Signing/notarization pouze přes owner-provided GitHub secrets; bez nich workflow vytvoří pouze zřetelně interní unsigned artifact, nikoli bezvarovný release.

### Úkol 16: Windows build/release hardening

**Soubory:** upravit `.github/workflows/desktop-windows.yml`, pokud je to nutné; jinak jej ponechat.

**Akceptace:** existing NSIS install smoke zůstane, artifact obsahuje SHA-256, balíček spustí fixture provider setup, odinstalace nemění cizí soubory. Code signing je pouze volitelně owner secrets; žádný secret do logu.

### Úkol 17: Private release approval gate

**Soubory:** vytvořit nebo upravit `.github/workflows/desktop-release.yml` a `apps/desktop/README.md`.

**Akceptace:** workflow je ručně spuštěný a release job je chráněn GitHub environment approval; žádná push/tag událost sama nic nevydá. Release je jen pro soukromé repo a obsahuje verze, platformy, podpisový stav, checksumy, známé OS varování a private feedback link. Do schválení se workflow pouze testuje jako artifact build; release se nepublikuje.

## Fáze 6: Harness ověření a předání

### Úkol 18: Provider coverage a Harness acceptance

- **Soubory:** dotčené provider tests, `packages/workbench/src/workbench.test.ts`, `apps/control-plane/api/server.test.ts` a testy nastavení.

**Akceptace:** 100 % manifest coverage; relevantní Workbench/API/UI fixture suites; typecheck a docs-truth; ověřit lokální web/CLI cestu. Nevolat reálné providery. Ověřit, že `packages/cli/src/tui/**` a TUI graph nemají změny, ale nepoužívat široký reset/stash.

**Příkazy:**

```sh
node --experimental-strip-types --test packages/workbench/src/provider-catalog.test.ts packages/workbench/src/provider-stream.test.ts packages/workbench/src/workbench.test.ts
pnpm --filter @void/workbench run typecheck
```

Platformní desktop smokes jsou mimo aktuální cíl a nesmí se spouštět. Konečná full suite se spustí jednou po dokončení všech implementačních úkolů.

## Approval gates a otevřené blokery

1. Uživatel dne 2026-10-23 výslovně schválil implementaci tohoto plánu a specifikace.
2. Owner udělí testerům GitHub read access sám. Žádná změna repo visibility.
3. Desktop signing/notarization a platformní balíčky jsou historické a mimo aktuální cíl; nežádat kvůli nim owner credentials.
4. Každý nepovolený nebo nedokumentovaný provider auth flow zastaví daný adapter. Žádné napodobení skrytého loginu ani použití lokálního OMP/Prime tokenu bez souhlasu.
5. H19 project secret boundary zůstává nezávisle blokovaná; implementace coding workspace capability se nezačne, dokud její vlastní návrh není schválen.
6. Žádné automatické commit/push/merge/release. Commit nebo push vyžaduje samostatné výslovné schválení; merge, release, změna přístupů a skutečné provider požadavky nejsou povolené.

### Historický úkol 19: Ověřit a publikovat Harness-only větev (záznam, neopakovat)

**Soubory:** pouze Harness soubory už změněné v pracovním stromu; nikdy `packages/cli/src/tui/**` ani `.nomo/work-state.json`.

**Historická akceptace:** Původní schválený rozsah zahrnoval provider, Workbench, API, UI a desktop fixture testy, docs-truth i `pnpm run typecheck`; nejde o požadavek aktuálního cíle ani důkaz současného stavu remote.

Dříve zaznamenané dokončené kroky níže jsou historická evidence, nikoli povolení opakovat commit nebo push na aktuální worktree.
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

## Aktuální plán dokončení Harnessu, 2026-10-27

Tato aktualizace nahrazuje dřívější webové a desktopové cíle tohoto plánu. Historické záznamy implementace zůstávají zachované, ale neurčují další práci.

### Hranice práce a výchozí stav

- Pracovat pouze v existujícím `.worktrees/agent-harness` na větvi `feat/wp-regress`. Nový worktree by zde buď vynechal existující změny, nebo je duplikoval. V tomto worktree zachovat všechny rozpracované změny; v hlavním checkoutu a TUI worktree nic neupravovat.
- Povolený rozsah: Workbench runtime, provider adaptéry a manifest, control-plane API jen pokud je nutné pro backend kontrakt, CLI instalátor a jeho testy, související Harness dokumentace, canonical task graph a Obsidian Work Log.
- Zakázaný rozsah: `apps/control-plane/ui/**`, web GUI, browser smoke/build, TUI změny, desktop/Xcode, SWE-bench, Docker a nesouvisející worktree. Neprovádět živé provider požadavky, nepřebírat tajemství a nezavádět neautorizovaný OAuth.
- „OpenAI compatible“ zahrnuje outbound provider adaptéry i inbound endpointy. Schválený inbound rozsah je pouze `GET /v1/models` a textový `POST /v1/chat/completions` podle `docs/superpowers/specs/2026-11-07-nomo-inbound-openai-chat-completions.md`; neimplikuje OpenAI OAuth ani další OpenAI resources.
- Aktivní Harness worktree obsahuje uživatelské rozpracované změny. Každý krok musí omezit editaci na ověřené Harness cesty; žádné hromadné uklízení, reset, commit, push ani merge.
- Canonical task graph zůstává jediným zdrojem stavu úkolů. Graphify/Understand Anything indexy jsou zastaralé nebo ukazují jiný worktree; nepoužívat je jako důkaz aktuálního stavu. Obsidian zůstává projekční paměť, nikoli druhý task graph.

### Fáze 1: Bezpečná CLI instalační cesta

1. Ověřit instalátor v izolovaném dočasném HOME a s falešným `pnpm`; žádný síťový přístup, skutečný účet ani zásah do uživatelova HOME.
2. Opravit rozpor, kdy instalátor vytvoří příkaz `nomo`, ale po instalaci vypíše `void`.
3. Přidat behaviorální regresní test: izolovaný běh instalátoru uspěje, vypíše přesný skutečný příkaz `nomo` a nevypíše zavádějící `void`. Zachovat současné testy launcheru, dependency freshness a bezpečného odmítnutí cizího launcheru.
4. Přijímací kritérium: `node --test scripts/src/install-nomo.test.mjs` projde; pomoc testerovi odpovídá CLI instalátoru a nevyžaduje web GUI ani jeho test.
5. Tester stále potřebuje udělený read access k soukromému repozitáři, Git, Node 24+ a pnpm. Přístup uděluje vlastník ručně; plán nemění viditelnost repozitáře ani nezveřejňuje balíček.

### Fáze 2: Kvalita core coding-agent Harnessu

1. Zachovat Workbench jako jediný runtime a autoritu pro identity, grants, policy, ledger, consent a privátní workspace.
2. Při změně runtime ověřit celý dotčený tok: vznik a ukončení runu, validitu identity/grantu, filtraci workspace, mediaci nástrojů, revokaci, stream eventů, bounded/redacted výstup, chyby a cancellation. Nezavádět paralelní runtime ani obecnější abstrakci bez acceptance důkazu.
3. Udržet monotonicitu AgentRunner stavů; přechod `running` zpět do `starting` musí být odmítnut. Existující targeted testy a Workbench typecheck jsou výchozí regression gate.
4. Každá nalezená závada dostane reprodukční failing test, nejmenší opravu, passing focused test a kontrolu callerů. Bez reprodukované chyby se nemění fungující kontrakt.

### Fáze 3: Dokončení provider compatibility kontraktu H21

1. Použít připnuté OMP/Prime baseline a checked-in manifest jako úplný zdroj inventory. Coverage musí klasifikovat každý provider/model řádek, transport, endpoint, discovery, auth a podporované schopnosti; neznámý řádek musí test zastavit.
2. Pro implementované obecné model API transporty dokončit důkazy lokálními fixture testy pro request mapping, streaming pořadí, tool calls, usage, cancellation, chyby a redakci tajemství. Každá capability smí být označena podporovaná jen s odpovídajícím kontraktem a testem.
3. Manifest nyní uvádí 17 implementovaných, 7 blokovaných a 1 platformně nedostupný transportní řádek. Blokované řádky zahrnují agent/proprietární protokoly Cursor, Devin, Factory Droid, GitLab Duo Agent, Google Gemini CLI a OpenAI Codex Responses. Nezaměňovat je za běžné OpenAI kompatibilní API; neoznačit je jako podporované bez autoritativního transportního a auth kontraktu.
4. Uživatel zvolil zachovat dependency-free Harness. Osm OMP 18.6.2 `local` tiny modelů zůstává bez runtime adapteru a bez workeru; NOMO je explicitně vrací jako `unavailableModelTransports` se stavem `blocked`, důvodem a přesnými model IDs přes `Workbench.providerState()` i `GET /api/provider`. Nejde o OMP agent integraci ani generic HTTP endpoint. Plná OMP parita zůstává nesplněná a nesmí se tak prezentovat.
5. Všech 209 in-scope OMP Bedrock chat modelů nyní dostává descriptor přes existující NOMO `aws-credential-chain`, pouze pokud pinned manifest deklaruje `native-auth` i `host-credential`; test navíc vyžaduje přesnou shodu model ID a endpointu. Jde o mapování zdrojově deklarované host-chain cesty na existující AWS SDK `defaultProvider`, nikoli o import OMP resolveru. OMP bearer-token cesta zůstává nepodporovaná; žádné OMP OAuth/runtime ani provider request. Zdroje: https://raw.githubusercontent.com/can1357/oh-my-pi/v18.6.2/packages/ai/src/providers/amazon-bedrock.ts, https://raw.githubusercontent.com/can1357/oh-my-pi/v18.6.2/packages/ai/src/providers/aws-credentials.ts, https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/migrate-credential-providers.html#default-credential-provider.
6. OMP Ollama Cloud podporuje 51 připnutých chat modelů s API-key autentizací a výběrem pouze modelů z manifestu; lokální Ollama zůstává na loopbacku bez autentizace. Pět připnutých Bedrock Mantle Responses modelů používá striktní regionální endpoint a oddělené profily API-key Bearer nebo typovaného AWS credential chainu. Host credentials se načtou pouze při výslovném completion; SigV4 podepisuje `/openai/v1/responses` službou `bedrock-mantle` a výpis katalogu zůstává lokální. OMP bearer-token resolver ani `AWS_BEARER_TOKEN_BEDROCK` token-provider tok nejsou implementované. Zdroje AWS: https://docs.aws.amazon.com/bedrock/latest/userguide/endpoints.html, https://docs.aws.amazon.com/bedrock/latest/userguide/count-tokens.html#count-tokens-mantle, https://docs.aws.amazon.com/bedrock/latest/userguide/inference-responses-api.html#bedrock-mantle-prereq. Poslední lokální brány: Mantle 7/7; Workbench 851 prošlo / 2 přeskočeny; Control Plane API 41/41; Workbench a Control Plane typecheck prošly. Pouze syntetické přihlašovací údaje a injektovaný fetch; žádný provider request ani skutečné credentials. Aktuálně manifest blokuje sedm API řádků, čtyři skupiny modelů / 32 řádků a jeden platformně nedostupný transport; Prime serving metadata zůstávají bez typovaného pole. H21 není dokončený a plná OMP/Prime parita není prokázaná.
7. Prime model-serving metadata zůstávají blokována, dokud neexistuje autoritativní typované pole. Neodvozovat serving heuristikou, ručním allowlistem ani blocklistem.
8. Přijímací kritérium: žádný provider ID se neztratí; každá položka je implementovaná s odpovídajícím testem, explicitně vyloučená podle připnutého zdroje, nebo označená blokovaná s přesným důvodem. H21 zůstává nehotová, dokud některý in-scope řádek nemá nepokrytý kontrakt.

### Fáze 4: Autentizace a bezpečné nastavení

1. Pokračovat jen v autentizačních postupech výslovně podporovaných připnutým provider kontraktem. API klíče a OAuth tokeny nesmějí uniknout do rendereru, logu, error textu, ledgeru ani feedback exportu.
2. Každý lifecycle test musí pokrýt bezpečné uložení, chybné/neúspěšné přepnutí, reauth/disconnect a zachování předchozího funkčního provideru. Všechny testy používají syntetická tajemství a lokální fixture server.
3. H12 OpenRouter a H13 OpenAI OAuth smoke jsou blokovány, dokud není k dispozici bezpečné a explicitní předání oprávnění. OMP OAuth se nesmí zaměnit za OpenAI API key; přímý OpenAI OAuth ani privátní app-server se nepředstírá.
4. Historickou nejistotu H58 o zděděném prostředí neopakovat v živém prostředí. Tato větev se uzavře jen novým bezpečným, izolovaným důkazem nebo zůstane dokumentovaně blokována.

### Fáze 5: OpenAI-compatible chování a tester feedback

1. Ověřovat pouze odchozí OpenAI Chat Completions, Responses a schválené Azure varianty lokálními fixtures. Pokrýt stream, nástroje, usage, chyby, cancellation a redakci; bez externího API klíče.
2. Zachovat soukromý feedback formulář bez automatické telemetrie nebo připojování promptů, odpovědí, URL a tajemství.
3. Tester onboarding musí popsat pouze Harness/CLI cestu, požadavky na runtime, read access, diagnostiku a soukromý feedback. Web GUI není akceptační cíl; změny UI ani browser smoke nejsou podmínkou.
4. Nepublikovat balíček ani neměnit přístupová práva. Testerům chybějící soukromý přístup musí udělit vlastník.

### Fáze 6: Inbound OpenAI Chat Completions API
1. Implementovat pouze `GET /v1/models` a `POST /v1/chat/completions` přes existující Control Plane auth a Workbench runtime; client `tools`, tool-role messages, multimodal inputs, `n > 1`, nepodporované parametry a neznámé modely odmítnout před vytvořením session.
2. Povolit jen textové `system`, `developer`, `user` a `assistant` zprávy; serializovat je jako caller-supplied transcript, který nenahrazuje interní NOMO system policy. Přijmout pouze `model`, `messages`, `stream` a explicitně schválené kompatibilní parametry.
3. JSON vrací standardní Chat Completion response. `stream: true` používá OpenAI SSE chunk framing, ale finální bounded/redacted obsah pošle až po doběhnutí Workbench runu (nejde o tokenový live stream); končí `finish_reason` a `[DONE]`. Při disconnectu se ruší pouze run založený daným HTTP requestem.
4. Přijímací kritéria: validní fixture ověří model discovery, textovou historii, completion, JSON/SSE, secret redaction, disconnect cancellation a single-run ownership. Invalid request/mode/model musí před vytvořením runu selhat; ověřit existující Control Plane auth/origin gate.
5. Testy nepoužívají OpenAI klíč, provider volání, externí síť ani runtime credentials; žádné client tools se nevykonávají.
### Fáze 7: Cílená a závěrečná verifikace

1. Po každé změně spustit nejmenší behaviorální test reprodukující acceptance, pak související Workbench/API/installer suite podle dotčených cest.
2. Před prohlášením Harnessu za hotový spustit `pnpm --filter @void/workbench test`, `pnpm --filter @void/workbench run typecheck`, `pnpm run typecheck`, `node --test scripts/src/install-nomo.test.mjs` a `node --test scripts/src/doc-truth.test.mjs`. API testy spustit, pokud se změnilo API; provider coverage test spustit po změně manifestu/generátoru.
3. Testy, které by spustily web GUI, browser, TUI změny, desktop, SWE-bench nebo Docker, do této verifikace nepatří. Žádná syntax/typecheck kontrola se nesmí vydávat za smoke běžícího Harnessu.
4. Zkontrolovat pouze vlastní diff povolených Harness cest, aktualizovat graph evidence a Obsidian Work Log a uvést každý neprovedený gate i důvod. Nezahrnout do změny cizí worktree obsah.

### Podmínky dokončení a blokery

- „Harness dokončen“ lze říci až po splnění všech in-scope acceptance v H21, secure setup/auth, CLI instalaci, OpenAI-compatible fixturech, soukromém feedback flow a relevantních test/typecheck gatech. Výslovně vyřazené GUI, TUI, desktop a SWE-bench/Docker nejsou součástí tohoto cíle.
- Aktuální blokery, které kód sám neodstraní: chybějící autoritativní Prime serving metadata; nepodporované/proprietární transporty a jejich auth kontrakty; bezpečné předání přihlašovacích údajů pro H12/H13; bezpečné uzavření H58; vlastníkovo udělení přístupu testerům do soukromého repozitáře.
- Pokud některý blokovaný provider zůstane součástí schváleného in-scope rosteru, celý požadavek na plnou OMP/Prime kompatibilitu zůstává nehotový. Výsledek se musí popsat jako částečně ověřený Harness, ne jako ekvivalent Prime Agentu nebo OMP.
- Zastavit konkrétní loop při neznámém kontraktu, odhalení tajemství, nepovoleném souboru, cizí změně, síťovém požadavku nebo regresi testu; zachovat rozpracovaná data a přesně zaznamenat blocker.

## Aktualizace rozsahu, 2026-11-09

Tato poznámka nahrazuje pouze dřívější rozhodnutí o TUI a OpenAI OAuth. Uživatel schválil lokální OpenAI Sign in with ChatGPT návrh, vybral současně outbound OpenAI Responses i inbound H69/H73 Chat Completions podmnožinu a znovu otevřel pouze TUI pro provider účet. Web GUI, browser smoke, desktop, Docker, hosted produkce a skutečný provider request zůstávají mimo rozsah nebo blokované. Zbytek staršího plánu a jeho historické důkazy zůstává zachován.

Zvolený cílový checkout je `.worktrees/local-harness-readiness`, výchozí HEAD `521b1c8` na `origin/main`, který obsahuje publikované H73. Starší `.worktrees/agent-harness` na `feat/wp-regress` je mimo cíl a zůstává nedotčený; jeho tip `975538a` neobsahuje publikovaný main snapshot. H21 zůstává blokované na dokumentovaných transportních/auth kontraktech zbývajících OMP/Prime položek, bez tvrzení o paritě.

### H74: Scope a oficiální OpenAI SIWC kontrakt

Hotovo jako dokumentační brána. Oficiální OpenAI dokumentace vyžaduje první dynamickou registraci, uchování vydaného `client_id`, stabilní `ext_agent_host_id`, HTTP loopback callback na `127.0.0.1` s přesnou cestou, PKCE, čerstvé `state`/`nonce`, validaci ID tokenu podle podpisu/JWKS, issuer, audience, expiry a nonce, a vazbu tokenů na ověřenou identitu/client ID. Ověřit udělené scopes včetně `chatgpt.tokens.use.direct`. Refresh používá rotující tokeny a musí být serializovaný. Odhlášení se pokusí o oficiální revokaci a nepotvrzený výsledek musí být zobrazen pravdivě. Inference smí volat jen veřejný Responses endpoint s `store: false` a `stream: true`; modely se načtou pro zvolený účet. ChatGPT backend endpoints jsou zakázány. H74 použil pouze oficiální dokumentaci, žádná tajemství nebo síťový provider request.

Zdroje: https://developers.openai.com/siwc/token-sharing-open-source/sign-in, https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions, https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference, https://developers.openai.com/siwc/token-sharing-open-source/token-reference, https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery, https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations.

### H75: Workbench a lokální Control Plane lifecycle

Uživatel zvolil sdílení OAuth registrací i účtů mezi místními NOMO workspaces na jednom hostiteli. Účty proto patří do host-level šifrovaného úložiště mimo `NOMO_DATA_DIR`, postaveného na existujícím `LocalStorage`; refresh, reauth a disconnect se serializují napříč procesy.

Po H74 test-first implementovat registraci, callback, identitu, granted-scope enforcement, šifrované uložení a obnovu, serializovaný refresh, revokaci a provider selection přes existující Workbench. Každé encrypted store používá persistent SQLite transaction lock uvnitř directory sentinel na historické lock cestě (`workspace.enc.lock` pro workspace, `accounts.lifecycle.lock` pro host auth). Atomic mkdir na nepřítomné cestě a legacy `open(wx)` soupeří o jedinou cestu; právě jeden ji získá a poražený fail-closed odmítne. Test ověřuje oba výsledky jednoho takového závodu. To ale neřeší stale reaper, který už před instalací sentinelu ověřil mrtvý PID, zatímco jiný legacy writer následně získal PID lock a vstoupil do kritické sekce. Reaper může později pathname unlinknout a umožnit novému writeru vstoupit na jiné SQLite inode, takže mixed-version překryv zůstává možný. Sentinel chrání proti následnému legacy unlink jen po instalaci. Převod existujícího souboru na adresář fail-closed odmítá. Sdílený cutover proto vyžaduje důkaz, že před instalací neexistuje žádná již admitovaná stará kritická sekce nebo stale reaper schopný takové přerušení; potvrzená lokální starší TUI instance není quiescent. Rollback k PID-only binárkám není bez samostatného převodního protokolu podporován. Testy kandidáta nejsou důkaz cutoveru. Callback je jednorázový server na náhodném portu, vázaný pouze na `127.0.0.1` a přesnou cestu `/auth/callback`; jen port se může měnit. TUI otevře systémový prohlížeč shell-free příkazem a authorization URL nevypíše. Reautorizace neposílá `id_token_hint` ani `login_hint`, aby ID token a e-mail nebyly v URL/argumentech spouštěče; ověřený ID token se zahodí po validaci. Oficiální výběr účtu zůstává součástí flow. Žádá se pouze o dokumentované `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct` scopes. Model discovery používá account-bound `/v1/models` odpověď `models[]`, filtruje pouze `visibility: "list"` a předává uživateli `display_name`/`slug`; nesmí zaměnit tento tvar za běžný OpenAI `data[]` katalog. Pokud validní token nedostane `chatgpt.tokens.use.direct`, zachovat pouze ověřenou registraci účtu jako plan-usage-disabled a inference zakázat; nabídnout explicitní zapnutí s plným scope setem a consent jen po akci uživatele. OAuth/admission chyby zachovají HTTP status, tvar těla, machine code a request ID bez vypisování raw citlivého obsahu; usage-limit kód vede na oficiální Manage usage. Potvrzený invalid/revoked token vyžaduje reauth, dočasná síťová chyba tokeny nemaže. Fixture testy pokryjí špatný state/nonce/PKCE/client ID, chybný nebo vypršelý ID token, chybnou audienci/issuer, chybějící consent scope, refresh race/rotaci, neúspěšné uložení, account switch a revocation failure. Provider adapter použije jen povolený account-visible model a přesný Responses API kontrakt; existující OpenAI API-key a generic-compatible profily zůstanou oddělené a nedotčené při selhání setupu. Žádný live provider požadavek.

### H76: TUI účet a provider stav

Po H75 TUI nabídne podporovaný connect/reauth/disconnect postup, account/model/permission/usage status a jasné stavy chyb. Použije jen safe Workbench/API projection. Tokeny, authorization code a URL s citlivými query parametry se nevypíší. `/connect chatgpt [ACCOUNT_ID]` spouští novou autorizaci nebo reauth; `/chatgpt` zobrazí účty, `/chatgpt enable ID` žádá výslovné plan-usage consent, `/chatgpt models ID` vypíše pouze account-visible modely, `/chatgpt use ID MODEL` aktivuje zvolený profil a `/chatgpt disconnect ID` nejprve vyžádá potvrzení. Nový účet nepřepíše existující provider až do výslovného výběru modelu. Pokrýt empty, connected, declined-scope, reauth, usage-limit a remote-revocation-unconfirmed stavy. Měnit jen vlastněné TUI soubory v aktuálním Harness checkoutu; jiné TUI worktrees zůstanou nedotčené.

### Uzávěr

H75/H76 vyžadují cílené RED/GREEN fixtures, související Workbench/API/TUI suites, typecheck a security review. Volitelný jediný živý Responses smoke zůstává samostatnou bránou po lokálním ověření, s uživatelovým explicitním ChatGPT plan souhlasem, disposable synthetic projektem a kontrolou přesného přenosového přehledu před autorizací. Nikdy nečíst, žádat ani vypisovat token. Pokud bezpečný consent nebo account eligibility není dostupná, smoke zůstane blokovaný bez fallbacku.
