# NOMO harness: instalace pro testery a kompatibilita providerů

> **Stav: schváleno k implementaci uživatelem 2026-10-23.** Publikace releasu, skutečné provider requesty, credential import, commit, merge a změny TUI nejsou tímto schválením povolené.
> **Aktualizace rozsahu 2026-10-27:** Aktuální cíl je Harness core a CLI. Uživatel výslovně vyřadil web GUI a browser smoke, TUI změny, desktop/Xcode a SWE-bench/Docker. Starší UI acceptance dále v tomto historickém specifikačním dokumentu jsou mimo aktuální implementační rozsah; povolené jsou pouze Harness runtime, CLI, backend API a dokumentace. OpenAI kompatibilita zůstává odchozí, nikoli serverové API.


## Cíl

Umožnit pozvaným testerům spustit coding-agent Harness z checkoutu, připojit modelové providery z cílových verzí OMP/Prime a posílat soukromou ruční zpětnou vazbu bez telemetrie. Webové GUI a desktopová aplikace nejsou aktuálním cílem.

## Potvrzené volby

- Rozsah providerů: všechny modelové providery OMP/Prime, nikoli ne-modelové služby jako web search.
- Platformy: Harness runtime a CLI v prostředí Node 24 nebo novějším. Webové GUI, browser smoke, TUI změny, desktopová aplikace, Tauri, Xcode a jejich instalační smoke testy jsou mimo aktuální rozsah.
- „OpenAI compatible“ zahrnuje odchozí provider adaptéry i nový, samostatně specifikovaný inbound endpoint. Inbound rozsah podle `2026-11-07-nomo-inbound-openai-chat-completions.md` je pouze `GET /v1/models` a textový `POST /v1/chat/completions`, JSON/SSE, bez klientských tools a bez OpenAI OAuth.
- TUI změny a web GUI jsou mimo rozsah. Práce zůstává na Harness runtime, provider API/backendu, CLI, testech a dokumentaci v Harness worktree; starší UI acceptance v tomto dokumentu se nyní nevykonávají. Desktopové balení je mimo aktuální rozsah.
- Nejsou povoleny veřejné releasy, změna viditelnosti repozitáře, telemetrie, externí provider volání, commit ani merge bez dalšího souhlasu.

## Výchozí stav a důkazy

- `packages/workbench/src/provider.ts` podporuje obecné endpointy kompatibilní s OpenAI Chat Completions a nativní Anthropic Messages. `provider-defaults.ts` nabízí 14 předvoleb (NVIDIA, OpenCode Zen, Pollinations, TokenRouter, Puter, Qwen, OpenRouter, Anthropic, Google Gemini, Groq, DeepSeek, Vercel AI Gateway, Ollama a LM Studio); předvolby stále používají pouze tyto dva transporty. `ProviderConfig` nese `baseUrl`, API key, volitelný model a `kind`, nikoli plnou identitu providera a jeho autentizační profil.
- Tentýž soubor odmítá domény `openai.com`; přímý oficiální OpenAI endpoint tedy není podporovaný.
- `apps/control-plane/api/server.ts` dosud vystavuje pouze `/api/*`. Inbound `/v1/models` a `/v1/chat/completions` jsou nově schváleným cílem popsaným v samostatném spec; implementace musí znovu použít stávající Control Plane auth a Workbench runtime.
- `apps/control-plane/ui/src/settings.tsx` poskytuje konfiguraci endpointu, typu a API key. Desktop nyní importuje pouze vybrané API-key profily z OpenCode/Prime; OAuth tokeny, příkazové výrazy a vlastní endpointy se neimportují (`apps/desktop/README.md`, § First-run provider import).
- `apps/desktop/README.md` potvrzuje Tauri balíčky pro macOS arm64/x64 a Windows x64 s přibaleným Node/runtime backendem. Uživatel nepotřebuje Node, pnpm ani terminál.
- `.github/workflows/desktop-windows.yml` sestaví, nainstaluje a lokálně smoke-testuje unsigned NSIS balíček. Automatizovaný macOS release workflow v aktuálním seznamu workflow nebyl nalezen.
- Veřejná macOS distribuce vyžaduje Developer ID podpis a notarizaci. Windows balíček je unsigned a může zobrazit SmartScreen varování. Tyto release credentials v implementačním prostředí nejsou potvrzené.
- `CONTRIBUTING.md` vítá bug reporty, ale nebyl doložen samostatný tester feedback flow.
- Read-only zdrojové baseline pro inventář: OMP `@oh-my-pi/pi-coding-agent` 18.6.2 (`upstream/omp-src/packages/coding-agent/package.json`) a Prime Agent 0.10.1 (`upstream/prime-src/Cargo.toml`). OMP definuje chat-provider roster v `upstream/omp-src/packages/catalog/src/compat/provider-ids.ts`, transportní API v `upstream/omp-src/packages/catalog/src/types.ts` a provider/auth detaily v katalogu. Prime definuje transporty v `upstream/prime-src/crates/pa-types/src/ai/mod.rs`, modely v `upstream/prime-src/crates/pa-ai/src/models_generated.rs` a `upstream/prime-src/crates/pa-models/src/`; Prime Inference je samostatný credentialed gateway.
- Tyto zdrojové stromy jsou pouze čtecí reference. NOMO z nich nepřebírá běhový kód ani novou závislost.

