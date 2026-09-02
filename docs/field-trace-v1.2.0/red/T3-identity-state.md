# RED — T3: identity & state coupling

Wave-2 RED phase for category 3 of `docs/field-trace-v1.2.0/README.md`
(`Q-01`, `O-02`, `O-17`, `O-18`). Failing tests only; **no source file was
modified.** Every assertion states the invariant that should hold, never the
behaviour the field trace observed.

Files added:

| layer | file | tests |
|---|---|---|
| JS / hooks | `mcp/tests/wave1-identity-state.test.ts` | 6 (5 RED, 1 no-regression guard that passes) |
| Python / harness | `harness/tests/test_wave1_identity_state.py` | 11 (all RED) |

Re-run:

```
cd mcp     && npx vitest run tests/wave1-identity-state.test.ts
cd harness && python -m pytest tests/test_wave1_identity_state.py -p no:randomly
```

---

## Q-01 — every hook resolved `.evor/` to the plugin cache

### Verification of the brief's claim about the existing test

**The claim is accurate.** `harness/tests/test_compaction_survival.py` contains
exactly 16 `run_hook(...)` call sites (a 17th `grep` hit is the `def run_hook`
line), and **all 16 pass `EVOR_ROOT` explicitly** — lines 76, 115, 137, 182, 217,
232, 239, 259, 281, 289, 295, 320, 368, 418, 463, 482. The
`join(CLAUDE_PLUGIN_ROOT ?? cwd, '.evor')` branch that every real session takes
has no coverage in that file. `TestSubagentStopWithoutEvorRoot` below is that
missing coverage, written in the same subprocess idiom.

Note the resolver is not the only site: `hooks/subagent-stop.mjs` re-derives the
root itself with the identical expression
(`process.env.EVOR_ROOT ?? join(pluginRoot, '.evor')`), so a fix confined to
`hooks/lib/active-run.mjs` will leave the hook tests below red.

### The fixture

Both suites build the exact field configuration:

```
<tmp>/plugin/.evor/runs/frontier-1ms/run-live-01/          ← leftover self-test
        └── ticks/1/sage/findings.json                      ARTIFACT PRESENT
<tmp>/project/.evor/runs/binarization-worldmodel/run-project-live-01/
        └── ticks/1/sage/                                   ARTIFACT ABSENT
```

`EVOR_ROOT` unset, `CLAUDE_PLUGIN_ROOT=<tmp>/plugin`, cwd `<tmp>/project`. The
asymmetry is the non-vacuity guard: a hook that resolves to the plugin finds a
healthy artifact and stays silent — exactly what happened across 97 agents —
while correct resolution must warn. A second test inverts the fixture so the
suite pins the *direction* of resolution, not merely "warns sometimes".

### Results — `mcp/tests/wave1-identity-state.test.ts`

| test | invariant | status |
|---|---|---|
| `resolves to the project's .evor when EVOR_ROOT is unset and CLAUDE_PLUGIN_ROOT has its own .evor` | `resolveEvorRoot()` returns `<project>/.evor` | **RED** |
| `never returns a path inside CLAUDE_PLUGIN_ROOT` | neither `resolveEvorRoot()` nor `resolveRunDir()` is under the plugin root | **RED** |
| `resolves the active run from the project's active-run.json, not the plugin's` | `runId`/`missionId`/`runDir` come from the project | **RED** |
| `still honours an explicit EVOR_ROOT override (no regression)` | explicit override still wins | **ALREADY-GREEN** (guard, intentional) |
| `fires [EVOR SUBAGENT WARNING] when a subagent ends without its owed artifact and EVOR_ROOT is unset` | advisory fires against the project run dir | **RED** |
| `stays silent when the PROJECT's artifact is present, even though the plugin's is not` | advisory does not fire when the project artifact exists | **RED** |

All failures are deterministic.

