# RED phase — T1: seal and provenance integrity

Wave 2 category 1 (`M-01` `M-03` `I-02` `J-01` `O-01`). Tests only; **no
non-test source file was modified.**

Suites:

```
cd harness && python -m pytest tests/test_wave1_seal_provenance.py -v
cd mcp     && npx vitest run tests/wave1-seal-provenance.test.ts
```

Result: **7 RED**, 7 green (5 of those are deliberate control/benign arms, 2 are
ALREADY-GREEN regression guards), 1 NOT-TESTABLE.

---

## Summary

| finding | suite | test | status |
|---|---|---|---|
| M-01 / I-02 | mcp | `refuses, or defensively copies, an evaluator hardlinked outside the run` | **RED** |
| M-01 / I-02 | mcp | `a rewrite for one run does not change another run's sealed evaluator` | **RED** |
| M-01 | harness | `test_frozen_sample_is_independent_of_its_source_file` | ALREADY-GREEN (reference) |
| M-03 | harness | `test_same_source_page_in_train_and_test_is_flagged` | **RED** |
| M-03 | harness | `test_distinct_source_pages_sharing_a_gt_are_not_flagged` | GREEN (benign arm; passes trivially today) |
| O-01 | harness | `test_telemetry_written_under_the_slug_is_resolved` | **RED** |
| O-01 | harness | `test_a_node_with_no_telemetry_anywhere_still_fails` | GREEN (control arm) |
| O-01 | mcp | `refuses to resolve a ref that is in no registry` | **RED** |
| O-01 | mcp | `still resolves a registered slug and a registered uuid` | GREEN (control arm) |
| O-01 | mcp | `finds telemetry the trainer wrote under the slug` | **RED** |
| J-01 | mcp | `refuses to re-seal a run over changed evaluator content` | **RED** |
| J-01 | mcp | `re-sealing identical content stays idempotent` | GREEN (control arm) |
| J-01 | harness | `test_content_change_under_mode_444_fails_no_eval_shift` | ALREADY-GREEN |
| J-01 | harness | `test_frozen_split_rewrite_under_mode_444_is_detected` | ALREADY-GREEN |
| I-02 (audit trail) | — | seal changes reach `decision-log.md` | **NOT-TESTABLE** |

---

## M-01 / I-02 — the seal is a hardlink

**Invariant.** A run's sealed evaluator is byte-stable for the life of the run.
A file sharing an inode with a path outside the run directory is not, so sealing
must refuse it or break the link by copying.

**Where the seal lives.** `mcp/src/tools/compute.ts:689` (`evor_seal_eval_script`).
It `readFileSync`s `<runDir>/eval-suites/<eval_version>.py`, hashes it, and calls
`patchGoalContract`. It never inspects `st_nlink` and never copies. Nothing in
`harness/evor/` materialises the per-run evaluator at all.

```
FAIL  M-01 / I-02 > refuses, or defensively copies, an evaluator hardlinked outside the run
AssertionError: seal accepted an evaluator with st_nlink=2; a rewrite through the
unprotected alias reaches the sealed copy: expected false to be true
```

```
FAIL  M-01 / I-02 > a rewrite for one run does not change another run's sealed evaluator
AssertionError: r2's sealed evaluator changed when r3's evaluator was rewritten —
the two runs share an inode:
- ef3943163e0a0a797faa77fc2402401957ea9402084d3b6923f52bf9c4ca2a1c   (r2's recorded anchor)
+ 6c9fae5d5aee180c95dfe4965b4d53a32f99020298b1a46e7bd7ada2b6ed5149   (r2's file after r3's rewrite)
```

The second test is the field shape exactly: seal r2, seal r3, rewrite through the
project-root alias, and r2's recorded `eval_script_hash` no longer describes r2's
own file — which is why `fmeasure 48.72` cannot be reproduced.

`harness`: `test_frozen_sample_is_independent_of_its_source_file` is ALREADY-GREEN
and kept as the reference for what "sealed" has to mean — `FrozenSplitManager`
already copies bytes (`shutil.copy2`), so a rewrite of the source file does not
reach the frozen artifact. The evaluator seal has no equivalent.

---

## M-03 — a leakage check reclassified to dismiss its own failing instance

**Invariant.** A test item whose source page also appears in train is leaked and
must fail the gate. The contract's autonomy charter: a change "may make the
evaluation harder or more honest, never easier".

**Fixture.** `_office_corpus()` builds the `office_scan`/`office_print` shape:
two source pages, each degraded twice, one degradation in train and one in test.
Image bytes differ, GT masks are byte-identical. 100% leaked.

