#!/usr/bin/env python3
"""
ci/retier-report.py -- turn the per-role matrices into a regression verdict.

Each evals/<role>/spec.json declares two arms that differ only in model tier.
This reads the reports those matrices wrote and answers one question per role:
does the cheaper arm regress against the tier it replaced?

"No regression" is a claim about an interval, not a point. A 27/30 vs 29/30
split is not evidence of anything at n=30, and reporting it as "-6.7pp" invites
exactly the conclusion the numbers cannot support. So every accuracy carries a
Wilson score interval, and the arms are compared with an exact Fisher test
rather than a normal approximation that is unreliable at these cell counts.

Cost is reported per PASSING attempt, not per call. A tier that is 40% cheaper
per call and fails a third of the time is not cheaper -- the retry is part of
the price.
"""

import json
import math
import sys
from glob import glob
from math import comb
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


def wilson(k, n, z=1.96):
    """Wilson score interval. Degrades sanely at k=0 and k=n, unlike Wald."""
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    d = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / d
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, centre - half), min(1.0, centre + half))


def fisher_two_sided(a, b, c, d):
    """
    Exact two-sided Fisher test on [[a, b], [c, d]].

    Sums the probability of every table at least as extreme as the observed one,
    with the margins held fixed. Two-sided is defined by probability mass rather
    than by doubling one tail, which is the convention that stays correct on
    lopsided margins.
    """
    n = a + b + c + d
    if n == 0:
        return 1.0
    row1, col1 = a + b, a + c

    def prob(x):
        return comb(row1, x) * comb(n - row1, col1 - x) / comb(n, col1)

    observed = prob(a)
    lo = max(0, col1 - (n - row1))
    hi = min(row1, col1)
    # 1e-9 absorbs float error, so a table with identical probability to the
    # observed one is not excluded by a last-bit difference.
    return min(1.0, sum(prob(x) for x in range(lo, hi + 1) if prob(x) <= observed * (1 + 1e-9)))


def self_test():
    """
    `python3 ci/retier-report.py --self-test`

    The two statistics below are the whole basis of the no-regression claim, so
    they are checked rather than trusted. Fisher is cross-checked against scipy
    when it is installed and against the classic tea-tasting table when it is
    not; Wilson is checked at k=0 and k=n, where the Wald interval it replaces
    collapses to a point and would assert certainty from 30 samples.
    """
    import random

    failures = []
    try:
        from scipy.stats import fisher_exact

        random.seed(7)
        worst = 0.0
        for _ in range(500):
            a, b, c, d = (random.randint(0, 30) for _ in range(4))
            if a + b == 0 or c + d == 0 or a + c == 0 or b + d == 0:
                continue
            worst = max(worst, abs(fisher_two_sided(a, b, c, d) - fisher_exact([[a, b], [c, d]])[1]))
        print(f"fisher vs scipy over 500 random tables: max abs error {worst:.2e}")
        if worst > 1e-9:
            failures.append("fisher disagrees with scipy")
    except ImportError:
        got = fisher_two_sided(1, 9, 11, 3)
        print(f"scipy absent; tea-tasting table [[1,9],[11,3]] -> {got:.6f} (known 0.002759)")
        if abs(got - 0.0027594) > 1e-5:
            failures.append("fisher disagrees with the known tea-tasting value")

    for k, n, want_lo, want_hi in ((0, 30, 0.0, None), (30, 30, None, 1.0)):
        lo, hi = wilson(k, n)
        print(f"wilson({k}/{n}) = [{lo:.4f}, {hi:.4f}]")
        if want_lo is not None and lo != want_lo:
            failures.append(f"wilson({k}/{n}) lower bound {lo} != {want_lo}")
        if want_hi is not None and hi != want_hi:
            failures.append(f"wilson({k}/{n}) upper bound {hi} != {want_hi}")
        if lo == hi:
            failures.append(f"wilson({k}/{n}) collapsed to a point")

    # The case this report exists to keep honest: 27/30 vs 29/30 looks like a
    # 6.7pp regression and is not distinguishable from noise.
    lo27, hi27 = wilson(27, 30)
    lo29, hi29 = wilson(29, 30)
    p = fisher_two_sided(27, 3, 29, 1)
    print(f"27/30 [{lo27:.3f},{hi27:.3f}] vs 29/30 [{lo29:.3f},{hi29:.3f}] -> p={p:.3f}")
    if p < 0.05:
        failures.append("27/30 vs 29/30 was called significant; the test is too permissive")

    print("SELF-TEST FAILED: " + "; ".join(failures) if failures else "SELF-TEST OK")
    return 1 if failures else 0


