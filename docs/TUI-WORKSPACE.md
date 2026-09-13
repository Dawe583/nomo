# VOID na vlastním počítači

## Spuštění

Z kořene repozitáře:

```sh
pnpm tui
```

Na macOS lze spustit také `VOID.command` dvojklikem. Potřebuje dostupný Node.js
24+ a pnpm. Není to `tui:preview`: tento příkaz používá skutečný lokální Workbench,
šifrované uložiště, skutečný model a skutečné dokumentové operace.

Na tomto počítači byl TokenRouter importován do lokálního šifrovaného úložiště.
Jinde jej připojí příkaz uvnitř TUI:

```text
/connect opencode:tokenrouter
```

Import čte pouze pevnou cestu `~/.config/opencode/opencode.jsonc`, povolený
endpoint TokenRouteru a doslovný API klíč. Nevykonává konfiguraci, shell ani
odkazy na příkazy. `/sources` ukáže další dostupné zdroje. Model pro nové
konverzace je `z-ai/glm-5.3-free`, dokud jej provider nabízí; žádný tichý placený
fallback. Pokud import není potřebný, lze použít uložený profil nebo proměnnou
`TOKENROUTER_API_KEY` bez zadávání klíče do příkazové historie.

## První skutečný test

1. `n` založí novou konverzaci. `i` zapne psaní.
2. Napiš: `Vytvoř plán testování a ulož ho do plan.md.` Enter odešle.
3. Tab přepíná přehled, chat, konverzace, dokumenty, ledger, schválení,
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
