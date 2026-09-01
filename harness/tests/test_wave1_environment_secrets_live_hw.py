"""
test_wave1_environment_secrets_live_hw.py — REAL-HARDWARE RED tests for
field-trace category 8 (ENVIRONMENT & SECRETS), findings R-04, R-05, R-08, R-09.

These do not mock torch. They run the shipped prober against the actual GPU in
this machine and compare what it wrote to what `torch.cuda.mem_get_info()` and
`nvidia-smi` say is really free. The unit tests in
``test_wave1_environment_secrets.py`` assert the same invariants against a fake
device; this file is the instrument that shows the defect is not an artifact of
the fake.

That matters more than usual here: the field trace ran on an
**NVIDIA A100 80GB PCIe**, and so does this box. When these tests run on that
hardware they are not a simulation of R-04 — they are R-04, reproduced.

Gating
------
Guarded by ``EVOR_LIVE_HW=1``. This is a HARDWARE gate, not a
``.skip``-of-a-failing-test: with the gate on, every failure below is loud, and
an absent or unreachable GPU is reported as an error rather than passed over.
No model is called and nothing is billed — only local CUDA queries — so there is
no reason not to run it on any box with a GPU.

    EVOR_LIVE_HW=1 PYTHONPATH=harness python3 -m pytest \
        harness/tests/test_wave1_environment_secrets_live_hw.py -q -s

On a CPU-only box the GPU-branch tests fail with an explicit
"no CUDA device" message rather than silently passing.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

from evor.capability import probe_capability, read_capability

pytestmark = pytest.mark.skipif(
    os.environ.get("EVOR_LIVE_HW") != "1",
    reason="real-hardware probe; set EVOR_LIVE_HW=1 to run (no model is called, nothing is billed)",
)

# The goal contract of all three field-trace missions forbade these outright,
# and the run's own verification artifact recorded "No fp8, no flash_attn" as a
# PASS condition.
_CONTRACT_FORBIDDEN_LIBS = {"flash-attn", "xformers", "triton"}


def _torch_or_fail():
    try:
        import torch  # type: ignore[import]
    except ImportError:  # pragma: no cover - environment dependent
        pytest.fail(
            "torch is not importable, so the GPU branch of the prober cannot be "
            "exercised. This is an ERROR, not a pass: install torch or unset "
            "EVOR_LIVE_HW."
        )
    if not torch.cuda.is_available():  # pragma: no cover - environment dependent
        pytest.fail(
            "no CUDA device is available, so R-04 cannot be reproduced on this "
            "box. This is an ERROR, not a pass: run on a GPU host or unset "
            "EVOR_LIVE_HW."
        )
    return torch


@pytest.fixture(scope="module")
def real_probe(tmp_path_factory: pytest.TempPathFactory) -> dict:
    """Run the SHIPPED prober against this machine and capture ground truth
    beside it."""
    torch = _torch_or_fail()
    evor_root = tmp_path_factory.mktemp("live-hw") / ".evor"
    profile = probe_capability(evor_root)

    free_bytes, total_bytes = torch.cuda.mem_get_info()
    smi = None
    if shutil.which("nvidia-smi"):
        out = subprocess.run(
            ["nvidia-smi",
             "--query-gpu=name,memory.total,memory.used,memory.free",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=30,
        )
        if out.returncode == 0:
            smi = out.stdout.strip().splitlines()[0]

    ctx = {
        "evor_root": evor_root,
        "profile": profile,
        "written": json.loads((evor_root / "capability.json").read_text()),
        "free_gb": round(free_bytes / 1024 ** 3, 2),
        "total_gb": round(total_bytes / 1024 ** 3, 2),
        "nvidia_smi": smi,
    }
    print(
        "\n[live-hw] shipped prober wrote: "
        + json.dumps(ctx["written"], indent=2)
        + f"\n[live-hw] ground truth: free={ctx['free_gb']} GiB  total={ctx['total_gb']} GiB"
        + (f"\n[live-hw] nvidia-smi: {smi}" if smi else "")
    )
    return ctx


# ─────────────────────────────────────────────────────────────────────────────
# R-04 — total VRAM vs free VRAM, on real silicon
# ─────────────────────────────────────────────────────────────────────────────

class TestR04LiveFreeVram:
    def test_r04_live_written_profile_carries_a_free_memory_figure(
        self, real_probe: dict
    ) -> None:
        written = real_probe["written"]
        free_fields = [k for k in written if "free" in k.lower()]
        assert free_fields, (
            "capability.json written by the shipped prober on this machine "
            f"records no free-memory figure. It reports vram_gb="
            f"{written.get('vram_gb')} while {real_probe['free_gb']} GiB is "
            f"actually free of {real_probe['total_gb']} GiB total. Keys written: "
            f"{sorted(written)}"
        )

    def test_r04_live_recorded_figure_matches_what_is_actually_free(
        self, real_probe: dict
    ) -> None:
        """The consequence, stated as a number: an agent that sizes a candidate
        against the recorded figure is sizing against memory it does not have.
        """
        written = real_probe["written"]
        free_fields = [k for k in written if "free" in k.lower()]
        recorded_free = written[free_fields[0]] if free_fields else written.get("vram_gb")
        overstatement = (recorded_free or 0) - real_probe["free_gb"]
        assert overstatement <= 2.0, (
            f"the figure an agent would size against ({recorded_free} GB) "
            f"overstates actually-free memory ({real_probe['free_gb']} GiB) by "
            f"{overstatement:.2f} GiB on this host. This is R-04 reproduced on "
            f"the same GPU model the field trace ran on."
        )

    def test_r04_live_free_figure_is_plausible_against_nvidia_smi(
        self, real_probe: dict
    ) -> None:
        """Cross-check against a second, independent source, so a fix cannot
        satisfy the previous test by echoing torch back at itself."""
        smi = real_probe["nvidia_smi"]
        if smi is None:  # pragma: no cover - environment dependent
            pytest.fail(
                "nvidia-smi is not available, so the independent cross-check "
                "cannot run. ERROR, not a pass."
            )
        fields = [f.strip() for f in smi.split(",")]
        smi_free_gb = int(fields[3]) * 1024 ** 2 / 1024 ** 3   # MiB -> GiB

        written = real_probe["written"]
        free_fields = [k for k in written if "free" in k.lower()]
        assert free_fields, (
            f"no free-memory field to cross-check; nvidia-smi reports "
            f"{smi_free_gb:.2f} GiB free on {fields[0]}"
        )
        assert written[free_fields[0]] == pytest.approx(smi_free_gb, abs=3.0)


# ─────────────────────────────────────────────────────────────────────────────
# R-09 — advertised libs vs contract-forbidden libs, on real silicon
# ─────────────────────────────────────────────────────────────────────────────

class TestR09LiveAdvertisedLibs:
    def test_r09_live_profile_does_not_advertise_contract_forbidden_libs(
        self, real_probe: dict
    ) -> None:
        advertised = set(real_probe["written"].get("available_libs", []))
        offenders = sorted(advertised & _CONTRACT_FORBIDDEN_LIBS)
        assert offenders == [], (
            f"capability.json advertises {offenders} as available on this "
            "machine purely because they import. The goal contract forbade all "
            "three, and the run's verification artifact scored 'no flash_attn' "
            "as a PASS. The profile's most eye-catching claims describe "
            "capabilities the mission was prohibited from touching."
        )

    def test_r09_live_importability_is_recorded_under_its_own_name(
        self, real_probe: dict
    ) -> None:
        written = real_probe["written"]
        assert "importable_libs" in written, (
            "the import result is worth keeping — it just must not be spelled "
            f"'available'. Keys written: {sorted(written)}"
        )


# ─────────────────────────────────────────────────────────────────────────────
# R-05 — provenance of a real probe output
# ─────────────────────────────────────────────────────────────────────────────

class TestR05LiveProvenance:
    def test_r05_live_probe_output_declares_itself_a_measurement(
        self, real_probe: dict
    ) -> None:
        written = real_probe["written"]
        assert written.get("source") == "probe", (
            "a real probe output is byte-indistinguishable from a hand-authored "
            "policy pin. On the field-trace machine two capability.json files "
            "disagreed and no reader could tell which was a measurement. "
            f"Keys written: {sorted(written)}"
        )

    def test_r05_live_hand_authored_profile_is_not_mistaken_for_this_probe(
        self, real_probe: dict, tmp_path: Path
    ) -> None:
        """Drop the field trace's actual hand-authored profile next to a real
        one and confirm the reader can tell them apart."""
        root = tmp_path / ".evor"
        root.mkdir(parents=True)
        (root / "capability.json").write_text(json.dumps({
            "gpu_arch": None,
            "cpu_only": True,
            "supported_dtypes": ["fp32", "int8"],
            "notes": "Capability profile pinned CPU-only + int8 so Dreamer's "
                     "proposals stay deployment-realistic.",
            "cores": 8,
            "avx512": True,
        }))
        with pytest.raises(Exception) as excinfo:
            read_capability(root)
        assert "capability" in str(excinfo.value).lower(), (
            "read_capability() returns None for a hand-authored, "
            "schema-nonconformant profile — the same value it returns when no "
            "probe has run. On this machine a real probe DID run and produced "
            f"{real_probe['written'].get('gpu_name')}; a reader resolving the "
            "other root would see 'not probed yet' and never learn it was "
            "looking at a hand-written CPU-only pin."
        )


# ─────────────────────────────────────────────────────────────────────────────
# R-08 — the freshness gate, against a real timestamp
# ─────────────────────────────────────────────────────────────────────────────

class TestR08LiveProbeFreshness:
    def test_r08_live_probe_writes_a_parseable_timestamp(
        self, real_probe: dict
    ) -> None:
        """Positive control for the gate: probed_at must be machine-comparable,
        otherwise a freshness gate cannot be built on it at all."""
        probed_at = real_probe["written"].get("probed_at")
        assert probed_at and re.match(r"^\d{4}-\d{2}-\d{2}T", probed_at), (
            f"probed_at is not an ISO timestamp: {probed_at!r}"
        )

    def test_r08_live_run_start_consumes_the_real_probe(
        self, real_probe: dict, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """Run start must be gated on the probe. Here the probe is real and
        fresh, and run start still neither reads it nor records which profile
        the run was started under — so a run started before any probe is
        indistinguishable from this one afterwards.
        """
        from tests.test_wave1_environment_secrets import _minimal_answers

        answers = tmp_path / "answers.json"
        answers.write_text(json.dumps(_minimal_answers()))
        evor_root = tmp_path / ".evor"
        evor_root.mkdir(parents=True)
        shutil.copy(
            real_probe["evor_root"] / "capability.json",
            evor_root / "capability.json",
        )

        from evor.init_run import run_init_run

        rc = run_init_run(
            str(answers), run_id_arg="run-live-hw", evor_root_arg=str(evor_root)
        )
        capsys.readouterr()
        assert rc == 0, "a run with a fresh real probe present must start"

        run_dir = evor_root / "runs" / "test-mission" / "run-live-hw"
        state = json.loads((run_dir / "mission-state.json").read_text())
        recorded = json.dumps(state) + (run_dir / "decision-log.md").read_text()
        assert "capability" in recorded.lower() or "probed_at" in recorded, (
            "the run records nothing about which capability profile it was "
            "started under, so 'probed 50 minutes after the run started' leaves "
            "no trace in run state at all. Files written: "
            f"{sorted(p.name for p in run_dir.iterdir())}"
        )
