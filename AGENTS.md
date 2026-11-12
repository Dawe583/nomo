# NOMO agent guidance

For every NOMO task, read `AGENTS.local.md`, `docs/agent-contract.md`,
`.agents/skills/nomo-workflow/SKILL.md` and
`.agents/skills/nomo-pydantic/SKILL.md`.

Supported launchers also load those core skills explicitly:
`scripts/nomo-pi.sh`, `scripts/nomo-omp.sh` and
`scripts/nomo-prime-agent.sh`. Use the native harness tools available to the
current task; do not change global harness settings.
