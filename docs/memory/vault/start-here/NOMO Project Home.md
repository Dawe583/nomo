---
title: NOMO Project Home
tags:
  - nomo
  - project-home
status: active
---

# NOMO Project Home

## Connected memory areas

- [[Governance Map]]: rules and decisions.
- [[Product and Strategy Map]]: direction, roadmap and hypotheses.
- [[Architecture Map]]: source map and authority.
- [[Delivery Map]]: active delivery and verification.
- [[Research Map]] and [[Skills and Tooling Index]]: evidence and reusable procedures.
- [[Operations Map]], [[Work Log Map]], [[Archive Map]], [[Generated Index Map]].

## Knowledge system

- Start: [[NOMO Start Here]].
- Full structure: [[NOMO Knowledge Map.canvas]].
- Writing and authority rules: [[NOMO Memory Rules]].


## NOMO navigation

Start with [[NOMO Start Here]] for task routing and [[NOMO Knowledge Map.canvas]] for the whole-vault map. [[NOMO Memory Rules]] defines the authority and writing contract.

### Product & Strategy
- [[NOMO Field Expert Strategy]]
- [[NOMO Product Direction]]
- [[NOMO Decisions]]
- [[NOMO Product Roadmap]]

### Architecture & Memory
- [[NOMO Code Graph]]
- [[NOMO Memory Rules]]

### Work & Delivery
- [[NOMO TUI Control Center]]
- [[NOMO Work Log]]
- [[NOMO Hunt Queue]]
- [[NOMO Loop Graph]]

## NOMO TUI current control center - 2026-10-30

- Use [[NOMO TUI Control Center]] as the single current TUI status and owner pointer.
- Clean integration worktree: `NOMO/.worktrees/tui-clean-continuation`, branch `tui/clean-continuation-2026-10-30`, starting at `origin/main` 521b1c8.
- OpenCode TUI worktree/branch were removed by explicit user direction. Do not revive that lane.
- OMP's uncommitted candidate worktree remains preserved and under audit. Do not delete or merge it until every file is classified and its tests are rerun.
- Older TUI plans and code snapshots below are historical. Follow the current repository plan and graph instead.

## Pracovní pravidla

- Paměť a rozhodnutí: [[NOMO Memory Rules]].
- Produktový směr: [[NOMO Product Direction]]; milníky: [[NOMO Product Roadmap]].
- Aktuální Harness úkoly a blokace: `.nomo/harness-work-state.json` ve worktree `NOMO/.worktrees/agent-harness`.
- Pracovní záznamy: [[NOMO Work Log]].
- Kódový graf: [[NOMO Code Graph]] a `Graphify-Index/NOMO-Harness/README.md`.
- Tento Obsidian index neduplikuje specifikace ani kódové kontrakty z repozitáře.

## Aktuální Harness stav - 2026-11-07

