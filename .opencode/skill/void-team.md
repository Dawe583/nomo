---
description: "Use when orchestrating VOID subagent teams through prime-agent: spawning background agents, autonomous runs with gates, sending follow-ups, attaching, and collecting evidence. Mirrors prime-agent's RLM subagent model for opencode."
---

# VOID team orchestration via prime-agent

Every command below was written against prime-agent 0.9.3 on macOS, where it
lives at /Users/dawe/.local/bin/prime-agent. On any other machine, including
Windows, prime-agent is not installed and none of these commands run; check
`Get-Command prime-agent` or `which prime-agent` before planning a team on it.

The model this skill used to name, `tokenrouter/z-ai/glm-5.3-free`, is
DEAD. TokenRouter was removed from this repository on 2026-09-18; see
AGENTS.local.md. Do not pass it to anything. Subagents run on
`opencode/space-bunny-free`, and every agent file under `.opencode/agent/`
carries that model in its frontmatter.

For parallel teams use the opencode Task tool. It needs no daemon, no socket
and no rate-limit coordination, because every subagent inherits the session
model. Give each a disjoint file list and require a verification command, and
never let two of them edit the same tree.

## Spawning a background team member (one at a time)

Detached agent that survives this session:

    prime-agent send --from opencode-principal <agent-name> "<task>"

To create a new named agent in daemon mode:

    prime-agent --mode daemon --cwd /Users/dawe/Developer/Claude-Projects/VOID \
      --autonomous --autonomous-max-turns 24 \
      --daemon-socket /var/folders/7x/j48g50ds3qb8vwhsfcbccl5c0000gn/T/prime-agent-501/daemon.sock \
      --goal "<one sentence objective>" -p "<task>" &

Simplest reliable pattern: run a one-shot print job in the background with
nohup and capture output to a log file, one at a time:

    nohup prime-agent -p --cwd <worktree> "<full task brief>" > /tmp/<name>.log 2>&1 &

Then poll: tail /tmp/<name>.log

## Autonomous runs with completion gates

    prime-agent -p --autonomous \
      --autonomous-gate "pnpm run typecheck" \
      --autonomous-gate "pnpm --filter @void/<pkg> test" \
      --autonomous-max-turns 24 \
      --autonomous-gate-retries 3 \
      --cwd <worktree> "<task>" > /tmp/<name>.log 2>&1

Gates run in the worktree after the agent finishes; the run passes only when
every gate passes. This is the adversarial-verification hook: add a gate per
exit criterion.

## Steering a busy agent

    prime-agent send --steer <agent-name> "<message>"

## Listing and observing

    prime-agent list
    prime-agent list --json
    prime-agent attach <agent-name>   # interactive, needs a TTY

## Session evidence

Session JSONL files live in ~/.prime/agent/sessions/. Each message event has
id, parentId, timestamp, message.role, message.content[] with types text,
thinking, toolCall, toolResult. Parse with python3 json to extract evidence.

## Rules inherited from the repo

One workflow one clear question. Structured outputs between stages. Every
subagent states what it did not verify. No production credentials ever.
Worktree isolation for parallel writers: git worktree add ../void-<name>
<branch>. NEVER let two agents edit the same tree.
