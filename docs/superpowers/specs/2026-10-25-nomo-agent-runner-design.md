# Návrh: oddělená hranice pro coding-agent runtime

## Stav

Návrh výše uvedené architektury uživatel výslovně schválil 2026-10-25. Implementace zůstává nepovolená, dokud uživatel neschválí samostatný implementační plán.

## Problém a cíl

`ProviderClient` představuje inferenční rozhraní: enumeruje modely a volá `complete(model, messages, tools, signal, onDelta?)`. Coding-agent SDK nebo session API má naproti tomu vlastní běh, stav, události, rušení a často i vlastní vykonávání nástrojů. Adaptovat takovou session jako `ProviderClient` by zaměnilo odpověď modelu za dlouhotrvající agentní běh a mohlo obejít Workbench tool policy, event ledger i projektovou revizi.

Cíl: navrhnout samostatnou hranici pro agentní běhy, aniž by se oslabila stávající projektová hranice nebo vznikla falešná kompatibilita s modelovým API.

## Ověřený základ

- `packages/workbench/src/provider-adapters/types.ts` definuje `ProviderClient` jako katalog modelů a jednorázové dokončení modelového požadavku.
- `packages/workbench/src/index.ts` vlastní modelovou smyčku, autorizaci a vykonání Workbench nástrojů, event ledger a projektové kontroly.
- `packages/workbench/src/project-workspace.ts` spravuje filtrovanou pracovní kopii a kontrolu změn před jejich aplikací.
- `packages/workbench/src/project-sandbox.ts` už poskytuje příkazovou izolaci přes explicitně nakonfigurovaný Docker/Podman runtime a image identifikovanou digestem. To není důvod instalovat runtime, image ani spouštět benchmarky; nová cesta nesmí sandbox obejít ani potichu změnit jeho konfiguraci.
- Schválená hranice v `docs/superpowers/specs/2026-10-24-nomo-project-workspace-boundary.md` zakazuje `.git` a tajné údaje v pracovní kopii, vyžaduje schválení přes digest před aplikací změn a nezajišťuje izolaci proti jinému procesu stejného uživatele.

## Rozhodnutí návrhu

### 1. Dvě oddělená rozhraní

`ProviderClient` zůstává výhradně inferenčním API. Nové `AgentRunner` bude samostatná Workbench služba pro dlouhotrvající běh coding agenta. Nesmí se přidávat alias, obal ani adaptér vydávající agentní session za `ProviderClient`.

Navrhovaný kontrakt (názvy a přesné typy se mohou při implementačním plánu zpřesnit):

- `AgentRunner.describe()` vrací identitu adaptéru a jeho ověřené schopnosti; schopnost není povolení.
- `AgentRunner.start(input)` přijímá text úlohy, explicitní oprávnění pro pracovní kopii, allowlist nástrojů, volitelný profil adaptéru ověřený přes `describe()` a signal pro zrušení; vrací neprůhledné ID běhu a asynchronní proud normalizovaných událostí.
- Události mají stabilní `runId` a zahrnují stav/progres, žádost o zprostředkovaný nástroj, výsledek nástroje a právě jeden terminální výsledek. Obsah a metadata s limity velikosti; tajné údaje se nevracejí ani nelogují.
#### Text odpovědi AgentRunneru

Schválené rozhodnutí H55: text dokončení od runneru zobrazit jako běžné zprávy asistenta v existujícím proudu událostí session/chatu. Jde o obsah session, nikoli podepsaný auditní záznam: uchovává se pouze v šifrovaném stavu Workbenche a nekopíruje se do podepsaného workspace ledgeru, zpráv provideru ani druhého úložiště výsledků.

