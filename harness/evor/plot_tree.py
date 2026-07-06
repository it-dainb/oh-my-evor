"""
plot_tree.py — Evolution tree visualiser for Evor run reports.

Reads tree.json (DICT format: {"nodes": {"<id>": {...TreeNode...}}, "updated_at": "..."})
and renders an ASCII tree, a PNG (via matplotlib with text fallback), or a
self-contained static HTML file.

CLI usage (invoked by skills/evor-report/SKILL.md)::

    python -m evor.plot_tree \\
        --run-id <run_id_or_run_dir> \\
        --run-dir <run_dir> \\         # optional — inferred from run-id if absent
        --format ascii|png|html \\
        --output <path> \\             # required for png/html
        --highlight-frontier \\
        --include-frontier-table \\    # html only
        --include-lessons \\           # html only
        --include-strategy-summary     # html only
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────


def _load_tree(run_dir: Path) -> dict[str, Any]:
    """Load tree.json as a dict of {node_id: node_dict}.

    Expects DICT format: {"nodes": {"<id>": {...TreeNode...}}, "updated_at": "..."}
    written by mcp/src/tree-store.ts::writeTree().
    """
    tree_path = run_dir / "tree.json"
    if not tree_path.exists():
        return {}
    data = json.loads(tree_path.read_text())
    nodes_val = data.get("nodes", {})
    if not isinstance(nodes_val, dict):
        return {}
    return nodes_val


def _load_run_state(run_dir: Path) -> dict[str, Any]:
    rs_path = run_dir / "run-state.json"
    if not rs_path.exists():
        return {}
    try:
        return json.loads(rs_path.read_text())
    except Exception:
        return {}


def _short_id(node_id: str, length: int = 8) -> str:
    return node_id[:length]


# ─────────────────────────────────────────────────────────────────────────────
# ASCII renderer
# ─────────────────────────────────────────────────────────────────────────────


def _render_ascii(
    nodes: dict[str, Any],
    frontier_ids: set[str],
    highlight_frontier: bool,
) -> str:
    """Render the evolution tree as ASCII lines."""
    if not nodes:
        return "(empty tree — no nodes yet)"

    # Build parent → children map
    children: dict[str, list[str]] = {nid: [] for nid in nodes}
    roots: list[str] = []
    for nid, node in nodes.items():
        parent_ids = node.get("parent_ids") or []
        if not parent_ids:
            roots.append(nid)
        else:
            for pid in parent_ids:
                if pid in children:
                    children[pid].append(nid)

    if not roots:
        # Fallback: treat all nodes as roots (cycle or detached)
        roots = list(nodes.keys())

    lines: list[str] = []

    def _visit(nid: str, prefix: str, is_last: bool) -> None:
        node = nodes[nid]
        connector = "└── " if is_last else "├── "
        fam = node.get("approach_family", "?")
        score = node.get("fitness_value")
        score_str = f"{score:.4f}" if score is not None else "n/a"
        ev = node.get("eval_version", "?")
        integrity = node.get("integrity_status", "?")
        status = node.get("status", "?")
        marker = " [FRONTIER]" if (highlight_frontier and nid in frontier_ids) else ""
        lines.append(
            f"{prefix}{connector}{_short_id(nid)}  "
            f"family={fam}  score={score_str}  "
            f"ev={ev}  integrity={integrity}  status={status}{marker}"
        )
        ext = "    " if is_last else "│   "
        kids = children.get(nid, [])
        for i, kid in enumerate(kids):
            _visit(kid, prefix + ext, i == len(kids) - 1)

    for i, root in enumerate(roots):
        _visit(root, "", i == len(roots) - 1)

    return "\n".join(lines)


# ─────────────────────────────────────────────────────────────────────────────
# PNG renderer (matplotlib, with text fallback)
# ─────────────────────────────────────────────────────────────────────────────


def _render_png(
    nodes: dict[str, Any],
    frontier_ids: set[str],
    output_path: Path,
    highlight_frontier: bool,
) -> None:
    """Render tree as PNG.  Falls back to a text representation if matplotlib is unavailable."""
    try:
        import matplotlib  # noqa: F401
        _render_png_matplotlib(nodes, frontier_ids, output_path, highlight_frontier)
    except ImportError:
        _render_png_text_fallback(nodes, frontier_ids, output_path, highlight_frontier)


def _render_png_matplotlib(
    nodes: dict[str, Any],
    frontier_ids: set[str],
    output_path: Path,
    highlight_frontier: bool,
) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import matplotlib.patches as mpatches

    if not nodes:
        fig, ax = plt.subplots(figsize=(6, 2))
        ax.text(0.5, 0.5, "(empty tree)", ha="center", va="center", fontsize=12)
        ax.axis("off")
        output_path.parent.mkdir(parents=True, exist_ok=True)
        fig.savefig(str(output_path), dpi=120, bbox_inches="tight")
        plt.close(fig)
        return

    # Assign y-levels by depth, x-positions within each depth
    depth_map: dict[str, int] = {}
    parent_map: dict[str, str | None] = {}
    for nid, node in nodes.items():
        d = node.get("depth", 0)
        depth_map[nid] = d
        pids = node.get("parent_ids") or []
        parent_map[nid] = pids[0] if pids else None

    by_depth: dict[int, list[str]] = {}
    for nid, d in depth_map.items():
        by_depth.setdefault(d, []).append(nid)
    max_depth = max(by_depth.keys()) if by_depth else 0

    pos: dict[str, tuple[float, float]] = {}
    for d, nids in by_depth.items():
        for i, nid in enumerate(sorted(nids)):
            x = i - len(nids) / 2.0
            y = -d
            pos[nid] = (x, y)

    fig_w = max(8, len(nodes) * 1.2)
    fig_h = max(4, (max_depth + 1) * 1.5)
    fig, ax = plt.subplots(figsize=(fig_w, fig_h))

    # Draw edges
    for nid, (x, y) in pos.items():
        pid = parent_map.get(nid)
        if pid and pid in pos:
            px, py = pos[pid]
            ax.plot([px, x], [py, y], "k-", lw=0.8, alpha=0.4)

    # Draw nodes
    for nid, (x, y) in pos.items():
        node = nodes[nid]
        fam = node.get("approach_family", "other")
        score = node.get("fitness_value")
        is_frontier = highlight_frontier and nid in frontier_ids
        color = "gold" if is_frontier else "#7ec8e3"
        ec = "red" if is_frontier else "steelblue"
        circle = mpatches.FancyBboxPatch(
            (x - 0.4, y - 0.2), 0.8, 0.4,
            boxstyle="round,pad=0.05",
            facecolor=color, edgecolor=ec, linewidth=1.5,
        )
        ax.add_patch(circle)
        label = f"{_short_id(nid)}\n{fam}\n{score:.3f}" if score is not None else f"{_short_id(nid)}\n{fam}"
        ax.text(x, y, label, ha="center", va="center", fontsize=6)

    ax.autoscale()
    ax.axis("off")
    ax.set_title("Evor Evolution Tree", fontsize=10)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(str(output_path), dpi=120, bbox_inches="tight")
    plt.close(fig)
    print(f"[evor.plot_tree] PNG written to {output_path}", file=sys.stderr)


def _render_png_text_fallback(
    nodes: dict[str, Any],
    frontier_ids: set[str],
    output_path: Path,
    highlight_frontier: bool,
) -> None:
    """Write an ASCII text file as fallback when matplotlib is not installed."""
    ascii_text = _render_ascii(nodes, frontier_ids, highlight_frontier)
    # Write as .txt alongside the requested .png path
    txt_path = output_path.with_suffix(".txt")
    txt_path.parent.mkdir(parents=True, exist_ok=True)
    txt_path.write_text(ascii_text)
    print(
        f"[evor.plot_tree] matplotlib not available — ASCII tree written to {txt_path}",
        file=sys.stderr,
    )


# ─────────────────────────────────────────────────────────────────────────────
# HTML renderer
# ─────────────────────────────────────────────────────────────────────────────


def _render_html(
    nodes: dict[str, Any],
    frontier_ids: set[str],
    output_path: Path,
    run_dir: Path,
    highlight_frontier: bool,
    include_frontier_table: bool,
    include_lessons: bool,
    include_strategy_summary: bool,
) -> None:
    """Render a self-contained static HTML report."""
    ascii_tree = _render_ascii(nodes, frontier_ids, highlight_frontier)

    # Frontier table
    frontier_table_html = ""
    if include_frontier_table:
        rows = []
        for rank, fid in enumerate(sorted(frontier_ids), 1):
            node = nodes.get(fid, {})
            score = node.get("fitness_value", "n/a")
            fam = node.get("approach_family", "?")
            ev = node.get("eval_version", "?")
            integrity = node.get("integrity_status", "?")
            rows.append(
                f"<tr><td>{rank}</td><td>{_short_id(fid)}</td><td>{fam}</td>"
                f"<td>{score}</td><td>{ev}</td><td>{integrity}</td></tr>"
            )
        if rows:
            frontier_table_html = (
                "<h2>Frontier Nodes</h2>"
                "<table border='1' cellpadding='4'>"
                "<tr><th>Rank</th><th>Node</th><th>Family</th>"
                "<th>Score</th><th>Eval Version</th><th>Integrity</th></tr>"
                + "".join(rows)
                + "</table>"
            )

    # Strategy summary
    strategy_html = ""
    if include_strategy_summary:
        strat_path = run_dir / "strategy.json"
        if strat_path.exists():
            try:
                strat = json.loads(strat_path.read_text())
                strategy_html = (
                    "<h2>Strategy</h2>"
                    f"<pre>{json.dumps(strat, indent=2)}</pre>"
                )
            except Exception:
                pass

    html = f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Evor Evolution Report</title>
  <style>
    body {{ font-family: monospace; margin: 2em; background: #fafafa; }}
    pre {{ background: #eee; padding: 1em; border-radius: 4px; overflow-x: auto; }}
    table {{ border-collapse: collapse; margin: 1em 0; }}
    th {{ background: #ddd; }}
    td, th {{ padding: 4px 8px; }}
  </style>
</head>
<body>
<h1>Evor Evolution Tree</h1>
<pre>{ascii_tree}</pre>
{frontier_table_html}
{strategy_html}
</body>
</html>"""

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(html)
    print(f"[evor.plot_tree] HTML written to {output_path}", file=sys.stderr)


