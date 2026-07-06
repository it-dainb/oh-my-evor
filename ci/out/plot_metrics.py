"""Metrics-evolution plot for an Evor run: metrics per candidate (recording order)
+ best-so-far envelope + baseline. Grows into a per-tick evolution curve as ticks accrue."""
import json, sys
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

rd = Path(sys.argv[1])
out = sys.argv[2]
baseline = float(sys.argv[3]) if len(sys.argv) > 3 else None

tree = json.loads((rd / "tree.json").read_text())
nodes = [n for n in tree.get("nodes", {}).values() if n.get("metrics")]
nodes.sort(key=lambda n: (n.get("created_at") or "", n.get("id") or ""))

MET = [
    ("test_top1_restricted", "test top-1 (primary)", "#1f77b4"),
    ("test_top5_restricted", "test top-5", "#2ca02c"),
    ("mean_class_accuracy", "mean-class acc", "#ff7f0e"),
    ("worst_domain_top1", "worst-domain (guard)", "#d62728"),
]

fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(9.5, 7.5), gridspec_kw={"height_ratios": [2.2, 1]})

if not nodes:
    ax1.text(0.5, 0.5, "no scored candidates yet", ha="center", va="center", transform=ax1.transAxes)
else:
    xs = list(range(1, len(nodes) + 1))
    for key, label, col in MET:
        ys = [n["metrics"].get(key) for n in nodes]
        if any(v is not None for v in ys):
            ax1.plot(xs, ys, marker="o", ms=5, color=col, label=label)
    # best-so-far on the primary metric
    prim = [n["metrics"].get("test_top1_restricted") for n in nodes]
    best, b = [], -1.0
    for v in prim:
        if v is not None and v > b:
            b = v
        best.append(b if b >= 0 else None)
    ax1.plot(xs, best, color="black", lw=2.2, ls=":", label="best-so-far (primary)")
    if baseline is not None:
        ax1.axhline(baseline, ls="--", color="gray", lw=1.5, label=f"baseline {baseline:.3f}")
    ax1.set_xticks(xs)
    ax1.set_xlabel("candidate (recording order → ticks)")
    ax1.set_ylabel("score")
    ax1.set_title(f"Evor — metric evolution  ({len(nodes)} candidates, best primary={max([p for p in prim if p is not None], default=0):.3f})")
    ax1.legend(fontsize=8, ncol=2, loc="lower right")
    ax1.grid(alpha=0.3)

    # bottom: primary score by approach family (which strategies are winning)
    fam_col = {}
    palette = plt.cm.tab10.colors
    for n in nodes:
        f = n.get("approach_family", "?")
        fam_col.setdefault(f, palette[len(fam_col) % 10])
    for x, n in zip(xs, nodes):
        f = n.get("approach_family", "?")
        y = n["metrics"].get("test_top1_restricted")
        ax2.bar(x, y, color=fam_col[f], width=0.7)
        ax2.annotate(f[:9], (x, y or 0), ha="center", va="bottom", fontsize=7, rotation=0)
    if baseline is not None:
        ax2.axhline(baseline, ls="--", color="gray", lw=1.2)
    ax2.set_xticks(xs)
    ax2.set_xlabel("candidate")
    ax2.set_ylabel("primary top-1")
    ax2.set_title("primary score by approach family")
    ax2.grid(alpha=0.3, axis="y")

fig.tight_layout()
fig.savefig(out, dpi=120, bbox_inches="tight")
print("wrote", out)
