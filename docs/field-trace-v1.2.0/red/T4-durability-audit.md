# T4 — Durability and audit — RED phase

Category 4 of the wave-2 sweep (`A-04` `P-01` `P-02` `I-01` `I-11` `O-09` `R-02`).
Failing tests only; no file under `harness/evor/**`, `mcp/src/**` or `hooks/**` was
modified.

**Result: 16 RED (15 unit + 1 live), 1 ALREADY-GREEN (live P-02, under the tested
configuration only), 1 NOT-TESTABLE.**

Test files
- `harness/tests/test_wave1_durability_audit.py` — 6 unit tests, all RED
- `mcp/tests/wave1-durability-audit.test.ts` — 9 unit tests, all RED
- `ci/durability-live.mjs` + `mcp/tests/durability-live.test.ts` — live lane,
  real model driving the real MCP tool surface; RED, observed three times

Re-run
```
cd /home/dainb_1/research/oh-my-evor/harness && python -m pytest tests/test_wave1_durability_audit.py -q
cd /home/dainb_1/research/oh-my-evor/mcp     && npx vitest run tests/wave1-durability-audit.test.ts
cd /home/dainb_1/research/oh-my-evor/mcp     && EVOR_LIVE_EVAL=1 npx vitest run tests/durability-live.test.ts
cd /home/dainb_1/research/oh-my-evor         && node ci/durability-live.mjs      # the probe alone
```

Every failure below is on its own assertion. None is an import, typo or fixture
error: each fixture step that could fail silently (`run_init_run` returning 0,
the seal call returning `ok`, the contract actually being mutated, `active-run.json`
actually moving) carries its own `fixture:` assertion ahead of the invariant, and
`npm run typecheck` in `mcp/` is clean.

---

## I-01 — a materially significant action reaches `decision-log.md`

The field artifact contains a header plus `node_id / approach_family / status /
depth` stubs and nothing else. Answering the lane's own wave-2 question — *is
there any code path that can write a non-node event to it?* — there are four:
`tree.py` (crossover refusal), `monitor.py` (self-heal), `angle_registry.py`
(coverage alert) and `benchmark.py` (`## BenchmarkUpgrade` block). **None of them
covers a mission transition, an evaluator change, a gate change, or a contract
mutation.** `benchmark.py:185` is the shape the others should copy; these tests
assert the missing four against their real writers, not against the field file.

### `mcp/tests/wave1-durability-audit.test.ts` → `a mission status transition is recorded in the decision log`
**Invariant:** `stateWrite` — the sole writer of `mission-state.json.status` — must
append the transition to `decision-log.md`. **Status: RED.**
```
AssertionError: stateWrite flipped mission-state.json to 'failed' and wrote NOTHING to
decision-log.md — the transition survives only as a mutated field with no history
(field-trace I-01): expected '' not to be '' // Object.is equality
 ❯ tests/wave1-durability-audit.test.ts:137:11
```

### `harness/tests/test_wave1_durability_audit.py::test_starting_a_successor_mission_logs_the_supersede_in_the_prior_run`
**Invariant:** bootstrapping a successor mission in an `.evor/` root that already
holds one must leave a supersede entry in the predecessor's `decision-log.md`.
`run_init_run` is the writer that knows this is happening — it rewrites
`active-run.json`, which names the predecessor. **Status: RED.**
```
AssertionError: starting mission 'binarization-r2' left NO entry in the superseded run's
decision-log.md — the restart is invisible in the durable record (field-trace I-01)
assert ''
```

### `mcp/tests/wave1-durability-audit.test.ts` → `re-sealing a changed evaluator is recorded in the decision log`
**Invariant:** `evor_seal_eval_script` called when the contract already anchors a
*different* `eval_script_hash` is not a first seal — it is an evaluator
replacement, and must be logged. This is the mechanism behind
`8d7107cf → 3dc2f7da → f123d17c → a3776de4`. **Status: RED.**
```
AssertionError: the sealed evaluator anchor was replaced with no decision-log entry —
the previous evaluator's scores become unreproducible and nothing records that it
changed (field-trace I-01): expected '' not to be '' // Object.is equality
 ❯ tests/wave1-durability-audit.test.ts:172:11
```

### `mcp/tests/wave1-durability-audit.test.ts` → `mutating a sealed goal contract is recorded in the decision log`
**Invariant:** the entry named in the log must identify *which* contract field
changed. `patchGoalContract` (`compute.ts:382`) is the only MCP path that rewrites
a sealed `goal-contract.json`, and it is silent and best-effort by construction —
it is also the shape a gate change takes (GPU 10 ms→500 ms, CPU 0.1 s→1.0 s).
**Status: RED.**
```
AssertionError: goal-contract.json fields ["eval_script_hash"] were rewritten with no
entry naming them in decision-log.md: expected '' to contain 'eval_script_hash'
 ❯ tests/wave1-durability-audit.test.ts:206:7
```