## Provider kontrakt

### Přesný baseline roster

Inventář se nesmí odvodit jen z 14 současných předvoleb Workbenche. Připnutý OMP typ `KnownProvider` deklaruje tyto ID: `abliteration`, `aiand`, `aimlapi`, `alibaba-coding-plan`, `alibaba-token-plan`, `amazon-bedrock`, `anthropic`, `apple`, `azure`, `baseten`, `bedrock-mantle`, `cerebras`, `charm-hyper`, `cline-pass`, `cloudflare-ai-gateway`, `commandcode`, `coreweave`, `cursor`, `deepinfra`, `deepseek`, `devin`, `factory-droid`, `firepass`, `fireworks`, `github-copilot`, `gitlab-duo`, `gitlab-duo-agent`, `gmi-cloud`, `google`, `google-antigravity`, `google-gemini-cli`, `google-vertex`, `groq`, `helmcode`, `huggingface`, `kilo`, `kimi-code`, `litellm`, `lm-studio`, `local`, `meta`, `minimax`, `minimax-code`, `minimax-code-cn`, `mistral`, `moonshot`, `muse-code`, `nanogpt`, `novita`, `nvidia`, `ollama`, `ollama-cloud`, `openai`, `openai-codex`, `opencode-go`, `opencode-zen`, `openrouter`, `qianfan`, `qwen-portal`, `sakana`, `siliconflow`, `siliconflow-cn`, `singularityapi-dev`, `singularityapi-tech`, `stepfun`, `synthetic`, `together`, `typesafe`, `umans`, `venice`, `vercel-ai-gateway`, `vllm`, `wafer-serverless`, `web`, `xai`, `xai-oauth`, `xiaomi`, `xiaomi-token-plan-ams`, `xiaomi-token-plan-cn`, `xiaomi-token-plan-sgp`, `yolo-auto`, `zai`, `zenmux`, `zhipu-coding-plan`.

Prime Agent 0.10.1 compiled model catalog obsahuje přesně tato provider ID: `amazon-bedrock`, `anthropic`, `azure-openai-responses`, `cerebras`, `cloudflare-ai-gateway`, `cloudflare-workers-ai`, `deepseek`, `fireworks`, `github-copilot`, `google`, `google-vertex`, `groq`, `huggingface`, `kimi-coding`, `minimax`, `minimax-cn`, `mistral`, `moonshotai`, `moonshotai-cn`, `openai`, `openai-codex`, `opencode`, `opencode-go`, `openrouter`, `prime-inference`, `vercel-ai-gateway`, `xai`, `xiaomi`, `xiaomi-token-plan-ams`, `xiaomi-token-plan-cn`, `xiaomi-token-plan-sgp`, `zai`. Prime `Provider` je otevřený string; manifest proto musí porovnat skutečné provider ID compiled katalogu, `KnownProvider` enum a Prime Inference model katalog, nikoli předpokládat, že samotný enum je úplný.

OMP `KnownApi` transportní rodiny: `openai-completions`, `openai-responses`, `openrouter`, `openai-codex-responses`, `azure-openai-responses`, `anthropic-messages`, `bedrock-converse-stream`, `google-generative-ai`, `google-gemini-cli`, `google-vertex`, `ollama-chat`, `cursor-agent`, `factory-droid-agent`, `gitlab-duo-agent`, `devin-agent`, `apple-foundation-models`. Prime `KnownApi` přidává `mistral-conversations`; sdílené rodiny se evidují jednou, ale jejich provider-specific auth a wire varianty zůstávají samostatnými manifestními poli.

