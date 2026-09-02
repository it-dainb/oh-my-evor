"""Evaluator sanity gate — plan item 2.6.

K-10 / AF2 §4.4. A trivial all-ones predictor scored **94.7 F** on this corpus,
and the evaluator that produced that number was sealed. Nothing objected,
because nothing had ever asked the evaluator the one question that exposes it:
*what do you say about a candidate that does no work at all?*

Document binarisation makes this sharp — most pixels are background, so
predicting a constant scores high on a naive metric. But the failure is general:
an evaluator whose score is near-maximal for a degenerate predictor is not
measuring the thing the mission is trying to improve, and every comparison made
with it is meaningless in the same direction.

**This is a PRECONDITION of custody (2.7), not a Phase 9 nicety.** Sealing an
evaluator makes it permanently binding. Custody over an unguarded authoring path
makes a mis-authored evaluator permanently binding *instead of merely wrong*,
which is worse than having no custody at all. So the gate runs first.

The gate does not need to know the metric. It needs the evaluator to be run
against degenerate predictions and to report what it says.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Iterable

#: A score at or above this from a degenerate predictor means the evaluator is
#: not measuring the task. Deliberately generous — the field case scored 0.947,
#: and a gate that argues about 0.55 vs 0.60 is arguing about the wrong thing.
DEGENERATE_SCORE_CEILING = 0.80

#: The predictions a candidate that does no work would emit. `all_ones` is the
#: field case; `all_zeros` catches an evaluator whose polarity is inverted, which
#: is the same defect wearing the opposite sign (r1 and r2 both failed on
#: polarity). `copy_input` catches an identity evaluator.
DEGENERATE_PREDICTORS = ("all_ones", "all_zeros", "copy_input")


@dataclass
class SanityVerdict:
    sealable: bool
    scores: dict[str, float] = field(default_factory=dict)
    reasons: list[str] = field(default_factory=list)

    def __bool__(self) -> bool:
        return self.sealable


def check_evaluator_sanity(
    score_fn: Callable[[str], float],
    predictors: Iterable[str] = DEGENERATE_PREDICTORS,
    ceiling: float = DEGENERATE_SCORE_CEILING,
) -> SanityVerdict:
    """Run the evaluator against degenerate predictors; decide if it may be sealed.

    ``score_fn(predictor_name)`` returns the evaluator's score for that
    degenerate prediction, on the same scale as a real candidate's.

    An evaluator that RAISES on a degenerate input is fine — refusing to score
    nonsense is correct behaviour, and it is not evidence of a broken metric.
    What is not fine is scoring it highly.
    """
    verdict = SanityVerdict(sealable=True)

    for name in predictors:
        try:
            score = float(score_fn(name))
        except Exception as exc:  # noqa: BLE001 — an evaluator may legitimately refuse
            verdict.reasons.append(f"{name}: evaluator refused to score it ({type(exc).__name__}) — acceptable")
            continue

        verdict.scores[name] = score
        if score >= ceiling:
            verdict.sealable = False
            verdict.reasons.append(
                f"{name}: scored {score:.4f}, at or above the {ceiling} ceiling for a "
                f"predictor that does no work. An evaluator that rates a constant "
                f"prediction this highly is not measuring the task, and every "
                f"comparison made with it is wrong in the same direction. "
                f"A trivial all-ones predictor scored 0.947 on this corpus and the "
                f"evaluator that said so was sealed."
            )

    if not verdict.scores and not verdict.reasons:
        verdict.sealable = False
        verdict.reasons.append(
            "no degenerate predictor was evaluated, so the gate did not run. "
            "Absence of a failure verdict is not evidence of integrity — an "
            "unrun gate must not report a pass."
        )
    return verdict