---

## I-11 / O-09 — run state is freely mutable and carries no history

**Choice of invariant, as required by the brief.** Three candidates were on the
table: reject a retroactive status write; record it as a dated correction; or make
every transition append-only. I assert **append-only**, plus **no concurrent live
missions**, and treat "reject the retroactive write" as unenforceable in isolation.
Reasoning: a writer cannot tell a legitimate late close-out from an illegitimate
one — the field's own backfill was the *honest* action, taken because the parent
had told the operator "both superseded missions still read status: 'running'…
I'd close them out explicitly." Rejecting it would have blocked the correct fix.
Append-only subsumes the other two: with a durable trail a late correction is
still visible *as* a late correction, because its entry carries the time it was
made. `updated_at` cannot do this — the next write overwrites it, which is exactly
why the run's history is unreconstructable from the state tree. And preventing the
overlap removes the condition that made a 14-hour backfill necessary at all.

### `mcp/tests/wave1-durability-audit.test.ts` → `every transition appends a timestamped, append-only audit entry`
**Invariant:** two successive `stateWrite` transitions must both survive, each with
its own timestamp. **Status: RED.**
```
AssertionError: mission-state.json records only the CURRENT status; the running→paused
transition was overwritten by paused→failed and is gone. Two writes, zero surviving
history entries (keys: ["status","objective","current_tick","updated_at"]):
expected +0 to be 2 // Object.is equality
 ❯ tests/wave1-durability-audit.test.ts:241:7
```

### `mcp/tests/wave1-durability-audit.test.ts` → `two missions in one .evor/ root cannot both be running`
**Invariant:** marking a second mission `running` while another is running in the
same root must be refused. **Status: RED.**
```
AssertionError: a second mission was marked running while binarization-r1 was already
running in the same .evor/ root (field-trace O-09): expected [Function] to throw an error
 ❯ tests/wave1-durability-audit.test.ts:284:7
```

### `harness/tests/…::test_starting_a_successor_mission_closes_out_the_prior_mission_state`
**Invariant:** the harness half of the same rule — once `active-run.json` has moved
to the successor, the predecessor must not still read `running`. **Status: RED.**
```
AssertionError: binarization-r1 still reads status='running' after binarization-r2 took
over active-run.json — an orphaned mission left live is exactly the state that had to be
hand-backfilled 14h39m later (field-trace O-09)
assert 'running' not in {'locked', 'running'}
```

### `mcp/tests/wave1-durability-audit.test.ts` → `a terminal transition carries a reason and names its successor`
**Invariant:** the tool surface must accept the *why* in the same call that makes
the transition. `superseded_by` / `superseded_reason` were hand-typed because
`RunStatePatchSchema` has no field for either — and the hand-typed reason then
disagreed with the run's own `tick-state.halt_reason`. A reason produced by the
transition cannot drift from the state that caused it. **Status: RED.**
```
AssertionError: RunStatePatchSchema silently drops the reason for a terminal transition —
there is no supported way to record WHY a mission failed, which is why it was hand-written
into the artifact 14h39m later (field-trace I-11): expected undefined to be truthy
 ❯ tests/wave1-durability-audit.test.ts:267:7
```

### `harness/tests/…::test_closing_out_a_mission_records_why_and_when`
**Invariant:** the harness half — a superseded mission's `mission-state.json` must
carry a machine-written reason and name its successor. **Status: RED.**
```
AssertionError: the superseded mission carries no machine-written reason for leaving its
live state; mission-state.json keys = ['best_node_id', 'best_score', 'current_tick',
'max_ticks', 'objective', 'started_at', 'status', 'updated_at']
assert []
```

---

## P-02 — no writer may put run state inside the installed plugin

Scope split as agreed: the sibling lane covers the *hook resolver*; these cover the
*harness and MCP writers*. Each test builds a directory that is unambiguously an
installed plugin (`.claude-plugin/plugin.json`, laid out as
`plugins/cache/oh-my-evor/oh-my-evor/1.2.0/`) and points the state root at it.

### `mcp/tests/wave1-durability-audit.test.ts` → `stateWrite refuses a run whose state root is inside a plugin tree`
**Invariant:** `stateWrite` must refuse; `active-run.json` must not appear under the
plugin root. **Status: RED.**
```
AssertionError: stateWrite wrote mission state and active-run.json inside the installed
plugin tree (field-trace P-02): expected [Function] to throw an error
 ❯ tests/wave1-durability-audit.test.ts:327:7
```

