# Implementační plán: NOMO AgentRunner

> **Stav:** Návrh i implementační plán schváleny 2026-10-25. Uživatel povolil pouze lokální fixture s připnutým `@cursor/sdk@1.0.40`; instalace proběhla s vypnutými lifecycle skripty. H48 offline fixture prošel: skutečný SDK `createAgentPlatform`/`createAgent`/`send` tok předal přesný allowlist pěti MCP proto-nástrojů do veřejného executor seamu nahrazeného test doublem, pouze explicitní callback, prázdné `settingSources`, pracovní adresář a zrušení do stavu `cancelled`; callback po odvolání grantu selhal. Síťové transporty byly zablokovány a nevznikl žádný provider request. Fixture nahrazuje model i executor, proto nedokazuje vzdálené vynucení Cursoru ani skutečný síťový běh. Následuje fáze 1 AgentRunner kontraktu; bez credential čtení a provider requestu.

**Cíl:** Přidat do Harness samostatné coding-agent runtime rozhraní, které zachovává stávající Workbench autorizaci, ledger, projektový sandbox a digest-gated review/apply. Dokončení vyžaduje jeden skutečný vendor adaptér splňující všechna kritéria; falešný runner samotný není dodaný Harness.

**Specifikace:** `docs/superpowers/specs/2026-10-25-nomo-agent-runner-design.md`

## Globální omezení

- Pracovat jen ve worktree `.worktrees/agent-harness` a nad Harness zdrojovou větví. TUI soubory, jejich graf ani cizí dirty změny se nesmějí měnit, stageovat ani zahrnout.
- Žádný SWE-bench, benchmarkové datasety, instalace Docker/Podman či image, commit, push, merge ani release. Existující projektový sandbox se nesmí obejít ani měnit jeho konfigurace.
- Žádný provider request, přihlášení, credential čtení, SDK instalace nebo jiné síťové vedlejší účinky bez nové výslovné autorizace. Testy používají syntetické klíče a lokální fixture.
- `ProviderClient` zůstane inferenční kontrakt. Agent-runner nesmí změnit stav transportů H21 ani tvrdit OMP/Prime parity.
- Po jednom work itemu proveďte jeho cílenou regresi, zapište důkaz do graphu a teprve pak pokračujte. Nezakrývat selhání opakováním bez diagnózy.
- Do implementace se přechází až po tomto schváleném plánu a splnění zdrojového gate v kroku 1.

## Výchozí zdroje a hranice

- Runner návrh: `docs/superpowers/specs/2026-10-25-nomo-agent-runner-design.md`.
- Workspace hranice: `docs/superpowers/specs/2026-10-24-nomo-project-workspace-boundary.md`.
- Inference kontrakt: `packages/workbench/src/provider-adapters/types.ts`.
- Workbench lifecycle, policy, ledger a project dispatch: `packages/workbench/src/index.ts`.
- Filtrovaná kopie a digest review/apply: `packages/workbench/src/project-workspace.ts`.
- Stávající Docker/Podman projektový sandbox: `packages/workbench/src/project-sandbox.ts`.
- Navrhované změny jsou omezeny na Workbench runtime, nezbytné Control Plane API/UI, testy a Harness dokumentaci. Žádná TUI cesta.

## Fáze 0: důkaz způsobilosti jednoho vendor adaptéru

### Úkol 1: Auditovat oficiální protokol před výběrem adaptéru

**Postup:** Pro kandidáty z H44 ověřit pouze oficiální dokumentaci a případně publikovaný zdrojový protokol; nezačínat instalací SDK ani účtem. Zvolit nejvýše jednoho kandidáta pro první implementaci.

**Povinná matice:** autorizace a credential flow; endpoint allowlist; přesný přenos promptu a souborů; zda se odesílá repozitář; zprostředkování každého nástroje; vypnutí nativního shellu/souborů/MCP/git; odvolání přístupu; potvrzení zrušení; skryté side effects jako branch/PR; limity událostí a redakce.

**Akceptace:** Každá schopnost je doložena zdrojem. Kandidát splní všechna omezení schválené specifikace. Nepodložené, neurčité nebo vzdáleným systémem nevynutitelné tvrzení znamená odmítnutí kandidáta.

