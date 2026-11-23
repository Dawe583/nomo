---
trigger: always_on
---

# NOMO subagent routing

When delegation is requested, use only `scout`, `builder`, `orchestrator`,
`ui-designer`, or `verifier`. These project profiles request
`deepseek-v4-1-flash-1017-high`. Do not select built-in profiles or
delegation skills that override the profile's model. Do not change the primary
model to route a subagent.

The profile setting is not proof of the runtime model. Report it as verified
only when run metadata identifies the exact model.
