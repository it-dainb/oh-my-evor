"""
harness/tests/test_citation_backed_finding.py — unit tests for CitationBackedFinding

Coverage:
  - Construct with required fields only; new optional fields default correctly
  - implementation_spec defaults to None
  - key_hyperparams defaults to None
  - libraries defaults to [] and round-trips
  - Construct with all fields including all three new ones
  - JSON round-trip (model_dump_json → model_validate_json)
  - Verbatim LaTeX formula preserved byte-for-byte through round-trip
  - Rich implementation_spec (training recipe + library name) preserved exactly
  - Invalid confidence / trust_level / applicable_families rejected by Pydantic

Only contracts.py is imported; no subprocess calls, no filesystem I/O.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from evor.contracts import CitationBackedFinding

# Portable harness dir (this file lives in <harness>/tests/). Works on the host
# and inside the container — do NOT hardcode.
_HARNESS_DIR = Path(__file__).resolve().parent.parent

# ─── Shared fixtures ──────────────────────────────────────────────────────────

_REQUIRED_KWARGS: dict = dict(
    title="Temperature scaling improves calibration",
    source_url="https://arxiv.org/abs/1706.04599",
    sources=["https://arxiv.org/abs/1706.04599", "https://papers.nips.cc/paper/2017/hash/"],
    finding="Post-hoc temperature scaling reduces ECE by ~40% on CIFAR-100 without retraining.",
    evidence="ECE 4.2% → 2.5% on CIFAR-100 test set; WideResNet-28-10; T optimised on val.",
    confidence="high",
    trust_level="authoritative",
    applicable_families=["training"],
    quorum_met=True,
)

# Verbatim LaTeX formula from Guo et al. 2017 (temperature scaling NLL)
_VERBATIM_FORMULA = (
    r"loss = -\sum_{i} y_i \log\!\left(\frac{\exp(z_i / \tau)}{\sum_j \exp(z_j / \tau)}\right)"
)

# Rich implementation spec that includes a training recipe and a named library — the
# kind of multi-section blueprint Forge-junior would receive for a paper like augraphy.
_RICH_IMPL_SPEC = """\
Architecture: lightweight encoder-decoder; backbone=ResNet-18 pretrained on ImageNet.

Training recipe (Table 3):
  - Optimizer: AdamW, lr=3e-4, weight_decay=1e-2
  - Schedule: cosine decay, 100 epochs, 10-epoch linear warmup
  - Batch size: 32 per GPU x 4 GPUs (effective 128)
  - EMA decay: 0.9999 applied after each step

Augmentation pipeline (order matters, applied with augraphy>=0.3):
  1. augraphy.AugraphyPipeline([InkBleed(p=0.3), BadPhotocopy(p=0.2)])
  2. albumentations.HorizontalFlip(p=0.5)
  3. albumentations.Normalize(mean=[0.485,0.456,0.406], std=[0.229,0.224,0.225])

