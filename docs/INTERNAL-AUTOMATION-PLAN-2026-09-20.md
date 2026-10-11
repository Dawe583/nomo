# Historical VOID internal automation and agent capability plan

> Historical proposal from 2026-09-20. Product and go-to-market claims below
> are not current. The NOMO product direction and Harness acceptance gates are
> in the active context, spec and implementation plan.

Date: 2026-09-20
Canonical repository target: `VOID-harness/void`
Baseline reviewed: `main` at `75289f4ce1caf2c6a05feb5fa3337b867c702261`
Status: implementation plan. Items marked “verified now” already exist; all other items are proposed work.

## 1. Goal

Move routine internal work into four Slack agents without letting an agent approve its own consequential action.

The target system should:

1. keep the team’s GitHub state, tasks, plans, decisions, process documents, releases and marketing calendar synchronized;
2. assign realistic work from verified backlog and team capacity;
3. generate evidence-backed product and marketing content;
4. notify the team about every meaningful repository, release, deployment and process event;
5. require human approval before merge, release, deployment, public publication, permission changes or destructive operations;
6. preserve an attributable audit record for every automated proposal and action.

## 2. Verified baseline

### Repository

- `Dawe583/void` was mirrored into `VOID-harness/void` with complete commit history.
- Five branches were copied with matching SHAs: `main`, `GUI-WEB`, `claude/poradna-design-animations-wwbc1l`, `codex/gui-upgrade`, `codex/void-beta`.
- Four desktop beta tags were copied with matching SHAs.
- Existing CI covers Node 24 and 26, typecheck, build, package tests, control-plane tests and four end-to-end programs.
- Separate workflows cover disposable PostgreSQL integration, manifest persistence, Windows desktop build/install smoke and Pages.
- Packages remain private at version `0.1.0`. `docs/RELEASE.md` intentionally blocks public npm release until installable artifacts, protected publishing, real-service checks and release evidence exist.

### Slack agents

- David's Agent, Max's Agent and Coordinator completed live Slack-to-LLM-to-Slack production smokes.
- Oliver's Agent transport exists but has no owner until Oliver joins the Slack workspace.
- Existing runtime already provides tasks, weekly planning, approvals, reminders, standups, decisions, SOP proposals, private drafts, process discovery, knowledge search, project status and read-only GitHub search.
- Existing PostgreSQL, n8n, scheduler, durable outbox, approval buttons and audit log are sufficient. No Kafka, Redis or second task store is needed.
- The Slack Agents runtime now supports multiple owner-scoped GitHub App installations, selected-repository access, active-repository tracking, open and closed work, and deterministic stale-mirror warnings. Production still has only the `Dawe583` installation configured, so `VOID-harness` remains unavailable until the organization installation is approved.
- Agent configuration has drift: repository agent files still reference the retired `tokenrouter/z-ai/glm-5.3-free` route, while workspace policy requires `opencode-zen` by default and token-based providers only through environment or local authentication.

### Product and market

- Product thesis: accountability and reversible recovery for AI-agent writes, not generic project management or another LLM gateway.
- Existing go-to-market plan prioritizes registry pages, weekly reversibility reports, public incident classification, MCP distribution and design partners.
- Public claims must remain tied to executable evidence. Fixture-only behavior is not certification.

## 3. Operating model

Use one shared event pipeline:

```text
GitHub / Slack / Graphify / scheduler
  -> normalized event in PostgreSQL
  -> deterministic policy and ownership check
  -> agent proposal
  -> human approval when required
  -> durable outbox executor
  -> result, evidence link and audit record
  -> Slack notification and weekly metrics
```

Reuse current components:

- PostgreSQL: source of truth for work, approvals, events, releases, campaigns and audit records.
- n8n: orchestration and webhooks.
- Slack agents: interaction and approval surface.
- GitHub App: repository identity and scoped API access.
- GitHub Actions: repository-local verification and release evidence.
- Graphify: architecture and decision context, updated after accepted changes.

Do not add a general event bus, a second workflow engine, a second project tracker or a custom social-media queue.

