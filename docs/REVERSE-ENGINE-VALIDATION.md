# NOMO reverse engine: ověření jádra a skutečné hranice

Datum: 2026-09-11. Rozsah: ledger, policy, registry, proxy, connectors, CLI replay, SDK a managed document engine. Tento audit nehodnotí GUI ani TUI. Všechny změny a testy běžely s izolovanými dočasnými daty. Nebyla provedena produkční destruktivní operace ani deployment.

## Výsledek

**404 testů jádra prošlo, 0 selhání, 0 přeskočených testů.** Prošel také typecheck všech balíčků, pět scénářů `e2e-connectors` a osm scénářů `e2e-final`.

NOMO dnes poskytuje integrované Undo pro vlastní spravované textové dokumenty a samostatné konektorové inverse pro omezené operace PostgreSQL a kompenzační obnovu S3. **Není to univerzální Ctrl+Z pro libovolný nástroj nebo vedlejší efekt agenta.** Klasifikace R1 ani schválení operace samy nevytvoří předchozí stav.

Nové testy odhalily a opravy odstranily ztrátu souběžných zápisů manifestu, nefunkční lokální namespace konektorového capture, důvěru v modifikovatelný inverse plán, provádění PostgreSQL inverse bez transakce, souběžné použití jedné transakční connection, vrácení nedostupného nadlimitního snapshotu a nedostatečné autentizování CLI replay.

## Co bylo spuštěno

```sh
node scripts/src/check-reverse-engine.mjs
pnpm -r --filter './packages/**' --if-present typecheck
node scripts/src/e2e-connectors.mjs
node scripts/src/e2e-final.mjs all
```

Runner spouští balíčky v jejich vlastním pracovním adresáři, protože fixture cesty SDK závisejí na package cwd. Nezahrnuje soubory GUI, adresář TUI ani provider test suites. Stávající workbench scénáře používají deterministické modelové odpovědi; nejde o ověření skutečného vzdáleného modelu.

| Balíček | Prošlo | Co pokrývá |
|---|---:|---|
| ledger | 49 | Řetěz, podpisy, změny obsahu/workspace, attestation, pořadí a integrita |
| policy | 75 | Allow/hold/deny, expirace, souběžná rozhodnutí, persistence, fail-closed |
| registry | 38 | Klasifikace, facts, neznámé operace, podmínky reversibility |
| proxy | 80 | Forward, deny, approval, chyby dependency, HTTP/stdio, transport a bezpečnost |
| connectors | 67 | SQL capture/inverse, cascade, S3, snapshoty, drift, race, rollback a tampering |
| cli | 69 | Replay, key verification, manifest binding, chyby adapterů a další core příkazy |
| sdk | 9 | Skutečný proxy subprocess, forward a schvalování |
| workbench | 17 | Managed dokumenty, inverse, signed evidence, restart, konflikty a storage |

PGlite spouští skutečný PostgreSQL engine v procesu. Testuje SQL, constrainty, transakční rollback a cascade obnovu; není důkazem chování vzdáleného PostgreSQL clusteru při síťovém výpadku. S3 používá explicitní fake klienty s modelovanými ETag a podmíněnými zápisy. Nebyl proveden reálný restore do AWS účtu.

## Reálné cesty provedení

### Proxy a SDK

`tools/call` projde klasifikací a policy. Rozhodnutí a jeho vyřešení se zapíší do ledgeru před forwardem. Chyba zápisu ledgeru v testovaném interceptoru vrací deny. Hold čeká na rozhodnutí nebo expiraci. Proxy/SDK pak zprostředkuje externí volání.

Proxy nadále automaticky nevolá PostgreSQL/S3 `connector.capture()`. Nový volitelný host binding ale pro přesně pojmenovaný tool propojí capture, translated request ID, dispatch a terminal outcome. Capture failure blokuje upstream. JSON-RPC error je `failed`; ztracená odpověď nebo close po dispatch je `unknown` bez retry. Observe posture recovery binding nepoužívá.

