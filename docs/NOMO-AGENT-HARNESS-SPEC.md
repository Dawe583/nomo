# NOMO agent harness — specifikace

Stav ke 2026-10-07. Napsáno po přímém čtení zdrojů obou referenčních
harnessů na tomto stroji. Každé tvrzení o jejich chování má cestu k souboru;
cesty jsou z relativní kořene příslušného repozitáře.

Referenční zdroje:

- `upstream/omp-src` — oh-my-pi `omp` 18.6.2
- `upstream/prime-src` — PrimeIntellect `prime-agent` 0.9.8
- `docs/AGENT-BINARIES.md` v tomto repozitáři popisuje, jak NOMO oba binárky
  používá. Důležitá věc: **NOMO z nich dnes nekonzumuje žádný kód** — `omp`
  vůbec (`docs/AGENT-BINARIES.md:19-23`), `prime` jen přes tři úzké povrchy
  (`:34-46`). Tato specifikace nemění to rozhodnutí. Níže navržený harness je
  NOMO kód, který stojí vedle nich, ne fork.

---

## 1. Co omp skutečně dělá

Pozor na strukturu: kořen `omp-src/packages/` má 18 balíčků. Agent runtime je
`packages/agent`, CLI je `packages/coding-agent` (`omp-src/AGENTS.md`, tabulka
Package Structure).

| Oblast | Kde | Co to je |
| --- | --- | --- |
| Agent loop | `packages/agent/` | Základní smyčka: stav, tool calling, fronty zpráv |
| Nástroj `learn` | `omp-src/packages/coding-agent/src/tools/learn.ts` | Zapíše trvalou lekci do paměti; volitelně i vygeneruje/rozšíří skill |
| Nástroj `manage_skill` | `omp-src/packages/coding-agent/src/tools/manage-skill.ts` | create/update/delete izolovaného skillu |
| `AutoLearnController` | `omp-src/packages/coding-agent/src/autolearn/controller.ts` | Naslouchá event streamu; po podstatném tahu volitelně spustí syntetický capture turn |
| Paměť | `omp-src/docs/memory.md` | Pět backendů: `off`, `local`, `hindsight`, `mnemopi`, `sharpshooter` |
| Ratchet | `omp-src/packages/coding-agent/src/ratchet/ratchet.ts` | Hillclimb evaluací s confidence intervalami a keep/revert bránou |
| Metaharness | `omp-src/packages/metaharness/README.md` | Jeden správce benchmarků: experiment → run → trace, SQLite, REST/SSE, dashboard |
| Subagenti | `omp-src/docs/agent-hub.md` | TUI roster subagentů: stav, lineage, steer, revive, kill |

### 1.1 Paměť — jak se učí

`omp-src/docs/memory.md` popisuje `local` backend, který je pro NOMO nejbližší:

- lekce jdou do `learned.md`, newest-first, deduplikované, redigované,
  cap 100 položek (`omp-src/docs/memory.md`, sekce "Capturing lessons")
- vstřikovány **od další session** — `learn` nemutuje prompt-cache prefix
  aktivní session
- `learned.md` limit 2 000 znaků na lekci, kontext 400 znaků

Konsolidace běží ve dvou fázích na pozadí (`omp-src/docs/memory.md`, "How it works"):

1. **Per-session extrakce** — model čte historii session a vytáhne trvalý
   signál: technická rozhodnutí, omezení, vyřešené chyby, opakované workflow.
   Session přeskakují jako příliš nové, staré, aktivní, nebo za limit.
2. **Konsolidace** — druhý průchod čte všechny extrakce a vyprodukuje
   `MEMORY.md` (dlouhodobá paměť) a `learned.md` (lekce).

Důležitá vlastnost z `omp-src/docs/memory.md`: paměť je **heuristický kontext**, ne
autorita. Při konfliktu s reálným stavem repozitáře vyhrává repozitář.

### 1.2 Autolearn — kdy se učí

`autolearn/controller.ts` je jeden instalovaný na session (taskDepth 0). Logika:

- `#toolCalls` se počítá na `tool_execution_end`, resetuje se na `agent_end`
- `#turnStartedInGoalMode` se snapuje na `agent_start`, protože goal tool může
  goal uprostřed tahu zrušit a finální stav by podcenil
- pasivní mód je záměrně **prompt-cache neutral**: žádný skrytý připomínka se
  nevkládá do konverzace
- ochrana proti překryvu: `#captureInFlight` + `#capturePending`

Nápad, který stojí za převzetí: učení se spouští **na hranici tahu**, ne
uvnitř něj. Turn, který skončil, má stabilní kontext.