## 4. Upgraded agent responsibilities

### David's Agent — product and engineering execution

Functional role: Builder. Primary owner: David.

Add these skills:

1. **Backlog engineer**
   - Convert verified gaps, GitHub issues and meeting actions into scoped tasks.
   - Require acceptance criteria, owner, estimate, dependency and evidence command.
   - Reject duplicate work already covered by another issue, plan or package.
2. **Daily engineering brief**
   - Report failing workflows, open pull requests, release blockers, stale branches and today’s approved tasks.
   - Link every claim to GitHub, Graphify or the internal task record.
3. **Change impact review**
   - Query Graphify before multi-package work.
   - Identify affected packages, persisted formats, security boundaries, tests and documentation.
4. **Release evidence preparation**
   - Draft release notes from merged work and verification output.
   - Never tag, publish, merge or deploy. Coordinator handles the release proposal and a human approves it.
5. **Claim audit**
   - Compare website, README and release text with current capability evidence.
   - Open correction tasks when marketing exceeds tested behavior.

Automation level: read and draft automatically; create David’s own tasks on explicit request; cross-owner assignments require owner approval.

### Oliver's Agent — internal operations and compliance

Functional role: Operator. Primary owner: Oliver after Slack onboarding.

Add these skills:

1. **Process miner**
   - Run structured discovery for recurring work.
   - Convert approved answers into versioned SOPs, checklists and templates.
2. **Operational readiness**
   - Track release checklist, credentials that need human renewal, vendor reviews, backups, incidents, access reviews and policy exceptions.
3. **Evidence register**
   - Maintain links to test runs, screenshots, release artifacts, notarization, audits and design-partner evidence.
4. **Risk and blocker triage**
   - Convert unresolved operational blockers into owned tasks.
   - Escalate overdue external prerequisites without inventing a workaround.
5. **Weekly process review**
   - Report manual steps repeated at least twice, their cost, failure mode and whether automation is justified.

Automation level: reminders, evidence collection and drafts automatic; access, credential, legal, financial and policy changes always human-approved.

### Max's Agent — marketing and distribution engine

Functional role: Courier. Primary owner: Max.

Add these skills:

1. **Content research**
   - Pull only verified product evidence, public sources and Graphify context.
   - Separate fact, internal assumption and proposed claim.
2. **Video script studio**
   - Generate hook, 30–60 second script, shot list, on-screen text, captions, thumbnail line, CTA and platform variants.
   - Prefer screen recordings and real ledger/hold evidence over generic AI imagery.
3. **Editorial calendar**
   - Maintain campaign, audience, channel, owner, publish time, approval state, asset state and result metrics.
4. **Content repurposing**
   - Convert one verified technical story into LinkedIn, X, YouTube Shorts, TikTok/Reels and newsletter drafts.
5. **Distribution and follow-up**
   - Prepare replies, design-partner outreach and weekly performance review.
   - Never send outreach or publish public content without approval.

Automation level: research, briefs, scripts, captions and scheduling proposals automatic; public posting and outbound contact approval-gated.

### Coordinator — team planner and GitHub Release Steward

Team agent. No access to private personal memory.

Add these skills:

1. **Complete GitHub change intelligence**
   - Ingest push, pull request, issue, workflow, release, deployment and security-status events for `VOID-harness`.
   - Post immediate alerts for failed protected workflows, force pushes, permission/ruleset changes, failed deployments and release failures.
   - Post compact merge notices and one daily digest for normal activity.
2. **Version planner**
   - Determine the next version from approved change labels and compatibility impact.
   - Keep workspace packages synchronized while the repository remains pre-1.0.
   - Preserve existing desktop tag shape: `desktop-v0.1.0-beta.N`.
3. **Release proposal**
   - Assemble commit range, changelog, migration notes, evidence URLs, artifact digests and unresolved blockers.
   - Create a draft release only after all mandatory checks are green.
   - Tag or publish only after a named human approves the exact release digest.
4. **Repository governance report**
   - Report branch/ruleset drift, stale branches, unreviewed workflow changes, missing CODEOWNERS coverage, dependency alerts and secret-scanning status.
