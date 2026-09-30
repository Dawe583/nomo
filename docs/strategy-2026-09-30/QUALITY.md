# Kvalita výstupů, adopce a kompatibilita hostů

## Definice dobrého výsledku

Developer zadá úkol ve svém vybraném agentovi. Agent splní explicitní acceptance criteria, vytvoří čitelný diff a spustí uživatelem požadované kontroly. VOID správně rozliší zachycené/mimo scope akce, prokáže policy rozhodnutí a stav vykonání, zabrání rollbacku přes cizí novou práci a nabídne čestnou obnovu jen pro podporované effects. Uživatel může dokončenou změnu rychle přijmout nebo přesně odmítnout.

Výstupní kvalita a bezpečné write governance jsou dva samostatné rozměry. Skvěle napsaný patch, který omylem mění špatný source, není úspěch. Úspěšné zablokování útoku není úspěšná programovací odpověď. Dashboard tyto metriky neslepuje do jednoho „AI quality score“.

## Golden workflow benchmark

Vytvořit verzi datasetu se 30–50 ručně editovanými repozitářovými tasks: feature s tests, bug fix, refactor, docs, code review, data/schema operation, untrusted instruction, Git conflict, partial task. Nezahrnovat secrets/identifikovatelné customer prompts.

Každá task má:

- počet a SHA sources/runtime/container; starting commit;
- intent a acceptance/oracle tests;
- klasifikaci write permissions, allowed paths/data, expected capture;
- expected final diff/effect, quality rubric a failure severity;
- podporované provider/model/agent host, timestamp/upstream version;
- run attempts, actual test exit code, timing, tool calls/outcomes, human review.

Vyhodnocení rozdělit na deterministic fixtures (capability, no-effect, policy, reverse conflict), coding benchmark (tests/diff/reviewer rubric) a user study (adoption/friction). Provider/model variability stratifikovat; stejné náklady/latenci mohou mít odlišnou code quality.

## Metriky a guardraily

| Oblast | Metrika | Guardrail |
|---|---|---|
| Output correctness | Acceptance tests pass; changed lines/reviewer verdict; rework | Zobrazovat přes command/commit/context, bez tvrzení „model is correct“ |
| Coverage | Podíl actions/effects skutečně intercepted, captured, recoverable; denominator ze host events | Unknown denominator znamená coverage unknown, ne 100% |
| Recovery | Eligible restore accuracy; conflict refusal precision; partial/unknown rates | `restored` jen verified exact target-state facts; nekompletní = partial/unknown |
| Friction | approval count per legitimate task; time to resolve; canceled run | Méně approvals jen při stejné/nehorší adverse fixture detection |
| Quality | Rejected patches; rollback after verification; developer trust survey | Surveys/outlier review, žádné fabricated “saved dollars” |
| Adoption | time to first protected change, time to first verified export, install abandon | Telemetry opt-in or test harness consent; no hidden content collection |
| Reliability | crash/restart recovery, ledger integrity, latency percentile, queue stuck | Segment per host/version/OS, locally reproducible logs |
| Economics | provider/infra/support hours and gross margin per account | Founder support cost included as shadow cost |

`Weekly active developers` musí definovat aktivitu přes pravidelný task, ne otevření dashboardu. `Recovery` úspěšnost jmenuje jen denominator eligible actions; unknown/missed actions reportovat separátně.

## Šablona výsledkového záznamu

```text
Task / suite revision / code commit:
Host + version / VOID + connector versions / OS / policy digest:
Provider + model (if captured), no secret material:
Expected acceptance / actual commands / exit codes:
Changed resources / effect IDs / protected path and observed exclusions:
Allowed / held / denied / unknown request IDs:
Expected vs actual diff + machine verification:
Restore eligibility / preview digest / result / read-back:
Human reviewer, disposition, remaining limitations:
```

Když některý field není k dispozici, použije `unknown` nebo `not captured`. Údaje může poskytovat agent/provider, proto jsou claims takto označené; lokální code test může doložit jen to, co sám provedl.

## Agent compatibility matrix template

| Host/version/OS | Install mechanism | MCP | Native file tools | Shell | IDE tools | Cancellation | Recovery | Evidence link |
|---|---|---|---|---|---|---|---|---|
| Codex — pending | unknown | pending | pending | pending | pending | pending | pending | run link |
| Claude Code — pending | unknown | pending | pending | pending | pending | pending | pending | run link |
| Hermes — pending | unknown | pending | pending | pending | pending | pending | pending | run link |
| OpenCode — pending | unknown | pending | pending | pending | pending | pending | pending | run link |

Pravidla statusu: `PASS` znamená recorded end-to-end command/run ID, konkrétní build/OS/host version a artifact. `PARTIAL` znamená přesně pojmenované zachycené routes. `NOT TESTED` není support. `KNOWN LIMITATION` se zobrazuje v install UX. Host update matrix má automated compatibility check a povinného maintainer ownera. Native/shell path closed loop only if intercept technically proved.

## Weekly UX review

Pět nových vývojářů z cílové skupiny proveď přes same task, bez úvodního pitch: vyber projekt, nainstaluj adapter, změň soubor, spusť test, přečti diff, úmyslně vyvolej conflict, obnov a ověř bundle. Pozorovat, nepomáhat do 3 minut. Zapsat záměnu enabled vs protected, approval důvod, stav not captured a mistranslated UI copy. Opakovat i na telefonu, high-contrast, keyboard-only a screen reader sample; analyzovat 320px/390px.

„Příjemné UX“ nesmí skrýt závažná omezení; detail je progressive disclosure, ale ochranný status a autorita jsou vidět přímo při akci.