Toto jsou zdrojové seznamy, nikoli tvrzení, že každá položka poskytuje in-scope chat model. Pro OMP se do runtime coverage zahrnou pouze konkrétní katalogové řádky s `kind=chat` nebo `kind=tiny`; položky `search`, image, audio, embedding a další služby jsou explicitně mimo scope. Prime řádky se klasifikují podle compiled model catalogu a samostatného Prime Inference katalogu. Každé vyloučené ID musí mít v checked-in manifestu důvod a zdrojový důkaz.

Model-provider roster OMP navíc obsahuje `minimax-cn`: tento provider není v `KnownProvider`, ale pinned OMP 18.6.2 model catalog obsahuje osm chat modelů a Anthropic Messages descriptor. Proto zůstává oddělený seznam `KnownProvider` (84 ID) a model-providerů (85 ID); manifest jej nesmí ztratit. Pro tento descriptor OMP nemá provider-specific env-key deklaraci, takže záznam vyžaduje explicitní uživatelský API key bez tvrzení o env aliasu. Generátor `scripts/generate-provider-manifest.mjs` odvozuje checked-in `packages/workbench/src/provider-manifest.json` z read-only checkoutů těchto baseline a selže při neznámém přidaném model provideru.

První implementační deliverable je verzovaný coverage manifest odvozený z uvedených baseline. Každý in-scope řádek nese provider ID, zdroj a verzi, model ID/kind, transportní rodinu, endpoint nebo pravidlo jeho sestavení, discovery, podporované autentizace a schopnosti. Manifest dále obsahuje explicitní vylučovací seznam s důvodem; nové/změněné upstream ID selže na coverage testu, dokud není klasifikováno. Výchozí baseline má 73 OMP in-scope providerů/5 480 chat-tiny řádků, 32 Prime providerů/152 řádků a 200 explicitně vyloučených OMP ne-chat řádků.

Agent-specifické transporty zůstávají v rozsahu pouze tehdy, pokud připnutý katalog deklaruje jejich model jako chat/tiny model pro Workbench; nesmějí se tiše zaměnit za běžný chat completions.

- OMP 18.6.2 `local` provider obsahuje osm `kind=tiny` modelů na `local-inference` / `local://inference`. Uživatel zvolil zachovat lehký, dependency-free Harness; NOMO proto modely nespouští, ale explicitně je označuje jako blokovaný transport `local-inference` v `Workbench.providerState().unavailableModelTransports` a `GET /api/provider`. Žádný ONNX/MLX worker, váhy ani OMP agent se nespouští a transport se nemapuje na obecné HTTP/OpenAI API. Plná OMP parita tím není splněna. Upstream zdroje pouze pro evidenci: https://raw.githubusercontent.com/can1357/oh-my-pi/v18.6.2/packages/catalog/src/compat/rules/providers/local.kdl a https://raw.githubusercontent.com/can1357/oh-my-pi/v18.6.2/docs/local-models.md.

- Pinned OMP 18.6.2 declares 209 in-scope Bedrock chat model rows with `native-auth` and `host-credential`. Workbench exposes them through its existing `aws-credential-chain` only for that source/auth declaration, with descriptor model IDs and endpoints required to match. This uses NOMO's existing AWS SDK Node `defaultProvider`; it does not import OMP's credential resolver. OMP bearer-token support remains out of scope and unsupported. This is not full OMP auth/provider parity. Sources: https://raw.githubusercontent.com/can1357/oh-my-pi/v18.6.2/packages/ai/src/providers/amazon-bedrock.ts, https://raw.githubusercontent.com/can1357/oh-my-pi/v18.6.2/packages/ai/src/providers/aws-credentials.ts, https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/migrate-credential-providers.html#default-credential-provider.

- Coverage audit RED found 192 in-scope chat model rows across 11 groups without exact descriptors. OMP `ollama-cloud` now covers all 51 pinned chat rows with manifest-declared API-key auth, canonical `https://ollama.com`, Bearer on `/api/chat` and selected-manifest-model discovery; local `ollama` stays loopback/no-auth. Bedrock Mantle now covers its five pinned GPT-5.4, GPT-5.5, GPT-5.6 Luna, Sol and Terra rows through the Responses adapter, API-key Bearer auth and a strict regional `/openai/v1` endpoint. Fixture tests reject other hosts/paths and cover key redaction, encrypted persistence and zero live provider requests. Sources: pinned OMP manifest/provider and official AWS API-key/model-card docs. The remaining 136 rows across 9 groups remain explicit blockers for unresolved endpoint inputs or unsupported device-code auth. Full OMP/Prime parity remains incomplete.