**Stop:** Pokud žádný oficiální adaptér neprokáže úplné zprostředkování nástrojů, souhlasu, workspace a zrušení, zastavit bez implementace; H21 i runner zůstávají blokované. Nenahrazovat nedostupný runtime falešným nebo providerovým obalem.

**Ověření:** Zdroje a matice v plánu/graph evidence; žádný SDK install, credential access, provider request ani síťový smoke.

## Fáze 1: typovaný kontrakt a lifecycle testy

### Úkol 2: Přidat AgentRunner kontrakt a validátor eventů

- **Soubory:** nové moduly pod `agent-runners/` a testy vedle nich. `provider-adapters/types.ts` měnit jen pokud LSP/reference audit prokáže nutnost; preferovat žádnou změnu.

**Akceptace:** Typy popisují runnerem deklarované schopnosti, schválený profil, AbortSignal, neprůhledný grant workspace, běh a normalizované eventy pro status, žádost/výsledek nástroje a terminální stav (`completed|failed|cancelled|unknown`). Zrušení vrací pouze `confirmed|unknown`. Profil mimo deklarovaný seznam, neplatný nebo přeshraniční run event, chybná sekvence, více než jeden/neposlední/žádný terminální event a payload nad limitem validátor odmítne.

**Testy:** Ověřit povolený profil, platný event stream včetně tool request/result, runId a sequence korelaci, terminální invarianty a payload limit. Tato fáze netvrdí reálné rušení, grant revocation ani retry chování; tyto runtime invariants ověřuje fáze 2 Workbench brokerem.

**Ověření:** `node --experimental-strip-types --test` nad novými runner testy; Workbench typecheck.

## Fáze 2: Workbench broker, consent a audit

### Úkol 3: Zprostředkovat běhy existujícím Workbench

**Soubory:** `packages/workbench/src/index.ts`, nové runner orchestration moduly a jejich testy. Před změnou exportů spustit LSP reference audit.

**Akceptace:** Workbench sám vydává run ID a workspace grant až po explicitním souhlasu. Každý event přichází přes jediný broker; každé volání nástroje znovu ověří grant, workspace binding, profil, allowlist a aktuální policy. Rozhodnutí, dispatch, výsledek, zrušení a terminal outcome jsou v ledgeru bez tokenů, promptových secretů či neomezených payloadů.

**Testy:** vynucený tool request mimo allowlist je odmítnut před side effectem; odvolání přístupu během čekání zastaví následné akce; ledger eviduje skutečnou cestu allow/deny; protokolový timeout zachová `unknown`; side-effect request se automaticky neopakuje.

**Ověření:** nové cílené Workbench testy plus existující policy/ledger/session testy změněné cestou. Typecheck workbench.

**Výsledek H50 brokeru:** Implementován programový Workbench broker: jednorázový digest souhlasu, Workbench-issued run/grant identity, korelované události, mediatované nástroje, revalidace grant/profile/runner/allowlist/policy před side effectem, cancellation a digest-only dispatch/result/terminal záznamy brokeru. Consent preview vypisuje deklarované kategorie přenosu (`task`, system prompt, arguments/results nástrojů); jde o tvrzení trusted adapteru, nikoli vynucenou síťovou kontrolu. Regrese ověřují out-of-allowlist `nomo_project_exec` odmítnutý před sandboxem, změnu policy během approval hold, změnu runner description po consentu, odvolání project grantu, chybějící terminal (`unknown`) a bez automatického retry. H50 nedodává vendor adapter ani Control Plane consent route/UI; žádný live provider/network běh není ověřen.

**Ověření H50:** Cílené runner/broker testy 15/15; `pnpm --dir packages/workbench run typecheck` prošel; celá Workbench sada 750 passed, 2 skipped, 0 failed. Projekt workspace/access regresní testy 22 passed, 1 configured-sandbox test skipped. `node scripts/src/doc-truth.test.mjs` prošel 9/9. Bez provider requestu, sandbox runtime instalace nebo TUI změn.