```
 ❯ tests/wave1-identity-state.test.ts  (6 tests | 5 failed) 773ms

AssertionError: expected '/tmp/evor-q01-8xrG5E/plugin/.evor' to be '/tmp/evor-q01-8xrG5E/project/.evor'
 ❯ tests/wave1-identity-state.test.ts:148:26
    148|     expect(got.evorRoot).toBe(layout.projectEvor);

AssertionError: expected true to be false
 ❯ tests/wave1-identity-state.test.ts:157:56
    157|     expect(got.evorRoot.startsWith(layout.pluginRoot)).toBe(false);

AssertionError: expected 'run-live-01' to be 'run-project-live-01'
 ❯ tests/wave1-identity-state.test.ts:167:23
    167|     expect(got.runId).toBe(PROJECT_RUN_ID);

AssertionError: expected '' to contain '[EVOR SUBAGENT WARNING]'
 ❯ tests/wave1-identity-state.test.ts:208:24
    208|     expect(res.stdout).toContain("[EVOR SUBAGENT WARNING]");

AssertionError: expected '[EVOR SUBAGENT WARNING] sage stopped …' not to contain '[EVOR SUBAGENT WARNING]'
 ❯ tests/wave1-identity-state.test.ts:233:28
    233|     expect(res.stdout).not.toContain("[EVOR SUBAGENT WARNING]");

 Test Files  1 failed (1)
      Tests  5 failed | 1 passed (6)
```

### Results — the missing default-branch coverage in Python

```
E  AssertionError: advisory must fire for the project's missing sage artifact; stdout=''
E  assert '[EVOR SUBAGENT WARNING]' in ''

E  AssertionError: the project's artifact is present; the advisory must not fire;
   stdout='[EVOR SUBAGENT WARNING] sage stopped but artifact not confirmed for this tick.\n
           Agent may not have externalized its work. Orchestrator should verify via evor_read_artifact.\n'
```

Status **RED**, deterministic.

---

## O-02 — zero file locking

### Relationship to `mcp/tests/signals-race.test.ts` (read first, not duplicated)

That suite covers the **TypeScript** `emitSignal` in `mcp/src/tools/signals.ts`.
It is single-process: it mocks `fs.renameSync` to no-op on `signals.jsonl` and
asserts `emitSignal` retries and then throws instead of silently returning. It
proves a *verify-after-write* contract for one function in one language. It does
not spawn concurrent writers, and it never touches the Python harness.

The uncovered paths this suite targets are therefore disjoint: the **Python**
`SignalBus.emit` read-modify-rewrite, and `ContentAddressedStore`'s
`_load_refcounts`/`_save_refcounts` pair. (`tree.json`
`_persist_visit_increments` remains uncovered and is a candidate for a follow-up;
it shares the identical read→mutate→`os.replace` shape, so a fix that repairs the
two paths tested here will not automatically repair it.)

### Tests

| test | invariant | status |
|---|---|---|
| `test_signal_bus_loses_no_emits_under_concurrency[0..2]` | 8 processes × 25 distinct signatures → all 200 present in `signals.jsonl` | **RED** |
| `test_refcounts_lose_no_puts_under_concurrency[0..2]` | 8 processes × 15 distinct blobs → refcount total is 120 | **RED** |

Both start their writers on an `mp.Barrier` so the read-modify-write windows
actually overlap, and both are parametrised over 3 rounds.

**Failure character: probabilistic in principle, but not in practice.** The loss
is not a narrow window — `emit()` re-reads and rewrites the whole file per call,
so with 8 writers roughly 7 of every 8 concurrent emits are clobbered. Measured
over 8 consecutive full-file runs (24 rounds per test), every round failed, and
the signal loss was 168–174 of 200 each time. No round has ever come close to
passing. Writer exit codes are `[0]*8` for the signals test, so the failure is
the invariant, not a crashed child.

