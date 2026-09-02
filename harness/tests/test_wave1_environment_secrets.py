"""
test_wave1_environment_secrets.py — wave-2 RED tests for field-trace category 8
(ENVIRONMENT & SECRETS), lane R.

Source lane: docs/field-trace-v1.2.0/lanes/lane-r-environment-hygiene.md

Every test in this module asserts the CORRECT invariant, not the behaviour
v1.2.0 actually shipped.  They are expected to FAIL until the corresponding
production change lands.  Nothing here reads, writes or references a real
credential: all secret-shaped values are synthetic (``s2k-TESTONLY-0000…``)
and the real exposed key is referred to only by its first four characters and
its length, exactly as the lane report does.

Findings covered
----------------
R-01  redaction helper must exist and must be applied at every emission point
R-03  this repo must pin its own deps; a run must record interpreter + packages
R-04  capability probe must record FREE VRAM, not just total
R-05  a capability profile must be schema-validated on read, and a hand-authored
      "policy pin" must be distinguishable from a probe measurement
R-07  the dependency sentinel must record what it verified and must be
      invalidated by a changed environment  (TS: mcp/tests/wave1-environment-secrets.test.ts)
R-08  run start must be gated on a fresh capability probe
R-09  the capability report must not advertise a contract-forbidden lib as
      available on the strength of a bare import
R-11  a killed training job must be DETECTED, and a result must carry evidence
      its trainer ran to completion
R-15  candidate imports must anchor to __file__, not to the process cwd
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import signal
import sys
import time
import types
from pathlib import Path

import pytest

from evor.capability import _probe_torch_gpu, probe_capability, read_capability
from evor.contracts import (
    EvaluationResult,
    MutationLocusArch,
    TelemetrySummary,
    TreeNode,
)
from evor.init_run import run_init_run
from evor.integrity import IntegrityGate
from evor.jobs import start_job, status, status_path
from evor.quality_gate import ForgeStructureGate

_REPO_ROOT = Path(__file__).resolve().parents[2]
_HARNESS_DIR = Path(__file__).resolve().parents[1]

# Synthetic stand-in for the leaked Semantic Scholar key.  NEVER put a real
# credential in this file.  The real key is referenced only as "s2k-" + 44 chars.
_SYNTHETIC_S2_KEY = "s2k-TESTONLY-0000000000000000000000000000000"
_REAL_KEY_PREFIX = "s2k-"
_REAL_KEY_LENGTH = 44


# ─────────────────────────────────────────────────────────────────────────────
# Fake-torch scaffolding for the capability prober
# ─────────────────────────────────────────────────────────────────────────────

_GIB = 1024 ** 3
_TOTAL_VRAM_BYTES = 80 * _GIB          # what props.total_memory reports
_FREE_VRAM_BYTES = 40 * _GIB           # what the run could actually use


class _FakeProps:
    major = 8
    minor = 0
    name = "NVIDIA A100 80GB PCIe"
    total_memory = _TOTAL_VRAM_BYTES


class _FakeCuda:
    @staticmethod
    def is_available() -> bool:
        return True

    @staticmethod
    def current_device() -> int:
        return 0

    @staticmethod
    def get_device_properties(_dev: int) -> _FakeProps:
        return _FakeProps()

    @staticmethod
    def mem_get_info() -> tuple[int, int]:
        """torch.cuda.mem_get_info() -> (free_bytes, total_bytes)."""
        return (_FREE_VRAM_BYTES, _TOTAL_VRAM_BYTES)


def _install_fake_torch(monkeypatch: pytest.MonkeyPatch) -> None:
    """Install a shared-tenant A100: 79.25 GB total, ~40 GB actually free."""
    torch = types.ModuleType("torch")
    torch.cuda = _FakeCuda  # type: ignore[attr-defined]
    version_mod = types.ModuleType("torch.version")
    version_mod.cuda = "13.0"  # type: ignore[attr-defined]
    torch.version = version_mod  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "torch", torch)


def _install_fake_accel_libs(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make flash-attn / xformers / triton importable (as they were on the box)."""
    for name in ("flash_attn", "xformers", "triton"):
        monkeypatch.setitem(sys.modules, name, types.ModuleType(name))


