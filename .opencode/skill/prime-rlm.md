---
description: "Use when driving prime-agent's Python RLM kernel programmatically: rlm() child spawns, agent_message, list_subagents, bash(), and the ipython tool. For advanced orchestration through the daemon."
---

# prime-agent RLM recipes

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

## Known limits on this machine (2026-09-08)

- Free model glm-5.3-free: 8 req/min, so parallel children hit 429 and some
  return empty. Spawn one child at a time.
- Paid OpenRouter models through the operator key: 402 (max_tokens 32k
  rejected, max_tokens not settable via rlm). Not usable for children.
- The operator's opencode runs on the same tokenrouter key; coordinate spawn
  bursts between opencode and prime-agent or they eat each other's quota.
