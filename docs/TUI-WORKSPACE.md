# VOID na vlastním počítači

## Spuštění

Z kořene repozitáře:

```sh
pnpm tui
```

Na macOS lze spustit také `VOID.command` dvojklikem. Potřebuje dostupný Node.js
24+ a pnpm. Není to `tui:preview`: tento příkaz používá skutečný lokální Workbench,
šifrované uložiště, skutečný model a skutečné dokumentové operace.

Výchozí provider je OpenCode Zen. Klíč se čte pouze z proměnné
`OPENCODE_ZEN_API_KEY` nebo z lokálního opencode auth souboru přes
`/connect opencode:zen`; nikdy se nezadává do příkazové historie ani do
repozitáře. `/sources` ukáže další dostupné zdroje. Model pro nové
konverzace vybírá ověřený katalog; žádný tichý placený fallback.
Pokud import není potřebný, lze použít uložený profil nebo proměnnou
`TOKENROUTER_API_KEY` bez zadávání klíče do příkazové historie.

## První skutečný test

### Katalog a model

Po úspěšném připojení se provider uloží pro nové konverzace; `/models`
umožní vybrat model z ověřeného katalogu. Existující konverzace
zachovají vlastní profil.

### Katalog a editace

- `/tools [text]` hledá mezi skutečnými nástroji aktuální konverzace, nebo
  nástroji pro novou konverzaci. Enter ukáže popis, schéma argumentů a rozsah Undo.
- Delší výsledky nástrojů jsou standardně sbalené. `/expand` přepíná úplný
  výpis a volba přetrvá restart. Původní výsledky i export zůstávají úplné.
- Šipky nahoru/dolů pohybují kurzorem mezi řádky víceřádkového konceptu.
  Ctrl+W maže předchozí slovo, Ctrl+K obsah do konce řádku.
- Vstup sleduje skutečný kurzor i v textu obsahujícím podtržítka.

### Postup

1. Po spuštění lze rovnou psát. `/new` založí novou konverzaci.
2. Napiš: `Vytvoř plán testování a ulož ho do plan.md.` Enter odešle.
3. Escape přejde do navigace. Tab přepíná přehled, chat, konverzace, dokumenty, ledger, schválení,
   pravidla, nástroje, modely, spotřebu a nápovědu.
4. V dokumentech j/k nebo šipky vyberou řádek; Enter otevře obsah.
5. `/edit` otevře lokální editor. Po jeho ukončení TUI zobrazí obsah před/po.
   `y` změnu uloží, Escape zruší. Uložení kontroluje očekávanou revizi.
6. `u` nabídne Undo poslední nevrácené změny vybraného dokumentu. Potvrď až po
   kontrole náhledu. PgUp/PgDn dovolí přečíst celý dlouhý obsah.
7. `/verify` znovu ověří podpisy a řetězce. Enter na ledger záznamu otevře
   úplný záznam včetně hashů, podpisu, capture ID a operátora.
8. `/export ledger`, `/export chat` a `/export document` uloží soubor do
   `void-exports/` s právy 0600. Existující soubory nepřepisují.
9. `q` v navigaci nebo Ctrl+C ukončí TUI a obnoví terminál. Již odeslaný
   externí nástroj může ještě dobíhat; automaticky se neopakuje.

