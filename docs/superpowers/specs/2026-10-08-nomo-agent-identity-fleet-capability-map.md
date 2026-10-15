# Capability Map: NOMO Agent Identity and Fleet Control Plane

> Stav: návrh k lidské revizi. Zatím nejde o schválenou implementační specifikaci.
>
> Datum: 2026-10-08

## Cíl a doporučený přístup

NOMO se podle uživatelského zadání mění na Agent Identity & Fleet Control Plane. Agent Harness zůstává povinnou součástí, ale není samostatným pitch. Zachováme ověřené části proxy, policy, registry, ledgeru, konektorů, Workbench a control plane. Recovery-first positioning přestane být primárním produktem. Konkrétní recovery kontrakty zůstanou technickou schopností podporovaných konektorů.

Zvažované přístupy:
1. Přepsat produkt i repo od nuly. Odmítnuto, protože zahodí ověřené jádro a ohrozí rozpracovanou práci.
2. Změnit produktovou strategii a znovu použít ověřené technické jádro. Doporučeno, nejrychlejší a nejméně rizikové.
3. Rozdělit produkt do nového repozitáře. Odmítnuto, protože by zdvojilo testy, release proces a bezpečnostní kontrakty.

## Moduly, hranice a závislosti

| Modul ID | Odpovědnost | Závisí na | Demo do 2026-10-11 | Product v1 | Pozdější plný rozsah |
|---|---|---|---|---|---|
| `agent-identity` | Registrace principalu a vazba agent/workspace/run | Trusted Workbench runtime principal | Jeden registrovaný principal a jeden workspace | Inventář více agentů a běhů | Tenant RBAC, SSO a lifecycle pro všechny hosty |
| `token-broker` | Capability token s TTL nejvýše 60 sekund, audience, scope a revokace | `agent-identity`, transport-specific trust boundary | Lokální issuer mintuje 60s token pro jednu Workbench run | Standardní MCP OAuth 2.1 pro HTTP MCP | Tenant vault, KMS a delegated provider credentials |
| `interception-policy` | MCP interception, R0 až R3, `Allow`, `Deny`, `Hold`, `observe-only` | Identity, registry, policy, proxy | Workbench → inbound HTTP proxy → jeden fixture MCP target | Product v1 podpírá HTTP MCP a explicitní stdio boundary | Rozšířený katalog hostů a konektorů |
| `audit-ledger` | Podepsaná hash-chained evidence rozhodnutí, approval a výsledku | Identity, policy | Lokální signed evidence | Append-only Neon/Postgres ledger | Retence, vyhledávání a fleet-scale operace |
| `fleet-control` | Inventář, živý feed, run stop, agent revoke a fleet kill | Broker, proxy, ledger | Kill všech běhů v jednom lokálním procesu | Multi-agent control plane s ack barrier mezi aktivními uzly | Tenant izolace, HA a organizační role |
| `coding-agent-harness` | Spuštění a měření coding agentů pod stejnými guardrails | Enforcement path, Workbench | Jeden task bez persistent learning | Produktový host běží přes stejný token a proxy | Bezpečně schválený learning a retrieval |
| `integrations-and-assurance` | Host adaptéry, konektory, provoz a release evidence | Fleet Control, Harness | Jeden host a jeden disposable MCP server | Deklarovaný a testovaný podporovaný scope | Další hosté, konektory, HA a enterprise controls |

**Build order:** `agent-identity` → `token-broker` → `interception-policy` → `audit-ledger` → jeden lokální end-to-end demo path → `fleet-control` v product v1 → `coding-agent-harness` nad stejným enforcement path → `integrations-and-assurance`. UI feed lze stavět paralelně až po stabilizaci API a event kontraktu. Závislostní cyklus není povolen.

## Výchozí implementační stav

Audit committed `main` na `b39a7b0` zjistil:

- Workbench vytváří session a run UUID. Nízkoúrovňový runtime ale přijímá `agentId` a `runId` od volajícího a ověřuje jen syntaxi. Jde o metadata, ne o autentizovanou identitu.
- Companion device token má TTL 15 minut a invitation 120 sekund. Agent token s TTL 60 sekund chybí. `NOMO_CONTROL_TOKEN` je statický. `@void/proxy` dnes přijímá agent MCP přes STDIO a jako klient podporuje upstream STDIO nebo HTTP; inbound HTTP MCP server chybí. Workbench již umí volat HTTP MCP s bearer headerem.
- Cloud ukládá provider a integration credentials šifrovaně na úrovni vlastníka. Run-scoped credential vending chybí.
- `/api/agents` vypisuje profily, ne živou flotilu. SSE je session-scoped. Samostatný `observe` mode chybí.
- Stop je kooperativní a per-session. Již předané MCP volání může doběhnout. Agent-wide i fleet-wide kill chybí.
- Harness může aktivovat memory bez operator approval a digestu návrhu. Bezpečný retrieval do další session není zapojen. Persistent learning se nesmí označit za hotový.

Agent identity registry je autoritou pro principal, workspace binding, credential status a revokaci. Demo důvěřuje jen lokálnímu Workbench server runtime, který identitu přiřadí; Workbench profile, session UUID a run UUID zůstávají metadata, ne důkaz identity. Proxy odvodí identitu z brokerem ověřeného credentialu, nikdy z request-body `agentId` nebo `runId`. Pro HTTP MCP se token váže na issuer, audience serveru, agent, run, workspace, upstream a tools. MCP authorization spec doporučuje OAuth pro HTTP; STDIO OAuth nemá následovat a místo toho načítá credentials z environmentu. MVP volí HTTP, ale jeho pre-issued lokální capability token není tvrzením o standardní OAuth kompatibilitě.

## MVP do neděle 2026-10-11

Cíl je reprodukovatelné lokální demo, ne veřejný release ani produkční fleet produkt. Použije jednu server-side Workbench run identity, jeden workspace, jeden MCP server a disposable target. Současný Workbench slouží jako trusted host/test client, ne jako důkaz, že celý nový coding-agent Harness workstream je hotový. Agent hostem je NOMO Workbench: uživatelův coding agent volá nový inbound HTTP MCP endpoint proxy přes existující Workbench HTTP klient. Ukáže ověřenou identity a capability token, který lokální issuer vytvoří na začátku Workbench runu. Token má TTL nejvýše 60 sekund, audience NOMO proxy a zůstává pouze v paměti Workbench serveru. Workbench ho přidá do `Authorization` headeru; model ho nedostane. Demo ukáže `Allow`, `Deny` a `Hold` před dispatch, signed evidence, expiraci/revokaci tokenu a lokální kill switch. `observe-only` ukáže volání bez změny policy rozhodnutí. Chybějící identity, scope, policy nebo ledger končí fail closed.

Demo kill switch platí pro jeden enforcement proces. Po lokálním acknowledgement další volání nesmí projít. Už dispatchnutá akce může doběhnout a UI ji označí jako in-flight nebo neznámý výsledek, ne jako zrušenou.

Demo nepokrývá multi-tenancy, SSO, hosted secret vault, více nezávislých proxy uzlů, plný OAuth login ani globální revokační SLA. Lokální token profil je pouze demo fixture; neprezentuje se jako standardní MCP OAuth a není určen pro externí deployment. I v tomto profilu token váže issuer a audience, jde pouze v `Authorization` headeru a nikdy se nepředává upstreamu. Product v1 musí implementovat standardní MCP OAuth pro HTTP včetně Protected Resource Metadata (RFC 9728), Authorization Server discovery, PKCE, `resource` parametru, audience, expiry, scope a revocation checks a 401 challenge. Viz [MCP Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization). STDIO OAuth nepoužívá; jeho identity vyžaduje samostatný procesní a environment trust design. Demo může spustit jeden vymezený task přes současný Workbench, ale learning zůstane vypnutý, dokud nejsou hotové approval digest, operator review a retrieval pouze schváleného kontextu v další session stejného workspace. Samotné demo nepovažuje Harness za dokončený. Produktový release nesmí označit Harness za hotový, dokud coding agent neběží přes stejnou identity/broker/proxy/policy/ledger cestu a neprojde approval i safe-retrieval branami.

## Trvalé bezpečnostní hranice

