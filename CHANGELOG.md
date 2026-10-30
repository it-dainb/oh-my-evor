# Changelog

All notable changes to Evor. Format follows [Keep a Changelog](https://keepachangelog.com/).

## [1.2.17] — 2026-10-30 — one forge report per candidate

Found in tick 4 of the binarization mission, the first tick with two selected proposals.

### Changed

- **Forge-family model tiers (operator choice):** `evor-forge`, `evor-forge-critic`,
  `evor-forge-architect` and `evor-forge-analyst` move from Opus to Sonnet (Forge's effort from high to medium), and `evor-forge-junior`
  from Sonnet to Haiku. Haiku takes no `effort`, so the junior's `effort: low` is dropped. These
  tiers have not been measured: `docs/v1-cost-and-verification.md` marks them as operator-set and
  unmeasured, and the 8.1 rows for the three reviewers are re-recorded as stale.

### Added

- **`python -m evor.watch`: stop a training run that has stopped learning.** forge-junior runs it
  as the one background task it waits on, with the trainer detached. It exits when the trainer
  does, or early with a verdict:
  - `stalled`: validation has set no new best in 5 evaluations. The `diagnosis` is `overfitting`
    (train loss still falling, or the train-val gap widening) or `underfitting` (both flat).
  - `diverged`: NaN/inf loss, or loss far above its best.
  - `stuck`: the trainer is alive but writes no telemetry.

  The junior stops the trainer, keeping its best checkpoint, and reports the verdict. Forge records
  it as `early_stop` and emits a `learning-stall` signal with the verdict's `next_tick_hint`, so the
  next proposal can act on it. The watcher never changes the learning rate or anything else
  mid-run: that would change the experiment and make the result unattributable. Replayed on tick 4's
  real telemetry, it flags `overfitting` at step ~28,000 of 60,000. That run's validation peaked at
  12,000 while train loss kept falling, so roughly half of its compute was spent for no gain.

### Changed

- **Agent-visible text carries no development history.** The agent files, skills, commands and
  reference docs had accumulated incident dates, mission names, tick anecdotes, plugin and CLI
  version numbers, finding ids and paths into the plugin's own source. So had the strings the
  hooks and tools emit to agents: deny reasons, nudges, stop blocks and tool descriptions. An agent
  that knows how its governor is built studies it instead of doing its job: one Forge grepped the
  governor to get past a denial. These surfaces now state each rule in the present tense, with at
  most a one-clause domain reason. The history stays in this changelog and in code comments.
  `agent-visible-no-leaks.test.ts` enforces it, for markdown and for emitted strings in the hooks
  and MCP tools.

### Fixed

- **The completeness check reported every candidate as missing a node.** The server assigns
  each proposal a hypothesis id distinct from its proposal id, and nodes are recorded with that
  hypothesis id. Matching selected proposals by proposal id alone failed on both of tick 4's
  candidates, although both were trained, evaluated and integrity-checked. A proposal now matches
  by either id.
- **Two candidates shared one forge report.** A tick forges every selected proposal, but the
  forge-family slots (`forge`, `forge-critic`, `forge-architect`, `forge-analyst`) were one fixed
  file per tick, so the second Forge's report overwrote the first's. With `kind=<node name>` each
  candidate's artifacts now go under `ticks/<t>/forge/<node>/`, in both the Python and TypeScript
  path maps; without a kind the path is unchanged. The agents are told to pass it, and the hooks
  that check for a Forge report accept either layout.
- **Agents polled `evor_wait` on their own children.** On CLI 2.1.314 a sub-agent that ends its
  turn is woken when its child finishes; the field log shows it four times in a row. The CLI then
  shows "Waiting for N background agents" and spends nothing while waiting. Polling cost a turn
  and a context re-send per call: five calls in five minutes in tick 4. Agents now end their turn
  to wait on a child. `evor_wait` is kept for jobs and processes, which wake nobody, with
  `wait_s: 540`.
- **Long jobs would have cost a poll every nine minutes.** At 540 s per `evor_wait` call, a
  12-hour training run is about 80 calls. Agents with Bash now wait with ONE background Bash task
  that exits when the work does: the trainer itself (forge-junior), or an `until` loop over the
  job's `status.json` (Forge). They then end their turn and are woken once, with no calls in
  between. This was verified on CLI 2.1.314: a sub-agent was woken 2 s after its background task
  finished. `evor_wait` remains for the tick, which has no Bash, and its short re-scores. The
  job-launch nudge says the same.
- **forge-junior's trainer launch was refused.** The launch redirected the trainer's log and
  later ran `head -1 $T` on the node's telemetry file. The guard read the whole command as one
  unit, so the redirect made `$T`, which is under `.evor/runs`, a "write". Statements are now judged
  separately; that whole-command pass existed only for `python -c` code, which is now lifted out
  on its own. `NAME=/path` assignments are not targets. A real write through a variable is still
  refused.
- **A denied agent studied the governor to get past it.** After the wrongful trainer-launch
  denial, Forge spent its turns grepping `pre-tool-use.mjs` and `write-targets.mjs` for a route
  through. Every denial now says it is already recorded as a signal, and that a wrong one should
  be reported or routed around, not reverse-engineered.
- **The `[EVOR RESUME]` hint fired where no EVOR run exists**, and sent an unrelated session
  looking for a run id.
- **A never-halt mission could not ask a person who had just typed.** The user asked to drop a
  "leaf" domain, there were two, and the clarifying question was denied. Asking is now allowed
  when the current turn was started by a typed message; questions on autonomous turns are still
  denied.
- **Probe hit its 14-turn cap mid-analysis** and returned a partial result. The cap is now 24.
- **Forge was truncated at its 45-turn cap**, with 83 turns used and no report written, while its waits were
  still polled. Waits no longer cost turns, and the cap is now 60.
- **The `evor_run_start` nudge told agents to end their turn and Monitor.** That is the pattern
  that stalled the field run. It now says to wait with one background Bash task (with Bash) or
  `evor_wait({ job_id, wait_s: 540 })` (without).
- **"artifact not confirmed" fired on successful partial writes.** The check looked at the final
  path; a `partial: true` write goes to `<stem>-partial.json`, and a kind-filed forge write goes to
  `forge/<kind>/`.

## [1.2.16] — 2026-10-30 — resumes start clean; heredoc bodies are not shell

Found resuming the binarization mission and in its tick 4.

### Fixed

- **Command stubs shadowed their skills.** `commands/<name>.md` and `skills/<name>/SKILL.md` share
  the address `oh-my-evor:<name>`, and which one loads was not stable: the same `/evor-run`
  loaded the skill in one session and the stub in another. The stub's
  `Read("${EVOR_PLUGIN_ROOT:-$CLAUDE_PLUGIN_ROOT}/…")` cannot be expanded by the Read tool, so
  those sessions opened with a denied Bash call. The nine stubs that duplicated a skill are
  removed. `/evor-resume`, which has no skill of its own, invokes `evor-run` through the Skill
  tool.
- **A resumed mission investigated the plugin.** A mission paused for a plugin failure records
  the defect in its pause reason, and the next session spent its first minutes reading plugin
  source to see whether it was fixed. `evor-run` now resumes it through `evor_check_stop`, which
  already answers that question.
- **A Python comparison in a heredoc read as a shell redirect.** `len(x)>200` in a
  `python3 - <<EOF` body made an architect's read-only comparison "write" a node's
  `results.json`. Heredoc bodies are now judged by the Python write shapes alone and removed
  from the text the shell rules read. A Python write in a heredoc after `cd` is still caught.
- **`python -c` code was read as shell too.** Probe's read-only telemetry analysis printed
  `'first->last %'`, and `->` read as a redirect, with every string literal taken as a path. The
  code argument of `python -c` is now judged like a heredoc body. When that code does write, the
  whole command is judged as before, so a path passed outside the code is still a target.
- **Probe could not read the reviewers' reports.** Probe analyzes the tick after every verdict
  is in, but it was granted only the `forge` slot. It may now read the critic's, architect's and
  analyst's reports. Reviewers still cannot read each other's.

## [1.2.15] — 2026-10-30 — Forge could not wait for forge-junior, or set up a worktree

Found in tick 4 of the binarization mission on 1.2.14.

### Fixed

- **No way to wait for a child that has no artifact.** On CLI 2.1.314 every sub-agent spawn
  returns at once. forge-junior reports only through its final message, so Forge could neither
  wait for it nor read its result. `evor_wait({ agent_id })` now waits for that child to finish
  and returns its final message as `result`, which a foreground spawn used to provide. Waiting on
  a `forge-junior` artifact is refused, with a pointer to `agent_id`.
- **A copy's sources counted as writes.** The guard treated every path in a writing command as
  a target, so Forge's `cp -r $P/data … $N/` "wrote" the parent node's code and the sealed
  evaluator it copied from. Source operands of `cp`, `ln`, `install` and `rsync` are now reads.
  `mv`, which removes its source, is unchanged, and so is a path that is also written.
- **Forge's instructions had it set up the worktree; the governor forbids that.** Copying seams
  and the evaluator writes `.py` files, which only forge-junior may do. The setup is now
  forge-junior's first step, and Forge locks the evaluator afterwards.
- **A reviewer's scratchpad counted as candidate code.** The critic wrote a check script to its
  session scratchpad and was refused "author-code", with the target `<worktree>/EOF`: the quoted
  heredoc delimiter was read as a path. Scratchpad paths are no longer write targets for the role
  checks, and heredoc delimiters are not paths. Running candidate code is still forge-junior's
  alone, and the critic's instructions now say how to ask for execution evidence instead.
- **`evor_lock_evaluate` refused every node in setup order.** It required the node to be
  registered, but the evaluator is placed and locked before `evor_record_node`. It now locks a
  worktree named for the node, and still refuses a name with neither a node nor a worktree.

## [1.2.14] — 2026-10-30 — Sage had nothing to research, and waits outlived the agent they waited on

Found in tick 3 of the binarization mission on 1.2.13.

### Fixed

- **Gate H004 rejected every proposal while the frontier had one node.** "No parent supplies more
  than ⌊N/2⌋ proposals" cannot hold when only one parent exists, so tick 3 trained nothing and
  every later tick would have too. H004 now applies only with two or more frontier nodes, in the
  deterministic gate and in Selector's instructions. `evor_validate_proposals` takes `run_id` and
  reads the frontier size itself. The skill had documented a `run_id` the tool did not accept.
- **A contract-failure block could never lift.** It cleared only after a later tick succeeded,
  and no tick runs while it holds. Failed tick records are now stamped with the plugin version,
  and they block only while that same version runs. After a plugin fix, one tick tries the new
  code; if the cause persists, it fails again and blocks again.
- **A handoff could be written and never read.** `evor_write_handoff` writes
  `handoffs/<tick>-<seq>.json`, and `evor_read_handoff` only looked for `tick-<n>.md` or
  `<from>_to_<to>.json`. The tick routed Mutagen's investigation queries to Sage this way, and
  Sage read "not found" three times and exited without researching. Every read route now also
  returns these entries; a `from→to` read falls back to the newest entry addressed to the reader.
- **Sage was denied the artifact it researches.** The read guard ordered the pipeline
  `sage → mutagen`, but within a tick Mutagen runs first and Sage answers its queries. Sage may
  now read Mutagen's artifact, and its instructions fall back to it when no handoff exists.
- **`evor_wait` outlived the agent it waited on.** Waiting on an artifact whose producer had
  already exited ran out the full 540 s. Pass `producer_agent_id` (from the spawn result): a
  producer that stops without writing makes the wait return at once with `producer_stopped`.
- **Mutagen guessed `mutation_locus` paths.** Its instructions showed one example. The
  validator accepts one fixed path per family and refused `data/` for data-curation. The full
  table is now in the agent file, and a test validates every row.
- **Sage-junior could not write its documented output.** Its instructions wrap findings in
  `{angle_slug, findings: [...], ...}`, and the validator checked that wrapper as if it were a
  single finding, failing every required field. It now validates each entry in `findings`. A test
  feeds the agent file's example to the validator.
- **Sage could not write a finding flagged `self_directed`.** Its instructions (Step 1b)
  require the flag on findings from the one angle it chooses itself, and the contract forbade it.
- **Sage-junior invented approach families** (`loss`), which the validator refuses. Its
  instructions now state the closed set and where a loss function belongs.
- **`evor-run` still asked "Resume from tick N?"** on a never-halt mission; the governor denied
  it, at the cost of one call. It now resumes without asking under that charter.

## [1.2.13] — 2026-10-30 — open-ended missions overwrote their fitness with an undefined coverage

1.2.12's fix was right but not reached: in an `open_ended` mission the evaluator then replaced
`fitness_value` with the angle coverage, so the re-scored binarization node still logged 0.0.

### Fixed

- **Domain angles were never scored.** Angles are registered as `domain:<name>`, while
  evaluators key `per_domain` by `<name>`. All 24 of the mission's angles went unscored, which
  made coverage undefined, reported as 0.0. Both id forms now match.
- **Coverage replaced a declared fitness.** In an open-ended mission, coverage (a 0–1 share of
  domains above their bar) replaced the contract's primary fitness, whose units `baseline_value`
  and every `best_score` use. A declared primary fitness now wins. Coverage is still recorded as
  `worst_angle_coverage` for the coverage stop checks, and it is the fitness only when no primary
  is declared. When no angle can be scored, coverage is undefined and changes nothing.

- **A capability gap blocked the run forever.** No tool can close a gap, so tick 1's Mutagen
  gap, whose cause was fixed in 1.2.11, still made `evor_check_stop` report `blocked` after tick 2
  scored. A gap now stops blocking once a later tick finishes without failing. A gap that recurs
  is raised again and blocks again.
- **A never-halt mission asked the user while paused.** The 1.2.12 deny applied only while the
  mission ran; main paused itself and asked anyway. It now applies while paused too, except in a
  session whose latest command is `evor-setup` or `evor-distill`.

Verified on the mission's real node: the sealed `evor run` now reports fitness 2.5206, with 24
angles scored and coverage 0.0 (no domain has reached its bar of 98 yet).

## [1.2.12] — 2026-10-30 — the sealed evaluator scored every worst-domain node 0.0

Found while resuming the binarization mission on 1.2.11.

### Fixed

- **Worst-domain and weighted fitness read a missing key as zero.** The harness reduced
  `per_domain[d][primary]` with `.get(primary, 0.0)`. The binarization evaluator reports
  `per_domain[d] = {S, fmeasure}` and its primary metric (`min_domain_ocr_faithful`) only as an
  aggregate, so the sealed job scored a working model 0.0 while the evaluator itself said 2.52.
  The tick then recorded 2.52 by hand. Now, if no domain carries the primary metric, the
  evaluator's own aggregate is used. A report that has it in some domains and not others, or
  nowhere at all, fails the evaluation loudly instead of scoring 0.
- **A never-halt mission asked the user anyway.** `skills/evor/SKILL.md` already forbade
  `AskUserQuestion` under `aggressive-never-halt`, and main asked twice in one resume. The
  governor now denies it to main while such a mission runs, and says how to decide instead.
- **Resuming a running mission began with governor denials.** `evor-run` read state with
  `evor_state_read` three times, and the `[EVOR RESUME]` hint prescribed `evor_state_read` and
  `evor_tree_read`: the calls the governor denies main while a mission runs. On a running mission
  both now go through the tick boundary and `evor_check_stop`. `evor-run` also stopped pointing
  main at `Monitor` and at a relative skill path that sent it to Bash.

## [1.2.11] — 2026-10-30 — waits that do not depend on being woken

Fixes from the log of the 2026-10-30 binarization mission. Its tick 1 failed on a plugin
contradiction, tick 2 lost 80 minutes to a queued notice, and the run then stalled for good on a
job nothing tracked.

### Fixed

- **Mutagen could not write the output its own instructions describe.** `agents/evor-mutagen.md`
  told it to omit `hypothesis.id` ("the server assigns") and to emit `mutation_tier`, `angle`,
  `technique_tags`, `investigation_queries` and three more fields. The proposal validator
  required the id and rejected all of those fields, so tick 1 failed at step 2.
  `evor_write_artifact` now assigns `proposal_id` and `hypothesis.id`, and the contract accepts
  the documented fields. A test feeds the agent file's own example to the validator.
- **A tick that yielded on a job stalled the mission.** No host task tracks an `evor_run_start`
  job, so nothing could wake main, and main was denied `Monitor`. The new **`evor_wait`** tool
  blocks inside the caller's turn until a job finishes, a process exits or an artifact is
  written (up to 540 s per call; 330 s measured on CLI 2.1.314). Every wait in the agent docs now
  uses it. The Stop hook blocks a stop that would leave a job wait with nobody to wake on it,
  and says what to call.
- **Main ended up driving Forge.** The tick handed Forge to main, and about 45 Forge wake-ups
  ("Waiting.") became main turns. The governor now denies main a `SendMessage` to any evor agent
  except the tick, and the tick doc says a child that returns mid-work is waited on, never
  handed up.
- **Forge slept 80 minutes after training ended.** It ended its turn with a `Monitor` armed, and
  the trainer-exit notice stayed queued until main messaged it. Forge and forge-junior now hold
  their turn with `evor_wait({ pid })`.
- **A plugin contract failure was retried as if it were a bad experiment.** `tick_record` takes
  `failure_kind` (`experiment` / `contract` / `infrastructure`) and `error`. A `contract` or
  `infrastructure` failure makes `evor_check_stop` report `blocked`, and main pauses the mission
  and reports it instead of spawning the next tick.

### Changed

- The docs no longer claim that nothing wakes a sub-agent, or that a foreground spawn always
  blocks. On CLI 2.1.314 in a backgrounded session, every spawn returned at once and children's
  notices did wake their parent, but not reliably. Agents now wait with `evor_wait` whichever
  way the host behaves.

## [1.2.10] — 2026-10-30 — a paused mission no longer locks you out of setup

### Fixed

- **The governor treated an active-run pointer as a running mission.** `/evor-setup` in a
  workspace whose `.evor/active-run.json` pointed at a *paused* mission was denied Bash,
  `evor_state_read`, an `evor-probe` spawn and a memory write, and then stopped. Main's
  orchestration rules (no leaf work, spawn only the tick, no state reads at the tick boundary)
  exist to keep a running mission's ticks inside `evor-tick`, so they now apply only while
  `isMissionLive` says the mission is running. A pointer with no state files yet keeps them on,
  and so does an unreadable state, which is now logged. The state guards (`.evor` writes,
  protected paths) are unchanged, and main may always write its own memory.
- **evor-setup Case C asks and then acts instead of stopping.** It offers start new, resume or
  cancel and carries out the choice in the same turn. Starting new needs no manual close:
  `init_run` already supersedes every non-terminal prior mission.
- Harness tests that import sibling test modules failed at collection from the repo root. They
  now resolve from both working directories.

## [1.2.9] — 2026-10-30 — the budget meant what the interview said, and the first live tick in two months

### ⚠ Every node failed integrity from v1.2.6 to v1.2.8

`eval_script_hash` has one writer, the seal, and three readers — integrity check 4
(`no_eval_shift`), `ForgeStructureGate.eval_locked`, and `lockEvaluate` — all of which compare
**sha256 of one file**. v1.2.6 made the seal write a digest over the evaluator's whole file set,
to bring `score_plugin.py` under custody, and moved none of the readers. From v1.2.6 every node
failed `no_eval_shift` and no node could be locked, so nothing could ever be promoted. It shipped
to `main` as 1.2.8. The parity test pinned the seal to `evor.eval_contract`; nothing pinned it to
the gate that reads it.

- One anchor per file: `eval_script_hash` = sha256(`<v>.py`) again, new `eval_plugin_hash` =
  sha256(`score_plugin.py`). The gate checks both; a rewritten metric under an intact harness
  still fails.
- Contracts sealed by 1.2.6–1.2.8 carry a set digest. It commits to the same bytes, so it is
  accepted — translated in one place per runtime (`eval_contract.per_file_anchor`,
  `lockEvaluate`) — and re-sealing such a run rewrites the anchor to the per-file form. The
  tamper guard compares content file by file, so the re-seal is not mistaken for a tamper.
- `mcp/tests/seal-to-readers.test.ts` runs the real seal against every reader in both runtimes.
  It fails on the 1.2.8 seal.

Verified live: a bench tick's node — `feature-cross-lr-01`, fitness 0.874 — passed integrity
with `no_eval_shift: true`. The previous tick's node failed on exactly this check.

### A sub-agent spawns in the foreground

v1.2.7 assumed the platform re-activates a sub-agent when its background child finishes. It
does not: completion notices go to MAIN. The "resumptions" that seemed to prove it were agents
calling `SendMessage` on each other. The wait primitive a sub-agent has is a FOREGROUND `Agent`
call, which blocks until the child returns — several in one message run in parallel and are all
awaited. Same seed, same CLI: 13 foreground / 0 background spawns ran the whole tick; 3 / 4 (Sage
backgrounding its juniors) stalled and exited with 0 nodes.

- The governor denies `run_in_background` from any sub-agent. Main may still background.
- `skills/evor/SKILL.md`, `agents/evor-tick.md` and the SubagentStop message no longer prescribe
  `TaskOutput(block:true)`, which a sub-agent never had. On a `yielding` return main resumes that
  tick with `SendMessage` instead of idling for a wake-up that does not come.

### The live-tick runner could not run

`ci/bench-tick.sh` failed in seeding from 2026-09-02 to now — `init_run` refused "no capability
profile" — so no live tick was measured for two months, across every release.

- The seeder never probed the machine; it does now, and freezes before the eval suite.
- `init_run` resolved the evor root twice: run creation honoured `EVOR_ROOT`, the probe check
  used the process cwd. With the root set by environment it looked in the wrong `.evor`. One
  resolver; the new test fails on the old code with the field error.
- The images pinned CLI 2.1.220, which never resumes a yielding sub-agent; ticks died at the
  first spawn. Both pinned to 2.1.312. Measurements under 2.1.220 are not comparable. The ML
  image's `claude-agent-sdk@0.3.220` pin was paired with the old CLI and is left as it was.

### A correction to this release

K-06 was first made to reject a breaker longer than the budget. That is inert, not harmful, and
rejecting it refused every short run with a default breaker — including the 1-tick bench mission.
It is disclosed and passes.

### Still open

`tick-state.json`'s step counter is maintained by agent prose: in the verified live tick it stayed
at step 2 while the tick completed and was recorded `scored`. Nothing blocked on it this time; the
continuation guard reads it.


The September setup transcript reported two "inverted validator predicates" and three
smaller setup defects. The validator was not inverted. Underneath it was a stop path that
honoured the three budget numbers selectively, and a per-tick history nothing wrote.

### The budget limits were per stop type

The setup interview asks three questions as if about every mission
(`skills/evor-setup/SKILL.md:173`): *how many iterations at most*, *the plateau window (ticks
with no improvement before stopping)*, and *a circuit breaker (max consecutive failures)*.
`tree.check_stop_condition` answered a different set:

| limit | was enforced for | and meant |
|---|---|---|
| `max_iterations` | `maximize-under-budget` only | a tick cap |
| `plateau_window` | `worst-angle-plateau` only | a spread over `tick_history_scores` |
| `circuit_breaker` | every type | **`tick >= circuit_breaker`** — a second tick cap, counting nothing |

`tick_history_scores` — read by every history-based stop — was written by nothing, and
`evor_state_write` is `.strict()` and did not accept the key. So for a `target` mission,
neither `max_iterations` nor the plateau was ever checked, and the breaker was the only
working stop. The validator's K-06 rejected any breaker below the budget, which is correct
under a tick-cap reading, so every mission set breaker = budget — which by accident made it
the run's only iteration limit. A breaker of 0, or above the budget, would have run forever.
The setup summary in the field told the operator "plateau_window = 20 is the real early
stop"; it could not have fired.

- **The breaker counts consecutive FAILED ticks.** `rejected` and `skipped` are not
  failures — a search that comes up empty is the plateau's job, not the breaker's.
- **`max_iterations` and `plateau_window` apply to every mission**, checked after the stop
  type's own goal so a target reached on the last permitted tick is reported as the target.
  A tick with no score improves nothing.
- **`evor_state_write({tick_record: {tick, outcome, score?}})`** is the one writer of
  `run_state.tick_records`; `tick_history_scores` is derived from it and not writable
  directly. `yielding` is rejected — a wait is not a tick.
- **The Stop hook flags a finished tick with no record** — debt main can pay in one call.
  Counted from the first recorded tick, or for a run that predates records, the latest tick
  only: a run in flight cannot honestly reconstruct outcomes it never stored.
- **K-06 now checks the hazard that remains**: a breaker longer than the budget can never
  trip. **K-07's message was false** ("0 is read as unlimited") — the stop path reads 0 as
  no spend, so a zero ceiling stops the run before tick 1. And it advised omitting a field
  the schema made required. **`max_cost_usd` is optional**; absent means no ceiling, which is
  what a local-only run means. Missions had been shipping a nominal $10000.

### Setup took no domains from the data

`create_initial_suite` built one hardcoded `primary` domain, whatever the frozen split held. A
22-domain mission got a one-domain suite; every open-ended angle and coverage figure described
that. Domains now come from the frozen split's `per_sample_domains` — derived by `freeze.py`
from the samples, never the caller — with `primary` only before a freeze. The setup skill now
orders `evor_init_eval_suite` after `evor_freeze_splits`.

### A preflight check that was not run was reported as passed

`loss_decreasing` needs a candidate worktree, which never exists at setup, so it was always
`null`, dropped from `required`, and the run printed "PASSED — environment ready". The
"deferral to the first real training run" is collected by nothing: integrity check 5 rejects
only NaN, Inf or CONSTANT loss, so a diverging loss passes it. It is now listed under
`unverified`, the tool description and setup skill stop promising a micro-train, and the
skill tells the agent to report it as not run.

### Concurrency had nowhere to live

Setup computed and printed "Estimated concurrency: N" and had no field to write it to; the
only builder of a ResourcePlan is called by nothing. `evor_state_write` now takes a
`resource_plan`, setup records it, and the tick reads it. It bounds how many candidates train
AT ONCE — never how many a tick owes.

### The test suite depended on the directory it ran from

Seven `mcp/tests` files resolved repo paths from `process.cwd()`, true only under `npm test`.
From the repo root every hook spawn in `hooks.test.ts` died with "Cannot find module", ~189
tests failed for that reason alone, and 26 tests elsewhere skipped silently. Among the
failures were **16 real ones introduced in v1.2.3**, when the Stop hook moved to the JSON
block protocol: they asserted `exit 2`, and were invisible because `hooks.test.ts` was already
red and releases compared failing FILES against a baseline. All seven files now anchor to the
test file; `no-cwd-relative-paths.test.ts` forbids the pattern; counts are identical from both
directories. `TestM03SourcePageLeakage` — written RED before its fix existed — now declares
the lineage the fix reads, and is mutation-checked: with the check stubbed to "clean" the leak
arm fails.

### Also

`test_r03_run_records_interpreter_and_package_set` failed on the calendar: its capability
fixture hardcoded `probed_at: 2026-07-06`, which passed init's 2160h staleness limit in
September and not in late October. It is relative to now.

**Not verified by:** a bench re-measure — skipped by the operator. The agent and skill files
changed again; evor-tick's 8.1 evidence row stays stale.

## [1.2.8] — 2026-09-14 — O-01 closed at the write side

`node_identity.py` made every READER tolerant of a node's two identities. That was the
right rescue for the runs already on disk, and it was never a fix: while any writer could
mint a second directory, the split kept being created and every reader needed the rescue
forever. A live run held `nodes/cf9f0020-…/results.json` beside
`nodes/n001-depthwise-unet/telemetry.jsonl` — one node, two directories, same run. The
original victim was integrity check 5, which failed a candidate holding **12,000
well-formed telemetry records** because it looked under the other one.

### Why the split was still being created

The agent surface is name-keyed **on purpose** — `evor_record_node` "Returns {ok, name} …
you never handle an internal id" — and the server surface is uuid-keyed. Both wrote
`nodes/<identity>/`, and nothing decided which owned the directory. Then
`agents/evor-forge.md` said:

> The harness exports EVOR_TELEMETRY_PATH, EVOR_NODE_ID, and EVOR_RUN_ID to the
> subprocess environment before training starts.

True of the EVAL subprocess (`evaluator.py::_build_env`), false of training, which
forge-junior launches through Bash where nothing sets it. So Forge exported it itself,
from the only identity it holds — the name.

### Writers can no longer choose

- **`evor_record_node` grants the canonical `telemetry_path`.** Forge passes it through
  verbatim instead of constructing one; the uuid stays inside an opaque path rather than
  being handed over as an id. The construction is gone, and with it the choice.
- **`telemetryIngest` resolves through `resolveNodeRef`,** not `tryResolveNodeRef` —
  `node-ref.ts` states the rule ("Readers use this; writers use resolveNodeRef") and the
  strict form throws when a populated tree does not claim the ref, which is the loud
  failure this needs. Resolving an unknown ref to itself is precisely what mints the
  second directory. It still returns the ref for an empty or unreadable tree, the
  legitimate pre-first-node case.
- **`python -m evor run` canonicalises** before exporting `EVOR_TELEMETRY_PATH`, via the
  new `node_identity.canonical_node_id` — the write-side half the module was missing.
- **`agents/evor-forge.md` corrected**, and `evaluator.py` now states that its env block
  covers the eval subprocess only, so the claim cannot be misread back into place.

### Readers that were still guessing

`dashboard/store.py` and `integrity.py` already resolved both identities. Three did not:

- `harness/evor/telemetry.py` built a single path; it resolves now, falling back to the
  **declared** path when the artifact exists under neither — a caller reporting "not yet
  written" must keep reporting exactly that, which is what stops the rescue degrading
  into "pass when missing".
- `hooks/stop.mjs`'s drift guard checked `nodes/<uuid>/telemetry.jsonl` only — the same
  guess that failed the 12,000-record node, and it fails toward "the candidate is bad".
- `hooks/lib/tick-completeness.mjs` (added in 1.2.7) carried its own ad-hoc alias list.
  It now asks the owner.

### One rule, two runtimes, pinned together

O-01 needs an owner in Python (the harness) and in JS (the hooks and the MCP server), so
`hooks/lib/node-identity.mjs` mirrors `harness/evor/node_identity.py`.
`mcp/tests/node-identity-parity.test.ts` runs both over the real split fixture and fails
if they disagree — two implementations of one rule is the shape of the original defect, and
a mirror without that test is just another reader with its own opinion.

The parity suite also pins the safety property in both: resolution can rescue a misfiled
artifact and can **never** manufacture one, so a genuine absence still fails the check.

## [1.2.7] — 2026-09-14 — a yield is not a return

Two guards, pulled in opposite directions, because that is what the evidence asked for.

### The tick's return contract had no word for waiting

`evor-tick` spans hours and around ten async agent boundaries and has no blocking
primitive — `TaskOutput` is not registered for a sub-agent. Its only way to wait is to end
its turn and be re-activated, which the platform does reliably. The field proves it:

| agent | yields | survived | matched by the tick return contract? |
|---|---|---|---|
| `evor-sage` | 7 | **7 of 7** | no |
| `evor-tick` | 8 | 7 of 8 | **yes** |

Sage yielded seven times with five live juniors and resumed every time. The tick died on
its eighth — at 42 turns of a declared 90, so not the cap. The only difference was
`TICK_OUTCOMES = ['scored','rejected','skipped','failed']`: no in-progress value. So a
yielding tick had to claim a TERMINAL outcome, and `failed` is the only one that can carry
an explanation. It emitted, three times in one tick:

```json
{"tick":1,"outcome":"failed","error":"Blocked mid-tick at Step 5 ... No blocking
 primitive available to hold turn across this compute-bound async boundary."}
```

Main read a dead tick and recovered the only way it could — a fresh tick agent, discarding
everything the first one knew. The contract could not express what was happening, so the
agent reported the nearest available falsehood. This was introduced with the contract and
survived 1.2.5: that release made the *mid-flight* guard yield-aware and left the *return*
coercion untouched.

- `yielding` is now an outcome, carrying `waiting_on`.
- The return contract is **not enforced at all** on a turn end that `isYieldingStop()`
  identifies as a yield — a yield has no return shape to violate. This restores exactly the
  sage behaviour.
- The block message now teaches the word, so a tick that has to be corrected learns that
  waiting is sayable.
- `skills/evor/SKILL.md` tells main a `yielding` return is not a finished tick: do not
  record it, do not advance the counter, **do not spawn a replacement**.

### A terminal return may not owe a selected candidate

`agents/evor-selector.md` said *"`selected` is true for at most one review"*;
`skills/evor/SKILL.md` said *"one Forge per approved proposal (up to
`ResourcePlan.concurrency`)"*. Two documents, two beliefs about how many candidates a tick
trains — and `concurrency` was persisted **nowhere in the run**, so the limit had no value
to read. In the field the selector selected h001 AND h003, `SelectorVerdict` accepted it
because nothing checked, only h001 was forged, and h003 was parked in a `carry_forward` key
defined in no skill, no agent file and no contract. Nothing read it. The tick reported step
9 done with an approved hypothesis silently gone.

- Multi-select is now the declared shape, and checked: the winner must be among the
  selected, and an **approved-but-unselected** proposal is rejected outright — it is a
  candidate that disappears.
- New `hooks/lib/tick-completeness.mjs` owns "what does this tick still owe". Both callers
  import it — the SubagentStop guard and the new `evor_tick_completeness` MCP tool. Both are
  JS, so no mirror and no parity test; a second implementation is how the evaluator ended up
  with four disagreeing beliefs about its own interface.
- The guard blocks a `"scored"` return that still owes a node, integrity verdict, fitness or
  telemetry for any selected proposal. It does **not** fire mid-tick, and does not fire on a
  `"failed"` return.
- Telemetry is looked up under the node's id AND its name, because the field run held both
  `nodes/<uuid>/results.json` and `nodes/<name>/telemetry.jsonl`. That split is a real
  defect and not this module's to fix; checking only the declared path reported a trained
  node as owing telemetry, and a completeness gate that fires on a finished candidate is
  worse than none.

### Why the guard is not what was first proposed

The original idea was to block the tick until all hypotheses were trained. That forbids the
only mechanism a tick has for waiting: its stop *is* its yield. It would have re-created the
livelock 1.2.3 and 1.2.5 removed — and it is the anti-pattern `hooks/lib/waiting.mjs`
already names, *guards are for state debt the agent can discharge right now*. Hence loose on
a yield, strict on a finish.

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
