#!/usr/bin/env python3
"""
score_cross_domain.py — assert >= 1 genuine A->B cross-domain transfer in Dreamer output.

Each proposal must carry:
  transferred_from:         source domain / technique (must differ from "text"/"text-classification")
  into_our_domain:          true (boolean)
  why_researcher_enabled_it: non-empty explanation string

The scorer verifies that at least one proposal has all three fields with
non-trivial values AND that transferred_from != "text" (proving it really
came from a different domain).
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


def extract_result_text(claude_output: dict) -> str:
    if claude_output.get("is_error"):
        raise SystemExit(
            f"Claude returned an error: {claude_output.get('result', '(no detail)')}"
        )
    result = claude_output.get("result", "")
    return result if isinstance(result, str) else json.dumps(result)


def parse_json(text: str) -> dict:
    text = text.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    fence = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if fence:
        try:
            return json.loads(fence.group(1))
        except json.JSONDecodeError:
            pass
    brace = re.search(r"\{.*\}", text, re.DOTALL)
    if brace:
        try:
            return json.loads(brace.group(0))
        except json.JSONDecodeError:
            pass
    raise ValueError(f"Could not extract JSON: {text[:300]!r}")


_OUR_DOMAIN_TOKENS = frozenset({
    "text", "text-classification", "sentiment", "nlp", "language",
    "text_classification", "our-domain",
})


def _is_different_domain(transferred_from: str) -> bool:
    """True if transferred_from is not our domain (text classification)."""
    tf = transferred_from.lower().strip()
    # Must not be empty
    if not tf:
        return False
    # Must not be our own domain
    for token in _OUR_DOMAIN_TOKENS:
        if token in tf:
            return False
    return True


def evaluate_transfers(proposals: list[dict]) -> list[dict]:
    """Return list of proposals that qualify as genuine A->B transfers."""
    genuine = []
    for p in proposals:
        tf = p.get("transferred_from", "")
        into_ours = p.get("into_our_domain", False)
        why = p.get("why_researcher_enabled_it", "")

        if (
            tf                              # non-empty
            and into_ours is True           # explicit True
            and why                         # non-empty explanation
            and len(why.strip()) > 10       # not just a placeholder
            and _is_different_domain(tf)    # actually from a different domain
        ):
            genuine.append({
                "proposal_id":             p.get("proposal_id", "unknown"),
                "approach_family":         p.get("approach_family", ""),
                "transferred_from":        tf,
                "into_our_domain":         into_ours,
                "why_researcher_enabled_it": why,
                "idea_snippet":            p.get("idea", "")[:120],
            })
    return genuine


def main() -> None:
    parser = argparse.ArgumentParser(description="Score cross-domain transfer loop")
    parser.add_argument("--input", required=True, help="Claude JSON output from cross_domain_eval.sh")
    parser.add_argument("--out",   required=True, help="Output report JSON path")
    args = parser.parse_args()

    raw = json.loads(Path(args.input).read_text())
    text = extract_result_text(raw)
    data = parse_json(text)
    proposals = data.get("proposals", [])

    genuine_transfers = evaluate_transfers(proposals)

    assertions = {
        "at_least_one_genuine_transfer": len(genuine_transfers) >= 1,
    }

    report = {
        "total_proposals":    len(proposals),
        "genuine_transfers":  genuine_transfers,
        "transfer_count":     len(genuine_transfers),
        "assertions":         assertions,
        "passed":             all(assertions.values()),
        "cost_usd":           raw.get("total_cost_usd"),
    }

    Path(args.out).write_text(json.dumps(report, indent=2))

    print(f"\n=== Cross-Domain Transfer Score ===")
    print(f"Total proposals: {len(proposals)}")
    print(f"Genuine A->B transfers: {len(genuine_transfers)}")
    for t in genuine_transfers:
        print(f"  - [{t['proposal_id']}] {t['transferred_from']} -> our domain")
        print(f"    why: {t['why_researcher_enabled_it'][:100]}")
    print()

    for name, result in assertions.items():
        print(f"  [{'PASS' if result else 'FAIL'}] {name}")

    print()
    if report["passed"]:
        print("RESULT: PASS — at least one genuine cross-domain transfer confirmed")
    else:
        print("RESULT: FAIL — no genuine A->B transfer found")
        print("  Expected: transferred_from != our domain, into_our_domain=true, "
              "why_researcher_enabled_it non-empty")
        sys.exit(1)


if __name__ == "__main__":
    main()
