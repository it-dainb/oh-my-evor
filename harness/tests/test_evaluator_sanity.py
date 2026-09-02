"""§2.6 — an evaluator that rates doing nothing highly may not be sealed.

K-10 / AF2 §4.4: a trivial all-ones predictor scored **94.7 F** on this corpus
and the evaluator that produced that number was sealed. Nothing objected,
because nothing had ever asked the evaluator what it says about a candidate that
does no work.

Precondition of custody (2.7): sealing makes an evaluator permanently binding, so
custody over an unguarded authoring path makes a mis-authored evaluator
permanently binding instead of merely wrong.
"""

from __future__ import annotations

import pytest

from evor.evaluator_sanity import (
    DEGENERATE_SCORE_CEILING,
    check_evaluator_sanity,
)


class TestTheFieldCase:
    def test_an_all_ones_predictor_scoring_94_7_is_unsealable(self):
        v = check_evaluator_sanity(lambda name: 0.947 if name == "all_ones" else 0.1)
        assert v.sealable is False
        assert not v
        assert any("0.9470" in r for r in v.reasons)

    def test_the_reason_says_why_rather_than_just_no(self):
        v = check_evaluator_sanity(lambda name: 0.947 if name == "all_ones" else 0.1)
        joined = " ".join(v.reasons)
        assert "not measuring the task" in joined


class TestAGoodEvaluatorPasses:
    def test_a_metric_that_rates_nothing_near_zero_is_sealable(self):
        v = check_evaluator_sanity(lambda _name: 0.02)
        assert v.sealable is True
        assert bool(v)
        assert set(v.scores) == {"all_ones", "all_zeros", "copy_input"}

    def test_the_gate_must_not_block_a_merely_mediocre_evaluator(self):
        # It is a category check, not a quality bar.
        v = check_evaluator_sanity(lambda _name: DEGENERATE_SCORE_CEILING - 0.01)
        assert v.sealable is True


class TestInvertedPolarity:
    def test_all_zeros_scoring_high_is_caught_too(self):
        # The same defect with the opposite sign. r1 and r2 both failed on
        # polarity, and an evaluator scoring the inverse image highly is exactly
        # as broken as one scoring the constant image highly.
        v = check_evaluator_sanity(lambda name: 0.93 if name == "all_zeros" else 0.05)
        assert v.sealable is False
        assert any("all_zeros" in r for r in v.reasons)

    def test_an_identity_evaluator_is_caught(self):
        v = check_evaluator_sanity(lambda name: 0.99 if name == "copy_input" else 0.04)
        assert v.sealable is False


class TestRefusalIsNotFailure:
    def test_an_evaluator_that_raises_on_nonsense_is_acceptable(self):
        def score(name: str) -> float:
            raise ValueError("cannot score a constant prediction")

        v = check_evaluator_sanity(score)
        assert v.sealable is True, "refusing to score nonsense is correct behaviour"
        assert all("acceptable" in r for r in v.reasons)


class TestAnUnrunGateDoesNotPass:
    def test_no_predictors_means_unsealable(self):
        v = check_evaluator_sanity(lambda _n: 0.0, predictors=[])
        # `record.ts:162` — absence of a failure verdict is not evidence of
        # integrity. This is the `integrity.py:404` failure mode as a positive
        # requirement: a gate that did not run must not report a pass.
        assert v.sealable is False
        assert any("did not run" in r for r in v.reasons)