Conformance fixture ověřuje `postgres.row.update` přes skutečný `runProxy`, PGlite connector capture, podepsaný JSONL outcome, restart connectoru a Undo. Podepsané `allow:resolved` bez této binding evidence zůstává jen oprávněním pokračovat.

#### Složený composition root (R02)

`packages/proxy/src/legacy-root.ts` je produkční místo, kde se evidence kontraktu skládá do funkčního bindingu. Dřívější stav měl kontrakt i jednu fixture, ale žádné produkční místo, kde by operátor binding vybral; fixture skládala `LegacyProxyBinding` ručně. To je právě dva paralelní mechanismy.

Root je dosažitelný z běžné cesty: `packages/proxy/src/index.ts` ho re-exportuje, takže host získá resolver přes `@nomo/proxy` a předá ho do `runProxy({ legacyBinding })`. Není potřeba psát vlastní `LegacyProxyBinding`.

| Vlastnost | Chování |
|---|---|
| Výběr bindingu | Explictní jméno z `LEGACY_BINDING_NAMES`; neznámé jméno vyhodí `UnknownLegacyBindingError` při sestavení, ne hádí a ne vrací fallback |
| Jeden přístupový bod | `legacyBindingRoot(name, deps)` je jediný export, který vrací binding; produkční cesta i conformance fixture jdou přes něj |
| Překlad argumentů | `InterceptedCall.args` se jednou přeloží na `arguments` pro connector; proxy nezná tvar connectoru a connector nezná tvarinterceptu |
| Durabilita | Manifest zápis proběhne před forwardem; selhání zápisu odmítne capture a upstream je volán nula-krát |
| Workspace | Call s jiným workspace než nakonfigurovaným je odmítnut před capture, aby snapshot a podepsaný záznam neskončily v různých namespaces |
| Terminální stav | Doložený efekt je `completed`; nedoložený výsledek je `unknown`; JSON-RPC error je `failed`; ztracená odpověď je `unknown` bez retry |

#### Co složený root váže, a co ne

Zjištění, které určuje hranici: `forward/legacy-binding.ts` nepřekládá **žádný** tool. Je to tool-agnostický evidence kontrakt. Co je přeložitelné, určuje množina konektorů, které v repu mají capture i inverse, a ta je uzavřená na tři jména:

| Tool | Konektor | Conformance fixture |
|---|---|---|
| `postgres.row.update` | postgres, capture podle PK schématu, inverse přes `update` | PGlite, reálný `runProxy`, restart, Undo, drift |
| `postgres.row.delete` | postgres, capture včetně ON DELETE CASCADE, inverse přes `insert` | PGlite s cascade, restart, obnovení řádů dítěte i rodiče |
| `aws.s3.object.delete` | s3, capture bytů a ETagu, inverse přes `putObject` | fake S3 client, reálný `runProxy`, restart, obnovení bytů |

Každé jméno má vlastní cross-layer fixture, která projde skutečným `runProxy` lifecycle, skutečným connector capture, podepsaným terminálním outcome a restart Undo. Test `every advertised tool has a real conformance fixture` failuje, pokud se do `LEGACY_BINDING_NAMES` přidá jméno bez fixture, takže podporovaná množina nemůže inzerovat neověřenou obnovu.

Co **ne**bylo ověřeno a co root **ne**pokrývá:

- `aws.s3.object.put` a `aws.s3.bucket.delete` záměrně nejsou bindovatelné. Put přepíše bajty, které root nikdy nečetl, takže neexistuje before image k obrácení. Nejde o vynechanou implementaci, ale o chybějící předpoklad obnovy.
- S3 fixture používá fake klient s modelovanými ETagy. Není to AWS emulátor: nejsou ověřeny bucket policy, ACL, tagy, metadata, retention, historie verzí ani `If-Match`/`If-None-Match` konflikty proti skutečné S3. Konektor sám navíc přiznává, že jde o kompenzaci vytvořením objektu, ne o obnovení historie.
- PostgreSQL fixture běží na PGlite, ne na sítěovém clusteru. Síťový výpadek, neurčitý výsledek COMMIT a cross-host transakční hranice mezi capture a forwardem nejsou prokázány. Ta hranice zůstává na hostiteli.
- `nomo-proxy` bin a `sdk` klient **nepředávají** `legacyBinding` do `runProxy`. Root je veřejný export `@nomo/proxy`, ale žádný z těchto dvou produkčních vstupů ho zatím nepoužívá. K compositu je připraven, zapojen není.
- Root neřeší více závislých služeb, distribuovanou transakci ani rollback grafu. Jeden binding je jedna capture evidence pro jeden nástroj.

