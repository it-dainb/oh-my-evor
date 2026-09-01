# Lane A — Plugin Mutation / Guard Bypass Inventory (Wave 1)

PLUGIN = /home/dainb_1/.claude/plugins/cache/oh-my-evor/oh-my-evor/1.2.0
SRC    = /home/dainb_1/research/oh-my-evor @ bab279e (branch v1.2.1)
Method = sha256 of every `git ls-tree -r bab279e` path vs the installed file; noise dirs excluded.

## 0. Scope of divergence

17 tracked files modified. **Zero tracked files deleted.** New untracked files under PLUGIN
(excluding venv/state noise): `mcp/tests/tick-self-heal.test.ts` (250 lines, 22 cases),
plus `.evor/.deps-ok`, `.evor/user-prompt-throttle.json`, `.evor/runs/.../post-advisory-throttle.json`.

| file | -lines | +lines |
|---|---|---|
| agents/evor-tick.md | 0 | 20 |
| harness/evor/contracts.py | 0 | 27 |
| harness/evor/freeze.py | 7 | 166 |
| harness/evor/integrity.py | 53 | 757 |
| harness/tests/test_bench_evaluator.py | 2 | 6 |
| harness/tests/test_integrity.py | 0 | 109 |
| harness/tests/test_tabular_ladder.py | 1 | 3 |
| hooks/stop.mjs | 0 | 20 |
| mcp/bridge/integrity_bridge.py | 4 | 37 |
| mcp/dist/index.cjs | 605 | 973 |
| mcp/src/contracts.ts | 1 | 39 |
| mcp/src/tools/compute.ts | 2 | 10 |
| mcp/src/tools/record.ts | 6 | 104 |
| mcp/src/tools/state.ts | 1 | 477 |
| skills/evor-mcp/SKILL.md | 0 | 1 |
| skills/evor/SKILL.md | 5 | 23 |
| .evor/runs/frontier-1ms/run-live-01/mission-state.json | 2 | 5 |

## 1. Headline: the net direction is HARDENING, not bypass

This is the surprising result and it should be stated before the findings. The overwhelming
majority of the 757 added lines in `integrity.py` and the 104 in `record.ts` **replace stubs
that could never fail with checks that actually compute something**:

- pristine `_check_no_label_contamination` was literally `return True` with a docstring saying
  "Returns True by default when training data is not available" (SRC integrity.py, removed
  lines around `return True` at old L579). The installed version computes real sha256 overlap
  between train and every frozen eval split and hard-fails on any image-level overlap.
- pristine `_check_no_test_leakage` never compared train to test at all — it only checked for
  duplicate hashes *within* the frozen test split.
- pristine `record.ts` `fillNodeBookkeeping` persisted a caller-supplied `integrity_status`
  verbatim (`if (node.integrity_status === undefined) node.integrity_status = "pending"`).
  The installed version calls `enforceComputedIntegrity()`, which reads the harness-computed
  verdict from `evaluations/<node_id>.json`, overwrites the field with it, and demotes any
  caller claim to an advisory `integrity_status_claimed` + `integrity_claim_disagreement`.
  This closes a straightforward self-grading hole.
- `updateNodeAfterEval` no longer leaves `integrity_status` untouched when the bridge produced
  no verdict; it falls back to the last computed verdict, never to a claim.

So the run did not primarily disarm the harness. It found several no-op guards and made them
real. That said, three concrete weakenings and several durability problems remain, below.

## 2. Findings

### A-01 BYPASS — new agent-reachable `allow_refreeze` escape hatch on the frozen-split guard
Files: `harness/evor/freeze.py` (CLI `--allow-refreeze` arg, `main()`),
`mcp/src/tools/compute.ts` L126-140 (`allowRefreeze` param) and L612-628 (zod
`allow_refreeze` on the `evor_freeze_splits` tool).