### Úkol 4: Napojit schválenou pracovní kopii

**Soubory:** `packages/workbench/src/project-workspace.ts`, `project-sandbox.ts` a jejich testy pouze tam, kde současné API skutečně nestačí; zbytek v novém runner brokeru.

**Akceptace:** Runner vidí pouze grantovaný filtrovaný workspace. Shell/procesní práce používá existující explicitně nakonfigurovaný sandbox; žádný host shell, cesta k původnímu repozitáři, `.git`, secret nebo přímé síťové nástroje. Review zobrazuje digest a přesné změněné soubory. Apply zůstává po souboru a vyžaduje potvrzení přes stávající cestu.

**Testy:** fixture s vyloučeným secret a `.git`; pokus o path traversal a zápis mimo grant; souběžná změna workspace; stale digest odmítnut; apply před potvrzením nemožné; žádný automatický commit/push.

**Ověření:** cílené `project-workspace` a sandbox regresní testy. Runtime smoke izolace pouze s již nakonfigurovaným lokálním sandboxem, který uživatel výslovně nastavil; neinstalovat ani nestahovat runtime/image.

**Výsledek H51:** Broker nepotřeboval nové workspace/sandbox API: synthetic `AgentRunInput` je přesně omezen na task, system prompt, Workbench-issued grant, vybrané tool schemas, profile ID a `AbortSignal`; host root path ani obsah vyloučeného `.env.local` se nepředává. Approved `nomo_project_exec` bez sandbox konfigurace končí před dispatch a temp host marker nevznikne. Projektové kopie, symlinky, manifest, stale digest a apply regression zůstávají zelené. Runner/broker testy 16/16, project workspace/access 22/23 (1 configured-sandbox skip), Workbench 751 pass / 2 configured-sandbox skip, typecheck a doc-truth 9/9. Skutečný sandbox process nebyl spuštěn; tento runtime claim zůstává neověřený.

## Fáze 3: jeden vendor adaptér za zdrojovým gate

### Úkol 5: Implementovat zvolený protokol

**Soubory:** jediný nový modul pod `packages/workbench/src/agent-runners/` a lokální transport fixtures. Název/strukturu určit až po úkolu 1; nepředpovídat API před ověřením.

**Akceptace:** Adaptér mapuje zdokumentované eventy, tool callbacks, usage, chyby, odvolání a zrušení bez ztráty informací. Síťový klient míří pouze na deklarovaný endpoint. Vypnuté vendor-native nástroje se ověří negativním testem; pokud protokol jejich vypnutí nezaručuje, implementace se zastaví.

**Testy:** fake HTTP/protocol server ověřuje autentizaci syntetickým klíčem, přesné požadavky, stream, chybné/truncated eventy, timeout, zrušení, redakci a zákaz redirectu/endpoint escape. Bez reálné sítě a bez skutečných účtů.

**Ověření:** adapter suite, Workbench suite, typecheck. Není-li fixture věrná zdrojovému protokolu, adaptér není ověřený.

**Gate H52 — blokace adaptéru:** Worktree používá `@cursor/sdk@1.0.40`. Oficiální Cursor Cookbook dokumentuje `Agent.create({ apiKey, model, local: { cwd } })`, `run.stream()` a `run.wait()`; veřejné typy balíčku navíc definují `Run.cancel()`, SDK zprávy včetně `tool_call`, `status`, `request` a `usage` a `tools: ["mcp"]` jako omezení vestavěných toolů. Veřejný `CursorAgentPlatform` nabízí lokální executor seam, kterou používá H48 fixture, ale `CursorAgentPlatformOptions`, `AgentOptions` ani veřejné `configureCursorSdk` nemají nastavitelné API base URL/endpoint. H48 proto dokazuje pouze mapování SDK k lokálnímu executor double, ne přesný protokol ani omezení síťového cíle. Bez zdokumentovaného endpoint override nelze splnit požadovaný fake-local-server a endpoint-escape test bezpečně; nový adapter se neimplementuje ani neoznačí za ověřený. H52 je dokončeno jako zdrojová prověrka; úkol 5 zůstává blokován, dokud SDK neposkytne dokumentovaný endpoint hook nebo vhodný adapter s veřejným transportem. Zdroje: https://github.com/cursor/cookbook/blob/main/sdk/quickstart/src/index.ts ; https://github.com/cursor/cookbook/blob/main/sdk/quickstart/README.md.

