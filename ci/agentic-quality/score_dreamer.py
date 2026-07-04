#!/usr/bin/env python3
"""
score_dreamer.py — score Dreamer open-ended breadth and wildness-dial responsiveness.

Measures:
  - distinct_angle_count:   number of unique "angle" labels across proposals
  - invented_beyond_list:   proposals with in_provided_list=false (genuinely new angles)
  - family_diversity:       distinct approach_family values
  - novelty_distribution:   {obvious, moderate, breakthrough} by wildness field

Assertions (both must pass for PASS):
  1. At high wildness (0.9):  distinct_angles >= 8  AND  invented_beyond_list >= 2
  2. Wildness contrast:       breakthrough(0.9) > breakthrough(0.2)
     AND cross_domain(0.9) > cross_domain(0.2)
     where breakthrough = proposals with wildness >= 0.7, cross_domain = same

NOTE: does NOT score against the 6 approach_family taxonomy. The angle space is open-ended.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


# ─────────────────────────────────────────────────────────────────────────────
# JSON extraction from Claude --output-format json
# ─────────────────────────────────────────────────────────────────────────────

def extract_result_text(claude_output: dict) -> str:
    """Extract the model's response text from Claude's JSON envelope."""
    if claude_output.get("is_error"):
        raise SystemExit(
            f"Claude returned an error: {claude_output.get('result', '(no detail)')}"
        )
    result = claude_output.get("result", "")
    if not isinstance(result, str):
        # Some output formats nest under subkeys
        result = json.dumps(result)
    return result


def parse_proposals_json(text: str) -> dict:
    """Parse proposals JSON from model output text.

    Handles:
      - Raw JSON object
      - JSON wrapped in ```json ... ``` code block
      - JSON embedded in prose (finds outermost { ... })
    """
    text = text.strip()

    # Try direct parse first
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Strip markdown code fence
    fence = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if fence:
        try:
            return json.loads(fence.group(1))
        except json.JSONDecodeError:
            pass

    # Find outermost JSON object
    brace = re.search(r"\{.*\}", text, re.DOTALL)
    if brace:
        try:
            return json.loads(brace.group(0))
        except json.JSONDecodeError:
            pass

    raise ValueError(
        f"Could not extract JSON proposals from model output. "
        f"First 300 chars: {text[:300]!r}"
    )


# ─────────────────────────────────────────────────────────────────────────────
# Metrics
# ─────────────────────────────────────────────────────────────────────────────

_INSPIRATION_MENU = frozenset({
    "domain-transfer", "style-transfer", "attribute-editing",
    "concept-injection", "concept-removal", "semantic-expansion",
    "semantic-compression", "perspective-shift", "temporal-context",
    "resolution-scaling", "structural-topology", "identity-invariance",
    "physics-simulation", "composition-recombination", "narrative-grounding",
    "emotion-conditioning", "modality-bridging", "abstraction-level",
    "reasoning-chain", "knowledge-injection",
})


def compute_metrics(proposals: list[dict]) -> dict:
    angles = [p.get("angle", "") for p in proposals if p.get("angle")]
    distinct_angles = list(dict.fromkeys(angles))  # deduplicated, order-preserved

    # in_provided_list=false means angle was invented (not on the menu)
    invented = [
        p for p in proposals
        if not p.get("in_provided_list", True)
        and p.get("angle", "")
        and p["angle"].lower() not in _INSPIRATION_MENU
    ]
    # Also count any angle not in the menu regardless of the flag (belt-and-suspenders)
    invented_by_content = [
        p for p in proposals
        if p.get("angle", "").lower() not in _INSPIRATION_MENU
        and p.get("angle", "")
    ]
    # Use the more generous count (either flag or content)
    invented_count = max(len(invented), len(invented_by_content))

    families = list({p.get("approach_family", "") for p in proposals if p.get("approach_family")})

    def _novelty(ps: list[dict]) -> dict:
        w_vals = [p.get("wildness", 0.0) for p in ps]
        return {
            "obvious":      sum(1 for w in w_vals if w < 0.3),
            "moderate":     sum(1 for w in w_vals if 0.3 <= w < 0.7),
            "breakthrough": sum(1 for w in w_vals if w >= 0.7),
        }

    # cross_domain: same definition as breakthrough (wildness >= 0.7 means paradigm shift / cross-domain)
    cross_domain_count = sum(1 for p in proposals if p.get("wildness", 0) >= 0.7)

    return {
        "proposals_count":       len(proposals),
        "distinct_angle_count":  len(set(a.lower() for a in distinct_angles if a)),
        "distinct_angles":       distinct_angles,
        "invented_beyond_list":  invented_count,
        "invented_angle_labels": [p.get("angle", "") for p in invented_by_content],
        "family_diversity":      len(families),
        "distinct_families":     families,
        "novelty_distribution":  _novelty(proposals),
        "cross_domain_count":    cross_domain_count,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="Score Dreamer wildness-dial output")
    parser.add_argument("--w02", required=True, help="Path to wildness=0.2 Claude JSON output")
    parser.add_argument("--w09", required=True, help="Path to wildness=0.9 Claude JSON output")
    parser.add_argument("--out", required=True, help="Path for dreamer-report.json output")
    args = parser.parse_args()

    w02_raw = json.loads(Path(args.w02).read_text())
    w09_raw = json.loads(Path(args.w09).read_text())

    w02_text = extract_result_text(w02_raw)
    w09_text = extract_result_text(w09_raw)

    w02_data = parse_proposals_json(w02_text)
    w09_data = parse_proposals_json(w09_text)

    w02_proposals = w02_data.get("proposals", [])
    w09_proposals = w09_data.get("proposals", [])

    w02_metrics = compute_metrics(w02_proposals)
    w09_metrics = compute_metrics(w09_proposals)

    # ── Assertions ────────────────────────────────────────────────────────────
    # 1. High-wildness (0.9) breadth: distinct angles >= 8 AND invented >= 2
    assert_high_wildness_breadth = (
        w09_metrics["distinct_angle_count"] >= 8
        and w09_metrics["invented_beyond_list"] >= 2
    )

    # 2. Wildness contrast: breakthrough and cross-domain both higher at 0.9 than 0.2
    assert_breakthrough_contrast = (
        w09_metrics["novelty_distribution"]["breakthrough"]
        > w02_metrics["novelty_distribution"]["breakthrough"]
    )
    assert_cross_domain_contrast = (
        w09_metrics["cross_domain_count"] > w02_metrics["cross_domain_count"]
    )

    assertions = {
        "high_wildness_distinct_angles_ge8": w09_metrics["distinct_angle_count"] >= 8,
        "high_wildness_invented_beyond_list_ge2": w09_metrics["invented_beyond_list"] >= 2,
        "high_wildness_breadth_overall": assert_high_wildness_breadth,
        "breakthrough_0.9_gt_0.2": assert_breakthrough_contrast,
        "cross_domain_0.9_gt_0.2": assert_cross_domain_contrast,
    }

    report = {
        "w02": {**w02_metrics, "cost_usd": w02_raw.get("total_cost_usd")},
        "w09": {**w09_metrics, "cost_usd": w09_raw.get("total_cost_usd")},
        "assertions": assertions,
        "passed": all(assertions.values()),
    }

    Path(args.out).write_text(json.dumps(report, indent=2))

    # ── Human-readable summary ────────────────────────────────────────────────
    print(f"\n=== Dreamer Score Report ===")
    print(f"w=0.2: {w02_metrics['distinct_angle_count']} distinct angles, "
          f"{w02_metrics['invented_beyond_list']} invented, "
          f"breakthrough={w02_metrics['novelty_distribution']['breakthrough']}")
    print(f"w=0.9: {w09_metrics['distinct_angle_count']} distinct angles, "
          f"{w09_metrics['invented_beyond_list']} invented, "
          f"breakthrough={w09_metrics['novelty_distribution']['breakthrough']}")
    print(f"Invented angles (0.9): {w09_metrics['invented_angle_labels']}")
    print()

    for name, result in assertions.items():
        status = "PASS" if result else "FAIL"
        print(f"  [{status}] {name}")

    print()
    if report["passed"]:
        print("RESULT: PASS — Dreamer breadth and wildness-dial assertions satisfied")
    else:
        failed = [k for k, v in assertions.items() if not v]
        print(f"RESULT: FAIL — {len(failed)} assertion(s) failed: {failed}")
        sys.exit(1)


if __name__ == "__main__":
    main()
