# Doporučená roadmapa VOID

Řazení odstraňuje nejprve známé chyby v autoritě, obnově a důkazech. Čas je v týmových týdnech pro **jeden 4–6členný cross-functional squad**. Nejsou to kalendářní sliby ani týmová FTE data. U většího týmu práce paralelizovatelná až po vytvoření společného kontraktu. Řady s externí závislostí čekají na příslušný environment/buyer.

## 0–2 týdny: stabilizovat důvěru, opravit průchody, připravit baseline

1. Znovu načíst `main`, zajistit reproduction fixtures a sepsat security review findings jako issue kandidáty. Nepřekopávat architekturu.
2. Opravit obnovu více po sobě jdoucích efektů stejného zdroje. Planner a apply musí používat stejnou resource/revision lineage; recovery job ukončit `restored` pouze pokud se hodnoty i počet změněných resource shodují s výchozím stavem.
3. Opravit vazbu recovery pause `lease-expired` versus validator; restart/lease expiry musí být validní, signed a pozorovatelný.
4. Opravit MCP session response ID remapping pro server-originované requesty v reálném `Session`; end-to-end fixture musí zahrnovat celý `runProxy` event loop.
5. Zabezpečit ledger soubor implicitní permissions režimem (owner-only) a testovat pod umask 022 i 077 na POSIX; Windows ACL prověřit separátně. Nesmí se tvrdit, že samotný mód řeší disk/host kompromitaci.
6. Nahradit request digest, který zahazuje starší prefix historie, průkaznou incremental chain/hash state. Nevyžadovat opětovné serializování celé historie. Ověřit různé prefixy se stejným tail, pořadí, model i tool catalog.
7. Zpřesnit provoz CI: current main SHA má 3 failed workflow runs. GitHub report neměl běžící job steps/runner_id; příčinu nelze z evidence pojmenovat. Spustit na novém branch CI a oddělit runner/startup failure od source test failure.

**Exit:** všech sedm problémových scénářů reprodukovatelných před opravou, zelený cílený běh po opravě v normální i restriktivní umask, full `pnpm check`, cloud workflow, manifest matrix Node 24/26, Apple simulator workflow a Python no-source deploy-shape. Nezelený/skipped runner není PASS.

## 2–6 týdnů: první bezpečný host adapter a wow proof

1. Zafixovat jeden verzovaný host-adapter contract pro instrukce, MCP tools, metadata, trust boundary, cancellation, restart a explicit capabilities.
2. Vydat první reálně ověřený adapter pro Codex. Zbytek hostů je discovery/conformance práce, dokud testy nepřejdou.
3. Zjednodušit první instalaci přes `void doctor`/Desktop setup: host config backup, diff, explicit opt-in, uninstall/rollback config, secret-safe diagnostics, read-only diagnosis.
4. Ukázat supported/unsupported write coverage v plain language vedle host statusu. U každé cesty uvést „plně zachyceno“, „jen MCP“, „observe“, „mimo VOID“, bez vizuálního implied safety.
5. Připravit fixture/workspace s filesystem, Git a Postgres a přesným ledger capture. U každého resource ukázat recovery eligibility a checkpoint.
6. Předvést současně tři případy: bezpečně obnoveno; konflikt s novou prací je bezpečně odmítnut; akce nikdy neprošla capture a UI explicitně řekne, že ji VOID nemůže vrátit.
7. Implementovat „not atomic“ multi-effect job orchestration pouze pokud umí resumovat/idempotentně pokračovat po částečném efektu. Každý krok má stav, dependency a residual; jeden globální green status nesmí zakrýt částečnou obnovu.

**Exit:** 8 nezávislých developerů na čistém stroji dokončí fixture bez autora; při jejich úmyslném conflict/untracked/crash scénáři nedojde ke ztrátě novějších dat; žádné produkční credentials; export ověří standalone verifier mimo běžící runtime. Malý vzorek testuje friction, netvrdí market share.

## 6–12 týdnů: další tři hosté a kvalita běžné práce

- Implementovat Claude Code, Hermes a OpenCode přes tentýž kontrakt; stejné testy golden tasks, host-specific conformance k profilu/verzi.
- Paralelně zapojit workstreams: konektor soubory/Git; Postgres adapter a transaction boundaries; install/onboarding; docs/release; eval/evidence UI. Jeden architekturní owner hlídá společný security contract.
- Upřednostnit opakované workflows pozorované u pilotů před budováním dalších providerů. Provider může zůstat libovolný nastavený lokálně; VOID nemá přebírat inference bill jako podmínku používání.
- Přidat task done report: git diff/stat, dotčené resources, výsledky uživatelem definovaných testů, coverage gap, ledger proof digest/verification key source a obnovení/konflikt state. Případný agent summary je jasně odlišen od strojově ověřených faktů.
- Zlepšit napojení na existing status/IDE/CI bez paralelního log dashboardu: odkazy na diff, approval, test command, evidence export; notifications opt-in.
- Přidat policy presets jen s explain-why a friction evidence. Repeated no-op approvalse zmenšit přes scope/TTL/operation identity, nikdy přes skryté rozšíření oprávnění.
- CI zahájit instalační conformance pro všechna čtyři hostovská release verze. Závislost na brittle CLI flags dát do versioned detection, žádný silent fallback.