Přidá se událost runneru `assistant-message` obsahující pouze prostý text. Text se považuje za nedůvěryhodný a vykreslí stávajícím escapovaným rendererem chatu. Limit je 16 KiB UTF-8 na zprávu a 64 KiB UTF-8 na veškerý výstup jednoho běhu; zkrácení zachová hranici znaku a viditelně se označí. Po vyčerpání rozpočtu se další obsah zahodí a zobrazí se nejvýše jedno pevné upozornění o zkrácení. Použije se existující redakce provideru, jsou-li k dispozici connection tokens; při shodě se stávající detekcí tajných vzorů či známých secretů se celá zpráva skryje. Heuristická detekce nezaručuje nalezení každého tajného údaje.

Text terminální události `message`, pokud je dodán, podléhá stejným limitům a zacházení s tajnými údaji. Stav běhu zůstává samostatný a autoritativní: i selhaný nebo zrušený běh může mít bezpečnou zprávu. Surový výstup se nezahrnuje do podepsaného ledgeru ani chybových logů. Zprávy podléhají stávajícímu šifrování a retenčnímu chování session; žádné nové úložiště ani ukládání v prostém textu se nezavádí.
- Terminální stavy: `completed`, `failed`, `cancelled`, `unknown`. `unknown` znamená, že transport či vzdálený systém nepotvrdil, zda běh skutečně skončil; nikdy se nepřekládá na `cancelled` jen proto, že lokální čekání skončilo.
- `AgentRunner.cancel(runId)` vrací potvrzený výsledek, nebo neznámý výsledek. Opakované spuštění po nejednoznačné chybě není automatické, protože běh mohl již provést vedlejší účinky.

### 2. Jediné autoritativní místo pro nástroje a soubory

Runner nesmí dostat libovolnou cestu k hostitelskému repozitáři ani přímý přístup k MCP, shellu, git, síťovým nástrojům nebo souborům. Každá žádost o nástroj musí projít Workbench autorizací, již schváleným allowlistem, stávající implementací nástroje a ledgerem. Jediný povolený síťový provoz je explicitně nakonfigurovaný transport adaptéru k jeho deklarovanému poskytovateli; není dostupný jako nástroj agentovi. Nativní SDK/CLI schopnosti se vypnou; pokud je nelze vypnout nebo prokazatelně zprostředkovat, adaptér není způsobilý.

Projektový kontext poskytuje pouze schválená filtrovaná kopie. Všechny změny procházejí stávajícím `ProjectWorkspace` stavem, diffem a kontrolou digestu; aplikace změn vyžaduje explicitní schválení. Automatické aplikování, commit, push, branch nebo PR nejsou povolené.

Tento návrh nezaměňuje filtrovanou kopii za procesní izolaci. Vykonávání příkazů musí nadále procházet existujícím nakonfigurovaným projektovým sandboxem. Přímý hostitelský shell nebo skryté vykonávání uvnitř SDK je odmítnuto.

### 3. Souhlas a vzdálené služby

Každý běh vyžaduje zřetelný souhlas pro konkrétního runnera, úlohu, rozsah nástrojů a pracovní kopii. Před odesláním mimo zařízení musí uživatel vidět poskytovatele, co přesně se odešle (souborový manifest a digest), a případný požadavek na síťové či repository oprávnění.

Adaptér je pod touto hranicí nepoužitelný, pokud vyžaduje odeslání celého repozitáře, skrytý upload, vzdálené změny větví/PR nebo neauditované nástroje. Vzdálené agentní API nelze povolit jen proto, že nabízí API key nebo OAuth. Kód, credential ani data se v rámci návrhu nikam neodesílají.

### 4. Katalog schopností a způsobilost adaptéru

Schopnosti musí být deklarované i prokazatelné: režim projektu, zda jsou nástroje zcela zprostředkované, rozsah vzdálených dat, vedlejší účinky na repozitář a záruka zrušení. Workbench adaptér odmítne ještě před spuštěním, pokud některá požadovaná vlastnost není splněná. Výchozí hodnota je zákaz, ne optimistický odhad.