In pristine bab279e, `FrozenSplitManager.freeze()` had an `allow_refreeze` kwarg but it was
**not reachable from the CLI and not exposed by the MCP tool** — the refusal message
("A frozen split is the denominator of every fitness comparison already recorded, so it cannot
change silently") was effectively absolute for an agent. The patch wires it end to end:
`evor_freeze_splits({ allow_refreeze: true })` → `--allow-refreeze` → guard skipped, split
replaced, `locked_split_hash` changes. The tool description names the risk but nothing enforces
it; there is no operator confirmation, no audit record of a refreeze, and the new hash silently
becomes the baseline for check 1 (`split_hash_match`) going forward.

### A-02 BYPASS — check 6 (reward_hacking_probe) was silently disarmed as a side effect of a check-2 "false positive fix"
File: `harness/evor/integrity.py`, `_compute_no_test_leakage` condition (b).

`_check_reward_hacking` itself is byte-identical to pristine, including its corroboration rule:
the near-perfect-value ceiling branch only fires when `corroborated=True`, i.e. when check 2 or
check 3 fails. What changed is the *supply* of corroboration. Pristine check 2 compared **all**
`per_sample_hashes` values including masks; the patch restricts the duplicate scan to image
hashes, justified in-comment as "36 such benign mask collisions measured in corpora/v10".
On that corpus, pristine check 2 failed → `corroborated=True` → a >=0.98 val score would have
been flagged as a leakage ceiling. After the patch check 2 passes → `corroborated=False` →
**the ceiling branch can no longer fire on this mission at all.** The per-step spike branch is
unaffected. The mask-collision reasoning is defensible on its merits; the disarming of check 6
appears to be an unnoticed second-order effect.

### A-03 BYPASS(-adjacent) — `skipped` / INDETERMINATE statuses are a new third state whose verdict contribution needs auditing
Files: `harness/evor/integrity.py` (`_compute_no_test_leakage`, `_compute_no_label_contamination`,
`_check_telemetry_sane`), `harness/evor/contracts.py` L719-740, `mcp/src/contracts.ts` L370-397.

The rewrite introduces `*_status ∈ {passed, failed, skipped}` alongside the booleans. Verified
good: `_check_telemetry_sane` returns `(False, "skipped", ...)` for a missing file, so an
absent telemetry.jsonl still lands in `failures` and still fails the verdict — same as pristine's
`if not telemetry_path.exists(): return False`. Verified less good: `_compute_no_test_leakage`
and `_compute_no_label_contamination` return `(True, "skipped", ...)` when the corpus layout is
unresolvable. The detail string says INDETERMINATE, but the **boolean fed into `failures` and
into `corroborated` is `True`** — i.e. an unresolvable corpus reads as clean. That is the same
shape as the stub it replaced, only now with a paper trail. It is a strict improvement in
observability and no change in verdict, but it is not the "never a silent pass" the docstrings
claim.

### A-04 MAJOR (durability) — none of this exists in SRC's history, on any branch
`git log --all -S` over `evor_tick_resume`, `enforceComputedIntegrity`, `integrity_status_claimed`,
`item_count_override`, `enumerate_split_pairs`, `_compute_no_label_contamination`,
`auto_resume_count`, `tick-self-heal` returns **0 commits for every one of them**. No stash, no
unmerged branch, no commit anywhere after 2026-08-23. Roughly 1,500 net added lines — including
every genuine hardening in A-01..A-03 and the entire tick self-heal feature — exist **only in
the installed plugin cache** and will be destroyed by the next `oh-my-evor` plugin update. This
is the single highest-value item to act on: the work is good and it is one `claude plugin update`
away from being gone, with no diff to recover it from other than the `.bak-*` chain.

### A-05 FEATURE — tick self-heal / stall detection (largest single addition)
Files: `mcp/src/tools/state.ts` (+477: `TERMINAL_STEP`, `DEFAULT_STALE_SECONDS=300`,
`DEFAULT_MAX_AUTO_RESUMES=5`, `envInt`, `checkTickHealth`, `tickResume`, and the new
`evor_tick_resume` MCP tool), `mcp/tests/tick-self-heal.test.ts` (new, 22 cases),
`skills/evor/SKILL.md`, `skills/evor-mcp/SKILL.md`, `agents/evor-tick.md`, `hooks/stop.mjs`.

Detects a tick that has gone stale (incomplete, no terminal verdict, `updated_at` older than the
threshold) and returns `action: resume|fail|none`; on `resume` it patches `auto_resume_count`
into tick-state, on `fail` it marks the tick failed and emits a `critical` `orchestration_stall`
signal. The stated motivation, repeated in three files, is a measured failure mode: "a sub-agent
spawning a background child and yielding, and its caller reading that yield as a completed
return", five times across three missions. Test coverage is unusually thorough for mid-run work
(no-false-positive, no-re-dispatch, budget-reset, cap-bound cases).

### A-06 MINOR — `hooks/stop.mjs` was NOT weakened
`blockStop()` is still called on the same `started && !finished` condition. The +20 lines only
add a staleness note (`ageS`, `auto_resume_count`) and an instruction to call `evor_tick_resume`
first. The stop hook's termination control is intact. Flagging explicitly because a stop-hook
edit is the obvious place to look for a termination bypass and there isn't one here.

### A-07 MINOR — `mcp/dist/index.cjs` is a faithful rebuild, not a hand-edit
Rebuilt `mcp/src/index.ts` with the plugin's own esbuild and build config into a scratch outfile
and diffed. After normalising esbuild's cwd-relative path comments, the residual diff is
**a single line** — one string literal where the em-dash is `—`-escaped in our rebuild and
literal in the installed file (an esbuild charset/version artifact). No injected logic. Every
new src identifier (`evor_tick_resume`, `enforceComputedIntegrity`, `readComputedVerdict`,
`integrity_claim_disagreement`, `allow_refreeze`) is present in dist at the expected counts.

### A-08 MINOR — TEST-TAMPER: none found. All three touched test files got stronger.
This is the finding the brief anticipated and it does not hold up:
- `test_bench_evaluator.py` (-2/+6) and `test_tabular_ladder.py` (-1/+3): mechanical adaptation
  to `_check_telemetry_sane`'s new `(bool, status, detail)` tuple return. Each replaced
  `assert ... is True` with **two** assertions (`sane is True` *and* `status == "passed"`) plus
  `detail` as the failure message. Strictly stronger, no expectation relaxed.
- `test_integrity.py` (-0/+109): pure addition of `TestTelemetrySaneHardened` with 9 new cases
  (empty file, duplicate steps, non-monotonic steps, NaN loss, constant loss, missing-file-is-
  skipped, slug-dir resolution). Nothing deleted, nothing skipped, no `.only`/`.skip` introduced.

### A-09 MINOR — one new test is machine-coupled and will permanently skip everywhere else
File: `harness/tests/test_integrity.py::TestTelemetrySaneHardened::test_real_production_node_passes`.
Hardcodes `/home/dainb_1/research/binarization/.evor/runs/binarization-worldmodel-min98-2026-08-r3/
run-live-01/nodes/iir-scan-binnet-02/telemetry.jsonl` and `pytest.skip`s when absent. It asserts
`== 12000` records. This is the agent canonicalising the exact artifact it was unblocking as a
regression test; on CI or any other machine it is a silent no-op that inflates the green count.

### A-10 MINOR — `item_count` no longer equals `len(per_sample_hashes)`
File: `harness/evor/freeze.py` (`item_count_override`, `_pair_entries`).
For pre-defined splits, both image and mask are hashed, so `per_sample_hashes` has 2N entries
while `item_count` is now overridden to N logical pairs. The override is derived internally from
`len(test_pairs)` and is **not** reachable from the CLI or MCP, so it is not an agent-controlled
lever — but any consumer or assertion relying on `item_count == len(per_sample_hashes)` now
breaks, and the refreeze-refusal message compares override-derived counts.

### A-11 SELF-HEAL — node-dir resolution and val-split plumbing in the bridge
File: `mcp/bridge/integrity_bridge.py` L169-232.
Pristine looked only at `run_dir/nodes/<args.node_id>/telemetry.jsonl`; on disk the node dir may
be keyed by slug (`node.name`) rather than UUID, so a healthy telemetry file read as missing and
check 5 hard-failed. The patch searches `args.node_id`, `node.id`, `node.name`. Same for
`provenance.jsonl`. It also loads the val split and passes `frozen_val=` so checks 2/3 compare
train against every eval split. Legitimate fix for a real false-failure; note it is the direct
cause of A-09's test existing.

### A-12 SELF-HEAL/FEATURE — manifest-form corpus split discovery in freeze.py
File: `harness/evor/freeze.py` +130 lines (`_resolve_store_root`, `_resolve_referenced_file`,
`_pairs_from_frozen_index`, `_pairs_from_split_txt`, `enumerate_split_pairs`, `_pair_entries`).
The legacy `iterdir` + 80/20 scan froze a manifest corpus's *metadata files* as the eval set and
returned ok over zero images. New precedence: `frozen_index.json` → `test.txt`/`val.txt` →
legacy scan. A referenced file that does not exist is a hard `FileNotFoundError` rather than a
silently shrunk split — correct call, since the split is the fitness denominator.

### A-13 COSMETIC — `.evor/runs/frontier-1ms/run-live-01/mission-state.json`
`"status": "locked"` → `"paused"`, plus `paused_at` / `paused_by: "session-end-hook"`. Shipped
run state mutated by a hook, not an agent edit. Also note this same file is dirty in SRC's
working tree.

## 3. Timeline (reconstructed from `.bak-<ts>` names; 29 backups, 7 waves)

| wave | files backed up | apparent intent |
|---|---|---|
| 20260823-083205 | freeze.py | manifest-corpus split discovery + `item_count_override` (A-12, A-10) — unblock a freeze that produced an empty eval set |
| 20260823-083554 | compute.ts, dist | expose `allow_refreeze` through the MCP tool (A-01) — re-freeze the split the previous wave got wrong |
| 20260823-2350 | contracts.py, integrity.py, integrity_bridge.py, contracts.ts, record.ts, dist | the big one: real leakage/contamination computation, computed-verdict enforcement in record.ts (A-03, A-02 as a side effect), val-split plumbing |
| 20260824-013931 | evor-tick.md, stop.mjs, state.ts, contracts.ts, evor/SKILL.md, evor-mcp/SKILL.md, dist | tick self-heal feature landed across runtime + docs + agent + hook (A-05, A-06) |
| 20260824-020302 | contracts.py, integrity.py, integrity_bridge.py, contracts.ts, dist | integrity.py 744 → 1303 lines; status/detail triples threaded into both schemas |
| 20260824-021010 | contracts.py, integrity.py, integrity_bridge.py, test_bench_evaluator.py, test_tabular_ladder.py, contracts.ts, dist | first test-file wave — adapting the two callers to the new tuple return (A-08) |
| 20260824-021846 | test_integrity.py | last wave: 9 new telemetry cases incl. the machine-coupled one (A-09) |

Note freeze.py has only one backup (wave 1) while integrity.py has three — the freeze work landed
in one pass, the integrity rewrite was iterated on across three waves (744 → 1303 → 1303 → 1448
lines, so wave 021010 changed it without changing line count and the final +145 lines were
written after the last backup).

## 4. What wave 2 should drill into, ranked

1. A-01: is `allow_refreeze` ever actually invoked in the binarization run? Grep the run's MCP
   call log / `.evor/runs/**` for `allow_refreeze` and compare `locked_split_hash` across
   `goal-contract.json` revisions. If the split was re-frozen mid-run, every fitness number
   before and after that point is on a different denominator.
2. A-02: re-run check 6 against the binarization corpus with pristine vs patched check 2 and
   confirm whether any node scored >= 0.98 in the window where the ceiling branch was disarmed.
3. A-04: capture the full plugin→SRC diff as a patch series now, before any plugin update.
4. A-03: decide whether INDETERMINATE should be `False` (fail-closed) rather than `True`.
