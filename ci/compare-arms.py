#!/usr/bin/env python3
"""
ci/compare-arms.py -- compare arms that live in different report files.

ci/retier-report.py pairs the two arms inside one report, which is the right
shape when a matrix ran both. It is the wrong shape for a ladder: extending
sonnet -> haiku reuses the sonnet arm already measured rather than paying to
re-run it, so the two arms sit in different files.

Usage:

    python3 ci/compare-arms.py \\
        "haiku:ci/out/probe-haiku.json:haiku-medium" \\
        "sonnet:ci/out/role-probe.json:sonnet-medium"

The FIRST arm is the candidate; the SECOND is the baseline it must not regress
against. Statistics are imported from retier-report.py so there is one
implementation of Wilson and Fisher, checked by its --self-test.
"""

import json
import sys
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

_spec = spec_from_file_location("retier_report", Path(__file__).resolve().parent / "retier-report.py")
_rr = module_from_spec(_spec)
_spec.loader.exec_module(_rr)
wilson, fisher_two_sided = _rr.wilson, _rr.fisher_two_sided


def load_arm(descriptor):
    try:
        label, path, tier = descriptor.split(":", 2)
    except ValueError:
        raise SystemExit(f"bad descriptor {descriptor!r}; expected label:path:tier")
    records = [r for r in json.load(open(path))["records"] if r["tier"] == tier]
    if not records:
        raise SystemExit(f"no records for tier {tier!r} in {path}")
    k = sum(r["status"] == "correct" for r in records)
    cost = sum(r.get("cost_usd") or 0 for r in records)
    wall = sum((r.get("wall_ms") or 0) / 1000 for r in records)
    bad = sum(r["status"] in ("unparseable", "cli_error") for r in records)
    return {
        "label": label, "tier": tier, "k": k, "n": len(records), "bad": bad,
        "per_call": cost / len(records), "per_pass": cost / k if k else float("inf"),
        "sec": wall / len(records),
        # Per-case detail: a gate that fails in BOTH arms is a fixture bug, and
        # the whole point of pairing is to see that rather than read it as a
        # capability difference.
        "by_case": _by_case(records),
    }


def _by_case(records):
    out = {}
    for r in records:
        k, n = out.get(r["case_id"], (0, 0))
        out[r["case_id"]] = (k + (r["status"] == "correct"), n + 1)
    return out


def main(argv):
    if len(argv) < 2:
        raise SystemExit(__doc__)
    cand, base = load_arm(argv[0]), load_arm(argv[1])

    print(f"{'arm':<26}{'n':>5}{'pass':>6}{'acc':>8}{'95% CI (Wilson)':>20}{'$/call':>10}{'$/pass':>10}{'s/call':>9}")
    for a, tag in ((cand, "candidate"), (base, "baseline")):
        lo, hi = wilson(a["k"], a["n"])
        pp = f"${a['per_pass']:.4f}" if a["k"] else "n/a"
        print(f"{a['label'] + ' (' + tag + ')':<26}{a['n']:>5}{a['k']:>6}{a['k'] / a['n'] * 100:>7.1f}%"
              f"{'[' + f'{lo * 100:.1f}, {hi * 100:.1f}' + ']':>20}${a['per_call']:>9.4f}{pp:>10}{a['sec']:>9.1f}")

    p = fisher_two_sided(cand["k"], cand["n"] - cand["k"], base["k"], base["n"] - base["k"])
    delta = (cand["k"] / cand["n"] - base["k"] / base["n"]) * 100
    if p < 0.05 and delta < 0:
        verdict = "REGRESSION -- do not adopt"
    elif p < 0.05:
        verdict = "IMPROVEMENT"
    else:
        verdict = "no detectable difference -- retier holds"
    print(f"\n  delta {delta:+.1f}pp   Fisher exact p={p:.4f}   -> {verdict}")
    if cand["k"] and base["k"]:
        print(f"  cost: {(1 - cand['per_call'] / base['per_call']) * 100:+.1f}% per call, "
              f"{(1 - cand['per_pass'] / base['per_pass']) * 100:+.1f}% per PASSING attempt")
    for a in (cand, base):
        if a["bad"]:
            print(f"  ! {a['label']}: {a['bad']} unparseable/cli_error")

    shared = sorted(set(cand["by_case"]) & set(base["by_case"]))
    rows = [(c, cand["by_case"][c], base["by_case"][c]) for c in shared]
    broken = [r for r in rows if r[1][0] == 0 and r[2][0] == 0]
    diff = [r for r in rows if r[1][0] != r[2][0] and r not in broken]
    if broken:
        print("\n  cases failing in BOTH arms (fixture bug, not a capability difference):")
        for c, (k1, n1), (k2, n2) in broken:
            print(f"    {c:<38}{cand['label']}={k1}/{n1}  {base['label']}={k2}/{n2}")
    if diff:
        print("\n  cases where the arms differ:")
        for c, (k1, n1), (k2, n2) in sorted(diff, key=lambda r: r[1][0] - r[2][0]):
            print(f"    {c:<38}{cand['label']}={k1}/{n1}  {base['label']}={k2}/{n2}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
