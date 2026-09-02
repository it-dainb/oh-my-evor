# Wave 1 — Lane O: Concurrency, Shared State & Storage Integrity

Scope: `/home/dainb_1/research/binarization/.evor` (read-only inventory, nothing modified).
Harness contract read from `/home/dainb_1/.claude/plugins/cache/oh-my-evor/oh-my-evor/1.2.0/harness/evor/*.py`
and `.../mcp/src/tools/{state,record}.ts`.

## Headline

**2 of 109 parsed state files are malformed** (and both are mislabelled, not corrupted — raw stderr in a
file named `*.jsonl`). **Zero JSON state files are truncated or partially written.** The artifact CAS is
**perfectly consistent** — 6 blobs, 6 refcount entries, 0 dangling, 0 orphaned, 0 leaked bytes.

**~170 MB of the 256 MB tree (66%) is redundant or abandoned**: 158 MB is two extra byte-identical copies
of the same 520-image frozen corpus, and 12 MB is an abandoned worktree checkpoint that was never evaluated.

**The headline risk is structural, not realised.** There is *no file locking anywhere in the harness* —
`grep -rn "flock|fcntl|filelock|LOCK_EX"` over all 29 Python modules returns **zero hits** — and
`SignalBus.emit()` is a full-file read-modify-rewrite. It survived 19 hours and 41 emits on a **2.55-second
margin**, purely because the three missions never overlapped in time. Nothing was lost to a race. The next
run that puts two emitters inside 2.5 s will silently lose a signal, and nothing in the system would notice.

---

## 1. Write-path contract (what the harness actually guarantees)

| Path | Mechanism | Atomic? | Locked? | Read-modify-write? |
|---|---|---|---|---|
| `store.ContentAddressedStore._save_refcounts` | tmp + `os.replace` | yes | **no** | **yes** (load→mutate→save) |
| `store.put` / `store.link` / `store.gc` | as above | yes | **no** | **yes** |
| `signals.SignalBus.emit` | `_atomic_write_jsonl` (mkstemp + `os.replace`) | yes | **no** | **yes — rewrites the ENTIRE file every emit** |
| `signals.drain_inbox` | `os.replace` claim before read | yes | n/a | claim-then-drain |
| `artifacts.write_artifact` | mkstemp in target dir + `os.replace` | yes | **no** | no (whole-payload put) |
| `tree._persist_visit_increments` / `meta_evolve` | `.tmp` + `os.replace` | yes | **no** | **yes** |
| `jobs._atomic_write` | tmp + rename | yes | **no** | no |
| **`handoff.write_handoff` / `write_tick_handoff`** | **plain `path.write_text`** | **NO** | no | no |
| `mcp state.ts` (`stateWrite`, `lockMission`, `tickResume`) | `.tmp` + `renameSync` | yes | **no** | **yes** |
| **`mcp record.ts recordEval`** (`nodes/<id>/results.json`) | **plain `writeFileSync`** | **NO** | no | no |

Every shared-file mutation is last-writer-wins with a read→mutate→replace window bounded only by
process scheduling. `os.replace` gives *crash*-atomicity (never a half-file), which is why nothing is
corrupt — but it gives **no** concurrency safety, which is why nothing is safe.

Two additional latent defects in that contract:

- `store._load_refcounts()` **unconditionally unlinks `.refcounts.json.tmp`** on every read, on the
  assumption it is a crash orphan. If a second process is mid-`put()`, its in-flight tmp is deleted out
  from under it and its `os.replace` raises `FileNotFoundError`. The "crash cleanup" is itself a race.
- `signals.drain_inbox` claims the inbox by rename, then unlinks the temp in a `finally`. A crash mid-drain
  therefore loses the **entire batch** of captured signals. Its docstring says "crash-safe"; it is
  duplicate-safe, not loss-safe.

## 2. Concurrency actually observed

98 subagent transcripts. **Peak concurrency: 9 simultaneous agents at 2026-08-23T09:41:42Z** (r1 tick-1
forge phase). 43 of 98 agents issued at least one mutating call.

Mutating-call census across all transcripts:

| Tool | Calls | Target |
|---|---|---|
| `evor_write_artifact` | 89 | per-agent file, **no collision possible** |
| `evor_signal_emit` | 41 | **one shared `signals.jsonl` per run** |
| `evor_state_write` | 21 | shared `run-state` / `tick-state` / `mission-state` / `active-run` |
| `evor_record_node` | 4 | shared `tree.json` |
| `evor_record_eval` | 2 | `nodes/<id>/results.json` |

