---
description: "Spawn a NOMO team member through prime-agent in daemon mode with autonomous gates"
agent: nomo-principal
---
Spawn a prime-agent team member for: $ARGUMENTS

Steps:
1. Read the task brief below from the user arguments.
2. Create a worktree if the task edits files:
   git worktree add ../nomo-<role> -b claude/<wp>-<role> 2>/dev/null || true
3. Launch ONE prime-agent run (rate limit: 8 req/min on the free tier), in
   autonomous mode with the repo gates:
   nohup prime-agent -p --autonomous \
     --autonomous-gate "pnpm run typecheck" \
     --autonomous-max-turns 24 --cwd <worktree> "<brief>" \
     > /tmp/prime-<role>.log 2>&1 &
4. Poll the log and report when the run completes with gate results.
5. Collect evidence: changed files, test output, what was not verified.