# ─────────────────────────────────────────────────────────────────────────────
# R-01 — credential redaction
# ─────────────────────────────────────────────────────────────────────────────

class TestR01CredentialRedaction:
    """R-01 (BLOCKER) — a live API key reached two transcripts and settings.json.

    The leak itself was a human-paste path, but the code-level invariant that
    would have contained it is: evor owns ONE redaction helper, and every
    surface that can emit a configured credential routes through it.  The
    plugin's own status output already truncates to a four-char preview; that
    behaviour must be a shared, tested primitive rather than one lucky call
    site.
    """

    def test_r01_redaction_helper_exists(self) -> None:
        spec = importlib.util.find_spec("evor.secrets")
        assert spec is not None, (
            "evor.secrets does not exist. There is no single redaction primitive "
            "in the harness, so every place that could emit a credential is "
            "redacting (or not redacting) on its own."
        )

    def test_r01_redaction_preserves_only_a_four_char_preview(self) -> None:
        spec = importlib.util.find_spec("evor.secrets")
        assert spec is not None, "evor.secrets does not exist (see previous test)"

        from evor.secrets import redact_secrets  # type: ignore[import]

        emitted = redact_secrets(
            f"S2 API Key: {_SYNTHETIC_S2_KEY} Rate limit: 1 request per second"
        )
        assert _SYNTHETIC_S2_KEY not in emitted, (
            "redact_secrets() passed a key-shaped token through verbatim"
        )
        assert emitted.startswith("S2 API Key: s2k-"), (
            "redaction should keep a four-char preview so operators can still "
            f"identify which key it was; got {emitted!r}"
        )

    def test_r01_no_source_file_reads_a_secret_named_env_var_unredacted(self) -> None:
        """Regression guard: no evor code path pulls a credential out of the
        environment at all today.  Locking that in means a future reader has to
        add redaction deliberately rather than by accident.
        """
        secret_env = re.compile(
            r"""(?:process\.env\.|os\.environ(?:\.get\()?\[?['"]?)"""
            r"""([A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD)[A-Z0-9_]*)""",
        )
        offenders: list[str] = []
        roots = [
            _REPO_ROOT / "hooks",
            _REPO_ROOT / "harness" / "evor",
            _REPO_ROOT / "mcp" / "src",
        ]
        for root in roots:
            for path in root.rglob("*"):
                if path.suffix not in {".py", ".ts", ".mjs", ".cjs"}:
                    continue
                if "__pycache__" in path.parts or "node_modules" in path.parts:
                    continue
                for match in secret_env.finditer(path.read_text(errors="replace")):
                    offenders.append(f"{path.relative_to(_REPO_ROOT)}: {match.group(1)}")

        assert offenders == [], (
            "source reads credential-shaped env vars; each read must be routed "
            f"through evor.secrets.redact_secrets before any emission: {offenders}"
        )


# ─────────────────────────────────────────────────────────────────────────────
# R-04 — free VRAM vs total VRAM
# ─────────────────────────────────────────────────────────────────────────────

