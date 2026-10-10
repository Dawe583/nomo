# Obchodní plán NOMO: pravdivý opakovaný příjem

## Doporučení

Bezplatné/otevřené lokální jádro používá developer u stávajícího agenta. Zpočátku nabídnout 2–3 team design-partner piloty s jasným workflow, vlastním sandboxem, podporovaným hostem, týdenním outcome review, konkrétním evidence/recovery výsledkem a pevně omezeným support časem. Účtovat měsíčně jen za skutečnou opakovanou službu/team capability; jednorázovou integraci vykázat zvlášť.

Tento model sedí dnešní rozdělení licencí/open-private v `docs/DECISIONS.md`. Před jakoukoli změnou open/paid boundary je nutné nově posoudit licenci, příspěvky a stávající users; žádnou základní feature z free do paid skrytě nepřesouvat.

## Nabídková posloupnost

| Fáze | Uživateli dostupné | Cena / co měřit |
|---|---|---|
| Open beta | Lokální adapter, policy/recovery pro ověřené connectors, standalone verification; explicit exclusions | €0; install→first guarded change→verified restore; BYO model provider, žádný inference margin |
| Design partner | 4–8 týdnů, 1–2 workflows, 1–2 hosty dle matrix, team lead reviewer, weekly report/session, cap 2–4 support hodin týdně podle dohody | Hypotéza €750–€1,500/month + oddělený bounded onboarding fee; neověřená willingness-to-pay |
| Team beta | Org policy/version, member/reviewer identity, approvals, export/retention, coverage matrix, budget/API key lifecycle, transparent support | Stávajících €249/month je hypotéza z product docs, zkusit scope test vůči €149/€249/€499; nezavádět pricing UI před billing/entitlement review |
| Pro individual | Convenience, supported adapter auto-updates, local history backup, better UX/support; ne paywalled undo nebo safety | Možné €15–€29/month jen pokud 10–15 aktivních developerů explicitně platí za value mimo core. Zatím nevytvářet. |
| Enterprise | Self-host/SSO/residency/SLA podle potřeby | Individuálně až s buyer-sponsored deployment a provozním budgetem; nevydávat certifikace/SLA bez důkazu. |

Pilot není předplatné jen podle labelu: renewal podmínit sjednaným deliverable, annual/monthly terms, cancellation a evidence support limits. Peníze za customer-bespoke engineering nepočítat jako MRR. Free limits stanovit nákladovým/security důvodem, ne blokovat základní recovery.

## Revenue equations jsou scénáře, nikoli forecast

- 4 × €249 Team = €996 MRR.
- 20 × €249 = €4 980.
- 41 × €249 = €10 209.
- 8 × €1 250 design partner = €10 000.

Růst přes 41 teams vyžaduje self-service, support bez founder assistance a product-qualified acquisition. Osm partnerů × týdenní seance spotřebuje delivery capacity. Stávající `docs/10K-MRR-REALITY-CHECK.md` už hodnotí €10k jako upside target a €2k–€5k base case při nulové evidenci placených účtů. Ponechat čísla jako scenarios, reforecastovat z vlastních cohort dat. Neexistuje zde ověřený current revenue/runway.

## Prvních 30 dní komerční evidence

1. **6 rozhovorů s používajícími developery** (přinejmenším jeden na host); popis posledního konkrétního error/loss/conflict, jeho frekvence, workaround a čas.
2. **4 rozhovory s potenciálním platícím team lead/platform buyerem:** who buys, budget path, security blockers, proof expected and recurring workflow.
3. **Neslibovat plnou coverage:** pilot explicitně vybere verzi hosta, effect/connector, sandbox a supported scenario.
4. **Nabídnout 3 pilot briefs** s cenou a stop condition. Zamítnutí zaznamenat dle důvodu: pain, install, trust, budget, timing, purchasing. Zaznamenat, zda buyer připomínku přijme bez author support.
5. **Měřit pilot activation** až po první guarded write a VERIFIED export. Waitlist/signup/demo view nejsou activation.
6. Na konci týdne: paid/collected pipeline, pilot hours, time-to-first-value, effect coverage, recovery outcomes, renewal intent, objections a follow-up date. MRR počítat jen ze sjednaných active recurring commitments.

Jestli po 12–20 kvalifikovaných rozhovorech nikdo nepotvrdí weekly workflow ani 2–3 buyers nechtějí scoped pilot, upravit positioning/product direction. Nepřidávat features do nového plánu jen pro teoretické monetizační možnosti.

## Retence

Retenci přináší měnící se projekt, jemuž developer důvěřuje i nadále:

- před každým taskem vidí stejné coverage state;
- review report vybere true changed effects a jejich testy;
- čerstvá editace jiné práce vede ke konfliktu, kterou NOMO bezpečně zachová;
- recovery může kdykoliv ověřit v local sandboxu;
- team pravidla a reviewer evidence se přenesou při změně agenta.

Sledovat weekly protected workspace, 4/8/12-week active cohorts, repeated verified effect, renewal, expansion from one to multiple developers, contributor and host churn. Incident/restore scarcity může snižovat experimentální action count; chráněné routine use měřit separátně.

## Komerční funnel

```mermaid
flowchart LR
    A[Relevantní developer reach] --> B[Install start]
    B --> C[Host připojen]
    C --> D[První zachycená akce]
    D --> E[Diff + tests review]
    E --> F[Recovery fixture ověřena]
    F --> G[Weekly protected use]
    G --> H[Team buyer a paid pilot]
    H --> I[Renewal / další team]
```

V každé hraně uvést N, zdroj leadu, týden cohorty, host/effects a drop-off reason. Z feedu anonymous counter nelze odvozovat unique conversion. Veřejný site waitlist s `stored:false` memory fallback není durable lead; marketing KPI musí vyloučit volatile storage.

## Náklady, support a finanční kontrola

- Měřit cloud DB/workflow retention/export, model provider $/task podle customer key vs NOMO key, storage/vault growth, installer/update signing, GitHub macOS/Windows runner, incident/support engineering hours.
- Brutto marže počítat s support labor jako shadow cost. Limit custom adapters hours na pilot contract.
- Hosted tools provádějí customer write operations: termy jasně odlišují customer-owned credentials, access window, data handling, incident notification a responsabilité. Nezakládat auto billing bez account deletion, offboard, backup/export a proration design.
- Budoucí usage limit nesmí během obnovy zrušit store write/podpis; accounting metering nemá být v critical commit path.
- Inference náklady mít BYOK jako default; pokud hosted shared model, disclose vendor, retention, region a per-account budget before purchase.

## Ekonomické metriky

- contracted MRR, collected MRR, ARR annualized; recurring versus services/setup/grant.
- stage conversion separate warm referral/inbound/OSS/community/technical partner; n minimums and timestamp windows.
- gross margin and contribution margin per tier after storage/inference/support fees.
- support time, time to payback only with CAC evidence; no LTV estimate for tiny cohorts.
- logo/revenue churn, downgrade/cancellation reasons, 4/8/12-week retention.
- runway, infra spend cap, DSO/collection terms to be provided by founder; Git cannot supply them.

## Security/trust prerequisites for paid teams

Org-scoped identity/role, documented effect capture contract, tested per-host matrix, keys/secrets boundary, incident owner, deletion/retention, audit/export completeness anchor, durable backups/restore drills, clear support policy. Security page cannot count cryptographic integrity as proof of who authorized if signer and effect executor are the same compromised principal. External certification/SLA only after actual audit/coverage.
