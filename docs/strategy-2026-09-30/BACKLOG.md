# Navržený backlog produktu NOMO

Vlastník epiku přiřadit v týmovém kick-offu. „P0/P1“ popisuje pořadí v návrhu, ne zákaznickou ani regulatorní severity bez triage. Implementaci každé nové vlastnosti uživatel výslovně zvažuje.

## E0 — Recovery pravdivě vrací celý resource chain

**Problém:** dva zápisy stejného file path v jednom recovery jobu mohou po obnovení pozdějšího kroku zneplatnit starší captured revision a zastavit se na mezistavu.

**Návrh:** planner i adapter používají explicitní očekávanou resource lineage. Obnova poslední změny aktualizuje očekávání dalšího kroku pouze z ověřeného outcome téhož jobu. Paralelní/neznámá změna nikdy nedostane implicitní rebase.

**Akceptace:**

1. Filesystem test create→write→write→rename→delete→restore na skutečném temp FS po novém runtime i restartu.
2. Obnovou se vrátí přesné file contents a deklarovaný metadata scope; inode/ACL/xattrs mimo kontrakt se neslibují.
3. Uprostřed jobu přidej nezávislou novější editaci stejné i jiné cesty. NOMO konflikt správně lokalizuje, zachová ji a reportuje partial, nikdy „restored“.
4. Každý write/recovery má replay-safe transition identity; timeout po commit před receipt dává `unknown` a vyžádá reconciliation.
5. Postgres stejné řádky opakovaně upraví a obnoví v deklarované transakční/trigger boundary; cizí concurrent update vyvolá konflikt.
6. Označení restored vyžaduje read-back obsahu/state, ověřený signed outcome a uzavřené všechny intended steps.

## E1 — Lokální ledger je skutečně owner-only podle deklarovaného OS kontraktu

Uměstit mód/policy přímo při vytváření souboru; pravidla existujícího souboru zkontrolovat a nepovolovat wide permissions bez explicitního degraded stavu. Na Windows otestovat ACL/DPAPI model; POSIX umask 022/077; concurrent creator/process restart; read-only directory; hardlinks/symlinks; symlink/parent replacement. Nezahrnout signing/vault secrets do shell/stdout.

**Exit:** audit log, key file, journal, vault i temp soubory mají jednotlivé security assumptions viditelné v `doctor`, bez broad root permission. Backup/restore zachová stejné identity a ověření; permission chyba fail closed.

## E2 — MCP/SSE request-response contract

- `Session.maps` předat response relay v pravém tvaru. Test vytvoří celý `runProxy` proces se skutečným `Session`, string upstream id i numeric agent id, souběžné server requests, cancellations a error result. Odpověď k původnímu serveru vrátí jeho ID přesně.
- Pause validator podporuje každý kód, který runtime emituje, nebo emitter zužuje na schema. Property testuje write/read/restart/lease takeover.
- Ověřit initialize version negotiation, SSE více frames/CRLF/EOF, notifications bez response ID, reconnect a session cleanup.

**Exit:** host sees protocol-valid reply/error/cancel; no hangs or guessed id; unknown session result cannot masquerade as unrelated success.

## E3 — Attribution digest chain pro model request

Nahradit `hash(prefix tail + through length)` incremental chain `d₀ = SHA256(domain || canonical(header, first batch)); dₙ₊₁ = SHA256(domain || dₙ || canonical(next messages, tools, model snapshot))`. Ve schématu verze explicitně zachovat/a migrovat historické eventy. Digest není důkaz pravdivosti modelu ani podpis runtime identity.

**Akceptace:** stejně dlouhá různá historie + stejný suffix mají rozdílný digest; stejný request opakovaně dává stejný digest; provider/model/tool-order/schema/scope změna ho změní; append jen nových messages má O(delta) cost; batch order, Unicode, redaction a migration documented.

## E4 — Jeden capability kontrakt pro hosty a effecty

### Navržené modely coverage

- `native-managed`: skutečná mutation cesta hosta je řízená adapterem.
- `mcp-managed`: pouze konkrétní tool requesty směrované přes NOMO MCP.
- `observe`: event vidíme a logujeme, ale nemůžeme zaručit blokaci ani obnovu.
- `unsupported`: NOMO nevidí / neresolvuje.

Každý záznam má `host name`, tested version, OS, transport, effect/connector, preconditions, conflict guarantee, tested source/branch, fixtures SHA, CI link, known exclusions, last verified date. Neexistuje jeden boolean „agent protected“.

**Exit:** capability je generována z provider registry nebo versioned adapter metadata; CLI, desktop, README, hosted admin používají tutéž odpověď. Unsupported path viditelný před action. Preset může provoz odmítnout, když critical path obchází mode.

## E5 — Host add-on a installation flow

Build pro Codex, Claude Code, Hermes, OpenCode. Nejprve one host end-to-end; zbývající adaptéry mohou běžet v paralelních squads, ale nespustí se do `supported`, dokud jejich conformance matrix neprojde.

**Funkce k posouzení:** `nomo doctor adapters`; dry-run plán config změn; backup a atomická instalace; uživatel vidí diff a vybere scopes; update idempotentní; uninstall obnoví config bez odstranění user changes; profile/worktree discovery; health/protocol status; přesný návod pro native vs MCP vs shell; redacted troubleshooting bundle. Bez „one-click enables all permissions“.

**Acceptance pro každého hosta:** nejnovější a jedna starší supported verze; fresh host config, existing custom config, 2 parallel sessions, abort/cancel, provider non-deterministic refusal, restart after crash, path with spaces/Unicode, Windows/macOS/Linux podle support policy. Změřit tři instalace od nezávislých lidí.

