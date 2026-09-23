# VOID — plán dalšího upgradu (TUI + GUI + AI agentic reverse tool)

## Current status correction

The dated roadmap below is not a completion report. See [verified scope](UPGRADE-VERIFICATION.md). New unconfigured workspaces default to NVIDIA NIM, `z-ai/glm-5.3-flash`; existing provider/model snapshots remain unchanged. Missing credentials mean setup-required, never fallback.

Managed document SQL journaling, retained run/list recovery, local profiles, deterministic compaction and a bounded local queue are implemented slices of A5/A9/A10, B6/B8/B9/B11 and C3/C6. Their larger roadmap items are not complete: no general pause/resume, executable hooks, dependency closure, server-enforced per-hunk review or general cloud queue is claimed. Percentage milestones are not measured evidence. No entire F0-F5 phase is closed by this integration.


Datum: 2026-09-18. Větev: `main` (lokálně pullnuto z `https://github.com/Dawe583/void`).
Autor: tým subagentů (5 rolí) + orchestrátor. Metoda: evidence-first, specify-first, žádný Potěmkin.
Vstupní dokumenty: `PLAN-GAPS.md` (audit 2026-09-16), `REVERSE-TOOL-UPGRADE-PLAN.md` (WP-R00–R14, milníky M0–M5),
`GUI-UPGRADE-PLAN.md` + `GUI-UPGRADE-DELIVERY.md`, `TUI-WORKSPACE.md`, `UPGRADE-CHECKPOINT.md`,
`REVERSE-UPGRADE-PROGRESS.md`, `RECOVERY-CONTRACT.md`.

## 0. Co je nového na GitHubu (ověřeno lokálně)

- `git clone https://github.com/Dawe583/void.git` do prázdného `VOID/` — OK. `git status` čistý.
- `main` HEAD `5eac884` „Default to TokenHarbor mimo-v2.5:free from the opencode setup".
  Předtím: `27acd74` standalone CLI verify, `8929f9e` Pollinations keyless fallback,
  `2d1f792` all-in-one GUI s Hermes paritou, `39194c3` web aperture + wordmark,
  `2f81882` provider/harness settings + thinking dots, `76ad907` attestace slices + offline verify,
  `fc04d8d` TUI theme switch za běhu.
- Aktivní vzdálené větve: `origin/GUI-WEB` (starší web preview, Wave 1/2), `origin/codex/gui-upgrade`
  (native workspace, Vercel backend, mobilní refinement), `origin/codex/void-beta` (ASCII beta workbench,
  replay hardening), `origin/claude/poradna-design-animations-*`. `main` je napřed před všemi —
  žádný merge z nich bez review. `GUI-WEB` je archivní, nemergovat naslepo (diff maže celé `apps/control-plane/ui`).
- Aktuální stav produktu: TUI `pnpm tui` (11 tabů, fuzzy slash, unified diff, schvalování `a/d/y`,
  cost/context poctivě `unknown`), GUI React+TS+Vite (`/chat … /settings`, TokenRouter/GLM 5.3 Free default,
  TokenHarbor nový default z opencode setupu), reverse jádro M0 ~70 %, M1 ~60 % —
  lokální signed journal + PGlite/Postgres managed cesta existuje, chybí cloud journal parita,
  proxy capture-binding, pin/GC, PG tail, planner s leasy.

## 1. Inventura nástrojů (poctivě, co je a co není)

| Požadavek | Realita na tomto stroji | Jak použito v plánu |
|---|---|---|
| ECC | `ecc@ecc 2.0.0`, `~/.claude/plugins/cache/ecc/ecc/2.0.0/skills/` — 200+ skillů | `deep-research`, `backend-patterns`, `frontend-design-direction`, `design-system`, `motion-*`, `mcp-server-patterns`, `security-review`, `verification-loop`, `delivery-gate`, `safety-guard`, `postgres-patterns`, `react-patterns`, `terminal-ops` |
| taste-skill | ECC `taste` existuje, ale je to **video taste** (angelcore/cloud-trance, beat-mapped střih), ne UI taste | Přebírám jen princip „taste first = směr rozhodnout před první generací" + `Taste is decided first and judged last`. Pro UI platí `frontend-design-direction`, ne video paleta |
| awesome-design | Samostatný skill **není instalován** | Mapováno na `frontend-design-direction` + `design-system` + `make-interfaces-feel-better` + `motion-foundations/patterns/advanced/ui` + `liquid-glass-design`. Žádná instalace duplicit (ponytail) |
| caveman | Soubor `/Users/dawe/.codex/skills/caveman` na Macu; zde jen `.caveman-active = full` | Princip: stručná čeština, plný technický detail jen v explicitně vyžádaných plánech/reportech (tento dokument) |
| ponytail | Zde jen `.ponytail-active = full` | Princip: reuse existujícího runtime/komponent/dialogů, žádná nová infra (žádný Kafka/Redis, Neon+Workflow stačí), nikdy nevynechat features/a11y/validaci/verifikaci |
| market-research | Skill načten | Konkurenční mapa, TAM signály, doporučení stavět/NE |
| web-design-guidelines | Skill načten | Kontrast 4,5:1, targety 44 px (mobil 48), keyboard cesta, live-regions střídmě |
| Task subagenti | 5 specialistů, každý jiná role | TUI, GUI, reverse-engine, market/strategy, ECC-quality — všichni jen research, kód až ve fázích |

