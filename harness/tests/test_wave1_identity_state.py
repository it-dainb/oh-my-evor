"""
harness/tests/test_wave1_identity_state.py

Wave 1, category 3 — identity & state coupling, harness/Python layer.
RED phase: every assertion below states the invariant that *should* hold, not
the behaviour the field trace observed.

Findings covered (see docs/field-trace-v1.2.0/):

  Q-01 (lane Q, BLOCKER) — the default `.evor/` resolution branch is untested.
      `test_compaction_survival.py` has 16 hook invocations and all 16 set
      EVOR_ROOT explicitly, so the branch every real session takes
      (`join(CLAUDE_PLUGIN_ROOT ?? cwd, '.evor')`) has never been exercised.
      TestSubagentStopWithoutEvorRoot is that missing coverage, driven from the
      same subprocess idiom as the existing file.

  O-02 (lane O, BLOCKER) — no file locking anywhere in the harness.
      `SignalBus.emit()` and `ContentAddressedStore._save_refcounts()` are
      whole-file read-modify-rewrites. They survived the 19-hour run on a
      2.55 s inter-emit margin, i.e. on the shape of the workload, not on the
      storage layer.

  O-17 (lane O) — `_load_refcounts()` unconditionally unlinks
      `.refcounts.json.tmp`, destroying a concurrent writer's in-flight file.

  O-18 (lane O) — `drain_inbox` claims crash-safety but loses the entire batch
      when a drain is interrupted mid-way.
"""

from __future__ import annotations

import json
import multiprocessing as mp
import os
import subprocess
import threading
from pathlib import Path

import pytest

from evor.signals import SignalBus, drain_inbox, make_signal
from evor.store import ContentAddressedStore

# ── Hook helpers (same shape as test_compaction_survival.py) ──────────────────

HOOKS_DIR = Path(__file__).parent.parent.parent / "hooks"
SUBAGENT_STOP = str(HOOKS_DIR / "subagent-stop.mjs")

NODE_BIN = "node"

PLUGIN_MISSION_ID = "frontier-1ms"
PLUGIN_RUN_ID = "run-live-01"
PROJECT_MISSION_ID = "binarization-worldmodel"
PROJECT_RUN_ID = "run-project-live-01"


def run_hook(
    script: str,
    env: dict[str, str],
    cwd: str,
    stdin: str = "",
    timeout: int = 10,
) -> subprocess.CompletedProcess:
    """Spawn a hook with a minimal, controlled environment and an explicit cwd."""
    clean_env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin")}
    clean_env.update(env)
    return subprocess.run(
        [NODE_BIN, script],
        input=stdin,
        capture_output=True,
        text=True,
        timeout=timeout,
        env=clean_env,
        cwd=cwd,
    )


def _build_field_layout(root: Path) -> dict[str, Path]:
    """Materialise the exact field configuration on disk.

    A plugin dir with its own leftover `.evor/` (artifact PRESENT → silence) and
    a project dir with the live `.evor/` (artifact ABSENT → warning). The
    asymmetry is the non-vacuity guard: a hook that resolves to the plugin says
    nothing, which is exactly what happened across 97 agents in the field.
    """
    plugin_root = root / "plugin"
    project_root = root / "project"

    plugin_evor = plugin_root / ".evor"
    plugin_run = plugin_evor / "runs" / PLUGIN_MISSION_ID / PLUGIN_RUN_ID
    (plugin_run / "ticks" / "1" / "sage").mkdir(parents=True)
    (plugin_evor / "active-run.json").write_text(
        json.dumps({"run_id": PLUGIN_RUN_ID, "mission_id": PLUGIN_MISSION_ID, "status": "paused"})
    )
    (plugin_run / "tick-state.json").write_text(json.dumps({"tick": 1, "current_step": 2}))
    (plugin_run / "mission-state.json").write_text(
        json.dumps({"objective": "Beat the CIFAR-10 frontier", "status": "paused"})
    )
    (plugin_run / "ticks" / "1" / "sage" / "findings.json").write_text(
        json.dumps({"findings": ["leftover self-test artifact, unrelated to this project"]})
    )

    project_evor = project_root / ".evor"
    project_run = project_evor / "runs" / PROJECT_MISSION_ID / PROJECT_RUN_ID
    (project_run / "ticks" / "1").mkdir(parents=True)
    (project_evor / "active-run.json").write_text(
        json.dumps({"run_id": PROJECT_RUN_ID, "mission_id": PROJECT_MISSION_ID, "status": "running"})
    )
    (project_run / "tick-state.json").write_text(json.dumps({"tick": 1, "current_step": 4}))
    (project_run / "mission-state.json").write_text(
        json.dumps({"objective": "Binarize document images", "status": "running"})
    )

    return {
        "plugin_root": plugin_root,
        "project_root": project_root,
        "plugin_run": plugin_run,
        "project_run": project_run,
    }