```
E  AssertionError: 174 of 200 signals were lost: ['w0-s0', 'w0-s1', 'w0-s10', ...];
   writer exit codes [0, 0, 0, 0, 0, 0, 0, 0]

E  AssertionError: 171 of 200 signals were lost: [...]; writer exit codes [0, 0, 0, 0, 0, 0, 0, 0]
E  AssertionError: 172 of 200 signals were lost: [...]; writer exit codes [0, 0, 0, 0, 0, 0, 0, 0]

E  AssertionError: refcount total 19 != 120 concurrent puts (101 lost to the read-modify-write
   window); writer errors: ["writer 0 put 0: FileNotFoundError: [Errno 2] No such file or
   directory: '…/artifacts/.refcounts.json.tmp' -> '…/artifacts/.refcounts.json'", …]
E  assert 19 == 120
```

The refcount test's `writer errors` list shows the two failure modes compounding:
`FileNotFoundError` on `os.replace` (that is O-17 firing under real concurrency)
and `JSONDecodeError` from reading a `.refcounts.json` mid-replace. Child
exceptions are collected on an `mp.Queue` and reported *inside* the invariant
assertion, so the test fails on `total == expected`, never on a bare exit code.

---

## O-17 — `_load_refcounts()` deletes a concurrent writer's in-flight tmp

| test | invariant | status |
|---|---|---|
| `test_load_refcounts_leaves_an_inflight_tmp_alone` | a reader must not unlink a `.refcounts.json.tmp` another writer is mid-write on, and that writer's `os.replace` must still succeed | **RED** |

**Deterministic** — the interleaving is forced with two `threading.Event`s, not
raced: the writer writes its tmp, signals `tmp_written`, and blocks; the test
then calls `_load_refcounts()` and only afterwards releases the writer. There is
no timing window to lose.

```
E  AssertionError: a concurrent writer's in-flight .refcounts.json.tmp was deleted by a read
E  assert False
E   +  where False = exists()
E   +    where exists = PosixPath('…/artifacts/.refcounts.json.tmp').exists
```

The test carries two further assertions past that point (the writer's
`os.replace` raises no `FileNotFoundError`, and the refcount file ends up holding
the writer's payload) which will start being exercised once the first one is
fixed.

---

## O-18 — `drain_inbox` loses the whole batch on a mid-drain crash

| test | invariant | status |
|---|---|---|
| `test_uncommitted_signals_survive_a_mid_drain_crash` | after an interrupted drain, a subsequent `drain_inbox` must still deliver every signal the crash did not commit | **RED** |

The crash is injected with a `KeyboardInterrupt` from a delegating bus stub on
the 2nd of 3 inbox entries. A `BaseException` is required: `drain_inbox`'s
per-line `except Exception: continue` swallows anything narrower, so a plain
exception would be absorbed as a "malformed line" and never reach the crash path.

The invariant is deliberately stated as **re-drainability**, not "a `.drain-tmp`
orphan is left behind". The docstring's own crash story — that a crash leaves a
`*.drain-tmp` rather than the live inbox — would not actually save the data:
`drain_inbox` only ever reads `signals-inbox.jsonl`, so an orphaned tmp is never
picked up again. Asserting on the tmp file would pin the wrong contract.

**Deterministic.**

```
E  AssertionError: the crash lost the rest of the batch; recovery drain emitted 0,
   bus holds ['inbox-sig-1']
E  assert {'inbox-sig-1'} == {'inbox-sig-1', 'inbox-sig-2', 'inbox-sig-3'}
E    Extra items in the right set:
E    'inbox-sig-2'
E    'inbox-sig-3'
```

---

## Collateral check

Full suites were run to confirm nothing else moved:

- `harness`: `56 failed, 934 passed, 3 skipped` (before the 11th test in this file was added) — the failures from this file
  plus other lanes' RED files (`test_wave1_environment_secrets.py`,
  `test_wave1_knowledge_lifecycle.py`, `test_wave1_seal_provenance.py`). No
  previously-passing test changed state.