**Exit:** podporované verze uvedeny; každá PASS komponenta je reproducovatelná na clean runneru; output benchmark zůstane nejméně na baseline kvalitě každého zvoleného hosta; recovery conflict suite 100% bezpečnostní scénáře očekávaně refuse/resume; přinejmenším dva paid pilots běží bez custom forků.

## 3–6 měsíců: team beta, měřitelná retence a verze

1. Zavést organizace a membership až s vlastníky tenant migrace, role matrix, approval reviewer separation, revoke semantics a negativní cross-tenant regression suite.
2. Týmový evidence feed a shared project policy: kdo/agent/host/version, request digest chain, nástroje/resource, co zachyceno, verdict, approvals, effect outcome, test a proof. Minimal data necessary; default secrets/input redaction.
3. Stav obnovy: preview → approve → apply → verify → residual review; panic stop, safe resume a unknown outcome reconciliation. Multi-resource není „rollback transaction“.
4. Retence, audit export a budget controls podle bezpečnostního review zákazníka. Guest/shared links až po access review; export signed and completeness-anchored.
5. Omezit povinný managed cloud na team potřeby; lokální self-hosted/OSS zachovat. Jen anonymizované opt-in telemetry, výchozí off.
6. Billing v sandboxu; seats/trial/renewal/cancel/refund/DPA/retention, webhook idempotence, entitlement drift a account offboarding. První 2–3 piloty lze férově fakturovat ručně, pokud cesta/terms jsou jasné.

**Exit:** 4-8 týdnů opakovaného use u více organizací; placené renewal a support effort známo; žádné P0/P1 tenant leaks; org invite/revoke/restore/export lifecycle vyzkoušen independent reviewer; unit economics pozitivní na ceně a rozsahu služby.

## 6–12 měsíců: scale pouze podle důkazů

- Self-service onboarding a Pro/team tiers po opakovaných kohortách.
- GitHub/CI policy check + release verification evidence, pokud pilot koupil deploy/PR workflow.
- Další high-value adapter až po paid request a independent conformance. Stripe/cloud operations nejsou automaticky první kvůli event reversibility/production blast radius.
- Resilience: Windows/Linux/macOS crash, disk full, race, backup/restore, schema migrations, multiple workers leases. Formal methods/property tests pro state graph kde drahé incidenty opodstatní cenu.
- Optional signer/executor separation přes samostatný principal/HSM/remote verifier. Nesuplovat root host trust tvrzením „zero trust“.
- Native mobile/Apple workspace a nové IDE only after retention/support signal; remote phone approval má být scoped a expirable.
- Další enterprise deployment/EU residency/SOC2 pouze s real customer pull, audit scope, budget i external control maturity.

## Kapacitní plány

| Tým | Plánovaná práce | Milníky |
|---|---|---|
| 1 core engineer + agents | První opravy; jeden host; demo; jeden adapter. Žádné paralelní native/web rebuilds | 2–6 týdnů trust+first workflow; 6–12 týdnů interviews/pilot readiness; 3–6 měsíců další host po stabilizaci |
| 3 vývojáři | 1 runtime/recovery, 1 host adapters/CLI, 1 onboarding/quality; founder také interviews/pilot support | 0–2 týdnů fixes; 2–4 prvního hosta; 4–8 týdny dalších hostů paralelně; týmový cloud omezeně |
| Větší tým 4–6 engineerů + product/GTM/security/reliability part-time | Dva squad strands přes společný contract: effects/recovery; host compatibility/install. Samostatný test/evidence owner, product-led paid pilot | Cílově first 4 hosts/FS+Git+PG proof do 6–10 týdnů po QA; 12 týdnů začátek managed-team beta po buyer gate |
| 7+ engineerů | Jeden platform group (2), adapter group (2–3), onboarding/UX (1–2), quality/security SRE shared, product+GTM; udržovat release ownership | Neurychlovat kvantitu před konformancí. Přidat reliability automation a customer delivery capacity dřív než 10+ host integrations |

Rozsah většího týmu upřesnit po napsání FTE/time budgets; nábor nevyplývá z technického auditu. Všechny velikosti počítají nezávislou security/review kapacitu a pravidelný buyer kontakt.

## Kill / continue gates

- Po 10 čistých first-use pokusech ≤3 dokončení: nepřidávat feature; opravit activation.
- Po nejméně 12 kvalifikovaných rozhovorech méně než 4 opakující se pain v recovery/conflict/evidence: změnit segment/promise před dalším integration sweepem.
- Placený pilot nechce pokračovat po 4–8 týdnech, nebo používá produkt jen jednorázově: odložit Team SaaS/billing a hledat weekly workflow.
- Candidate connector neprojde independent conformance/unknown state safety: držet disabled/preview; nevypsat ho v marketing support listu.
- Každá závažná data loss, false restored nebo cross-tenant access událost: pozastavit dotčený recovery deployment cohort, zachovat audit data, provést incident review.
- Bez důkazu o usage/cost 90 dní zůstává €10k MRR stretch target; tým reforecastuje podle skutečného pipeline, collected recurring revenue a support capacity.