Tightest cross-agent gap between two writes to the **same** file (`signals.jsonl`): **2.55 s**
(others: 2.64, 2.85, 3.31, 3.38, 3.79). Tightest cross-agent gap between any two shared-state MCP calls
overall: 0.43 s — but that pair was two `write_artifact` calls to different per-agent paths, so it was benign.

**The 21 `evor_state_write` calls are strictly sequential and never interleave between runs.** The full
mtime timeline confirms mission serialisation: r1 writes end 09:53:22, r2 begins 10:42:54, r2 ends 23:38:39,
r3 begins 23:52:03. The only cross-run interleave in 19 hours is the 40-second window at
00:12:56 → 00:13:36 where r3's `mission-state`/`strategy` is written and then r1's and r2's `mission-state`
files are back-filled — and those are three *different* files. **No two ticks, jobs, or runs ever wrote the
same state file concurrently.**

## 3. Findings

### O-01 — BLOCKER — Node-identity split-brain invalidated the run's only successful candidate

The node directory is keyed **two different ways by two different writers**:

```
r3/run-live-01/nodes/iir-scan-binnet-02/telemetry.jsonl        3,000,808 B, 12,000 records  (trainer writes by SLUG)
r3/run-live-01/nodes/afb204f4-66d0-…-ced66d31de8b/results.json     4,181 B                  (harness writes by UUID)
```

Same for r2 (`iir-binnet-01` vs `a0d33fe8-…`) and r1 (`multiscale-stroke-gate-01` vs `f87a29e0-…`).
Direct evidence the two halves never met — r2 job `3679dbc8`'s log:

> `[evor run] ERROR: node 'iir-binnet-01' not found in tree.json. Run evor_record_node before invoking the harness.`

Consequence: integrity check 5 (`telemetry_sane`) looked under the UUID, found nothing, and returned a
failing verdict. `r3/evaluations/afb204f4-….json` at 01:56:05 records
`verdict: failed`, `failure_reason: telemetry_sane`, against a node whose own
`results.json` reports `telemetry_summary.total_steps: 12000` and whose telemetry file has exactly 12,000
well-formed records. r3's `tick-state.json` names it outright:

> `"integrity_reason": "telemetry_sane false-negative (harness defect: telemetry_summary.total_steps=0 vs actual 12000 lines)"`

This is a **concurrency-of-identity** bug: two writers, two naming schemes, no shared registry. Job
`c4a5e447` succeeded (exit 0) and produced a fully-scored candidate; the identity mismatch failed it.