- `mcp`: `144 failed | 1338 passed | 6 skipped` across 8 failing files — the 5
  failures from `wave1-identity-state.test.ts` plus other lanes' RED files. The
  live wrapper was added afterwards and contributes 4 more, gate-on only.

No `.skip`, `.only`, `xfail`, or swallowed failure appears in either new file.

## Not testable in this phase

Nothing in the assigned finding set was untestable. One adjacent path is
**deferred, not blocked**: `tree.json`'s `_persist_visit_increments`
(`harness/evor/tree.py:269`) has the same unguarded read-modify-write shape but
requires a full `TreeNode` fixture to drive concurrently; the two O-02 tests
above already fail on the same root cause, so it adds no RED signal now — but it
does need its own test before O-02 can be called closed, because a fix scoped to
`signals.py` and `store.py` will leave it unlocked.

---

# LIVE ADDENDUM — real model, real hooks, real MCP server

The unit suite above proves the resolver returns the wrong string when called
directly. That is the same *shape* of evidence `test_compaction_survival.py`
already had, and it is why Q-01 survived: a test that builds its own environment
can only check the branch it chose to build. The probes below launch a REAL
headless session the way the plugin loader does — hooks registered,
`CLAUDE_PLUGIN_ROOT` exported, `EVOR_ROOT` **deleted from the child environment**
— and then read the filesystem.

Files added:

| file | what it is |
|---|---|
| `ci/identity-live-eval.mjs` | the two probes plus their pure analysis helpers |
| `mcp/tests/wave1-identity-live-eval.test.ts` | vitest wrapper; 4 gate-off analysis tests + 11 live |

Re-run:

```
npm --prefix mcp run build
EVOR_LIVE_EVAL=1 npx --prefix mcp vitest run tests/wave1-identity-live-eval.test.ts   # from mcp/
EVOR_LIVE_EVAL=1 node ci/identity-live-eval.mjs --probe all                            # harness directly
```

**Gating.** Everything live sits behind `EVOR_LIVE_EVAL=1` via
`describe.runIf`. Gate off, the live blocks do not execute (`4 passed | 11
skipped`, 2.0 s, no network). Gate on, they must fail loudly: `runSession`
throws on a CLI error, a missing JSON envelope, or a session in which **no evor
hook fired**. An unreachable model is an error, never a pass. This gate is not a
`.skip` of a deterministic failure — there is no deterministic answer to skip.

**Model / n / cost.** `claude-sonnet-5` throughout (`--model sonnet`), the tier
the field run's orchestrator used. Q-01 probe: n=4 sessions, ~$0.10 each. O-02:
n=3 full arm-pairs, 3 agents × 3 emits per arm, ~$0.49 per arm. Total spend for
everything reported here: **≈ $3.05**.

## Q-01 LIVE — `hook-root-resolution`

Sandbox, built fresh per run:

```
<tmp>/plugin/    the repo's real hooks/ + plugin.json, and a leftover
                 .evor/runs/frontier-1ms/run-live-01/  (mission RUNNING,
                 sage artifact PRESENT)   ← CLAUDE_PLUGIN_ROOT
<tmp>/project/   .evor/runs/binarization-…/run-project-live-01/
                 (mission RUNNING, sage artifact ABSENT)   ← cwd
```

Hooks are registered through `--settings`, not `--plugin-dir`: a `--plugin-dir`
plugin's `hooks/hooks.json` does not register in CLI 2.1.236 (measured by
`ci/autonomy-live.mjs`), while a settings hook block does. `EVOR_ROOT`,
`EVOR_ACTIVE_RUN_ID` and `EVOR_MISSION_ID` are stripped from the child env so an
inherited value cannot silently repair the defect.