### `harness/tests/…::test_init_run_refuses_an_evor_root_inside_an_installed_plugin`
**Invariant:** the bootstrapper must refuse. This is the writer that produced the
exact artifacts P-01/P-02 found in both the cache and the marketplace clone.
**Status: RED.**
```
AssertionError: run_init_run bootstrapped a mission inside the installed plugin tree
(field-trace P-02)
assert 0 == 1
```

### `harness/tests/…::test_signal_bus_refuses_a_run_dir_inside_an_installed_plugin`
**Invariant:** `SignalBus.emit` must refuse and must not create `signals.jsonl`.
**Status: RED.**
```
Failed: DID NOT RAISE Exception
```

### `harness/tests/…::test_write_artifact_refuses_a_run_dir_inside_an_installed_plugin`
**Invariant:** `write_artifact` reports by return value, so the refusal is asserted
on the envelope *and* on the filesystem — an error return that still wrote the file
would not close this. **Status: RED.**
```
AssertionError: write_artifact accepted a run_dir inside the installed plugin tree and
returned {'ok': True, 'path': '…/plugins/cache/oh-my-evor/oh-my-evor/1.2.0/.evor/runs/
frontier-1ms/run-live-01/ticks/1/probe/findings.json'} (field-trace P-02)
```

---

## A-04 / P-01 — a released plugin tree is verifiable against its commit

**Scope, stated explicitly.** That ~3,000 lines of in-place patching were never
committed is a *process* gap; no test can commit them, and the GREEN phase must not
be sent looking for one. What is a genuine *code* gap is that **no drift check is
even possible**: nothing records what the shipped tree is supposed to contain, so a
mutated installed tree is undetectable except by the manual `diff -rq` against a
fresh clone that lanes A and P had to run by hand, after the fact.

`dist-freshness.test.ts` was read first and is not duplicated: it compares mtimes of
`dist` vs `src` *inside a checkout* and cannot see an installed tree at all. These
two extend the same idea by one step — bind the shipped tree to a recorded commit.

### `mcp/tests/wave1-durability-audit.test.ts` → `the release records the commit the shipped tree was built from`
**Invariant:** `.claude-plugin/` must carry either a commit field on `plugin.json`
or a hash-manifest sidecar. A version string is not provenance: it does not change
when 15 tracked files are patched in place. **Status: RED.**
```
AssertionError: nothing in .claude-plugin/ records the commit or the per-file hashes the
shipped tree was built from, so an installed tree cannot be compared against its release.
plugin.json carries only a version string, and a version string does not change when 15
files are patched in place (field-trace A-04 / P-01): expected [] to not deeply equal []
 ❯ tests/wave1-durability-audit.test.ts:368:11
```

### `mcp/tests/wave1-durability-audit.test.ts` → `a drift check exists that would flag a modified installed tree`
**Invariant:** `harness/evor/doctor.py` — the self-check that ships with the plugin
and is the only checker that runs *inside* an installed tree for a real user — must
carry a plugin-tree drift check. It currently checks `.evor/` layout and mission
state and says nothing about the plugin's own files. **Status: RED.**
```
AssertionError: harness/evor/doctor.py — the check that runs inside the installed tree —
has no plugin-tree drift check, so 15 modified tracked files and 26 leftover .bak-* files
went unreported for 19 hours (field-trace A-04 / P-01): expected false to be true
 ❯ tests/wave1-durability-audit.test.ts:382:7
```

**What GREEN can and cannot close here.** Code can close: emit a
`.claude-plugin/MANIFEST.sha256` at release time, and add a `plugin_tree` check to
`evor doctor` that recomputes it. Code cannot close: getting the ~3,000 patched
lines into a commit. That needs a human capturing the plugin→SRC diff as a patch
series *before* the next `claude plugin update` deletes it (lane A's own
recommendation 3), and a release rule that a shipped tree is only ever built from a
clean checkout.

---

## R-02 — reference `.gitignore` and setup path — **NOT-TESTABLE**

**Status: NOT-TESTABLE (as a unit test in this repo). Reason, verified rather than
assumed:** the finding is a property of the *user's* project (`~/research/binarization`
is not a git repo and its `.gitignore` is decorative), and this repo ships no code
path that creates or verifies a project-side ignore file. Checked and found nothing:

- `grep -rn "gitignore|git init"` over all `*.sh`, `*.py`, `*.ts`, `*.mjs` in the
  repo returns only comments in `mcp/tests/agent-eval.test.ts` and `ci/…/README.md`
  — no writer, no verifier.