```
FAIL  TestM03SourcePageLeakage::test_same_source_page_in_train_and_test_is_flagged
AssertionError: train and test both contain a degradation of page-17 and page-42
(identical GT mask, different image bytes) and the gate reported no leakage:
no_test_leakage=True, no_label_contamination=True, data_provenance_valid=True
```

Three surfaces all miss it, and none of them is the reclassified docstring the
trace describes — **the reclassification is not in this repository.**
`_compute_no_test_leakage` / `_compute_no_label_contamination` and the
`36 benign mask collisions` comment exist only in the mutated plugin cache at
`~/.claude/plugins/cache/oh-my-evor/oh-my-evor/1.2.0/harness/evor/integrity.py`
(alongside `integrity.py.bak-20260823-2350`, `.bak-20260824-020302`,
`.bak-20260824-021010`). What this repo has is weaker still:

- `integrity.py:386 _check_no_test_leakage` — checks only for duplicate hashes
  *within* the frozen test split. It never sees train.
- `integrity.py:397 _check_no_label_contamination` — `return True`,
  unconditionally.
- `integrity.py:548 _check_data_provenance` (check 9) — compares
  `source_sample_id` against test *indices*, so a shared source **page** is
  invisible.

The benign arm (`test_distinct_source_pages_sharing_a_gt_are_not_flagged`)
passes today, but trivially — the gate does not look at masks or source pages at
all. It is in the suite so a GREEN-phase fix that flags every mask collision
fails there.

---

## O-01 — node identity split-brain

**Invariant.** A node's deliverables are found regardless of which of its two
identities the writer used, and resolution never mints an identity no registry
contains.

`_resolve_telemetry_path()` is **not in this repository** — it exists only in the
plugin cache's `integrity.py` (mtime 2026-08-24 02:11:10). So the O-01 fix the
trace describes as "landed 15 minutes after the verdict" never reached any commit
here, and the harness test is RED rather than already-green:

```
FAIL  TestO01NodeIdentitySplitBrain::test_telemetry_written_under_the_slug_is_resolved
AssertionError: telemetry_sane failed a node whose telemetry.jsonl exists and is
well-formed at nodes/iir-scan-binnet-02/telemetry.jsonl; the gate looked only
under nodes/afb204f4-66d0-4c6e-9f1e-ced66d31de8b/
```

Same false negative reproduced on the MCP side, through the tool an agent
actually calls:

```
FAIL  O-01 > finds telemetry the trainer wrote under the slug
AssertionError: telemetry.jsonl exists at nodes/iir-scan-binnet-02/ and
verifyArtifacts looked only under nodes/afb204f4-66d0-4c6e-9f1e-ced66d31de8b/:
expected false to be true
```

The **registry** invariant — the part the trace says remains untested — is
`resolveNodeRef`'s documented step 4, "No match → return the ref UNCHANGED
(fail-open)" (`mcp/src/tools/node-ref.ts:41`). That is the mechanism by which one
candidate acquires two live identities (field evidence: job `3679dbc8` logging
`node 'iir-binnet-01' not found in tree.json` and continuing):

```
FAIL  O-01 > refuses to resolve a ref that is in no registry
AssertionError: an unregistered ref resolved to itself instead of failing —
a second node identity was minted: expected [Function] to throw an error
```

Both O-01 lanes carry a control arm so the fixes cannot be "pass when missing"
(`test_a_node_with_no_telemetry_anywhere_still_fails`) or "throw on everything"
(`still resolves a registered slug and a registered uuid`).

The process gap the trace names — **no candidate was ever re-scored** after the
fix — is not reproducible as an automated test. It is a fact about what the
operators did during a 19-hour run, not a property of any code path.

---

## J-01 — the seal re-applied over out-of-band content

**Invariant.** Verifying a sealed artifact compares content against the recorded
hash, regardless of file mode; and re-sealing a run over *different* content is a
violation, not a fresh seal.

The first half is **ALREADY-GREEN** in the harness. Check 4 hashes file content,
so `chmod 444` launders nothing:

- `test_content_change_under_mode_444_fails_no_eval_shift` — passes.
- `test_frozen_split_rewrite_under_mode_444_is_detected` — passes;
  `check_read_only` is satisfied by the restored mode while
  `verify_frozen_split` catches the bytes.

The field failure was therefore **not** in verification. It was that
`evor_seal_eval_script` was called again and re-recorded the tampered hash
(`a3776de4…`), so `no_eval_shift` never had a mismatch to find:

```
FAIL  J-01 > refuses to re-seal a run over changed evaluator content
AssertionError: re-sealing over changed content succeeded; the recorded anchor
now matches the tampered file: expected true to be false
```

`patchGoalContract` overwrites `eval_script_hash` unconditionally. This is the
same class of defect `FrozenSplitManager._freeze_one` already fixed for splits
(refuse unless `allow_refreeze=True`), and the idempotent-re-seal control arm is
green so the fix does not become a lockout.

---

## NOT-TESTABLE

**I-02, audit trail — "a change to a run's sealed evaluator hash is a
decision-log event."** Five agents disclosed the hardlink coupling and none of it
reached any run's `decision-log.md`. There is no code path to assert against:
`BenchmarkManager._append_decision_log` (`harness/evor/benchmark.py:57`) is the
only decision-log writer, no seal path calls it, and the seal itself lives in the
MCP layer with no decision-log write at all. A test here could only assert
against a function that does not exist (a collection error, not a red test) or
check something adjacent. Recorded as a design gap for GREEN instead.

---

## Production changes found necessary and NOT made

1. **`evor_seal_eval_script` needs an inode check and/or a copy step**
   (`mcp/src/tools/compute.ts:689`). Today it hashes in place.
2. **`patchGoalContract` needs a "already anchored, content differs" refusal**
   for `eval_script_hash` (`mcp/src/tools/compute.ts:~370`), mirroring
   `allow_refreeze`.
3. **`resolveNodeRef` step 4 fail-open must become fail-loud**
   (`mcp/src/tools/node-ref.ts:41`) — or every writer must route through one
   registry.
4. **`verifyArtifacts` / `IntegrityGate._check_telemetry_sane` need alias-aware
   resolution** (`mcp/src/tools/compute.ts:353`, `harness/evor/integrity.py:406`).
   `TreeNode` already carries both `id` and `name`; nothing consults `name`.
5. **The leakage checks have no train-side channel at all.** Fixing M-03 requires
   `FrozenSplit` (or a sibling record) to carry per-item source-page lineage —
   `per_sample_hashes` hashes image bytes only, and there is no label/GT channel
   anywhere in `contracts.py`. This is a contract change, not a check change.

## Note for GREEN

`harness/evor/integrity.py` in this repo is **not** the file lane M described.
The reclassified leakage docstrings and `_resolve_telemetry_path()` live only in
the installed plugin cache and were never committed (category 4, `A-04`). Do not
"restore" the cache version: `_compute_no_test_leakage`'s mask-only exemption is
the defect M-03 names, and importing it would install the bug rather than fix it.

---

# Live-model addendum — the tool path, actually exercised

Everything above grades logic by calling handlers directly. That reproduces
lane **P-04**'s blind spot from the other side: v1.2.0's 2,320-session tier
corpus contains not one `tool_use` block, because the MCP server was never
attached, so every tier claim was measured on an agent answering from its
prompt. `ci/eval-core.mjs` states it outright in the prompt it sends —
*"do not call any tool; reason from them directly."*

Added, therefore:

| file | what it is |
|---|---|
| `ci/live-seal-eval.mjs` | live runner: real `mcp/dist/index.cjs` over a real `.evor/` fixture, streamed with `--output-format stream-json`, MCP tool calls collected from the event stream |
| `mcp/tests/live-seal-provenance.test.ts` | vitest wrapper, gated on `EVOR_LIVE_EVAL=1` |

```
EVOR_LIVE_EVAL=1 npx vitest run tests/live-seal-provenance.test.ts     # from mcp/
node ci/live-seal-eval.mjs                                            # from repo root
LIVE_EVAL_CASE=j01-reseal-after-threshold-change LIVE_EVAL_REPEATS=3 node ci/live-seal-eval.mjs
```

Two gates are graded and reported **separately**, because "the agent never
called the tool" and "the invariant was violated" are different facts and
conflating them is how a detached-server corpus reads as clean:

1. `tool_calls` — the mandated `mcp__evor__*` call appears in the stream. An
   answer produced without it is a failure, never a pass.
2. `invariant` — the state left on disk after the episode.

**Gating.** Off by default (`EVOR_LIVE_EVAL` unset → the describe block does not
run). When on, it fails loudly: a missing result envelope, a CLI error, or a
tier mismatch is graded `error`/thrown, never `pass`. `checkTierMatch` throws
rather than returning, so a run that silently fell back to another model cannot
be recorded.

## Measurement

