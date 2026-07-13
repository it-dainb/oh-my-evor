---
name: evor-mcp
description: >
  Evor MCP tool catalog, run lifecycle, artifact schemas, and native-tool guide.
  Auto-loads when operating an evor run — setting up/running/resuming/inspecting
  a mission, recording nodes/evals, launching or watching training, reading/writing
  tick artifacts, citing papers, emitting/querying signals, or changing any evor state.
user-invocable: false
---

# Evor MCP Reference

## The Law

1. **To change evor state, lineage, or compute — call an `evor_*` MCP tool.** Never write `.evor/` directly. The guard denies direct writes and names the correct tool.
2. **For everything the platform already does well — use the native tool** (see [Native Tools](#native-tools)). Do not reinvent it in MCP.
3. **Before acting, read the upstream artifact via `evor_read_artifact`.** If the read returns an error object, the upstream step has not run — stop and surface the gap; do not fabricate.

`.evor/worktrees/<node_id>/**` is Forge's code surface — edit freely. Marker files (`.env`, `.deps-ok`, `.uv-ok`, `.workspace-class`, cache markers) are also writable.

---

## Tool Catalog

All tools are deferred. Load them with `ToolSearch("select:evor_<name>,…")` before first use.

### Lifecycle
| Tool | Purpose |
|---|---|
| `evor_init_run` | Construct and atomically write all run artifacts; returns run_id |
| `evor_validate` | Validate goal-contract schema, metric gameability guards, frozen-splits, and evolution tree format |
| `evor_doctor` | Check environment and run integrity; pass `repair=true` to auto-fix obvious issues |
| `evor_capability` | Probe hardware and record capability; call before preflight |
| `evor_preflight` | Run the 5-step micro-train smoke-test; returns `{checks, passed}` |
| `evor_lock_mission` | Validate the run and lock the mission so the tick loop can start; refuses if validation fails |
| `evor_check_stop` | Return whether the run's stop condition is met, with a reason |

### Tree / Select
| Tool | Purpose |
|---|---|
| `evor_tree_read` | Read the evolution tree, optionally filtered to a subtree |
| `evor_select` | Select next parent node(s) to expand by the active policy (UCB1 default); returns ranked node IDs |
| `evor_record_node` | Validate and register a new candidate node in the evolution tree |
| `evor_record_eval` | Validate and record an evaluation result for a node; auto-triggers integrity check |

### Artifacts
| Tool | Purpose |
|---|---|
| `evor_write_artifact` | Validate and atomically write a tick artifact for the given `agent` and `kind` |
| `evor_read_artifact` | Read and validate an upstream tick artifact; returns an error object when the step has not run |
| `evor_store_patch` | Store a unified-diff parent patch for a node |
| `evor_store_blob` | Store a file or text blob in the content-addressed store; returns `content_ref` |
| `evor_telemetry_ingest` | Validate and append telemetry records for a node |

### Candidate Telemetry (§19 — no evor import required)

The harness exports three env vars into every training subprocess before it starts:

| Variable | Value |
|---|---|
| `EVOR_TELEMETRY_PATH` | Absolute path to the node's telemetry file (parent dir pre-created) |
| `EVOR_NODE_ID` | Node identifier string |
| `EVOR_RUN_ID` | Run identifier string |

Candidate training code appends one JSON-line per step using stdlib only:

```python
import json, os
from datetime import datetime, timezone

tel_path = os.environ.get("EVOR_TELEMETRY_PATH")
if tel_path:
    record = {
        "step": step,                                  # int — required
        "node_id": os.environ["EVOR_NODE_ID"],         # str — required
        "run_id": os.environ["EVOR_RUN_ID"],           # str — required
        "timestamp": datetime.now(timezone.utc).isoformat(),  # ISO 8601 — required
        "train_loss": loss,    # float — recommended
        "lr": lr,              # float — optional
        "grad_norm": gn,       # float — optional; omit for tabular/XGBoost
        "val_metric": vm,      # float — optional; buffer from validation epoch
        "epoch": float(epoch), # float — optional
    }
    with open(tel_path, "a") as f:
        f.write(json.dumps(record) + "\n")
```

Candidate code **must not** import from `evor.*`; use the env-path pattern above.

### State
| Tool | Purpose |
|---|---|
| `evor_state_read` | Read active run state; returns merged state object |
| `evor_state_write` | Update run state fields; optional promotion of strategy, mission status, and active run pointer |
| `evor_read_goal_contract` | Read and validate the run's goal contract; returns the contract object or `{error}` |

### Signals
For the full signal vocabulary (shapes, axes, severity, kind catalogue), read `agents/references/signal-protocol.md`.

| Tool | Purpose |
|---|---|
| `evor_signal_emit` | Emit (upsert/dedup by signature) a Signal onto the run's bus; repeat emits raise confidence and escalate severity |
| `evor_signal_query` | Pull signals filtered by facet lens, severity floor, kind, and `since_tick`; drains inbox first |
| `evor_signal_digest` | Return a compact top-slice (`severity>=medium`) of the bus for spawn-prompt injection |

### Citations
| Tool | Purpose |
|---|---|
| `evor_cite` | Append a bib entry, arXiv URL, or dataset URL to a node's citations |

### Wiki
| Tool | Purpose |
|---|---|
| `evor_wiki_add` | Record a lesson entry and append it to the cross-run wiki index |
| `evor_wiki_query` | Keyword search over the cross-run wiki index; filter by `approach_family` or `confirmed_only` |
| `evor_wiki_summarize` | Summarise wiki lessons by `approach_family` and `hypothesis_verdict` |

### Gotchas
| Tool | Purpose |
|---|---|
| `evor_gotcha_query` | Query the accumulated gotchas for known failure patterns, hardware constraints, and approach dead-ends |
| `evor_gotcha_add` | Record or dedup-update a gotcha; repeat adds increment `occurrences` and raise `confidence` |
| `evor_gotchas_list` | List all accumulated gotchas sorted by confidence descending |

### Integrity
| Tool | Purpose |
|---|---|
| `evor_integrity_check` | Run all integrity checks and record the verdict; returns pass/fail with per-check details |

### Compute / Run
| Tool | Purpose |
|---|---|
| `evor_run_start` | Launch a candidate node as a detached background job; returns `{job_id, status_path, log_path}` immediately |
| `evor_run_status` | Read run progress and tail the log for a running or completed job |
| `evor_schedule` | Submit a training job to the run scheduler; returns `{job_id, pid}` |
| `evor_meta_evolve` | Update the search strategy from the current frontier (meta-evolution of the search policy) |
| `evor_plot_report` | Render the evolution tree as PNG and/or HTML; writes to `report/` under the run directory |

### Setup
| Tool | Purpose |
|---|---|
| `evor_freeze_splits` | Freeze test and val splits from a dataset directory; seals the contract against future split changes |
| `evor_init_eval_suite` | Create the initial evaluation suite and angle registry |
| `evor_seal_eval_script` | Lock the evaluator so it cannot be changed after setup; call after writing the evaluator file |
| `evor_distill_scan` | Deep-scan a workspace for brownfield onboarding; writes and returns a `StartingPointReport` |
| `evor_check_leakage` | Screen candidate acquisition items against the frozen test split and return the clean set |

### Handoffs / Inbox
| Tool | Purpose |
|---|---|
| `evor_write_handoff` | Write a tick handoff payload; auto-increments the sequence |
| `evor_read_handoff` | Read a handoff from a prior agent by `from_agent`, `to_agent`, or `tick` |
| `evor_drain_inbox` | Drain a pending inbox into the wiki or signal bus; returns count drained |

---

## Run Lifecycle Recipe

```
evor_capability          # probe hardware (once per machine)
evor_preflight           # 5-step smoke-test
evor_init_run            # write all run artifacts; returns run_id
evor_validate            # verify goal contract + splits
evor_lock_mission        # validate and lock the mission; refuses if validation fails

── per tick ──────────────────────────────────────────────────────────────
evor_read_artifact       # read upstream agent's output FIRST (see §Read-First)
evor_wiki_query          # ground proposals in accumulated lessons
evor_tree_read           # inspect frontier
evor_select              # pick parent node(s)
... (specialist agents produce their tick artifacts via evor_write_artifact)
evor_record_node         # register the candidate node in the evolution tree
evor_run_start           # launch training (async); returns job_id immediately
                         # → watch with Monitor (attended) or FileChanged+asyncRewake (unattended)
evor_run_status          # check state when monitor fires
evor_telemetry_ingest    # ingest telemetry records from the run
evor_record_eval         # record evaluation result (auto-triggers integrity check)
evor_integrity_check     # verify result; if verified=false → evor_signal_emit(integrity-violation)
evor_wiki_add            # record the lesson from this tick
evor_state_write         # update frontier + tick state
evor_meta_evolve         # update search strategy (end of tick or milestone)
evor_check_stop          # check whether the run's stop condition is met
```

For brownfield missions, call `evor_distill_scan` before `evor_init_run` to produce the starting-point report.

---

## Native Tools

Use these platform tools directly — do not replicate their behavior in MCP.

- **`evor_run_status`** — Watch a launched run by polling `evor_run_status({run_id})` until `state` reaches `done` or `failed`. It reports progress, the latest metrics, and any error signature — cover both success and failure. Do not tail log files by hand; the tool owns the run's internals.
- **`AskUserQuestion`** — Capture the mission goal, metric, budget, and autonomy level at setup; any human decision or consent gate. Do not use in the autonomous hot-loop.
- **`PushNotification`** — Fire when a run finishes, crashes, hits an OOM, achieves a breakthrough (best-score jump), or reaches a human gate. Use for state changes the user would act on.
- **`TaskCreate` / `TaskList` / `TaskUpdate` / `TaskStop`** — Track per-tick candidates and phase progress as a visible task list. Use `TaskStop` to abort a runaway sub-agent on a `severity=critical` signal.
- **`ToolSearch`** — Load evor tool schemas on demand (see [Tool-Search Note](#tool-search-note)) and discover research MCPs (Semantic Scholar, arXiv, Consensus, Exa, HF) before Sage fans out.
- **`lsp_diagnostics`** — Run LSP pre-flight on candidate code before launching training. A type or syntax error caught here saves a multi-hour wasted run. Treat as best-effort (graceful when no LSP server is present).
- **`SendUserFile`** — Deliver the evolution-tree PNG and metrics plot at milestones. Call `evor_plot_report` first, then send `report/tree.png`.
- **`WaitForMcpServers`** — Ensure research MCPs are connected before Sage fans out queries (when tool-search is off).
- **`Agent` / `Task`** — Delegate to specialist agents (`oh-my-evor:evor-forge`, etc.) per the tick handoff DAG.

---

## Read-First Discipline

Before acting on what a prior agent produced, call `evor_read_artifact` to retrieve that agent's tick output. Working from memory or assumptions about upstream output leads to fabricated lineage.

If `evor_read_artifact` returns an error object, the upstream step has not produced output. Stop and surface the gap — do not proceed.

**Handoff DAG (who reads what):**

- **Sage** reads all `sage-junior` angle artifacts, then writes its findings.
- **Mutagen** reads `sage` findings + `evor_wiki_query` + `evor_tree_read`(frontier) before proposing.
- **Selector** reads `mutagen` proposals + `evor_tree_read` + strategy (`evor_state_read`) before issuing its verdict.
- **Forge** reads `selector` verdict + the winning `mutagen` proposal; its junior writes code → LSP pre-flight → `{critic, analyst, architect}` review in parallel → on pass: `evor_record_node` + `evor_run_start`.
- **Probe** reads telemetry + `evor_run_status` before writing findings and emitting signals.
- **Orchestrator** reads `probe` findings, then calls `evor_record_eval` → `evor_integrity_check` → `evor_wiki_add` → `evor_state_write`(frontier).

---

## Tool-Search Note

Evor tools are deferred by default — only tool names load upfront, not their full schemas. Load schemas before first use:

```
ToolSearch("select:evor_init_run,evor_validate,evor_state_read")
ToolSearch("select:evor_write_artifact,evor_read_artifact,evor_record_node")
ToolSearch("select:evor_run_start,evor_run_status,evor_record_eval,evor_integrity_check")
```

Load only what the current turn needs. The MCP tool prefix is `mcp__plugin_oh-my-evor_evor__<tool>` (used in hook matchers).
