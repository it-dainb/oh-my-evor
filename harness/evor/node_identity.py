"""One place that knows a node's identities — plan item 1.5.

FINDING O-01. A node has two identities: a UUID (``node.id``) and a
human-readable slug (``node.name``). The trainer writes telemetry to
``nodes/<slug>/telemetry.jsonl``; integrity check 5 was handed
``nodes/<uuid>/telemetry.jsonl``, found nothing, and failed the node. The node in
question — ``iir-scan-binnet-02`` — had **12,000 well-formed telemetry
records**. That false negative stood as the run's final verdict and no candidate
was ever re-scored.

Nothing was wrong with either writer. The slug is the right name for a directory
a human reads; the UUID is the right key for a machine. The defect is that both
were correct and no component owned the mapping, so every reader independently
guessed which one the writer had used — and a guess that resolves to a
non-existent path fails silently in the direction of "the candidate is bad".

So this module holds the aliases and the resolution, and readers ask it rather
than guessing. It deliberately does NOT invent a path: it returns only paths that
exist, so resolution can never turn a genuine absence into a pass. The control
arm in ``test_wave1_seal_provenance.py`` pins exactly that.
"""

from __future__ import annotations

from pathlib import Path
from typing import Iterable, Optional, Protocol


class _HasIdentities(Protocol):
    id: str
    name: Optional[str]


def node_aliases(node: _HasIdentities) -> list[str]:
    """Every directory name a writer may legitimately have used for this node.

    Order is ``id`` first, then ``name``: the UUID is the canonical key, and the
    slug is the alias a human-facing writer prefers. Both are returned because
    both are in use on disk right now, in the same run.
    """
    aliases: list[str] = []
    for candidate in (getattr(node, "id", None), getattr(node, "name", None)):
        if candidate and str(candidate) not in aliases:
            aliases.append(str(candidate))
    return aliases


def resolve_node_artifact(
    path: Path,
    node: _HasIdentities,
    *,
    extra_aliases: Iterable[str] = (),
) -> Optional[Path]:
    """Resolve an artifact path that may have been written under either identity.

    ``path`` is what the caller expected, of the shape
    ``.../nodes/<identity>/<artifact>``. If it exists, it is returned unchanged —
    resolution never second-guesses a hit. Otherwise the identity segment is
    swapped for each of the node's other aliases and the first EXISTING path is
    returned.

    Returns ``None`` when the artifact exists under no identity. That is the
    whole safety property: this function can rescue a misfiled artifact, and it
    can never manufacture one. A check handed ``None`` fails exactly as it did
    before, which is what keeps the O-01 fix from degrading into "pass when
    missing".
    """
    path = Path(path)
    if path.exists():
        return path

    parent = path.parent           # .../nodes/<identity>
    artifact = path.name           # telemetry.jsonl
    container = parent.parent      # .../nodes

    seen = {parent.name}
    for alias in [*node_aliases(node), *extra_aliases]:
        if alias in seen:
            continue
        seen.add(alias)
        candidate = container / alias / artifact
        if candidate.exists():
            return candidate

    return None


def aliases_from_tree(tree: dict, ref: str) -> list[str]:
    """Every identity of the node ``ref`` names, given a parsed ``tree.json``.

    ``ref`` may be either identity. Returns ``[ref]`` when the tree does not know
    it — an unknown ref is not an error here, it just has no aliases, and the
    caller's existing not-found handling stays in charge.

    This is the registry half of item 1.5: a reader that holds only a string can
    still ask what else that string is called, instead of guessing which of the
    two conventions the writer used.
    """
    nodes = tree.get("nodes") or {}
    if isinstance(nodes, dict):
        entries = list(nodes.values())
    else:
        entries = list(nodes)

    for entry in entries:
        if not isinstance(entry, dict):
            continue
        node_id = entry.get("id")
        name = entry.get("name")
        if ref in (node_id, name):
            return [str(x) for x in (node_id, name) if x]
    return [ref]


def resolve_node_artifact_by_ref(
    run_dir: Path, ref: str, artifact: str, tree: Optional[dict] = None
) -> Optional[Path]:
    """Resolve ``<run_dir>/nodes/<identity>/<artifact>`` from either identity.

    Returns ``None`` when the artifact exists under no identity — resolution
    never manufactures a path.
    """
    run_dir = Path(run_dir)
    direct = run_dir / "nodes" / ref / artifact
    if direct.exists():
        return direct

    if tree is None:
        try:
            import json

            tree = json.loads((run_dir / "tree.json").read_text())
        except Exception:
            return None

    for alias in aliases_from_tree(tree, ref):
        candidate = run_dir / "nodes" / alias / artifact
        if candidate.exists():
            return candidate
    return None
