# Izolovaný projektový pracovní prostor: implementační plán

> **Pro implementátory:** REQUIRED SUB-SKILL: Použijte `superpowers:executing-plans` pro realizaci plánu. Každý behaviorální krok používá TDD: nejprve test, pozorovat očekávané selhání, potom minimální implementace a opakované ověření.

**Cíl:** Harness pracuje pouze s filtrovanou kopií projektu, agent může číst jen omezený status/diff a původní soubory se mění pouze po lokálním GUI schválení digestu jednoho souboru.

**Architektura:** `project-workspace.ts` vlastní bezpečné vytvoření a kontrolu pracovní kopie, manifest, diff, aplikaci a mazání. Workbench váže existující sandbox a omezený MCP nástroj na kopii. Control Plane vystaví oddělené lokální API `/api/project-workspace` a ne-TUI stránku, která zobrazí změny a vyžádá výslovné schválení.

**Tech stack:** TypeScript, Node.js built-ins, Git s pevnými argumenty, existující Workbench a Control Plane, React, `node:test`. Bez nových závislostí, bez skutečného provideru a bez živého Docker/Podman.

**Spec:** `docs/superpowers/specs/2026-10-24-nomo-project-workspace-boundary.md`

## Globální omezení

- Neupravovat ani nestagovat žádné `packages/cli/src/tui/**` ani TUI worktree.
- Zachovat předchozí uživatelské změny na `feat/wp-regress`; zejména provider úpravy v `packages/workbench/src/index.ts`, `apps/control-plane/api/server.ts`, UI Settings, README a CHANGELOG.
- Nepoužít credentials, externí provider, live container, instalaci závislostí, commit, push, merge ani branch switch.
- Původní projekt se čte jen při potvrzeném přístupu; sandbox mountuje pouze `source/` pracovní kopie.
- Vstupní Git příkazy jsou pevné a bez shellu. Vypněte systémový config, fsmonitor, untracked cache a credential helper, ale zachovejte user ignore pravidla pro `--exclude-standard`.
- Povinné filtry: `.git`, vnořené VCS, `.env*`, `.ssh`, `secrets`, `credentials`, známé klíčové/certifikátové přípony, ignorované soubory, build/cache adresáře a `packages/cli/src/tui/**`; case-insensitive; žádné symlinky, hardlinky ani soubory z jiného filesystem device.
- Limity kopírování: 100 000 souborů, 32 MiB na soubor, 1 GiB souhrnně; selhání je celé a bez aktivace částečné kopie.
- Data žijí v `LocalStorage.directory/project-workspaces/<sha256-hex>/`; `source/` je jediné místo mountované do kontejneru. Soukromé `control/baseline/` drží potvrzené původní bajty pro stabilní diff a přidává nejvýše 1 GiB; manifest a ownership marker jsou mimo mount.
- POSIX data adresáře `0700`, soubory `0600`; Windows odmítne kořen mimo `dataDir(homedir())`.
- Každý API endpoint projektu včetně čtení je explicitně lokální, i při nastaveném `NOMO_CONTROL_TOKEN`; mutace navíc používají stávající JSON/Origin/Fetch Metadata kontroly.
- Digest schvaluje jednu cestu a její přesné `add`/`update`/`delete`, původní hash a výsledný hash. Aplikace nikdy nesmí přepsat soubor, který od diffu změnil uživatel.
- Ledger obsahuje jen digesty, relativní cesty a výsledky, nikdy diff, obsah ani absolutní cestu projektu.
- Testy používají dočasné lokální Git repozitáře a fixture soubory. Žádný provider ani kontejner.
- Dodržet `docs/STANDARDS.md`: `node:test`, typované importy, explicitní `.ts` v interních Workbench importech, žádné em/en dash.

---

### Úkol 1: Filtrovaná pracovní kopie a manifest

**Soubory:**
- Vytvořit `packages/workbench/src/project-workspace.ts`.
- Vytvořit `packages/workbench/src/project-workspace.test.ts`.
- Neměnit `packages/cli/src/tui/**`.