class TestR04FreeVram:
    """R-04 (HIGH) — capability.json recorded total_memory (79.25 GB) on a
    shared-tenant A100 where ~40 GB was actually free.  Agents independently
    learned to distrust the artifact; the next agent that does not will oversize
    a candidate.
    """

    def test_r04_probe_records_free_vram_distinctly_from_total(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        _install_fake_torch(monkeypatch)
        profile = probe_capability(tmp_path / ".evor")

        dumped = profile.model_dump(exclude_none=False)
        free_fields = [k for k in dumped if "free" in k.lower()]
        assert free_fields, (
            "CapabilityProfile records no free-memory field at all; "
            f"fields present: {sorted(dumped)}"
        )

        free_gb = dumped[free_fields[0]]
        assert free_gb == pytest.approx(40.0, abs=0.5), (
            f"free VRAM should be ~40 GB (torch.cuda.mem_get_info), got {free_gb}"
        )
        assert profile.vram_gb == pytest.approx(80.0, abs=0.5), (
            "vram_gb should remain the labelled TOTAL figure"
        )

    def test_r04_probe_calls_mem_get_info(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The distinct assertion: the prober must actually ask the driver for
        free memory, not derive it from total."""
        _install_fake_torch(monkeypatch)
        calls: list[str] = []
        monkeypatch.setattr(
            sys.modules["torch"].cuda,  # type: ignore[attr-defined]
            "mem_get_info",
            lambda: (calls.append("mem_get_info"), (_FREE_VRAM_BYTES, _TOTAL_VRAM_BYTES))[1],
        )
        _probe_torch_gpu()
        assert calls == ["mem_get_info"], (
            "_probe_torch_gpu() never queried torch.cuda.mem_get_info(); it "
            "reports props.total_memory only"
        )


# ─────────────────────────────────────────────────────────────────────────────
# R-09 — importable is not the same as permitted
# ─────────────────────────────────────────────────────────────────────────────

class TestR09ImportableVsPermitted:
    """R-09 (MEDIUM) — available_libs advertised flash-attn/xformers/triton on
    the strength of a bare __import__, while the goal contract FORBADE all
    three and the verification artifact recorded "no flash_attn" as a PASS.
    """

    def test_r09_bare_import_does_not_make_a_lib_available(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        _install_fake_torch(monkeypatch)
        _install_fake_accel_libs(monkeypatch)
        profile = probe_capability(tmp_path / ".evor")

        assert profile.available_libs == [], (
            "available_libs must mean 'exercised and usable', not 'importable'. "
            f"Bare imports produced {profile.available_libs}."
        )

    def test_r09_importability_is_reported_separately(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        _install_fake_torch(monkeypatch)
        _install_fake_accel_libs(monkeypatch)
        profile = probe_capability(tmp_path / ".evor")

        dumped = profile.model_dump(exclude_none=False)
        assert "importable_libs" in dumped, (
            "the raw import result is still useful, but it must be labelled as "
            f"importability, not availability; fields present: {sorted(dumped)}"
        )
        assert sorted(dumped["importable_libs"]) == ["flash-attn", "triton", "xformers"]


# ─────────────────────────────────────────────────────────────────────────────
# R-05 — schema validation and policy pins
# ─────────────────────────────────────────────────────────────────────────────

# The hand-authored PLUGIN/.evor/capability.json, verbatim in shape.
_HAND_AUTHORED_PROFILE = {
    "gpu_arch": None,
    "cpu_only": True,
    "supported_dtypes": ["fp32", "int8"],
    "notes": "Capability profile pinned CPU-only + int8 so Dreamer's proposals "
             "stay deployment-realistic.",
    "cores": 8,
    "avx512": True,
}


class TestR05CapabilityProfileProvenance:
    """R-05 (HIGH) — two conflicting capability.json files existed; the
    plugin-side one was hand-authored, schema-nonconformant, and bypassed the
    prober entirely.  Two agents reading "the capability profile" got
    contradictory answers depending on which root they resolved.
    """

    def test_r05_nonconformant_profile_is_rejected_not_silently_none(
        self, tmp_path: Path
    ) -> None:
        evor_root = tmp_path / ".evor"
        evor_root.mkdir(parents=True)
        (evor_root / "capability.json").write_text(json.dumps(_HAND_AUTHORED_PROFILE))

        with pytest.raises(Exception) as excinfo:
            read_capability(evor_root)

        assert "capability" in str(excinfo.value).lower(), (
            "read_capability() must distinguish 'malformed profile on disk' from "
            "'probe not yet run'. Returning None for both lets a hand-authored "
            "file read as an absent one."
        )

    def test_r05_probe_output_is_labelled_as_a_measurement(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        _install_fake_torch(monkeypatch)
        profile = probe_capability(tmp_path / ".evor")
        dumped = profile.model_dump(exclude_none=False)

        assert "source" in dumped, (
            "CapabilityProfile carries no provenance field, so a policy pin and "
            f"a probe measurement are indistinguishable; fields: {sorted(dumped)}"
        )
        assert dumped["source"] == "probe"

    def test_r05_policy_pin_is_accepted_only_when_declared_as_one(
        self, tmp_path: Path
    ) -> None:
        """Pinning a profile to steer proposals is legitimate — it just must
        say so, rather than impersonating the prober's output."""
        evor_root = tmp_path / ".evor"
        evor_root.mkdir(parents=True)
        pinned = {
            "gpu_arch": None,
            "gpu_name": None,
            "vram_gb": None,
            "supported_dtypes": ["fp32", "int8"],
            "available_libs": [],
            "cuda_version": None,
            "cpu_only": True,
            "probed_at": "2026-08-23T03:47:00+00:00",
            "source": "policy-pin",
        }
        (evor_root / "capability.json").write_text(json.dumps(pinned))

        profile = read_capability(evor_root)
        assert profile is not None, "a declared policy pin must still load"
        assert profile.model_dump(exclude_none=False).get("source") == "policy-pin", (
            "the declared provenance must survive the round-trip, so a reader "
            "can tell it is not a measurement of this machine"
        )


# ─────────────────────────────────────────────────────────────────────────────
# R-08 — run start gated on a fresh probe
# ─────────────────────────────────────────────────────────────────────────────

def _minimal_answers() -> dict:
    return {
        "mission_id": "test-mission",
        "mode": "from-scratch",
        "mission_type": "fixed",
        "task_description": "Classify images into 10 categories",
        "dataset_ref": "/data/cifar10",
        "metric_specs": [
            {
                "metric_name": "accuracy",
                "direction": "higher",
                "domain_applicability": "all",
                "aggregation_rule": "macro_avg",
                "role": "primary_fitness",
            }
        ],
        "fitness_mode": "aggregate",
        "eval_version": "v1",
        "baseline_value": 0.70,
        "target_value": 0.85,
        "coverage_target": None,
        "stop_condition": {"type": "target"},
        "wildness": 0.5,
        "budget": {
            "max_iterations": 20,
            "plateau_window": 5,
            "circuit_breaker": 3,
            "max_cost_usd": 50.0,
        },
        "framework": "pytorch",
        "seed_repo_path": None,
        "locked_split_hash": "abc123deadbeef",
        "eval_script_hash": "def456cafebabe",
        "expansion_policy": None,
        "allowed_licenses": ["MIT", "Apache-2.0"],
        "evolution_bounds": None,
        "autonomy_charter": None,
        "created_at": "2026-07-06T00:00:00+00:00",
    }


class TestR08ProbeFreshness:
    """R-08 (MEDIUM) — the run started at 00:05 and the capability probe ran at
    00:55.  The plugin's own docs place evor_capability BEFORE preflight; here
    the first fifty minutes of candidate sizing ran against no profile at all.
    """

    def test_r08_run_start_refuses_without_a_capability_probe(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        answers = tmp_path / "answers.json"
        answers.write_text(json.dumps(_minimal_answers()))
        evor_root = tmp_path / ".evor"   # deliberately has no capability.json

        rc = run_init_run(
            str(answers), run_id_arg="run-fixed", evor_root_arg=str(evor_root)
        )
        out = capsys.readouterr().out

        assert rc == 1, (
            "run_init_run() created a run with no capability profile on disk. "
            "Run start must be gated on a probe so sizing decisions cannot "
            f"precede the measurement they depend on. stdout={out.strip()!r}"
        )
        assert "capability" in out.lower()

    def test_r08_run_start_refuses_a_stale_probe(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        answers = tmp_path / "answers.json"
        answers.write_text(json.dumps(_minimal_answers()))
        evor_root = tmp_path / ".evor"
        evor_root.mkdir(parents=True)
        (evor_root / "capability.json").write_text(json.dumps({
            "gpu_arch": "sm_80",
            "gpu_name": "NVIDIA A100 80GB PCIe",
            "vram_gb": 79.25,
            "supported_dtypes": ["fp32", "fp16", "bf16"],
            "available_libs": [],
            "cuda_version": "13.0",
            "cpu_only": False,
            "probed_at": "2020-01-01T00:00:00+00:00",   # years stale
        }))

        rc = run_init_run(
            str(answers), run_id_arg="run-fixed", evor_root_arg=str(evor_root)
        )
        out = capsys.readouterr().out

        assert rc == 1, (
            "a capability profile probed years before the run was accepted "
            f"without complaint; stdout={out.strip()!r}"
        )
        assert "stale" in out.lower() or "capability" in out.lower()


# ─────────────────────────────────────────────────────────────────────────────
# R-03 — reproducibility, the parts that live in THIS repo
# ─────────────────────────────────────────────────────────────────────────────

class TestR03Reproducibility:
    """R-03 (BLOCKER) — runs were not reproducible: no lockfile, no pinned
    interpreter, no repo.  Most of that is a property of the user's project.
    These two assertions are the parts this repo owns.

    NOT-TESTABLE here, recorded in the RED report rather than faked:
      - the research project not being a git repository (R-02)
      - training running from /opt/conda/envs/shared-base (R-03 item 3)
      - the absence of a hardware pin (R-03 item 4)
    """

    def test_r03_repo_pins_its_own_python_dependencies(self) -> None:
        text = (_REPO_ROOT / "pyproject.toml").read_text()
        start = re.search(r"^dependencies\s*=\s*\[", text, re.M)
        assert start, "no [project].dependencies block in pyproject.toml"

        # Scan to the matching close bracket — extras like uvicorn[standard]
        # nest brackets inside the list.
        depth, i = 0, start.end() - 1
        while i < len(text):
            if text[i] == "[":
                depth += 1
            elif text[i] == "]":
                depth -= 1
                if depth == 0:
                    break
            i += 1
        specs = re.findall(r'"([^"]+)"', text[start.end():i])
        lockfiles = [
            p for p in ("uv.lock", "requirements.lock", "poetry.lock", "pdm.lock")
            if (_REPO_ROOT / p).exists()
        ]
        unbounded = [s for s in specs if not re.search(r"(==|<=|<|~=)", s)]

        assert lockfiles or not unbounded, (
            "oh-my-evor's own dependencies carry lower bounds only and there is "
            f"no lockfile, so the harness itself is not pinned: {unbounded}"
        )

    def test_r03_run_records_interpreter_and_package_set(self, tmp_path: Path) -> None:
        answers = tmp_path / "answers.json"
        answers.write_text(json.dumps(_minimal_answers()))
        evor_root = tmp_path / ".evor"
        evor_root.mkdir(parents=True)
        (evor_root / "capability.json").write_text(
            json.dumps({
                "gpu_arch": None, "gpu_name": None, "vram_gb": None,
                "supported_dtypes": ["fp32"], "available_libs": [],
                "cuda_version": None, "cpu_only": True,
                "probed_at": "2026-07-06T00:00:00+00:00",
            })
        )
        run_init_run(str(answers), run_id_arg="run-fixed", evor_root_arg=str(evor_root))

        run_dir = evor_root / "runs" / "test-mission" / "run-fixed"
        manifest = run_dir / "env-manifest.json"
        assert manifest.exists(), (
            "a run records no environment manifest, so the interpreter and "
            "package versions a result was produced under are unrecoverable "
            f"after the fact. Files written: {sorted(p.name for p in run_dir.iterdir())}"
        )
        data = json.loads(manifest.read_text())
        assert "python_version" in data and "python_executable" in data
        assert data.get("packages"), "manifest records no package versions"


# ─────────────────────────────────────────────────────────────────────────────
# R-11 — killed jobs and completion evidence
# ─────────────────────────────────────────────────────────────────────────────

class TestR11JobLifecycle:
    """R-11 (MEDIUM) — background training was killed at subagent turn end;
    nohup and setsid did not help, and one run died at step 254 of 450, leaving
    a weights.pt that looks valid on disk.

    The second test is the load-bearing one: lane R's open question is how many
    recorded results came from checkpoints of killed runs, which feeds directly
    into lane M's validity findings.
    """

    def test_r11_detached_job_runs_in_its_own_session(self, tmp_path: Path) -> None:
        """First half: the supervisor must outlive the turn that spawned it,
        which requires its own session so a group-kill of the caller misses it.
        """
        run_dir = tmp_path / "run"
        run_dir.mkdir()
        info = start_job([sys.executable, "-c", "import time; time.sleep(30)"], run_dir)
        st = json.loads(Path(info["status_path"]).read_text())
        pid = st["pid"]
        try:
            assert os.getsid(pid) != os.getsid(0), (
                "supervisor shares the caller's session; a group kill at turn "
                "end takes the training job with it"
            )
        finally:
            try:
                os.killpg(os.getpgid(pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            try:
                os.waitpid(pid, 0)
            except ChildProcessError:
                pass

    def test_r11_killed_job_is_not_reported_as_running(self, tmp_path: Path) -> None:
        """Second half, part one: when the supervisor dies without flipping
        status.json, status() must report the job as dead rather than echoing a
        'running' state that will never change.
        """
        run_dir = tmp_path / "run"
        run_dir.mkdir()
        info = start_job([sys.executable, "-c", "import time; time.sleep(30)"], run_dir)
        pid = json.loads(Path(info["status_path"]).read_text())["pid"]

        os.killpg(os.getpgid(pid), signal.SIGKILL)
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass
        # Give the OS a beat to finish tearing the process group down.
        for _ in range(50):
            try:
                os.kill(pid, 0)
            except OSError:
                break
            time.sleep(0.05)

        st = status(info["job_id"], run_dir)
        assert st["state"] != "running", (
            "status() re-reads status.json without checking whether the "
            f"supervisor is still alive; a SIGKILLed job reports {st['state']!r} "
            "forever, and its half-written checkpoint looks like a finished run"
        )
        assert st["state"] in {"killed", "failed", "dead"}, (
            f"a killed job must be classified, not left ambiguous: {st['state']!r}"
        )
        assert Path(status_path(run_dir, info["job_id"])).exists()

    def test_r11_truncated_trainer_fails_the_integrity_gate(
        self, tmp_path: Path
    ) -> None:
        """Second half, part two — the invariant that actually protects the
        science: a result must carry evidence its trainer ran to completion.

        Here the node was configured for 450 steps and the telemetry stops at
        254, exactly the shape lane R observed.  Every other integrity input is
        clean, so the only thing that can fail this node is a completion check.
        """
        from tests.test_integrity import (  # reuse the established factories
            _make_frozen_split,
            _make_goal,
            _write_eval_script,
            _write_telemetry,
        )

        samples = {str(i): f"sample-{i}".encode() for i in range(8)}
        frozen = _make_frozen_split(tmp_path, samples)
        eval_script = tmp_path / "eval-suites" / "v1.py"
        eval_hash = _write_eval_script(eval_script)
        goal = _make_goal(frozen.split_hash, eval_hash)

        node = TreeNode(
            id="node-test-001",
            parent_ids=[],
            approach_family="arch",
            hypothesis_id="hyp-001",
            code_ref="nodes/node-test-001/code/",
            genome_ref="genome-ref-abc",
            data_version_ref="data-v1",
            config={"max_steps": 450},
            metrics={"accuracy": 0.85},
            eval_version="v1",
            lesson_ids=[],
            citations=[],
            integrity_status="pending",
            status="done",
            is_crossover=False,
            visit_count=1,
            depth=0,
            created_at="2026-07-03T00:00:00Z",
            mutation_locus=MutationLocusArch(family="arch", path="model/"),
        )
        result = EvaluationResult(
            node_id="node-test-001",
            run_id="run-001",
            eval_version="v1",
            metrics={"accuracy": 0.85},
            per_domain={"default": {"accuracy": 0.85}},
            fitness_value=0.85,
            telemetry_summary=TelemetrySummary(total_steps=254),
            status="success",
            benchmark_raw="",
            timestamp="2026-07-03T02:00:00Z",
        )

        telemetry = tmp_path / "telemetry.jsonl"
        _write_telemetry(
            telemetry,
            [
                {"step": i, "train_loss": round(1.0 - i * 0.002, 5), "grad_norm": 1.0}
                for i in range(254)
            ],
        )

        report = IntegrityGate().check(
            node=node,
            result=result,
            goal=goal,
            telemetry_path=telemetry,
            eval_script_path=eval_script,
            frozen_test=frozen,
            provenance_path=None,
            run_dir=tmp_path,
        )
        checks = report.checks.model_dump(exclude_none=False)

        assert "trainer_completed" in checks, (
            "IntegrityChecks has no completion check, so a checkpoint from a "
            "killed trainer (254 of 450 steps) is scored as a finished run. "
            f"Checks present: {sorted(checks)}"
        )
        assert checks["trainer_completed"] is False
        assert report.verdict == "failed"


# ─────────────────────────────────────────────────────────────────────────────
# R-15 — cwd-anchored imports
# ─────────────────────────────────────────────────────────────────────────────

_CWD_ANCHORED_TRAINER = '''\
import os
import sys

sys.path.insert(0, os.getcwd())

from model import Net


def train():
    tel = os.environ["EVOR_TELEMETRY_PATH"]
    with open(tel, "a") as fh:
        fh.write("{}\\n")
'''


class TestR15CwdAnchoredImports:
    """R-15 (LOW) — `sys.path.insert(0, os.getcwd())` in a candidate trainer
    resolved against the wrong cwd and raised ModuleNotFoundError: 'model'.
    Candidate code must anchor its imports to __file__.
    """

    def test_r15_structure_gate_rejects_cwd_anchored_sys_path(
        self, tmp_path: Path
    ) -> None:
        candidate = tmp_path / "node-001"
        (candidate / "train").mkdir(parents=True)
        (candidate / "train" / "trainer.py").write_text(_CWD_ANCHORED_TRAINER)

        report = ForgeStructureGate().check(candidate)
        check = report.check_by_name("path_anchoring")

        assert check is not None, (
            "ForgeStructureGate has no path-anchoring sub-check, so candidate "
            "code that resolves imports against the process cwd merges clean "
            f"and fails at launch. Sub-checks present: "
            f"{[c.name for c in report.checks]}"
        )
        assert check.passed is False, (
            f"sys.path.insert(0, os.getcwd()) was accepted: {check.reason}"
        )

    def test_r15_structure_gate_accepts_file_anchored_sys_path(
        self, tmp_path: Path
    ) -> None:
        candidate = tmp_path / "node-002"
        (candidate / "train").mkdir(parents=True)
        (candidate / "train" / "trainer.py").write_text(
            _CWD_ANCHORED_TRAINER.replace(
                "sys.path.insert(0, os.getcwd())",
                "sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))",
            )
        )

        report = ForgeStructureGate().check(candidate)
        check = report.check_by_name("path_anchoring")

        assert check is not None, (
            "ForgeStructureGate has no path-anchoring sub-check; the positive "
            "control cannot pass either"
        )
        assert check.passed is True, (
            f"__file__-anchored sys.path was rejected: {check.reason}"
        )
