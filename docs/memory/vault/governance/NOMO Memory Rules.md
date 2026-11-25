---
title: NOMO Memory Rules
aliases:
- NOMO Memory Policy
tags:
- nomo
- governance
- memory-policy
status: current
---

# NOMO Memory Rules

## Allowed project memory

- Obsidian notes in this vault hold product decisions, project status, roadmaps and handoff notes.
- Graphify holds code relationships and source-grounded architecture lookup. Its machine outputs live under `Graphify-Index/graphify-out/`, outside the repository.
- Repository context, standards, specs and code contracts remain versioned with the project. They are not replaced by duplicated chat memory.

## Do not store

- ChatGPT or Codex project memory, full conversation transcripts, secrets, API keys, user credentials, production data or personal data.
- All project content in one Graphify output folder. Human-readable project memory belongs in Obsidian notes.

## Update rule

Record only durable, verified facts, decisions, open risks and current work status. Link to source documents. Update the work log when a milestone commits or a blocker changes. Do not silently turn a hypothesis into a decision.

## Resource-conscious verification

- Run no more than one Node or Playwright test process at a time, at low priority.
- Avoid repeating a long CLI test without a concrete new reason. If a targeted test does not exit, stop it and investigate the open handle from source before running more tests.
- Aim to keep total active CPU below 80%. `taskpolicy` and `nice` lower priority but do not impose a hard CPU cap. `pmset -g therm` reports thermal pressure, not temperature.

## 🔗 Governance relationships

- [[Governance Map]] is the navigation hub.
- [[NOMO Decisions]] stores accepted choices under these rules.
- [[Product and Strategy Map]], [[Delivery Map]], and [[Work Log Map]] are governed areas.
- Templates under `Templates/` connect consistent note creation to this policy.