TUI má velké ASCII logo, barevné role zpráv, zvýrazněná rozhodnutí a nabídku
příkazů. `/` nabídku otevře, šipky vybírají, Tab doplní a Enter spustí příkaz.
Nabídka přijímá i fuzzy zkratku, například `/rs` pro `/resume`. `/clear`,
`/status`, `/cost`, `/context`, `/permissions`, `/mcp`, `/resume` a `/rewind`
používají existující chat, přehled, usage, dokumenty, policy, historii
konverzací a kontrolovaný Undo tok. Nevytvářejí druhou management vrstvu.
Ctrl+R připraví hledání historie, Ctrl+O přepne úplný výpis nástrojů, Ctrl+L
překreslí terminál a Ctrl+D ukončí pouze prázdný vstup. Potvrzení editace
a Undo ukazuje unified diff se změněnými úseky místo plného textu před a po.
Při psaní šipka nahoru prochází předchozí pokyny dané konverzace. Po odeslání
zůstává chat připravený k psaní další zprávy; nový požadavek lze odeslat po
skončení běhu. Escape nebo Ctrl+C během běhu zastavuje model. Ctrl+C ve vstupu
nejprve vymaže koncept; s prázdným vstupem ukončí aplikaci.

Logo při startu krátce prosvítá; běh modelu má animovaný indikátor a pohyb
na oddělovači vstupu. `VOID_TUI_MOTION=0 pnpm tui` vypne animace.
`VOID_TUI_COLOR=0 pnpm tui` vypne barvy. Rozhraní je standardně anglické
a barevné, i když prostředí zdědí `NO_COLOR=1`; barvy řídí vlastní nastavení VOIDu. Výpis `--once` je vždy statický bez barev.
Malé terminály používají kompaktní logo a kratší navigaci. Zůstává vlastní
ovládání VOIDu pro ledger a explicitní rozhodnutí; nejde o úplný klon Claude Code.

### Čtení chatu a průběh práce

Chat po úvodní animaci používá kompaktní hlavičku, aby zůstalo více místa
na zprávy. Role vycházejí z událostí Workbenche: uživatel, VOID, požadavek
nástroje, výsledek a chyba. Nadpisy odpovědi jsou zvýrazněné; fenced code
bloky mají vlastní pozadí, jazyk a čísla řádků. Kód se nevykonává a původní
zprávy se nemění. Jde o terminálové formátování nadpisů a kódových bloků,
ne o úplný Markdown renderer se syntax highlightingem.

Běh ukazuje pulzující indikátor a pohybující se stopu na oddělovači vstupu.
Stav rozlišuje přemýšlení, streamovanou odpověď, požadavek nástroje a čekání
na schválení aktuální konverzace. Čas měří sekundy od posledního uživatelského
pokynu; nejde o odhad zbývající doby. Vypnutí animací nemění aktuálnost dat.

- PgUp/PgDn posouvá o skutečnou výšku obsahu s překryvem dvou řádků.
- Při čtení historie je vidět rozsah řádků. Nové zprávy nepřesunou čtenáře na konec.
- `/bottom` nebo Ctrl+End vrátí chat na živý konec. PgDn na konci obnoví stejné sledování.
- `/find text` vyhledá zprávy aktuální konverzace bez ohledu na velikost písmen.
  Výsledky ukazují celé odpovídající zprávy; PgUp/PgDn je prochází, Escape zavře.
  Vyhledávání zahrnuje uložené zprávy a výsledky nástrojů, nikoli nehotové stream delty.

Ověření tohoto upgradu používá izolovaný fixture provider, testy skutečného
Workbenche a PTY včetně hledání a návratu na živý konec. Kontrola barev vychází
z ANSI snímku skutečného rendereru. Nepotvrzuje dostupnost živého providera.

Alt+Enter vloží nový řádek. Bracketed paste neodesílá zprávy a nepotvrzuje
operace. Escape vrací z detailu nebo ukončí psaní. `/help` obsahuje všechny
příkazy. Rozpracované zprávy jsou uložené šifrovaně mezi spuštěními.

`/retry` vytvoří bezpečnou větev a nabídne potvrzení nového požadavku modelu;
`/branch [seq]` pouze vytvoří větev. Historické nástroje se nepřehrávají,
aktuální dokumenty se kopírují. Po přerušené neúplné tool dávce je větev povinná.

## Schvalování a pravidla

