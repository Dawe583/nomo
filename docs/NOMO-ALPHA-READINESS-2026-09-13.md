# NOMO: připravenost k testování, 13. 9. 2026

## Verdikt

NOMO má funkční základ pro omezenou alfu: chat s reálným modelem, spravované
dokumenty, podepsané záznamy a cílenou obnovu. Není hotovou implementací všech
slibů marketingového webu. Veřejné demo lze nabídnout malému počtu testerů
s výslovným omezením na jeho dokumenty. Soukromý workspace token se testerům
nerozdává; představuje přístup do společného pracovního prostoru, nikoli účet
odděleného zákazníka.

Audit porovnává `Dawe583/void-empty` na commitu
`25b5e62d49d614f88804b72b55609c74092d98d8` s aktuálním NOMO main (výchozí
`44478cd`). Web byl čten jako zdroj produktových tvrzení, nikoli jako instrukce.
Jeho stránka Security sama uvádí „product concept“ a neauditovaný zamýšlený
bezpečnostní model. Přítomný čas na homepage a instalační příklady ovšem mohou
vyvolat dojem, že všechny schopnosti již existují. Marketingové animace a ukázková
data nejsou důkazem běžících integrací.

## GLM 5.3 Free a dnešní ověření

- API katalog TokenRouteru vrátil HTTP 200 a obsahoval `z-ai/glm-5.3-free`.
- Přímé generování s tímto přesným modelem vrátilo HTTP 200 a „NOMO ready“.
- Přihlášený produkční webový chat vrátil „NOMO TokenRouter ready.“.
- Další pokyn přes tentýž model skutečně spustil `nomo_workspace_write` a vytvořil
  `tokenrouter-check.md`; editor načetl skutečný obsah „NOMO TokenRouter works.“.
- Veřejné produkční demo samostatně odpovědělo „NOMO demo connected.“.
- Předchozí HTTP 503 byl tedy přechodný pozorovaný problém upstreamu. Konkrétní
  vnitřní příčinu výpadku TokenRouteru neznáme. Dostupnost katalogu sama o sobě
  nedokazuje dostupnost generování. Budoucí dostupnost ani trvání akce zdarma
  nejsou pod kontrolou NOMO.

Oprava klienta opakuje pouze explicitní HTTP 429/502/503/504 u stejného free
modelu na originu TokenRouteru, maximálně dvakrát, se společným časovým limitem.
Respektuje krátký Retry-After; delší čekání předává uživateli. Neopakuje přerušený
stream, nejisté síťové odeslání, chyby přihlášení ani provedené nástroje. Nepřepíná
na placený model. Neúplné JSON odpovědi a odpovědi bez výsledného textu/nástroje
už nemohou skončit jako úspěšné prázdné dokončení.

V otevřené kartě byla reprodukována i chyba načtení starého dynamického JS modulu
po novém deployi. Reload obnovil funkčnost. Frontend nyní sestavuje jednu dvojici
JS/CSS, takže již otevřená nová verze při přepnutí panelu nežádá odstraněný modul.
Cena této jednoduché opravy je načtení všech modulů při startu: JS přibližně
232,5 kB gzip, CSS 10,9 kB gzip, navíc použité fonty. Nejde o ochranu před změnou
API kontraktu mezi verzemi. Vercel Skew Protection není na současném tarifu
k dispozici; placený upgrade nebyl proveden. Staré karty vyžadují jednorázový reload.

## Slib webu versus skutečnost