### 1.3 Ratchet — jak se hodnotí

Toto je nejlepší kus v obou repozitářích a NOMO ho nemá vůbec.
`omp-src/packages/coding-agent/src/ratchet/ratchet.ts`:

```ts
export const RATCHET_STAGES = ["inputs", "grader", "plan"] as const;
export type RoundDecision = "baseline" | "keep" | "revert" | "rerun";
export type Verdict = "up" | "down" | "flat";

export interface RatchetGoal {
  /** Metrika, kterou smyčka optimalizuje. */
  target: string;
  direction: Direction;
  /** Guardrail metriky, které nesmějíreagovat mimo šum. */
  hold: string[];
  directions: Record<string, Direction>;
}

export interface SplitSummary {
  n: number;
  mean: number | null;
  /** 95% CI half-width přes průměry případů; null pod dvěma případy. */
  half: number | null;
}
```

Klíčové vlastnosti, které je nutné převzít:

- **`hold` guardraily.** Optimalizuje se jedna metrika, ostatní nesmějí
  regresovat mimo šum. Bez toho se "lepší skóre" koupí za bezpečnost.
- **95% confidence interval** přes průměry případů, ne přes jednotlivé pokusy.
  Student-t kritické hodnoty jsou vložené jako tabulka pro df 1..30.
- **Split na train/test + kontrola leakage.** Drží `train_ids`, `test_ids`,
  `split_seed` a `baseline_inputs_sha`. Jiná sada případů = nový flow.
- **Schválení je hashem obsahu.** `approvals: Partial<Record<RatchetStage,
  { sha: string; at: string }>>` — když se změní vstupy, schválení je neplatné.
- **Plateau detekce** (`stop.plateau`) a `flat_rounds`.
- **Všechno mimo model.** Komentář nahoře: "Everything the model must not be
  able to argue with lives here — approval freshness (content hashes), the
  frozen split, completeness and held-out leakage checks, and the round
  decision — so the kernel facade only forwards arguments."

Ten poslední bod je zásadní architektonický princip a NOMO ho potřebuje
stejně: **statistika a brány nesmějí být v promptu.**

---

## 2. Co prime skutečně dělá

Prime je Rust port. `crates/pa-agent/src/agent.rs` je port `omp-src/packages/agent/src/agent.ts`
(ten portovaný originál je zřejmě tentýž kód jako v omp — oba stromy
pocházejí ze stejné rodiny).

| Oblast | Kde | Co to je |
| --- | --- | --- |
| Agent loop | `crates/pa-agent/src/agent_loop/` | `run.rs`, `tool_call.rs`, `entry.rs`, `response.rs`, `abort.rs` |
| Session engine | `crates/pa-core/src/session_engine/` | 62 souborů — největší kus |
| **Continual harness** | `crates/pa-core/src/refinement/` | `mod.rs` (state), `planner.rs` (edity), `ranking.rs` (relevance), `executor.rs` (aplikace) |
| Skills | `crates/pa-core/src/skills/` | `loader.rs`, `discovery.rs`, `frontmatter.rs`, `prompt_templates.rs` |
| Semantic edges | `crates/pa-core/src/session_engine/semantic_edges.rs` | Append-only ledger model-request událostí |
| Auto retry | `crates/pa-core/src/session_engine/auto_retry.rs` | Klasifikace chyb a retry politika |
| Compaction | `crates/pa-core/src/session_engine/compaction*.rs` | 9 souborů |
| Agent messaging | `crates/pa-core/src/session_engine/agent_messaging.rs` | Rodič ↔ dítě |
| RLM runtime | `prime-agent-runtime/src/rlm/` | Python: `harness.py`, `skill.py`, `mcp.py`, `factory.py`, `bash.py` |

### 2.1 Continual harness — nejzajímavější věc v obou stromech

`crates/pa-core/src/refinement/mod.rs` — trvalá editovatelná stavová vrstva:

```rust
pub const REFINEMENT_KINDS: [&str; 5] = ["prompt", "memory", "skill", "subagent", "factory"];
pub const HARNESS_STATE_DIR_NAME: &str = "harness";
pub const REFINEMENT_HISTORY_FILE_NAME: &str = "refinement_history.jsonl";

pub enum RefinementKind { Prompt, Memory, Skill, Subagent, Factory }
pub enum RefinementAction { Create, Update, Delete }
pub enum HarnessScope { Local, Global }
```

Tvrzení z hlavičky `mod.rs`, které definuje celý systém:

> Continual harness is the persistent, editable set of prompt notes, memories,
> skills, and subagent specs that lets Prime Agent improve reusable behavior
> **outside the token history**.

