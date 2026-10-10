# NOMO: audit produktových rozhraní a cloudového provozu

Datum: 30. září 2026. Výchozí main: `4c560dd98668da06e24b2189e854203fdcaa80a2`. Tento dokument je podklad k rozhodnutí, nikoli souhlas s implementací. Podrobnost čtení uvádí [SURFACES-COVERAGE.md](SURFACES-COVERAGE.md). Statické čtení nepředstavuje penetrační test, ověření nasazeného prostředí ani důkaz skutečných zákazníků.

## 1. Závěr

NOMO má podstatně více skutečně implementovaných mechanismů než obyčejný chat: sdílený workbench, policy, approvals, podpisy, správu konektorů, řízenou obnovu a několik UI. Největší obchodní riziko je rozptýlení mezi příliš mnoho produktů dříve, než jeden zákazník opakovaně získá měřitelný výsledek. Doporučení k diskusi: první produktový slib postavit na **bezpečné změně a ověřené obnově konkrétního vývojářského workflow**, s minimální změnou existujícího agentového návyku. Jeden desktop a CLI jako hlavní vstup; cloud jako týmová správa a evidence; Apple companion až po ověření místní hodnoty.

Cloudová izolace účtů má reálný základ. Týmový SaaS včetně organizací, správy rolí, plateb a zákaznického lifecycle nelze odvozovat z existence přihlášení. Apple UI rovněž nelze zaměňovat za dokončenou aplikaci s executor transportem. Obecné „undo pro AI“ a „control plane“ už nabízí konkurence; odlišnost musí být doložitelná v nepříznivém scénáři.

## 2. Mapa současných povrchů

| Povrch | Co je v kódu doloženo | Omezení / důsledek |
|---|---|---|
| React workbench | Chat, sessions, runs, approvals, ledger, documents, modely, settings, connectors, command palette; `apps/control-plane/ui/src/pages.tsx:22`, `:167`, `:246`, `:299`, `:399`, `:565`; `chat.tsx:195`; `documents.tsx:1` (modul) | Je to více než MVP obrazovka, ale rozsah UI neprokazuje activation ani retenci. |
| Lokální control plane | Sdílený `Workbench`, lokální/remote origin gate, projects, agents, hooks a desktop import; `apps/control-plane/api/server.ts:124`, `:135`, `:183`, `:191`, `:200` | Projekty nejsou automaticky filesystem grants; lokální integrations route vrací `supported:false` na `:194`. Cloud/local nejsou stejná sada schopností. |
| Tauri desktop | Node sidecar, ephemeral loopback, single instance, OS úložiště klíčů, minimal Tauri capabilities; `apps/desktop/runtime.mjs:13`, `:20`, `:24`; `src-tauri/src/main.rs:97`, `:130`, `:145`, `:205`; `tauri.conf.json:14` | Packaging není důkaz veřejně bezproblémového vydání. README explicitně nechává signing/notarization a clean-machine install jako release gates. |
| Cloud | Express API, durable workflows, owner SQL, managed documents, OAuth integrace, Prime bridge; `cloud/server.mjs:82`, `:113`, `:928`; `cloud/store.mjs:26`; `cloud/integrations.mjs:133` | Account namespace není organizace. Prime je operator-only na `cloud/server.mjs:1012`. Jedna běžící/zastavující session na owner na `:1106`–`:1108`. |
| Apple SwiftUI | Design system, čitelný transcript, offline/cache/revocation model, protocol kit, test fixtures | `apps/apple/NOMOApp/ChatModel.swift:146` zavádí `OfflineChatTransport`; není shipping connected executor. `AppModel.swift:92` uvádí no paired transport. Backend pairing registry existuje, ale end-to-end produkt nevyplývá z existence protocol kit. |
| Hosted Appwrite MCP | Read-only projekt/registry/tool katalog, stateless snapshot; `apps/appwrite-mcp/README.md:3` | Nevykonává recovery. Je vhodný distribuční/informační kanál, nikoli hosted execution služba. |
| TUI | Preview HTML je samostatný povrch; engine a CLI audit vlastní jiné workstreamy | Plán musí používat sdílený capability contract, aby TUI/GUI nepřidávaly rozdílnou autoritu. |
| Marketing | Teaser vědomě omezuje undo na captured reversible actions; `marketing/teaser/README.md:17` | Film sám neměří lead kvalitu, activation, paid conversion ani product proof. Potřebuje konkrétní reprodukovatelnou ukázku. |

## 3. Bezpečnost a identita: silné stránky a otevřené brány

### 3.1 Doložené dobré základy