def load_reports():
    """
    Collect the matrix reports, whichever naming convention they landed under.

    Two things this must not do. It must not pick up a diagnostic or smoke run
    -- those are single-tier and single-case by construction, and averaging one
    into a role's numbers would quietly corrupt the verdict. And when a role has
    more than one report on disk it must not silently choose; it keeps the one
    with the most records and says so.
    """
    best = {}
    paths = set(glob(str(REPO / "ci/out/*-report.json"))) | set(glob(str(REPO / "ci/out/role-*.json")))
    for path in sorted(paths):
        name = Path(path).name
        if any(s in name for s in ("diag", "smoke", "bench-tick")):
            continue
        try:
            r = json.load(open(path))
        except json.JSONDecodeError:
            print(f"  ! {name} is not valid JSON (run still writing?)", file=sys.stderr)
            continue
        if not (r.get("role") and r.get("records")):
            continue
        role = r["role"]
        if role in best and len(best[role][1]["records"]) >= len(r["records"]):
            print(f"  ! ignoring {name}: {best[role][0]} has more records for {role}", file=sys.stderr)
            continue
        if role in best:
            print(f"  ! ignoring {best[role][0]}: {name} has more records for {role}", file=sys.stderr)
        best[role] = (name, r)
    return [best[k] for k in sorted(best)]


def summarise(records):
    """Per-tier: n, passes, unparseables, total modelled and billed cost."""
    tiers = {}
    for rec in records:
        t = tiers.setdefault(
            rec["tier"], {"n": 0, "k": 0, "unparseable": 0, "cli_error": 0, "cost": 0.0, "billed": 0.0, "wall": 0.0}
        )
        t["n"] += 1
        t["k"] += rec["status"] == "correct"
        t["unparseable"] += rec["status"] == "unparseable"
        t["cli_error"] += rec["status"] == "cli_error"
        t["cost"] += rec.get("cost_usd") or 0.0
        t["billed"] += rec.get("cli_cost_usd") or 0.0
        t["wall"] += (rec.get("wall_ms") or 0) / 1000.0
    return tiers


def load_spec_arms():
    """role -> [current_tier, pre_retier_tier], taken from the spec's arm order."""
    arms = {}
    for path in sorted(glob(str(REPO / "evals/*/spec.json"))):
        s = json.load(open(path))
        if s.get("role") and s.get("arms"):
            arms[s["role"]] = [f"{a['model']}-{a['effort']}" for a in s["arms"]]
    return arms


