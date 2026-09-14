# Changelog

All notable changes to Evor. Format follows [Keep a Changelog](https://keepachangelog.com/).

## [1.2.6] — 2026-09-14 — the evaluator contract has an owner

A mission setup could not finish without the operator typing `cp`. The write guard was
blamed; the write guard was not the cause.

### The root cause

The evaluator's interface had no owner. Four sites each asserted their own belief about
it, and nothing made them agree:

| site | believed the evaluator… |
|---|---|
| `evaluator.py::_build_cmd` | takes no positional args |
| `scaffold_evaluator.py` | takes `<split_dir> <pred_dir>` |
| `evor_seal_eval_script` | IS one file, `eval-suites/<v>.py` |
| `skills/evor-setup/SKILL.md` | loads `build_model` + weights, and gets its split path "via the run environment" |

Every disagreement was fatal and none was visible, because the only test that executed
an evaluator **substituted itself for both boundaries the product crosses**:

```python
# how the test launched it        # how evaluator.py:133 launches it
[python, "v1.py", split, pred]    [python, eval_script]        # no positional args
# how the test wrote score_plugin.py   # how an agent must
Path(...).write_text(body)              Write/Edit → denied by PROTECTED_RUNS_RE
```

It supplied its own argv, wrote the mission-owned file by direct filesystem call, and
handed in its own `score()` returning a constant. Each substitution hid exactly one
defect. All three were fatal, and the run environment never exported the split path the
setup skill promised — a fourth.

### `harness/evor/eval_contract.py`

One owner, in the shape §1.2 already established for `finished`. It defines invocation,
stdout, **extent** (the evaluator is a SET of files), the environment an evaluator may
rely on, and the two conformant shapes. All five sites now derive from it.

- **Invocation** — `_build_cmd` calls `build_argv`. The generated harness no longer
  requires positional arguments; it self-locates from `EVOR_RUN_DIR` (now exported, as
  the setup skill always claimed) or from `__file__`, and honours `--eval-domains`.
  `HARNESS_VERSION` 1 → 2, so a version skew stays distinguishable from tampering.
- **Extent** — the seal anchors every file the evaluator comprises. It hashed
  `<v>.py` alone while the harness does `from score_plugin import score`, so the
  function deciding every score sat outside the anchor whose stated purpose is that
  nobody can shift the metric. Rewriting the metric left custody reporting **intact**.
- **Shapes** — `generated` scores prediction files and cannot load a model;
  `authored` can. A contract gating on `latency_*` or `vram_*` requires `authored`, and
  `evor_scaffold_evaluator` now **refuses** such a contract instead of emitting gates
  that are skipped rather than enforced. A skipped floor does not fail — the run
  reports a pass it never earned.
- **The missing writer** — new `evor_write_eval_script` is the owning tool for
  `eval-suites/<v>.py` and `score_plugin.py`. The guard is NOT relaxed: it validates
  that the source compiles, takes no positional argv, prints its one JSON object, and
  reads polarity from `label_semantics` rather than guessing — every one of those a
  thing the hand-written column actually got wrong in the field. It refuses to
  overwrite a sealed version rather than route around the re-seal guard.

### The test that makes drift impossible again

`harness/tests/test_evaluator_contract_conformance.py` crosses both boundaries: write
through the owning tool, launch through the product's runner, assert a result. It failed
on all three defects on first run, before any product code changed. Its final case is
the property the mission actually needed — write, then run, no human.

`test_scaffold_evaluator.py` is converted from inventing its own argv to deriving it,
which also made one case stronger: under the contract an evaluator cannot be POINTED at
a different split at all, so the remaining hazard is the declared location holding the
wrong count.

`mcp/tests/eval-contract-parity.test.ts` runs the TS seal mirror and the Python owner
over one fixture and fails if the digests diverge — a mirror without that test is just a
fifth independent opinion.

### Bookkeeping this forced

- 73 bench scenarios re-pointed at the new `hooks/stop.mjs`, `agents/evor-tick.md`,
  `agents/evor-forge.md`, `skills/evor-setup/SKILL.md` and `skills/evor-mcp/SKILL.md`
  shas, and four `A1` quotes re-anchored to the rewritten `evor-forge.md` line — with
  both graded invariants verified present in the new text first. Logged in the §6.7
  re-freeze log. Applied as text-level replacements after a JSON round-trip was found
  rewriting `\u00a7` escapes across the corpus; that pass was reverted.
- `evor-tick`'s 8.1 evidence row keeps its stale mark with the sha re-recorded, so this
  edit does not hide inside the previous ones.

## [1.2.5] — 2026-09-14 — a stop with live children is a yield, not an end

Claude Code re-activates an agent when a background agent it spawned reports back —
the CLI says so: *"Waiting for 5 background agents to finish."* An agent that ends its
turn there has **yielded**. The session was never going to end, so blocking that stop
buys nothing and costs a turn of context every time.

Every Stop-hook guard here treated a yield as an end. Two field failures, one mistake:

- 497 consecutive blocked stops against a pending node the orchestrator could not
  record (fixed in 1.2.3 by bounding it; this fixes the cause).
- The drift guard demanding tick 1's Mutagen artifact **16 seconds into tick 1**, from
  the orchestrator — which is forbidden to produce it, because the tick boundary owns
  that spawn. The orchestrator could not comply without committing the exact violation
  the guard exists to detect. It burned six attempts saying so, then the operator
  disabled the hook with `EVOR_SKIP_HOOKS=stop` — which disarms every legitimate guard
  in the file, including the integrity and continuation checks.

The guards are for state **debt the agent can discharge right now**: a node it recorded
and never evaluated, a tick it abandoned. They were never for the absence of an artifact
somebody else still owes.

### The yield gate

New `hooks/lib/waiting.mjs`. Two signals, either sufficient, both fail-open **toward
allowing the stop** — misreading a yield as an end is the failure being removed, and the
debt survives on disk for the next stop either way.

1. **`tick-state.json`'s `blocked` field**, written by `evor_await_artifact` — which the
   skill already tells agents to call before they block. First-party and in-band: the
   agent *said* what it is waiting for. In the field run the tick had written
   `blocked: {on: "artifact:sage@tick1"}` and parked exactly as instructed, and the
   guards fired at it anyway.
2. **A live agent under the session's `subagents/`.** Covers agents that yield without
   recording a wait — `evor-sage` fanning out to five juniors. An agent counts as live
   unless its transcript ends in an assistant message with a terminal `stop_reason`;
   because a *parked* agent reads as terminal by that test, a recent write also counts,
   which closes the window between a child finishing and its parent waking.

The gate runs **before** the block counter, so a yield cannot consume attempts against
the ceiling during a long, healthy tick.

### Two guards re-scoped

- **The drift guard's roster checks now require a finished tick.** "Did you skip the
  roster?" is only answerable once the tick is over; mid-tick, an absent artifact is the
  normal state.
- **The SubagentStop mid-flight guard added in 1.2.3 was wrong** and is now yield-aware.
  A tick that parks to wait for Forge is doing the right thing. It fires only when a tick
  goes quiet with nothing live and no recorded wait — the original defect — and its
  message now says which of the two distinguishes them.

### Also verified, not changed

Model routing is correct for every role, checked against two live sessions' transcripts:
`evor-tick` sonnet, `evor-sage`/`evor-mutagen`/`evor-selector` haiku,
`evor-sage-junior`/`evor-forge-junior` sonnet, `evor-forge` and all three forge reviewers
opus. Turn caps bite per invocation (four agents landed exactly at their declared cap);
the counts that exceed a cap belong to agents that were *resumed*, which continues the
same transcript. Three of four `evor-sage-junior` spawns hit exactly 16/16 — the cap is
tight, not broken.

## [1.2.4] — 2026-09-14 — run_start evaluates, it does not train

One correction, to the sentence an agent reads at the moment it decides what a tool
will cost. Shipped separately from 1.2.3 because 1.2.3 was already installed when this
was found.

Verified against source: the tool calls `jobStart`, which launches `python -m evor run`;
that subcommand's own help is *"Run evaluation for a candidate node"*, and `_cmd_run`
executes `worktree/evaluate.py` through `EvaluatorAdapter`. No training step exists in
that path. Training is written and run by `evor-forge-junior`, before the call.

The tool description the model reads at call time said `launch training (async)`. A
mission budgeted 150 from-scratch ticks on the belief that the multi-hour cost sat
inside `run_start`; it sits inside Forge. The error is quiet in the other direction too
— calling it on an untrained worktree raises nothing, it just scores whatever weights
are on disk, which is worse than a failure because it is indistinguishable from one.

Corrected in `mcp/src/tools/compute.ts` (the `evor_run_start` and
`evor_forge_dispatch_batch` descriptions, the batch docstring, the module header),
`skills/evor-mcp/SKILL.md` (tool table and tick flow), and `agents/evor-forge.md`
(role statement, completion checklist, and a new failure-mode entry for evaluating an
untrained candidate). `evor_forge_dispatch_batch` runs the same `jobStart` path and was
mislabelled the same way. New `mcp/tests/run-start-does-not-train.test.ts` fails if any
surface reattaches "training" to either tool, and pins the two harness facts the
correction rests on.

## [1.2.3] — 2026-09-14 — the tick could not read its own procedure

A single mission (`binarization-worldmodel-recall-2026-09`) wedged at tick 1 and spent
**497 consecutive blocked stops** emitting "Waiting on tick 1." Four defects, one chain.

### The tick never received the 9-step loop

`commands/evor.md` and `skills/evor/SKILL.md` both claim the address `oh-my-evor:evor`,
and the **command wins**. So `evor-tick`, whose frontmatter says
`skills: [oh-my-evor:evor]`, received a 1,295-byte dispatch stub instead of the
39,897-byte procedure — and that stub's entire dispatch is
`cat "$EVOR_PLUGIN_ROOT/skills/evor/SKILL.md"`, while the agent declares
`disallowedTools: Bash`. It was handed an instruction it is structurally forbidden to
execute. Measured in the tick's transcript: the skill was invoked **nine times**, the
stub came back every time, and across 28 `Read` calls SKILL.md was never one of them.

It was not turn-capped (45 turns of a declared 90). It had budget and no procedure. It
improvised Sage → Mutagen → Selector → Forge from fragments in its own agent file and
had nothing for step 5 onward: no wait discipline, no `evor_record_node`, no
`evor_run_start`. `evor-mcp` is the control — no command of that name, body arrived
intact in the same context.

- All ten `commands/evor*.md` now dispatch with the **Read tool** instead of `cat`.
  Every one of them shadows a skill, so this is the class fix.
- `agents/evor-tick.md` gains a Step 0 that Reads the procedure explicitly, states why
  the frontmatter does not deliver it, and adds the waiting section — including that
  `TaskOutput` and `Monitor` are deferred tools needing
  `ToolSearch("select:TaskOutput,Monitor")`. In the measured run neither was ever
  loaded and the string `TaskOutput` never appeared in the tick's context at all.
- New `mcp/tests/skill-command-name-collision.test.ts` fails if a shadowing command
  goes back to shelling out, or if evor-tick stops reading its own skill.

### The Stop hook blocked with an unreadable reason

`hooks/stop.mjs` exited 2 with its message on **stdout**. Claude Code reads an exit-2
Stop hook's reason from **stderr**, so every block surfaced as
`Stop hook error: [node ".../hooks/stop.mjs"]: No stderr output` — blocked, with no
stated reason. The orchestrator could not act on what it could not read, so it emitted
a filler turn and stopped again.

Now emits `{"decision":"block","reason":...}` on stdout with exit 0 — the JSON protocol
`subagent-stop.mjs` and `pre-tool-use.mjs` already used. This hook was the last one on
the exit-code path. The reason is mirrored to stderr for session logs.

### The Stop hook had no release ceiling

`pending_node_ids` was declared a structural invariant that "can never be overridden by
repeated stopping", so its branch fell through and blocked again, forever — the counter
in that run's `stop-blocks-*.json` reached **497**. The reasoning was wrong on its own
terms: the debt survives in `run-state.json` after release either way, and the next
session's guard re-raises it. Blocking 497 times never recorded the node; it only
consumed the context that might have.

- `SOFT_CEILING` 8 (drift-only debt, as before) and a new `HARD_CEILING` 25 that
  releases **everything**, `pending_node_ids` included.
- The ceiling is checked unconditionally rather than only when `stop_hook_active` is
  set — the platform signal is not guaranteed; the persisted count is.
- Session id now comes from the STDIN payload. `CLAUDE_SESSION_ID` is unset for Stop
  hooks in this build, which had collapsed every session onto one `nosession` counter.

### The mid-flight guard did not follow the tick into the subagent

The Stop hook's incomplete-tick guard is scoped to the orchestrator — "only main owns
tick completion" — which was true before `evor-tick` became the boundary that runs the
9 steps. The enforcement never moved with the ownership, so a subagent ending its turn
was exempt from every guard. The tick returned "mid-flight" as if it were an outcome,
three times in one session.

`hooks/subagent-stop.mjs` now blocks a mid-flight `evor-tick` return with the concrete
wait instruction, bounded at 2 retries so a tick that genuinely cannot finish costs two
turns and then goes through.

### Tests

`stop-incomplete-tick.test.ts` and `wave1-autonomy-termination.test.ts` asserted
`code === 2` and passed for two releases while the hook was unusable in the field —
an exit code cannot distinguish a readable block from a reason-less one. They now
assert the reason is readable. 128 tests pass across the five affected suites.

## [1.2.2] — 2026-09-14 — the instrument release

v1.2.2 is almost entirely work on the thing that measures the agents, not on the
agents. `evals/bench` was built to catch a system publishing its own defects as
model failures, and over sixty commits it was found doing exactly that.

**No F1 number from this cycle should be quoted.** The reason is in
`docs/evor-eval-bench/13-lite14-is-a-different-instrument.md` and
`14-the-ceiling.md`: the runs that produced them measured different instruments,
and the instrument itself re-rolls about one paired cell in three between
identical runs.

### What the bench was doing wrong

- **The governor was not loaded.** `.claude-plugin/plugin.json` was never copied
  into the sandbox, so `oh-my-evor:*` agent types did not resolve and
  `hooks/hooks.json` — including `SubagentStart`/`SubagentStop` — never came into
  force. Every calibration before this measured the roles with the reflex layer
  switched off. Fixed by copying the manifest and passing `--plugin-dir`.
- **The operator's global CLAUDE.md was loaded into every scored run**, so each
  role carried an unrelated orchestration framework's instructions. Removed with
  `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`; `--system-prompt` does not suppress memory,
  and `--bare`/`--safe-mode` would have taken the hooks with it.
- **The role-identity read was wrong at three sites.** `agent_type` is empty for a
  top-level agent, which is how the bench runs every role, so the governor
  believed `evor-tick` was the mission orchestrator and denied its fan-out. Fixed
  twice before every site was found.
- **A denial was flagged per tool NAME, not per call** — 412 flagged against 159
  real, and `bench-detect.mjs` treats a denied call as invisible, so one denied
  `Bash` silently un-matched every Bash predicate for the rest of the run.
- **The governor-decided-denial subtraction was dead code.** `ctx.governor_denials`
  had one reference in the repository: the consumer.
- **Four records were scored FAIL for a task that never arrived**, and the
  product's own `Stop` hook — correct in production — could only misfire against
  fixtures that all depict a mid-tick state.
- **Fixtures failed the product's own schemas**: mutation proposals missing five
  required fields, `tree.json` missing its envelope `updated_at`, `strategy.json`
  carrying two fields of fifteen. The agents reported this correctly for four
  calibrations and were recorded as fabricating.

### What the product gained

- `evor-tick` may no longer spawn `evor-tick`. Nothing forbade it, and three runs
  ended waiting on a nested copy of themselves.
- `evor-mutagen` is told that `evor_validate_proposals` is a call it makes, not
  something that happens to its payload.
- `evor-tick`'s pointer rule no longer contradicts its own failed-tick section.
- `kind` is documented as a registry rather than a closed set, matching
  `signal-protocol.md` and the schema, which four agent files contradicted.
- The per-role `maxTurns` each agent file declares is now honoured.

### Not fixed, and named

- **100% F1 is not reachable on a single run** — the ceiling is about 0.92–0.94,
  because model sampling is unseeded and roughly one paired position in seven
  re-rolls after every bench-side cause is removed. Three honest reformulations
  are set out in `14-the-ceiling.md`; none has been chosen.
- **Negative halves can pass by staying silent.** `S = detect ∧ declaration` on
  both halves, so 46% of the false positives the corpus should record are absorbed
  by the agent saying nothing. Correcting it lowers the reported score by about
  4 points, which is why it is documented rather than quietly applied.
- **Three tier rows in `docs/v1-cost-and-verification.md` §3 remain stale.**
- The last calibration attempt was lost to an account rate limit, and the harness
  scored the refusal as model failure — the same class of defect as above, still
  open.

## [1.2.1] — 2026-09-02 — the affordance release

v1.2.0's first real field deployment ran 19 hours across three missions and
produced **1 tick of 200 in each, 0 promotions**, ending when the operator killed
it. An 18-lane trace, 8 root causes and 6 affordance lanes established that most
of what looked like agent misbehaviour was the system unable to express something
real — so a human or an agent improvised outside it, and the improvisation was
later catalogued as a defect.

**58 of 60 planned items ship.** The two that do not are named below: the key
rotation, which is an operator action, and the `iir-scan-binnet-02` re-score,
which needs a GPU. Phase 8 — the tier re-measurement, listed as outstanding in
the first cut of this entry — has now run, and its result is stated below rather
than resolved: it did not confirm the tiers, it unseated two of them.

### The principle this release is built on

> Any obligation stated in prose to an agent is an obligation the system has
> decided not to have. **For every invariant, name the writer. If the writer is
> the agent that benefits from violating it, it is not an invariant.**

That pattern existed correctly in the codebase exactly once — `record.ts:162`,
*"absence of a failure verdict is not evidence of integrity"*. This release
applies it to the other twelve places.

### Fixed — guards that could not fail

- `_check_no_label_contamination` was `return True`: three lines of docstring and
  an unconditional pass, reported beside four checks that can fail. It now
  compares hashes, and with none supplied returns **`None` = not evaluated**,
  which is not the same as clean.
- `.evor/.deps-ok` was a 24-byte timestamp whose mere existence satisfied the
  dependency check. It now attests the interpreter and package set and
  revalidates against them.
- The evaluator sanity gate (new): a trivial all-ones predictor scoring **94.7 F**
  is now unsealable. An unrun gate reports unsealable rather than passing.
- `evor doctor` gained a plugin-tree drift check. 17 files in the installed tree
  were modified in place — including `hooks/stop.mjs` — with 26 `.bak-*` files
  beside them, unreported for 19 hours.

### Fixed — guards that were disarmed, and what arming them revealed

Retiring `run-state.status` armed three `stop.mjs` gates that had been silently
false. That exposed three further defects underneath: the drift guard was **never
scoped to the orchestrator** and had been blocking sub-agents for not producing
artifacts they were spawned to produce; check (c) duplicated Guard 3 with a worse
message; and **two independent test suites' fixtures had drifted** behind the same
inert gate.

### Fixed — the guards checked roles and command text, never paths

Every realized harm in the field run came through a path no guard looked at.
Verdicts are now made on the **resolved absolute write target**, through `cd` and
variable expansion, identically for every caller — an identical edit re-issued as
`subagent_type: "claude"` no longer succeeds 51 seconds after being refused.
`runsTraining` was **narrowed**, not widened: 54 of 82 training denials were false
positives, and broad textual denial trains evasion rather than compliance.

### Fixed — data that was wrong about itself

- **`freeze-splits` was freezing the corpus's metadata files as the eval set.**
  `dataset_card.yaml`, `manifest.json`, `test.txt` — 7 files split 80/20, exit 0,
  `test_item_count: 5`, and every fitness number in a 19-hour run computed against
  them. The corpus had declared all 132 items with domains and per-file hashes
  four weeks earlier; nothing read it. Items now resolve by **declared sha256**, so
  the manifest survives the corpus being reorganised — and an edited sample is
  reported missing rather than silently frozen in its place.
- A node with **12,000 valid telemetry records** was failed by a directory-naming
  mismatch: the trainer wrote `nodes/<slug>/`, the gate read `nodes/<uuid>/`.
  Neither writer was wrong; nothing owned the mapping.
- Three missions read `running` concurrently for 15.6 hours. A successor now
  closes out its predecessor in the same write that creates it.

### Added — affordances, because a guard over a missing affordance breaks things

`docs/credentials.md` (there was no secure path; chat was the only channel) ·
`evor_scaffold_evaluator` (the server owns the harness, the mission owns
`score(pred, gt)` — every field failure lived in the hand-written column) ·
`evor_await_artifact` (agents were told to wait on `job_complete` /
`self_heal_event`, which have **zero producers**) · a `capability-gap` consumer
(`evor-tick` emitted one honestly and nothing read it) · authority expressed as
**operations, not tool names** (`Write` denied, `Bash` granted, 21 writes happened
anyway).

### Added — a state machine, as data three languages read

`contracts/state-machines.json` with a reader in Python, TypeScript and
JavaScript. An FSM in one language is invisible to the others, and `stop.mjs` —
whose wrong predicate caused C-02 — is in a third. Every state carries
`max_dwell_s`, so *"is this still alive?"* becomes arithmetic any reader can do
from the file alone.

### Migrated

The three field mission trees (~242 MB) to the v1.2.1 shape, gated on a verified
revert point, dry-run reviewed, with **every node artifact hashed byte-identical
before and after**.

### Not shipping, and why

- **The Semantic Scholar key is not rotated.** The value in `.env` is
  byte-identical to the one exposed on 2026-08-23. Relocating it changed where it
  is stored, not whether it is compromised. Revocation is an operator action.
- **Source-page leakage (M-03) is NOT EVALUATED, not clean.** The check ships and
  is correct in all three states; `corpora/v10` declares no per-item lineage, so it
  abstains. Two RED tests are left failing deliberately — adjusting them would hide
  the gap. One `group` key in the corpus builder closes it. See `KNOWN_GAPS.md`.
- **Two shipped retiers are no longer supported by their own evidence.** Phase 8
  re-measured every role through the fixed instrument (930 calls, $274.44, 0
  harness errors) and corrected the arithmetic: v1.2.0's CIs used n = CALLS, so
  `36/36` was twelve cases run three times. Repeats of one case are not
  independent observations of a role. On n = cases, **all seven adopted rows fail
  the 10pp gate they were published as clearing** (`ci/recompute-v1-cis.mjs`
  reproduces the published intervals to the decimal, then recomputes them).

  Re-measured, three of nine roles clear the margin. `evor-sage` (haiku, 92.3%,
  also below the 95% absolute floor) and `evor-mutagen` (haiku, 96.0%, interval
  touching the margin exactly) do not, and both ship. Neither is *worse* — the
  gaps are +3.1pp and +4.0pp — but neither is established. Moving the other way,
  `evor-forge-architect`'s recorded −10.0pp regression **does not reproduce**,
  and `evor-tick` is benchmarked for the first time (sonnet 80.0% vs haiku
  20.0%). `evor-selector`, `evor-forge` and `evor-forge-junior` have no
  `spec.json` and were **not** re-measured. See §3 of
  `docs/v1-cost-and-verification.md` for the per-role table, `KNOWN_GAPS.md` for
  what closing it needs, and `docs/evidence/matrix-81.json` for the 930 calls.

- **Agent output carries prose the parser forgives.** 22 of 131 calls emit text
  before their JSON — 28.8% on `evor-probe`. All 131 still parsed, because
  `parseContractOutput` strips fences and hunts for the first object, so the rate
  is a live dependency on that leniency rather than a property of the roles.
  Nobody declared the tolerance and nobody owns it. The earlier report of this as
  absent came from n=15; P(zero | 29%, n=15) is under 1%, so that run did not
  fail to reach significance, it failed to look.

## [1.2.0] — 2026-08-22 — model-tier optimization

Six tier/effort changes ship, chosen by a gate both angles must clear:
**accuracy ≥95% absolute, the difference CI clearing −10pp, both arms from one
paired run, and a material cost saving.** Across those six roles,
**$0.7039 → $0.2195 per call — 68.8% cheaper**, with no measured accuracy
regression on any of them.

Five further retiers were measured, found short of the gate, and **reverted to
their `main` tiers** rather than shipped on weaker evidence. Their prompt fixes
ship regardless: those were verified on *both* arms and improve the expensive
tier too.

`evor-tick` ships as a new agent on sonnet. It has never been benchmarked.

The savings did not come from model swaps. They came from **thirteen defects in
Evor's own agent files** — every time a cheaper tier looked like a capability
limit, reading the model's actual answer found a rule that was graded but never
stated, stated twice with different answers, or stated far from where the field
is written. Thirteen times out of thirteen. Zero times was it a model failing to
reason.

### Changed — tiers that ship

> **Corrected by 1.2.1 (item 8.3). The evidence column below is wrong and is
> left standing as published history.** Every CI in it uses n = CALLS, not
> cases: `36/36` is twelve cases run three times, `116/120` is ten cases run
> twelve times, and repeats of one case are not independent observations of a
> role. Recomputed on cases, all seven adopted rows fail the 10pp gate they are
> shown clearing. The arms were also measured with no MCP tools attached. See §3
> of `docs/v1-cost-and-verification.md` for the re-measurement.

| agent | from | to | evidence | saving |
|---|---|---|---|---|
| `evor-sage` | opus | **haiku** | 75/78 vs 77/78, CI [−9.5, +3.6] | 79.3% |
| `evor-mutagen` | opus | **haiku** | 116/120 vs 116/120, CI [−5.3, +5.3] | 71.9% |
| `evor-probe` | opus | **haiku** | 66/66 vs 66/66, CI [−5.5, +5.5] | 69.0% |
| `evor-acquirer` | sonnet | **haiku** | 36/36 vs 36/36, CI [−9.6, +9.6] | 59.2% |
| `evor-forge-junior` | sonnet `effort: high` | sonnet **`effort: low`** | 45/45 on all three arms, CI [−7.9, +7.9]; roc_auc identical to 4 d.p., sd=0 | 42.5% |
| `evor-selector` | opus | **haiku** | 200/200 at n=200, CI [−1.9, +1.9] | 22.5% |
| `evor-tick` | *(new)* | sonnet | none — never benchmarked | — |

`effort:` was removed from every agent moved to haiku — haiku does not support
it, and `tests/agent-frontmatter.test.ts` fails on an inert declaration.

### Reverted — measured, but short of the gate

Each of these was measured non-inferior and would have saved real money. None
ships, because non-inferior is not the same as demonstrated.

| agent | proposed | reverted to | why it did not ship | saving forgone |
|---|---|---|---|---|
| `evor-forge-critic` | haiku | opus | 29/30 vs 27/30, but the two arms came from **separate runs** — run-to-run variation uncontrolled | 68.0% |
| `evor-forge-analyst` | haiku | opus | 93.5% absolute, below the 95% bar | 63.5% |
| `evor-sage-junior` | haiku | sonnet | 93.9% absolute, below the 95% bar | 65.7% |
| `evor-forge-architect` | sonnet | opus | 93.3% and CI lower bound exactly −10.0pp | 40.6% |
| `evor-forge` | sonnet | opus | 3-tick A/B only; no per-attempt n to compute an interval from | 17% |

Reverting these costs **$0.2618 per call** across the four with per-call
figures; `evor-forge` has none, so the true total is higher. They are not suspected of regressing — the evidence is thin,
not adverse — and `evor/optimization-v2` exists to fix that.

### Added

- `evals/acquirer/` — 12 cases across five gates. Acquirer's tier had never been
  benchmarked before this.
- `evals/probe/oscillating-curve` and a flattened `grad-vanishing` tail.
- Non-inferiority testing in `ci/retier-report.py`: Newcombe method-10 interval
  for a difference of proportions, built from two Wilson intervals.
- Run fingerprints (`agent_sha256`, `spec_sha256`) in every report, so an arm can
  be topped up across runs and `ci/compare-arms.py` can refuse to pool reports
  that measured different files.
- `docs/v1-cost-and-verification.md` — per-row verification status.
- `docs/agent-file-defects.md` — all thirteen defects, with the reasoning.

### Fixed — statistics

- **`p >= 0.05` was being reported as "no regression".** It is not: a
  non-significant p says the run could not tell the arms apart. The verdict is
  now one of four — regression, improvement, non-inferior within 10pp, or
  UNDERPOWERED. Under this rule four previously-"held" retiers were reclassified
  as never demonstrated.
- **The 10pp margin is what n can reach**, not what is comfortable. At n=30 a
  perfect tie still leaves a 15.4pp drop inside the interval; ruling out 5pp
  needs n≈200.
- **Cost is now billed, not modelled.** The two disagree by a *tier-dependent*
  factor — 1.142× on haiku, 1.261× on sonnet and opus — so it does not cancel in
  an arm-vs-arm ratio, and every modelled saving previously quoted was a floor.
- `gradeField`: an explicitly-empty `set` is now a gradeable claim ("nothing
  fired"); an absent field still fails.

### Fixed — agent files (13 defects)

All one class: **a rule that is graded but not stated, or stated twice with
different answers.** Full detail in `docs/agent-file-defects.md`.

- `evor-mutagen`: `mutation_tier` doubly determined; `dream_k` asked for more
  proposals than families exist; crossover protocol had no trigger (0/3 in
  **both** arms).
- `evor-sage-junior`: `confidence` doubly determined; indirect evidence
  assert-low vs decline; one finding per source skipped the quorum gate.
- `evor-sage`: `confidence` doubly determined — and the first fix over-corrected,
  breaking three single-source fixtures.
- `evor-probe`: loss-curve checks unordered and one dimensionally wrong;
  `telemetry_sane` conflated a broken stream with a bad run; saturation
  per-tick vs cumulative; a missing optional field read as a schema violation;
  a null value confused with an absent field.
- `evor-forge-analyst`: Pass 4 risk indicators were overridden by holistic
  judgement — now floors.
- `evor-forge-architect`: Dimension 5 needed branch-first selection on wildness.
- `evor-acquirer`: two drop counts merged into one field with no rule saying so;
  the license gate ended in "e.g.", making every unlisted license a coin flip.

### Known limitations

- **No tick-level cost measurement exists.** Every figure is per call.
- **Four opus→sonnet retiers were never demonstrated** — probe, forge-architect,
  forge-critic, mutagen. Underpowered, not suspected of regressing.
- **`evals/acquirer` cannot fail** — both arms score 36/36, so it proves the
  absence of a large regression and nothing finer. Same, milder, for probe.
- **`evor-tick` has never been benchmarked.**
- **The modelled-vs-billed gap is unexplained.** Direction known, cause not.