**Rozhraní:**
- Exportovat limity `PROJECT_WORKSPACE_LIMITS` s hodnotami ze specifikace.
- Exportovat `createProjectWorkspace({ projectRoot, dataRoot })`, `listProjectWorkspaces(dataRoot)`, `projectWorkspaceStatus(workspace)`, `projectWorkspaceDiff(workspace, path, maxBytes?)`, `applyProjectWorkspaceChange(workspace, path, digest)` a `deleteProjectWorkspace(dataRoot, rootDigest)`.
- Návratový typ pracovní kopie obsahuje kanonický původní root, `rootDigest`, zobrazený basename, cestu `source`, cestu k řízeným metadatům a základní manifest. Nevrací absolutní root do API ani do ledgeru.
- Rozložení: `<dataRoot>/project-workspaces/<hex>/source`, `<dataRoot>/project-workspaces/<hex>/control/{owner.json,manifest.json,baseline/,backups/}`.
- Vlastník/manifest mají verzi, digest původního rootu, počty a cesty s hash/size/mode. Neobsahují obsah souborů; přesné výchozí bajty jsou ve privátním baseline, protože bez něj nejde spolehlivě zobrazit potvrzený diff po změně originálu.

- [x] Přidejte testovací Git fixture s tracked `src/main.ts`, untracked `notes.md`, ignorovaným `.env.local`, `.git/config`, `secrets/token`, `packages/cli/src/tui/workspace.ts`, symlinkem na soubor mimo root a adresáři `node_modules`.
- [x] Spusťte `node --test packages/workbench/src/project-workspace.test.ts`; očekávejte selhání importu chybějícího modulu.
- [x] Implementujte canonical root a Git root kontrolu přes `execFile`/`spawn` s pevnými argumenty `git rev-parse --show-toplevel`, `git ls-files --cached --others --exclude-standard -z`; root musí být přesně stejný jako zadaná kanonická cesta.
- [x] Nastavte izolované Git proměnné bez system configu a helperů, ale zachovejte user ignore pravidla pro `--exclude-standard`; vynucujte `GIT_TERMINAL_PROMPT=0`, `core.fsmonitor=false` a vypnutý untracked cache. Nespouštějte shell ani Git hook.
- [x] Implementujte jeden case-insensitive path filtr, normalizaci Git cest a kontrolu parent komponent. Na Windows odmítejte ADS/reserved device názvy. Před každým čtením odmítejte symlink, non-regular soubor, hardlink a jiný filesystem device.
- [x] Kopírujte do soukromého dočasného adresáře, nastavte módy, zapište manifest a ownership marker mimo `source/`, ověřte výsledek a atomicky přesuňte kompletní strom na cílový digest.
- [x] Pro existující platný workspace zachovejte obsah a původní manifest. Pro neplatný marker, nesoulad digestu nebo limit odmítněte operaci bez aktivace a bez smazání dosavadního workspace.
- [x] Doplňte testy přesných limitů 100 000/32 MiB/1 GiB, odmítnutí 100 001 Git položek, ne-Git kořenů a rodičů, case-insensitive filtrů, hardlinků, symlinků, datového kořene, atomic cleanup, bezpečné obnovy osiřelého zámku a zachování aktivního zámku.
- [x] Spusťte `node --test packages/workbench/src/project-workspace.test.ts`; očekávejte všechny fixture testy zelené. Ověřeno 12/12 testů; `pnpm --filter @void/workbench typecheck` také prošel.

### Úkol 2: Status/diff, bezpečná aplikace a Workbench napojení

**Soubory:**
- Upravit `packages/workbench/src/project-workspace.ts` a jeho test.
- Upravit `packages/workbench/src/index.ts`.
- Upravit `packages/workbench/src/workspace.ts` pouze pro klasifikaci read-only projektu.
- Upravit `packages/workbench/src/project-access.test.ts`, `project-sandbox.test.ts` a `tool-catalog.test.ts`.
- Před úpravou `index.ts` zachovat již přítomné změny provider identity a provider state.

**Rozhraní:**
- Přidat read-only `PROJECT_CHANGES_TOOL` s přesným union vstupem `{ operation: "status" } | { operation: "diff"; path: string }`; třídění `r0`.
- Workbench vystaví `projectWorkspaceStatus()`, `projectWorkspaceDiff(path)`, `applyProjectWorkspaceChange(path, digest)`, `revokeProjectAccess()` a `deleteProjectWorkspace(rootDigest)`.
- `confirmProjectAccess()` vytvoří/obnoví pracovní kopii a binduje `source/`; existující příkaz `nomo_project_exec` pak mountuje pouze tuto cestu.
- Změnový MCP nástroj se nabízí pouze projektu potvrzené relace, jejíž custom profil explicitně allowlistuje `nomo_project_changes`. Nesmí schvalovat ani aplikovat změnu.