# ── Q-01 — the untested default resolution branch ─────────────────────────────


class TestSubagentStopWithoutEvorRoot:
    """subagent-stop must find the PROJECT's run when EVOR_ROOT is unset."""

    def test_warns_on_missing_artifact_with_evor_root_unset(self, tmp_path: Path) -> None:
        layout = _build_field_layout(tmp_path)

        result = run_hook(
            SUBAGENT_STOP,
            {"CLAUDE_PLUGIN_ROOT": str(layout["plugin_root"])},
            cwd=str(layout["project_root"]),
            stdin=json.dumps(
                {
                    "agent_type": "oh-my-evor:evor-sage",
                    "agent_id": "agent-q01-py-01",
                    "last_assistant_message": "done",
                }
            ),
        )

        assert result.returncode == 0
        assert "[EVOR SUBAGENT WARNING]" in result.stdout, (
            "advisory must fire for the project's missing sage artifact; "
            f"stdout={result.stdout!r}"
        )

    def test_silent_when_project_artifact_present_with_evor_root_unset(
        self, tmp_path: Path
    ) -> None:
        layout = _build_field_layout(tmp_path)

        # Mirror image: artifact on the project side, none on the plugin side.
        sage_dir = layout["project_run"] / "ticks" / "1" / "sage"
        sage_dir.mkdir(parents=True)
        (sage_dir / "findings.json").write_text(
            json.dumps({"findings": ["real project findings, well over the 10-byte floor"]})
        )
        (layout["plugin_run"] / "ticks" / "1" / "sage" / "findings.json").unlink()

        result = run_hook(
            SUBAGENT_STOP,
            {"CLAUDE_PLUGIN_ROOT": str(layout["plugin_root"])},
            cwd=str(layout["project_root"]),
            stdin=json.dumps(
                {
                    "agent_type": "oh-my-evor:evor-sage",
                    "agent_id": "agent-q01-py-02",
                    "last_assistant_message": "done",
                }
            ),
        )

        assert result.returncode == 0
        assert "[EVOR SUBAGENT WARNING]" not in result.stdout, (
            "the project's artifact is present; the advisory must not fire; "
            f"stdout={result.stdout!r}"
        )


# ── O-02 — concurrent writers to a shared, unlocked file ──────────────────────
#
# Module-level workers so multiprocessing can start them under any start method.

SIGNALS_PER_WRITER = 25
SIGNAL_WRITERS = 8
CONCURRENCY_ROUNDS = 3


def _emit_worker(run_dir: str, writer_id: int, count: int, barrier) -> None:
    """Emit `count` distinct signals, starting in lockstep with the other writers."""
    bus = SignalBus(Path(run_dir))
    barrier.wait(timeout=30)
    for i in range(count):
        bus.emit(
            make_signal(
                kind="concurrency-probe",
                signature=f"w{writer_id}-s{i}",
                shapes=["limit"],
                axes=["compute"],
                severity="medium",
                evidence={"writer": writer_id, "seq": i},
                source=f"writer-{writer_id}",
            )
        )


def _put_worker(root: str, writer_id: int, count: int, barrier, errors) -> None:
    """Put `count` distinct blobs into a shared store, in lockstep.

    Failures are reported through `errors` rather than by dying, so the test
    fails on its own invariant assertion with a readable cause instead of on a
    bare non-zero exit code.
    """
    store = ContentAddressedStore(Path(root))
    barrier.wait(timeout=30)
    for i in range(count):
        src = Path(root) / f"src-{writer_id}-{i}.bin"
        src.write_bytes(f"payload-{writer_id}-{i}".encode())
        try:
            store.put(src)
        except Exception as exc:  # noqa: BLE001 — surfaced in the assertion message
            errors.put(f"writer {writer_id} put {i}: {type(exc).__name__}: {exc}")