| test | invariant | status |
|---|---|---|
| `the rig actually measured the hooks` | ≥1 evor hook fired; `session-start` among them | GREEN (control) |
| `ran on a real model` | model id present in the envelope | GREEN (control) |
| `the hooks announced a run dir at all` | ≥1 run dir observed | GREEN (control) |
| `Q-01a — the resolved run dir is the PROJECT's` | 0 run dirs under `CLAUDE_PLUGIN_ROOT` | **RED** |
| `Q-01b — the restore block names the project's mission` | `<evor-restore>` names the live mission, not the decoy | **RED** |
| `Q-01c — no hook writes into another project's .evor/` | decoy `.evor/` byte-identical after the session | **RED** |

**Deterministic**: 4 of 4 sessions reproduced all three, identically. None of the
three assertions depends on what the model said — Q-01a reads the run dir the
hook itself announced, and Q-01c is a sha256 inventory diff.

```
[live] q01 model=claude-sonnet-5 turns=1 cost=$0.1070 wall=8.1s
       hooks=session-start+stop (2 invocations)

AssertionError: hooks resolved 1 run dir(s) inside CLAUDE_PLUGIN_ROOT:
  ["/tmp/evor-identity-live-U8cdJM/plugin/.evor/runs/frontier-1ms/run-live-01"]:
  expected 1 to be +0

AssertionError: <evor-restore> named the decoy mission
  ("Beat the CIFAR-10 accuracy/latency frontier") — this is the payload the
  orchestrator was handed for 19 hours: expected true to be false

AssertionError: the session mutated files inside CLAUDE_PLUGIN_ROOT/.evor:
- Array []
+ Array [
+   "/plugin/.evor/runs/frontier-1ms/run-live-01/mission-state.json",
+   "/plugin/.evor/runs/frontier-1ms/run-live-01/stop-blocks-nosession.json",
+ ]
```

Q-01c is the finding the unit suite structurally cannot express: an eight-second
session in an unrelated project **rewrote another project's `mission-state.json`
and created a new file inside it**. That is the mechanism behind this repo's own
still-uncommitted `M .evor/runs/frontier-1ms/run-live-01/mission-state.json`.
The session-start hook resolving wrong is the read half; this is the write half.

The full `<evor-restore>` the live session received:

```
<evor-restore>
Mission: Beat the CIFAR-10 accuracy/latency frontier
Tick 1 step 2 | Best: 0.61
Spawn evor-tick to resume the loop; prioritise the user's newest request.
</evor-restore>
```

The project it was running in is a document-binarization mission. Nothing in the
payload is about it.

## O-02 LIVE — `signal-concurrency`, two arms

Two arms, reported separately and never blended.

| arm | writers | invariant | status |
|---|---|---|---|
| `mcp-only` | 3 real agents × 3 `evor_signal_emit` | no signal lost | **ALREADY-GREEN** |
| `mixed` | the same agents + 2 Python `SignalBus.emit` loops | no signal lost | **RED** |

**This corrects the lane-O headline.** Lane O reports "no file locking anywhere"
on the strength of `grep -rn "flock|fcntl|filelock|LOCK_EX" harness/evor/*.py`.
That grep is over Python only. The TypeScript side **does** lock:
`mcp/src/lock.ts` `withRunLock()` takes an `O_EXCL` lock at
`<runDir>/.tree.lock`, and `mcp/src/tools/signals.ts:179` and `tree-store.ts:80`
both hold it. The `mcp-only` arm confirms it holds under real agents: 9 of 9
emits survived, three times running.

The real defect is sharper than "no locks": **the lock exists and the other
writer of the same file does not take it.** `hooks/subagent-stop.mjs` shells out
to `python3 -m evor.signals drain`, which reaches `SignalBus.emit` — a whole-file
read-modify-rewrite that never looks at `.tree.lock`. The two writers of
`signals.jsonl` therefore do not serialise against each other, and the locked
writer is the one that loses.