- [x] Přidán test dočasného Git projektu; změna kopie prokazatelně nepřepisuje originál.
- [x] Testy pokrývají TUI/secret cestu, profily bez `nomo_project_changes`, změněný manifest, diff limit 32 768 bajtů, read-only dispatch, revokaci a restart.
- [x] Spuštěny Workbench fixture testy. RED-first nebylo u již implementovaného Workbench modulu provedeno; API routa byla nejprve ověřena jako 404 a následně jako funkční.
- [x] Status porovnává aktuální `source/` s potvrzeným manifestem; enumerace ignoruje symlinky a filtrované cesty, řadí relativní cesty a počítá hashe.
- [x] Per-file diff váže digest na root, cestu, operaci a oba hashe; změna obsahu zneplatní digest. Překročení výstupního limitu se odmítne bez zkrácení.
- [x] Apply znovu ověřuje root, ownership, cestu, symlinky, digest a originální hash; zálohu ověří před atomickou změnou. Konflikt neprovádí zápis, replay je idempotentní.
- [x] Příkaz, status, diff, apply, bind/revoke/delete sdílí serializační frontu; binding se zachytí před `await` a před použitím ověří.
- [x] Záloha je mimo mount, ověřena hashí proti původnímu obsahu a přetrvá selhání.
- [x] Revokace odebere in-memory binding; katalog vrací jen metadata a mazání vyžaduje ověřený digest/marker.
- [x] Start i spawn nabízí změnový nástroj jen při explicitním allowlistu a potvrzeném bindingu.
- [x] `nomo_project_exec` mountuje pouze `source/`; systémový kontext popisuje oddělený originál; limity, ledger digesty i R3 policy zachovány.
- [x] Explicitní dispatch, `availableTools`, start i spawn jsou profily a bindingem omezené.
- [x] `node --test packages/workbench/src/project-workspace.test.ts packages/workbench/src/project-access.test.ts packages/workbench/src/workspace.test.ts packages/workbench/src/tool-catalog.test.ts`: 31 passed, 1 skipped, 0 failed; `pnpm --filter @void/workbench typecheck` passed. Live container test skipped because runtime/image are not configured and live containers are prohibited.

Výsledek Task 2: Workbench izolace, read-only changes, apply a metadata API jsou hotové. Přímý sandbox bind mount nebyl spuštěn v live kontejneru záměrně; zdrojová trasa i testy bez runtime ověřují pouze `source/`.

### Úkol 3: Lokální Control Plane API

**Soubory:**
- Upravit `apps/control-plane/api/server.ts`.
- Upravit `apps/control-plane/api/server.test.ts`.
- Neměnit existující `/api/projects`, které spravuje katalog projektů.
- Zachovat současné necommitnuté Google Vertex změny v `server.ts` a testech.

**Rozhraní:**
- Použít přesné routy ze specifikace: `POST /api/project-workspace/access`, `GET /api/project-workspace`, `GET /api/project-workspace/diff?cursor=&limit=` nebo `?path=`, `POST /api/project-workspace/apply`, `DELETE /api/project-workspace` a `DELETE /api/project-workspace/workspace`.
- Odpovědi obsahují jen schémata specifikace; při neaktivním projektu katalog nevrací cesty ani obsah.
- Všechny metody na tomto prefixu explicitně vyžadují `isLocalRequest`, i když globální server přijímá `NOMO_CONTROL_TOKEN`.

- [x] API testy pokrývají metody a schémata, non-Git/relativní root, limit `413`, snapshot stránkování, diff cesty, chybějící/stale digest, revokaci a odstranění.
- [x] Testy s `NOMO_CONTROL_TOKEN` odmítají cross-origin volání všech šesti rout. Same-origin browser request lokálně funguje i s tokenem; mutace bez JSON jsou odmítnuty.
- [x] `node --test apps/control-plane/api/server.test.ts` nejprve reprodukoval chybějící `POST /access` odpovědí `404` místo `201`.
- [x] Přidána routa pod `/api/project-workspace`; `/api/projects` zůstává beze změny. Každá metoda/query/body/cesta/digest je přesně validována před Workbench voláním.
- [x] Ne-Git/chybné cesty vrací `400`, limity `413`, stale snapshot/digest `409`, nepovolený lokální původ `403`, nepodporované metody `405`; odpovědi neobsahují root ani stack.
- [x] `node --test apps/control-plane/api/server.test.ts`: 30 passed, 0 failed; zachované Vertex testy prošly. `pnpm --filter @void/workbench typecheck` a `pnpm exec tsc -p apps/control-plane/tsconfig.json --noEmit` prošly.