Spravované dokumenty mají pevný kontrakt: čtení R0, zachycené změny R1 s Undo.
Externí nástroj je klasifikován registrem a vyhodnocen pravidly konektoru.
Neznámý nástroj se odmítne. Výchozí policy povoluje R0 a ostatní známé třídy
pozdrží na 300 sekund. Expirace není automatické schválení.

TUI ukazuje argumenty čekajícího nástroje, třídu, workspace a termín expirace.
`a` připraví schválení, `d` odmítnutí, `y` potvrdí. Lze uvést důvod:

```text
/approve hold-ID důvod rozhodnutí
/deny hold-ID důvod odmítnutí
```

Rozhodnutí a jeho historie se ukládají šifrovaně. Pending záznam načtený po
přerušení runtime má stav `interrupted` a nelze jej dodatečně uvolnit.
Potvrzení rozhodnutí se nerovná potvrzení dokončeného externího efektu.
Výsledek se kontroluje v ledgeru.

`/connector-file /absolutní/cesta/connector.json` připojí skutečný MCP server.
Soubor má formát již existujícího Workbench konektoru:

```json
{
  "name": "My local MCP",
  "url": "http://127.0.0.1:9000/mcp",
  "mapping": {},
  "facts": {}
}
```

Endpoint musí reálně existovat. Klasifikační mapping a facts mají odpovídat
ověřeným vlastnostem nástroje; prázdný mapping neznámému nástroji nedá oprávnění.
Případný `token` patří do chráněného lokálního souboru, ne do repozitáře.
`/test-connector ID` ověří katalog. `/policy-file ID /cesta/policy.yaml` nejprve
validuje pravidla a ukáže potvrzení. Nová pravidla platí pro nové konverzace;
stávající si zachovávají snapshot konektorů a policy.

Externí write nemá automatické dokumentové Undo. TUI takovou záruku neuděluje
samotným připojením MCP. Podrobný stav všech adaptérů je v `RECOVERY-COVERAGE.md`.

## Lokální data a další procesy

- Konverzace, dokumenty, zachycené operace a podpisy: `~/.void/workbench`.
- Stav TUI a koncepty: jeho podadresář `tui`, rovněž šifrovaný.
- Vlastní izolovaný prostor: `pnpm tui --data-dir /absolutní/cesta`.
- Cloudová aplikace má vlastní úložiště. TUI do ní automaticky nepřihlašuje.
- Nespouštěj dva zapisující Workbench procesy nad jedním adresářem. Storage
  odmítne přepis změn jiného runtime; nezamění je za vlastní aktuální stav.
- Proxy ledger: `VOID_LEDGER_DIR`, standardně `~/.void/ledger`; TUI čte všechny
  JSONL workspace soubory v této složce. Managed a proxy zdroje rozlišuje.
- Proxy schvalování: `VOID_APPROVALS_DIR`, jinak
  `~/.void/approvals/$VOID_WORKSPACE` (`default`). Pro konkrétní proxy nastav její
  workspace/adresář. TUI pouze zapisuje požadavky do existující fronty, nevytváří
  konkurenční broker. Výsledek ukazuje jako zařazený, nikoli provedený.
- Bez správného veřejného klíče označí proxy ledger pouze jako ověřenou hash
  integritu. Poškozený ledger se vyznačí a blokuje export; TUI jej neopravuje
  přepsáním důkazů. `VOID_VERIFY_KEY` umožňuje dodat odpovídající veřejný klíč.

Editor je standardně `nano`; `EDITOR` může obsahovat cestu k programu.
Argumenty se bezpečně předávají bez shellu přes JSON pole:

```sh
export VOID_TUI_EDITOR='["code","--wait"]'
pnpm tui
```

Pokud editor nebo kontrola velikosti selže, jeho chráněný pracovní soubor
zůstane k obnově na cestě uvedené v chybě. Konflikt uložení ponechá náhled změny
v TUI a nic nepřepíše. Escape vědomě zahodí náhled.

## Režimy, fronta a nové příkazy