## Fáze 4: Control Plane rozhraní, dokumentace a end-to-end důkaz

### Úkol 6: Přidat ne-TUI ovládání souhlasu a review

**Soubory:** pouze existující Control Plane API/UI povrchy po ověření jejich současných kontraktů; jejich přesnou mapu doplnit po LSP/find při implementaci. TUI zůstává mimo rozsah.

**Akceptace:** Uživateli se před spuštěním zobrazí runner/provider, úloha, oprávnění nástrojů, souborový manifest/digest, co se přenese mimo zařízení a možné vedlejší účinky. Bez souhlasu se run nezačne. UI nikdy nevykreslí credential. Umožní sledovat run, požádat o zrušení a revidovat diff; změnu nelze aplikovat bez potvrzení.

**Testy:** API deny/allow se skutečným Workbench brokerem; UI testy interakcí a stavu bez testování statického textu; smoke v jednom existujícím browseru: spustit fixture, vyvolat tool request, zrušit, ověřit ledger a digest review/apply bez skutečného provider requestu.

**Výsledek H53 — source map:** `apps/control-plane/api/server.ts` přijímá `ControlPlaneOptions.workbench`; výchozí `Workbench` se vytváří bez runnerů, ačkoli konstruktor umí dostat `agentRunners`. Není route pro runner katalog, consent preview ani AgentRunner start. `/api/sessions` volá běžné provider `Workbench.start`; `/api/runs/:id/stop` volá `Workbench.stopRun`, které pro AgentRunner deleguje zrušení a ponechává výsledek jako cancelled/unknown podle adaptéru; odpověď stop endpointu pouze potvrzuje přijetí v procesu. Existující `/api/project-workspace` + `ProjectWorkspace` UI už pokrývají filtrovanou kopii, manifest, souborové digesty, diff a potvrzený per-file apply; `main.tsx` ji zpřístupňuje jako lazy page. Chat zatím vytváří běžné sessions a neumí AgentRunner consent preview. Server testy pokrývají workspace route a stop ack. LSP server pro worktree není dostupný; mapování bylo ověřeno definicemi a cíleným grepem, žádný kontrakt nebyl odhadnut.

**H54 implementační seam:** Přidat volitelnou `ControlPlaneOptions.agentRunners` registraci pro vložené trusted adaptery; bezpečně zpřístupnit pouze validované runner description metadata; přidat `GET /api/agent-runners`, `POST /api/agent-runs/preview` a jednorázový `POST /api/agent-runs` (consent ID + digest) přes existující Workbench metody. Nezavádět vlastní stop API: UI použije existující `/api/runs/:id/stop`, jehož ack není tvrzení o potvrzeném zastavení. Přidat oddělený AgentRunner consent komponent pod existující ProjectWorkspace stránku: zobrazit preview přenosů, runner/provider/endpoint, task, profile, selected tools, manifest/digest a vedlejší účinky; explicitní start až po consentu; po startu otevřít běžnou session route a zachovat již existující digest review/apply. Testovat přes skutečný Workbench s lokálním synthetic runnerem; default bez nakonfigurovaných runnerů zůstává prázdný a žádný fake vendor adapter se nepřidává.