## 2. Tým subagentů a role (vytvořen a proběhl)

1. **TUI-specialista** — `packages/cli/src/tui/**`, PTY testy, Claude Code/OpenCode/ratatui/bubbletea research. Výstup: 13 návrhů (must→nice) + 5× NEDĚLAT.
2. **GUI-specialista** — `apps/control-plane/ui/**`, paper-terminal identita, approval-inbox/HITL research. Výstup: 15 návrhů + 5× NEDĚLAT.
3. **Reverse-specialista** — `packages/runtime`, `packages/connectors`, `packages/ledger`, WP-R00–R14, saga/durable/SOTA research. Výstup: M0 70 % / M1 60 %, 12 must/should položek, top-3 rizika.
4. **Market/strategy analytik** — README/CONTEXT/GO-TO-MARKET/BETA + web. Výstup: mapa 7 hráčů (Rubrik, Portkey→Palo Alto, MintMCP, Composio, Claude/OpenAI nativ, Temporal/DBOS/Vercel SDK 7), cenové kotvy, 4× NE.
5. **ECC-quality orchestrátor** — STANDARDS/DECISIONS/CHECKPOINT. Výstup: Definition of Done (kontrakt+testy+důkaz+docs), 12-řádková testovací matice, 7 porotních otázek, co měřit/NEMĚŘIT.
6. **Orchestrátor (tento plán)** — syntéza, fáze, gaty. Pravidlo: max 2 subagenti píší kód současně (plán), nikdy nepřepisují společný runtime zároveň.

## 3. Deep-research: má to smysl? (fakt → inference → rozhodnutí)

- **Reversibilita jako tier, ne flag** — fakt: Tian Pan 04–07/2026 (4-tier model T0–T3), Toffoli (reversibilita = funkce akce × recovery stavu, unknown → escalate), IETF draft Agent Action Manifest 07/2026 (machine-readable manifest, effects advisory, fail-closed receipt), Microsoft agent-governance-toolkit (rings + saga orchestration). Inference: VOID R0–R3 + `exact/bounded/unknown` + readiness je správný směr a nikdo z mapovaných ho nedělá jako neutrální vrstvu. **Rozhodnutí: STAVĚT, kritická cesta M1.**
- **Undo = saga s kompenzacemi, ne stack** — fakt: Tian Pan „Undo Button Is a Saga", DevRev 08/2026 (version rollback ≠ action reversibility), agentic-design.ai saga pattern (idempotency key povinně). Inference: LIFO je jen default nezávislých akcí; závislosti = reverse-topologicky; kompenzace je forward-akce s vlastním failure modem. **Rozhodnutí: STAVĚT R06+R07 minimálně, R11 staged až M5.**
- **Inverse počítat při zápisu, ne při Undo** — fakt: prior value Y zachytit v momentě writu, jinak human/agent mezitím změní na Z; ABA odhalí jen revision/CAS. Inference: capture-before-dispatch + revision binding je non-negotiable. **Rozhodnutí: STAVĚT R02+R03 před jakýmkoli novým adaptérem.**
- **Hold komoditizuje, registr+ledger ne** — fakt: Claude auto-mode klasifikátor (default 08/2026, 93–97 % approve, 62 % bypass = approval fatigue), OpenAI Agents SDK guardrails+HITL, Vercel AI SDK 7 (HMAC approvals, WorkflowAgent). Inference: samotný hold není diference; diference = registry + třída + ledger + offline verifier. **Rozhodnutí: do TUI/GUI investovat do approval-důkazů (args/schema/pre-post/rule), ne do dalšího chat-bling.**
- **Konkurence neumí VOID的核心** — Rubrik (snapshot-model, enterprise), Portkey/MintMCP (allow/deny+log, žádný hold třetí stav ani kompenzace), Composio (šíře 1000+ integrací, $0,30/1K calls, žádný ledger), opendot (terminálový undo, content-addressed store — nejblíž TUI duchu). **Rozhodnutí: distribuce přes MCP Registry + `void-verify` standalone + registry stránky `/registry/<id>`, NE vlastní gateway.**