- `install.sh` (57 lines) installs the *plugin itself*: builds `mcp/dist/index.cjs`,
  pip-installs `harness/`, pre-warms the research MCP venvs, then prints
  `/plugin marketplace add`. It never touches a user project directory.
- `skills/evor-setup/SKILL.md` has no repo-hygiene step.
- `harness/evor/init_run.py` writes the 7 mission artifacts and `active-run.json`
  and nothing else.

A test asserting "setup produces an ignore file" would therefore be asserting a
feature that has no owner module — it would fail as an existence check on a name
nobody has chosen yet, and would send GREEN to invent a placement rather than fix
a defect. This repo's *own* `.gitignore` is thorough and already covers `.evor/runs/`,
`**/.omc/`, `__pycache__/`, `.venv/` and `.evor/.env`; it is the target project's
that is thin.

**What would close it** (in preference order, none of them a unit test):
1. A hygiene step in `skills/evor-setup/SKILL.md`: `git init` if absent, then write
   or extend the project `.gitignore` to cover `.evor/`, `.omc/`, `wandb/`, `.deps/`,
   `*.log`, `.claude/settings.local.json`, `.semantic_scholar_mcp/`. Once that step
   has a module behind it, a unit test becomes possible and should be added then.
2. A `repo_hygiene` check in `harness/evor/doctor.py` — same list, report-only —
   which *would* be directly unit-testable and is the cheapest real coverage here.
3. Docs: a "before your first mission" section stating that a mission's edits are
   unrecoverable without a repo.

Related and out of scope for this category's tests: `R-03` (no lockfile, shared
conda env, no hardware pin) is likewise a project/process property, not a defect in
this repo's code.

---

## LIVE lane — a real model, the real tool surface, and the diff

**Why the unit lane is not sufficient here.** Calling a writer proves the writer
works. `I-01` is the opposite shape: over 19 real hours, materially significant
actions happened and *nothing called the writer at all*. That is only visible when
a real session drives the real tools and you then diff what changed on disk against
what the durable record captured.

**Harness:** `ci/durability-live.mjs`, wrapped by `mcp/tests/durability-live.test.ts`.
One `claude -p` session per run, `--output-format stream-json` so the tool_use and
tool_result blocks are recorded, evor MCP attached via `--mcp-config` with
`EVOR_ROOT` pointed at a throwaway project, `--allowedTools mcp__evor` and
`--disallowedTools Bash,Write,Edit,MultiEdit,NotebookEdit,WebFetch,WebSearch,Task,Agent`.
The mission is seeded deterministically by `python -m evor init-run` — the model
never decides the starting state. The session is asked to do three things: record a
candidate node, re-seal a rewritten evaluator, and mark the mission failed.

**Two design points that make the result hard to fake.**
1. *Ground truth is the state delta, not the narration.* `happened` is computed from
   `mission-state.json`, `goal-contract.json` and `tree.json` before/after. An action
   the model claims but did not perform changes nothing, so it is not graded; an
   action that did change state must appear in the log or the test fails. Lane I
   established the agents narrate honestly — this probe does not depend on that.
2. *A positive control.* `evor_record_node` is the one class already wired to the
   decision log. If the control entry is missing the probe returns `harness_error`,
   never a finding — that is the signature of no MCP attached, a wrong run dir, or a
   model that called nothing.

**Gating.** `EVOR_LIVE_EVAL=1`. Off: the live block does not run and one assertion
keeps the lane from rotting (`node --check` on the probe). On: every assertion is
mandatory; the probe exits non-zero when it cannot run (no CLI, no credentials, no
`mcp/dist/index.cjs`) and the suite turns that into a failure. An unreachable model
is an error, not a pass.

### Runs