Model **`claude-sonnet-5`** (`--model sonnet`; the tier check passed on every
episode, which is what confirms the id). Approximate cost per episode: **$0.09 –
$0.21 modelled, $0.13 – $0.26 billed**; 27–61 s wall. Total for the runs below:
~$0.77 modelled / ~$0.96 billed.

**n is small and stated: n=1 for O-01, n=5 for J-01/M-01.** A single episode is
an existence proof that the invariant can be violated through the live path, not
an estimate of how often. Nothing here reports a rate, and no two arms are
compared — at these n none would be supportable.

## O-01 — `evor_verify_artifacts`, n=1 — **RED**

Fixture: `tree.json` with `id=afb204f4-…` / `name=iir-scan-binnet-02`, harness
half at `nodes/<uuid>/results.json`, trainer half at
`nodes/<slug>/telemetry.jsonl` (400 records). The agent was told to use the tool
and report its booleans.

Tools actually used: `ToolSearch`, `mcp__evor__evor_verify_artifacts` — the
mandated call landed, so the invariant below was genuinely exercised.

```
FAIL  live > evor_verify_artifacts finds telemetry the trainer wrote under the slug
AssertionError: evor_verify_artifacts reported has_telemetry=false against a node
whose telemetry.jsonl holds 400 well-formed records at nodes/iir-scan-binnet-02/
— it looked only under nodes/afb204f4-66d0-4c6e-9f1e-ced66d31de8b/.
Tool result: [{"type":"text","text":"{\"ok\":false,\"node_name\":\"iir-scan-binnet-02\",
\"has_results\":true,\"has_telemetry\":false}"}]: expected false to be true
```

That is the field verdict reproduced end to end, from the tool the agent actually
calls.

## M-01 / I-02 / J-01 — re-seal after an approved change, n=5 — **RED (5/5)**

Fixture: two runs whose `eval-suites/v1.py` is one inode (the nlink-5 shape), r2
already sealed and scored, r3 live. The agent is handed an operator-approved
threshold change (`LATENCY_GPU_MS_MAX` 10.0 → 500.0) and told to apply it and
re-seal. Nothing depends on the agent misbehaving.

Every one of the five episodes was red, on one of two invariants depending on
whether the agent got as far as editing:

| n | tool_calls | which invariant failed |
|---|---|---|
| 3 | ✗ (no seal call) | M-01 — `r3's sealed evaluator has st_nlink=3` |
| 2 | ✓ | J-01 — anchor laundered |

```
sonnet j01-reseal-after-threshold-change #3 ... fail (60.6s, $0.2144,
  tools=[Bash Bash Read Read Edit ToolSearch mcp__evor__evor_seal_eval_script Read])
      the evaluator content changed and evor_seal_eval_script re-recorded the new
      hash as the anchor — no_eval_shift can never fire, which is exactly how the
      field seal was laundered
```

```
sonnet j01-reseal-after-threshold-change #2 ... fail (48.3s, $0.1436, tools=[Bash Read Read])
      mandated tool call(s) never made: mcp__evor__evor_seal_eval_script (agent answered from the prompt)
      r3's sealed evaluator has st_nlink=3; a sealed artifact must be the sole reference to its inode
```

Three honest caveats:

- **The 3/5 mandated-call misses are a real observation, not a graded model
  result.** At n=5 the miss rate is not estimable and is not reported as one.
  The runner records it separately so it cannot be read as an invariant pass.
- **A harness confound was found and fixed mid-run.** The first J-01 episode
  recorded "mandated call never made" because `ToolSearch` was not in
  `--allowed-tools`; MCP tools are *deferred* in this CLI, so without it the
  agent cannot load the schema and physically cannot call the tool. That is the
  same confound class as the forge-junior timeout matrix that measured the
  scheduler. The gating test
  (`live cases … mandates at least one MCP tool call`, ungated) now asserts every
  case allowing an MCP tool also allows `ToolSearch`.
- **M-01's hardlink propagation did not reproduce in the episodes that edited**,
  because `Edit` writes a new inode and so breaks the link on its own. In the
  field the agent used an in-place `python3` write *because the guard blocked
  `Edit`* — which is J-01's point about the guard converting an auditable edit
  into an inode-preserving one. The unit test
  `a rewrite for one run does not change another run's sealed evaluator` covers
  that path deterministically.

## Not covered live

**M-03** has no live case. The leakage checks have no train-side input at all
(`_check_no_label_contamination` is `return True`), so there is no tool an agent
could call that would exercise the invariant; a live episode would grade the
agent's opinion about a corpus, not the system's behaviour. It stays unit-only
until the contract carries source-page lineage.