Provider roster je připnutý k uvedeným verzím; novější upstream provider není automaticky podporován. Změna baseline vyžaduje aktualizaci manifestu a znovu ověřený coverage report. Každé provider ID musí být klasifikováno, žádné se nesmí ztratit při převodu katalogu.

### Architektura

- Zachovat stávající Workbench jako jediný runtime a politickou/ledger autoritu.
- Přidat malý typovaný provider registry a explicitní transport adapters podle unikátních API rodin z manifestu. Jedna implementace adapteru může obsloužit více providerů pouze tehdy, když jejich protokol, auth, model discovery a streaming kontrakt skutečně odpovídají.
- Udržet malé rozhraní klienta: seznam modelů a dokončení požadavku včetně streamu a tool callů; transporty převádějí zprávy, nástroje, usage a chyby na stávající `Model`, `ModelMessage` a `ModelReply`.
- Nesmí se přidat nová běhová závislost ani importovat OMP/Prime implementace. OMP/Prime katalogy jsou verzovaný zdroj inventory, nikoli runtime knihovny.
- Přesný model schopností se deklaruje v katalogu. Funkce, kterou provider/model nepodporuje, se označí jako nepodporovaná; žádný tichý fallback, náhrada modelu ani předstírání podpory.
- Podpora zahrnuje protokoly potřebné pro celý manifest, včetně OpenAI Chat Completions, OpenAI Responses, Anthropic Messages, Google, Bedrock a provider-specific/agent transports, pokud jsou v manifestu. Tento seznam je orientační: konečný seznam vznikne z úplného inventory, nikoli z ručního zkrácení.
- Přímý OpenAI endpoint bude zpřístupněn pouze přes výslovný OpenAI adapter a jeho API kontrakt, nikoli obcházením současné kontroly custom URL.

### Autentizace a síťová hranice

- API klíče, OAuth/device login a lokální bezklíčové endpointy se implementují podle konkrétního provider manifestu. OAuth se podporuje pouze pro autentizační postupy dostupné v cílové verzi a povolené podmínkami dané služby; žádné reverse engineering, obcházení paywallu ani zneužití osobních tokenů.
- Tajemství zůstávají v existujícím šifrovaném lokálním úložišti. OAuth tokeny musí mít bezpečný refresh/revoke životní cyklus. Browser/renderer nesmí obdržet uložený token; logy, chyby, issue exporty a ledger nesmí obsahovat klíče ani OAuth tokeny.
- Import existujících OMP/Prime účtů není implicitní. Případný import vyžaduje samostatný explicitní souhlas uživatele a testy, které dokazují zachování dosavadního provideru při chybě importu.
- Zachovat HTTPS pro vzdálené endpointy a loopback HTTP pouze pro lokální inference; přesměrování na provider requestech zůstává zakázané. Žádná custom URL nesmí obejít ověření endpointu nebo poslat credentials jinému hostu.
- Testy používají lokální HTTP fixture server a syntetické tajemství. Bez skutečných klíčů a bez externích API requestů.

## Instalace a distribuce

- Tester dostane přístup k existujícímu soukromému repozitáři a použije zdrojový checkout. Požadavky: Git, Node.js 24+ a pnpm; tento projekt nepublikuje instalační balíček.
- `scripts/install-nomo.sh` poskytuje existující CLI instalační cestu. Aktuální testovací postup nevyžaduje spuštění webového rozhraní ani `pnpm gui`.
- Přístup do repozitáře uděluje vlastník mimo tento workflow. Tento plán nemění viditelnost repozitáře, nic nevydává a nepožaduje podpisové certifikáty.

## Zpětná vazba a soukromí

- Přidat soukromý GitHub issue form/šablonu pro bug report a tester feedback; release notes a quickstart na něj odkazují. Pozvaní testeři potřebují repozitářový přístup.
- Žádná automatická telemetrie, cloudový upload, session export ani automatické odeslání diagnostiky.
- Formulář žádá verzi aplikace, OS/architekturu, kategorii, reprodukční kroky a očekávaný/skutečný výsledek. Provider ID/model lze uvést dobrovolně; API URL, prompty, odpovědi, obsah projektu a secrets se nepřipojují automaticky.
- Pokud se později přidá diagnostický export, musí být ruční, s náhledem před exportem a allowlistem polí. Není podmínkou prvního tester řezu.