class TestConcurrentSharedStateWrites:
    """Every write from every concurrent writer must survive."""

    @pytest.mark.parametrize("round_no", range(CONCURRENCY_ROUNDS))
    def test_signal_bus_loses_no_emits_under_concurrency(
        self, tmp_path: Path, round_no: int
    ) -> None:
        run_dir = tmp_path / f"round-{round_no}"
        run_dir.mkdir()

        barrier = mp.Barrier(SIGNAL_WRITERS)
        procs = [
            mp.Process(
                target=_emit_worker,
                args=(str(run_dir), w, SIGNALS_PER_WRITER, barrier),
            )
            for w in range(SIGNAL_WRITERS)
        ]
        for p in procs:
            p.start()
        for p in procs:
            p.join(timeout=120)

        expected = {
            f"w{w}-s{i}"
            for w in range(SIGNAL_WRITERS)
            for i in range(SIGNALS_PER_WRITER)
        }
        persisted = {s.signature for s in SignalBus(run_dir).query()}

        assert persisted == expected, (
            f"{len(expected - persisted)} of {len(expected)} signals were lost: "
            f"{sorted(expected - persisted)[:10]}; "
            f"writer exit codes {[p.exitcode for p in procs]}"
        )

    @pytest.mark.parametrize("round_no", range(CONCURRENCY_ROUNDS))
    def test_refcounts_lose_no_puts_under_concurrency(
        self, tmp_path: Path, round_no: int
    ) -> None:
        root = tmp_path / f"store-round-{round_no}"
        root.mkdir()

        writers, per_writer = 8, 15
        expected = writers * per_writer
        barrier = mp.Barrier(writers)
        errors: mp.Queue = mp.Queue()
        procs = [
            mp.Process(target=_put_worker, args=(str(root), w, per_writer, barrier, errors))
            for w in range(writers)
        ]
        for p in procs:
            p.start()
        for p in procs:
            p.join(timeout=120)

        reported: list[str] = []
        while not errors.empty():
            reported.append(errors.get())

        refcounts = root / "artifacts" / ".refcounts.json"
        counts = json.loads(refcounts.read_text()) if refcounts.exists() else {}
        total = sum(counts.values())

        assert total == expected, (
            f"refcount total {total} != {expected} concurrent puts "
            f"({expected - total} lost to the read-modify-write window); "
            f"writer errors: {reported[:3]}"
        )


# ── O-17 — the "crash cleanup" that eats a live writer's tmp ──────────────────


class TestRefcountTmpIsNotStolen:
    """A reader must not destroy another process's in-flight `.refcounts.json.tmp`."""

    def test_load_refcounts_leaves_an_inflight_tmp_alone(self, tmp_path: Path) -> None:
        store = ContentAddressedStore(tmp_path)
        reader = ContentAddressedStore(tmp_path)

        tmp_written = threading.Event()
        reader_done = threading.Event()
        errors: list[BaseException] = []

        def writer() -> None:
            # Replicates _save_refcounts, paused between the tmp write and the
            # os.replace — the window a second process's read lands in.
            try:
                store._tmp_path.write_bytes(json.dumps({"cafebabe": 3}).encode())
                tmp_written.set()
                assert reader_done.wait(timeout=10)
                os.replace(store._tmp_path, store._refcounts_path)
            except BaseException as exc:  # noqa: BLE001 — recorded, re-raised by assert
                errors.append(exc)

        thread = threading.Thread(target=writer)
        thread.start()
        assert tmp_written.wait(timeout=10)

        reader._load_refcounts()
        assert store._tmp_path.exists(), (
            "a concurrent writer's in-flight .refcounts.json.tmp was deleted by a read"
        )

        reader_done.set()
        thread.join(timeout=10)

        assert not errors, f"writer failed after its tmp was removed: {errors[0]!r}"
        assert json.loads(store._refcounts_path.read_text()) == {"cafebabe": 3}


# ── O-18 — drain_inbox is at-most-once, not crash-safe ────────────────────────