5. **Capacity planner**
   - Use approved tasks, dependencies, absences and 32-hour weekly capacity.
   - Propose plans to each owner. Each owner approves their own plan.
6. **Executive digest**
   - Summarize shipped value, current risks, next milestone, marketing output and decisions needed.

Coordinator must not write product code, approve its own release, bypass branch protection, rewrite Git history or force-push.

### Shared Slack response standard

- Personal identities are exactly `David's Agent`, `Max's Agent` and `Oliver's Agent`; the team agent remains `Coordinator`.
- All application-generated messages, controls, channel metadata, prompts and operational documentation are English. User-authored content remains unchanged.
- Messages use a concise emoji status header, scannable sections, bullets, context/as-of markers and action buttons. Tables are reserved for genuine plan, project and metric comparisons.
- Scheduled briefs state whether they reflect an approved plan or a live deterministic proposal and warn when replanning is required.
- GitHub answers include the mirror synchronization time and a stale-data warning after two hours.
- Rich Block Kit messages always retain a plain-text accessibility and notification fallback.

## 5. GitHub Release Steward design

### 5.1 Canonical repository cutover

1. Treat `VOID-harness/void` as the new canonical repository after team confirmation.
2. Update developer remotes, Vercel project linkage, status badges, repository links and Slack project metadata.
3. Keep `Dawe583/void` unchanged until the cutover is verified. Later make it read-only or archive it with a pointer; do not delete history.
4. Install the existing read-only GitHub App into `VOID-harness` for visibility.
5. Use a separate write-capable installation or separately scoped credentials for release actions. Read-only search must not inherit release permissions.

### 5.2 Permissions

Read installation:

- Repository metadata: read
- Contents: read
- Issues and pull requests: read
- Actions/workflow runs: read
- Deployments and commit statuses: read
- Security alerts: read only if organization policy allows it

Release executor:

- Contents: write only for approved tag/release operations
- Pull requests: write for release PRs
- Releases: write
- No organization administration, member management, secrets write or ruleset bypass

Use short-lived installation tokens. Never store a personal access token in repository, Slack, browser storage or logs.

### 5.3 Event and notification policy

Immediate `#agent-ops` alert:

- required workflow fails on `main`;
- deployment fails or rolls back;
- force push or branch deletion;
- release action fails;
- secret-scanning or dependency alert becomes critical;
- GitHub App permission or organization ruleset changes.

Immediate `#project-ops` notice:

- pull request merged;
- release candidate created;
- release approved, published or deprecated;
- milestone blocked.

Daily digest at 16:45 Europe/Prague:

- commits and merged pull requests;
- open pull requests and review age;
- open issues by priority and owner;
- workflow and deployment status;
- version recommendation and changelog delta;
- decisions required.

Weekly digest Friday 15:30:

- shipped capability with evidence;
- version and release status;
- unresolved release blockers;
- repository health and stale branches;
- work completed versus approved plan.

### 5.4 Version policy

Until 1.0:

- Keep all workspace package versions synchronized.
- `PATCH`: compatible fix, docs correction or internal hardening with no persisted-format change.
- `MINOR`: new compatible capability, connector or user-visible workflow.
- `MAJOR` remains `0`; any breaking API, policy, ledger or snapshot change requires explicit migration notes and a human decision.
- Desktop prereleases use `desktop-v<version>-beta.<N>`.
- Never replace a released tag. Deprecate a bad artifact and issue a new version.

Release gate:

1. clean reviewed commit;
2. required CI and integration workflows green;
3. migration and compatibility notes complete;
4. secret scan clean;
5. artifact list and digests complete;
6. current limitations preserved;
7. exact release digest approved by a named human;
8. draft release promoted and result reported to Slack.

## 6. Marketing automation

### 6.1 Content record

Each content item needs:

- campaign and objective;
- audience and funnel stage;
- evidence links;
- claim classification: verified fact, internal assumption or opinion;
- master script and platform variants;
- asset owner and deadline;
- approval state;
- scheduled time and platform post identifier;
- impressions, watch time, completion rate, clicks, replies, qualified conversations and resulting first-hold activations.