**Výsledek H54:** Control Plane přijímá volitelný trusted `agentRunners` registry; výchozí registry je prázdná. `Workbench.agentRunnerCatalog()` validuje description proti allowlistu polí a vrací kopii bez credential polí. Nové route `GET /api/agent-runners`, `POST /api/agent-runs/preview` a `POST /api/agent-runs` delegují na Workbench; preview má striktní vstupní shape, start vyžaduje přesný jednorázový consent ID + SHA-256 digest a chybné/stale/duplicitní consent fail-closed. Existující stop route zůstává jedinou cestou zrušení. Pod `ProjectWorkspace` je oddělená consent karta: volba runner/profilu adaptéru/profilu agenta, úkol, endpoint/přenosové kategorie, nástroje, workspace grant a manifest, capability/cancellation claims, explicitní checkbox a start; běh se sleduje existující session route. Bez runneru UI zobrazí prázdný stav a nemá start action. Změny zůstávají v kopii a existující per-file digest review/apply se neměnilo. Regrese: Control Plane API 32/32, UI 134/134 včetně state testů pro loading/error/no-runner/no-profile a přesnou explicitní consent gate, Workbench 751 passed / 2 configured-sandbox skipped; Workbench typecheck, UI typecheck a UI build prošly. Hidden-browser smoke se skutečným lokálním Control Plane, Workbenchem a synthetic runnerem ověřil endpoint/manifest preview, blokovaný start před checkboxem, start a potvrzené zastavení; samostatný izolovaný UI průchod ověřil empty state bez runneru. Zachycené API/browser requesty mířily pouze na localhost; žádný provider request ani externí síťový provoz. Build hlásí upstream `use client` a chunk-size warnings. Zbývající omezení: žádný vendor adaptér kvůli H52 endpoint gate; žádný skutečný sandbox runtime ani explicitní změna/apply během tohoto smoke.

### Úkol 7: Aktualizovat provozní dokumentaci a ověřit celé řetězení

**Dokumentace:** Workbench README, Harness acceptance handoff, change log a příslušný task graph. Vysvětlit připojení, souhlas, sandbox prerequisite, podporované schopnosti, zastavení, neznámý výsledek, credential boundaries, review/apply a přesná omezení; bez parity marketingu.

**Povinné gates:** cílené runner/provider/workspace/policy/ledger/UI testy, `pnpm run typecheck`, `pnpm run build`, `node --test scripts/src/doc-truth.test.mjs`, `git diff --check` a browser runtime smoke změněného non-TUI rozhraní. Spustit po jednom; při první nevysvětlené chybě diagnóza, nejvýše jeden opravený retry.

**Akceptace dokončení:** Všechny nové akceptační body mají chování pokryté regresními testy; skutečný vybraný adaptér prošel lokální protokolovou fixture; browser/Workbench smoke prokáže cestu od souhlasu po ruční digest review. Neověřený provider/OS zůstává výslovně omezením, nikoli „pass“.

## Zastavovací podmínky

Zastavit při neprokazatelné schopnosti vendoru, chybějícím credential authority, nutnosti odeslat celý repozitář, skrytém shellu/MCP/souborovém přístupu, neznámém remote vedlejším účinku, neověřeném zrušení, neexistující sandbox konfiguraci, TUI konfliktu, cizí dirty změně, secret nálezu nebo opakovaném gate selhání. Nikdy neoslabovat specifikaci, neskrývat blocker, nepředstírat smoke/providera ani neprovádět externí side effect.

## Aktuální výsledek zdrojového gate

První kandidát: **Cursor TypeScript SDK v lokálním režimu**. Cloud mode je vyloučen. Oficiální dokumentace uvádí lokální agent loop, lokální pracovní adresář, allowlist `tools`, `local.customTools` callbacky, omezení zdrojů nastavení, běh/cancel API a podporu Node.js 22.13+; Workbench vyžaduje Node.js 24+.

Zamýšlená omezení adaptéru: `tools: ["mcp"]`, `settingSources: []`, pouze explicitní `local.customTools` mapované do Workbench brokeru, žádné inline `mcpServers`, žádné subagentní tooly, žádné přímé shell/read/write/edit nástroje, custom store bez implicitního zápisu do `~/.cursor`, lokální režim nad schválenou filtrovanou kopií. Agent API smí komunikovat pouze s deklarovaným Cursor endpointem; souhlas musí předem pokrýt manifest a digest odesílaných dat.

