# NOMO izolovaný projektový pracovní prostor

## Stav

Návrh schválen uživatelem 2026-10-24. Uživatel schválil filtrovanou kopii bez `.git`, citlivých/ignorovaných souborů a TUI; read-only stav/diff; aplikaci pouze po výslovném schválení přesného hashe; ne-TUI Control Plane rozhraní s ručně zadanou absolutní cestou. Rozhraní používá `/api/project-workspace`, protože `/api/projects` už spravuje katalog projektů.

## Problém a cíl

`nomo_project_exec` dnes bind-mountuje původní projektový adresář do kontejneru read/write. Agent tak může přes libovolný shellový příkaz číst soubory, které nemají být v modelovém kontextu, a zapisuje rovnou do původního pracovního stromu. Cílem je zachovat použitelný coding workflow, ale modelu a kontejneru zpřístupnit jen filtrovanou kopii a nikdy automaticky neměnit původní strom.

## Rozhodnutí

1. Operátor zadá absolutní cestu projektu v ne-TUI Control Plane GUI a výslovně potvrdí přístup. Kořen musí být samostatný kořen Git working tree; bez dostupného Git nebo pokud `git rev-parse --show-toplevel` nevrátí zadaný kořen se přístup odmítne.
2. Workbench vytvoří pracovní kopii v existujícím datovém kořeni Workbench `project-workspaces/<rootDigest>`. Kořen použije stejnou prioritu jako `LocalStorage`: `NOMO_DATA_DIR`, jinak `NOMO_LEDGER_DIR/workbench`, jinak výchozí `dataDir(homedir())/workbench`. POSIX adresáře/soubory mají `0700`/`0600`; na Windows musí kořen ležet pod AppData aktuálního uživatele (`dataDir(homedir())`), jinak se přístup odmítne. Přesný filtrovaný obsah při potvrzení se uchová i v soukromém `control/baseline/`, aby diff zůstal ukotvený v potvrzeném stavu i po změně originálu; představuje až 1 GiB dodatečného obsahu. `source/` je jediný mountovaný adresář. Původní projekt je pro agenta a sandbox pouze ke čtení; zapisuje do něj výhradně explicitní lokální apply route.
3. Vstupní soubory se enumerují pevnými argumenty `git ls-files --cached --others --exclude-standard -z`. Systémový Git config, fsmonitor, untracked cache a credential helper jsou vypnuté; uživatelská Git ignore pravidla zůstávají respektována. Příkaz nepoužívá shell ani Git hook. Kopie obsahuje jen běžné povolené soubory, ne symlinky. Cesty se před čtením znovu ověří vůči kanonickému kořeni. Na Windows se odmítnou ADS a rezervované device názvy. Soubory na jiném filesystem device nebo s `nlink > 1` se odmítnou, protože mohou zpřístupnit obsah mimo projekt.
4. Filtr vždy vynechá `.git`, vnořená VCS metadata, `.env*`, `.ssh`, adresáře `secrets`/`credentials`, soubory `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `*.token`, `*.secret`, `id_rsa*`, `id_ed25519*`, ignorované soubory a build/cache adresáře `node_modules`, `.next`, `dist`, `build`, `target`, `.cache`, `coverage` i `packages/cli/src/tui/**`. Kontrola cest je case-insensitive. Limit je 100 000 souborů, 32 MiB na soubor a 1 GiB souhrnného obsahu; překročení odmítne celou přípravu bez částečně použitelné kopie.
5. V kontejneru se mountuje pouze tato pracovní kopie do `/workspace`; původní `.git`, hostitelský filesystem a síť zůstávají nedostupné. Příkazy jsou serializované a nadále dodržují existující časové, paměťové a výstupní limity.
6. Agent má omezený MCP nástroj `nomo_project_changes`: `{ operation: "status" }` vrací počty a omezený seznam změněných relativních cest; `{ operation: "diff", path: string }` vrací diff jedné filtrované cesty. Žádný libovolný Git příkaz ani přístup k původnímu `.git`. Stav porovnává kopii s potvrzeným manifestem, ne s předchozími uživatelskými změnami původního repozitáře. Výstup filtruje stejné citlivé cesty a TUI a respektuje existující výstupní limit projektového exec.
7. Control Plane stránkuje seznam změněných cest po 50 položkách a zobrazuje diff vždy pro jeden soubor. Digest jednoho souboru pokrývá root digest, relativní cestu, akci add/update/delete, původní hash a výsledný hash/obsah. Změna kopie po zobrazení diffu vytvoří nový digest a zneplatní staré schválení.
8. Aplikace změn do původního projektu je pouze uživatelská akce v GUI, která odešle přesný digest a cestu jednoho zobrazeného souboru. Workbench před zápisem znovu ověří digest, kanonický root, cestu, zákaz symlinků/TUI/citlivých cest a to, že původní obsah stále odpovídá výchozímu hashi. Konflikt vrátí `409` bez přepsání. Jeden soubor se zapíše atomickým nahrazením po vytvoření a ověření zálohy; žádná multi-file transaction není tvrzena. Žádné automatické commit, push, merge ani branch switch.
9. Neschválené změny pracovní kopie přežijí restart. Přístup k nim se po restartu znovu potvrzuje; API smí bez aktivního potvrzení vrátit jen katalog workspace s digestem, zobrazovaným názvem, souhrnnými počty a příznakem změn, nikdy cesty, diff ani obsah. Kopii lze smazat jen přes výslovnou uživatelskou akci; automatický cleanup nesmí odstranit uživatelskou práci.
10. Ledger ukládá digest, seznam povolených relativních cest a výsledek operace; neukládá diff ani obsah souborů.

## Nezměněné hranice

- Žádné změny v `packages/cli/src/tui/**` ani v TUI worktrees.
- Žádné skutečné provider requesty, OAuth, čtení credentials, instalace závislostí, live Docker/Podman, commit/push/merge ani release.
- Filtrování názvů souborů není obecný detektor tajemství. Uživatelské rozhraní musí před potvrzením uvést, že citlivé údaje vložené do běžných zdrojových souborů mohou být modelem přečteny.
- Projektová izolace chrání model a kontejner, ne jiný proces na hostiteli pod stejným uživatelským účtem. Apply ověřuje názvy cest; přenosná implementace nemůže vyloučit souběžnou změnu rodičovského adresáře týmž účtem. Takový proces má stejné hostitelské filesystem oprávnění jako operátor. Node `fsPromises.open` přijímá cestu; přenosné directory-relative mutace přes otevřený adresářový handle jsme neidentifikovali. Tento lokální host-process závod není sandboxová izolace ani ochrana proti stejnému uživateli.

## Rozhraní

- `POST /api/project-workspace/access`: `{ path: string }`; odpoví `201 { project: { rootDigest, displayName }, workspace: { fileCount, totalBytes } }`. Chybný/ne-Git kořen je `400`, limit kopie `413`.
- `GET /api/project-workspace`: `{ project: null | { rootDigest, displayName }, workspace: null | { fileCount, totalBytes, changes: { added, modified, deleted } }, savedWorkspaces: [{ rootDigest, displayName, fileCount, totalBytes, hasChanges, requiresConfirmation }] }`; nikdy nevrací obsah ani cesty bez aktivního potvrzení.
- `GET /api/project-workspace/diff?cursor=<opaque>&limit=50`: vrací `{ snapshotDigest, files: [{ path, operation, beforeHash, afterHash, digest }], nextCursor }`; `limit` je 1 až 100.
- `GET /api/project-workspace/diff?path=<relative>`: vrací `{ digest, file: { path, operation, beforeHash, afterHash, digest, diff } }` pro jedinou filtrovanou cestu.
- `POST /api/project-workspace/apply`: `{ path: string, digest: string }`; aplikuje pouze právě zobrazený a schválený soubor; stale base nebo digest vrátí `409`.
- `DELETE /api/project-workspace`: zruší přístup; nesmaže pracovní kopii.
- `DELETE /api/project-workspace/workspace`: `{ rootDigest: string }`; smaže jen kopii po samostatném potvrzení a ověření ownership markeru pod existujícím Workbench datovým kořenem; při změnách musí GUI výslovně varovat před ztrátou.

API mutace projektu jsou výhradně lokální: vždy vyžadují existující `isLocalRequest` kontrolu i tehdy, když je pro jiné Control Plane routes povolen vzdálený token. Nepřebírají vzdálenou autoritu přes `NOMO_CONTROL_TOKEN`. Mutace chrání stejný content-type/Origin/Fetch Metadata základ jako ostatní rozhodovací endpointy. Model dostává pouze read-only MCP nástroj; nikdy nedostane route ani schopnost schválit či aplikovat patch.

## Ověření a akceptace

- RED/GREEN fixture test pro vytvoření kopie z dočasného Git repozitáře: povolené zdrojové soubory jsou dostupné, `.git`, ignorované soubory, známé secret cesty, symlinky, hardlinky, jiný filesystem device a TUI se nikdy neobjeví v kopii ani výstupu nástroje.
- Limity souboru/souhrnné velikosti a ne-Git kořen odmítnou přípravu bez částečné aktivace.
- Sandbox připojuje pouze pracovní kopii; úprava kopie nemění originál.
- `status`/`diff` vrací pouze změny proti manifestu a nikdy libovolný Git výstup.
- Nesprávný nebo zastaralý digest, změněný originál, symlink, TUI cesta a cesta mimo kořen odmítnou aplikaci bez zápisu.
- Schválený hash aplikuje přesně přezkoumanou změnu jednoho souboru; opakování stejného hashe je bezpečně identifikováno a nezpůsobí další změnu.
- API testy pokrývají metody, schéma, lokální auth/CSRF a konflikty; UI smoke ověřuje path entry, zobrazení diffu, přístupné potvrzení hashe a bezpečný konflikt.
- Veškeré testy používají dočasné lokální fixtures. Žádný live container ani skutečný provider.

## Schválené limity

Uživatel schválil povinný Git root a limity 100 000 souborů, 32 MiB na soubor a 1 GiB celkem. Překročení libovolného limitu odmítne přípravu bez aktivace částečné kopie.