`claude-sonnet-5`, n=3 sessions, 4–12 turns each, 34–79 s, **$0.95 billed in total**
($0.465 / $0.218 / $0.263 per the CLI's own `total_cost_usd`).

| run | tools called | node (control) | mission running→failed | evaluator re-seal |
|---|---|---|---|---|
| 1 | record_node, state_write | logged | happened, **not logged** | not attempted |
| 2 | record_node, seal_eval_script, state_write | logged | happened, **not logged** | happened, **not logged** |
| 3 (via vitest) | record_node, state_write | logged | happened, **not logged** | not attempted |

Zero tool errors in all three; the model simply skipped the seal in runs 1 and 3,
which is ordinary model variance and is why `happened=false` is graded as
"nothing to observe" rather than as a pass.

### `I-01` LIVE — **RED** (3/3 runs)

**Invariant:** every artifact change a real session makes appears in `decision-log.md`.
Observed output from the gated vitest run:
```
  control (node_recorded): happened=true recorded=true
  mission_status_transition: happened=true recorded=false  [mission-state.json status "running" -> "failed"]
  evaluator_reseal_contract_mutation: happened=false recorded=false
  tools called: ToolSearch, mcp__evor__evor_record_node, mcp__evor__evor_state_write
  model=claude-sonnet-5 turns=4 cost=$0.2630808 wall=70.2s
  VERDICT: RED

AssertionError: these state changes were made by a real session and left NO entry in
decision-log.md. Everything the log gained was:

## record 2026-09-01T08:42:29.479Z
- node_id: d6d33885-d002-4f2d-b5f8-f166874810eb
- approach_family: data-curation
- status: pending
- depth: 0
: expected [ Array(1) ] to deeply equal []

+ Array [
+   "mission_status_transition (mission-state.json status \"running\" -> \"failed\")",
+ ]
 ❯ tests/durability-live.test.ts:130:7
```
From run 2, where the evaluator was also re-sealed (`def456cafeba → 41b5879c3032`,
`"tool_errors": []`), the log delta was again *only* the node stub. **This is the
field artifact reproduced end to end in 35 seconds for 22 cents:** the mission is
`failed`, the sealed evaluator anchor has moved, and the only durable narrative the
run produced is one `node_id / approach_family / status / depth` stub.

### `P-02` LIVE — **ALREADY-GREEN under the tested configuration**

**Invariant:** nothing writes run state outside the sandbox. Before/after sha256
inventories of this repo and of `~/.claude/plugins` are taken around the session and
classified: anything under a `.evor/` directory or bearing a run-state filename is
`run_state_leak`; unrelated churn is reported separately and not asserted on. The
session has no Bash, Write or Edit, so a run-state file outside the sandbox could
only come from an evor writer resolving its root wrongly.

`run_state_leak: []` in all three runs. Recorded honestly as **green for the
configuration actually tested** — cwd is the project and `EVOR_ROOT` is set, which is
the configuration that behaves. The configuration that produced the field artifact
(the state root resolving inside the plugin) is covered by the four unit tests above,
which are RED. Concurrent noise seen and correctly classified as such: another agent's
`ci/guard-probe.mjs`, OMC's `.in_use/<pid>` files, and pre-warming venv files under
the marketplace clone.

### What the live lane does NOT change

`R-02` stays NOT-TESTABLE. A real model cannot make the *user's* project a git
repository, and no amount of live coverage converts a process gap into a code defect.
The same holds for the uncommitted-plugin half of `A-04`/`P-01`.

---

## Summary

| finding | test | status |
|---|---|---|
| I-01 | `a mission status transition is recorded in the decision log` (ts) | RED |
| I-01 | `test_starting_a_successor_mission_logs_the_supersede_in_the_prior_run` (py) | RED |
| I-01 | `re-sealing a changed evaluator is recorded in the decision log` (ts) | RED |
| I-01 | `mutating a sealed goal contract is recorded in the decision log` (ts) | RED |
| I-11 | `every transition appends a timestamped, append-only audit entry` (ts) | RED |
| I-11 | `a terminal transition carries a reason and names its successor` (ts) | RED |
| I-11 | `test_closing_out_a_mission_records_why_and_when` (py) | RED |
| O-09 | `two missions in one .evor/ root cannot both be running` (ts) | RED |
| O-09 | `test_starting_a_successor_mission_closes_out_the_prior_mission_state` (py) | RED |
| P-02 | `stateWrite refuses a run whose state root is inside a plugin tree` (ts) | RED |
| P-02 | `test_init_run_refuses_an_evor_root_inside_an_installed_plugin` (py) | RED |
| P-02 | `test_signal_bus_refuses_a_run_dir_inside_an_installed_plugin` (py) | RED |
| P-02 | `test_write_artifact_refuses_a_run_dir_inside_an_installed_plugin` (py) | RED |
| A-04/P-01 | `the release records the commit the shipped tree was built from` (ts) | RED |
| A-04/P-01 | `a drift check exists that would flag a modified installed tree` (ts) | RED |
| I-01 | LIVE `I-01 LIVE: every state change a real session made is in the decision log` | RED (3/3 live runs) |
| P-02 | LIVE `P-02 LIVE: nothing wrote run state outside the sandbox` | ALREADY-GREEN (tested config only) |
| R-02 | — | NOT-TESTABLE (no owner module; needs a setup/doctor hygiene step first) |