# ─────────────────────────────────────────────────────────────────────────────
# CLI entry point
# ─────────────────────────────────────────────────────────────────────────────


def _cli() -> None:
    parser = argparse.ArgumentParser(prog="python -m evor.plot_tree")
    parser.add_argument(
        "--run-id", required=True,
        help="Run identifier (or absolute path to run directory).",
    )
    parser.add_argument(
        "--run-dir", default=None,
        help="Explicit path to .evor/runs/<mission>/<run-id>/. "
             "Inferred from --run-id if omitted.",
    )
    parser.add_argument(
        "--format", dest="fmt", default="ascii",
        choices=["ascii", "png", "html"],
        help="Output format (default: ascii).",
    )
    parser.add_argument(
        "--output", default=None,
        help="Output path for png/html. Defaults to <run-dir>/report/tree.<ext>.",
    )
    parser.add_argument(
        "--highlight-frontier", action="store_true",
        help="Mark frontier nodes distinctly.",
    )
    parser.add_argument(
        "--include-frontier-table", action="store_true",
        help="Include frontier leaderboard table (html only).",
    )
    parser.add_argument(
        "--include-lessons", action="store_true",
        help="Include wiki lessons section (html only; no-op if wiki empty).",
    )
    parser.add_argument(
        "--include-strategy-summary", action="store_true",
        help="Include strategy.json dump (html only).",
    )

    args = parser.parse_args()

    # Resolve run_dir
    if args.run_dir:
        run_dir = Path(args.run_dir).resolve()
    else:
        candidate = Path(args.run_id)
        run_dir = candidate.resolve() if candidate.is_dir() else (Path(".evor/runs") / args.run_id).resolve()

    nodes = _load_tree(run_dir)
    run_state = _load_run_state(run_dir)
    frontier_ids: set[str] = set(run_state.get("frontier_ids", []))

    if args.fmt == "ascii":
        print(_render_ascii(nodes, frontier_ids, args.highlight_frontier))
        sys.exit(0)

    # Determine output path for png/html
    ext = "png" if args.fmt == "png" else "html"
    if args.output:
        output_path = Path(args.output).resolve()
    else:
        output_path = run_dir / "report" / f"tree.{ext}"

    if args.fmt == "png":
        _render_png(nodes, frontier_ids, output_path, args.highlight_frontier)
    else:
        _render_html(
            nodes=nodes,
            frontier_ids=frontier_ids,
            output_path=output_path,
            run_dir=run_dir,
            highlight_frontier=args.highlight_frontier,
            include_frontier_table=args.include_frontier_table,
            include_lessons=args.include_lessons,
            include_strategy_summary=args.include_strategy_summary,
        )

    sys.exit(0)


if __name__ == "__main__":
    _cli()