`@cursor/sdk@1.0.40` je nainstalován se schválením uživatele. H48 offline fixture prošel: skutečný SDK `createAgentPlatform`, `createAgent`, `send` a `Run.cancel` tok předal přesný seznam pěti SDK MCP proto-nástrojů do veřejného executor seamu nahrazeného test doublem, pouze vlastní `broker_probe` callback, `settingSources: []`, prázdné `mcpServersOverride`, dočasný workspace a syntetický klíč. Callback po odvolání grantu odmítl volání; `Run.cancel()` skončil jako `cancelled`. Síťové transporty `fetch`/HTTP/HTTPS/HTTP2 byly blokovány a v testu nebyl zaznamenán žádný požadavek. Ověření: fixture 1/1, Workbench sada 735 testů prošlo, 2 přeskočeny, 0 selhalo; typecheck prošel. Důkaz platí pouze na SDK-to-executor hranici: model i executor byly nahrazeny, takže vzdálené vynucení allowlistu ani živý Cursor běh nejsou ověřeny. H49 nyní pokrývá fázi 1 typovaného AgentRunner kontraktu. Reálný provider request zůstává zakázán.

Ostatní kandidáti pro první řez jsou odmítnuti podle dokumentace: Devin v3 a GitLab External Agents jsou vzdálené session/CI surfaces s repository, pipeline nebo MR side effects; Factory SDK má approval handlers a subtractive `disabledToolIds`, ale dokumentace neposkytuje ekvivalentní restriktivní allowlist přes Workbench nástroje.

Oficiální zdroje: [Cursor TypeScript SDK](https://cursor.com/docs/sdk/typescript), [Cursor SDK Bridge](https://cursor.com/docs/sdk/bridge), [Cursor sandbox reference](https://cursor.com/docs/reference/sandbox), [Factory Droid TypeScript SDK](https://docs.factory.com/sdk/typescript), [Devin Create Session](https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions), [GitLab External Agents](https://docs.gitlab.com/user/duo_agent_platform/agents/external/).

## H55: Bezpečný výstup AgentRunneru v chatu

**Rozhodnutí:** Uživatel schválil omezené zprávy asistenta v chatu. `assistant-message` obsahuje pouze prostý, nedůvěryhodný text; chat používá stávající escaped renderer. Ukládání zůstává výhradně v šifrovaném stavu session; žádný obsah nepřidávat do podepsaného workspace ledgeru, provider messages ani paralelního result store. Zachovat existující session retention.

**Limity:** nejvýše 16 KiB UTF-8 na zprávu a 64 KiB UTF-8 souhrnně na běh, zkrácení jen na hranici code pointu s viditelným upozorněním. Po vyčerpání souhrnného limitu zahodit další obsah a přidat nejvýše jedno pevné upozornění. Provider redaktor, connection-token redakce a známá detekce secretů se použijí před perzistencí; při secret-like shodě zprávu celou skrýt. Tato heuristika není zárukou úplného odhalení všech secretů.

**Terminální chování:** `terminal.message` podléhá stejným limitům. Text nesmí změnit stav běhu: `failed`, `cancelled` a `unknown` zůstávají pravdivé i při bezpečné zprávě asistenta. Surový text se nesmí objevit v signed ledgeru ani chybových logách.

**Akceptace:** testy validátoru a Workbench lifecycle ověří běžnou i terminální zprávu, UTF-8 limity/truncation, secret withholding, error/cancel status a nepřítomnost výstupního textu v ledgeru; Control Plane API vrátí session eventy; stávající chat je zobrazí bezpečně. Ověřit skutečný browser path s pouze syntetickým runnerem, bez externích hostů/providerů. TUI, vendor adapter, credentials, Docker, commit/push/merge zůstávají mimo rozsah.

**Výsledek a ověření H55:** Workbench 754 prošlo a 2 nakonfigurované sandbox testy byly přeskočeny; Control Plane API 261/261, UI 134/134, root `pnpm run typecheck` a `pnpm run build` prošly. Browser smoke nad sestaveným Control Plane s lokálním syntetickým runnerem vrátil 201 pro preview/start, chat vykreslil běžnou i terminální zprávu a konzole neměla chyby. Regrese ověřují šifrovaný stav session, nepřítomnost výstupu v podepsaném ledgeru, známý secret withholding, UTF-8 limity a pravdivé stavy failure/cancel. Žádný provider request ani externí host.