## Akceptační kritéria

1. Coverage manifest obsahuje 100 % in-scope chat/tiny provider entries a všechny transportní rodiny z obou připnutých baseline. CI test selže na neznámém, duplicitním nebo nepokrytém provider/API ID.
2. Každý provider má explicitní endpoint, discovery, auth a capability záznam. Všechny dostupné protokolové/auth větve mají lokální fixture testy; žádný test nevolá externí službu.
3. Testy prokazují model discovery, úspěšný textový completion, stream, tool-call round trip, usage, cancellation a chybové/redakční chování pro každý transport, který daný provider deklaruje. Nepodporovaná capability je explicitně odmítnuta nebo skryta; nesmí být tiše degradována.
4. Přímý OpenAI provider funguje přes oficiální adapter a všechny existující compatible/Anthropic profily se po restartu zachovají přes ověřenou konfiguraci/migraci.
5. API key i OAuth token se nikdy nevrací klientovi, nevypíše, nevloží do eventu/ledgeru/feedbacku a zůstane dostupný jen v šifrovaném lokálním úložišti. Redirect, cizí host nebo neplatný token končí bezpečnou chybou.
6. Workbench a místní Control Plane API zpřístupní pouze doložené provider setup flows. TUI pro OpenAI účet zobrazí pouze bezpečné stavy, účet/model, reauth a disconnect. Web GUI a browser smoke zůstávají mimo aktuální rozsah.
7. Tester s uděleným přístupem dokáže ze zdrojového checkoutu podle dokumentace spustit CLI i lokální webové rozhraní s Git, Node.js 24+ a pnpm. Žádný desktopový balíček ani instalovaný smoke test.
8. Soukromý feedback formulář umožňuje ručně nahlásit reprodukovatelný problém bez telemetrie, diagnostického uploadu, tajemství nebo citlivého obsahu.
9. Žádný veřejný release, změna repo visibility, produkční credential ani skutečný provider request před samostatnou kontrolou bezpečného consentu. TUI implementace je v rozsahu, web GUI není.

## Implementační pořadí

1. Vytvořit a zkontrolovat strojově ověřitelný provider coverage manifest z OMP 18.6.2 a Prime 0.10.1; vyřešit každý provider ID, API typ, auth typ a chat/tiny klasifikaci.
2. Dodat typed registry/transport contract a migraci současných `compatible`/`anthropic` configů bez ztráty klíčů, modelu nebo nastavení.
3. Implementovat adaptery po transportních rodinách v pořadí určeném počtem pokrytých providerů a rizikem; každý řez test-first s lokálními fixtures.
4. Implementovat provider-specific API key/OAuth/login a bezpečné uložení až po uzavření auth matrix; ověřit refresh, cancel, expiry a redakci.
5. Zapojit registry a auth přes `/api/provider` a Workbench. Implementovat pouze schválený TUI účetní tok; web GUI zůstává mimo rozsah. Ověřit kompatibilitu starších configů.
6. Doplnit soukromý tester issue form a quickstart pro zdrojový checkout, CLI a lokální web bez telemetrie a automatického session/diagnostic exportu.
7. Spustit relevantní provider/Workbench/API/UI fixture suites, typecheck a docs-truth testy; po dokončení všech kódových řezů provést kompletní suite. Zaznamenat manifest coverage a přesné výsledky do jediného Harness grafu a Obsidian work logu.

## Blokery a oddělené práce

- Přístup testerů do soukromého GitHub repo musí vlastník udělit samostatně.
- Testerům uděluje přístup vlastník; desktopové podpisy, balíčky a instalační smoke testy jsou mimo aktuální rozsah.
- Pokud provider v připnutém katalogu vyžaduje nepodporovaný nebo nepovolený auth flow, nesmí se jeho API obcházet. Překážka se doloží a znovu předloží uživateli; úplná kompatibilita se do té doby nehlásí.
- H19 (filtered working copy + omezené Git API) zůstává odděleně blokované až do schválení detailní bezpečnostní hranice; jeho implementace není součástí provider/install worku.

## Dodatek: OpenAI Sign in with ChatGPT a TUI rozsah, 2026-11-09