Tedy: agent si **sám píše do své vlastní výbavy** na základě toho, jak se
trajektorie vyvinula. Ne do konverzace, ale do trvalého stavu.

Prompt v `planner.rs` (`REFINEMENT_SYSTEM_PROMPT`) je napsaný jako kontrakt,
ne jako popis. Vyjímám to, co je přenositelné:

- **Základní system prompt je immutable.** Harness může přidat suplementární
  poznámky, nesmí přepsat základ.
- **Přiřazení komponenty podle povahy věci:** `memory` pro deklarativní fakta a
  preference, `skill` pro opakovatelné procedury vystavené jako Python call,
  `prompt` pro úzké behaviorální addendum, `subagent` pro reusable delegace.
- **Scope politika:** local = jen tahle session, global = cross-session lekce,
  které se mají opakovat. Projekt-specifická lekce smí jít global jen když
  title/path/content explicitně pojmenuje projekt.
- **Během local refinu jsou global entries read-only kontext** — nikdy je
  neproposalovat na update/delete.
- **"Prefer small evidence-backed edits."**
- **Rollback**: pokud minulý refinement způsobil problém, rollback nebo
  nahraď vadnou položku.
- **"Never edit source files directly."** — harness se upravuje jen přes edity.

Výstup je JSON s pevným tvarem: `summary`, `rationale`, `expectedOutcome`,
`edits[]`, kde každý edit má `action`, `kind`, `id`, `title`, `content`,
`path`, `reference`, `arguments`, `metadata`, `reason`.

Skill edity navíc musí nést `reference` s `{"type":"python"}`, Python import
a call pattern, plus `arguments` popisující vstupy — jinak je skill nevyužitelný.

### 2.2 Gate — proč to není jen "ukaž agentovi konverzaci"

`AUTO_REFINE_REVIEW_SYSTEM_PROMPT` v `planner.rs` je levný review pass, který
rozhodne, **jestli vůbec refinovat**:

> Reject one-off noise, unsupported hypotheses, and transient tool outputs.

To je přesně ta bráda, která NOMO potřebuje, aby se na ni nerozbilo těžké
tokeny při každém tahu.

### 2.3 Trigger — kdy refinovat

`crates/pa-core/src/session_engine/auto_refine_trigger.rs`. Stav, který nese
session:

```rust
pub(crate) struct CompactAutoRefineState {
    pending: bool,
    last_review_at: Option<u64>,
    settled_turns_since_review: u32,
    in_flight: bool,
    branch_version: u64,
    pending_review: Option<AutoRefineReview>,
}
```

Pravidla, která jsou přenositelná a důležitá:

1. **Pořadí je pevné:** nejdřív brány (je-li refine surface, je zapnutý,
   `compact` nastavení, review cooldown), pak review, a teprve schválený
   review spustí refinement.
2. **Každý pokus o review — decline, úspěch, i chyba — razítkuje cooldown** a
   resetuje počítač turnů. Bez toho by trvalá chyba opakovala plný review na
   každé hranici.
3. **`branch_version`:** přesun větve ho zvýší a kolo, které začalo na starší
   verzi, svůj výsledek zahodí. Review vyřešené proti opuštěné větvi nikdy
   neaplikuje svoje edity.
4. **`pending_review` za aktivního tahu** se převezme na další hranici bez
   nového modelového volání.
5. **Povrchy:** `Checkpoint` (mezi runy) a `Dispose` (zavření session — trigger
   se neztratí).

### 2.4 Relevance ranking — jak se do promptu dostane jen relevantní kus

`crates/pa-core/src/refinement/ranking.rs`. Tokenizace do query termů:

- word runy písmen a číslic, **delší než 4 znaky**
- CJK runy jako **překrývající se bigramy**

Plus `is_cjk` jako samostatná funkce pokrývající hiragana, katakana,
hangul a CJK Unified Ideographs přes několik bloků včetně extenze-J.

`overview_for_prompt` v `executor.rs` dělá per-kind přehled s 40-položkovým
capem a 240-znakovým zkrácením obsahu, ref i args.

### 2.5 Semantic edges — ledger před efektem

`crates/pa-core/src/session_engine/semantic_edges.rs`. Kontrakt:

> Ledger events are written **before** the effects they describe (ledger
> before wire, a child's return before the notice that triggers the parent's
> next turn).

Provenance je best-effort: **první selhání ledgeru trvale vypne recorder s jedním
warningem** a volajé přestanou posílat request ids na wire, místo aby oslabili
invariant. Edge sémantika zůstává v TS, protože „nothing in the Rust product
reads or derives edges yet".