## 4. Základní body plánu

### A. TUI (must → nice)
1. Per-hunk diff review s enforce na serveru (M) — zužuje blast radius schválení.
2. Sticky approval banner v chatu (M) — hold nesmí být schovaný v tabu.
3. Approval detail: args + schema + R-třída s precondicí + rule + pre/post (M).
4. Server-autoritativní režim v status baru (S) — plan/read-only nikdy jen UI state.
5. `/context` breakdown + progress bar + threshold varování (S), tokeny billing vs kontext striktně oddělit.
6. `/cost` panel per-session/per-model, `unknown` nikdy `$0.00` (S/M).
7. Command paleta Ctrl+P + fuzzy skóre + recent-first (S).
8. Strukturované todos jako eventy, ne parsování prose (M, závisí na Workbench kontraktu).
9. Rewind picker s dependency varováním, R2/R3 blocker (M UI / XL planner).
10. Viditelná cancellable fronta `/queue` — `cancel queued only` (S).
11. Session/branch picker s preview + search (S, nice).
12. Ledger quick-view chain ikony `[+]/[x]/[!dev-key]` s časem posledního `/verify` (S).
13. Konfigurovatelné keybinds + opt-in Vim až po terminal safety (M, confirmation keys nikdy konfigurovatelné).

### B. GUI (must → nice)
1. Approval inbox v2 — riziko první, R3+R2 nahoře, plain-language akce + before/after diff + povinná reject note, execute-inline-on-approve, 1 commit při dvojím schválení (M).
2. Destruktivní gate hold-to-confirm pro R3/unknown (S).
3. Per-hunk diff review s HMAC-lock + stale příznak (L).
4. Ledger verify UX s poctivým scopem: job + progress + `seq X–Y + head digest + klíč + čas`, cache vázaná na head (M).
5. Viditelné permission modes Plan/Read-only/Normal s autoritou na serveru (M).
6. Kapacita a fronta narovinu: queued stav + pořadí + storno + resume (L; plná fronta XL).
7. Todo/plan jako structured events (M).
8. Background tasks s pause/resume/stop + notifikace (L).
9. Kontext compaction s účtenkou, ledger untouched (L).
10. `@file` mentions se snapshotem revize; binárky až s object storage + capability check (M).
11. Agents/hooks/MCP správa za stabilním kontraktem (L).
12. Tool-card důkazní panel + redakce secretů (S).
13. Reconnect/offline/stale matice (M).
14. Dependency graf + checkpoint rewind jen kde server umí inverses (XL, killer-feature vs claude.ai).
15. Zkratky + onboarding + prázdné stavy (S).

### C. Reverse — funkční AI agentic reverse tool (kritická cesta k M1)
1. R00 capability profil + claim audit webu (S, must) — bez toho nelze certifikovat nic.
2. R02-bind: capture→dispatch→outcome pro legacy proxy + 1 fixture/tool (M, must).
3. R01-cloud: cloud journal parita + disk/partition/kill testy (XL, must).
4. R03-pin: pinning, retention, GC respektující piny, kvóta-migrace (M, must).
5. R04-PG: reálný server — cascade, tenant, migrace, kill, partition, ztracený COMMIT (XL, must).
6. R06-min: perzistentní job, digest-approval, resume, conflict-stop, `reverses` receipt (M, must).
7. R05 FS/Git selektivní Undo (L, should) — paralelně s R04.
8. R07-min: read/write sets + revision do journalu (M, should).
9. R10-core: race 100×limit 2, restart/retry/unknown drží rezervaci (S, should).
10. R13-základ: `doctor/init` inventura, cooperative/managed label (S, should).
11. R14-min: offline bundle + completeness + externí verifier (M, should).
12. R12-test: `void adapter test` + drift→uncertified (L, should).
- Defer po M1: R08 S3/Supabase, R09 GitHub/Vercel, R11 staged, plný R06-lease/fencing, plný R07-graf, Python transport, registry 500 entries.

### D. Co NEDĚLAT (společné, s důvodem)
1. Žádný `bypassPermissions`/auto-approve — popírá intercept→decide→ledger kontrakt.
2. Neodhadovat ceny, nemazat historii jako „smazání důkazu", žádný hard-delete bez server endpointu.
3. Žádná tichá auto-compaction přepisující ledger; summary jen vedle, verzovaně.
4. Žádné binárky/multimodálko bez storage + policy; žádný vlastní Markdown parser/druhý store/3 vizuální kity.
5. NE vlastní LLM/MCP gateway, NE univerzální SaaS snapshot-platforma v betě, NE multi-workspace RBAC/SSO v 0.1, NE placené ads před 10 platícími.
6. Neklonovat Claude Code naslepo (themes/pluginy/hooks) — VOID TUI je ovládání ledgeru, ne klon.