```
[live] signals arm=mcp-only model=claude-sonnet-5 cost=$0.4871
       expected=9 missing=0 overlap_ms=n/a verdict=no-loss
[live] signals arm=mixed    model=claude-sonnet-5 cost=$0.4871
       expected=1219 missing=266 overlap_ms=6108 verdict=loss

AssertionError: 266 of 1219 signals lost across 6108ms of overlap:
  ["a0-s1","a1-s1","a1-s2","a2-s1","py0-s125","py0-s126",…]: expected 266 to be +0
```

Note the first four entries: `a0-s1`, `a1-s1`, `a1-s2`, `a2-s1` are **agent**
emits — signals the MCP server had already committed while holding `.tree.lock`,
destroyed by a Python writer that did not.

**Failure character: probabilistic, and measured as such.** Three arm-pairs were
run:

| run | overlap | expected | lost | rate |
|---|---|---|---|---|
| 1 | 3,210 ms | 1,234 | 220 | 17.8% |
| 2 | 5,429 ms | 1,221 | 242 | 19.8% |
| 3 | 6,108 ms | 1,219 | 266 | 21.8% |

3 of 3 reproduced, and in every run some of the agents' own emits were among the
casualties (5, 3 and 4 of 9 respectively). The arm carries its own validity gate:
`overlapWindow()` measures the intersection of the Python and agent write
windows, and an arm with no overlap reports `inconclusive-no-overlap` and fails
as inconclusive rather than passing.

That gate was not decoration. **The first version of this arm passed vacuously**:
the Python writers used a fixed count with a 50 ms sleep, finished in ~250 ms,
and the agents' first `evor_signal_emit` landed about ten seconds later. The
windows never met and the arm reported `missing_count: 0`. That is exactly the
reading lane O warns against — "the clean bill of health is exactly what a lost
update would also look like" — and it was produced by the rig, not the system.
The Python writers now emit continuously until every agent has finished, and
journal each attempted signature before emitting it, so the expected set is what
Python actually attempted rather than what the harness planned.

**Deterministic complement.** Because the live arm is probabilistic, the primary
evidence is a forced interleaving in the Python suite:
`TestSignalBusLostUpdate::test_emit_preserves_a_write_that_lands_inside_its_window`
patches `_atomic_write_jsonl` to commit another writer's record between the
emit's read and its write. No race, no timing:

```
E  AssertionError: sig-B was committed by another writer inside the emit's
   read-modify-write window and was silently overwritten; bus holds ['sig-A', 'sig-C']
E  assert {'sig-A', 'sig-C'} == {'sig-A', 'sig-B', 'sig-C'}
```

## Gate-off evidence

```
$ npx vitest run tests/wave1-identity-live-eval.test.ts
 ✓ tests/wave1-identity-live-eval.test.ts  (15 tests | 11 skipped) 9ms
 Test Files  1 passed (1)
      Tests  4 passed | 11 skipped (15)
   Duration  2.03s
```

The 4 that run with the gate off are the analysis helpers —
`evorHookRecords`, `classifyResolvedRunDirs`, `missingSignatures`/`emitTimes`,
and `overlapWindow`. They are not decoration either: every live assertion is
only as good as the parser under it, and a transcript reader that silently
returned `[]` would turn each live red into a false green.

## Live status summary

| finding | test | status |
|---|---|---|
| Q-01 | `Q-01a — the resolved run dir is the PROJECT's` | RED (4/4, deterministic) |
| Q-01 | `Q-01b — the restore block names the project's mission` | RED (4/4, deterministic) |
| Q-01 | `Q-01c — no hook writes into another project's .evor/` | RED (4/4, deterministic) |
| O-02 | `O-02a — N concurrent MCP writers lose nothing` | ALREADY-GREEN (3/3; `withRunLock` holds) |
| O-02 | `O-02b — an MCP writer and the Python writer lose nothing` | RED (3/3, 17.8–21.8% loss) |
| O-02 | `TestSignalBusLostUpdate` (forced interleaving) | RED, deterministic |