**The fix landed 15 minutes after the verdict.** `_resolve_telemetry_path()` (integrity.py:975) searches
both the UUID and the slug, and its docstring states the bug verbatim ("the telemetry writer and the gate
historically disagreed, which made a perfectly healthy 12k-step telemetry file look 'missing'"). It is
present in the live `integrity.py` (mtime 2026-08-24 02:11:10) and **absent from all three
`integrity.py.bak-*` snapshots** — so the 01:56 verdict was produced by pre-fix code, and no candidate
was ever re-scored under the fixed gate.

### O-02 — BLOCKER — Zero file locking; `SignalBus` rewrites the whole file on every emit

`grep -rn "flock\|fcntl\|filelock\|LOCK_EX" harness/evor/*.py` → **no matches**. `SignalBus.emit()`
calls `_load(path)` (parse every line), merges, then `_atomic_write_jsonl(path, ALL lines)`. Two emitters
inside the read→write window: the later write is built from a snapshot that predates the earlier one, and
the earlier signal vanishes with no trace — no gap marker, no sequence number, no error.

Observed minimum inter-emit gap: **2.55 s**. Nothing enforces that margin; it is an artifact of how slowly
these particular agents ran. With 9 concurrent agents and 41 emits, the run cleared this on luck.

Same unguarded read-modify-write applies to `tree.json` (`_persist_visit_increments`, `meta_evolve`),
`.refcounts.json`, and every `stateWrite` patch in `state.ts`.

**No lost update was actually detected** — see §4.

### O-03 — HIGH — `active-run.json` has said `"running"` for 8 days

```json
{"run_id":"run-live-01","status":"running","started_at":"2026-08-24T00:05:00Z","job_id":"c4a5e447-…"}
```
mtime 2026-08-24 01:30:08 — written at job *start*. That job's `status.json` records
`state: succeeded, exit_code: 0, finished_at: 2026-08-24T01:30:33`. **The job-completion path writes
`jobs/<id>/status.json` and nothing else**; `jobs.py::_supervise` never touches `active-run.json`, and
`state.ts` only writes it from an explicit `evor_state_write` patch. No writer owns the close transition.
Today is 2026-09-01: the file has advertised a live run for 8 days.

### O-04 — HIGH — r1's two tree nodes are stuck `running` forever; their jobs failed

```
r1/tree.json: f87a29e0-… status=running   1f5558ca-… status=running
r1/jobs/06ca7248 → node f87a29e0, state=failed, exit_code=1, finished 09:41:27
r1/jobs/7f2ae025 → node 1f5558ca, state=failed, exit_code=1, finished 09:45:51
```
Both jobs wrote `nodes/<uuid>/results.json` with `"status": "error"` (the corpus/domain-mapping
`EvalError`) at exactly those timestamps. **Nothing transitions `TreeNode.status` on job failure** — the
supervisor writes the job's own status file, the evaluator writes `results.json`, and neither owns the
tree. r2 and r3 reached `status: done` only because their orchestrator agent survived to call
`evor_record_node` a second time; r1's orchestrator halted at step 6 first.

Also note every node in all three trees has `score: null`, `fitness: null`, `updated_at: null`,
`visits: null` — the tree is write-once at creation and never updated with outcomes.

### O-05 — HIGH — Two independent status fields, permanently contradictory

| Run | `mission-state.status` | `run-state.status` | `tick-state.step_status` |
|---|---|---|---|
| r1 | **failed** | **running** | failed |
| r2 | **failed** | **running** | done |
| r3 | running | running | **running** (abandoned mid-step-9) |

`run-state.json` reads `"status": "running"` in **all three** runs, two of which are explicitly declared
failed and superseded. They are written by different code paths (`stateWrite` patches `mission_status` and
`status` into two different files) with no reconciliation and no invariant check. Any consumer reading
`run-state.json` sees three live runs.

Additional cross-field disagreement: `mission-state.current_tick` is `0` in all three runs while
`tick-state.tick` is `1` — two tick counters, one never advanced. And `mission-state.started_at` is
`null` in all three despite all three having run.

### O-06 — HIGH — 158 MB (62% of the tree) is byte-identical duplicated corpus; the CAS is bypassed

```
r1/frozen-splits  79M   522 files
r2/frozen-splits  79M   522 files
r3/frozen-splits  79M   522 files
```
Content hash of the sorted per-file md5 list is **identical across all three**: `d22a353a6d42ec6593ad2e5cd99bccaa`.
The manifests agree that they are the same corpus — `split_hash` is `790f91d0…` (val) and `86c6462a…`
(test) in **all three** manifests. Only `split_id`, `mission_id`, `frozen_at` and `storage_path` differ.

`stat` confirms three distinct inodes with link count 1 — **three full physical copies, no hardlinking,
no CAS**. `freeze.py` re-copies the corpus per mission even when it has just computed a `split_hash`
proving the corpus is unchanged.

Meanwhile the content-addressed store that exists specifically to prevent this holds **6 blobs totalling
~179 KB** of `genome.yaml` text and patches. Dedup is implemented and works — it is applied to 0.07% of
the bytes. Redundant: **158 MB** (two of three copies).

### O-07 — MEDIUM — 2 signals permanently dropped by an un-retried tool-name typo

35 distinct signatures were emitted across the run; 33 are on disk. The 2 missing:

| signature | emitted | result |
|---|---|---|
| `data-bottleneck-palm-leaf-370pages` | 2026-08-24T01:59:22.167Z | `is_error: true` — `No such tool available: mcp__plugin_oh-my_evor_evor__evor_signal_emit` |
| `selector-misaligned-criteria-data-family` | 2026-08-24T01:59:29.401Z | same |

The agent typed `oh-my_evor` for `oh-my-evor`, got a hard error, and **never retried**. These interleave
with three probe emits that *did* land (01:59:15, 01:59:18, 01:59:26), so the surface pattern mimics a
lost update — it is not one. Net effect is the same: two findings, one of them a governance signal about
selector criteria, are gone with no record anywhere except the transcript.

### O-08 — MEDIUM — r1's `tick_count` never incremented

`r1/run-state.json` has `"tick_count": 0` while `r1/tick-state.json` records tick 1 reaching step 6 and
failing. r2 and r3 both have `tick_count: 1`. The counter is bumped only by an explicit orchestrator
`evor_state_write` patch (r2's at 23:38:21, r3's at 02:00:08); r1's orchestrator halted before issuing it.
The counter is not derived from tick state, so it silently under-reports whenever a tick dies.

### O-09 — MEDIUM — `mission-state.json` hand-edited 14 h after the fact; the `.bak` chain proves it

Two `.bak-20260824T001336Z` files exist (r1, r2). Diff against live is exactly:

```
- "status": "running"
+ "status": "failed",
+ "superseded_by": "binarization-worldmodel-min98-2026-08-r3",
+ "superseded_reason": "…"
```

Both live files have mtime 2026-08-24 00:13:36 — r1's last real activity was 09:53 on 08-23 (**14h39m
earlier**), r2's was 23:38. Note the ordering: **r3's own `mission-state.json` was written at 00:12:56,
40 seconds *before* r1 and r2 were marked failed and superseded-by-r3.** The successor was created and
running before its predecessors were recorded as dead. No value regressed; nothing was clobbered; this is
a retroactive backfill, not a race — but the run's own history is now unreconstructable from the state
tree alone.

