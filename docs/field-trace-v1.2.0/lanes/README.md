# Lane reports

Eighteen wave-1 lane reports, **verbatim as each lane wrote them**. They are not
edited for consistency: where two lanes disagree, both readings are preserved and
the reconciliation lives in [../README.md](../README.md#corrections-between-lanes).

Two things to know when reading them:

- Several reports reference intermediate working files by name (`census.tsv`,
  `errors.json`, `tool-errors.tsv`, `spawn-graph.txt`, `rebuilt.cjs`, and
  similar) and describe them as being "in this directory". Those were scratch
  artifacts in the analysis session's working directory and are **not** copied
  here — only the reports are. Every claim in a report is sourced to the original
  evidence (transcripts, run dirs, plugin cache, git), not to those intermediates.
- Each lane wrote independently and to its own brief, so severity labels are
  calibrated within a lane rather than across them. The ranking that matters for
  wave 2 is the category ranking in the parent README, not the per-lane
  BLOCKER/HIGH labels.

| file | lane | angle |
|---|---|---|
| `lane-a-plugin-mutation.md` | A | plugin mutation vs `bab279e` |
| `lane-b-mcp-errors.md` | B | tool and MCP call errors |
| `lane-c-loops-stalls.md` | C | loops, stalls, non-termination |
| `lane-d-subagents.md` | D | subagent fleet census and tier conformance |
| `lane-e-run-state.md` | E | run-state and mission integrity |
| `lane-f-efficiency.md` | F | spend and wasted work |
| `lane-g-privilege-escalation.md` | G | delegated privilege escalation |
| `lane-h-guard-evasion.md` | H | guard evasion, behavioural |
| `lane-i-reporting-integrity.md` | I | reporting integrity |
| `lane-j-hook-efficacy.md` | J | hook efficacy — did enforcement help? |
| `lane-k-guardrail-gaps.md` | K | guardrail coverage gaps |
| `lane-l-autonomy.md` | L | autonomy vs human-in-the-loop |
| `lane-m-science-validity.md` | M | scientific validity of the research |
| `lane-n-knowledge-memory.md` | N | knowledge accumulation and citations |
| `lane-o-concurrency.md` | O | concurrency, shared state, storage |
| `lane-p-cross-project.md` | P | cross-project control set |
| `lane-q-context-continuity.md` | Q | context window and compaction |
| `lane-r-environment-hygiene.md` | R | environment, dependencies, secrets |
