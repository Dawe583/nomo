# NOMO core: ověřená zjištění a vady

Baseline `4c560dd98668da06e24b2189e854203fdcaa80a2`, 30. září 2026. Zpráva se vztahuje na technické hlavní cesty a opakované testy; úplné rozpětí ručního čtení je v [coverage](CORE-COVERAGE.md). Jde o read-only audit, žádná source oprava.

## Závěr

Lokální signed ledger, policy/runtime, offline verifier a několik managed adapterů jsou skutečný produkt, ne pouze mock. Nejrizikovější mezera není přidání UI funkcí: jde o správnost více-krokové obnovy a end-to-end důkazy. Host agent může jít mimo capturable path a explicitní timeout/unknown status musí zůstat viditelný. Každý recovery adapter má odlišné resource/version záruky.

## Potvrzené technické nálezy

| Priorita návrhu | Nález | Evidence / důsledek |
|---|---|---|
| P1 | Více po sobě jdoucích zápisů stejného souboru může při run recovery konfliktovat po obnovení posledního zápisu; zůstane mezistav místo původních bajtů | `packages/connectors/src/filesystem/managed.ts:163–207,234–235,447–490`. Adapter očekává captured revision, ale vlastní předchozí restore změní inode/ctime revision. Reprodukce přes skutečný temp FS + managed adapter. Pořadí plánovaných kroků funguje, acceptance obnova chainu chybí. |
| P1 | MCP response ID se při server→agent response může vrátit jako nesprávné id, když response relay dostane `Session` místo `Session.maps` | `packages/proxy/src/bin.ts:493`, `session.ts:24–34`, `relay/requests.ts:66+`. Session drží mapy pod `.maps`; relay čte `upstreamToAgent` přímo. Test mapovací helper funkce nepokrývá živou kompozici `runProxy`. Indikátor: `server-42` se po relay vrátí jako agent `1`. |
| P1 | Recovery takeover umí uložit `pause.code="lease-expired"`, ale parser obnovované job state přijímá jen `step-unavailable` | `packages/runtime/src/execute.ts:1004–1012`, `runtime/src/recovery/plan.ts:700–707`. Persistent takeover state může projít write a poté selhat při následné validaci. Chybí společná closed enum/schema i restart test přes tento branch. |
| P1 | Request digest současné agentní konverzace při incremental digest hashing neobsahuje dřívější prefix ani předchozí digest | `packages/workbench/src/index.ts:2394–2417`. Existuje lokální deterministická reprodukce: stejně dlouhé různé prefixy + tentýž přírůstek dávají stejný digest. `through` length prefix nerozlišuje. Oslabuje vazbu atribuce na plné kontextové historii; není SHA-256 kolize, jde o vynechaná vstupní data. Nahradit domain-separated hash chain s migrací. |
| P2 | Ledger soubor vzniká bez explicit mode a spoléhá na oprávnění parent složky a OS umask | `packages/ledger/src/store.ts:96,119`: novou adresářovou cestu vytváří `0700`; při už existující custom cestě její ACL/permissions znovu nekontroluje a append otevře bez mode. Výchozí key/data soubory mají vlastní hardening, ale tento JSONL path je samostatný boundary. Vyjasnit kontrakt pro shared directories a otestovat POSIX umask 022/077 i Windows ACL před tvrzením o každém custom path. Default `~/.nomo/ledger` není týmová sdílená cesta. |
| P1 | Existující clean full `pnpm test` v tomto executor environment není green | První baseline průchod: 15 suites, 2020 případů deklarovaných runnerem: CLI 308/0; connectors 386/5 fail; ledger 101/0; policy 91/0; proxy 157/0; registry 38/0; runtime 161/0; SDK 14/0; verifier 3/0; workbench 138/0; control plane 197/0; scripts 178/0; cloud 111/0; appwrite MCP 53/1 fail; nomo-transport 84/0. `/tmp/nomo-strategy-tests.log`. Pět connector failures vzniklo pod runner umask 077; 220 příslušných FS/Git testů prošlo pod umask022, 2 skip. Appwrite fixture symlinky křížily `/workspace` a `/tmp`; při stejném source testu pod stejným filesystem root příznak zmizel, viz follow-up níže. |
| P2 | Cloud demo má nesouhlasné provider labely | `cloud/demo.mjs`: runtime požaduje NVIDIA key, ale veřejný status/error model může hlásit starší TokenRouter název. Uvedeno též v [surfaces auditu](SURFACES-AUDIT.md). Jde o produktovou pravdu/provider data boundary. |

V coverage zprávě subagenta je v úvodním bodě „222 testů“, zatímco následující tabulka uvádí 220 pass + 2 skip; do citace používáme 220/0/2. Nepřenášet rozpor dál bez opakování.

### Follow-up při tvorbě plánu

- Python Appwrite suite při `TMPDIR` uvnitř workspace prošla 53/53; `/tmp/nomo-strategy-appwrite-localtmp.log`. Samostatný deploy-shape test prošel: `/tmp/nomo-strategy-deploy-shape.log`. Root cause test portability potvrzuje cross-device temp setup, ne vadu hosted snapshotu.
- Typecheck prošel. `pnpm run build` prošel; build report ověřil 4 frontend assets, Node API a streaming route. `scripts/src/e2e-arc.mjs all` skončil `PASS whole product arc moment`.
- Fyzické Apple simulator/desktop installers a GitHub Actions běžící joby z tohoto Linux prostředí nejsou doloženy.

## Existující pozitivní schopnosti, které stojí za reuse

- Registry evaluace oddělená od ledger/policy závislostí; case-level reversibility a podmínky.
- Signed, append-only ledger a samostatný offline verifier; export bundle má per-section digest, counts, range a externí anchor.
- Runtime states pro intent/capture/effect/recovery a explicit unknown/reconcile paths; encrypted recovery vault.
- Filesystem/Git/Postgres/s3 capability surface; managed API odděluje probe, capture, execute, plan a recovery, místo aby předstírala obecné snapshot undo.
- Workbench TUI/GUI má policy, provider separation, queue/abort, compaction, audit metadata, approval, recovery preview a explicit model state; provider BYOK a captured output reasoning se oddělují.
- Test suite je velká, package scoped, má named timeout; Python testy se počítají separátně. GitHub action last commit runs zatím selžou bez job diagnostic evidence; jejich příčinu z tohoto GitHub API snapshotu nelze přiřadit source změně.

## Priorita a evidence potřebná před dodáním

1. E0 restoration sequence conflict matrix + golden raw bytes/state proof.
2. MCP composition fixture end-to-end with actual Session and server request.
3. Typed/schema validator for all durable pause/end-state variants; restart each lifecycle.
4. Request history chained digest; include old history migration/replay proof.
5. OS permission matrix + `umask` known; add ACL checks and secret/redaction review.
6. Fix suite portability: no cross-device symlink assumptions; root runner execute full `pnpm check` again. Test report must preserve actual fail output.
7. Test the generated desktop/Linux/macOS installers and installed file permissions, not only workspace tests.

## Claims NOMO should qualify

- "Signed" means bytes verify against a particular public key; how that key was anchored is a separate fact.
- "Restored" should name exact fields/resources verified after write. It is not general rollback of external side effects.
- Registry rows do not imply installed executable adapter support. Keep source-level registry and runnable connectors as separate denominators.
- `MCP` attachment covers those MCP tools that pass through the proxy, not arbitrary host writes to shell, editor, browser, SDK or network.
- SQLite/filesystem/Postgres capture is not by itself tamper-proof, compliance certified or unavailable to privileged host attacker.