Tenhle vzorec — *ledger before wire* — je přesně to, co NOMO dělá v
`commitWorkspace`, a je to nejlepší jednotlivá věc v prime pro NOMO.

---

## 3. Co NOMO má dnes

Tady je klíčová věc, kterou je nutné říct před návrhem: **NOMO má věc, kterou
ani omp, ani prime nemají.**

### 3.1 Co NOMO má a oni nemají

| Vlastnost | Kde v NOMO |
| --- | --- |
| Podepsaný hash-chain ledger jako autoritativní záznam | `packages/workbench/src/index.ts`, `commitWorkspace` |
| Fail-closed klasifikace r0–r3 s registry | `packages/registry/src/evaluate.ts:113` (`classifyTool`) |
| Uzavřená gramatika policy na 5 klíčích | `packages/policy/src/grammar.ts:16-23` |
| Dvě implementace hold (workbench-local, SDK/proxy) | `docs/CODING-TOOLS-MAP.md` §4 |
| Neprůstrelný alias gate (`tool_${index}`) | `packages/workbench/src/index.ts:3408-3413` |
| Důkazní odmítnutí: typed error + ověřený digest | `packages/workbench/src/index.ts:3059-3068` |
| Recovery planner s cross-host fencing | `packages/runtime/src/recovery/` |
| Nález pravidla z refusals v podepsaném chainu | `packages/workbench/src/learned-rules.ts` |

Poslední řádek je důležitý a zároveň jediný existující „učicí“ mechanismus.

### 3.2 `mineLearnedRules` — jediná věc, která se dnes učí

`packages/workbench/src/learned-rules.ts`, 105 řádků, čistá funkce nad entries.
Učební poznámka na vrcholu souboru je přesná a má platit dál:

> A learned rule is **evidence, not authority**. Two consequences are
> load-bearing and both are enforced by the caller rather than here:
>
> - Learned rules are appended **after** the operator's own rules, because
>   `decide` takes the first matching rule.
> - The decision is `hold`, **never `deny`**.

Další vlastnosti, které je nutné zachovat:

- `LEARNED_RULE_MIN_REPEATS = 3` — „One refusal is noise; a model that keeps
  being refused is a fact.“
- `isRefusal` záměrně **vyřazuje** `execute:unknown` (mezera v našem vědomí není
  důvod pro trvalý zákaz) a `proxy` (rozhodl upstream, ledger už zaznamenal
  delegování).
- Klíč je `JSON.stringify([klass, tool])`, s komentářem proč ne surový NUL —
  doslovný NUL v souboru nechá git považovat soubor za binární.
- Řazení je deterministické, aby dva průchody stejným chainem daly stejná pravidla
  a stejné digesty.
- **„Nothing here writes."** Promotion je práce volajícího a jde přes
  `commitWorkspace`, aby záznam podepsal stejný klíč jako vše ostatní.
- Volejí se načtení (`policyWithLearned`, `index.ts:2776-2786`, s importem na
  `:98`), takže „derived on read, so a chain that is truncated or rolled back
  cannot leave a stale rule in force".

Nastavení v `packages/cli/src/tui/workspace.ts:1091`, `:2427`, `:2438`.

**Toto je nejlepší učicí mechanismus ze všech tří repozitářů.** Protože běží nad
podepsaným chainem, jehož autoritu si nikdo nemůže podvrhnout. prime si píše
`refinement_history.jsonl` a důvěřuje tomu, že se tam nedá dostat; omp píše
`learned.md` do pracovního stromu. NOMO má ledger.

### 3.3 Harness limity — tabulka, ne literály

`packages/workbench/src/harness-settings.ts`, 14 klíčů. Tři pravidla, která
soubor deklaruje:

1. **„A setting with no consumer does not exist."** Každý klíč jmenuje symboly,
   které ho čtou, ve souboru, kde jsou definované, a test tvrdí, že ty
   symboly existují.
2. **„Bounds are clamped, not trusted."**
3. **„The server keeps the last word on authority."** `permissionMode` je
   schválně nepřítomný a zůstane.

Každý limit nese `consumerFile`, `consumers`, `default`, `min`, `max`, `icon`.
Například `maxOutputTokens` → `provider.ts` → `["complete", "anthropic"]` a
`maxRunTimeoutMs` → `index.ts` → `["run"]`. Oba `consumerFile` jsou soubory
uvnitř `packages/workbench/src/`, nikoli kořenové `packages/cli` — tabulka
uvádí relativní cestu v rámci balíku.

