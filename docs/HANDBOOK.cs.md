# NOMO handbook

Úplný návod pro provozovatele: co NOMO je, co odmítá tvrdit, jak se nainstaluje
a jaké příkazy, klávesy, routy a soubory vystavuje. První čas si přečti
kapitoly 1 až 7 v tomto pořadí, zbytek je reference.

Všechno tady je ověřené. [jak se tento návod udržuje pravdivý](../scripts/src/handbook.test.mjs) vytáhne z tohoto
dokumentu každý příkaz, skript, cestu k souboru a odkaz a selhá, pokud některý
z nich přestane existovat, pokud se příkaz vytrácí, nebo pokud se obě jazykové
verze rozejdou. Návod, který lže, je horší než žádný, takže tenhle je brána, ne
proza.

- [1. Co NOMO je](#1-co-nomo-je)
- [2. Co NOMO neumí](#2-co-nomo-neumí)
- [3. Pojmy](#3-pojmy)
- [4. Instalace](#4-instalace)
- [5. Prvních deset minut](#5-prvních-deset-minut)
- [6. Připojení poskytovatele modelu](#6-připojení-poskytovatele-modelu)
- [7. Který povrch použít](#7-který-povrch-použít)
- [8. Terminálové rozhraní](#8-terminálové-rozhraní)
- [9. Webová a desktopová aplikace](#9-webová-a-desktopová-aplikace)
- [10. Příkazová řáda](#10-příkazová-řáda)
- [11. Soubory policy](#11-soubory-policy)
- [12. Ledger](#12-ledger)
- [13. Undo a obnova](#13-undo-a-obnova)
- [14. Hostování MCP serveru](#14-hostování-mcp-serveru)
- [15. Desktopové aplikace](#15-desktopové-aplikace)
- [16. Rozdíly mezi platformami](#16-rozdíly-mezi-platformami)
- [17. Řešení problémů](#17-řešení-problémů)
- [18. Než to namíříš na produkci](#18-než-to-namíříš-na-produkci)
- [19. Kam dál](#19-kam-dál)

---

## 1. Co NOMO je

NOMO je vrstva mezi AI agentem a nástroji, do kterých ten agent může zapisovat.
Každé zachycené volání nástroje posoudí ve čtyřech krocích a pak je zapíše:

1. **Zachytí** volání. NOMO převezme MCP session; agent nekomunikuje přímo se
   svými nástroji.
2. **Klasifikuje** ho. Jak vratitelné je toto volání vzhledem ke stavu cíle?
   Odpověď je R0, R1, R2 nebo R3.
3. **Rozhodne** podle policy souboru, který ovládáš: povolit, zakázat, nebo
   čekat na člověka.
4. **Zapíše** rozhodnutí do podepsaného, hashovaného řetězce ledgeru **předtím**,
   než zápis proběhne.

Později můžeš ledger přečíst, mimo síť ověřit, attestnout jeho výřez a zápis
vrátit, pokud konektor zachytil dost stavu pro přesnou inverzi.

Hodnota není v blokování. Hodnota je, že o měsíce později a bez důvěry v dodavatele
umíš odpovědět: co ten agent udělal, na čí autoritě, a jestli se to dá vrátit.

**Jak se to neprodává.** Vracení akcí agentů je na prodej od srpna 2025, takže
tenhle návod na tom nestojí. Ukázané jsou dvě užší věci, a obě jdou ověřit:

- **Inverze běží proti živému systému a dotkne se jen efektu, který jmenuje.**
  Obnovení databáze do nějakého okamžiku zahodí každý legitimní zápis od té doby;
  inverze vrátí dotčené řádky a nechá beze změny zápisy, které mezitím udělal
  někdo jiný. `scripts/receipt-demo/run.mjs` ukazuje obojí na jedné tabulce: zápis
  agenta, schválení financí mimo NOMO a pak inverzi, po níž je první řádek zpět
  a druhý si drží svou pozdější hodnotu.
- **Potvrzení zůstane v té databázi, kde se efekt stal.** Po ověřené obnově ve
  spravovaném Postgresu se záznam zapíše do `${schema}.recoveries`
  (`packages/connectors/src/postgres/managed.ts:1399`), takže si ho ověří kdokoli,
  kdo se k té databázi dostane, čistým SQL a bez žádného procesu NOMO.
  `docs/RECEIPT-VERIFY.sql` je právě ten dotaz. Vypíše `PASS` jen tehdy, když
  řádek, který každé potvrzení jmenuje, je řádek, který živá tabulka opravdu má,
  a `FAIL`, když ne; byl spuštěn proti záměrně zkazené tabulce, aby se ukázalo,
  že umí selhat (`scripts/receipt-demo/README.md`).

Obnova se odmítne dřív, než se cokoli zapíše, pokud řádky nesouhlasí se
zachycením (`packages/connectors/src/postgres/managed.ts:1393`).

## 2. Co NOMO neumí

Přečti tuto kapitolu před tím, než kapitola 1 vytvoří důvěru k produktu. Každá
položka je současné, změřené omezení, ne bod plánu.

- **Nedělá volání bezpečné důvěrou v modelu.** Omezuje zapisovací cestu. Volání,
  které klasifikuje jako R0 a tvoje policy dovolí, je pořád volání, které si zvolil
  model.
- **Není to sandbox.** Je kooperativní. Řídí nástroje, které mu operátor
  nakonfiguroval. Nezachytí libovolné příkazy shellu, jiné programy ani druhého
  agenta, kterému nikdy neukázal cestu.
- **Undo existuje jen tam, kde konektor zachytil předchozí obraz.** Volání R2 nebo
  R3 nemusí mít inverzi vůbec. `nomo` ti to řekne, místo aby předstíral.
- **Ledger je odolný proti změnám, ne proti změnám nezabránění.** Kdokoli, kdo
  vlastní stroj, může JSONL přepsat. Podpis ti dokazuje, že záznam nebyl změněn
  _po_ zapsání někým, kdo neměl klíč.
  Podpis dokazuje, že bajty pocházejí od procesu, který ten klíč držel, a nic
  dalšího: zapisovač, podpisovač a ověřovač běží jako jeden OS principal
  (`docs/OPERATIONS.md`). Potvrzení ve tvé databázi je trvalý nárok zapsaný vedle
  řádků, o kterých mluví, a kontrola čte ty řádky.
- **Hold není zámek na svět.** Hold pozastaví jedno volání. Zapisovatel, který
  nikdy nešel přes NOMO, je nedotčen.
- **Třídy vratitelnosti jsou konceptuální klasifikace, ne certifikace dodavatele.**
  Přesné znění, které cestuje s daty registru, je v `NOTICE` v kořeni repozitáře.
- **Není tu plán napříč systémy.** Jedna úloha obnovy pokrývá spravované
  dokumenty, spravovaný Postgres a spravovaný filesystém na jednom hostu.
  Nekoordinuje databázi, bucket a git remote do jedné transakce.
- **iOS doprovodka nemůže zapisovat.** Je to ohraničená plně čtecí plocha.
  Vykonavatelem je vždy Mac nebo cloud, a aplikace to taky říká.
- **Na Windows není záruka owner-only na stavu schválení ověřena.** Kontrola
  ověří, že adresář je skutečný a není odkaz; ACL se dědí z tvého profilu
  uživatele. POSIX hosty režim explicitně zúží.

## 3. Pojmy

**Třída vratitelnosti.** Každé volání ji dostane, z registru a z pozorovaného
stavu cíle:

| Třída | Význam                                                      | Obvyklý postoj                                  |
| ----- | ----------------------------------------------------------- | ----------------------------------------------- |
| R0    | Plně vratitelné s přímou inverzí.                           | Povolit, ledger si inverzi nechá.               |
| R1    | Vratitelné se stopou nebo s předchozím obrazem.             | Povolit pro malý blast radius, držet pro velký. |
| R2    | Pouze zmírnitelné. Poškodzení můžeš zmenšit, akci nevrátíš. | Držet nebo zakázat.                             |
| R3    | Nevratitelné.                                               | Držet nebo zakázat.                             |

**Neklasifikované** volání se považuje za R3. Mezera v registru se tak mění v
opatrnost, ne v tichý allowance.

**Blast radius.** Kolika zdrojů by se volání dotklo. NOMO nehádá: pouze změřené
číslo splní pravidlo na radius a chybějící měření nechá radius neznámý, což
nesplní žádné radius pravidlo vůbec.

**Hold.** Rozhodnutí odložené na člověka. Volání čeká; agent dostane informaci,
které pravidlo ho drželo, a že nesmí tentýž pokus zopakovat.

**Ledger.** Jen připisovaný soubor podepsaných, hashovaných záznamů. Jeden
řádek na zachyceno volání. Nikdy se neupravuje, nikdy se nemaže.

**Inverze.** Operace, která vrátí cíl přesně do předchozího stavu. Jen R0 a R1 mají
inverzi. R2 má kompenzace, které poškodění zmenšují, a to není totéž.

**Spravovaný dokument.** Soubor, který NOMO sám vytvořil a vlastní. Jeho zápisy
se zachytí, takže jeho Undo je skutečné. Soubor, který současně upravuje
vnější program, je kooperativní jen částečně a kontrola driftu Undo odmítne.

## 4. Instalace

NOMO potřebuje **Node.js 24 nebo novější** a **pnpm 10**. Ověř obojí:

```sh
node --version
pnpm --version
```

Z Git checkoutu nainstaluj workspace a zpřístupni jeho příkaz `nomo`:

```sh
pnpm install --frozen-lockfile
pnpm setup # jednou, pokud je třeba přidat globální příkazy do PATH
```

`pnpm setup` podle potřeby připraví uživatelský adresář příkazů pnpm. Pokud
změní nastavení shellu, otevři nový terminál. Pak zpřístupni tento checkout jako
`nomo` z libovolného adresáře:

```sh
pnpm link --global
nomo doctor
```

Po přesunu checkoutu nebo výběru jiného klonu link spusť znovu.
Z kořene repozitáře funguje také `pnpm nomo`, `./nomo` na macOS/Linux nebo
`.\nomo.cmd` na Windows, bez globálního linku. `nomo doctor` hlásí terminál,
verzi Node, rozřešené adresáře dat a ledgeru, zda jsou zapisovatelné a zda je
přítomný ověřovací klíč.

Ověř celou instalaci ze zdrojového kódu:

```sh
pnpm run check
```

`pnpm run check` je celý typecheck plus všechny testovací sady. Měl by skončit
kódem 0.

Předkompilované desktopové aplikace jsou na stránce ke stažení odkázané v
`README.md`. Bundlují si vlastní Node runtime, ověřený proti připnutému
oficiálnímu SHA-256, takže koncový uživatel nic neinstaluje.

Když `corepack enable` skončí chybou práv, nepotřebuješ ho. Použij
`corepack pnpm <příkaz>`, což použije připnutého správce balíčků bez zápisu
shimu do instalace Node.

## 5. Prvních deset minut

Udělej to v tomto pořadí. Každý krok je příkaz, který buď funguje, nebo přesně
řekne, co chybí.

**1. Vytvoř rozvržení pracovního prostoru.**

```sh
nomo init
```

Vypíše adresář, který vytvořil, a tři další kroky. Nic jiného nezapisuje a
nic nemaže.

**2. Zkontroluj prostředí.**

```sh
nomo doctor
```

Čekej `PASS` pro verzi Node a datový adresář. `WARN` pro adresář ledgeru na
čerstvém stroji je normální: objeví se při prvním zápisu.

**3. Připoj poskytovatele.** Viz kapitola 6. Dokud to neuděláš, každá konverzace
hlásí `Setup required` a nic nevyšle. To je navržený stav, ne chyba.

**Sbírání místa v obou vaultech.** Rezervovaný vault se nikdy nesbírá implicitně:
sbírání řídí operátor a výchozí politika je `manual`, takže sběr bez
politiky nesmaže nic a vypíše jen report toho, co našel:

```sh
nomo recovery collect --config ./nomo-recovery.json
nomo recovery collect --config ./nomo-recovery.json --retention-policy ./retention.json
nomo recovery collect --config ./nomo-recovery.json --retention-policy ./retention.json --dry-run
```

`--dry-run` vypíše předpověď a digesty, které by skutečný běh smazal, a
nezapíše nic: žádný artefakt se nesmaže a žádný podepsaný řetězec se neotevře,
takže předpověď nelze zaměnit za sběr, který proběhl. Starší adresářové
artefakty sdílejí kořen rezervovaného vaultu a rezervovaný sběrač je
nesbírá, proto `--surface file` spustí vlastní sběrač adresářového vaultu a
`--surface both` spustí oba sběrače s různými operation id. Adresářový
sběrač platí stejná pravidla: soubor bez zaznamenaného důkazu je chráněný,
zaznamenaný pin drží, dokud jej neuvolní pojmenovaný operátor, a smazat se
smí jen to, co je odemčeno a staré podle politiky.

**4. Otevři pracovní prostor.**

```sh
pnpm tui
```

Napiš `/help` pro seznam příkazů, `?` pro kartu nápovědy a `/status`, abys viděl,
co NOMO rozřešil. Ukazatel režimu ve stavovém řádku vždy čte
`local only, not enforced`; kapitola 9 vysvětluje, proč to není chyba tvého
nastavení.

**5. Něco napiš a podívej se na důkazy.**

Napiš větu, nech ho napsat dokument, pak spusť `/ledger`. Záznamy tam jsou
důkazem toho, co se stalo. Spusť `/verify` pro kontrolu řetězce.

Když raději web, `pnpm gui` sestaví klienta a spustí lokální API. Otevře stejný
pracovní prostor, v prohlížeči.

## 6. Připojení poskytovatele modelu

**NOMO nemá žádný výchozí poskytovatele ani výchozí model.** Nový pracovní prostor
nemá ani jedno, dokud nějaký nepřipojíš. Nastavení vypisuje poskytovatele na
výběr a první konverzace se zeptá, který model použít, z katalogu, který vrátí
připojený poskytovatel. Existující konverzace si ponechají poskytovatele a
model, se kterým vznikly; připojení jiného poskytovatele nikdy nepřepíše historii.

Přihlášení udávají dva způsoby a jsou záměrně různé.

**Ambientní, pro vývojáře.** Nastav klíč v prostředí hostitele před startem NOMO:

```sh
export NVIDIA_API_KEY=...
nomo tui
```

NOMO nečte žádný přihlašovací údaj před tím, kterého si operátor zvolil. Preset
TUI bere z hostitelského prostředí `NVIDIA_API_KEY` a preset Qwen v GUI bere
`DASHSCOPE_API_KEY`; žádný jiný klíč se k provideru v žádné ploše nedostane.
Je to volba operátora, ne default NOMO. TUI to říká přímo: `Set
NVIDIA_API_KEY in the host environment, then reopen NOMO. No key is accepted in
chat.`

**Uložený, pro operátora.** V GUI otevři **Nastavení**, pak **Poskytovatel
modelu**. Vyber preset, vlož klíč do heslového pole a stiskni **Připojit a
ověřit**. Klíč se na serveru zašifruje a pole se vymaže. Úspěšné hlášení zní
`Provider connected. The key is encrypted on the server.`

**Nikdy netipuj klíč do chatu.** TUI odmítne příkazy, které vypadají jako
přihlašovací materiál, a GUI nemá v composeru žádné pole na klíč.

Když se nerozřeší žádné přihlášení, odznak stavu říká **Vyžaduje nastavení** a
nic nevyšle. To je záměr: NOMO nepřepíná na jiného poskytovatele, protože tichý
přepínaje poskytovatele je přesně ta chyba, které operátor nevidí.

Presety dostupné v GUI: NVIDIA NIM (`https://integrate.api.nvidia.com/v1`),
OpenCode Zen, Pollinations (zdarma, bez klíče), TokenRouter, Puter (zdarma, bez
klíče), Qwen (Alibaba DashScope), OpenRouter, Anthropic, Google Gemini, Groq,
DeepSeek a Vercel AI Gateway, plus lokální Ollama a LM Studio a vlastní
OpenAI-kompatibilní endpoint. Obě plochy vypisují tentýž seznam; připojí ten,
koho vyberete.
Stav poskytovatele je jeden z: `Připraven`, `Vyžaduje nastavení`, `Limit
poskytovatele` (s nejčasnějším zkušením s retry), `Nedostupný`.

Cena a kvóty poskytovatele se nikdy neodhadují. Tam, kde provider nehlásil číslo,
NOMO vypíše `unknown`, nikdy `$0.00`.

## 7. Který povrch použít

| Povrch              | Spusť                                   | Použij, když                                                                                              |
| ------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Terminál (TUI)      | `pnpm tui`                              | Žiješ v terminálu, chceš ledger vedle a chceš ovládání klávesnicí. Plné klávesy pro schvalování a obnovu. |
| Webová aplikace     | `pnpm gui`                              | Chceš prohlížeč, velikost pro telefon, nebo pohledy na dokumenty a obnovu.                                |
| Desktopová aplikace | `pnpm desktop:setup` pak `pnpm desktop` | Chceš desktopový shell s bundlovaným runtime a nativním úložištěm klíčů.                                  |
| CLI                 | `nomo <příkaz>`                         | Skriptuješ, audituješ, nebo stav ověřuješ z jiného nástroje.                                              |
| MCP host            | `nomo recovery serve --config <soubor>` | Volajícím je jiný agent a chceš zachytávání před jeho nástroji.                                           |

TUI a GUI jsou stejný engine nad stejným pracovním prostorem. Schválení vyřešené v
jednom je vidět ve druhém. TUI má klávesy, které GUI nemá, a GUI má historii
dokumentů, kterou TUI nemá.

## 8. Terminálové rozhraní

`pnpm tui`, nebo `nomo tui`. Možnosti: `--once` vykreslí jeden statický snímek a
skončí (jednorázový výkres je vždy bez barev), `--view <karta>`, `--session <id>`,
`--data-dir <cesta>`, `--import-provider opencode:zen|opencode:tokenrouter`,
`--project <cesta>`, `--skill <id>` (opakovatelně) a `--help`.

`--project` otevře jeden operátorem schválený projekt: pracovní prostor ho
vidí přes `nomo_project_exec`, příkaz, který běží v jednorázovém kontejneru
bez sítě a s projektem připojeným na cestě /workspace, bez hostovského
prostředí a bez credentialů. Projektový nástroj je dostupný jen tehdy, když
ho explicitně povolí vlastní nakonfigurovaný profil, a jde o R3 hov, takže
jde běžnou cestou policy a schvalování. Chybějící runtime kontejneru nebo
chybějící připnutý image je odmítnutí, nikoli návrat na hosta. Dvě nastavení,
která potřebuje, jsou `NOMO_PROJECT_SANDBOX_RUNTIME` (docker nebo podman) a
`NOMO_PROJECT_SANDBOX_IMAGE` (lokální sha256 image ID, ne tag: tag se může
posunout pod nohama operátora). `--skill`
vybírá skills z `.agents/skills/` zvoleného projektu a z jeho
`skills-lock.json`; text skillu se vloží do session jako neměnný snapshot a
počítá se jako nedůvěryhodný obsah projektu, takže nemůže rozšířit nástroje
ani oprávnění. Operátor je předtím, než se jakákoliv projektová data dostanou
k modelu, informován, že soubory projektu, text vybraných skillů, argumenty
příkazů a výstup příkazů mohou být odeslány nakonfigurovanému modelu a
ponechány v místní historii session.

### 8.1 Jedenáct karet

`overview`, `chat`, `sessions`, `documents`, `ledger`, `approvals`, `policy`,
`tools`, `models`, `usage`, `help`.

`Tab`, `Shift+Tab`, `Left` a `Right` mezi nimi přecházejí a `/runs` je alias pro
`/overview`. Úzký terminál ukazuje okno tří karet kolem aktivní.

Každá karta má příkaz se stejným jménem a argument kteréhokoli z nich se stane
filtrem daného panelu. Tedy `/ledger postgres` filtruje panel ledgeru na záznamy
zmiňující postgres.

### 8.2 Příkazy

Navigace a session: `/new [prompt]`, `/clear`, `/quit`, `/exit`,
`/resume <číslo-konverzace-nebo-ID>`, `/open <číslo-konverzace-nebo-ID>`,
`/rename <titul>`, `/archive`, `/bottom`, `/find <text>`, `/stop`, `/cancel`,
`/branch [seq]`, `/retry [seq]`.

Kontext a stav: `/status`, `/context`, `/cost`, `/stats`, `/diff`, `/todos`,
`/memory`, `/history`, `/config`, `/sources`, `/queue [resume]`, `/compact`,
`/expand`, `/edit`, `/bottom`, `/theme <color|mono|motion|still|reset>`,
`/keybindings`, `/command-palette`.

Konfigurace prostoru: `/policy`, `/tools`, `/models`, `/permissions` (také `/mcp`),
`/policy-file <connector-ID> <cesta-k-YAML>`, `/connector-file <cesta.json>`,
`/test-connector <ID>`, `/hooks`, `/hook-file <cesta.json>`, `/projects`,
`/project <ID|none>`, `/project-file <cesta.json>`, `/agents`, `/agent <ID>`,
`/agent-file <cesta.json>`.

Poskytovatelé: `/providers`, `/model <přesné-ID>`, `/connect <source-ID>` (také
`/login`), `/logout`.

Schvalování a obnova: `/approvals`, `/approve [hold-ID] [důvod...]`, `/deny
[hold-ID] [důvod...]`, `/undo [operation-ID]`, `/rewind`, `/recovery [job-ID]`,
`/verify`, `/document <cesta>`, `/attest`, `/export <ledger|chat|document>`.

Nastavení a diagnostika: `/doctor`, `/init`, `/conformance`, `/harness
<cloud|prime-agent>`.

Samotný harness: `/harness scores` ukazuje, co harness změřil, `/harness
review` žádá o revizi ihned a `/harness approve <digest>` a `/harness reject
<digest> [důvod...]` rozhodují návrh. Návrh zůstává neúčinný, dokud není
pojmenován přesný jeho digest, a digest, který nikdo nenavrhl, je odmítnut
jménem.

Každý příkaz výše bere argument na stejném místě; spuštění bez argumentu vypíše
svoji vlastníusage řádek, než by selhalo nečitelně. Příkaz bez argumentu vůbec
nebo neznámý se odmítne jménem.

**Dvě odmítnutí jsou trvalá a záměrná.** `/vim`, `/terminal-setup` a
`/output-style` existují, aby operátor přicházející z jiného agent CLI dostal
jasnou odpověď místo ticha. NOMO nemá ekvivalent.

**Dokončování pokrývá většinu příkazů, ne všechny.** Pět patnáct zpracovatelných
příkazů je dosažitelných, ale `/` dokončování je nenabídne: `/open`, `/sources`,
`/filter`, `/document`, `/approve`, `/deny`, `/rename`, `/archive`,
`/policy-file`, `/connector-file`, `/test-connector`, `/command-palette` a ta tři
odmítnutí výše. `/help` vypisuje všechna kromě `/command-palette`.

**Fuzzy shoda je skutečná, ale úzká.** `/rs` dosáhne na `/resume` a `/conf` na
`/conformance`. Shoda je uspořádaná podsekvence nad jménem příkazu, takže dotaz,
který není podsekvencí jména, neshodne, a jména začínající tím, co jsi napsal,
sortují první.

### 8.3 Klávesy

Potvrzovací modál, kde se dějí rozhodnutí, na kterých záleží:

| Klávesa         | Účinek                                                |
| --------------- | ----------------------------------------------------- |
| `y`             | Přijmout.                                             |
| `n`             | Odmítnout. Nic se neaplikuje a hlášení to řekne.      |
| `Esc`           | Zrušit a vymazat kontrolu.                            |
| `1` až `9`      | Přepnout ten diff hunk, abys zkontroloval část změny. |
| `PgUp` / `PgDn` | Prolistovat kontrolu o deset řádků.                   |

Stavový řádek v kontrolách čte `[!] REVIEW / y accept / n reject / Esc cancel /
PgDn preview`.

Přepínání hunků zužuje, co si prohlížíš. Zatím to nezužuje, co server vykoná;
viz kapitola 18.

Navigace a panely: `i` nebo `/` pro psaní, `q` pro ukončení, `n` pro novou
konverzaci, `u` pro náhled Undo, `a` pro přípravu schválení, `d` pro přípravu
odmítnutí, `r` pro obnovení, `?` pro nápovědu, `Enter` pro otevření vybrané
řádky, `Esc` pro krok zpět, `{` a `}` pro skok mezi vlastními zprávami, `PgUp` a
`PgDn` pro posun, `Up`/`k` a `Down`/`j` pro pohyb výběrem, `Ctrl+End` pro sledování
živého konce, `Alt+P` skok na modely.

Běh a skládání: `Ctrl+C` zastaví běžící běh a jasně řekne, že už odeslaný nástroj
může ještě dokončit; s neprázdným konceptem vymaže koncept; na prázdném konceptu
ukončí. `Ctrl+D` ukončí až na **druhé stisknutí do 800 ms**; první stisknutí to
řekne. `Ctrl+L` překreslí a dvakrát do dvou sekund vyčistí konverzaci. `Ctrl+O`
přepíná kompaktní a plný výstup nástrojů. `Ctrl+R` hledá v historii promptů.
`Ctrl+S` odloží koncept a druhé stisknutí ho obnoví. `Ctrl+G` otevře `$EDITOR`.
`Ctrl+T` spustí `/todos`. `Ctrl+X` a pak `Ctrl+E` do 1,5 s také otevře editor.
`Shift+Tab` cykluje režim `normal` → `accept` → `plan`, s `Alt+M` jako zálohou pro
terminály, kde Shift+Tab nikdy nedospěje. `Ctrl+P` otevře paletu příkazů. Uvnitř
composera `Enter` pošle, `Shift+Enter` nebo `Alt+Enter` nebo `Ctrl+Enter` nebo
`Ctrl+J` vloží nový řádek, stejně jako `\` a pak `Enter` na konci, a `Alt+B`,
`Alt+F`, `Alt+D`, `Ctrl+W`, `Ctrl+K`, `Ctrl+U` a `Ctrl+Y` dělají slovní a řádkové
editování nad malou kružnicí v paměti. Nic z toho se nepersistuje kromě záložky
`Ctrl+S` pro aktuální session.

**Nic není konfigurovatelné.** Neexistuje keymap soubor ani proměnná prostředí pro
přemapování. Potvrzovací klávesy jsou fixní záměrně: bezpečnostní rozhodnutí
nemá být jedno překlep od překlepu.

### 8.4 Lepkivý pruh schválení

Čekající hold je připnutý nad tělem na **každé** kartě, v tomto tvaru:

```
[!] APPROVAL PENDING[R3] postgres.row.delete a1b2c3d4 | [a] approve [d] deny (/approvals)
```

Přípona `[R3]` se objeví pro nevratitelné třídy a `(+N more, /approvals)`, když
čeká víc než jedno volání. Pruh existuje, aby se hold nedal přehlídnout jen tím,
že jsi na jiné kartě.

### 8.5 Lokální shell

Napsání `!` a příkazu ho spustí jednou, lokálně, mimo agenta. `!echo hello`
funguje. Výstup se ukáže jednou a **nikdy se nezapíše do ledgeru**; hlavička
detAILu říká `LOCAL SHELL, not stored in the ledger`.

Příkaz se odmítne, ještě než se spustí, pokud zmiňuje cokoli, co vypadá jako
přihlašovací materiál: proměnnou, jejíž název obsahuje KEY, TOKEN, SECRET nebo
PASSWORD, slova api_key, authorization nebo bearer, `tokenharbor` nebo
`tokenrouter`, privátní klíč nebo `.pem`, nebo `.env`, `.nomo` či `keychain`.
Jakákoli rozpoznaná **hodnota** tajemství v prostředí se v výstupu nahradí
`[redacted]` bez ohledu.

Shell je tvůj vlastní: `sh -c` na macOS a Linuxu, `cmd.exe /d /s /c` na Windows, s
`PATH` zúženým na `/usr/bin:/bin` nebo `%SystemRoot%\System32` v obou případech.
Časový limit je 10 s a limit výstupu 64 KiB.

### 8.6 Co stavový řádek nevymyslí

Stavový řádek ukazuje model, režim, počet zpráv, tokeny a cenu. Několik z těchto
polí je čestně `unknown` místo čísla a toto rozlišení má význam:

| Pole     | Čte `unknown`, když            |
| -------- | ------------------------------ |
| `tokens` | provider nehlásil žádný součet |
| `cost`   | provider nehlásil žádnou cenu  |
| `ctx`    | session nemá měření kontextu   |
| `model`  | není připojeno nic             |

Ukazatel režimu **vždy** čte `mode: <m> (local only, not enforced)`. Režim TUI je
předpona k promptu. Tvaruje, o co se model žádá; není místem vynucení, a
rozhraní to řekne, místo aby to naznačovalo. Když je stavový řádek příliš úzký,
`cost` úplně zmizí a plné čísla jsou pod `/cost`.

`/compact` řekne `Token savings are unknown. No provider summarization is
promised.` a pak potvrdí, že přepis a ledger zůstaly zachovány.

## 9. Webová a desktopová aplikace

`pnpm gui` sestaví klienta a spustí lokální API server. Pro práci na frontendu
spusť `node apps/control-plane/api/server.ts` a `pnpm dev:web` ve dvou
terminalech.

Rozhraní je defaultně anglické a české, pokud si to zvolíš v Nastavení. Volba
jazyka přežívá jen v tomhle profilu prohlížeče.

### 9.1 Routy

| Routa          | Co obsahuje                                                                     |
| -------------- | ------------------------------------------------------------------------------- |
| `/chat`        | Konverzace. Výchozí routa i to, kam padá neznámá cesta.                         |
| `/overview`    | Čítače pracovního prostoru a aktivita.                                          |
| `/sessions`    | Konverzace, včetně archivovaných.                                               |
| `/runs`        | Běhy a aktivita.                                                                |
| `/documents`   | Spravované dokumenty, jejich historie a kontrola obnovy.                        |
| `/approvals`   | Schválení, na vrcholu riziková.                                                 |
| `/ledger`      | Podepsané záznamy a rozsah ověření.                                             |
| `/connections` | Nástroje a MCP konektory s katalogem nástrojů a schématy.                       |
| `/models`      | Modely a spotřeba.                                                              |
| `/settings`    | Pracovní prostor, poskytovatel, projekty, vlastní agenti, hooky, vzhled, jazyk. |

`/demo` je veřejná izolovaná d sandbox se čtyřmi nástroji spravovaných dokumentů a
bez přístupu k tvému pracovnímu prostoru. Žádná průvodcová prohlídka neexistuje;
úvítací pohled místo toho nabízí startovní akce.

### 9.2 Příkazy v composeru

Napiš `/` a otevře se menu. Shoduje se podřetězcem nad jménem a popisem, ne
fuzzy. Šipky posouvají, `Enter` nebo `Tab` volí, `Esc` zavře a zachová tvůj
koncept.

`/new`, `/plan`, `/review`, `/tools`, `/model`, `/context`, `/undo`,
`/approvals`, `/ledger` a dva podmíněné: `/export` se objeví jen když konverzace
existuje, `/stop` jen když běží. Vybraný řádek nástroje otevře parametrické
schéma a předvyplní prompt, který ho popisuje. Nástroj nespustí.

`Esc` v composeru, když běží běh a menu je zavřené, zastaví běh. `ArrowUp` na
prázdném konceptu načte tvou předchozí zprávu k úpravě. `Cmd` nebo `Ctrl+Enter`
pošle vždy. Prosté `Enter` pošle jen když máš **Desktop send behavior** nastavené
na `enter` **a** okno má aspoň 768 px; default je, že prosté `Enter` vloží nový
řádek, což je důvod, proč composer napoprvé vypadá, jako by tě ignoroval.

Na úrovni aplikace: `Cmd`/`Ctrl+K` otevře paletu příkazů, `Cmd`/`Ctrl+Shift+O`
začne novou konverzaci, `Esc` zavře jakoukoli šabku nebo dialog. Obojí je
potlačeno, když má fokus dialog, a když komponuje输入法 editor.

### 9.3 Režimy oprávnění a kdo je volí

Tři režimy: `plan`, `read-only`, `normal`. `plan` a `read-only` prefixují tvůj
prompt, aby se modelu řeklo popisovat místo jednání; `normal` žádný prefix
nepřidává.

**Volí server.** Přepínač v aplikaci se vykreslí nefunkční a říká `Server
controls this mode; it cannot be changed here.` Klient si nemůže oprávnění
udělit: koncový bod preferencí odmítne režim poslaný klientem a workbench testy
pokrývají zápisové volání, katalog nástrojů, vyrobená volání, obnovu a Undo a
větvení v každém režimu. Když server neodpoví, aplikace padne na `read-only` a
řekne to v pruhu.

Toto je důležitý rozdíl proti TUI: režim GUI je autoritativní, režim TUI je
předpona k promptu.

### 9.4 Schválení volání

Schránka se dotazuje každých pět sekund a nevratitelné a zmírnitelné volání řadí
nahoru. Každá karta dává prostým jazykem popsanou akci, třídu, blast radius,
pracovní prostor, místní čas vypršení a zdůvodnění z policy.

**Zkontrolovat a rozhodnout** otevře modál. Ukazuje fakta, zdůvodnění,
navrhovanou změnu jako skutečný diff, když server poslal předchozí obraz, a
výslovné prohlášení, když neposlal, plus rozbalovací prvek s redigovaným
celým záznamem. Klíče, které vypadají jako tajemství, jsou maskované dřív, než
se dostanou do DOM.

- **Schválit** a **Odmítnout** jsou jediné dvě akce.
- **Odmítnutí vyžaduje poznámku.** Prázdný důvod se odmítne na klientu hlášením
  `Denials require a short reason for the audit record.` Poznámka se ořízne na
  500 znaků a uloží se s rozhodnutím.
- **R3 a unknown potřebují druhé stisknutí.** První kliknutí jen nabije, nápověda
  řekne stisknout znovu do osmi sekund a nabíjení vyprší. To zpomaluje záměrnou
  ruku, autoritou zůstává server.
- **Pozdní nebo duplicitní rozhodnutí je konflikt, ne druhý zápis.** Server odpoví
  409 nebo 404 a modál řekne `This approval was already decided elsewhere or
expired. No second write was made`. O vypršení rozhoduje server.

### 9.5 Undo a obnova v aplikaci

**Jedna operace.** Dokumenty, pak **Historie dokumentu**. Hledej podle cesty nebo
ID operace, zvol **Zkontrolovat změnu** a modál ukáže diff před a po s čísly
řádků a serverův důvod operace. **Potvrdit Undo** je povolené jen když server
řekne, že změnu lze aplikovat; pošle ID operace zpět jako potvrzovací token.
Úspěšný text zní `Change reversed. Evidence remains preserved.` Selhání nabídne
**Obnovit náhled** a náhled se znovu načte ze serveru, místo aby se použil znovu.

**Několik operací.** Zaškrtni operace a stiskni **Náhled obnovy vybraných změn
(N)**. Dialog naplánuje úlohu, pak ukáže ID úlohy, digest plánu, každý krok s jeho
sekvencí a zdroji a všechny zbytkové nebo nejisté operace. Plán zůstává fixní,
dokud ho neobnovíš, a obnovení vygeneruje nové ID úlohy, takže obnovení je
skutečně nový plán. **Schválit a aplikovat tento plán** pošle digest plánu
spolu se schválením, takže se schválení nedá přesunout na jinou práci. **Zkontrolovat
stav úlohy** je jen pro čtení.

Výsledek pojmenuje stav: Obnoveno, Částečně obnoveno, Konflikt, Výsledek neznámý,
Pozastaveno, Chybí zdroj, Nebyla úspěšná, Kompenzováno nebo Blokováno konfliktem.
Konflikt ani neznámý výsledek se nikdy neopakuje automaticky a důkaz se nikdy
nemaže.

Ve composeru zůstává čitelný stavový žeton poslední úlohy obnovy. Hlásí stav a
nabízí jen obnovení. **Neposkytuje žádnou autoritu obnovy.**

### 9.6 Schválení návrhu harnesse

Harness navrhuje změnu toho, co se naučil, a návrh čeká na člověka. V aplikaci
návrhy otevřené konverzace čekají přímo v konverzaci, jeden řádek na návrh, a
**Zkontrolovat a rozhodnout** otevře návrh.

Modál ukazuje návrh, ne jeho souhrn: každou úpravu s její akcí, druhem, položkou,
které se dotýká, textem, který zapíše, důvodem, proč ji stojí za to, a
podepsanými záznamy, ze kterých vychází. Úprava promptu ukazuje dodatek, který
chce, protože právě ten by přidal ke stálým instrukcím. Digest, ke kterému se
rozhodnutí váže, je na obrazovce, protože rozhodnutí, které se dá přesunout na
jiný text, není rozhodnutím o tomto návrhu.

**Schválit** a **Zamítnout** jsou jediné dvě akce, zamítnutí vyžaduje důvod a
server zůstává autoritou: návrh, který už někdo rozhodl, přijde s vlastní
větou serveru a druhý zápis se nestane. Návrh, který byl vrácen zpět, ze
seznamu zmizí, protože harness čte stav, který vrácení obnovilo.

## 10. Příkazová řáda

Dvacet tři příkazů. `nomo --help` vypíše seznam; `nomo <příkaz>` bez argumentů
vypíše usage daného příkazu.

| Příkaz               | Co dělá                                                         |
| -------------------- | --------------------------------------------------------------- |
| `nomo tui`           | Terminálový pracovní prostor.                                   |
| `nomo watch`         | Celoobrazkový živý pohled na ledger.                            |
| `nomo run`           | MCP proxy: `nomo-proxy` před nástroji agenta.                   |
| `nomo classify`      | Klasifikovat volání nástrojů v transkriptu nebo jedno volání.        |
| `nomo feed`          | Vypsat záznamy ledgeru, volitelně sledovat.                     |
| `nomo verify`        | Ověřit řetězec a podpisy ledgeru.                               |
| `nomo attest`        | Zapsat podepsanou attestaci nad záznamy workspace.              |
| `nomo export`        | Zapsat svazek důkazů pro obnovu.                                |
| `nomo replay`        | Přehrát nebo nasucho pustit zaznamenanou inverzi.               |
| `nomo taint`         | Ukázat sousedství závislostí záznamu ledgeru.                   |
| `nomo metrics`       | Strojově čitelné čítače ledgeru a journalu.                     |
| `nomo policy`        | Vypsat, ukázat a ověřit packy a soubory policy.                 |
| `nomo approvals`     | Vypsat čekající holds.                                          |
| `nomo approve`       | Zapsat rozhodnutí proti holdu.                                  |
| `nomo recovery`      | Spravovaný vykonavatel: inspect, plan, apply, reconcile, serve. |
| `nomo agent`         | Spustit jeden agent turn neinteraktivně.                        |
| `nomo doctor`        | Nahlásit prostředí.                                             |
| `nomo config`        | Vypsat rozřešenou konfiguraci. Tajemství nikdy nevypíše.        |
| `nomo init`          | Vytvořit rozvržení pracovního prostoru.                         |
| `nomo ledger verify` | Ověřit adresář ledgeru.                                         |
| `nomo update`     | Posunout instalovaný strom na sledovanou větev, jen dopředu.         |
| `nomo state`      | Shrnutí nebo migrace trvalého stavu pracovního prostoru.             |
| `nomo harness`    | Seznam a rozhodnutí nad návrhy harnesse relace a model, na kterém jeho recenze běží. |

Tě s argumenty, přesně:

```sh
nomo classify --transcript <soubor> [--facts <soubor>]
nomo classify --tool <id> [--facts <soubor>] [--fact k=v] [--args <json>]
nomo feed --ledger <adresář> [--json] [--follow]
nomo verify --ledger <adresář> [--attestation <soubor>]
nomo attest --ledger <adresář> --workspace <id>
nomo taint --ledger <adresář> --seq <n> [--depth <n>] [--json]
nomo replay --ledger <cesta> --snapshot-dir <adresář> --seq <n> [--dry-run] [--key base64-spki]
nomo replay --list-connectors
nomo agent --model <id> [--prompt <text>]
nomo harness list --session <id>
nomo harness approve --session <id> <digest-or-prefix>
nomo harness reject --session <id> <digest-or-prefix> --reason <text>
nomo harness rollback --session <id> <digest-or-prefix>
nomo harness ratchet --session <id>
nomo harness entries --session <id>
nomo harness model [<model-id>|--clear]
nomo tui [--once] [--project <cesta>] [--skill <id> ...] [--view <karta>] [--session <id>] [--data-dir <cesta>]
nomo recovery conformance [--adapter filesystem.managed|git.managed|managed-documents|postgres-managed-conformance]
nomo recovery <install|migrate|health|inspect|execute|plan|plan-job|apply-job|status-job|doctor|apply|reconcile|reconcile-recovery|serve|collect> --config <soubor> [--input <soubor>] [--approve <digest>] [--surface file|reserved|both]
nomo recovery collect --config <soubor> [--retention-policy <soubor>] [--surface file|reserved|both] [--dry-run] [--operation <id>]
nomo recovery doctor --config <soubor>
nomo recovery retention --config <soubor> [--surface file|reserved|both] (--list | --pin <digest> [--kind <recovery|operator>] --as <id> | --mark-unpinned <digest> | --release <digest> --pins <ownerId>:<kind> --as <id>)
nomo recovery vault-capacity --config <soubor> --from <maxTotalBytes>:<maxArtifactBytes> --to <maxTotalBytes>:<maxArtifactBytes> --as <operatorId>
nomo policy list | show <jméno> | validate <soubor>
nomo approve <hold-id> --by <kdo> [--deny] [--reason <text>] [--dir <cesta>]
nomo approvals --dir <cesta> [--json]
nomo update [--check] [--force]
```

Poznámky, které ušetří čas:

- `nomo harness entries` vypíše každé vytěžené pravidlo jako text policy
  souboru. Pravidlo není v platnosti: text slouží k vložení do vlastního policy
  souboru, před koncové catch-all pravidlo, pokud s ním operátor souhlasí.
- `nomo config` vypíše rozřešené adresáře dat, ledgeru a schválení a zda je
  nastaven ověřovací klíč. Klíč nikdy nevypíše.
- `nomo verify` na ledgeru s prázdným adresářem selže prostým `ENOENT` se
  jménem cesty. To je stav prvního spuštění, ne chyba.
- `nomo classify --tool <id>` klasifikuje jedno volání místo transkriptu a
  skončí kódem 0, když registry rozhodlo, kódem 2, když nemohlo. Čti řádek
  `facts:` před řádkem `tone:`: bez deklarovaných fakt se evaluator dostane
  jen na terminální případ entry, takže `r3` je tady fail-closed postoj, ne
  měření tvého účtu. `--fact k=v` přepíší `--facts <soubor>` pro toto volání
  a hodnota je doslova ten text, se kterým registry porovnává.
- `nomo replay --dry-run` řekne, co by inverze udělala, bez toho, aby to provedla.
  Použij před každým skutečným přehráním.
- Každá `nomo recovery` akce, něco měnící, vyžaduje `--approve <digest>` z
  předchozího `plan`. Digest je to, co váže tvoje schválení na přesně tu práci.
- `nomo policy` bez argumentu vypíše dodávané packy: `strict`, `balanced`, `dev`.
- `nomo update` posune instalovaný strom, který bydlí v `~/.local/share/nomo-cli`
  a nastavuje se proměnnou `NOMO_HOME`. Jde jen o dopředný posun: strom s
  necommitnutými změnami odmítne a `--force` ho odmítne také, protože žádný
  přepínač není důvod smazat práci provozovatele. Místní commity zahodí jen tehdy,
  když to `--force` výslovně řekne, a i tehdy přes `git reset --keep`, takže se
  chyba zastaví na změněném souboru.
- `nomo update --check` nic nemění a vypíše čtyři fakta a pak jeden verdikt:
  `installed:`, `installed-commit:`, `tracked-branch:`, `target-commit:` a pak
  `up to date` nebo `update available`. Když aktualizace existuje, skončí kódem
  3, když je strom aktuální, kódem 0. Strom, který remote nedosáhne, skončí
  taky kódem 0 a vypíše `target-commit: unknown`, takže čti verdikt, ne kód.
- `nomo update` nemá přepínač kanálu. Není tu `--stable` ani `--canary`; cílem je
  to, na co ukazuje sledovaná větev instalovaného stromu.

## 11. Soubory policy

Soubor policy je YAML. Celá gramatika jsou pět match klíčů, jedno rozhodnutí na
pravidlo a první shoda vyhrává.

```yaml
version: 1
rules:
  - match:
      tool: postgres.table.drop
    decision: deny
    rationale: schema drops never recover from a rollback
  - match:
      class: r0
    decision: allow
    rationale: fully reversible calls go through, the ledger keeps the inverse
  - match:
      class: r1
      blast_radius: { lt: 100 }
    decision: allow
    rationale: a cheap inverse on fewer than a hundred things is below the line
  - match:
      class: [r2, r3]
    decision: hold
    seconds: 120
    notify: [cli, slack]
    rationale: the damage is visible or permanent, so a human looks first
  - match: {}
    decision: hold
    seconds: 300
    rationale: nothing matched, so the call waits for a person
```

**Pět match klíčů**: `class` (r0 až r3, nebo seznam), `tool` (přesné id nebo
jedna koncová divoká karta jako `postgres.row.*`), `connector`, `workspace` a
`blast_radius` s `lt`, `lte`, `gt` nebo `gte`. Klíče v jednom `match` se spojují
AND. Seznam v jednom klíči je OR.

**Tři rozhodnutí**: `allow`, `deny` a `hold` s `seconds` a `notify`.

Čtyři vlastnosti dělají formát rozšiřitelný bez rozbití tvého souboru:

1. `version: 1` je povinná. Neznámá verze je chyba načtení, nikdy odhad.
2. Neznámý klíč nebo neznámá hodnota kdekoli je hlasitá chyba načtení. Překlep jako
   `blast_radus` shodí načtení, místo aby tiše rozšířil úzké pravidlo na všechno
   té třídy.
3. Protože se klíče spojují AND, přidání šestého klíče později je aditivní a
   nemůže změnit význam existujícího souboru.
4. Každé pravidlo má stabilní `id` a ledger zapisuje shodnuté pravidlo spolu s
   digestem textu policy, takže audit umí říct, který soubor rozhodnutí vyrobil.

**Defaulty, a rozlišení dvou různých selhání:**

- **Žádné pravidlo neshodlo v platném souboru: hold.** Hold je jediné rozhodnutí,
  které je samo vratitelné, a notifikace jmenuje pravidlo, které ti chybí. Schema
  stejně vyžaduje koncové pravidlo catch-all, takže v dobře sestaveném souboru to
  nikdy nenastane.
- **Soubor chybí, nečitelný, neplatný, nebo neznámé verze: deny, nahlas.** To je
  rozbité nastavení, ne nesedlé volání, a ty dvě se nesmějí vyřešit stejně.

**Co formát neumí vyjádřit, abys to nehledal:** žádné pravidlo nesouvisejí dvě
volání. Není tu žádná sazba, žádný běžný součet, žádné časové okno a žádné
pravidlo o člověku za agentem mimo workspace.Nevratitelnostní rozpočty, což jsou
stavová pravidla přesně toho druhu, jsou samostatná práce.

`nomo policy validate <soubor>` ověří soubor bez instalace. Validuj dřív, než na
něj namíříš proxy, protože neplatný soubor zakáže vše.

## 12. Ledger

Ledger je jeden JSON objekt na řádek v jen připisovaném souboru, defaultně pod
`~/.nomo/ledger/<workspace>.jsonl`. `nomo feed` ho vypíše, `nomo verify` ho
zkontroluje a `/verify` v TUI udělá totéž s rozsahem na obrazovce.

**Ověř ho mimo síť.** `packages/verifier/verify-ledger.mjs` je
jednosouborový verifikátor bez závislostí, spustitelný bez instalace NOMO:

```sh
node packages/verifier/verify-ledger.mjs --selftest
```

Jeho self-test projde round trip, editované tělo, špatný klíč, integritu bez
klíče a zmanipulovanou attestaci. To je kontrola, kterou může třetí strana
spustit a rozhodnout se, jestli ti věří.

**Co ověření dokazuje.** Každý záznam je podepsán Ed25519 nad doménově
odděleným, verzovaným preimage, který váže algoritmus i id klíče, a hash každého
záznamu navazuje na předchozí. Ověření tedy dokazuje, že posloupnost není
přerušená, těla odpovídají svým digestům a podpisy udělal klíč, který je
podepsal. Nedokazuje, že nikdo s tím klíčem nenapsal něco nepravdivého, ani že
proces nebyl odvinut na dřívější head. Opečování klíče důvěřuj stejně jako
matematice.

**Vývojářský klíč je tak označený.** Když není nastaven žádný klíč, NOMO vygeneruje
jeden pod `~/.nomo/keys/`, nahlas řekne, že se používá vývojářský klíč, a id klíče
dostane předponu `dev-`. Verifikátor označí záznam podepsaný takovým klíčem jako
platný pod vývojářským klíčem, nikdy prostě jako platný. Na Windows se soubor
klíče zúží ACL; na POSIX se režimem 0600.

**Čtení pohledu na ověření.** Stránka ledgeru v GUI a `/verify` v TUI ukazují, co
se kontrolovalo, digest headu, id klíče a počet probraných záznamů. Cache je
svázaná na head, takže změna headu ověření zopakuje. Server při každém volání
ověří celý ledger, což je čestné a není rychlé; scoped úloha není dodaná.

**`/export` odmítne na neověřeném ledgeru** hlášením `Export refused: a ledger
has not been verified.` Nejdřív ověř.

## 13. Undo a obnova

**Retence a uvolňování místa.** Oba vaulty (starý adresářový a rezervovaný
SQLite) drží artefakty s důkazem o ochraně. `nomo recovery collect
--config <soubor>` je jediný sběrač: smaže jen to, co je odemčeno, staré
podle zvolené věkové politiky a má důkaz, že je tomu tak. Artefakt s
nepřečteným důkazem je chráněný, chybný důkaz odmítne celý běh, a zrušený
pin drží ochranu, dokud jej operátor neuvolní pojmenováním. `--dry-run`
vypíše předpověď a nic neudělá. `nomo recovery retention --config <soubor>`
zaznamenává operátorové přechody: `--pin` připne, `--mark-unpinned` označí
revidovaný stav, po kterém politika může sbírat, `--release` odstraní
konkrétní pin, když jej pojmenuješ přesně, a `--list` přečte důkaz obou
polovic. `nomo recovery health --config <soubor>` shrne totéž do jedné
sekce `retention` a je to brána: exit nula znamená zdravý stav, degradovaný,
nebezpečný a nedostupný stav odejdou s exit 1. Strop vaultu se posouvá jen
výslovným operátorovým přesunem `nomo recovery vault-capacity --config
<soubor> --from <celkem>:<artefakt> --to <celkem>:<artefakt> --as <id>`,
který tvrdí, v jakém stavu vault je, a uloží přesun spolu s jeho záznamem.

Obnova je **samostatná, potvrzená akce na plánu**, nikdy vedlejší efekt zápisu.
Toto oddělení je celý důvod, proč se drží předchozí obraz.

Tok je vždy stejný tvar:

1. **Plán.** `nomo recovery plan`, `/undo` nebo `/rewind` v TUI. Dostaneš digest,
   kroky v pořadí, zdroje, kterých se každý dotýká, a zbytky.
2. **Zkontroluj.** Přečti to. Drift nebo chybějící artefakt se ukážou tady.
3. **Schval.** Schválení váže digest plánu, takže se nedá přesunout na jinou práci.
4. **Aplikuj.** Každý krok proběhne stejnou cestou jedné operace.
5. **Reconcile, když je třeba.** Nejistý výsledek zůstane nejistý, dokud ho
   nevyřeší trvalý důkaz. Nikdy se sám neopakuje.

**Stavy, na které narazíš**: `restored`, `partial`, `conflict`, `unknown`,
`paused`, `missing`, `not-successful`, `compensated`, `blocked-by-conflict`.
`partial` znamená, že proběhla kompenzace, což není totéž jako přesná obnova, a
rozhraní řekne, který dostal.

**Pravidla, která runner neohne:**

- Znovu použití digestu plánu s jiným obsahem je odmítnuto.
- Lidská úprava mezi zachycením a Undo je konflikt. Novější hodnota zůstane.
- Přerušená inverze je `unknown` a další start ji neopakuje.
- Obnova zapíše nový podepsaný event navázaný na původní. **Nikdy nesmaže
  původní důkaz.**
- Opakování téže úlohy nemá druhý účinek. Restart po inverzi přečte potvrzení místo
  aby povolil další inverzi.
- Jedno Uno v workspace najednou a nové dopředné zápisy jsou blokované, dokud je
  úloha obnovy neterminální.

**Drift je odmítnutí, ne varování.** Po Undo `filesystem.managed` váže spravovaný
kořen na původní cestu a jeho inode a ctime revizi. Zkopíruj nebo přesuň ten
adresář a Undo vrátí `conflict` bez důkazu. Operace se tiše nepřepojí na novou
cestu.

**Kam se důkaz uloží.** U spravovaného adaptéru Postgresu je trvalý a místní.
Obnova znovu přečte řádky, které zapsala, odmítne, pokud nesouhlasí se zachycením
(`packages/connectors/src/postgres/managed.ts:1393`), a teprve pak zapíše záznam
do `${schema}.recoveries` ve tvé vlastní databázi
(`packages/connectors/src/postgres/managed.ts:1399`). Číst nemusíš s důvěrou v
NOMO: `docs/RECEIPT-VERIFY.sql` je čisté SQL nad tabulkami, které vlastníš, a
byl spuštěn proti zkazenému řádku, aby potvrdil, že vypíše `FAIL`
(`scripts/receipt-demo/README.md`).

**Co není pokryto.** Spravovaný Postgres, spravovaný filesystém a spravované Git
commity jsou adaptéry se skutečným zachycením. R08 a R09, spravované S3 a spravované
GitHub a Vercel adaptéry, zatím jako vykonatelné adaptéry neexistují. Staged holds
a cascading cancel, práce R11, nejsou implementované. Není tu plán napříč systémy
a není pokračování nezávislé větve: konflikt zastaví závislé kroky.

**Opakovaná výhrada, kterou stojí za to přečíst dvakrát.** Git obnova na Windows je
odmítnuta. `git.managed` je POSIX only a řekne to. Zachycení filesystému na
Windows pokrývá bajty a ne POSIX režim, protože Windows nemá režim k zachycení.

## 14. Hostování MCP serveru

`nomo recovery serve --config <soubor>` vystaví spravovaného vykonavatele jako
lokální stdio MCP server, kterého si agent může volat. Konfigurace jmenuje
workspace, stabilní `agentId`, stavový adresář, proměnnou prostředí s klíčem
šifrování a adaptéry k vystavení.

```json
{
  "workspace": "test",
  "agentId": "test-agent",
  "stateDir": "state",
  "encryptionKeyEnv": "NOMO_RECOVERY_KEY",
  "filesystem": { "root": "project", "cooperative": true }
}
```

**Implementováno je osm nástrojů.** `nomo_execute`, `nomo_recovery_plan`,
`nomo_recovery_apply`, `nomo_recovery_plan_job`, `nomo_recovery_status_job`,
`nomo_recovery_apply_job`, `nomo_reconcile`, `nomo_recovery_reconcile`.

**Host smí autorizovat méně.** Sestava Prime dogfood autorizuje pět:
`nomo_execute`, `nomo_recovery_plan`, `nomo_recovery_apply`, `nomo_reconcile`,
`nomo_recovery_reconcile`. Tři nástroje úloh jsou implementované a tam
neautorizované. Která sada je živá, je rozhodnutí hostitele, zaznamenané pro každé
nasazení.

**Hranice se vynucuje na straně serveru.** Agent si nesmí dodat vlastní
workspace, identitu adaptéru ani grant schválení. Volání nástroje, které je
přinese, je odmítnuto, a testy pokrývají přesně toto. Policy se znovu načítá
per požadavek, takže úprava souboru policy má účinek na další volání.

**Interaktivní schvalování na tomto transportu není implementováno.** Hold a deny
výkon odmítnou; v MCP session není žádný prompt. Schval z TUI, z GUI nebo
`nomo approve`.

**Digest plánu není autorita policy.** Digest říká, co by se udělalo. Oprávnění
pochází z policy a tam, kde policy říká hold, od člověka.

## 15. Desktopové aplikace

Desktopový shell je aplikace Tauri 2, která bundluje vlastní Node runtime,
ověřený při buildu proti připnutému oficiálnímu SHA-256 pro každý cíl. Koncový
uživatel nic neinstaluje.

```sh
pnpm desktop:setup   # nainstalovat izolovaný desktopový workspace
pnpm desktop         # vývojový build
pnpm desktop:build   # zabalená aplikace
pnpm desktop:test    # testy desktop runtime a releas metadat
```

**Cíle.** macOS arm64 a x64 a Windows x64 přes NSIS. **Linux není podporovaný**:
příprava runtime odmítne nepodporovaného hosta a shell se nespustí.

**Podepisování je čestné o svém stavu.** Lokální macOS build je defaultně
podepsaný ad-hoc. V tomto repozitáři není Developer ID podpis, notarizace ani
cesta do Mac App Store a balící politika store režim odmítne, místo aby vyrobila
artefakt, který nelze distribuovat. Windows instalátor je nepodepsaný a
SmartScreen bude varovat.

**Smoke testy jsou zabudované.** Zabalený binár přijímá `--smoke-test`,
`--smoke-mobile` a `--smoke-runtime-exit`. Ty spustí bundlovaný runtime, načtou
web view, zkontrolují vykreslení, vyzkouší download bajt po bajtu a skončí kódem,
podle kterého můžeš bránit.

**iOS doprovodka je jen pro čtení.** Páruje se s jedním explicitně spárovaným
Macem přes důvěryhodnou místní síť. Ovládání párování je v současném buildu
vypnuté a vykonavatelem je vždy Mac. Nic, co ukazuje, neimplikuje lokální
provedení.

## 16. Rozdíly mezi platformami

Toto jsou skutečné, současné věci, které stojí za to vědět, než nahlásíš chybu.

| Oblast                    | macOS a Linux       | Windows                                              |
| ------------------------- | ------------------- | ---------------------------------------------------- |
| Rozsah obnovy filesystému | bajty a POSIX režim | jen bajty; Windows nemá režim k zachycení            |
| Spravovaná Git obnova     | podporována         | odmítnuta, POSIX only                                |
| Lokální shell TUI         | `sh -c`             | `cmd.exe /d /s /c`                                   |
| Soukromí stavu schválení  | režim zúžen na 0700 | adresář zkontrolován, ACL děděno z profilu uživatele |
| Vývojářský podpisový klíč | režim 0600          | ACL zúženo na aktuálního uživatele                   |
| Konce řádků v repozitáři  | LF                  | LF, přes `.gitattributes`                            |

Dvě hrany specifické pro Windows, které říkáme, než schováme: `nomo recovery
conformance --adapter git.managed` tam hlásí `platform-refusal` selhání záměrně,
a detekce `/harness` v TUI dělí `PATH` jen na `:`, takže na Windows hlásí, že
nic nenašla.

## 17. Řešení problémů

**`pnpm install` selže na stroji bez POSIX shellu.** Opraveno v tomto repozitáři.
Když to uvidíš, tvůj checkout je starší než oprava; preinstall hook je teď Node
skript.

**`ERR_SQLITE_ERROR: unable to open database file`.** Stavový adresář není
zapisovatelný, nebo je cesta špatná. Spusť `nomo config` a zkontroluj hlášený
datový adresář, pak `nomo doctor`, který hlásí zapisovatelnost.

**`ERR_UNSUPPORTED_ESM_URL_SCHEME ... protocol 'd:'`.** Windows cesta se dostala
k importu. Opraveno v tomto repozitáři; když na to narazíš, běžíš starší build.

**`No local Chromium binary found`.** Brána rozvržení prohlížeče potřebuje
Chromium. Nastav `NOMO_QA_CHROMIUM` na cestu k jednomu. Bez něj brána hlásí
pojmenovaný skip a todo, místo aby tiše prošla.

**Ověření ledgeru hlásí integritu hashů bez kontroly podpisů.** Není nastaven
ověřovací klíč. `nomo config` ukáže `verify-key: unset`. Nastav
`NOMO_VERIFY_KEY`, nebo přijmi ověření jen integrity a řekni to.

**Každé volání je zakázáno a nevíš proč.** Přečti odmítnutí: jmenuje id pravidla,
třídu a to, co by schválení vyžadovalo. Pak spusť `nomo policy validate <soubor>`.
Nečitelná nebo neplatná policy záměrně nahlas zakáže vše.

**Hold se nikde neobjeví.** Volání bylo povoleno, ne drženo. Zkontroluj `/ledger`
pro rozhodnutí a jeho pravidlo a `nomo approvals` pro cokoliv, co čeká.

**TUI ukazuje `mode: plan (local only, not enforced)` a čekal jsi blokaci.**
Přečti kapitolu o režimech oprávnění. Režim TUI je předpona k promptu. Režim
GUI je ten vynucený.

**`Setup required` a nic nevyšle.** Nerozřeší se žádné přihlášení poskytovatele.
Viz kapitola 6. NOMO nepřepíná na jiného poskytovatele.

**`Export refused: a ledger has not been verified.`** Nejdřív spusť `nomo verify`
na stejném adresáři.

**Undo vrátí `conflict`.** Něco změnilo cíl po zachycení. To je funkční kontrola
driftu. Přečti konflikt místo opakování.

**GUI říká `Multi-operation recovery is not available on this host.`** Host
nereklámoval úlohy obnovy. Jedna operace Undo pořád funguje.

## 18. Než to namíříš na produkci

Kontrolní seznam v pořadí, které chytí nejvíc.

1. **Spusť `nomo doctor` a přečti každý řádek.** Nezapisovatelný adresář ledgeru
   je selhání, na kterém nejvíc záleží.
2. **Připoj poskytovatele a ověř, že odznak říká Ready.** Pracovní prostor, který
   nemůže vysílat, je bezpečný ale nepoužitelný a chceš vědět, který máš.
3. **Spusť `nomo init`, pak `nomo doctor` znovu.** Potvrď, že druhý běh nemá
   varování o adresáři ledgeru.
4. **Rozhodni, kdo vlastní režim oprávnění.** V GUI ho vlastní server. Ověř, co
   tvůj host vrací na `GET /api/capabilities`, protože aplikace padne na read-only,
   když server neodpoví.
5. **Napiš a ověř si vlastní policy.** Začni od `nomo policy show dev` a
   zpřesni ji. Validuj ji. Překlep v match klíči shodí načtení místo aby
   pravidlo rozšířil, ale jen jakmile ji validuješ.
6. **Potvrď, které zdroje jsou spravované.** Undo je skutečné jen pro soubory,
   které NOMO vlastní. Kooperativní adresář, který zapisuje i jiný program, dá na
   Undo konflikt, a to je správný výsledek.
7. **Dokáž ledger na stroji, který NOMO nespouští.** Vezmi `nomo export` svazek a
   spusť proti němu samostatný verifikátor jinde.
8. **Nacvič skutečný hold.** Spusť ze kořene repozitáře simulovaný moment příkazem
   `node scripts/src/moment.mjs`. Ukáže jeden zakázaný delete, jeden schválený
   delete a přesný text, který agent přečte po vyřešení holdu.
9. **Nacvič skutečné Undo. Napiš dokument, zastav, restartuj a vrať ho. Pokud to
   host neumí, tvé tvrzení o obnově není skutečné.
10. **Věď, co jsi necertifikoval.** Fyzická zařízení, zoom prohlížeče, odečítače
    obrazovky, notarizace, produkční KMS a odevzdání do store jsou všechno mimo
    to, co tento repozitář umí dokázat. [matice releasových důkazů](RELEASE-1.0.1-MATRIX.md) zaznamenává
    každou položku jako otevřenou nebo dosvědčenou, jednotlivě.
11. **Přijmi omezení per hunk.** Přepnutí hunku v kontrole zužuje, co kontroluješ.
    Server zatím nezužuje, co vykoná, takže částečná kontrola není částečné
    schválení. Dokud to nedojde, schval celé volání, nebo žádné.
12. **Rozhodni o přihlašovacích údajích vědomě.** Klíče v prostředí hostitele
    jsou pohodlné a čitelné tím procesem. Klíče uložené přes GUI jsou na serveru
    zašifrované. Ani jedno není hardwarová hranice.

## 19. Kam dál

| Téma                                                | Dokument                                                 |
| --------------------------------------------------- | -------------------------------------------------------- |
| Terminálový prostor česky, s úplným seznamem kláves | [Terminálový prostor česky, s úplným seznamem kláves](TUI-WORKSPACE.md)                                  |
| GUI příkazy a katalog nástrojů                      | [příkazy GUI a katalog nástrojů](GUI-COMMANDS.md)                                   |
| Provoz proxy, schválení a rozvržení ledgeru         | [provoz proxy, schválení a rozvržení ledgeru](OPERATIONS.md)                                     |
| Referenční gramatika policy                         | [referenční gramatika policy](POLICY-REFERENCE.md)                               |
| Co je certifikované a co ne                         | [vykonavatelný smluvní rámec obnovy a jeho meze](RECOVERY-CONTRACT.md), [co je certifikované a co ne](RECOVERY-COVERAGE.md) |
| Vykonavatelný smluvní rámec obnovy a jeho meze      | [vykonavatelný smluvní rámec obnovy a jeho meze](RECOVERY-CONTRACT.md)                              |
| Přidání konektoru                                   | [přidání konektoru](CONNECTOR-GUIDE.md)                                |
| SDK pro zabudování                                  | [SDK pro zabudování](SDK.md)                                            |
| Nasazení do cloudu                                  | [nasazení do cloudu](CLOUD-INTEGRATION.md)                              |
| Spravovaná obnova Postgresu                         | [spravovaná obnova Postgresu](MANAGED-RECOVERY.md)                               |
| Spravovaná obnova filesystému                       | [spravovaná obnova filesystému](MANAGED-FILESYSTEM.md)                             |
| Spravovaná obnova Gitu                              | [spravovaná obnova Gitu](MANAGED-GIT.md)                                    |
| Konformance adaptéru a co znamená certifikace       | [konformance adaptéru a co znamená certifikace](ADAPTER-CONFORMANCE.md)                            |
| Potvrzení obnovy a jeho kontrola bez NOMO             | [potvrzení obnovy ověřené bez NOMO](../scripts/receipt-demo/README.md), [SQL, které spustí třetí strana](RECEIPT-VERIFY.sql) |
| Rozhodnutí za návrhem                               | `docs/CONTEXT.md`, `docs/DECISIONS.md`                   |
| Standardy, které si tento repozitář drží            | [standardy](STANDARDS.md)                             |
| Matice releasových důkazů                           | [matice releasových důkazů](RELEASE-1.0.1-MATRIX.md)                           |
| Aktivní plán NOMO MVP a roadmapa                  | [plán implementace NOMO](superpowers/plans/2026-10-08-nomo-agent-identity-fleet-mvp-and-roadmap.md) |
| Specifika Windows desktopu                          | [specifika Windows desktopu](WINDOWS-DESKTOP.md)                                |
| Hranice beta                                        | [hranice beta](BETA.md)                                           |
| Jak se tento návod udržuje pravdivý                 | [jak se tento návod udržuje pravdivý](../scripts/src/handbook.test.mjs)                          |