- `cloud/server.mjs:113`–`:148`: middleware zavádí same-origin/sec-fetch-site kontrolu, setup_required a operator session; nemá implicitní anonymous sdílený workspace.
- `cloud/server.mjs:259`, `:274`: owner vzniká z ověřeného operator tokenu nebo live account identity. `cloud/owner.mjs:29`, `:35`, `:46`, `:55` odděluje operator, public-demo a validaci owner.
- `cloud/store.mjs:26`–`:76`: parametrizované owner SQL a owner v transaction lock key; odmítnutí chybějící identity před database access.
- `cloud/schema.sql:14`, `:15`, `:22`: kompozitní primary keys s owner; `:30`–`:45` RLS a revokace public/API rolí. Komentář na `:29` říká, že server běží jako database owner: izolace proto závisí také na správném serverovém kódu, ne na tenant policy pro aplikační DB principal.
- `cloud/store.mjs:87`–`:113`: AES-GCM pro explicitně šifrované hodnoty. To není tvrzení, že všechny sloupce nebo exporty jsou šifrované.
- `cloud/integrations.mjs:133`–`:179`: OAuth callback výjimka má sealed owner state, browser binding, single use, expiraci, kontrolu client config a connection version. Vercel má jiný flow než PKCE (`cloud/oauth.mjs:84`).
- Desktop nesvěřuje WebView Node/shell: CSP a prázdné broad capabilities (`tauri.conf.json:13`–`:15`); startup odstraňuje `NODE_OPTIONS`, `NODE_PATH`, cloud token (`main.rs:152`–`:154`). Keychain má samostatnou implementaci a testy.
- React obsahuje focus handling, aria-live/status, modal traps a reduced motion (`ui.tsx:173`–`:187`, `main.tsx:157`, `:409`, `account-gate.tsx:65`). Tato evidence je dobrý základ, nikoli hotový WCAG audit.

### 3.2 Rozhodovací brány před placeným multi-tenant SaaS

| Brána | Dnešní důkaz | Návrh acceptance criteria |
|---|---|---|
| Account → organization | Owner je individuální principal; schema neobsahuje organization membership/billing | Dva uživatelé ve stejné organizaci a dva v různých organizacích; negativní cross-org/cross-role testy pro API, export, events, jobs, recovery a OAuth. Owner namespace migrace je explicitní a auditovaná. |
| Rollen a approvals | Osobní účet i operator gate existují; neprokázána týmová separation of duties | Vymezit owner/admin/operator/reviewer/viewer jen podle skutečné potřeby; approval nikdy nelze získat změnou request body. Revokace membership zastaví nové akce a streams podle definovaného kontraktu. |
| OAuth onboarding | Klient registrace a user auth jsou oddělené; UI vysvětluje admin registraci (`integrations.tsx:330`) | Pilot lze připojit bez asistence autora. Princip nejmenšího oprávnění pro konkrétní workflow; široké GitHub `repo` a Supabase write/secrets scope na `oauth.mjs:11`, `:32` se zákazníkovi vysvětlí před připojením. |
| Auth lifecycle | Cloud účty mají seal/liveSession, Supabase; vedlejší `cloud/auth.mjs` používá Appwrite | Zdokumentovat canonical auth stack a oddělit ostatní deploy utility; otestovat disabled account, remote logout, token refresh, reset a provider outage. Login UI nabízí jen password (`account-gate.tsx:29`), backend capability se nesmí prezentovat jako hotová UX. |
| Abuse / spend | Demo limit 50/day, 6/visitor (`demo.mjs:97`); sessions single-run owner gate | Zátěžově ověřené limity na auth, session creation, tools, events a export. Per-account budget nesmí růst jen mazáním cookie. Překročení rozpočtu musí zabránit dalšímu placenému provider callu. |
| Secrets/retention | `store.mjs:66` ukládá session JSON s trim events; `:78` projekce citlivé atributy vynechává | Data classification pro prompts, tool args/results, provider keys a recovery artefacts; skutečný export/delete/retention lifecycle respektuje auditní požadavky. Nevydávat obecné tvrzení „všechna data jsou encrypted“. |
| Billing | V rozsahu `apps/**`, `cloud/**` není nalezen Stripe/checkout/subscription lifecycle | Webhook signature, dedup, out-of-order/replay, subscription state, seat changes, trial/expired state, dunning, cancellation a export po cancel; test sandbox plateb bez reálných charges. Invoice payment pilot může předcházet automatickému billing. |
| Provozní readiness | Durable workflow a SQL základy existují | Monitoring error budget, queue stuck states, backup restore drill, incident runbook, region/residency a deletion commitments podle skutečné nabídky. SLA nejdřív po měření a zajištění podpory. |