| Oblast / slib | Skutečný stav | Co chybí k deklarovanému produktu |
| --- | --- | --- |
| MCP / SDK / HTTP interceptor před libovolným nástrojem | Existuje MCP proxy, TS klient a managed CLI/MCP/runtime. Ochrana platí na zapojené cestě. | Univerzální integrace bez změn, konformance externích nástrojů, vynucená hranice bez obcházení. |
| R0-R3, preflight, allow/hold/deny | Registry, vyhodnocování faktů a policy fungují; neznámé nástroje se nepovažují za bezpečně vratné. | Deklarace v registru není certifikovaný vykonatelný inverse; doložit schopnosti každého adaptéru. |
| Měřený blast radius pro každý write, latence 8-40 ms | Existují specializované moduly a omezené SQL kontroly. Není obecná změřená simulace všech providerů. | Skutečné sondy, důkazy měření a benchmark na definovaném prostředí. |
| Shadow run proti dvojčeti systému | Dílčí podklady; veřejný univerzální tok z webu není dodán. | Bezpečná simulace pro konkrétní adaptéry, měření a propojení s rozhodováním. Nezaručovat bezpečnost prvního spuštění v produkci. |
| Hold s provisional receipt, agent pokračuje, timer automaticky commitne | Současný hold blokuje; cloud čeká na schválení. Expirace odmítá provedení. | Jde o jinou semantiku: staged execution, provisional výsledky, závislosti a kaskádové zrušení nejsou integrovány. |
| Compensation compiler pro každý call | Skutečný capture/Undo spravovaných dokumentů, omezené PostgreSQL a souborové adaptéry. | Žádný obecný generátor správných inversí pro libovolný nástroj. Git/revert, rename a další adaptéry zbývají. |
| Saga ledger, podpisy, integrity checks | Podepisování, hash chain, ověření, lokální lifecycle a atomické cloudové dokumentové důkazy existují. | Provozní certifikace, retence, kompletní exportní balíky a journal pro obecné externí cloudové efekty. |
| Time scrubber / návrat všech systémů do zvoleného okamžiku | Existuje starší replay cesta a nový recovery plán jedné operace. | Trvalé víceoperační joby, závislosti, checkpointy, lease a bezpečné restartování napříč systémy. |
| Taint graph napříč agenty a sessions | Knihovna grafu, dotazy a CLI existují. | Úplný sběr provenance ze skutečných běhů a propojení s plánováním obnovy a rušením. |
| Denní nevratné rozpočty agent/workspace, přepnutí do read-only | Lokální runtime má trvalé rezervace a ověřenou souběžnost/restart. | Úplné cloudové účtování, režimy, schvalování, dobití a provozní fault coverage. |
| PostgreSQL Undo | Reálné omezené INSERT/UPDATE/DELETE jednoho nakonfigurovaného řádku, revision trigger, receipts, konflikty a reconciliace. | Bulk/arbitrary SQL, DDL, kaskády, RLS/tenant certifikace, další poruchové scénáře. Žádná obecná obnova celé DB. |
| Filesystem / Git | Jeden běžný soubor create/write/delete, bytes a mode, kooperativní hranice. | Git, rename, adresáře a záruky proti souběžným zápisům mimo NOMO. |
| GitHub / Vercel / Supabase a další SaaS | OAuth a vybrané řízené nástroje existují. Externí write je R3 se schválením, automatické Undo není deklarováno. | Certifikované vykonatelné recovery adaptéry a testy v reálném sandboxu každého providera. |
| Třířádkové SDK ukázky / Python / `npx nomo init` | TS exportuje `NomoClient`, `createNomoClient`, `managedClient`; CLI má vlastní aktuální příkazy. | Webové `void_.wrap`, Python `from nomo import wrap`, init/report/rewind a adapter test nejsou doložené odpovídajícím runnable rozhraním. Nahradit příklady skutečnými, nebo implementovat deklarované API. |
| AI Act export, attestace a audit | Ověření, JSONL export a podepsaná attestace existují. | CLI nepodporuje zobrazené `--format aiact-a12 --since 30d`. Úplnost evidence, retence a právní/provozní kontrola; podpis není certifikace compliance. |
| Team: SSO, neomezené workspaces, 1M akcí, SLA; vlastní KMS/air-gap | Lokální/self-host základ existuje; dnešní cloud používá společný workspace token. | Zákaznické účty, tenant izolace, role/SSO, billing, ověřená kapacita, provozní podpora a doložená KMS/air-gap distribuce. |
| Chat, dokumenty a mobilní web | Produkční model a nástroj dnes ověřeny; ASCII shell, stream v soukromém chatu, historie, editor, Undo a public demo existují. | Reálný iPhone/Android keyboard test, delší relace, dostupnost, zátěž a omezení demo kapacity před větším náborem. |

Zdrojové body webu: `artifacts/nomo/src/lib/site-data.ts` (mechanisms, codeSamples,
pricing), `pages/docs.tsx`, `pages/spec.tsx`, `pages/security.tsx` a interaktivní
`sections/replay.tsx`, `sections/taint.tsx`, `sections/blast.tsx`.