### O-10 — MEDIUM — 2 of 15 `.jsonl` files are not JSONL

```
r1/jobs/fe6281bb-…/log.jsonl  4/4 lines unparseable — raw argparse stderr
r2/jobs/3679dbc8-…/log.jsonl  1/1 lines unparseable — raw "[evor run] ERROR: node … not found"
```
`jobs.py::_supervise` pipes the child's raw stdout/stderr into a file named `log.jsonl`. It is a plain text
log with a JSONL extension. Every other job log happens to parse only because its single line is
coincidentally valid JSON. Any consumer that trusts the extension breaks on exactly the failures it most
needs to read. **These are the only 2 malformed files out of 109 parsed.**

### O-11 — MEDIUM — Orphaned `-partial.json` artifacts from truncated agents

`forge-report-partial.json` exists in all three runs. In **r3 the partial exists but the final
`forge-report.json` does not** — the forge agent wrote its checkpoint and never closed. Also
`r2/…/sage/juniors/curriculum-worst-group-partial.json` alongside the completed file.

Transcripts show **13 `write_artifact` calls with `partial: true` for agent `forge`**, all landing on the
same 3 paths — each overwriting the last. Partials are never reconciled, never cleaned up, and never
distinguished from finals by any reader. Lane D's 18 truncated agents are the supply side of this.

### O-12 — MEDIUM — Results rewritten 26 minutes later carrying a stale internal timestamp

```
r3/nodes/afb204f4-…/results.json   mtime 2026-08-24 01:56:05   internal "timestamp": 2026-08-24T01:30:33
```
The file was written at 01:30:33 by the job, then **rewritten at 01:56:05** by the integrity pass without
updating its own timestamp field. `recordEval` uses a bare non-atomic `writeFileSync` with no merge and no
staleness check. r1 and r2's results files have matching mtime/internal pairs; only r3's diverges — and
r3 is the run whose verdict was recomputed. mtime and content now disagree about when the record was made.

### O-13 — MEDIUM — Evaluation-record schema drifted mid-run

`r2/evaluations/*.json` has 10 `checks` keys and no `verdict_source`.
`r3/evaluations/*.json` has 16 keys — adds `eval_lock_stale`, `eval_lock_status`, `eval_lock_detail`,
`no_test_leakage_status`, `no_test_leakage_detail`, `no_label_contamination_status`,
`no_label_contamination_detail` — plus `verdict_source: "computed"`.

`tick-state.step_outputs` drifted too: r2 uses `fitness_value`, r3 uses `fitness`; r2 has
`min_domain_f_raw`, r3 has `integrity_reason`. Records from the same 19-hour run are not mutually
comparable, and no version field marks the boundary.

(Adjacent, Lane M's territory: `near_dup_leakage: false` and `reward_hacking_probe: false` in **both**
evaluations, with no `_status`/`_detail` companion — the always-false-together pattern.)