Výsledek Task 3: lokální API a explicitní ochrana i při `NOMO_CONTROL_TOKEN` jsou ověřeny; přímé `/api/projects` nebylo změněno.

### Úkol 4: Ne-TUI GUI pro přístup a revizi

**Soubory:**
- Vytvořit `apps/control-plane/ui/src/project-workspace.tsx`.
- Upravit `apps/control-plane/ui/src/main.tsx`, `apps/control-plane/ui/src/styles.css` a případné testovatelné čisté mapování UI stavu.
- Vytvořit `apps/control-plane/ui/src/project-workspace.test.ts` pro čisté mapování/validaci vstupů, pokud komponentní testovací infrastruktura není v projektu k dispozici.
- Nezasahovat do `apps/control-plane/ui/src/settings.tsx`; obsahuje cizí provider změny.

**Rozhraní:**
- Nová routa `/project-workspace` s položkou navigace, českým i anglickým textem, dostupným štítkem a viditelnými focus stavy.
- Formulář přijímá ručně zadanou absolutní cestu; před potvrzením vysvětluje filtrování a upozorní, že běžný zdrojový kód může obsahovat inline tajemství.
- Stránka zobrazuje neautorizovaný katalog bez cest, aktivní souhrn, stránkovaný seznam změn, jeden úplný diff, digest, výslovné potvrzení aplikace, konflikt a potvrzené mazání s varováním o ztrátě změn.

- [x] Přidejte čisté UI testy pro parsování stavů: `active=null`, potvrzený workspace, uložený workspace vyžadující opětovné potvrzení, `409` a chybové odpovědi. Testy ověřují obsah a přístupnost, ne pouhé předávání parametrů.
- [x] Spusťte příslušný UI test jako RED.
- [x] Přidejte lazy page import, `pageMap` a route v `main.tsx`, bez zásahu do `settings.tsx`.
- [x] Implementujte path confirmation, refresh a revoke přes existující `api()` a `useApi()`. Vstup nikdy neukládejte do `localStorage`, URL, logu ani analytics.
- [x] Implementujte stránkování po 50 souborech a `limit` 1..100, výběr přes `encodeURIComponent(path)`, úplné zobrazení diffu a zobrazený digest vedle tlačítka aplikace. Při načtení nového diffu zneplatněte předchozí potvrzovací stav.
- [x] Aplikaci vyžadujte přes samostatnou accessible confirmation. `409` zobrazte bez automatického retry a obnovte status. Mazání workspace vyžaduje potvrzení jeho digestu a zřetelné varování, pokud `hasChanges`.
- [x] Doplňte responsivní styl přes existující CSS proměnné; podporujte keyboard navigation, `aria-live` pro výsledky a `prefers-reduced-motion` bez nové závislosti.
- [x] Spusťte UI test, `pnpm --filter @void/control-plane-ui typecheck` a `pnpm run build:web`; build uspěl s existujícími Vite upozorněními na direktivy `use client` a chunk nad 500 kB.
Výsledek Task 4: UI testy 132/132, UI typecheck a web build uspěly. Browser smoke na `/project-workspace` ověřil formulář a secret warning, přesný digest a potvrzené apply pouze v dočasném `/tmp` fixture, stránkování po 50, stale-cursor `409`, dostupný dialog i zavření Escape s návratem fokusu. Při viewportu 390 px neměl dokument horizontální overflow; po reloadu nebyla původní fixture cesta v UI ani browser storage a konzole byla čistá.


### Úkol 5: Kontrakty, dokumentace a evidence

**Soubory:**
- Upravit `packages/workbench/README.md`.
- Upravit `docs/NOMO-AGENT-HARNESS-SPEC.md` pouze pokud je v rozporu se schváleným H19 kontraktem.
- Doplnit `CHANGELOG.md` bez přepsání existující Vertex/Workbench položky.
- Upravit `.nomo/harness-work-state.json` a Obsidian `NOMO Work Log.md` po ověřeném milníku.