## 5. Postupné fáze (každá: rozsah → závislost → důkaz → odhad)

| Fáze | Rozsah | Závisí na | Důkaz dokončení | Odhad |
|---|---|---|---|---|
| F0 Kontrakt + distribuce | R00 profil + claim audit; registry stránka `/registry/<id>` návrh; `void-verify` standalone spec | Tento plán | Každá podporovaná akce má scope/failure/test-ref; `check-registry-mirror` zelený | 2–4 dny (S) |
| F1 M1-jádro (DB cesta) | R02-bind + R03-pin + R04-PG + R06-min + R01-cloud parita | F0 | `write přes proxy → restart → Undo → DB+receipt OK`; ztracený COMMIT bez slepého retry; lidská změna = konflikt | 4–8 týdnů (XL) |
| F2 Coding-agent cesta | R05 FS/Git + R07-min + R10-core + R13-základ + TUI A1–A4 + GUI B1–B5 | F1 částečně paralelně | Selektivní Undo po restartu; sticky banner + per-hunk review s enforce; plan/read-only blokuje write | 3–5 týdnů (L/XL) |
| F3 Důvěra + provoz | R14-min bundle + verifier; GUI B4+B6+B12; TUI A5+A6+A12; metriky p95/p99 | F1+F2 | Externí verifier odmítne tamper; recovery po backup+rotaci klíče; LCP/INP/CLS baseline | 2–4 týdny (M) |
| F4 Šíře + parita | R12-test + `void adapter test`; GUI B7–B13; TUI A7–A10; managed commit/revert slice (append-only, žádný force-push) | F3 | Nový adaptér bez změny jádra; drift→uncertified; fronta/queue viditelná | 3–6 týdnů (L/XL) |
| F5 Vize | R11 staged + cascading cancel; plný R06/R07 (lease/fencing/graf); R08/R09 disposable-cloud certifikace; GUI B14 | F4 | Parent-cancel = 0 externích writů; cross-system plan s residual impact; incident-referenční test 10 kroků zelený | 2–4 měsíce (XL) |

Každá fáze končí 4-sloupcovým DoD: **kontrakt** (specify-first) + **testy** (`node:test`, seed) +
**důkaz** (příkaz, ne věta: `pnpm run check`, `pnpm test:reverse`, `node scripts/src/e2e-arc.mjs all`,
`pnpm run build`, Playwright disposable fixture) + **docs** (`RECOVERY-COVERAGE.md`, `MANAGED-*.md`, checkpoint).
Přeskočený live test ≠ certifikace. Mutace (uvolnění uncertain rezervace, přeskočený preflight,
tvrdé `restored` u R2) musí shodit testy — jinak je zelená podezřelá.

## 6. Porotní otázky pro každý návrh (verification-loop, 1× NE = vrátit)

1. Dělá write-path víc accountable, nebo je to funkce poblíž? (CONTEXT test.)
2. Jak se pozná fake-green? Který test selže po nasazení mutace?
3. Kde je skutečný cíl, ne mock? (DB klient, bytes+mode, ne volání `undo`.)
4. Co se stane při unknown? (Drží rezervaci, blokuje, vyžaduje reconciliation.)
5. Přepíše to lidskou změnu? (Konflikt + zachování novějšího + stop závislé větve.)
6. Je omezení viditelné tam, kde ho čtenář potká? (Cooperative, POSIX-only, žádný universal intercept.)
7. Projdelo by to třetí stranou bez našeho serveru? (Podpisy + sequence-range + plan digest.)

## 7. Další kroky (konkrétní, bez nových závislostí)

1. Review tohoto plánu → zapsat rozhodnutí do `docs/DECISIONS.md`.
2. F0: R00 profil schema + claim audit (2 soubory, 0 destruktivních testů).
3. F1 vertikála: jeden PG scénář end-to-end před jakýmkoli novým adaptérem.
4. TUI/GUI v F2 jen schvalovací důkazy (A1–A4, B1–B5) — žádný chat-bling před nimi.
5. Práce na `main`, malé ověřené commity, push = Vercel deploy (dle AGENTS.local.md); `GO-TO-MARKET.md` ven před open-core publikací.

*Design tokeny GUI zůstávají paper-terminal (`#f6f0e3/#12100a`, action `#bd4206/#e8702c`), pohyb 120–180 ms
jen jako odpověď na akci + `prefers-reduced-motion`, TUI anglicky + plné barvy default (`VOID_TUI_COLOR=0` = mono).
Ceny/limity providera jen doložené, jinak `unknown`. Sampling nikdy ≠ exact.*