## E6 — Filesystem/Git/Postgres proof workflow

Fixtures v repo demonstraci samostatně izolované:

- Files: regular text/binary, overwrite, create/delete, rename, permission/metadata scope, ignored/untracked, symlink/boundary refusal.
- Git: worktree, unrelated staged/unstaged, `.gitignore` edit, nested/submodule/lock/untracked, generated files. Nepoužívat `git reset --hard`/`git clean` jako celý inverse. Selective hunk/path restore pouze s captured revisions.
- Postgres: table allowlist, explicit schema/row key, constraints/trigger, delete cascade boundaries, transaction failure and commit-unknown, 2 concurrent writers, migration, grant/tenant scope, exact read-back.

**Demo flow:** fixed fixture changes across systems → inspect unified diff and evidence → run tests → deliberately add developer work → restore eligible actions → conflict/partial panel → independently verify export. Reporting „cross-system restore“ must identify ordering and residuals, not imply distributed atomic transaction.

**Exit:** one reproducible local command each for canonical safe pass and intentionally induced conflict pass; fixture never points at live accounts.

## E7 — Bezpečné paralelní session a worktrees

User-selected direction: create/suggest isolated worktrees and display sessions/tasks/current branch. Preserve own dirty files and unrelated index state. Warn when agent writes outside assigned workspace. Resource lock advisory only; filesystem revision conflict authoritative. On cancel/crash show UNKNOWN until reconcile. No auto merge initially.

Future merge proposal gets separate user approval and normal version control; NOMO does not change branch history. Respect repository ignored files, secret scanning boundaries and symlink/path containment.

## E8 — Low-friction policy, bez approval fatigue

1. Explain authorization using effect/rules/precondition/resource/precision, operator and expiry.
2. Human approval binds exact reviewed change, digest, actor, policy version, host/run, expiry and one idempotent operation/scope.
3. Repeating exact same request within explicit bounded retry is detected; new input/effect must be reviewed again.
4. Read-only and write permissions separate; team profile diff + history; emergency revoke applies to queued/subsequent calls.
5. `plan`, `audit`, `normal` and observe show enforced actual state; no UI toggle may claim stronger enforcement than transport controls.

Measure approvals/action, legitimate bounded task completion, override rate, needless prompt rate, authorization scope, time to decision. Target less interruption at same/no-worse unapproved-effect detection. Count never used alone.

## E9 — Doložená kvalita agentního výstupu

Future report contains: user task/acceptance, changed paths/effects, workspace diff, tests user/system requested and exact commands/exit codes, output hash, prior failures, human review, unresolved or untested areas, recovery availability, excluded native paths, provider/model metadata only if actually captured. Agent summary is an untrusted claim.

`green` only if declared test tasks executed and exit 0 against commit still under review. Empty test list shows “no tests were run”, not green. Run after actual changed-files capture; agent-produced code cannot self-attest. Keep human signoff for consequential schema/data/API/permission/infra changes.

## E10 — Review/recovery UX

- One 60-second overview: what the agent asked, what NOMO allowed/held/denied, resources, resulting diff, evidence, recovery status.
- Before recovery show exact eligible operations, dependency/order graph, collisions, captured artifacts/time/source and exclusions.
- After recovery verify values and print restored/conflict/partial/unknown separately; offer next safe step. Never retry external effects silently.
- Full keyboard navigation/readers, mobile dialog and empty/loading/error/permission-required/degraded states.
- Workbench Desktop option remains optional. Original host remains source of conversation; NOMO adds an inspect/recovery link or MCP result, not duplicate navigation by default.

## E11 — Outputs, evaluace a regression set

Build task suite only from sanitized or hand-authored, reviewable fixtures; each task has input, repo version, oracle tests, expected changes/effect, allowed and forbidden effects and supported hosts. Score output diff correctness, tests, policy adherence, source citation, latency/cost where measured, recovery eligibility and safe-conflict response. Freeze held-out set; publish methodology before scores.

Pass conditions: no P0 data-safety regression; host-specific benchmark parity with pre-adapter baseline; successful expected output >= team-approved baseline; false-safe coverage 0 in adversarial safe subset. General code quality eval separate from recovery safety.

## E12 — Org/admin/evidence retention

Requires owner migration design. Team features candidates: org/seat invitation, role by least access, dual-control approval, policy versions and rollback, audit export, retention/delete, evidence viewers, server-agent/API keys rotate/revoke, usage budgets, idempotent webhooks and billing. Store only required content; redaction boundary must say whether secrets/arguments/results are retained. Retain original signing/evidence bytes per contract.

**Acceptance:** tests use at least two organizations/admins/viewers and impersonation attempts; API/MCP/export/documents/jobs/websocket/recovery all deny wrong tenant; invite revoke and session revocation are immediate per defined SLA; logs cannot contain API keys; cancellation has data export and deletion schedule; provider outage has safe write-path behavior.

## Explicitly postpone unless validated

- Implement another chat UI / general multi-agent orchestration.
- MCP marketplace/catalog breadth without an adapter and recovery fixture.
- Automatic cross-DB/cloud rollback or claim of atomicity.
- OPA, SIEM/metrics exporter rewrites before team buyer requests them.
- Memory/vector/RAG/browsing/voice/image/gen features not connected to measured developer output.
- Apple/iOS rebuild before pairing transport yields real recurring use.
- SOC2 badges, guaranteed compliance, certifications or SLA before external evidence.
- Usage telemetry collecting prompts or repo contents; default should remain local/minimal.