Ověřené vendor dokumentace potvrzují, že některé produkty vystavují agentní session/bridge API, nikoli modelové completion API. Samotná existence takového API není důkaz, že splní tento kontrakt. Každý konkrétní adaptér potřebuje samostatnou kontrolu oficiálního protokolu a jeho schopností; do té doby zůstává H21 blokovaný.

### 5. Selhání, rušení a audit

- Každý přechod do běhu, žádost o nástroj, rozhodnutí policy, výsledek a terminální stav se zaznamená přes existující ledger; citlivé hodnoty a obsah tajných údajů se redigují.
- Po odvolání přístupu nesmí nová operace začít; rozpracovaná operace se ukončí podle možností runtime a její stav se poctivě označí jako `unknown`, pokud ukončení není potvrzené.
- Chyba vzdáleného transportu nesmí být prezentována jako důkaz, že vzdálená session přestala běžet.
- Žádný automatický retry po nejednoznačném výsledku, po žádosti o side-effect nebo po ztrátě spojení.

## Nezahrnuto

- Změny TUI.
- SWE-bench, benchmarková infrastruktura nebo stahování datasetů.
- Instalace Docker/Podman, image nebo jiné závislosti.
- Připojení reálného účtu, čtení OAuth/API klíče nebo volání poskytovatele.
- Implementace runneru, provider adaptéru, migrace dat, push, commit či otevření PR.
- Slib parity s Prime Agent nebo OMP; ta vyžaduje samostatné měření se srovnatelnou úlohou a bezpečnostním nastavením.

## Akceptační kritéria pro budoucí implementační plán

1. `ProviderClient` zůstane typově a funkčně inferenční kontrakt; agentní session má vlastní typ a životní cyklus.
2. Běh bez explicitního souhlasu, platné projektové vazby nebo povoleného rozsahu nástrojů skončí před spuštěním.
3. Žádný runner nedokáže obejít Workbench policy/ledger přes nativní shell, soubory, MCP, libovolnou síť nebo git; síťové volání adaptéru smí mířit jen na deklarovaného poskytovatele.
4. Projektová změna se nikdy automaticky neaplikuje; digest review/apply zůstane jedinou cestou zpět do původního workspace.
5. Zrušení rozlišuje potvrzené zastavení od neznámého stavu; testy pokrývají odvolání přístupu i závody při ukončení.
6. Testy používají deterministický falešný runner a lokální protokolové fixture; nepoužívají reálné účty ani síť.
7. Nezpůsobilý nebo nedostatečně zdokumentovaný vendor adaptér se odmítne bez side effectů.
8. Existující testy Workbench policy, ledgeru, projektové kopie a digest review/apply zůstávají zelené; konkrétní implementace musí mít runtime smoke test izolace.

## Stop podmínky

Implementace nezačne, dokud uživatel neschválí tento dokument a implementační plán. Konkrétní runner zůstane blokovaný, dokud zdrojový audit a test prokážou úplné zprostředkování nástrojů, bezpečné zacházení s daty, věrohodné rušení a kompatibilitu s existujícím projektovým sandboxem. Pokud kterýkoli bod vyžaduje oslabení schválené workspace hranice, runner se nepovolí; návrh se vrátí k revizi.

## Zdroje

- `packages/workbench/src/provider-adapters/types.ts`
- `packages/workbench/src/index.ts`
- `packages/workbench/src/project-workspace.ts`
- `packages/workbench/src/project-sandbox.ts`
- `docs/superpowers/specs/2026-10-24-nomo-project-workspace-boundary.md`
- Oficiální dokumentace prozkoumaná při návrhu: [Cursor Bridge](https://cursor.com/docs/sdk/bridge), [Devin authentication](https://docs.devin.ai/api-reference/authentication), [Devin Create Session](https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions), [Factory TypeScript SDK](https://docs.factory.com/sdk/typescript), [GitLab Duo external agents](https://docs.gitlab.com/user/duo_agent_platform/agents/external/), [GitLab Duo authentication](https://docs.gitlab.com/user/duo_agent_platform/authentication/).