### O-14 — LOW — `tree.json`'s own `updated_at` predates a node it contains

```
r1/tree.json  updated_at            = 2026-08-23T09:44:29.017Z
r1  node 1f5558ca-…  created_at     = 2026-08-23T09:45:00+00:00   (31 s LATER)
```
The file has not been modified since 09:44:29 (confirmed by mtime) yet contains a node claiming creation at
09:45:00. Note the formats differ — `updated_at` is machine-generated (ms precision, `Z`), while both
nodes' `created_at` are suspiciously round (`09:39:30`, `09:45:00`, `+00:00`) — these are
**agent-supplied timestamps accepted without validation**, not filesystem evidence. So this is a
provenance defect, not proof of a write race. It does mean node creation times cannot be trusted for
causal ordering.

### O-15 — LOW — 12 MB of trained work abandoned in a worktree, never evaluated

`worktrees/multiscale-stroke-gate-01/` (12 MB, `weights.pt` 12,291,105 B, mtime 08-23 09:39). Its
`train_run.log` ends:

> `[trainer] DONE. steps=450 wall_clock_s=127.3 best_val_F=98.76 … params=3055921`

**r1's `evaluations/` directory is empty** (r2 and r3 have 1 each). The candidate trained to completion,
its checkpoint was never scored, and the run was marked failed. The other two worktrees
(`iir-binnet-01` 644 KB, `iir-scan-binnet-02` 860 KB) each hold `weights.pt`/`weights_best.pt`/
`weights_final.pt`/`train_state.pt` still on disk with no CAS entry.

**Correction to the lane brief's premise:** these are **not git worktrees**.
`/home/dainb_1/research/binarization` is not a git repository at all (`git worktree list` →
`fatal: not a git repository`), and none of the three directories contains a `.git` file. They are plain
directories. The documented OMC hazard — worktree-local state lost when the worktree is removed — **does
not apply here**; nothing was lost to worktree teardown. Each does hold an `evaluate.py.lock` (a 64-char
sha256 of the sealed evaluator), which is the only integrity-pinning mechanism in the worktrees and which
`_check_eval_lock` verified as `passed` for r3.

### O-16 — LOW — Two write paths lack tmp+rename entirely

`handoff.py:68` (`path.write_text(json.dumps(envelope))`), `handoff.py:185` (`path.write_text("\n".join(lines))`),
and `record.ts:314` (`writeFileSync(resultsPath, …)`). Every other writer in the codebase uses
tmp+`os.replace`/`renameSync`. These three can leave a genuinely half-written file on a crash. None did
here — all 7 handoff files and all 4 results files parse — but they are the only paths where the "nothing
is corrupt" result was luck rather than design.

### O-17 — LOW — `_load_refcounts()` deletes a concurrent writer's in-flight tmp

`store.py:60-64` unlinks `.refcounts.json.tmp` on every load, assuming it is a crash orphan. A concurrent
`put()` mid-write loses its tmp and its `os.replace` raises `FileNotFoundError`. Never triggered here
(6 total `put()` calls, all serialised).

### O-18 — LOW — `drain_inbox` loses the whole batch on a mid-drain crash

`signals.py:drain_inbox` renames the inbox to a temp, iterates, and unlinks in `finally`. A crash after the
rename loses every unprocessed line. The docstring claims crash-safety; it delivers *at-most-once*, not
at-least-once. No `signals-inbox.jsonl` or `*.drain-tmp` exists on disk now, so this never fired.

## 4. Categories with ZERO hits — stated explicitly

- **LOST-UPDATE / WRITE-RACE — 0 confirmed instances.** No field appears-then-vanishes, no counter
  regresses, no `.bak` shows a value going backwards, and the only two missing signals are explained by
  a tool-name typo returning `is_error: true` (O-07), not by a clobber. The hazard is fully present
  (O-02) but did not fire. The reason is O-A below.
- **ARTIFACT-STORE INTEGRITY — 0 defects.** 6 blobs on disk, 6 refcount entries, exact 1:1 match.
  Zero dangling (counted-but-absent), zero orphaned (present-but-uncounted). Every blob hash appears in
  at least one file outside the store (refs: 3, 2, 2, 1, 1, 1). The one refcount of `2`
  (`9a55f0c3…`) is a correct double-`put()` of the same genome, not a miscount. **0 leaked bytes.**