Jde o ověření konkrétní matice scénářů, nikoli o certifikaci. Žádné prohlášení shody s externí službou z tohoto oddílu neplyne.

### Managed textové dokumenty

Workbench používá vlastní omezený namespace dokumentů. Write/delete uchovají before/after a ID operace. Dokumenty, inverse a signed evidence se lokálně ukládají do jednoho atomického šifrovaného snapshotu. Undo ověřuje podpisovou vazbu capture a vyžaduje aktuální přípustný stav dokumentu. Novější změna, včetně ABA změny obsahu zpět, staré Undo zablokuje. Stejné operation ID nemůže označovat jiný požadavek. Opakování dokončeného Undo se nechová jako nový přepis.

Jde o spravované dokumenty, nikoli obecný filesystem počítače. Limity počtu souborů, velikosti a historie jsou záměrné; kapacita mutací rezervuje místo pro Undo.

### PostgreSQL konektor

Capture parsuje podporovaný SQL tvar, vybere předchozí řádky podle schématu a při delete prochází známé ON DELETE CASCADE vazby. Inverse obnoví zachycené řádky ve správném pořadí. Při update porovnává skutečný aktuální stav s očekávaným výsledkem původního podporovaného zápisu.

Apply nyní vyžaduje executor s `begin`, `commit`, `rollback`, zamyká existující kontrolované řádky pomocí `FOR UPDATE` a serializuje dvě inverse operace sdílející stejný executor. Běžný CLI adapter vlastní jednu connection a začíná SERIALIZABLE transakci. Jakákoli chyba uvnitř inverse vede k rollbacku; neurčitý výsledek COMMIT není prezentován jako úspěch a nesmí vyvolat slepý retry.

Capture a původní externí forward nejsou automaticky jedna transakce. Mezi nimi může nastat změna. Triggery, funkce se side effects, computed hodnoty, další služby, sekvence a obecné DDL nejsou úplně pokryté inverse tohoto konektoru.

### S3 konektor

Capture ukládá bytes a persistovaný envelope cíle. Apply znovu načte digestově ověřené snapshoty. Drift kontroluje ETag; následný put používá `If-Match` nebo `If-None-Match: *`, takže modelovaný souběžný zápis dostane konflikt místo přepsání.

**Jde o kompenzaci vytvořením objektu/verze, nikoli obnovení původní historie.** Konektor nezaručuje obnovení ACL, tags, metadata, retention, všech verzí nebo externích consumers. ETag není obecný čítač revizí: stejný obsah může skrýt ABA historii. Opakovaný restore může vytvořit další verzi; nejde o obecné exactly-once Undo.

## Opravené chyby a důkazy