def main():
    spec_arms = load_spec_arms()
    reports = load_reports()
    if not reports:
        print("no role reports found in ci/out/ -- nothing to analyse")
        return 1

    print("=" * 96)
    print("RETIER REGRESSION REPORT -- cheaper arm vs the tier it replaced")
    print("=" * 96)

    verdicts = []
    for name, rep in reports:
        role = rep["role"]
        recs = rep["records"]
        tiers = summarise(recs)
        # The spec's first arm is the current (cheaper) tier; the second is the
        # main-branch tier it replaced.
        # Which arm is "current" comes from the spec, never from the report.
        # buildReport does not carry the arms through, and falling back to
        # sorted() orders them alphabetically -- which put opus before sonnet
        # and labelled the pre-retier arm as the current one. A cost saving
        # printed with the arms swapped reads as a cost increase.
        arms = spec_arms.get(role)
        if not arms:
            print(f"\n### {role}  -- SKIPPED: no evals/*/spec.json declares this role, "
                  f"so which arm is current cannot be established")
            continue
        order = [t for t in arms if t in tiers]
        if len(order) < 2:
            print(f"\n### {role}  -- INCOMPLETE: only {order or list(tiers)} present, cannot compare")
            continue
        cur, base = order[0], order[1]
        C, B = tiers[cur], tiers[base]

        print(f"\n### {role}   ({name})")
        print(f"{'arm':<22}{'n':>5}{'pass':>6}{'acc':>8}{'95% CI (Wilson)':>22}{'$/call':>10}{'$/pass':>10}{'s/call':>9}")
        for label, t, tag in ((cur, C, "current"), (base, B, "pre-retier")):
            lo, hi = wilson(t["k"], t["n"])
            per_call = t["cost"] / t["n"] if t["n"] else 0
            per_pass = t["cost"] / t["k"] if t["k"] else float("inf")
            pp = f"${per_pass:.4f}" if t["k"] else "n/a"
            print(
                f"{label + ' (' + tag + ')':<22}{t['n']:>5}{t['k']:>6}"
                f"{t['k'] / t['n'] * 100 if t['n'] else 0:>7.1f}%"
                f"{'[' + f'{lo * 100:.1f}' + ', ' + f'{hi * 100:.1f}' + ']':>22}"
                f"{'$' + f'{per_call:.4f}':>10}{pp:>10}{t['wall'] / t['n'] if t['n'] else 0:>9.1f}"
            )

        p = fisher_two_sided(C["k"], C["n"] - C["k"], B["k"], B["n"] - B["k"])
        delta = (C["k"] / C["n"] - B["k"] / B["n"]) * 100 if C["n"] and B["n"] else 0
        saving = (1 - (C["cost"] / C["n"]) / (B["cost"] / B["n"])) * 100 if B["n"] and B["cost"] else 0
        pass_saving = (
            (1 - (C["cost"] / C["k"]) / (B["cost"] / B["k"])) * 100 if C["k"] and B["k"] and B["cost"] else None
        )

        if p < 0.05 and delta < 0:
            v = "REGRESSION"
        elif p < 0.05 and delta > 0:
            v = "IMPROVEMENT"
        else:
            v = "no detectable difference"
        verdicts.append((role, v, delta, p, saving, pass_saving, C, B))

        print(f"  delta {delta:+.1f}pp   Fisher exact p={p:.3f}   -> {v}")
        print(
            f"  cost:  {saving:+.1f}% per call, "
            + (f"{pass_saving:+.1f}% per PASSING attempt" if pass_saving is not None else "per-pass n/a")
        )
        for label, t in ((cur, C), (base, B)):
            if t["unparseable"] or t["cli_error"]:
                print(f"  ! {label}: {t['unparseable']} unparseable, {t['cli_error']} cli_error")

    print("\n" + "=" * 96)
    print("SUMMARY")
    print("=" * 96)
    print(f"{'role':<26}{'verdict':<28}{'delta':>9}{'p':>8}{'$/call':>10}{'$/pass':>10}")
    for role, v, delta, p, saving, pass_saving, C, B in verdicts:
        ps = f"{pass_saving:+.0f}%" if pass_saving is not None else "n/a"
        print(f"{role:<26}{v:<28}{delta:>+8.1f}p{p:>8.3f}{saving:>9.0f}%{ps:>10}")

    regressions = [r for r in verdicts if r[1] == "REGRESSION"]
    print(
        f"\n{len(verdicts)} roles compared, {len(regressions)} regression(s) at p<0.05: "
        + (", ".join(r[0] for r in regressions) if regressions else "none")
    )
    total_cur = sum(v[6]["billed"] for v in verdicts)
    total_base = sum(v[7]["billed"] for v in verdicts)
    print(f"billed across the whole matrix: ${total_cur + total_base:.2f} "
          f"(current arms ${total_cur:.2f}, pre-retier arms ${total_base:.2f})")
    return 0


if __name__ == "__main__":
    sys.exit(self_test() if "--self-test" in sys.argv else main())