- Token má ověřeného issuera a audience a váže se na agent, run, workspace, upstream a povolené nástroje. TTL je nejvýše 60 sekund. Scope se znovu ověří bezprostředně před dispatch.
- Expirace, revokace, nečitelný stav, neznámý nástroj, chyba policy, timeout brokeru nebo nemožnost append ledgeru znamená fail closed. Chyba nesmí automaticky přepnout systém do `observe`. Důkaz rozhodnutí se durable-appendne před dispatch write operace; záznam outcome navazuje až po upstream odpovědi.
- Hold váže approval na digest přesné operace a ověřeného approvera. Po expiraci tokenu se před dispatch vydá nový krátký grant nebo se operace odmítne. Kill/revoke se ověří znovu po approval.
- Rozlišit run stop, lokální agent revoke a fleet-wide revoke. Fleet success se vrátí až po ack aktivních uzlů; uzel bez potvrzeného stavu nepředává volání.
- Kill switch neznamená rollback side effectu ani zaručené zrušení již předané akce.
- Raw tokeny, upstream secrets a citlivé argumenty nejsou v logu, eventu, ledgeru, screenshotu ani browser storage.
- Policy zůstává deterministická autorita. Harness nesmí autonomně měnit policy nebo oprávnění. Zachovat append-only signed ledger, durable compatibility a frozen `void.*` IDs.
- Produkční účty nepoužívají autonomní testy.

## Stack, strategie a dokumenty

Cílový stack podle briefu je TypeScript, Node.js 24+, pnpm, React 19, Vite 7, Tailwind CSS v4, Neon Postgres a Drizzle pro control-plane data. Proxy spine cílí na Apache-2.0 open core; hosted control plane je uzavřený. Pro jednosměrný feed se nejdřív použije SSE. `@nomo/registry` zůstává čistým registrem klasifikace. Agent identity a cryptographic token broker do něj nepatří; kandidátem je samostatná hranice `@nomo/identity`. Současný Workbench je implementační základ Harnessu, ne důvod vytvořit duplicitní runtime. Ledger schema změny zůstávají oddělené od běžných Drizzle migrations.

Mapa vychází z committed `main` `b39a7b0`. Hlavní checkout obsahuje rozsáhlé necommitnuté přejmenování na NOMO, které nebylo přeneseno. Před implementací se rename workstream sladí, bez hromadného kopírování dirty změn.

Uživatelský pivot z 2026-10-08 výslovně superseduje starý recovery-first positioning a starší pořadí produktu. Neznamená zákaznickou validaci ani volné místo na trhu. Oficiální produktové materiály [Microsoft Entra Agent ID](https://learn.microsoft.com/en-us/entra/agent-id/what-is-microsoft-entra-agent-id), [AWS Bedrock AgentCore Identity](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/identity.html) a [Cloudflare MCP portals](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/) ukazují, že identity pro agenty a správa MCP jsou aktivní tržní kategorie. Veřejný pitch nesmí tvrdit „první“ ani „jediný“. Diferenciaci kolem per-run grantů, pre-write rozhodnutí a podepsaného důkazu výsledku ověří zákaznické rozhovory před veřejným launch. Discovery začne jedním skutečným write incidentem a čtyřmi vlastníky: agent principal, scope/policy, control approval a incident response. Důkaz pilotu je konkrétní prostředí, pojmenovaný owner a approver, datovaný další krok a ideálně placený scope; cenové hladiny zůstávají hypotézami a pozitivní reakce na „fleet control plane“ sama nestačí.

Zastaralé produktové plány se odstraní z aktivního stromu až po nahrazení zdroje pravdy a opravě odkazů a testů. Zachovat bezpečnostní, provozní, technické a Harness kontrakty. Git historii nepřepisovat. V současném checkoutu má `docs/` asi 3,8 MB a `.git` asi 35 MB, takže přepis historie nenabízí úměrný zisk.

## Otevřená rozhodnutí před module specs

1. Kde se ukládají upstream credentials: lokální environment, lokální vault nebo hosted KMS.
2. Jaké jsou clock skew, key rotation, replay/idempotency, canonicalization upstream/tool a issuer/audience contracts.
3. Jaký je přesný postup pro Hold, když 60sekundový token expiruje před schválením.
4. Který jeden coding host a disposable MCP server tvoří nedělní demo.
5. Jaký SLA a reconcile stav platí pro fleet-wide kill a odpojený uzel.
6. Product v1 vyžaduje plný standardní HTTP OAuth flow pro Workbench a externí klienty. Nedělní demo může použít pouze interní token profile vydaný lokálním test issuerem a nesmí tvrdit OAuth compliance. stdio identity je mimo demo a vyžaduje samostatnou security spec.