| Nález | Před opravou | Oprava a test |
|---|---|---|
| Lokální connector capture | Namespace `workspace/postgres` odmítal LocalSnapshotStore; memory fixture problém skryla | Namespace `postgres-workspace`; skutečný local store + PGlite capture/restart/restore |
| Souběžný manifest | Více writer instancí četlo tentýž stav a přepisovalo si záznamy | Sdílená serializace a exkluzivní procesový lock; 40 souběžných writerů zachová 40 záznamů |
| Durability manifestu | Rename bez explicitního fsync | Synchronizace souboru a adresáře před návratem |
| Modifikace plánu | Apply používal mutable private payload inverse | Reload snapshotu přes ověření digestu a kontrola veřejných kroků; test změny řádku i cíle |
| Ztráta call metadata po restartu | PostgreSQL snapshot ukládal jen image | Verzovaný envelope s call + image, kompatibilní čtení starých image |
| Neatomická SQL inverse | Query-only executor mohl provést částečný restore | Odmítnutí před první query bez transaction lifecycle; skutečný constraint failure obnovu celou rollbackuje |
| Souběžné Undo stejné connection | Dvě operace mohly proložit transaction lifecycle | Fronta na executor; test právě jednoho restore a jednoho drift refusal |
| Check/write mezera při restore | Kontrolované existující řádky nebyly explicitně zamčené | `FOR UPDATE` v kontrolním čtení, v CLI nad SERIALIZABLE transakcí |
| Nadlimitní snapshot | Retention mohla odstranit právě zapsaný nadlimitní snapshot a put vrátit jeho reference | Předběžné odmítnutí bez odstranění již existujícího inverse |
| CLI hash-only důvěra | Přehašovaný ledger či zaměněný manifest mohl řídit mutation | Apply vyžaduje ověřené podpisy, `execute:completed` a podepsaný `captureDigest`; testy rehash a substitution |
| Chyby služby | Některé inverse chyby mohly propagovat text driveru | Sanitizované odmítnutí; S3 permission failure nevolá write a nevrací credential |

Nové důkazy jsou v `packages/proxy/src/forward/legacy-binding.test.ts`, `packages/proxy/src/legacy-root.test.ts`, `packages/proxy/src/bin.test.ts`, `packages/connectors/src/reverse-engine.test.ts`, `packages/cli/src/replay.test.ts` a `packages/connectors/src/s3/apply.test.ts`. Cross-layer scénáře skládají **složený production root** `legacyBindingRoot`, ne ručně psaný objekt: skutečný `runProxy` lifecycle s in-process upstream fixture, connector capture, podepsaný completed JSONL outcome, forward, restart a konektorové Undo. Tři cross-layer fixture pokrývají `postgres.row.update`, `postgres.row.delete` a `aws.s3.object.delete`, každý přes tentýž exportovaný bod. Root unit testy pokrývají odmítnutí neznámého jména, workspace guard, selhání manifestu a nedoložený výsledek. Proxy unit testy navíc pokrývají in-memory failed a unknown callbacky. Nejde o stdio nebo HTTP transport certification, signed negative fixture, automatické capture uvnitř proxy ani podporu dalších toolů.

Každé nové tvrzení v `legacy-root.test.ts` bylo ověřeno mutací zdroje: vypnutí odmítnutí neznámého jména, povýšení nedoloženého výsledku na `completed`, zrušení durability manifest zápisu, obejití workspace guardu a rozbití překladu `args` na `arguments`. Každá mutace shodila konkrétní test; po revertu je vše zelené.

## Změna CLI replay kontraktu

Inspect-only náhled staré historie zůstává dostupný:

```sh
nomo replay --ledger /path/workspace.jsonl --snapshot-dir /path/snapshots --seq 3 --dry-run
```

Skutečný apply navíc potřebuje důvěryhodný veřejný SPKI klíč přes `--key` nebo `NOMO_VERIFY_KEY` (library může dodat `publicKey`), záznam `decision: execute:completed` a `captureDigest` přesně rovný `manifest.reference.digest`.

```sh
nomo replay --ledger /path/workspace.jsonl --snapshot-dir /path/snapshots --seq 3 --key "$NOMO_VERIFY_KEY"
```

Konkrétní service adapter musí být nakonfigurovaný; samotný klíč žádné služby nepřipojuje. Historické authorization-only nebo nepodepsaně svázané capture záznamy se nesmějí dodatečně vydávat za důkaz dokončení. Zůstávají inspect-only. Náhled `--dry-run` sám o sobě nepotvrzuje oprávnění ani budoucí úspěch apply.

## Matice hranic