Uživatel schválil místní Sign in with ChatGPT pro vlastní ChatGPT plan jako samostatný provider profil. Použít pouze oficiální OpenAI authorization-code flow s PKCE, loopback callback na `127.0.0.1`, čerstvé `state` a `nonce`, dynamicky vydané `client_id`, stabilní host ID a ověření ID tokenu přes OpenAI JWKS. Při každém účtu oddělit vydané client ID, ověřenou identitu a tokeny. Používat jen udělené scopes, account-visible modely a veřejné `POST https://api.openai.com/v1/responses` s `store: false` a `stream: true`. Nikdy nepoužít ChatGPT backend endpoint, nezaměnit OAuth za API key ani tiše nezměnit platební cestu.

Tokeny a registrace jsou v samostatném host-level šifrovaném úložišti sdíleném mezi místními NOMO workspaces; používá existující `LocalStorage` mimo `NOMO_DATA_DIR`, aby account-scoped OAuth identita odpovídala jednomu hostiteli. Refresh, reautorizace a odpojení se serializují i napříč lokálními procesy. Refresh token se rotuje a souběžný refresh pro účet se serializuje. Odpojení se pokusí o oficiální revokaci; pokud potvrzení chybí, lokální odpojení zůstane pravdivě označené jako nepotvrzené. Scopes, dostupnost modelů, usage limity a chyby se zobrazí bez tokenů, včetně odkazu na oficiální přehled usage. Pokud validní token nedostane `chatgpt.tokens.use.direct`, účet zůstane ověřený, ale plan usage je vypnutý; inference zůstává zakázaná a zapnutí vyžaduje explicitní uživatelskou akci a úplný scope set. Chyby zachovávají status/code/request ID; potvrzený invalid/revoked token vyžaduje reauth, zatímco dočasná chyba credentials nemaže.

Dne 2026-11-09 uživatel znovu otevřel pouze TUI pro přístup k provider účtu. TUI smí volat existující Workbench a lokální Control Plane API; web GUI, browser smoke, desktop, produkce a Docker zůstávají mimo rozsah. Toto rozhodnutí nahrazuje pouze starší zákazy TUI v tomto dokumentu; nepovoluje změny cizích TUI worktrees ani změnu web UI. Inbound OpenAI Chat Completions zůstává samostatný, již schválený a omezený H69/H73 kontrakt. Ani jedna cesta neznamená plnou OpenAI API nebo OMP/Prime paritu.

TUI účetní tok používá `/connect chatgpt` pro novou autorizaci a `/connect chatgpt ACCOUNT_ID` pro reautorizaci; `/chatgpt` zobrazí bezpečný stav účtů a `/chatgpt enable ACCOUNT_ID` vyžádá consent pro přímé plan usage. `/chatgpt models ACCOUNT_ID` zobrazí account-visible katalog, `/chatgpt use ACCOUNT_ID MODEL_ID` aktivuje výslovně zvolený model a `/chatgpt disconnect ACCOUNT_ID` vyžaduje potvrzení. Nová autorizace sama nepřepíše aktivní API-key/generic provider; aktivní profil se změní až po výběru účtu/modelu. System browser launch předává oficiální authorize URL jako argument bez shellu, ale TUI URL ani credential hodnoty nezobrazuje.

Primární zdroje: https://developers.openai.com/siwc/token-sharing-open-source/sign-in, https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions, https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference, https://developers.openai.com/siwc/token-sharing-open-source/token-reference, https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery, https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations.

Loopback callback uses the stable `http://127.0.0.1:<port>/auth/callback` URI; only its port varies. The authorization request uses exactly `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`. Reauthorization omits `id_token_hint` and `login_hint` to keep the ID token/email out of the system-browser URL and launcher process arguments; the user selects the account in OpenAI's flow. Validate and discard the ID token rather than retaining it solely for that optional hint. The OAuth account’s model catalog is a separate contract from API-key OpenAI: request `GET /v1/models`, accept only `visibility: "list"`, display `display_name`, and submit its `slug`. The public Responses request is always streamed with `store: false`; completion is successful only after `response.completed`.

### Local shared-storage stale-lock safety gate

The encrypted workspace snapshot writer and host account lifecycle writer use persistent SQLite transaction locks inside directory sentinels at their historical lock paths (`workspace.enc.lock` and `accounts.lifecycle.lock`). This prevents a legacy `open(wx)` writer from acquiring an installed sentinel and makes legacy nonrecursive `unlink(path)` fail while the nonempty directory remains. Unexpected existing regular-file paths fail closed; do not auto-convert existing lock files. This is a candidate steady-state protocol, not a mixed-version cutover guarantee.

