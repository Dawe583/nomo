# NOMO Specification

Status: Draft v0.1
Formerly: VOID
Scope: Architecture, components, stack, and current priorities for the NOMO agent identity and fleet control plane.

## 1. Product identity

NOMO (formerly VOID) is an Agent Identity and Fleet Control Plane. It gives every AI agent in an organization a verifiable identity, enforces runtime guardrails on what the agent may do, records every tool call and write in a tamper-evident ledger, and lets operators see and stop the fleet from one place.

Tagline: "Every agent accounted for."
Subtitle: "Identity, guardrails, and control for the agent fleet."

Principle: the write path must be more accountable. A feature that does not make agent actions more identifiable, governable, observable, or stoppable does not belong in NOMO core.

## 2. Goals and non-goals

Goals:
- Every agent action that touches an external system is attributable to a registered agent identity.
- Every action is classified by risk before it executes, and policy decides whether it proceeds, is held, or is refused.
- The audit trail is append-only and tamper-evident, and can be verified by a third party.
- Operators can see the state of the whole fleet and halt any agent immediately.

Non-goals (for this version):
- NOMO does not replace the agent runtime or the model provider.
- NOMO does not invent business intent. It governs the calls agents make.

## 3. Architecture components

### 3.1 Ephemeral tokens and IAM

Agents never hold long-lived credentials. Each agent receives short-lived, ephemeral tokens bound to its registered identity.
- Token lifetime: 60 seconds. The 60-second token lifetime has been verified in a proof of concept.
- Every token maps to exactly one registered agent identity and its granted scopes.
- Expired tokens are refused. Renewal requires the agent to still be registered and not killed.

### 3.2 Runtime guardrails: action classification R0 to R3

Every tool call is classified by the reversibility and severity of its effect, based on the state of its target. A class belongs to a call, not to a tool.
- R0 (read): no state change. Allowed under normal policy and always logged.
- R1 (reversible write): changes state, with a known inverse that restores the prior state. Logged with the inverse recorded.
- R2 (reversible with trace, or mitigable only): changes state with no exact inverse. Mitigation or compensation is required, and the action is logged with a trace.
- R3 (destructive write, or irreversible): deletes or changes state with no recovery path. Default policy holds or refuses it pending explicit approval.

Policy decides for each class: allow, hold for human decision, or refuse. Classification is evaluated per call against the target state, and uncertain state is treated as the more restrictive class.

### 3.3 Tamper-evident ledger

The ledger is a hash-chained, append-only audit log of all tool calls and writes.
- Each entry contains the call, the agent identity, the class, the policy decision, the result, and the hash of the previous entry.
- Entries are signed. The ledger exposes append and read operations only, never update or delete.
- Verification recomputes the chain and reports the first broken link.
- Enforcement modes:
  - Fail-closed (default): if the ledger cannot record a call, the call does not execute.
  - Observe mode (for trials): calls execute and are recorded, and policy violations are reported without blocking. Observe mode must be shown in the UI and in the audit record as a non-enforcing state.

### 3.4 Fleet dashboard and kill-switch

The fleet dashboard shows centralized telemetry for all registered agents: identity, status, recent tool calls, classes, holds, refusals, and ledger health.
- Kill-switch: an emergency control that immediately revokes an agent's tokens and blocks further calls from it. A kill is recorded in the ledger.
- The kill-switch must act on the enforcement path, not only on the UI, and it must take effect within the 60-second token lifetime at the latest.
- Live event stream: the dashboard consumes the ledger event stream in near real time.

### 3.5 Coding harness and MCP proxy spine

The spine is the component that sits between an agent and the tools it can write to. It intercepts each tool call, classifies it, applies policy, forwards, holds, or refuses it, and appends the record to the ledger.
- The spine is open source under Apache-2.0.
- The control plane (fleet management, policy administration, approvals, dashboard, and hosted ledger services) is closed source.
- The boundary between spine and control plane is a stable interface. The spine must run without the control plane for local and self-hosted use, with enforcement and ledger behavior unchanged.

## 4. Stack

- Language: TypeScript across the monorepo.
- Runtime: Node.js 24 or later.
- Monorepo: pnpm workspaces.
- Frontend: React 19, Vite 7, Tailwind CSS v4.
- API server: Express 5.
- Database: Neon PostgreSQL with Drizzle ORM.
- Platform services: Supabase.

## 5. Current priorities (Day 2 spikes)

- Spike A, owner David: link the proxy with the tamper-evident ledger and agent registration. Done when a registered agent's tool call passes through the proxy, is classified, and produces a verifiable ledger entry.
- Spike B, owner Max: connect the event stream to the UI and implement the kill-switch button. Done when pressing the button revokes the selected agent's access and the UI reflects the state from the event stream.
- Spike C, owner Oliver: create a mock agent for tool-call testing and policy tuning. Done when the mock agent can exercise R0 to R3 calls and the resulting policy decisions can be reviewed and adjusted.

Open questions to resolve during the spikes:
- Exact format and signing scheme of ledger entries.
- Hold workflow and the approval channel for R3 calls.
- Scope model for agent registration and how scopes map to tool surfaces.

## 6. Acceptance criteria for this specification

- Each component in section 3 has a stated behavior, default, and failure mode.
- Fail-closed is the default ledger mode, and observe mode is available only for trials.
- Kill-switch behavior is defined at the enforcement layer, not only the UI.
- Every spike has an owner and a done condition.

## 7. Change control

This document is the source of truth for NOMO architecture. Changes are made through pull request. When code and this document disagree, either the code is fixed or this document is updated in the same change. Do not diverge silently.
