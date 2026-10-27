# NOMO x YC: project reuse audit

> **Scope:** NOMO, Papayai, and repositories created on or after 2026-09-27. This is a repository and README review, not a full security, license, or code reuse approval. Recheck exact commits before integrating anything.

## Executive result

Use NOMO as the control and evidence layer only where an actual workflow needs managed agent actions. Use Papayai as a possible founder-only dogfood surface for one internal workflow. Do not treat Papayai as a customer-validated product or as a zero-egress/private deployment: its current README says operational data lives in Supabase and lists direct calls to a hosted NVIDIA model for its Hunter automation.

The strongest recent code candidates are Leadora for document retrieval and citations, aether/OpenMuse for interaction patterns, `slack-mcp-vercel` for a bounded connector, and `prime-agent` for a later training/evaluation experiment. None is approved as a dependency. First audit its current code, license, security boundary, data handling, and test status. Readme claims are not production evidence.

## Confirmed local project facts

### NOMO

The local `docs/CONTEXT.md`, current README, product spec, and capability map agree on the target: Agent Identity and Fleet Control Plane for MCP-capable agents, a shared coding-agent Harness, identity and scope checks, policy, approval, and minimal durable evidence. They also state that distributed fleet identity runtime and product-v1 capability gates are not complete. The local demo is not standard OAuth, production, distributed revocation, or market proof. Code and release gates override this strategy memo.

**Implication:** do not describe all fleet-control claims as shipped. For the first customer workflow, reuse only code paths that pass their existing acceptance gates. A bounded local demo may be enough to test the application workflow, but not to sell a hosted enterprise control plane.

### Papayai

The local README describes a single-owner operational dashboard for jobs, clients, finance, promises, deadlines, capture, inbox, and notes. It explicitly says it is not a product for sale, not a team, and not accounting software. The current app is a static PWA whose operational database is Supabase. The README says offline use preserves only the application shell, not business data. It also records an unconfirmed NVIDIA API path for the Hunter automation and says real inference has not been verified.

**Implication:** Papayai can reveal which internal task David himself repeats, and can serve as a controlled workflow surface with synthetic or separately approved data. It cannot prove that an external buyer wants the same workflow. It does not currently establish a fully local data boundary. Do not send Papayai records to a new model or use them as training/evaluation fixtures without a data-flow, permission, and minimization review.

## Recent repository inventory

GitHub search for `user:Dawe583 created:>=2026-09-27` returned 14 repositories. This date range is based on GitHub repository creation date, not latest activity. Relevance below comes from README-level review.

| Repository | Relevance to this thesis | Safe current conclusion |
|---|---|---|
| `Leadora` | High, document assistant and RAG candidate | README describes an enterprise technical-docs assistant on Next.js, Supabase, and OpenAI. Audit tenant isolation, source provenance, retention, licensing, and test status before reuse. |
| `aether` | Medium, persistent personal agent patterns | README describes cross-channel memory and proactive actions with approvals. It may overlap with a general personal operating agent. Keep separate from this B2B workflow until there is evidence of shared users or code. |
| `openmuse` | Medium, agent experience and harness portability | Public README describes a browser/terminal/files agent, persistent work, and harness compatibility. Treat as reference or prototype candidate, not a secure enterprise runtime. |
| `prime-agent` | Medium, later model improvement research | Public README describes a self-improving RLM Harness. It is not required to prove demand; defer until a real workflow yields a measurable quality gap. |
| `slack-mcp-vercel` | Medium, bounded integration | README exposes Slack and Discord read/write tools through a Vercel-hosted MCP endpoint. Any reuse needs scopes, secret handling, approval, audit, and tenant-boundary review. |
| `nomo-web` | Low, template reconstruction | README describes a licensed template reconstruction. It does not appear to add the proposed workflow or governance capability. |
| `gstack` | High for process, none for runtime product | Use its founder, research, design, engineering, security, and evaluation workflows. Do not ship its skills as customer product features. |
| `leseni-novak` | Unknown | README was not found through the connected file API. Repository existence is not evidence of a reachable operator, customer relationship, or pilot. Ask the founder before using it as a route to customers. |
| `Socialist` | Low | README describes an Apify LangGraph scraper template, not the proposed internal workflow. |
| `AstroPhysics-exoplanets` | None identified | Astronomy research project; no overlap with this product thesis found in README review. |
| `exotic-compact-objects` | None identified | Astronomy research project; no overlap found. |
| `astro-science` | None identified | Scientific research environment; no product overlap found. |
| `AstronomicAL-astro-science` | None identified | Local human-in-the-loop scientific data exploration application. Different user, domain, and purchase. |
| `piworkspace` | None identified | Empty repository; no code or README to evaluate. |

The complete GitHub account contains older repositories, deliberately excluded from this review per founder scope. No conclusion about those repositories is needed for this product decision.

## Reuse order

1. **NOMO:** map policy, approval, proxy, Harness, and ledger capabilities to the exact code and accepted release gates. Build no duplicate identity layer.
2. **Papayai:** shadow one owner workflow with synthetic records or an explicit data-minimized experiment. First identify a task where the founder personally feels a recurring cost. Keep it separate from a market claim.
3. **Leadora:** inspect one implementation path only after one selected customer workflow needs document retrieval. Do not migrate its entire app or infrastructure speculatively.
4. **Slack MCP:** add only if a buyer workflow actually starts or ends in Slack. Keep write calls disabled until policy and approval gates are validated.
5. **Aether/OpenMuse/Prime Agent:** compare designs and interfaces after the product task is defined. Reuse a library only after ownership, license, security, and maintenance checks.

## Asset truth table

| Asset | Verified from files | Not established |
|---|---|---|
| NOMO | Product direction, bounded demo design, proxy/policy/ledger contracts, code and release plans | Full production fleet runtime, complete standard MCP OAuth path, broad hosted readiness, demand |
| Papayai | Personal operational PWA, actual Supabase data layer, candidate internal records and workflows | Team product, local-only data, customer demand, reliable local model runtime |
| Leadora | README product positioning, named technologies and hosted model dependency | Current code quality, tenant isolation, provenance accuracy, security, license rights, activity |
| New agent repos | Readme-level product or template descriptions | Fitness to merge into NOMO, operational safety, customer use, licensing compatibility |