## 4. Konkrétní produktové problémy k zařazení do plánu

### P1 — identita demo providera nesouhlasí s implementací

`cloud/demo.mjs:22` importuje NVIDIA_URL, `:115` vyžaduje `NOMO_DEMO_NVIDIA_KEY`; error text na `:43`–`:47`, publicView na `:131` a status na `:167` používají TokenRouter. To je staticky doložená nesrovnalost. Není to důkaz špatného routování v nasazení. Zákazník musí vždy vědět, kam jeho data a model call jdou.

Acceptance: `/status`, transcript metadata, model label, error copy a skutečný endpoint identifikují stejný provider; snapshot konkrétní session se při změně defaultu nepřepisuje. UI nesmí slibovat „Free“ bez vysvětlení, kdo platí inference a jaký je limit.

### P1 — release a download cesta mají jiné verze

`apps/desktop/src-tauri/tauri.conf.json:4` používá 1.0.1, `apps/control-plane/ui/src/desktop-downloads.ts:3`–`:5` odkazuje beta.4 se soubory 0.1.0. To může být záměrné oddělení local candidate a posledního distribuovaného buildu; plán je musí explicitně rozlišit.

Acceptance: release manifest je zdrojem product version, supported OS/arch, signing state, checksum a download URL; clean-machine test obou OS; žádný download button pro nepřipravený artifact. Notarization/signing jsou release gates, ne návrh na rozšíření engine scope.

### P1 — první hodnota není „otevřel chat“

Současná UI je široká; `settings.tsx:361` DesktopSetup řeší provider import, `workspace-controls.tsx:64` vysvětluje, že root path není filesystem grant. To je bezpečně správné, ale nováček potřebuje jasnou cestu od project selection k chráněné změně. Cloud managed documents mají jinou hodnotu než skutečná změna repozitáře.

Navržený acceptance scénář: uživatel na čistém stroji do 5 minut bez autora provede chráněnou fixture změnu, přečte diff a rozsah, úmyslně vloží konflikt, uvidí odmítnutí slepého rollbacku, úspěšně obnoví podporovanou variantu a exportuje samostatně ověřitelný proof. Tento scénář musí jít bez production credentials a bez placeného model callu; AI verze je samostatná další varianta.

### P1 — zlepšovat outputs přes důkazy a feedback

Konkurence má kvalitní agents/models. Přidávání dalšího výchozího modelu samo neprokazuje lepší outputs. Budoucí „done“ kontrakt má obsahovat task-specific test, diff, změněné zdroje, neověřené body a lidské hodnocení. Měřit success na referenční sadě před/po. Volitelný retry nesmí potichu měnit provider, obejít denial nebo zduplikovat side effect.

### P2 — Apple nesmí prodlužovat cestu k první retenci

Protocol kit je využitelná investice. Shipping offline companion nepřináší novou hodnotu prvnímu pilotu. Před živým transportem definovat read-only MVP: explicit pairing, capability handshake, history source, reconnect, expiring credentials, revoke a real executor connectivity. Approval/write mode je jiný increment s idempotency a unknown outcome UX. V1 placené nabídky nemusí native iOS obsahovat.

### P2 — architektura UI a types

`chat.tsx` má 1 629 řádků, `main.tsx` 1 126, `settings.tsx` 835; `api.ts:1` používá `Record<string, any>`. Plánovat typované response schemas a vyjmutí behavior modulů pouze tam, kde odblokují capability parity, bugfix nebo reliability. Velký rewrite v první obchodní fázi má vysokou opportunity cost; současné pure helpery a testy lze rozšiřovat.

## 5. Doporučené pořadí, podléhající uživateli

1. **Proof + release + activation:** sjednotit tvrzení, capability matrix, provider identity, download reality; clean-machine evidence a krátký golden workflow.
2. **Úzký placený pilot:** jeden effect/workflow, existující agent, zákazníkův sandbox, měřitelný time saved/recovery correctness, omezená podpora. Zatím faktura a ruční provisioning, pokud je to transparentní a průchodné.
3. **Team recurring value:** organization policy, review responsibilities, evidence retention/export, weekly outcome report a minimální metering. Smyslem je opakovaná hodnota při každé session, nikoli předplatné za vzácný incident.
4. **Self-serve:** billing, onboarding/support automation, integration install a rozpočty až po opakované pilotní aktivaci.
5. **Rozšíření:** druhý adapter/effect nebo agent podle zákaznických důkazů. Native iOS, nový IDE, RE specializace a plná orchestrace jsou konkurenční alternativy k prioritám, ne souběžné povinné cíle.