- [x] Aktualizujte Workbench README: jak připojit Git project, které zdroje se filtrují, že agent profil musí explicitně povolit oba projektové nástroje a jak v Control Plane zkontrolovat/apply po jednom souboru.
- [x] Dokumentujte lokální API, omezení `NOMO_CONTROL_TOKEN`, restart/reconfirm, inline secrets a fakt, že commit/push/merge neprobíhá.
- [x] Zkontrolujte `docs/NOMO-AGENT-HARNESS-SPEC.md`; H19 odděluje novou ne-TUI Control Plane cestu od historického CLI/TUI popisu. Nesouvisející závazky zůstaly zachované.
- [x] Přidejte jednu uživatelskou Unreleased položku do `CHANGELOG.md`.
- [x] Cílené Workbench/API testy: 52 passed, 1 skipped, 0 failed. UI testy: 132 passed. `pnpm run typecheck` prošel.
- [x] `pnpm run build:web` prošel s existujícími Vite upozorněními. `pnpm test` bylo spuštěno: 3 239 testů, 3 testovací skupiny selhaly a 2 skupiny byly UNRUN; podrobnosti níže. Po opravě H19 CSS rozpočtový test prošel 7/7.
- [x] Browser smoke na `/project-workspace` ověřil český formulář, varování před inline secrets, digest apply a konflikt ve výhradně dočasné fixture. Finální reload po CSS změně: viewport/dokument/body 390 px, bez overflow, cesta nebyla v textu ani browser storage, konzole a page errors prázdné.
- [x] Nezávislá read-only security review našla možný TOCTOU při souběžné změně rodiče původního projektu (`project-workspace.ts:458-483`). Workbench serializuje project exec/status/diff/apply v jedné frontě a sandbox container odstraní před uvolněním; agent v sandboxu tedy nemá souběžný přístup k originálu. Závod vyžaduje jiný host process, který už má práva stejného uživatelského účtu, a zůstává mimo hranici proti agentovi. Node v24 `fsPromises.open` je path-based; v dokumentaci jsme nenašli přenosnou directory-relative mutaci. Nebyl přidán nativní modul ani testovací hook. Zdroj: https://nodejs.org/docs/latest-v24.x/api/fs.html.
- [x] Závěrečný diff a pracovní strom zkontrolovány. H19 nezasahuje do TUI; čtyři existující TUI změny zůstaly nedotčené. Mimo H19 se měnily pouze typografické oddělovače ve čtyřech Harness souborech bez změny významu.
- [x] Příkazy a výsledky jsou v H19 grafu a Obsidian work logu. H19 zatím není označeno jako dokončené.

#### Výsledek závěrečného ověření

První `pnpm test` vykázal 3 239 testů, 3 selhané skupiny a 2 UNRUN. `packages/cli` mělo 522 passed a jednu selhanou TUI fixture: potvrzení projektu volalo nový povinný Git-root kontrakt s ne-Git dočasným adresářem. `scripts` mělo dvě selhání: CSS budget a zákaz dashů; následné cílené testy prošly: CSS budget 7/7 a `node --test scripts/src/no-dash.test.mjs` 1/1 po typografických opravách ve čtyřech Harness souborech mimo TUI. `pnpm --filter @void/control-plane-ui typecheck` prošel a UI testy 132/132. Plný `pnpm test` po opravách nebyl spuštěn znovu. `script/tui-pty` také selhalo; TUI zůstalo nedotčeno. `python/appwrite-mcp` zůstalo UNRUN kvůli chybějícímu SDK a `script/desktop-rust` kvůli chybějícímu Cargo/připraveným ikonám.

H19 zůstává blokované, protože úplná sada není zelená a odstranění TUI fixture selhání by porušilo výslovný zákaz zásahu do TUI. Cílené Workbench/API/UI testy, typecheck, web build a browser smoke prošly. Review TOCTOU neukázala cestu souběžného zápisu z sandboxu; zbytkové riziko host procesu je mimo deklarovaný lokální trust boundary.

## Hranice dokončení

H19 se označí `done` až po úplném filtrování, bezpečném odlišení originálu a kopie, autorizovaném modelovém status/diff, lokálním exact-digest apply, route/UI smoke, cílených testech, typecheck, build, review a uložené evidenci. Nepodařené platformní nebo clean-install ověření zůstává odděleným explicitním blokátorem, ne domnělým úspěchem.