Hodnota toho souboru pro návrh: **každý nový limit musí jmenovat svého
konzumenta.** Bez toho je to jen přání operátora.

### 3.4 Co NOMO nemá

| Chybí | Kdo to má |
| --- | --- |
| Učení se z **úspěchů**, ne jen z refusals | oba |
| Čisté lokální učení (local scope) oddělené od trvalého | prime (`HarnessScope`) |
| Relevance ranking — co do promptu patří | prime (`ranking.rs`) |
| Brána, která rozhodne „učit se nyní není vyhodné“ | prime (`auto_refine_trigger`) |
| Editovatelná stavová vrstva mimo token historii | prime (continual harness) |
| Cooldown proti thrashingu | prime |
| Branch versioning učicích editů | prime |
| Jakákoliv statistika / confidence interval | **nikdo** |
| Benchmark harness se split a guardraily | omp (ratchet, metaharness) |
| Roster subagentů | omp (agent-hub) |
| Prompt-cache neutralita při učení | omp (autolearn) |

Poslední řádek je důležitý: **NOMO nemá žádnou statistiku.** Ani omp, ani prime
nemají statistiku nad bezpečnostními rozhodnutími. To je prostor, kde může být
NOMO lepší než oba, a nemusí se nijak ohrožovat.

---

## 4. Návrh

### 4.1 Princip, ze kterého vychází celý návrh

**Učení musí být levné a nesmí být schopné obejít ledger.**

Z toho plyne rozdělení na dvě vrstvy, a to je celá architektura:

- **Deterministická vrstva** — těžba signálu z podepsaného chainu, žádné
  modelové volání. Rozšíří `mineLearnedRules`. Většina učení je tady a je
  zdarma.
- **Modelová vrstva** — jen refinement pass a jeho levná review brána. Běží
  výhradně když brána řekne ano, s cooldownem, a jeho výstup jde do chainu
  jako podepsaný záznam, ne do volného JSONL.

Tím je zohledněno i omezení rate limitů: běžný běh agenta platí nula
modelových volání navíc. Refinement je placen jen tehdy, když brána uzná, že
trajektorie obsahuje něco použitelného.

Druhý princip, převzatý z prime:

> **Nejdřív brány, pak review, a teprve schválený review spouští samotnou práci.**

### 4.2 Nový soubor: `learned-harness.ts` (navrženo)

Rozšíření současného modelu o 3 nové druhy položek. Existující těžba
refusals zůstává beze změny — je ověřená a je správná.

```ts
/** Kinds the harness can hold. `rule` is what the miner already produces. */
export type HarnessKind = "rule" | "lesson" | "skill" | "subagent";

export type HarnessScope = "session" | "workspace";

export type HarnessEntry = {
  readonly id: string;
  readonly kind: HarnessKind;
  readonly scope: HarnessScope;
  readonly title: string;
  readonly content: string;
  /** Ledger seq this was derived from. Provenance is the point. */
  readonly derivedFromSeq: number[];
  readonly createdAt: string;
  readonly uses: number;
  /** Set when an edit supersedes this entry. Kept, never deleted. */
  readonly supersededBy?: string;
};
```

Čtyři pravidla, která jsou závazná a přenesená z obou vzorů:

1. **Všechno pochází z chainu.** `derivedFromSeq` je povinné. Položka, která
   nemá provenance, do chainu nesmí.
2. **Lesson a skill jsou jen návrh.** `rule` smí jít do `policyWithLearned` a
   i to až po `LEARNED_RULE_MIN_REPEATS`. Zbytek čeká na operátora.
3. **Session scope nepřežije session.** Ukládá se do session state, ne do
   chainu — jinak by se po restartu znovu objevilo něco, co nikdo nepotvrdil.
4. **Supersede, ne maze.** Aktualizace položku schvádí a nechá starou žít s
   ukazatelem. `refinement_history.jsonl` v prime se zahazuje; chain ne.

### 4.3 Rozšíření těžby — `mineHarnessEntries`

Nová čistá funkce vedle `mineLearnedRules`. Stejná signatura jako
`mineLearnedRules` (pole entries → pole návrhů), stejná zásada „nothing here
writes".

Co se dá vytěžit **bez modelu**, z toho co ledger už obsahuje:

| Vzor | Podmínka | Návrh |
| --- | --- | --- |
| Opakované refusals | `isRefusal` a `repeats >= 3` | `rule` (dnes) |
| Opakované hold-approved | `hold:approved` a `repeats >= N` | `lesson`: „operator tohle opakovaně schválil“ |
| Stálé rychlé vykonání | class r0 a `elapsed < p95` a `repeats >= N` | `lesson`: „tato cesta je bezpečná a levná“ |
| Chybová dominanta | stejný `errorCode` a `repeats >= N` | `lesson` s návrhem, ne pravidlem |
| Drift klasifikace | stejný tool, r0 v některých a r2 v jiných | `lesson`: „klasifikace tohoto nástroje není stabilní“ |

