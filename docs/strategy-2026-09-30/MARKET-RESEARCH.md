# NOMO: trh, odlišení, retence a opakované příjmy

Research k 30. září 2026, jako podklad k rozhodnutí. Uživatel zvolil **add-on pro Codex, Claude Code, Hermes a OpenCode**, s wow scénářem filesystem + Git + Postgres. Monetizační doporučení je delegované; nové funkce zůstávají návrhy k projednání.

## 1. Metoda, důkazy a limity

Bylo načteno osm primárních GitHub README (Codex, Cline, Claude Code, OpenHands, Continue, agentgateway, Langfuse, Portkey), dokumentační rozcestník Codex sandbox a dvě veřejná GitHub issue searches s pěti položkami. Research je proveden GitHub connector nástrojem `github_fetch`, nikoli nativní službou Deep Research: taková callable služba nebyla v dostupných nástrojích nalezena. Přímé HTTPS dotazy ze shellu na raw GitHub a vendor ceníky skončily proxy `403 Forbidden`; konektor veřejná GitHub data načetl úspěšně. Proto neuvádíme domnělé aktuální ceníky Cursor/Claude/OpenAI/Langfuse/Portkey ani tvrzení o úplném trhu.

Evidence má tři odlišné úrovně: (1) vendor README tvrzení o vlastním produktu; (2) uživatelský issue report, bez vlastní reprodukce; (3) analytický závěr/hypotéza NOMO. README nezaručuje kvalitu provozu; issue nezaručuje existenci chyby ve všech verzích; search počet není počet postižených lidí ani market size. Nenalezená feature neznamená, že neexistuje. Konkurentní ceny citované ve starých NOMO dokumentech zde nebyly znovu ověřeny.

## 2. Konkurenční mapa z primárních zdrojů