class _CrashingBus:
    """Delegating bus that raises a non-`Exception` on the Nth emit.

    A `BaseException` is required: `drain_inbox`'s per-line `except Exception`
    swallows anything narrower, so only this reaches the real crash path.
    """

    def __init__(self, real: SignalBus, crash_on: int) -> None:
        self._real = real
        self._crash_on = crash_on
        self.emitted: list[str] = []

    def emit(self, signal):  # noqa: ANN001 — mirrors SignalBus.emit
        if len(self.emitted) + 1 == self._crash_on:
            raise KeyboardInterrupt("simulated crash mid-drain")
        self.emitted.append(signal.signature)
        return self._real.emit(signal)


class TestDrainInboxCrashSafety:
    """An interrupted drain must not lose the signals it had not yet emitted."""

    def test_uncommitted_signals_survive_a_mid_drain_crash(self, tmp_path: Path) -> None:
        run_dir = tmp_path
        entries = [
            {
                "kind": "cuda-oom",
                "signature": f"inbox-sig-{n}",
                "shapes": ["failure"],
                "axes": ["memory"],
                "severity": "high",
                "evidence": {"n": n},
                "source": "post-tool-use.mjs",
            }
            for n in range(1, 4)
        ]
        (run_dir / "signals-inbox.jsonl").write_text(
            "\n".join(json.dumps(e) for e in entries) + "\n"
        )

        crashing = _CrashingBus(SignalBus(run_dir), crash_on=2)
        with pytest.raises(KeyboardInterrupt):
            drain_inbox(run_dir, crashing)

        assert crashing.emitted == ["inbox-sig-1"]

        # Recovery: a subsequent drain must deliver everything the crash left.
        recovered = drain_inbox(run_dir, SignalBus(run_dir))

        persisted = {s.signature for s in SignalBus(run_dir).query()}
        assert persisted == {"inbox-sig-1", "inbox-sig-2", "inbox-sig-3"}, (
            f"the crash lost the rest of the batch; recovery drain emitted "
            f"{recovered}, bus holds {sorted(persisted)}"
        )


# ── O-02, forced interleaving — the lost update, without a race ───────────────
#
# The live probe `ci/identity-live-eval.mjs --probe signal-concurrency` observed
# this against real agents: with the MCP writers holding `<runDir>/.tree.lock`
# (mcp/src/lock.ts) and the harness's own Python writer ignoring it, 220 of 1234
# signals vanished across 3.2 s of overlap — including 5 of the 9 emits the real
# agents had already committed through the locked path. The test below is the
# same defect with the interleaving forced instead of raced, so a GREEN phase has
# something deterministic to work against.


class TestSignalBusLostUpdate:
    """An emit must not drop a record another writer committed after our read."""

    def test_emit_preserves_a_write_that_lands_inside_its_window(
        self, tmp_path: Path
    ) -> None:
        from unittest.mock import patch

        import evor.signals as signals_mod

        bus = SignalBus(tmp_path)
        bus.emit(
            make_signal("concurrency-probe", "sig-A", ["limit"], ["compute"],
                        "medium", {}, "writer-a")
        )

        original = signals_mod._atomic_write_jsonl
        state = {"injected": False}

        def racing_write(path: Path, lines: list[str]) -> None:
            # Stand-in for the other writer of this file — the MCP server, which
            # commits under .tree.lock while Python holds no lock at all. It lands
            # AFTER our emit read the file and BEFORE our emit writes it back.
            if not state["injected"]:
                state["injected"] = True
                with open(path, "a") as fh:
                    fh.write(
                        make_signal("concurrency-probe", "sig-B", ["limit"], ["compute"],
                                    "medium", {}, "writer-b").model_dump_json() + "\n"
                    )
            original(path, lines)

        with patch.object(signals_mod, "_atomic_write_jsonl", racing_write):
            bus.emit(
                make_signal("concurrency-probe", "sig-C", ["limit"], ["compute"],
                            "medium", {}, "writer-c")
            )

        assert state["injected"], "the concurrent write was never injected — test is inert"

        persisted = {s.signature for s in SignalBus(tmp_path).query()}
        assert persisted == {"sig-A", "sig-B", "sig-C"}, (
            "sig-B was committed by another writer inside the emit's "
            "read-modify-write window and was silently overwritten; bus holds "
            f"{sorted(persisted)}"
        )
