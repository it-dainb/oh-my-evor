"""§1.5 — one registry for a node's two identities (finding O-01).

The trainer writes ``nodes/<slug>/telemetry.jsonl``; integrity check 5 was handed
``nodes/<uuid>/telemetry.jsonl``, found nothing, and failed the node.
``iir-scan-binnet-02`` had **12,000 well-formed telemetry records**. That false
negative stood as the run's final verdict and no candidate was ever re-scored.

Neither writer was wrong. The slug is the right name for a directory a human
reads and the UUID is the right key for a machine; the defect is that nothing
owned the mapping, so every reader guessed — and a guess that resolves to a
missing path fails in the direction of "the candidate is bad".

The control arms matter as much as the fix ones: resolution must never turn a
genuine absence into a hit.
"""

from __future__ import annotations

import json
from pathlib import Path

from evor.node_identity import (
    aliases_from_tree,
    node_aliases,
    resolve_node_artifact,
    resolve_node_artifact_by_ref,
)

UUID = "afb204f4-66d0-4c6e-9f1e-ced66d31de8b"
SLUG = "iir-scan-binnet-02"


class _Node:
    def __init__(self, node_id: str, name: str | None):
        self.id = node_id
        self.name = name


def _write(p: Path, text: str = "{}") -> Path:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)
    return p


class TestAliases:
    def test_both_identities_are_returned_uuid_first(self):
        assert node_aliases(_Node(UUID, SLUG)) == [UUID, SLUG]

    def test_a_node_with_no_slug_still_has_one_identity(self):
        assert node_aliases(_Node(UUID, None)) == [UUID]


class TestResolveByNode:
    def test_slug_written_uuid_requested(self, tmp_path: Path):
        _write(tmp_path / "nodes" / SLUG / "telemetry.jsonl")
        got = resolve_node_artifact(tmp_path / "nodes" / UUID / "telemetry.jsonl", _Node(UUID, SLUG))
        assert got == tmp_path / "nodes" / SLUG / "telemetry.jsonl"

    def test_uuid_written_slug_requested(self, tmp_path: Path):
        _write(tmp_path / "nodes" / UUID / "telemetry.jsonl")
        got = resolve_node_artifact(tmp_path / "nodes" / SLUG / "telemetry.jsonl", _Node(UUID, SLUG))
        assert got == tmp_path / "nodes" / UUID / "telemetry.jsonl"

    def test_an_existing_path_is_returned_unchanged(self, tmp_path: Path):
        want = _write(tmp_path / "nodes" / UUID / "telemetry.jsonl")
        assert resolve_node_artifact(want, _Node(UUID, SLUG)) == want

    def test_absent_under_both_identities_resolves_to_nothing(self, tmp_path: Path):
        # THE control arm. Resolution may rescue a misfiled artifact; it may never
        # manufacture one, or the O-01 fix becomes "pass when missing".
        assert resolve_node_artifact(
            tmp_path / "nodes" / UUID / "telemetry.jsonl", _Node(UUID, SLUG)
        ) is None

    def test_another_nodes_artifact_is_not_borrowed(self, tmp_path: Path):
        _write(tmp_path / "nodes" / "some-other-node" / "telemetry.jsonl")
        assert resolve_node_artifact(
            tmp_path / "nodes" / UUID / "telemetry.jsonl", _Node(UUID, SLUG)
        ) is None


class TestResolveByRef:
    def _tree(self, run: Path) -> None:
        (run / "tree.json").write_text(
            json.dumps({"nodes": {UUID: {"id": UUID, "name": SLUG}}, "updated_at": "2026-08-23T00:00:00Z"})
        )

    def test_a_caller_holding_only_a_string_can_still_resolve(self, tmp_path: Path):
        self._tree(tmp_path)
        _write(tmp_path / "nodes" / SLUG / "results.json")
        assert resolve_node_artifact_by_ref(tmp_path, UUID, "results.json") == (
            tmp_path / "nodes" / SLUG / "results.json"
        )

    def test_it_works_in_the_other_direction_too(self, tmp_path: Path):
        self._tree(tmp_path)
        _write(tmp_path / "nodes" / UUID / "results.json")
        assert resolve_node_artifact_by_ref(tmp_path, SLUG, "results.json") == (
            tmp_path / "nodes" / UUID / "results.json"
        )

    def test_missing_returns_none(self, tmp_path: Path):
        self._tree(tmp_path)
        assert resolve_node_artifact_by_ref(tmp_path, UUID, "results.json") is None

    def test_no_tree_is_not_a_crash(self, tmp_path: Path):
        assert resolve_node_artifact_by_ref(tmp_path, UUID, "results.json") is None

    def test_an_unknown_ref_has_only_itself(self, tmp_path: Path):
        self._tree(tmp_path)
        tree = json.loads((tmp_path / "tree.json").read_text())
        assert aliases_from_tree(tree, "not-a-node") == ["not-a-node"]

    def test_a_list_shaped_tree_is_read_too(self, tmp_path: Path):
        tree = {"nodes": [{"id": UUID, "name": SLUG}]}
        assert aliases_from_tree(tree, SLUG) == [UUID, SLUG]