- H67 zůstává hotový. H69 přidává inbound `/v1/models` a `/v1/chat/completions` pouze v izolovaném kandidátním worktree; implementace zatím není v `main`. SSE posílá finální výstup až po dokončení běhu Workbench, nikoli průběžné tokeny.
- Ověření kandidáta: API 47/47, Workbench 856 prošlo a 2 nakonfigurované sandbox testy přeskočeny, typecheck prošel, docs-truth 9/9.
- Canonical Harness graph má 70 uzlů: 66 hotových, H21 aktivní, H71-H73 ready, 0 blocked. H70 dokončil read-only audit: SSE rámování odpovídá omezenému subsetu, ale `stream_options.include_usage` je odmítnuté a streamed usage chybí. H73 připravuje úzce omezené doplnění usage; H71/H72 čekají na audit oficiálních kontraktů Cursor Agent a Devin Agent.
- Všechny zkontrolované worktrees zůstávají dirty: root 166 staged / 2 unstaged / 15 untracked; `agent-harness` 1 / 73 / 4; `main-current` 0 / 52 / 5; izolovaný kandidát 164 / 7 / 2. H73 musí před změnou ověřit vlastnictví cílových dirty souborů; main synchronizace není bezpečná.
- TUI a ostatní cizí změny nebyly upraveny. Graphify `.graphify_root` chybí; `.ua` obsahuje neověřené intermediate artefakty. Obsidian CLI nenalezl běžící aplikaci.
- Podrobnosti, přesná omezení a test evidence jsou v `.nomo/harness-work-state.json` a [[NOMO Work Log#2026-11-07 - Harness boundary recheck]].

## Historický Harness stav - 2026-10-27

- Aktivní worktree: `NOMO/.worktrees/agent-harness`, větev `feat/wp-regress`.
- Commit `5ce70e6` přidává regresní test precedence tokenů NOMO před legacy aliasem; cílený Node test (3/3) a TypeScript kontrola prošly.
- Commit je lokální; push čeká na dostupné GitHub přihlášení.
- H43 Graphify refresh je hotový: jediný změněný in-scope soubor aktualizoval zastaralou hranu z L26 na L44. Graf zachoval 2 190 uzlů a 5 816 hran; diagnostika: 0 dangling/kolabovaných hran, 19 self-loopů a známých 216 referenčních stubů s 432 upozorněními. TUI nebylo skenováno ani změněno.
- Scope zůstává pouze Harness. TUI ani SWE-bench/Docker se neupravují.
- H19 hranice projektu splňuje svůj schválený ne-TUI verifier: cílené Workbench testy 31 prošly, 2 přeskočeny; UI 132/132, typecheck, web build, browser smoke i security review prošly. H19 je hotový. Oddělená úplná workspace gate zůstává blokovaná chráněnou CLI/TUI fixture a PTY selháním a chybějícím Appwrite/Rust toolingem; TUI se neměnilo.
- H54 i H55 jsou hotové: bezpečný AgentRunner consent flow a omezený výstup do šifrovaného session chatu. H55 limity: 16 KiB UTF-8/zpráva, 64 KiB/běh; testy kryjí známý secret, truncation, terminal failure/cancel a oddělení signed ledgeru. Workbench 754 passed / 2 sandbox skip, API 261/261, UI 134/134, typecheck/build a skutečný browser smoke na sestaveném Control Plane prošly. Synthetic local-only runner; žádný provider request ani externí host.

- H63 je hotový: `GET /api/provider` je pasivní při obsluze requestu; Settings
  má explicitní environment check. Při H63 closeout měl graf 60 uzlů:
  54 done, 6 blocked, 0 active a 0 ready. H58 zůstává blocked; H63 nemění
  nejistotu, zda předchozí inherited-environment smoke četl credential nebo
  zda upstream request opustil proces. Ověření používalo syntetické
  credentials a stubbed provider fetch; bez live requestu, browser/visual
  smoke nebo kliknutí. Podrobnosti: [[NOMO Work Log#2026-10-26 — H63: passive provider status and explicit environment check]].
- H21 has fixture coverage for OpenAI/Azure Responses refusals, OpenAI Chat
  Completions `function_call` and post-terminal stream rejection, Anthropic
  terminal/tool/SSE behavior, Cloudflare Anthropic SSE header passthrough,
  Google GenAI and Bedrock terminal ordering, and Mistral Conversations
  rejection of data after `conversation.response.done`. The Mistral ordering
  guard is conservative; its docs expose a generic `ConversationEvents`
  schema. OpenAI and Mistral focused suites: 16/16 and 14/14. Full Workbench
  791 total, 789 passed, 2 skipped, 0 failed; workspace `pnpm run typecheck`
  passed. Details:
  [[NOMO Work Log#2026-10-27: H21 Mistral Conversations post-completion event]].
- H21 OpenRouter routing preference gap is closed end-to-end: typed `/api/provider`
  validation and Workbench state persist the full gateway options; Settings
  exposes a provider-scoped optional JSON editor. API 35/35, gateway 7/7, UI
  138/138, full Workbench 789 passed / 2 skipped, typecheck passed. Browser
  smoke captured the request locally; no provider call or credential.
  H21 remains active with incomplete parity. Details:
  [[NOMO Work Log#2026-10-27: H21 OpenRouter routing preferences in Settings]].
- Prime model catalog contains `cloudflare/clef`, which is Evaluation-API-only;
  filtering waits for authoritative serving-field contract. H21 stays active;
  graph is 61 nodes, 55 done, 5 blocked, 1 active, 0 ready. Full parity remains
  incomplete; manifest blocked transports remain blocked. H63 done, H58
  blocked. Google GenAI/Vertex image input is implemented under the approved contract; final browser-send smoke is incomplete. Details: [[NOMO Work Log#2026-10-27: H21 Google/Vertex image input]].

- Rozsah od 2026-10-27: žádná desktopová aplikace ani práce s Xcode. H34
  zůstává blokovaný, ale je mimo cíl; existující `apps/desktop` zůstává
  nedotčené. OpenAI kompatibilita je odchozí podle schválené specifikace.

- Rozhodnutí 2026-10-27: práce je pouze na coding-agent Harnessu; neupravovat
  `apps/control-plane/ui/**` ani provádět browser smoke. Backend/API zůstává
  v rozsahu jen jako přímá součást Harnessu.
- Nejnovější H21 fixture: Google GenAI odmítá více kandidátů než výchozí
  jediný a nenulový `Candidate.index`; Google suite 12/12, celý Workbench
  791 prošlo, 2 přeskočeny. Review bez připomínek; bez živého provider požadavku.
  [[NOMO Work Log#2026-10-27: Google GenAI single-candidate odpovědi]].
- Druhý audit OpenAI, Anthropic, Bedrock, Mistral a Ollama nenašel další
  bezpečnou fixture změnu. H21 zůstává aktivní; další změny čekají na
  autoritativní kontrakt nebo schválený návrh. Graf má 0 ready uzlů.

- AgentRunner event validation now rejects `running` → `starting` regressions.
  Focused runner/integration tests passed 20/20 and Workbench typecheck passed.
  [[NOMO Work Log#2026-10-27: AgentRunner status monotonicity]].
- H21 zůstává aktivní a plná OMP/Prime kompatibilita není hotová. Graf má
  62 uzlů: 56 done, 5 blocked, 1 active (H21), 0 ready. Manifest obsahuje
  17 implementovaných, 7 blokovaných a 1 platformně nedostupný transport.
  Prime serving metadata stále čekají na autoritativní typované pole; H12/H13
  na bezpečné předání přihlašovacích údajů; H58 se nesmí znovu re-smokovat.

- Uživatel zvolil zachovat dependency-free Harness. Osm OMP `local` tiny modelů
  se nespouští; jejich `local-inference` transport nyní API explicitně vrací
  jako blokovaný s důvodem a přesnými model IDs. Žádný OMP agent/runtime ani
  worker se nespouští a nejde o obecné OpenAI API. Plná OMP parita zůstává
  nesplněná. [[NOMO Work Log#2026-10-27: H21 local tiny runtime coverage]].

- Ověření blockeru: Workbench 798 (796 prošlo, 2 přeskočeny), Control Plane
  API 37/37, Workbench typecheck a docs-truth 9/9. Harness jako celek zůstává
  nedokončený kvůli ostatním H21/H12/H13/H58 blockerům.

- Aktualizace 2026-10-28: lokální Harness diff teď pokrývá jediný připnutý
  Prime Cloudflare Workers AI model přes HTTPS endpoint vázaný na účet. Ověření:
  cílené 77/77, Workbench 807 passed / 2 skipped, Workbench a API typecheck,
  docs-truth 9/9. Změna není commitnutá; worktree obsahuje dřívější rozpracované
  změny a bezpečný čistý testovací worktree blokuje chybějící deklarace
  `@aws-sdk/credential-provider-node`.
- H21 zůstává aktivní: čtyři blokované modelové skupiny / 32 řádků a sedm
  blokovaných API řádků. Ostatní transporty vyžadují proprietární protokol,
  nedoloženou autentizaci nebo bezpečné přihlášení. Obecné Prime `serving`
  schéma zůstává nedoložené, ale Prime API mapuje `decisions` na Evaluations
  API. Workbench tyto modely vyřazuje z Chat Completions; cílené Prime/factory
  testy prošly 32/32, celý Workbench 684 passed / 2 skipped. Typecheck,
  Prettier kontroly zdrojů/testů a docs-truth 9/9 prošly. H12/H13 čekají na
  bezpečný credential handoff, H58 se nesmí znovu testovat proti převzatému
  prostředí. H6/TUI a H34/desktop zůstávají mimo rozsah.
  [[NOMO Work Log#2026-10-28: Prime Evaluation modely mimo Chat Completions]].
- Commit `8367872` obsahuje jen Prime adapter, jeho test a README; non-force push na `origin/feat/wp-regress` posunul větev `2c4740f..8367872`. Ostatní změny ve worktree zůstaly mimo commit.
- CompatibleProvider nyní odlišuje `TimeoutError` od selhání spojení; test
  reprodukoval starou chybnou hlášku. Cílené testy 26/26, Workbench sada
  832 passed / 2 skipped a typecheck prošly.
- Commit `b15f454` je pushnutý na `origin/feat/wp-regress`; obsahuje jen
  CompatibleProvider timeout hunk a regresní test. Ostatní změny zůstaly mimo
  commit.
- OpenAI Responses timeout se také zobrazuje jako `Provider request timed
  out.` místo selhání spojení. Cílené testy 41/41, Workbench sada
  833 passed / 2 skipped, typecheck prošly; `2884570` je pushnutý.
- Google GenAI nyní hlásí interní timeout odlišně od selhání spojení.
  Cílené testy 40/40, Workbench sada 834 passed / 2 skipped a typecheck
  prošly. Commit `16bc520` je potvrzený na vzdálené větvi přes `ls-remote`.
- Bedrock ConverseStream opraveně rozlišuje interní timeout od selhání spojení;
  zachovává zrušení volajícího i provider status chyby. Testy Bedrock/factory
  39/39, Bedrock suite 14/14, typecheck prošly; plná Workbench sada 835 passed /
  2 skipped. Commit `e235f8d` je pushnutý na `origin/feat/wp-regress`;
  nesouvisející změny zůstaly nestaged.
- OpenAI Responses nyní převádí timeout při čtení SSE streamu na
  `Provider request timed out.`; ostatní chyby čtení, včetně existujícího
  rušení, zůstávají zachovány. Cílené testy 17/17, typecheck a plná Workbench
  sada 836 passed / 2 skipped. Commit `1267ba5` je pushnutý; cizí
  model-ID validation hunk zůstal mimo commit.
- Anthropic SSE body timeout už vrací `Provider request timed out.` namísto
  obecné chyby streamu. Cílené testy 10/10, typecheck i plná Workbench sada
  837 passed / 2 skipped. Commit `f9ad7d2` je pushnutý na
  `origin/feat/wp-regress`.
- Google GenAI nyní převádí timeout z SSE readeru na
  `Provider request timed out.`. Zachován průchod původního AbortError.
  Cílené testy 41/41, typecheck a plná Workbench sada 838 passed / 2 skipped.
  Commit `7f915f3` je pushnutý na `origin/feat/wp-regress`;
  katalogové hunks zůstaly unstaged.
- Bedrock ConverseStream nyní rozlišuje `TimeoutError` při čtení AWS event
  streamu; existující abort test zůstává zelený. Bedrock/factory 40/40,
  typecheck a plná Workbench sada 839 passed / 2 skipped. Commit `9fa77bb`
  je pushnutý na `origin/feat/wp-regress`.
- Mistral Conversations nově převádí `TimeoutError` z SSE těla na
  `Provider request timed out.` a zachovává rušení požadavku volajícím.
  Cílené Mistral/factory testy 43/43, typecheck i celá Workbench sada
  prošly (840 úspěšných / 2 přeskočené). Commit `f658dcb` je pushnutý na
  `origin/feat/wp-regress`; nesouvisející změny katalogu a discovery zůstaly
  mimo commit.
- Ollama nyní převádí `TimeoutError` z těla NDJSON streamu na
  `Provider request timed out.` a zachovává existující test rušení požadavku.
  Cílené Ollama/factory testy 41/41, typecheck i plná Workbench sada prošly
  (841 úspěšných / 2 přeskočené). Commit `98e7860` je pushnutý na
  `origin/feat/wp-regress`; nesouvisející změny Ollama zůstaly mimo commit.
- Sdílený OpenAI-compatible SSE reader nově převádí body `TimeoutError` na
  `Provider request timed out.` a zachovává explicitní abort chování.
  Provider-stream/factory testy 42/42, typecheck i plná Workbench sada prošly
  (842 úspěšných / 2 přeskočené). Commit `86bf8b7` je pushnutý na
  `origin/feat/wp-regress`; cizí změny `provider.ts` a testů zůstaly mimo.
- `CompatibleProvider.decode()` nově rozlišuje `TimeoutError` při čtení JSON
  těla od neplatného JSONu; explicitní rušení volajícím zůstává zachované.
  Cílené testy 18/18, typecheck i plná Workbench sada prošly
  (843 úspěšných / 2 přeskočené). Commit `11113ad` je pushnutý na
  `origin/feat/wp-regress`; ostatní změny `provider.ts` zůstaly mimo commit.
- Aktuální scope je pouze Harness. Web GUI/browser smoke, TUI změny,
  desktop, SWE-bench a Docker jsou vyřazeny. H21 povolené cesty neobsahují
  `apps/control-plane/ui/**`. Pracovat pouze v existujícím
  `.worktrees/agent-harness`; zachovat všechny rozpracované změny.
- Podrobný etapový completion plan a verifikační brány:
  `docs/superpowers/plans/2026-10-23-nomo-harness-beta-and-provider-compatibility.md`.
- CLI installer nyní vypisuje `nomo`, shodně s vytvořeným launcherem.
  Izolovaný behaviorální test po RED/GREEN prošel 17/17.
  [[NOMO Work Log#2026-10-27: CLI installer command output]].
- Tester potřebuje read access k soukromému repozitáři, Git, Node 24+ a pnpm;
  přístup musí udělit vlastník. `scripts/install-nomo.sh` je aktuální CLI cesta.
  Webové rozhraní a `pnpm gui` nejsou součástí testovací acceptance.


## NOMO x YC Winter 2027 — 2026-10-27
- Aktuální dokumentační index: [NOMO x YC index](file:///Users/dawe/Developer/Claude-Projects/NOMO/docs/strategy/2026-10-27-nomoyc-index.md).
- Česko první; obecná firemní platforma zůstává dlouhodobou vizí. První konkrétní workflow, uživatel, data i poptávka nejsou potvrzené.
- Privátní stránka: https://www.dsak.tech/nomoyc. Webový kód obsahuje šifrovaný plán a dokumenty; API je vydá po přihlášení.
- Detailní stav a důkazy jsou v [[NOMO Work Log]].

## Bezpečná migrace názvů NOMO — 2026-10-28

- H66 byl při zahájení aktivní a nyní je dokončený; záznam důkazů je v
  `.nomo/harness-work-state.json` a podrobný souhrn níže i v [[NOMO Work Log]].
- Bezpečná produktová kopie se rozšířila z README na Core Workbench: pokyny
  agentů, systémové instrukce a texty policy denial/error nyní používají NOMO;
  testovací očekávání tomu odpovídají. Commit `ff228cc` je na
  `origin/feat/wp-regress`.
- Workbench testy: 843 prošlo, 2 přeskočeny, 0 selhalo; typecheck prošel.
- Root `@nomo/workspace`, soukromé CLI `@nomo/cli`, nástroje `@nomo/scripts`
  a zdrojový balíček verifier `@nomo/verifier` jsou sladěné. Commit `e77ed38`
  je pushnutý. NPM vrátil 404 pro obě ověřená jména verifieru; nic nebylo
  publikováno.
- Release/verzovací testy prošly 34/34, CLI test 5/5, verifier selftest všech
  šest kontrol; prošla i offline instalace se zamčeným lockfilem.
- H66 byl při vytvoření tohoto záznamu aktivní; nyní je dokončený.
  Zbývající výskyty jsou kompatibilní či persistentní identifikátory,
  environment aliases, externí metadata, historie a chráněné control-plane,
  UI/TUI/desktop/Apple cesty. Doslovná nula by porušila syntaxe či kompatibilitu.

## Harness package namespace slice — 2026-10-28

- Devět soukromých Harness balíčků nyní používá `@nomo/*`; závislosti,
  importy CLI, lockfile a aktuální release guards byly ověřeny.
- Všechny balíčky prošly typecheckem. Testy: 2 003 prošlo, 16 přeskočeno,
  0 selhalo. CLI consumer testy 25/25, release/bundle/version gate 42/42.
- Tento snapshot předcházel migraci v `e77ed38`; soukromé CLI, scripts a
  verifier nyní používají `@nomo/*`. Kompatibilní aliasy, wire/storage/Git
  ID a externí adresy zůstávají. TUI, GUI, desktop a Apple cesty beze změn.
- Původní další krok, audit zbývajících bezpečných názvů, je dokončený v H66.
  Veřejné, persistentní a vyloučené identity měnit pouze verzovanou cestou.
- Commity `32f0df1` a `4a9e5da` jsou na `origin/feat/wp-regress`.
  Druhý mění jen zastaralý komentář; `~/.void/workbench` zůstalo kvůli
  kompatibilitě.


## Aktuální stav H66 — 2026-10-28

- Bezpečná migrace názvů Harnessu je dokončená v commit 6bddf22. Bezpečné dočasné prefixy jsou nomo- a MCP metadata nomo-cloud; v prověřených Workbench, proxy a přímých CLI cestách už nezůstaly staré dočasné prefixy.
- Ověření: Workbench 843 prošlo, 2 přeskočené; proxy 35/35; CLI Harness 18/18; typecheck prošel. Commit je pushnutý na origin/feat/wp-regress.
- Záměrně zůstávají jazyková syntaxe, kompatibilní MCP/protocol ID, env aliasy, persistentní a externí identity, historie a chráněné stromy. Tyto výskyty nelze bezpečně hromadně přejmenovat.

- H21 aktualizace 2026-10-28: Bedrock Mantle nyní podporuje typovaný AWS credential-chain profil s per-call SigV4, lokálním model listingem a redakcí finálních/streamovaných výstupů. Ověření: Mantle 7/7, Workbench 851 prošlo / 2 přeskočeny, API 41/41, oba typechecky. Bez skutečných credentials či provider requestu. H21 zůstává blokovaný na Prime metadata a ostatní mezery; plná parita není prokázaná. [[NOMO Work Log#2026-10-28 — H21 Bedrock Mantle host credentials]].

- Commit `975538a` obsahuje pouze Bedrock Mantle Harness změnu; non-force push GitHub odmítl jako `Invalid username or token`. Commit je lokální na `feat/wp-regress`; žádné tokeny, force-push ani merge. Podrobnosti: [[NOMO Work Log#2026-10-28 H21 Mantle commit a push status]].