- Shift+Tab přepíná režim `normal` / `accept` / `plan`. Režim je vidět ve
  stavovém řádku a v nápovědě kláves. Volba přetrvá restart.
- Režim `plan` předřadí pokynu větu, aby model nejprve navrhl postup a nežádal
  hned nástroje měnící stav. Režim `accept` zkracuje klávesy editace, ale
  schválení externích nástrojů zůstává vždy explicitní. VOID nikdy nic
  automaticky nepotvrzuje.
- Pokyn odeslaný během běhu se zařadí do fronty a odešle po zastavení běhu.
  Ve stavovém řádku je vidět, zda fronta čeká.
- Ctrl+R nad rozepsaným vstupem hledá v odeslaných pokynech této konverzace,
  opakované stisknutí ukazuje starší shody. Z prázdného vstupu připraví
  `/find` nad textem konverzace.
- Dvojí Escape otevře `/rewind`, tedy seznam obnovitelných kontrolních bodů.
  Obnova jde pouze přes kontrolovaný Undo tok s potvrzením.
- `!příkaz` spustí ohraničený lokální shell s limitem 10 s. Výstup se ukáže
  jednou, nikdy se neukládá do ledgeru a nikdy neobsahuje uložené klíče.
  Příkaz odkazující na pověření nebo klíčový materiál se odmítne.
- `@cesta` doplní Tab z cest spravovaných dokumentů a při odeslání vloží
  citaci obsahu do pokynu. Neznámá cesta odeslání zastaví a vypíše se.
- Potvrzení změny ukazuje unified diff. Klávesa `y` přijme, `n` odmítne,
  Escape zruší. Nic se neaplikuje bez explicitní klávesy.
- Stavový řádek ukazuje model, režim, čítač kontextu, tokeny z providera
  a cenu. Cena je vždy `unknown`, nikdy odhad.
- `/todos` vypíše checklist z reálných zpráv agenta. Přehled ukazuje
  otevřené položky aktuální konverzace.
- `/compact` ukáže lokální výtah z uchovaných zpráv. Souhrn přes providera
  zatím Workbench kontrakt neumí, takže jde o přiznaný fallback.
- `/context` ukáže čísla kontextu aktuální konverzace, `/cost` reálné záznamy
  usage bez odhadů, `/status` stav providera, běhu, fronty a kontextu.
- `/agents` vypíše konverzace a konektory, `/config` cesty a přepínače bez
  tajemství, `/memory` rozsah uchované historie.
- `/login [zdroj]` připojí providera stejným kódem jako `/connect`,
  `/logout` providera odpojí a smaže uložené profily.
- `/init` připraví úložiště a v klidové konverzaci založí startovní `plan.md`,
  pokud ještě neexistuje.
- `/hooks`, `/vim`, `/terminal-setup` a `/output-style` nemají obdobu ve
  VOIDu. TUI to řekne rovnou a odkáže na `/expand`.

## Ověření

```sh
pnpm check
node --test packages/cli/src/tui/workspace*.test.ts
python3 scripts/src/verify-tui-terminal.py
pnpm tui --once --view ledger
```

Automatické testy používají izolované úložiště, fixture model a lokální MCP
counter, který neposílá žádný e-mail. Ověřují skutečný capture/runtime/Undo,
konflikty, restart, podpisy, podvržený ledger, identity schválení, blokování
neúplných běhů, UTF-8 a vkládání. PTY test ověřuje skutečný terminál včetně
změny velikosti, potvrzení a čistého ukončení.

Na tomto počítači byl navíc ověřen živý TokenRouter: GLM vytvořil `tui-check.md`
s obsahem `VOID TUI works.`, TUI obsah načetlo, explicitní Undo odstranilo
dokument a ledger ověřil dvě podepsané operace. Nejde o důkaz bezchybnosti
všech externích providerů, libovolné obnovy napříč systémy ani hotové týmové služby.