| Produkt / zdroj | Co primární text skutečně uvádí | Strategická implikace pro NOMO |
|---|---|---|
| [Codex README](https://github.com/openai/codex/blob/main/README.md), modified 2026-07-23 | Lokální coding CLI, IDE, desktop i cloud; ChatGPT login nebo API key; Apache-2.0 repo | Uživatelé už mají hosta i placený modelový plán. Povinné přesměrování do dalšího chatu zvyšuje switching cost. NOMO musí přidat jasně viditelnou bezpečnou operaci/evidence. Cenu ChatGPT z README neodvozujeme. |
| [Claude Code README](https://github.com/anthropics/claude-code/blob/main/README.md), modified 2026-01-12 | Terminal, IDE, GitHub; codebase understanding a Git workflows; plugins/custom agents | Plugin/host integration je distribuční povrch, ne automatická intercept coverage všech nativních toolů. |
| [Cline README](https://github.com/cline/cline/blob/main/README.md), modified 2026-09-17 | IDE, CLI, desktop, SDK, checkpoints/undo, plan/act approvals a auto-approve, BYO model, MCP/plugins, multiagent, schedules | Undo, approvals, multiagent ani desktop samy o sobě nejsou unikátní differentiator. SDK výslovně nabízí lifecycle hooks pro logging/auditing/policy enforcement; může být partner i konkurent. |
| [OpenHands README](https://github.com/OpenHands/OpenHands/blob/main/README.md), live fetch 2026-09-30 | Agent Canvas: self-hosted control center, third-party agents včetně Codex/Claude přes ACP, automations, local/VM/cloud, BYO model; local without sandbox warning | „Jeden dashboard pro všechny agenty“ je existující nabídka. Integrace pod workflow má menší switching cost než stavba druhého agent canvas. Warning je doklad potřeby jasné execution boundary, ne důkaz, že OpenHands vždy běží bez sandboxu. |
| [Continue README](https://github.com/continuedev/continue/blob/main/README.md), live fetch 2026-09-30 | Repo hlásí read-only/no longer actively maintained a final 2.0.0 release; CLI/VSCode/JetBrains | Neopisovat historické aktivní obchodní positioning jako současný fakt. Lesson: široká kompatibilita bez maintenance modelu sama nezaručí trvalý produkt. Příčinu ukončení zdroj nedokládá. |
| [agentgateway README](https://github.com/agentgateway/agentgateway/blob/main/README.md), modified 2026-09-10 | MCP/A2A proxy; stdio/HTTP/SSE/Streamable HTTP; OAuth, JWT/API keys, RBAC/CEL policy, rate limiting, TLS, OTel, model budget/spend | Generic gateway/governance vrstva má dobře vybaveného OSS konkurenta. NOMO musí demonstrovat effect-specific recovery/preconditions a evidence, nebo se s gateway integrovat. README absence určitého recovery tvrzení není důkaz, že produkt nemá recovery. |
| [Portkey gateway README](https://github.com/Portkey-AI/gateway/blob/main/README.md), modified 2026-02-19 | MCP gateway auth, tool access control, identity forwarding a logged tool calls; LLM routing, governance, cost, enterprise/private-cloud nabídka | Organizace mohou kupovat control/observability v existující službě. Billing per call vyžaduje skutečně měřitelnou jednotku a diferenciace nesmí být jen „máme audit“. |
| [Langfuse README](https://github.com/langfuse/langfuse/blob/main/README.md), modified 2026-09-24 | Observability, prompt management, datasets/evals; self-hosting; MIT mimo ee složky; v README výslovně basic telemetry bez raw traces/prompts | Outputs se zlepšují eval/data/feedback, ne množstvím UI features. NOMO může exportovat evidence do existujícího observability stacku místo budování plného eval dashboardu od začátku. |

Poznámka: Hermes a OpenCode jsou uživatelsky zvolené hosty, nikoli v této dílčí konkurenční tabulce zdrojově auditované konkurenty. Adapter proveditelnost a upstream contract musí ověřit technický workstream; neodvozujeme podporu z marketingové analogie s jinými MCP hosty.

## 3. Pain signály: konkrétní issue reports

GitHub search `repo:cline/cline checkpoint is:issue` vrátil 251 matches; `repo:openai/codex approval is:issue` 3 858 matches. To jsou textové matches včetně starých/nesouvisejících reportů. Výběr prvních pěti v každém dotazu není reprezentativní studie. Podstatné jsou reprodukční scénáře pro vlastní acceptance suite, nikoli velikost počtu.

| Zdroj | Co report tvrdí | Co ověřit ve NOMO |
|---|---|---|
| [Cline #14367](https://github.com/cline/cline/issues/14367), vytvořeno 2026-09-21, open při čtení | Checkpoint restore může po necommitnuté `.gitignore` a `git reset --hard` + `git clean -fd` nevratně odstranit untracked data; report jmenuje SDK implementation | Dirty worktree, ignored/untracked, změna ignore pravidla; nikdy nevymazat soubory mimo deklarovaný a zachycený efekt. Před restored ověřit všechny preconditions. Nereprodukováno u Cline v tomto auditu. |
| [Cline #12388](https://github.com/cline/cline/issues/12388), 2026-07-18 | Interní continuation/retry rozbije lookup staršího checkpointu | Stable operation id napříč retry/continue, user-turn vs execution-attempt identity; crash/reconnect nesmí ztratit vazbu journal/artefact/effect. |
| [Cline #12784](https://github.com/cline/cline/issues/12784), 2026-07-31 | Checkpoint initialization timeout | Large repo activation/latency/vault capacity; viditelný fallback nesmí tvrdit plnou ochranu. |
| [Cline #13689](https://github.com/cline/cline/issues/13689), 2026-08-29 | Missing checkpoints, bez reprodukčních kroků | Coverage indicator a explicit not-captured status; report má slabší důkazní hodnotu. |
| [Cline #4388](https://github.com/cline/cline/issues/4388), 2025-06-23 | Corruption/submodules, disk growth, interrupted checkpoint process | Submodules/worktrees, bounded retention, no `.git` manipulation surprises, failure-safe temporary state. Historický report může být pozdějšími verzemi vyřešený. |
| [Codex #44473](https://github.com/openai/codex/issues/44473), 2026-09-10 | Explicitně schválený non-force push opakovaně blokuje approval reviewer | User authorization continuity, jasný reason/action a ukončitelný hold; oprávněný bounded action má projít bez approval loopu. |
| [Codex #48821](https://github.com/openai/codex/issues/48821), 2026-09-28 | Delegované tasks čekají na approvals i při full access | Parent/child authorization scope vymezit výslovně; žádné tiché rozšíření authority ani schované blanket refusal. |
| [Codex #45952](https://github.com/openai/codex/issues/45952), 2026-09-16 | Ask-for-approval mode provádí nečekané změny | Policy decision musí vznikat u skutečné action boundary a být auditovaná; odpověď/plán nesmí být zaměněn za grant změn. |
| [Codex #47838](https://github.com/openai/codex/issues/47838), 2026-09-24 | Invisible approval stall, stuck badge | Každý hold má actionable UI, cancel a durable status; interrupted != succeeded. |
| [Codex #47217](https://github.com/openai/codex/issues/47217), 2026-09-22 | Granular approvals bypass/misclassification | Conformance matrix pro scope a execution path; unknown/default není automatické povolení. Nereprodukováno. |

Z těchto reportů plyne hypotéza: lidé nechtějí více varování; chtějí kontrolu, které rozumí a která nepoškodí jejich existující práci. Kupující potřebuje proof nejen happy path, ale dirty/concurrent/crash scenario.

## 4. Doporučené odlišení

**Pracovní positioning:** „Přidejte ke svému coding agentu chráněné změny a konfliktově bezpečnou obnovu souborů, Git operací a Postgres dat, s důkazem o tom, co bylo skutečně pokryto.“ Toto je cílový slib, ne tvrzení, že všechny tyto kombinace jsou nyní production ready.

Odlišení otestovat proti třem alternativám: stávající Git workflow/checkpoint v hostovi; sandbox + manuální backup; existující gateway/control plane. Test musí být „zákazník dokončil stejný task a zachoval práci druhého developera“, ne porovnání počtu features. Pokud NOMO jen přesune approval do jiné obrazovky, přidaná hodnota není prokázána.

Navržená obhajitelná hodnota:

1. **Selective recovery:** explicit effect, zachycený pre/post state, preconditions, conflict refusal a ověření výsledku; multi-effect recovery nemůže slibovat globální atomický undo bez podporovaného kontraktu.
2. **Visible coverage:** při každé operaci říká chráněno / jen zaznamenáno / nepokryto / neznámý outcome. Nativní shell hosta nemusí procházet MCP proxy. Vyhnout se blanket claimům „každá akce“.
3. **Nízká friction:** bounded safe policy pro rutinní změny, jediný jasný approval pro rizikový efekt, žádná žádost znovu jen při retry stejné autorizované operace; změna scope vyžaduje nové rozhodnutí.
4. **Reprodukovatelný proof:** zákazník má export a samostatný verifier, který správně popíše integritu a hranice důvěry. Podpis nesmí být prodáván jako důkaz pravdivosti modelové odpovědi nebo agent-resistant principal isolation bez implementace.
5. **Team continuity:** sdílená policy, ownership decisions a evidence přinášejí opakovaný užitek i v týdnu, kdy zákazník nic nevrací.

„Ultimátní pro každého developera“ je dlouhodobá vize. První buyer hypothesis: tým 3–20 vývojářů se souběžnými agenty a reálnou databází/dev environmentem, kde lead odpovídá za změny. To je pracovní segment pro rozhovory, nikoli zjištěný market size.

## 5. Monetizace: CEO doporučení

Doporučený počátek je **open/local adoption + placené a omezené team design-partner piloty**, po ověření retence self-serve Team. Nezpoplatnit základní konfliktové odmítnutí, obnovu nebo důvěryhodný export tak, aby freeware uživateli zbývala nebezpečná cesta. Opakovaný příjem má být za opakovanou organizační hodnotu a provozní závazek: policy management, review roles, evidence retention, support, hosting a správa kompatibility.

| Nabídka — hypotéza k testu | Účel | Cena/scoping hypotéza | Gate |
|---|---|---|---|
| Local/Core | Adoption, osobní důvěra, reprodukovatelný proof | Free/BYO provider, explicit supported scope | Fungující instalace a ochrana nevyžaduje bankovní kartu ani product chat. |
| Design partner | Najít buyer, outcome a obnovu podpory | €750–€1 500 měsíčně, jeden workflow/environment, 4–6 týdnů první evaluation, jasný support cap; jednorázový setup odděleně | Písemný scoped outcome, weekly review, 2 nezávislé úspěšné evaluace, poté pokračování; renewal není automaticky dokázané platbou za pilot. |
| Team | Opakovatelný self-serve/org nákup | Stávající €249/month concept zachovat jako jednu testovanou kotvu; porovnat €149/€249/€499 podle rozsahu | Bez autora activation, durable memberships/billing, opakované weekly use, margin/support důkazy. |
| Enterprise/Self-host | Data boundary/SLA/identity | Individuální nabídka, žádné veřejné SLA nebo compliance certifikace bez důkazů | Buyer-sponsored požadavek, deployment contract, security/provozní kapacita a realistická podpora. |

Tyto ceny nejsou naměřená ochota platit ani vendor benchmark. Primární pilotní pásmo zpřesnit až po rozhovorech a schopnosti podpory. Větší tým umožňuje paralelní adapter workstreamy a GTM, ale nedělá z každé feature obchodní prioritu. Rozsah podpory musí být omezen, jinak MRR skrývá consulting.

Pro jednotlivce lze otestovat Pro €15–€29/month jen pokud 10–15 aktivních uživatelů ukáže osobní recurring hodnotu mimo OSS základ. Samotná hypotetická cena není doporučení tento tier hned stavět. Na začátku držet jednoznačnou nabídku; test jednotlivců sbírá údaje bez paralelního rozsáhlého billing produktu.

### Ekonomika, kterou je třeba měřit

- **Gross margin po přímé podpoře:** `(recurring revenue − inference − hosting/storage − payment fees − přímé support/delivery náklady) / recurring revenue`. Founder čas uvádět i při nulové cash mzdě jako shadow cost.
- **Payback:** acquisition cost / monthly contribution margin; sledovat founder sales čas, nejen reklamu. Za malé n nelze tvrdit stabilní LTV.
- **MRR:** aktivní opakované závazky normalizované na měsíc; setup, jednorázová evaluace a nepravidelné služby uvádět odděleně. Collected MRR a contracted MRR rozlišit.
- **Retention:** aktivované cohorts, weekly active protected workspaces, 4/8/12-week use, logo churn, contraction/expansion. Rolling retention denominator a revenue base musí být uvedeny.
- **Safety quality:** recovery success na eligible effects; conflict refusal separátně; partial a unknown se nikdy nezapočítají jako restored. Počet deny/hold není hodnota sám o sobě.

Illustrative arithmetic: 4 týmy × €249 = €996 MRR; 20 × €249 = €4 980; 41 × €249 = €10 209; 8 pilotů × €1 250 = €10 000. To nejsou forecasty. 8 high-touch partnerů potřebuje delivery capacity; není to ekvivalent 41 self-serve teamů. Existing `docs/10K-MRR-REALITY-CHECK.md` už správně rozlišuje base €2k–€5k a upside €10k. Dokument má v jedné sekci i starší €3k–€6k formulaci; hlavní model má používat jediný explicitní scénář. Žádné dnešní revenue ani zákazníky nelze z repozitáře prokázat.

## 6. Acquisition a retence plán

### Prvních 30 dnů — důkaz problému

- 12–20 problémových rozhovorů: 4–5 pro každý host, směs individuální developer a team lead; evidovat konkrétní poslední incident, současnou workaround, frequency a schvalovací pravomoc. Neptat se jen „líbí se vám undo“.
- 8–12 účastníků clean-machine benchmarku s fixture; měřit time-to-first-protected-change, time-to-proof, install abandon a počet assistance kroků. N = 10 není populační conversion rate.
- 3–5 scoped nabídky, první 2–3 placené piloty maximálně v support capacity. Gate ke scale: doložená aktivace, opakovaný use a cenu přijme buyer bez neomezené custom práce.
- Distribution: upstream integration docs, reproduction-based educational content, developer demo, founder network. Outreach žádným nástrojem není v rámci tohoto plánování autorizováno; zde jde pouze o návrh kanálů.

### Retence není čekání na incident

Weekly loop: agent mění → developer ví, co je chráněné → tým přečte evidence a skutečné výsledky → policy se upraví na méně zbytečné friction → další task je snazší. Recovery drill lze jednou měsíčně provést v sandboxu. Weekly digest má uvádět konkrétní outcomes/coverage gaps a úspěšné verifikace, ne strašit počtem „zachráněných katastrof“ bez důkazu.

Expansion path: jeden developer → druhý reviewer → sdílený projekt → druhý environment/effect → další tým. Cross-agent kompatibilita je důvod zůstat při změně hosta, pokud je skutečně otestována. Automatické routine tasks přidávat až při zachování execution boundaries a customer pull.

### Acquisition web: doplňková částečná kontrola

Marketing repo na `85c6792838f5014818d48e93188342cf3c824c8e` má vlastní pricing concept, waitlist a agregované traffic counters; podrobnosti v SURFACES-AUDIT.md §8. Není tam live protected-action meter. Growth měření potřebuje durable lead receipt, source-specific kvalifikaci, activation evidence a consent/privacy. Agregované page hits nejsou unikátní uživatelé ani product retention. Nepřepisovat tuto hranici přidáním skrytého identifikátoru.

## 7. Feature portfolio podle rozhodnutého směru

| Návrh | Customer outcome | Priorita / závislost | Měřitelný acceptance |
|---|---|---|---|
| Installation + doctor pro čtyři hosty | Přidám ochranu bez opuštění hosta | Nejvyšší, shared contract; vybraný host testovat end-to-end | Čistý stroj, known version, diagnostic coverage native/MCP/shell, bez secrets v logs. |
| Filesystem/Git/Postgres proof pack | Rozumím obnově svého workflow | Nejvyšší; nejdřív fixtures a supported effects | Dirty/untracked/concurrent/crash scenarios; nezávislý verifier; žádný fake atomic claim. |
| Coverage/status panel | Vím, co je chráněné | Současně s adaptery | Nezachycený action se netváří jako guarded; unknown má next step; UI/readme stejné capability. |
| Low-friction policy presets | Dokončím rutinní task bez approval loops | Po policy integrity proof | Baseline vs NOMO task time a approvals; žádný scope escalation při retry. |
| Evidence/review bundle | Team lead může doložit změnu | Recurring Team value | Diff/effect/test/refusal/verification scope, redaction, export, named policy version. |
| Org roles + policy sharing | Onboard kolegu a omezím oprávnění | Po pilot feedback, před hosted Team | Tenant + role + revocation negative suite, ownership migration, no implicit operator all-tenants. |
| Outcome eval hooks/export | Lepší outputs doložené task tests | Po bezpečném tool contract | Referenční tasks, test pass, human rating; provider/model změna jen explicitní. |
| Billing + subscription lifecycle | Koupím a zruším nabídku bez autora | Po validated offer | Signed/idempotent/out-of-order webhook; entitlements fail correctly; data/export lifecycle. |
| iOS/nový IDE/RE intelligence | Nové audience/use case | Pozdější volitelné větve | Nejprve prokázat potřebu a opportunity cost; nejsou první-měsíc requirements. |

## 8. Další rozhodovací otázky A/B/C/D

Směr add-on už je zvolen. Pro zbývající rozhodnutí navrhovat varianty s reálným tradeoff, nepokládat znovu otázku na potvrzený směr:

1. První hlavní buyer: A team lead malého SaaS týmu; B platform/security tým; C agent-heavy freelancer; D paralelní rozhovory se všemi, volba po 12–20 interviews.
2. První komerční závazek: A pilot v customer sandboxu s weekly proof; B Local Pro bez support; C hosted Team; D pouze free beta do prokázané 8-week retence. Doporučení A, s free local adoption.
3. Feature pořadí po proof pack: A capability/coverage a install; B org review + evidence; C output evaluation; D provoz a self-serve billing. Doporučení A→B, output hooks dle customer pain, billing po nabídce.
4. Go/no-go po prvním měsíci: A ≥2 placené a opakovaně aktivní piloty; B ≥20 týdenních lokálních users; C ≥1 enterprise buyer-sponsored evaluation; D rozhodnout z kvalitativních findings. Doporučení kombinovat A s activation/retention evidence, ne vanity download cíl.

## 9. Co je stále neznámé

Current revenue/runway, skutečný počet lidí a FTE, přístup k buyerům, aktuální produkční auth/deploy settings, support willingness/cost, live vendor pricing, licence/host adapter boundary pro jednotlivé verze, agent-resistant trust topology a rozsah nezávislé obnovy napříč efekty. Žádná z těchto mezer se nemá maskovat feature roadmapou. Research má pokračovat rozhovory, reprodukcemi a živými primárními docs, až jsou přístupné.