Do not optimize for raw post volume. Primary conversion metric remains a team reaching its first protected hold.

### 6.2 Video format

Default 35–55 seconds, 9:16, captions always on.

```text
0–3 s   concrete failure or question
3–10 s  why ordinary logs or git revert are insufficient
10–32 s real VOID screen or terminal evidence
32–45 s result and honest limitation
45–55 s one CTA
```

Every script includes:

- spoken text;
- shot list;
- exact product state to record;
- on-screen captions;
- thumbnail line;
- LinkedIn, X and Shorts copy;
- evidence source;
- claims that require human review.

### 6.3 First five videos

1. **“Your AI deleted production rows. Can you undo the action, not just the code?”**
   - Show a held Postgres delete, deny it, then show the signed ledger receipt.
   - CTA: run the local hold demo.
2. **“Git revert is not agent undo.”**
   - Contrast source rollback with an external database mutation.
   - CTA: inspect VOID’s R0–R3 model.
3. **“Four classes of AI-agent actions in 40 seconds.”**
   - R0 direct inverse, R1 before image, R2 mitigation, R3 irreversible.
   - State that class depends on target facts, not tool name.
4. **“The approval prompt most tools hide.”**
   - Show tool, arguments, blast radius, rule, before/after and hold decision.
   - State that approval identity is still a release boundary where not implemented.
5. **“We tampered with the agent ledger.”**
   - Run verification, change one record, show first failing sequence.
   - Explain tamper-evident, not tamper-proof.

### 6.4 Weekly publishing cadence

All times Europe/Prague. Change times only after four weeks of measured results.

- Monday 10:00: technical idea and evidence selection in `#idea-intake`.
- Monday 16:00: approved production brief and asset checklist.
- Tuesday 15:30: LinkedIn technical post; 16:00 X thread.
- Wednesday 17:00: Short/Reel/TikTok video 1; publish only after account-specific approval.
- Thursday 15:30: registry or incident classification post; 16:00 X variant.
- Friday 14:00: Short/Reel/TikTok video 2 or product build log.
- Friday 16:00: performance review and next-week hypotheses.
- Newsletter: every second Thursday after at least two published evidence-backed stories exist.

Platform constraints:

- TikTok Direct Post needs approved `video.publish`; unaudited clients are private-only.
- YouTube uploads need OAuth and unverified API projects default to private viewing until audit.
- LinkedIn organization posting needs an authorized page role and `w_organization_social`.
- X posting needs user-context write scope; media uploads happen before post creation.
- Instagram/Reels requires a professional account, asynchronous media processing and account-specific publishing authorization.

Phase one creates drafts and a calendar only. Enable direct publishing per platform after OAuth setup, platform review, dry-run evidence and an approval gate.

## 7. Work assignment

Week: Monday 2026-09-21 through Sunday 2026-09-27. Current configured capacity is 32 hours each for David and Max. Oliver is not yet a configured Slack person; his plan remains blocked until onboarding.

### Monday 2026-09-21

David / David's Agent:

1. Confirm `VOID-harness/void` as canonical and audit all links/deployments that still point to `Dawe583/void` — 2 h.
2. Approve the pre-1.0 version policy and release gate in this document — 1.5 h.
3. Select one honest product proof for the first video and reproduce it locally — 2.5 h.
4. Review current release blockers R00, R02, R03, R04 and choose one next vertical slice — 2 h.

Max / Max's Agent:

1. Produce script, shot list, captions and platform copy for “Git revert is not agent undo” — 2 h.
2. Build a ten-company design-partner prospect list using the criteria in `GO-TO-MARKET.md`; do not contact anyone — 2 h.
3. Prepare the first-week editorial calendar and asset checklist — 1.5 h.
4. Review every claim in the first script against repository evidence — 1 h.

Oliver / Oliver's Agent, blocked until Slack onboarding:

1. Join Slack and bind Oliver's Agent to Oliver’s user identity — 0.5 h.
2. Audit the release runbook and produce a short external-prerequisite register — 2 h.
3. Inventory social account owners, OAuth status and publishing permissions without collecting secrets — 1.5 h.

Coordinator:

- Deliver morning briefs.
- Collect approvals for task ownership and weekly plans.
- Post repository mirror evidence.
- Report missing GitHub organization installation and Oliver onboarding as blockers.

### Rest of week

Tuesday:

- David: canonical-repository cutover changes and ruleset proposal.
- Max: record/edit video 1, prepare LinkedIn and X variants.
- Oliver: release evidence register and recurring access-review SOP.
- Coordinator: PR/workflow digest and Wednesday capacity check.

Wednesday:

- David: implement or scope the selected release-critical vertical slice.
- Max: publish approved video 1 and log platform identifiers; otherwise keep approved drafts ready.
- Oliver: map manual internal processes and rank automation by hours saved and risk.
- Coordinator: midweek plan variance and blocker escalation.

Thursday:

- David: verification evidence and technical registry story.
- Max: video 2 script and design-partner outreach draft.
- Oliver: review incident, backup and credential-renewal procedures.
- Coordinator: release-candidate readiness report; no release without approval.

Friday:

- David: integrated gate run, claim audit and next engineering decision.
- Max: approved build-log content and weekly marketing metrics.
- Oliver: operations review and next-week SOP proposals.
- Coordinator: weekly review, plan-versus-result, repository health and next-week draft.

Weekend:

- No planned capacity. Only urgent incident notifications. Weekly draft may run Sunday 18:00 but requires each owner’s approval before publication.

## 8. Minimal implementation backlog

### Phase A — visibility, one to two days

1. Install read-only GitHub App into `VOID-harness`.
2. Remove retired hard-coded model routes from every agent configuration; set the workspace-approved default and keep credentials out of Git.
3. Verify agent display names, avatars, ownership and production model identity after the Slack owner signs in.
4. Configure the implemented multi-installation GitHub sync for `VOID-harness` after the organization installation is approved.
5. Add workflow, release and deployment status ingestion.
6. Add GitHub event digest jobs and Slack notification templates.
7. Update Graphify after accepted `main` changes and expose query results through the existing knowledge path.

Exit proof: Coordinator reports organization branches, open work, latest workflow status and current release version with links; no write permission exists.

### Phase B — release proposals, two to four days

1. Add release-candidate records and deterministic version calculation.
2. Generate changelog from an exact commit range.
3. Bind approval to repository, commit SHA, version, evidence digest and artifact list.
4. Add separate release executor with minimal permissions.
5. Create draft release; tag/publish only after approval.

Exit proof: disposable repository release goes from approved commit to draft and published prerelease; changed digest invalidates approval; agent cannot merge or bypass rules.

### Phase C — marketing studio, three to five days

1. Add campaigns, content items, platform variants and performance records.
2. Add evidence-backed brief and video-script tools.
3. Add editorial calendar and approval blocks.
4. Generate, but do not publish, the first five scripts.
5. Store final approved assets outside Git history if they are large; repository keeps manifests and scripts.

Exit proof: one technical proof creates consistent LinkedIn, X and video drafts with source links and approval state.

### Phase D — platform publishing, per platform

1. Connect one platform at a time with OAuth.
2. Add private/unlisted dry run and fetch resulting post status.
3. Add approval bound to exact content hash, account and scheduled time.
4. Publish through durable outbox with idempotency key.
5. Store post ID, result and metrics.

Exit proof: duplicate delivery cannot duplicate a post; expired approval cannot publish; changed content requires new approval.

### Phase E — optimization after four weeks

- Compare content themes by qualified conversations and first-hold activations.
- Retire low-signal formats.
- Adjust posting time only with enough observations.
- Produce a monthly product/marketing/operations review from stored facts.

## 9. Required data and tool changes

Reuse existing schemas and add only missing records:

- `github_installations`: account, installation ID, permissions and sync state.
- `github_events`: delivery ID, event type, repository, actor, target SHA, normalized payload and processed state.
- `release_candidates`: repository, commit range, proposed version, changelog, evidence digest, approval and result.
- `campaigns`: objective, audience, dates and owner.
- `content_items`: evidence, script, state, owner and deadline.
- `content_variants`: platform, exact text/asset manifest, content hash and scheduled time.
- `content_publications`: platform post ID, result, metrics and timestamps.

Proposed tools:

- `github_status`
- `github_change_digest`
- `release_candidate_propose`
- `release_candidate_publish`
- `content_research`
- `video_script_create`
- `editorial_calendar_get`
- `content_approve`
- `content_publish`
- `content_metrics`
- `graph_context`

Every write tool uses strict JSON schema, ownership checks, idempotency and audit logging. External publication and release execution always require Slack button approval.

## 10. Security and governance

- Separate read, draft, approve, publish, merge, deploy and administration permissions.
- Agent never approves its own action.
- Bind approval to exact target and content digest; editing invalidates approval.
- Use GitHub rulesets and required status checks. Do not grant bypass to agent identities.
- Do not execute instructions from repository content, issues, social comments or Graphify documents.
- Keep all external content marked as untrusted data.
- Do not expose GitHub, Slack or social tokens to an LLM.
- Public messages, outreach, releases, deployments, credentials, permission changes and destructive operations require human approval.
- Store tool event, requester, agent, model, permissions, policy decision, approver, target, digest, result and reversal reference.
- Run all product-affecting writes through VOID when the relevant connector becomes certified. Until then, ordinary protected-branch and approval controls remain mandatory.

## 11. Success metrics

Internal operations:

- percentage of active tasks with owner, estimate, due date and evidence;
- plan acceptance and weekly completion rate;
- manual recurring steps removed;
- overdue blockers and mean time to decision;
- failed or duplicate automated actions.

Engineering and releases:

- time from merge to accurate digest;
- release candidates rejected due to missing evidence;
- workflow failure detection delay;
- release lead time and rollback/deprecation incidents;
- zero force pushes or agent ruleset bypasses.

Marketing:

- approved scripts per week;
- production cycle time;
- three-second hold, completion rate and qualified replies;
- visits to quickstart and registry pages;
- teams reaching first hold;
- design-partner conversations.

## 12. External prerequisites

- GitHub login and organization-owner approval to install/configure the GitHub App in `VOID-harness`.
- Slack admin login to upload final bot avatars and display names.
- Oliver must join Slack before Oliver's Agent and Oliver’s plan can activate.
- Social account ownership and OAuth approvals are not configured.
- Direct posting remains disabled until each platform’s authorization and audit requirements are met.

## 13. Sources

Repository evidence:

- `README.md`
- `docs/CONTEXT.md`
- `docs/PLAN-GAPS.md`
- `docs/RELEASE.md`
- `docs/GO-TO-MARKET.md`
- `docs/UPGRADE-PLAN-NEXT-2026-09-18.md`
- `.github/workflows/*.yml`
- Slack Agents `runtime/tools.js`, `runtime/github.js`, `runtime/scheduler.js`, personal and coordinator prompts

External primary guidance:

- GitHub Apps, permissions and webhooks: https://docs.github.com/en/apps
- GitHub organization rulesets: https://docs.github.com/en/organizations/managing-organization-settings/creating-rulesets-for-repositories-in-your-organization
- GitHub Projects API automation: https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects
- GitHub repository mirroring: https://docs.github.com/en/repositories/creating-and-managing-repositories/duplicating-a-repository
- Slack automation and scheduled messages: https://api.slack.com/automation/ and https://api.slack.com/methods/chat.scheduleMessage
- NIST AI RMF and Agentic AI: https://www.nist.gov/itl/ai-risk-management-framework and https://www.nist.gov/agentic-ai
- TikTok Content Posting API: https://developers.tiktok.com/docs/en/content-posting-api-get-started
- LinkedIn Posts API: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
- YouTube `videos.insert`: https://developers.google.com/youtube/v3/docs/videos/insert
- X create post API: https://docs.x.com/x-api/posts/create-post
