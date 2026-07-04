#!/usr/bin/env python3
"""
score_researcher.py — validate Sage researcher output structure and flag unverifiable citations.

Checks:
  1. Output is well-formed (has "findings" key, is a list)
  2. Each finding has required fields: title, source_url, finding, confidence, trust_level
  3. source_url is non-empty for every finding
  4. confidence values are valid ("high", "medium", "low")
  5. No hedged language ("might", "could", "may") in finding fields

Honest flags:
  - Any finding is marked "unverifiable_by_scorer" because the scorer cannot
    do live URL resolution. Citation verification requires academic MCPs or
    WebSearch in the run environment. This is expected and correct behavior.

PASS criteria: output is well-formed + all required fields present.
Unverifiable citations are flagged but do NOT cause a FAIL.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


REQUIRED_FIELDS = {"title", "source_url", "finding", "confidence", "trust_level"}
VALID_CONFIDENCE = {"high", "medium", "low"}
VALID_TRUST_LEVEL = {"authoritative", "indicative"}
HEDGE_PATTERN = re.compile(r"\b(might|could|may|possibly|perhaps|likely|probably)\b", re.IGNORECASE)


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


def check_finding(finding: dict, idx: int) -> dict:
    """Validate a single finding; return {issues, unverifiable, warnings}."""
    issues: list[str] = []
    warnings: list[str] = []

    # Required fields
    for field in REQUIRED_FIELDS:
        if field not in finding or not finding[field]:
            issues.append(f"missing or empty required field: '{field}'")

    # source_url must be non-empty
    source_url = finding.get("source_url", "")
    if not source_url:
        issues.append("source_url is empty")

    # confidence valid values
    confidence = finding.get("confidence", "")
    if confidence not in VALID_CONFIDENCE:
        issues.append(f"confidence='{confidence}' not in {VALID_CONFIDENCE}")

    # trust_level
    trust_level = finding.get("trust_level", "")
    if trust_level and trust_level not in VALID_TRUST_LEVEL:
        warnings.append(f"trust_level='{trust_level}' not in {VALID_TRUST_LEVEL}")

    # Hedged language in finding field
    finding_text = finding.get("finding", "")
    hedge_matches = HEDGE_PATTERN.findall(finding_text)
    if hedge_matches:
        warnings.append(
            f"hedged language in 'finding' field: {hedge_matches} — "
            "Sage mandate prohibits 'might', 'could', 'may'"
        )

    # All citations are unverifiable by the scorer (no live URL resolution)
    unverifiable = bool(source_url)  # True if there's a URL to potentially check

    return {
        "finding_index":       idx,
        "title":               finding.get("title", "")[:80],
        "source_url":          source_url[:100] if source_url else "",
        "confidence":          confidence,
        "trust_level":         trust_level,
        "issues":              issues,
        "warnings":            warnings,
        "unverifiable_by_scorer": unverifiable,
        "unverifiable_reason": (
            "scorer cannot perform live URL resolution; "
            "citation verification requires academic MCPs / WebSearch in run env"
            if unverifiable else ""
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Score Sage researcher output")
    parser.add_argument("--input", required=True, help="Claude JSON output from researcher_eval.sh")
    parser.add_argument("--out",   required=True, help="Output report JSON path")
    args = parser.parse_args()

    raw = json.loads(Path(args.input).read_text())
    text = extract_result_text(raw)
    data = parse_json(text)

    # ── Check 1: has "findings" key ──────────────────────────────────────────
    if "findings" not in data:
        report = {
            "passed": False,
            "issues": ["output missing 'findings' key — not well-formed Sage output"],
            "findings_checked": [],
        }
        Path(args.out).write_text(json.dumps(report, indent=2))
        print("RESULT: FAIL — output is not well-formed (missing 'findings' key)")
        sys.exit(1)

    findings = data.get("findings", [])
    if not isinstance(findings, list):
        report = {
            "passed": False,
            "issues": [f"'findings' is not a list (got {type(findings).__name__})"],
            "findings_checked": [],
        }
        Path(args.out).write_text(json.dumps(report, indent=2))
        print("RESULT: FAIL — 'findings' is not a list")
        sys.exit(1)

    # ── Check each finding ───────────────────────────────────────────────────
    finding_results = [check_finding(f, i) for i, f in enumerate(findings)]

    structural_issues = [
        fr for fr in finding_results if fr["issues"]
    ]
    all_issues = [
        f"finding[{fr['finding_index']}] '{fr['title']}': {'; '.join(fr['issues'])}"
        for fr in structural_issues
    ]
    all_warnings = [
        f"finding[{fr['finding_index']}] '{fr['title']}': {'; '.join(fr['warnings'])}"
        for fr in finding_results if fr["warnings"]
    ]

    unverifiable_count = sum(1 for fr in finding_results if fr["unverifiable_by_scorer"])

    assertions = {
        "output_well_formed": True,
        "findings_is_list": True,
        "all_required_fields_present": len(structural_issues) == 0,
    }

    report = {
        "findings_count":      len(findings),
        "findings_checked":    finding_results,
        "structural_issues":   all_issues,
        "warnings":            all_warnings,
        "unverifiable_count":  unverifiable_count,
        "unverifiable_note":   (
            f"{unverifiable_count}/{len(findings)} citations cannot be verified by this scorer. "
            "Verification requires academic MCPs (Consensus) or WebSearch in the run environment. "
            "This is EXPECTED — the scorer flags them as unverifiable rather than assuming real."
        ),
        "wiki_hits":           data.get("wiki_hits", []),
        "fallback_used":       data.get("fallback_used", "unknown"),
        "assertions":          assertions,
        "passed":              all(assertions.values()),
        "cost_usd":            raw.get("total_cost_usd"),
    }

    Path(args.out).write_text(json.dumps(report, indent=2))

    print(f"\n=== Researcher Score Report ===")
    print(f"Findings returned: {len(findings)}")
    print(f"Unverifiable by scorer: {unverifiable_count}/{len(findings)} "
          "(expected — no live URL resolution)")
    if all_warnings:
        print(f"Warnings ({len(all_warnings)}):")
        for w in all_warnings:
            print(f"  [WARN] {w}")
    if all_issues:
        print(f"Structural issues ({len(all_issues)}):")
        for issue in all_issues:
            print(f"  [FAIL] {issue}")
    print()
    for name, result in assertions.items():
        print(f"  [{'PASS' if result else 'FAIL'}] {name}")
    print()
    if report["passed"]:
        print("RESULT: PASS — Sage output is well-formed")
        print(f"NOTE: {unverifiable_count} citation(s) flagged as unverifiable by scorer "
              "(not a failure; tool verification is a run-env concern)")
    else:
        print("RESULT: FAIL — Sage output has structural issues")
        sys.exit(1)


if __name__ == "__main__":
    main()