Poslední řádek je NOMO-specifický a oba reference ho nemají: **nestabilní
klasifikace je bezpečnostní nález**, ne jen statistická zajímavost.

Všechny návrhy nesou `reason` ve stylu současného `rationale`: tvrzení
o pozorování, ne o závěru, který chain nepodporuje.

### 4.4 Gate — `refine-gate.ts` (navrženo)

Převzato z `AUTO_REFINE_REVIEW_SYSTEM_PROMPT`, ale **nejdřív pravidla, pak
model**.

```ts
export type GateDecision =
  | { readonly refine: false; readonly reason: string }
  | { readonly refine: true; readonly instructions?: string };

/** Cheap deterministic pre-filter. Zero model calls. */
export function cheapGate(input: {
  readonly settledTurnsSinceReview: number;
  readonly lastReviewAt: number | null;
  readonly cooldownMs: number;
  readonly newCandidateEntries: number;
  readonly pending: boolean;
  readonly branchVersion: number;
}): GateDecision;
```

Podmínky, které cheapGate vyhodnotí **bez modelu**:

- už běží review (`in_flight`) → odmítnout s `reason`
- pod cooldownem → odmítnout
- méně než `settledTurnsSinceReview` turnů → odmítnout
- žádný nový kandidát od minulého review → odmítnout
- trigger z kompakce, ale session nemá harness state dir → odmítnout
  (stejně jako v prime: „Sessions without the refine surface never arm")

Teprve když cheapGate projde, jde dotaz na model. Výstup je
`GateDecision`, a to rovnou jako JSON schema, ne jako volný text.

**Každý pokus — decline, úspěch, i chyba — razítkuje cooldown a resetuje
počítač turnů.** Bez toho trvalá chyba opakuje review na každé hranici. Toto je
pravidlo z `auto_refine_trigger.rs` a je přenositelné 1:1.

### 4.5 Trigger — `refine-trigger.ts` (navrženo)

Stav, který nese session, přebraný z `CompactAutoRefineState`:

```ts
export type RefineTriggerState = {
  pending: boolean;
  lastReviewAt: number | null;
  settledTurnsSinceReview: number;
  inFlight: boolean;
  branchVersion: number;
  pendingReview: GateDecision | null;
};
```

Povrchy, kde se trigger obslouží:

- `checkpoint` — mezi runy
- `dispose` — při zavření session; trigger se neztratí

`branchVersion` se zvýší při přesunu větve a kolo, které začalo na starší
verzi, výsledek zahodí. Bez toho se edit vyvinutý na opuštěné větvi propíše do
sdíleného stavu.

### 4.6 Relevance ranking — `harness-ranking.ts` (navrženo)

Převzato z `ranking.rs`, ale relevance se počítá **nad ledgerem**, ne nad
volnou historií.

```ts
export type QueryTerms = ReadonlyMap<string, number>;

/** Word runs >= 4 chars; CJK runs as overlapping bigrams. */
export function harnessQueryTerms(text: string): string[];

export function rankEntries(
  entries: readonly HarnessEntry[],
  terms: QueryTerms,
  perKindLimit: number,
  contentChars: number,
): HarnessEntry[];
```

Termíny se váží zdrojem: explicitní prompt uživatele váží nejvíc, systémový
prompt nejmíň, ledger-derived obsah někde mezi. Obě reference toto nemají —
mají ploché váhy termů. Vážení podle původu je správnější, protože „co se
opakovalo v chainu" není totéž jako „co teď napsal uživatel".

### 4.7 Scoring — `harness-scores.ts` (navrženo)

Tohle je kus, který **nemá nikdo z trojice** a který je nejlépe umístěný právě
v NOMO, protože čte podepsaný chain.

Inspirované ratchetem, ale **adaptované na bezpečnostní rozhodnutí**, ne na
výkonnost benchmarku.

```ts
export type ScoreDirection = "higher" | "lower";

export type ScoreMetric = {
  readonly key: string;
  readonly label: string;
  readonly direction: ScoreDirection;
  readonly unit: "ratio" | "ms" | "count" | "usd";
};

export type SplitSummary = {
  /** Případy s alespoň jedním ohodnoceným pokusem. */
  readonly n: number;
  readonly mean: number | null;
  /** 95% CI half-width přes průměry případů; null pod dvěma případy. */
  readonly half: number | null;
};

export type ScoreBoard = {
  readonly metrics: Readonly<Record<string, SplitSummary>>;
  readonly guardrails: Readonly<Record<string, SplitSummary>>;
  readonly verdict: "improving" | "declining" | "flat" | "insufficient-data";
  readonly generatedAt: string;
};
```

Metriky (a proč právě tyhle):

| Metrika | Směr | Proč |
| --- | --- | --- |
| `hold_rate` | lower | Kolik čeká na člověka. Vysoká = příliš těžká pravidla. |
| `deny_rate` | lower | Kolik se blokuje. Vysoká = agent zbytečně riskuje. |
| `unknown_tool_rate` | lower | Kolik volání nešlo klasifikovat. |
| `first_pass_rate` | higher | Podíl pokusů, které nepotřebovaly opravu. |
| `median_approval_ms` | lower | Rychlost člověka. |
| `recovery_success_rate` | higher | Podíl recovery, které doběhly. |
| `rollback_count` | lower | Kolikrát bylo třeba vracet. |
| `cost_usd` | lower | Přes `calculateUsageCost` ekvivalent. |

Guardraily, které nesmějí regresovat mimo šum: `deny_rate`, `rollback_count`,
`unknown_tool_rate`. **Bez guardrailů by šlo optimalizovat `hold_rate` na nulu
tím, že se všechno nechá projít** — proto guardraily.

Student-t kritické hodnoty z ratchetu se převezmou jako tabulka (df 1..30,
pro větší vzorek normální hodnota).

**Klíčové omezení, které musí být v kódu, ne v komentáři:** skóre je
**popisné, ne autoritativní**. Nikdy nevstupuje do `decide`. Stejně jako
`learned-rules.ts` a stejně explicitně.

### 4.8 Co zůstane nedělané, a proč

Tři věci z referencí, které se do NOMO **neportují**, a důvod:

1. **Python REPL runtime (prime `rlm`).** Prime skills jsou Python funkce
   spouštěné v REPL kernelu. NOMO skills jsou markdown (`SKILL.md`) jako u omp.
   Zavádět Python kernel by znamenalo novou runtime závislost a nový
   escape-hatch v produktu, jehož celý smysl je, že ho nemá. Neportuje se.
2. **`ratchet` v plné podobě.** Hillclimb nad variantami promptu je užitečný
   pro vývoj harnessu, ne pro běžný běh agenta. Přebírá se **statistická
   aparátura** (`SplitSummary`, guardraily, split, leakage check) pro
   `harness-scores.ts`; vlastní hillclimb zůstává jako nástroj pro práci na
   harnessu, ne jako produkt.
3. **Auto-compaction z prime.** NOMO má `packages/workbench/src/context.ts` a
   ten dělá triviální 3 000-znakové zkrácení JSON. To je slabé oproti
   prime, ale je to **samostatný kus práce**, který s učením nesouvisí.
   Zaznamenáno, neuděláno, a nesmí se zamíchat do refaktoru učení.

---

## 5. Testovací plán

Každá vlastnost dostane test, který padá bez implementace. Bez výjimky.

### 5.1 Těžba (`harness-scores` a `learned-harness`)

- determinismus: `mineHarnessEntries` na prohozených entries dává stejný výsledek
  a stejné digesty (paralelně k existujícímu `learned-rules.test.ts:101`)
- prázdné vstupy → prázdný výstup, žádná výjimka
- `cheapGate`:
  - pod cooldownem → odmítnout, **bez modelového volání**
  - `inFlight` → odmítnout
  - zero kandidátů → odmítnout
  - session bez harness state dir → odmítnout
- triggerní cooldown:
  - pokus o review, který skončí chybou, **také** razítkuje cooldown
  - `branchVersion` mismatch → výsledek zahazen
- ledger-first invariant: žádná položka bez `derivedFromSeq`
- supercede: aktualizace schvádí starou, stará zůstává s `supersededBy`
- scope izolace: session položka se neobjeví v workspace store

### 5.2 Invarianty, které nesmějí selhat

Tady je podstatná část — jde o invarianty, které NOMO už dodržuje a učení
nesmí rozbít:

- `mineLearnedRules` zůstává `hold`, nikdy `deny`
- naučené `rule` položky jsou až **za** operátorovými pravidly v poli `rules`
- žádný naučený vstup se nesmí dostat do `permissionMode`
- skóre se nikdy nepoužije v `decide`
- učení **nepřidává** nástroje do katalogu. Katalog je sestaven
  `index.ts:1313-1341` ze tří zdrojů (`[...workspaceTools]`, poté `tools.push`
  pro potvrzené connectory na `:1324` a pro stdio na `:1335`) a model do něj
  nemůže přidat ani odebrat řádek
- alias gate (`index.ts:3408-3413`) zůstává jediné místo, kde se mapa aliasů
  kontroluje
- `workspace-tools-guard.test.ts` zůstává zelený

Tyhle body jsou psané jako testy, ne jako review komentáře, právě protože
`docs/CODING-TOOLS-MAP.md` ukazuje, že bezpečnostní vlastnosti tohoto
repozitáře jsou dnes kryté přesně jedním testem na alias invariant
(`policy-review.test.ts:89-113`) a jinak ničím.

### 5.3 Testy proti regresím učení

- naučené pravidlo neprežije rollback chainu (dnes garantováno tím, že se
  pravidla odvozují při čtení — tato vlastnost musí zůstat)
- naučené pravidlo neprežije změnu session scope
- 1000 entries v chainu → těžba je v rozumném čase; jinak je to DoS ve vlastní
  službě, protože těžba běží na cestě autorizace

Poslední bod není hypotetický. `policyWithLearned` se dnes volá z jediného
místa, `index.ts:2986`, ve větvi `if (!tool.connectorId)` — tedy jen pro
managed workspace nástroje, ne pro connector ani stdio. Nová těžba, která by
běžela i na těchto cestách, by se násobila frekvencí každého externího nástroje.
Proto je v návrhu cache podle `evidence[workspace]` povinná, ne volitelná.

---

## 6. Pořadí práce

| # | Kus | Soubory | Závisí na |
| --- | --- | --- | --- |
| 1 | Scoring | `harness-scores.ts` + test | — |
| 2 | Trigger + gate | `refine-trigger.ts`, `refine-gate.ts` + test | 1 |
| 3 | Těžba entries | `learned-harness.ts` + test | 1 |
| 4 | Ranking | `harness-ranking.ts` + test | 3 |
| 5 | Modelový refinement pass | nový soubor + test | 2, 3, 4 |
| 6 | Zápis do chainu | `commitWorkspace` | 5 |
| 7 | TUI řádek + `/harness scores` | `cli/src/tui/` | 1 |

Kus 6 je jediný, který mění existující kód mimo nové soubory, a je záměrně
poslední — do té doby je celá věc přidaná a neprovozovaná, takže odebrání je
`git revert` jednoho souboru.

### 6.1 Co se dá udělat dřív než cokoliv jiného

`harness-scores.ts` (kus 1) je čistá funkce nad chainem, má testy a nedotýká
se ničeho. Je to zároveň kus, který ukáže, zda je 95% CI a guardraily v NOMO vůbec
užitečné, **předtím** než se staví cokoli složitějšího. Pokud vyjde, že
guardraily se dají splnit triviálně, je potřeba to vědět v kusu 1.

---

## 7. Co tato specifikace neřeší

Otevřeně, protože repozitář má `docs/OPEN-WORK-AUDIT.md` a věci, které tam
nejsou, se v tomhle stromu objevují jako falešné tvrzení později.

- **Klasifikace hostovských nástrojů modelu.** `docs/CODING-TOOLS-MAP.md`
  §6 končí konstatováním, že `shell.command.exec` je v registru jako r3,
  ale žádný takový nástroj není v katalogu, který model vidí. Učení to nemění.
- **Guard na connector a stdio povrchy.** (WP-GUARD, 2026-10-16). Povrch
  konektoru rozhoduje podle surove politiky operatora, povrch pracovniho prostoru
  podle politiky operatora s pripojenymi naucenymi pravidly, ktera jsou dnes
  inertni evidenci za terminalnim catch-all a nikdy nerozhoduji; stdio pouze
  deleguje a nerozhoduje nikdy. Testy v
  `packages/workbench/src/connector.test.ts` a
  `packages/workbench/src/workbench.test.ts` to pinuji pro cestu a receipt.
  Canary na nedotceny host se na obou površích neslibuje, viz
  `docs/CODING-TOOLS-MAP.md` Appendix 2.
- **Subagenti.** omp má Agent Hub, prime má `rlm.spawn` a `agent_message`,
  NOMO nemá nic. Chybí to tu. Je to větší kus práce než všechno výše a nedotýká
  se učení — patří do vlastního work package.
- **Skill drift mezi workspace a globální store.** Neuvažováno.
- **Co se stane, když se `mineLearnedRules` začne opakovat na vlastních
  výstupech.** Regresní smyčka. Řešitelné, ale `derivedFromSeq` je jen
  zachytí, ne řešení.