A second `wx` reservation is cooperative only and cannot protect against already-running old runtimes which ignore it. The reservation can itself remain stale after a crash. On an absent pathname, atomic `mkdir` and the old writer's `open(wx)` elect one winner; the loser fails closed. Child-process fixtures cover both outcomes for one stale reaper paused after unlink but before reacquisition. This does not cover an earlier stale reaper that validated a dead PID, then unlinks a pathname after another legacy writer replaced it and entered its critical section. That can remove the active writer's PID path, allowing a new SQLite writer to enter on a different inode. Installing a sentinel after that point does not undo the admitted work. A nonempty installed sentinel resists later legacy nonrecursive unlink, as a separate test verifies. The current candidate refuses existing regular-file lock paths without overwriting them and does not implement automatic conversion. A safe shared cutover must prove that no old critical section or prevalidated reaper can still create the unlink gap, or provide a separate transition protocol that safely fences them. A deterministic child-process fixture validates the stale PID, pauses before unlink, then resumes after sentinel installation while a SQLite writer is active: unlink fails and another current writer remains blocked until transaction release. This demonstrates only the steady-state sentinel behavior for that modeled interleaving. Prove workspace key initialization, cross-process single-writer and refresh serialization, crash and restart behavior, encrypted persistence, and legacy ciphertext compatibility. No live provider or credential access is allowed for these fixtures.

A read-only audit of the historical PID reaper found a check/unlink race. A process may read and validate a stale PID, pause, then resume after another old writer acquired the lock. With a directory sentinel, its `unlink(path)` fails while the nonempty directory remains, but this does not roll back work already admitted by the old writer or prove that every in-flight old critical section has ended. An isolated child-process protocol model reproduces concurrent entry when a prevalidated stale reaper unlinks a replacement PID file; its legacy writer is represented by a held critical-section marker, not an installed historical binary. A separate controlled probe against the regular-file protocol also reproduced overlapping entry. Neither evidence covers every deployed binary or filesystem, or establishes a cold cutover. Therefore cutover must be cold and quiescent: stop every supported legacy writer and stale reaper before preserving or converting any existing lock file or starting the new runtime; verify the old writer set is empty; only then admit new writers. Rollback to older PID-only binaries after sentinel installation is unsupported unless an explicit safe reverse protocol is proven with all writers stopped. This deployment/cutover contract is not yet enforced or operationally verified, so H75 remains blocked.

Cutover go/no-go evidence is per lock domain and is not a request to perform the cutover:

1. Freeze new legacy launches at every supported entrypoint, including direct checkout commands, installed launchers, update/reinstall paths, and automation. Record exactly which control enforces the freeze. A wrapper change alone is insufficient while old binaries or alternate entrypoints remain available.
2. Enumerate every binary/version and every data-root alias that can reach the lock pathname. For each active process, establish its executable, canonical data root, and whether it can own the workspace or auth lock. Do not infer shared-root quiescence from a process count or an `lsof` snapshot.
3. Drain admitted writers and any reaper that may already have validated a stale PID. Require a barrier with an observable completion condition, not a delay or a one-time empty-handle sample. If the old implementation has no such coordination signal, quiescence must be established by an authorized, controlled stop and restart procedure outside this candidate change.
4. Preserve verified backups of the encrypted snapshot and each existing lock database without reading or exposing credentials. Inventory lock-path type, mode, owner, device and inode before and after. The workspace and account lock paths are separate domains; migrate only with a reviewed, atomic procedure that preserves their existing contents or proves the lock-only files are empty and disposable.
5. Admit only the sentinel-aware runtime after all prior gates pass. Verify one writer at a time, restart/crash recovery, unchanged ciphertext readability, and no active old-code writer. Stop and restore from preserved evidence on any unexpected path type, checksum change, lock error, unsupported filesystem behavior, or rollback incompatibility.
6. Rollback is a separate all-writers-quiescent operation. Older PID-only binaries must not be admitted while sentinel directories exist. Do not recursively remove a sentinel or convert a lock path back to a file while any current or old writer can run.

Until each item has signed evidence and an authorized operator executes the transition, status is NO-GO. This checklist defines evidence; it does not grant permission to stop processes, alter launchers, inspect secret-bearing state, or mutate shared storage.
