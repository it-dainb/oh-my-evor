"""Static snapshot export: one self-contained HTML file of the dashboard view.

The live page (``static/index.html``) reads ``<script id="evor-snapshot">`` when
present and then renders from that inline JSON instead of calling the API, with
the steer box removed. Every node's evidence (makeup, per-domain table,
telemetry, small sample images) is inlined so the details panel works offline.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from evor.dashboard.insights import RunInsights, iter_export_evidence

_STATIC = Path(__file__).parent / "static" / "index.html"
_MARKER = "<!--EVOR_SNAPSHOT-->"
# Inline at most this many sample-image bytes in total, so the file stays shareable.
_SAMPLE_BUDGET = 8_000_000


def build_snapshot(run_dir: Path, evor_root: Path | None = None) -> dict[str, Any]:
    ins = RunInsights(Path(run_dir), evor_root=evor_root)
    bundle = ins.bundle()
    bundle["steer_enabled"] = False
    budget = _SAMPLE_BUDGET
    evidence: dict[str, Any] = {}
    for node_id, ev in iter_export_evidence(ins):
        for s in ev.get("samples") or []:
            if budget <= 0 or s["bytes"] > budget:
                continue
            uri = ins.sample_data_uri(node_id, s["name"])
            if uri:
                s["data_uri"] = uri
                budget -= s["bytes"]
        evidence[node_id] = ev
    bundle["evidence"] = evidence
    return bundle


def render_snapshot_html(snapshot: dict[str, Any]) -> str:
    template = _STATIC.read_text()
    payload = json.dumps(snapshot, ensure_ascii=False, default=str, allow_nan=False)
    # "</" inside a <script> would end it early; "<\\/" is the same JSON string.
    payload = payload.replace("</", "<\\/").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    tag = f'<script id="evor-snapshot" type="application/json">{payload}</script>'
    if _MARKER not in template:
        raise RuntimeError("index.html lacks the snapshot marker")
    return template.replace(_MARKER, tag, 1)


def export_snapshot(run_dir: Path, out_path: Path, evor_root: Path | None = None) -> Path:
    html = render_snapshot_html(build_snapshot(run_dir, evor_root))
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(html)
    return out_path
