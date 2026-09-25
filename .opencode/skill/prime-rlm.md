---
description: "Use when driving prime-agent's Python RLM kernel programmatically: rlm() child spawns, agent_message, list_subagents, bash(), and the ipython tool. For advanced orchestration through the daemon."
---

# prime-agent RLM recipes

prime-agent is not installed on this machine. It lived on the author's macOS
host and these recipes are kept for reference only. Verify it exists before
relying on any of it: `Get-Command prime-agent` on Windows, `which
prime-agent` elsewhere. For parallel subagent work here, use the opencode Task
tool instead; see `.opencode/skill/void-team.md`.

prime-agent's model works inside a persistent Python kernel. From a prime-agent
session, children are native:

    handle = await rlm("Review X for security issues", name="sec-review")
    print(handle.rlm_child_id, handle.name, handle.session_dir)

Spawn returns immediately; results arrive via agent_message replies or files.
Follow up with a retained child:

    await agent_message.send("Check the new test.", receiver_role="child", receiver_name=handle.name)

List and delete:

    children = await rlm.list_subagents()
    await rlm.delete_subagent(children[0])

Shell per call, kernel state persistent across calls:

    result = await bash("pnpm run typecheck")
    print(result.output)

## Known limits (recorded 2026-09-08, updated 2026-09-25)

- The provider this skill used to rely on, `tokenrouter/z-ai/glm-5.3-free`
  (~8 requests per minute, so parallel children hit 429 and some return
  empty), is DEAD. TokenRouter was removed from this repository on
  2026-09-18; see AGENTS.local.md. Do not pass it to anything.
- Paid OpenRouter models through the operator key: 402 (max_tokens 32k
  rejected, max_tokens not settable via rlm). Not usable for children.
- opencode and prime-agent no longer share a key, so there is no quota to
  coordinate. Every opencode subagent in this repository runs on
  `opencode/space-bunny-free`.