## 6. Varianty k diskusi A/B/C/D

- **A — konkrétní recovery pro každodenní AI coding (výchozí doporučení):** jednotlivec začne lokálně, team lead kupuje policy/evidence. Nutné ověřit skutečnou průchodnost existujícího agentového workflow a rozdíl proti checkpointům.
- **B — managed-team evidence/control:** silnější recurring ARPA, ale výrazně více identity/provozu a delší prodej. Vhodné, pokud už existuje platící tým s požadavkem na evidence.
- **C — specializace na DB/infrastructure změny:** vyšší riziková hodnota a ochota platit, ale recovery boundaries/sandbox/provoz jsou náročnější. Jen konkrétní podporované efekty, žádné „undo everything“.
- **D — all-in-one agent workspace:** nejširší developer appeal, přímý souboj s Codex/Cline/OpenHands a vysoké náklady; vyžaduje distribuční výhodu nebo měřitelně lepší outcome, kterou současný audit neprokazuje.

Otázky pro zákazníka i zakladatele: který workflow dnes používáte několikrát týdně, kde vás agent stojí čas/peníze, co byste potřebovali vidět před důvěrou, kdo platí a jaká cena je reálně schválitelná? Volba varianty nemá být schválení každého hypotetického feature pod ní.

## 7. Aktualizované zadání během návrhu

Uživatel zvolil add-on pro existující externí agenty (varianta A), nikoli novou hlavní agentovou aplikaci. Požaduje kompatibilitu **Codex, Claude Code, Hermes, OpenCode** a wow scénář **filesystem + Git + Postgres**. Rozpočet kapacity je větší tým, přesný počet/úvazky neznámý. CEO doporučení monetizace delegoval. Předchozí varianty slouží ke srovnání; nejsou všechny schválenou roadmapou.

Produktová konsekvence: stabilizovat desktop jako lokální approval/recovery/evidence panel a installation průvodce; chat nesmí být povinnou náhradou původního agenta. Pro každý ze čtyř hostů zveřejnit capability coverage podle transportu a efektu: interceptovaný MCP call, nativní file tool, shell a přímý síťový call jsou různé hranice. Pouhá možnost přidat MCP endpoint neprokazuje, že veškerá práce hosta prochází NOMO. Marketingová kompatibilita se smí slíbit až po skutečném conformance testu konkrétního hosta/verze. Podpora všech čtyř je cíl; implementace může běžet paralelně, ale musí sdílet jeden contract a samostatné důkazy.

Wow fixture má měnit soubor, Git stav a Postgres řádek v zákazníkem kontrolovaném sandboxu; vedle úspěšné obnovy předvést dirty worktree, untracked soubory, změnu druhého developera/agentu, restart a DB concurrent mutation. UI musí rozlišit restored/conflict/partial/unknown a zachovat podporované změny ostatních. Git commit nebo DB řádek nesmějí být prezentovány jako atomický společný rollback, pokud kontrakt prokazuje jen jednotlivé kroky.

## 8. Doplňková inspekce marketingového repozitáře

Pouze částečná read-only inspekce `/workspace/void-site-audit` na `85c6792838f5014818d48e93188342cf3c824c8e`; žádné změny. `artifacts/nomo/src/lib/pricing.ts:9`–`:10` výslovně uvádí, že tento web nepozoruje agent tool calls; `:37` drží Team price 249. `artifacts/nomo/src/sections/pricing.tsx:133` označuje ceny za illustrative a allowance za agreed, ne live meter. Nezaměňovat veřejnou pricing stránku za funkční subscription billing. Komentované benchmarkové ceny konkurence nejsou tímto auditem znovu ověřeny.

`api/waitlist.ts:68` ukládá požadavek před notifikací; `:94` loguje failure notification. `api/_store.ts:383`–`:397` má memory fallback s `stored:false`; při serverless restartu to není durable lead. Akvizice potřebuje zvlášť měřit durable/temporary receipt a nepočítat volatile waitlist jako skutečný pipeline. `lib/db/src/schema/traffic.ts:6`–`:17` má záměrně agregovaná day/path/kind data bez visitor/session/referrer/IP; to je privacy výhoda, ale nedává unikátní cohort conversion ani zdroj leadu. Funnel měřit opt-in lead/campaign atribucí a pseudonymními produktovými activation events podle odsouhlasené privacy politiky. Nepřidávat skryté session tracking.