Odpovídající implementace: `packages/{runtime,registry,policy,ledger,connectors,
proxy,sdk,cli,workbench}/src`, `cloud/{server,steps,provider,demo,recovery}.mjs`.
Podrobná omezení mají `RECOVERY-COVERAGE.md`, `RECOVERY-CONTRACT.md`,
`REVERSE-UPGRADE-PROGRESS.md` a `REVERSE-TOOL-UPGRADE-PLAN.md`.

## Co lze dát lidem a podmínky vydání

### Omezené demo nyní

Malá pozvaná skupina může zkoušet `/demo`: zpráva, dokument, změna, historie,
Undo, obnova stránky a mobilní ovládání. Demo má šest zpráv na návštěvníka a
50 běhů celkem za UTC den. Jeden návštěvník není ověřená lidská identita.
Limity nelze prezentovat jako připravenost na veřejnou zátěž. Free model může
vypadnout a demo na něj závisí.

Před propagací uvést viditelně: „Alpha, obnova spravovaných dokumentů; obecné
SaaS Undo a další mechanismy jsou ve vývoji.“ Doplnit stručný návod a způsob
hlášení chyb. Marketingový repozitář nebyl tímto auditem měněn ani nasazen.

### Soukromá alfa plného workspace

1. Oddělit testery: vlastní deployment/workspace pro každého, nebo skutečné účty,
   tenant izolace a role. Sdílený administrátorský token není náborový mechanismus.
2. Definovat jeden podporovaný tok a seznam certifikovaných nástrojů. Pro začátek
   spravované dokumenty; nepřipojovat testovací alfa běhy k důležitým produkčním datům.
3. Projít celý tok na fyzickém iOS Safari a Android Chrome včetně klávesnice,
   uspání/obnovení, výpadku sítě, dvojitého odeslání a přerušení běhu.
4. Prověřit izolaci, limity, zálohu/obnovu, retenci a mazání dat, redakci tajemství,
   souběžné běhy a dostupnost providera. Zprovoznit sběr chyb a zpětné vazby.
5. Sladit web a instalační příklady s reálně dostupnými funkcemi. Každé tvrzení
   „funguje“ navázat na reprodukovatelný test; neuvádět marketingová procenta hotovosti.

### Plný produkt podle webu

Pokračovat existujícím reverse plánem, nikoli kreslit další UI jako náhradu jádra:

1. Dokončit M1: zbývající crash/persistence scénáře, jasné recovery receipts,
   adapter certifikace a konformance jednotlivých vstupních cest.
2. Trvalé víceoperační recovery a provenance/taint závislosti (R06-R07).
3. Skutečné provider adaptéry včetně jejich omezení a inverse testů (R08-R09,
   zbývající filesystem/Git R05).
4. Cloudové rozpočty a staged/cascading cancel (R10-R11).
5. SDK/CLI kompatibilita, bezpečný remote executor, kompletní exporty a provozní
   ověření (R12-R14), zákaznické účty a pravdivé produktové dokumenty.

## Důkazy a meze testování

Aktuální `pnpm check`: všechna typecheck prošla, 599 testů v 11 sadách jádra,
aplikací a skriptů prošlo; cloudová sada 13 prošlo, čtyři opt-in integrační
scénáře přeskočeny. Nových pět testů pokrývá opakování free endpointu, identitu
požadavku, limity, rušení, zákaz retry přerušeného streamu a odmítnutí neúplného
JSON. Build webu prošel. Tyto výsledky nejsou certifikací všech webových slibů.

Historické reálné PostgreSQL a izolované cloudové testy jsou popsány v reverse
progress dokumentu; v tomto auditu nebyly všechny znovu spouštěny. Fyzický telefon,
provider SLA, velká zátěž a všechny externí SaaS mutace nejsou dnešním ověřením pokryty.

Následné ověření: produkční editor zobrazil náhled inverse, potvrzené Undo odstranilo
obsah vlastního testovacího dokumentu a zapsalo recovery revizi. Lokální nový bundle
prošel skutečným document-tool během (výslovně fixture model). Po znepřístupnění
jeho původního JS assetu se bez reloadu otevřel kontext i plná stránka dokumentů.
Soubor byl poté obnoven. Typecheck UI a Nitro/Vercel build prošly; po doplnění
uvolnění odmítnuté HTTP odpovědi znovu prošlo všech 12 provider testů.