Inference: single-scale, no TTA; threshold tuned on val (best=0.45).
"""


# ─── Construction ─────────────────────────────────────────────────────────────


class TestCitationBackedFindingConstruction:
    """Basic construction with and without the three new implementation-fidelity fields."""

    def test_required_fields_only(self) -> None:
        f = CitationBackedFinding(**_REQUIRED_KWARGS)
        assert f.title == "Temperature scaling improves calibration"
        assert f.confidence == "high"
        assert f.trust_level == "authoritative"
        assert f.quorum_met is True
        assert f.applicable_families == ["training"]

    def test_implementation_spec_defaults_to_none(self) -> None:
        f = CitationBackedFinding(**_REQUIRED_KWARGS)
        assert f.implementation_spec is None

    def test_key_hyperparams_defaults_to_none(self) -> None:
        f = CitationBackedFinding(**_REQUIRED_KWARGS)
        assert f.key_hyperparams is None

    def test_libraries_defaults_to_empty_list(self) -> None:
        f = CitationBackedFinding(**_REQUIRED_KWARGS)
        assert f.libraries == []

    def test_junior_sources_defaults_to_empty_list(self) -> None:
        f = CitationBackedFinding(**_REQUIRED_KWARGS)
        assert f.junior_sources == []

    def test_sota_bar_defaults_to_none(self) -> None:
        f = CitationBackedFinding(**_REQUIRED_KWARGS)
        assert f.sota_bar is None

    def test_with_implementation_spec(self) -> None:
        f = CitationBackedFinding(**_REQUIRED_KWARGS, implementation_spec=_VERBATIM_FORMULA)
        assert f.implementation_spec == _VERBATIM_FORMULA

    def test_with_key_hyperparams(self) -> None:
        params = {"tau": 0.1, "lr": 0.01, "epochs": 50}
        f = CitationBackedFinding(**_REQUIRED_KWARGS, key_hyperparams=params)
        assert f.key_hyperparams == {"tau": 0.1, "lr": 0.01, "epochs": 50}

    def test_with_libraries(self) -> None:
        libs = ["augraphy", "timm", "kornia", "albumentations"]
        f = CitationBackedFinding(**_REQUIRED_KWARGS, libraries=libs)
        assert f.libraries == libs

    def test_with_all_new_fields(self) -> None:
        params = {"tau": 0.5}
        libs = ["augraphy", "albumentations"]
        f = CitationBackedFinding(
            **_REQUIRED_KWARGS,
            sota_bar=0.025,
            junior_sources=["https://example.com/blog"],
            implementation_spec=_RICH_IMPL_SPEC,
            key_hyperparams=params,
            libraries=libs,
        )
        assert f.sota_bar == pytest.approx(0.025)
        assert f.junior_sources == ["https://example.com/blog"]
        assert f.implementation_spec == _RICH_IMPL_SPEC
        assert f.key_hyperparams == params
        assert f.libraries == libs

    def test_multiple_applicable_families(self) -> None:
        f = CitationBackedFinding(
            **{**_REQUIRED_KWARGS, "applicable_families": ["arch", "training", "algo"]}
        )
        assert set(f.applicable_families) == {"arch", "training", "algo"}

    def test_empty_applicable_families_accepted(self) -> None:
        f = CitationBackedFinding(
            **{**_REQUIRED_KWARGS, "applicable_families": []}
        )
        assert f.applicable_families == []


# ─── JSON round-trip ──────────────────────────────────────────────────────────


class TestCitationBackedFindingRoundTrip:
    """model_dump_json → model_validate_json must be an identity operation."""

    def test_round_trip_required_fields(self) -> None:
        f = CitationBackedFinding(**_REQUIRED_KWARGS)
        blob = f.model_dump_json()
        f2 = CitationBackedFinding.model_validate_json(blob)
        assert f2.title == f.title
        assert f2.finding == f.finding
        assert f2.confidence == f.confidence
        assert f2.trust_level == f.trust_level
        assert f2.quorum_met == f.quorum_met
        assert f2.applicable_families == f.applicable_families
        assert f2.implementation_spec is None
        assert f2.key_hyperparams is None
        assert f2.libraries == []

    def test_round_trip_with_new_fields(self) -> None:
        params = {"tau": 0.1, "beta1": 0.9, "beta2": 0.999}
        libs = ["timm", "kornia"]
        f = CitationBackedFinding(
            **_REQUIRED_KWARGS,
            implementation_spec=_VERBATIM_FORMULA,
            key_hyperparams=params,
            libraries=libs,
        )
        blob = f.model_dump_json()
        f2 = CitationBackedFinding.model_validate_json(blob)
        assert f2.implementation_spec == f.implementation_spec
        assert f2.key_hyperparams == params
        assert f2.libraries == libs

    def test_libraries_round_trip(self) -> None:
        libs = ["augraphy", "timm", "kornia", "albumentations"]
        f = CitationBackedFinding(**_REQUIRED_KWARGS, libraries=libs)
        blob = f.model_dump_json()
        f2 = CitationBackedFinding.model_validate_json(blob)
        assert f2.libraries == libs

    def test_verbatim_formula_preserved_byte_for_byte(self) -> None:
        """A verbatim LaTeX formula must survive model_dump_json → model_validate_json
        without any character mutation (backslashes, braces, subscripts, unicode)."""
        f = CitationBackedFinding(**_REQUIRED_KWARGS, implementation_spec=_VERBATIM_FORMULA)
        blob = f.model_dump_json()
        f2 = CitationBackedFinding.model_validate_json(blob)
        # Byte-for-byte equality: no escaping, normalisation, or truncation
        assert f2.implementation_spec == _VERBATIM_FORMULA
        assert len(f2.implementation_spec) == len(_VERBATIM_FORMULA)

    def test_rich_implementation_spec_preserved_exactly(self) -> None:
        """A multi-section training recipe + library name must survive the round-trip
        character-for-character — newlines, spacing, and 'augraphy' name intact."""
        f = CitationBackedFinding(
            **_REQUIRED_KWARGS,
            implementation_spec=_RICH_IMPL_SPEC,
            libraries=["augraphy", "albumentations"],
        )
        blob = f.model_dump_json()
        f2 = CitationBackedFinding.model_validate_json(blob)
        assert f2.implementation_spec == _RICH_IMPL_SPEC
        assert len(f2.implementation_spec) == len(_RICH_IMPL_SPEC)
        # Library name carried in spec is still there verbatim
        assert "augraphy" in f2.implementation_spec
        assert "AugraphyPipeline" in f2.implementation_spec

    def test_unicode_formula_preserved(self) -> None:
        """Unicode math symbols (e.g. Sigma, tau) must also survive the round-trip."""
        unicode_formula = "loss = -Σ y_i log(p_i/τ)"
        f = CitationBackedFinding(**_REQUIRED_KWARGS, implementation_spec=unicode_formula)
        blob = f.model_dump_json()
        f2 = CitationBackedFinding.model_validate_json(blob)
        assert f2.implementation_spec == unicode_formula

    def test_model_dump_dict_round_trip(self) -> None:
        """model_dump() → model_validate() (dict path) also round-trips correctly."""
        f = CitationBackedFinding(
            **_REQUIRED_KWARGS,
            implementation_spec=_VERBATIM_FORMULA,
            key_hyperparams={"tau": 0.1},
            libraries=["timm"],
        )
        data = f.model_dump()
        f2 = CitationBackedFinding.model_validate(data)
        assert f2.implementation_spec == _VERBATIM_FORMULA
        assert f2.key_hyperparams == {"tau": 0.1}
        assert f2.libraries == ["timm"]

    def test_json_blob_contains_all_new_keys(self) -> None:
        """The serialised JSON must carry all three new fields even at their defaults."""
        f = CitationBackedFinding(**_REQUIRED_KWARGS)
        parsed = json.loads(f.model_dump_json())
        assert "implementation_spec" in parsed
        assert "key_hyperparams" in parsed
        assert "libraries" in parsed


# ─── Validation / rejection ───────────────────────────────────────────────────


class TestCitationBackedFindingValidation:
    """Pydantic strict mode must reject bad literals and missing required fields."""

    def test_invalid_confidence_rejected(self) -> None:
        with pytest.raises(ValidationError):
            CitationBackedFinding(**{**_REQUIRED_KWARGS, "confidence": "very_high"})

    def test_invalid_trust_level_rejected(self) -> None:
        with pytest.raises(ValidationError):
            CitationBackedFinding(**{**_REQUIRED_KWARGS, "trust_level": "verified"})

    def test_invalid_applicable_family_rejected(self) -> None:
        with pytest.raises(ValidationError):
            CitationBackedFinding(
                **{**_REQUIRED_KWARGS, "applicable_families": ["vision"]}
            )

    def test_missing_required_field_finding_rejected(self) -> None:
        kwargs = {k: v for k, v in _REQUIRED_KWARGS.items() if k != "finding"}
        with pytest.raises((ValidationError, TypeError)):
            CitationBackedFinding(**kwargs)

    def test_missing_required_field_sources_rejected(self) -> None:
        kwargs = {k: v for k, v in _REQUIRED_KWARGS.items() if k != "sources"}
        with pytest.raises((ValidationError, TypeError)):
            CitationBackedFinding(**kwargs)

    @pytest.mark.parametrize("confidence", ["high", "medium", "low"])
    def test_all_confidence_values_accepted(self, confidence: str) -> None:
        f = CitationBackedFinding(**{**_REQUIRED_KWARGS, "confidence": confidence})
        assert f.confidence == confidence

    @pytest.mark.parametrize("trust", ["authoritative", "indicative"])
    def test_all_trust_levels_accepted(self, trust: str) -> None:
        f = CitationBackedFinding(**{**_REQUIRED_KWARGS, "trust_level": trust})
        assert f.trust_level == trust