| Situace | Očekávané chování / ověření |
|---|---|
| Managed create/update/delete | Zachycení předchozího obsahu; podepsané Undo ověřeno |
| Managed newer edit / ABA | Odmítnutí starého Undo ověřeno |
| Managed ID collision / retry / restart | Idempotence a persistence ověřeny |
| SQL podporovaný UPDATE | Capture a obnova testovány na PGlite |
| SQL DELETE s cascade | Parent/child pořadí a nesouvisející řádky testovány |
| SQL human drift / chybějící řádek | Odmítnutí místo přepisu testováno |
| SQL částečné selhání | Reálný constraint rollback testován |
| SQL dvě Undo stejné connection | Jedno provedení, jedno odmítnutí testováno |
| SQL dvě síťové connection / výpadek COMMIT | Síťově zde netestováno; neznámý výsledek vyžaduje inspekci |
| Legacy proxy `postgres.row.update` | Složený root, capture před dispatch, signed completed outcome a restart Undo ověřeny; failed/unknown mají proxy unit testy bez signed cross-layer fixture |
| Legacy proxy `postgres.row.delete` | Cross-layer fixture přes složený root: capture včetně cascade, signed completed outcome, restart a obnovení dětských i rodičovských řádů |
| Legacy proxy `aws.s3.object.delete` | Cross-layer fixture přes složený root: capture bytů a ETagu, signed completed outcome, restart a obnovení bajtů přes fake klient |
| Legacy proxy neznámé binding jméno | `UnknownLegacyBindingError` při sestavení; žádný fallback ani odhad toolu |
| Legacy proxy bind name bez fixture | Test na kompletní podporovanou množinu failuje; neověřená obnova se neinzeruje |
| Legacy proxy cizí workspace na callu | Odmítnutí před capture; snapshot a ledger zůstávají v jednom namespace |
| Legacy proxy `nomo-proxy` bin / SDK klient | `legacyBinding` se nepředává; root je exportovaný, ale produkční vstupy ho zatím nepoužívají |
| Legacy proxy numeric/string IDs | Přeložená ID vedou oddělenou capture a outcome evidenci |
| Legacy proxy capture failure / close | Nula upstream callů před dispatch; po dispatch `unknown`, bez retry |
| Capture versus původní forward race | Hostitel musí řešit transakční hranici; obecně nezaručeno |
| S3 delete/restore bytes | Fake client round trip testován |
| S3 concurrent writer / 412 | Podmíněný zápis odmítne overwrite v testu |
| S3 credentials/permission failure | Bez mutace a úniku textu upstream chyby |
| S3 všechny metadata/verze/ABA | Úplná historie a metadata se neobnovují |
| Manifest race / binding / snapshot bytes tamper | Ztráta, substitution a poškození testovány a odmítnuty |
| Ledger append failure / rehash / signature | Fail-closed / podpisová kontrola testovány |
| Irreversible operace (odeslaný email, platba, cizí API) | Policy může řídit spuštění; obecný inverse neexistuje |
| Smazaný/retencí odstraněný snapshot | Undo není dostupné, bez snapshotu se nesmí předstírat obnova |
| Více závislých externích služeb | Žádná obecná distribuovaná transakce ani automatický rollback grafu |

## Zbylé praktické limity

- Obecný proxy ledger zaznamenává rozhodnutí; ne všechny externí výsledky mají samostatný podepsaný execution record. Nový CLI apply tento rozdíl respektuje.
- CLI connector replay samo automaticky nepřidává signed Undo receipt do původního ledgeru. Managed document engine takovou navazující evidenci má. Integrující hostitel externího replay musí evidenci dokončení zajistit.
- Snapshot retention úmyslně může odstranit starší inverse. Podepsaný ledger nezaručuje budoucí dostupnost snapshotu.
- Exkluzivní manifest lock po pádu může zůstat; jeho odstranění vyžaduje ověření, že writer neběží. Automatické hádání stáří locku není bezpečné.
- Lokální JSONL ledger není distribuovaný multi-process consensus store. Testy jedné instance neprokazují bezpečnost všech multi-host writer topologií.
- Podpis dokládá původ a neměnnost zaznamenaného tvrzení, nikoli pravdivost libovolného vzdáleného service výsledku.
- Testy jsou konkrétní široká regresní matice, nikoli důkaz správnosti ve všech možných situacích. Reálné PostgreSQL network fault injection, AWS restore se skutečnou versioning/retention konfigurací a další MCP služby v tomto běhu ověřeny nebyly.