- **PARTIAL-WRITE / CORRUPTION of JSON — 0 instances.** All 92 `.json` files (plus 2 `.bak`) parse
  cleanly. All 13 real `.jsonl` files parse cleanly, including the 12,000-record and 6,600-record
  telemetry files. The only 2 failures are the mislabelled job logs (O-10), which were never JSON.
- **SIGNAL / EVENT ORDERING — 0 violations.** Across 33 signals: 0 duplicate `signal_id`, 0 duplicate
  `signature`, 0 records with `last_seen < first_seen`. One file-order inversion in r1 is the expected
  result of in-place dedup merging (`sig-95f7ff1666b6` occ=3, `sig-fb7016f53180` occ=2 both bumped
  `last_seen` without moving position) — correct behaviour, not corruption. Handoff files are
  monotonically named and monotonically timed.
- **CONCURRENT-TICK-HAZARD — 0 instances.** No two ticks, jobs, or runs ever wrote the same state file
  simultaneously. Mission write windows are disjoint (r1 ≤09:53:22, r2 10:42:54–23:38:39,
  r3 23:52:03–02:00:18). The r3-starts-23:51-while-r1/r2-written-00:13 overlap flagged in the brief is
  real but touches three *different* `mission-state.json` files 40 s apart (O-09).
- **WORKTREE-STATE LOSS — not applicable.** These are not git worktrees and the project is not a git
  repository (O-15); no state was lost to worktree removal.

### O-A — the structural reason nothing broke (and why that is fragile)

97 agents, 4 spawn depths, 9-way peak concurrency, zero locks — and no lost update. The explanation is
that **the fan-out was almost entirely read-only or write-disjoint**:

- 89 of the 156 mutating MCP calls were `write_artifact`, which resolves to a **per-agent, per-kind path**
  (`ticks/1/sage/juniors/<slug>.json`). Nine concurrent sage-juniors cannot collide by construction.
- All 21 `evor_state_write` and all 4 `evor_record_node` calls came from the **single tick orchestrator**,
  serialised by its own turn loop.
- Only `evor_signal_emit` (41 calls) put genuinely concurrent agents on one shared file, and those
  happened to space out at ≥2.55 s.

The safety came from the *shape of the workload*, not from the *storage layer*. Raise emit frequency,
add a second orchestrator, or let two missions overlap, and O-02 becomes a live data-loss bug with no
detection path — signals vanish silently, and §4's clean bill of health is exactly what a lost update
would also look like.

## 5. Storage accounting

| Component | Size | Verdict |
|---|---|---|
| `frozen-splits` × 3 (byte-identical) | 237 MB | **158 MB redundant** (2 extra copies) |
| `worktrees/multiscale-stroke-gate-01` | 12 MB | **abandoned** — trained, never evaluated |
| `worktrees/{iir-binnet-01, iir-scan-binnet-02}` | 1.5 MB | live checkpoints, not in CAS |
| `nodes/*/telemetry.jsonl` × 3 | 5.0 MB | valid, but split-brain-keyed (O-01) |
| CAS `artifacts/` × 3 | 179 KB | clean, 100% reachable |
| `wiki/`, state JSON, jobs, ticks | < 1 MB | — |
| **Total `.evor`** | **~256 MB** | **~170 MB (66%) redundant or abandoned** |

## 6. Wave-2 questions

1. Was any candidate ever re-scored under the fixed `_resolve_telemetry_path`, or does the whole 19 h
   end with a false-negative integrity verdict standing as the final result? (O-01)
2. What is the intended owner of the `active-run` → closed and `TreeNode.status` → terminal transitions?
   Is there a writer that was supposed to exist and doesn't? (O-03, O-04)
3. Why does `freeze.py` re-materialise a corpus whose `split_hash` it has just proven identical, when a
   working CAS with hardlink dedup sits in the same run directory? (O-06)
4. `write_artifact` proves the per-agent-path pattern eliminates collisions. Why is `signals.jsonl` a
   single shared file rather than per-emitter shards merged on read? (O-02)
5. Do errored MCP calls have any retry or dead-letter path, or is `is_error: true` always terminal for
   the data? (O-07)
6. Which agent authored the 00:13:36 mission-state backfill, and was any other state edited by hand in
   the same window? (O-09)
