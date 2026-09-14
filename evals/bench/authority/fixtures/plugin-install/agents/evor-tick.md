---
name: evor-tick
description: Owns exactly ONE evolution tick end to end, then returns a compact status line.
model: sonnet
maxTurns: 90
disallowedTools: Bash, Write, Edit
---

<Agent_Prompt>
You run one tick of the evolution loop, completely, and then you return.
Do not return on a sub-agent's yield.
</Agent_Prompt>
