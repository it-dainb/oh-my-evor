"""Dashboard endpoint tests (M9).

Uses FastAPI TestClient against an in-memory fixture run directory.
All tests are standalone — no live training run required.

Test inventory (plan M9 + Addendum v2):
  - test_health                          basic server sanity
  - test_list_runs                       /api/runs lists mission with summary
  - test_get_tree                        /api/tree returns all nodes
  - test_get_frontier                    /api/frontier returns best-so-far node
  - test_get_strategy                    /api/strategy returns StrategyState
  - test_get_node_detail                 /api/nodes/{id} returns node+result+integrity
  - test_per_domain_endpoint             per-domain breakdown tagged with eval_version
  - test_domain_pivot                    domain-pivot sorted descending by value
  - test_eval_version_filter             domain-pivot without param → current version only
  - test_eval_versions_endpoint          /eval-versions in version order (benchmark timeline)
  - test_coverage_endpoint_fixed         fixed mission → 404 with message
  - test_coverage_endpoint_open_ended    open_ended → current_coverage + per_angle list
  - test_angle_registry_endpoint         angle-registry returns contamination risk fields
  - test_angle_registry_missing_fixed    fixed run without registry → 404
  - test_benchmark_upgrade_timeline      eval-versions sorted with domain info
  - test_telemetry_sse_headers           telemetry endpoint sets SSE headers + emits events
  - test_node_not_found                  unknown node → 404
  - test_run_not_found                   unknown run → 404
  - test_static_index                    / serves index.html
"""

from __future__ import annotations

import pytest

from tests.conftest import MISSION_ID, NODE_A, NODE_B, RUN_ID

# ── Helpers ───────────────────────────────────────────────────────────────────

def run_url(suffix: str = "") -> str:
    return f"/api/runs/{MISSION_ID}/{RUN_ID}{suffix}"


# ── Basic sanity ──────────────────────────────────────────────────────────────


def test_health(client) -> None:
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert "evor_root" in body


def test_static_index(client) -> None:
    r = client.get("/")
    assert r.status_code == 200
    assert b"Evor" in r.content


# ── /api/runs ─────────────────────────────────────────────────────────────────


def test_list_runs(client) -> None:
    r = client.get("/api/runs")
    assert r.status_code == 200
    runs = r.json()
    assert len(runs) == 1
    run = runs[0]
    assert run["mission_id"] == MISSION_ID
    assert run["run_id"] == RUN_ID
    assert run["best_score"] == pytest.approx(0.851)
    assert run["tick_count"] == 3
    assert run["frontier_size"] == 1
    assert run["current_eval_version"] == "v1"
    assert run["mission_type"] == "fixed"


# ── Tree ──────────────────────────────────────────────────────────────────────


def test_get_tree(client) -> None:
    r = client.get(run_url("/tree"))
    assert r.status_code == 200
    nodes = r.json()
    assert len(nodes) == 2
    ids = {n["id"] for n in nodes}
    assert NODE_A in ids
    assert NODE_B in ids


def test_tree_nodes_have_eval_version(client) -> None:
    nodes = client.get(run_url("/tree")).json()
    for n in nodes:
        assert n["eval_version"] == "v1"
        assert "approach_family" in n
        assert "fitness_value" in n


# ── Frontier ──────────────────────────────────────────────────────────────────


def test_get_frontier(client) -> None:
    r = client.get(run_url("/frontier"))
    assert r.status_code == 200
    frontier = r.json()
    assert len(frontier) == 1
    best = frontier[0]
    assert best["id"] == NODE_A
    assert best["fitness_value"] == pytest.approx(0.851)
    assert best["integrity_status"] == "passed"


# ── Strategy ──────────────────────────────────────────────────────────────────


def test_get_strategy(client) -> None:
    r = client.get(run_url("/strategy"))
    assert r.status_code == 200
    s = r.json()
    assert s["selection_policy"] == "ucb1"
    assert s["meta_iteration"] == 1
    assert s["rescore_mode"] == "sync"
    assert isinstance(s["family_mix"], dict)


# ── Per-node detail ───────────────────────────────────────────────────────────


def test_get_node_detail(client) -> None:
    r = client.get(run_url(f"/nodes/{NODE_A}"))
    assert r.status_code == 200
    detail = r.json()
    assert detail["node"]["id"] == NODE_A
    assert detail["result"]["fitness_value"] == pytest.approx(0.851)
    assert detail["integrity"]["verdict"] == "passed"


def test_node_not_found(client) -> None:
    r = client.get(run_url("/nodes/no-such-node-xyz"))
    assert r.status_code == 404


# ── Per-domain endpoint (Addendum v2 Pillar 3) ───────────────────────────────


def test_per_domain_endpoint(client) -> None:
    r = client.get(run_url(f"/nodes/{NODE_A}/per-domain"))
    assert r.status_code == 200
    data = r.json()
    assert data["node_id"] == NODE_A
    assert data["eval_version"] == "v1"
    per_domain = data["per_domain"]
    # Both domains must be present
    assert "scanned" in per_domain
    assert "handwritten" in per_domain
    # Each domain must have the accuracy metric
    assert "accuracy" in per_domain["scanned"]
    assert "accuracy" in per_domain["handwritten"]
    # scanned should be slightly higher than handwritten
    assert per_domain["scanned"]["accuracy"] > per_domain["handwritten"]["accuracy"]


def test_per_domain_returns_fitness_value(client) -> None:
    data = client.get(run_url(f"/nodes/{NODE_A}/per-domain")).json()
    assert data["fitness_value"] == pytest.approx(0.851)


# ── Domain pivot (Addendum v2 Pillar 3) ──────────────────────────────────────


def test_domain_pivot(client) -> None:
    r = client.get(
        run_url("/domain-pivot"),
        params={"metric": "accuracy", "domain": "scanned"},
    )
    assert r.status_code == 200
    rows = r.json()
    assert len(rows) >= 1
    # Results are sorted descending by value
    if len(rows) > 1:
        assert rows[0]["value"] >= rows[1]["value"]
    assert rows[0]["domain"] == "scanned"
    assert rows[0]["metric"] == "accuracy"
    assert rows[0]["node_id"] in (NODE_A, NODE_B)


def test_eval_version_filter(client) -> None:
    """Without eval_version param → only nodes matching current GoalContract version."""
    r = client.get(
        run_url("/domain-pivot"),
        params={"metric": "accuracy", "domain": "scanned"},
    )
    rows = r.json()
    # All returned rows must be on the current eval_version (v1)
    for row in rows:
        assert row["eval_version"] == "v1"


def test_domain_pivot_unknown_domain_returns_empty(client) -> None:
    r = client.get(
        run_url("/domain-pivot"),
        params={"metric": "accuracy", "domain": "nonexistent-domain-xyz"},
    )
    assert r.status_code == 200
    assert r.json() == []


# ── Eval versions / benchmark timeline (Addendum v2 Pillar 3) ────────────────


def test_eval_versions_endpoint(client) -> None:
    r = client.get(run_url("/eval-versions"))
    assert r.status_code == 200
    suites = r.json()
    assert len(suites) >= 1
    assert suites[0]["eval_version"] == "v1"
    assert len(suites[0]["domains"]) == 2  # scanned + handwritten


def test_benchmark_upgrade_timeline(client) -> None:
    """eval-versions must be returned in lexicographic (version) order."""
    suites = client.get(run_url("/eval-versions")).json()
    versions = [s["eval_version"] for s in suites]
    assert versions == sorted(versions)


def test_eval_versions_include_domain_names(client) -> None:
    suites = client.get(run_url("/eval-versions")).json()
    domain_ids = {d["domain_id"] for d in suites[0]["domains"]}
    assert "scanned" in domain_ids
    assert "handwritten" in domain_ids


# ── Coverage (Addendum v2 Pillar 4) ──────────────────────────────────────────


def test_coverage_endpoint_fixed_mission(client) -> None:
    """Fixed missions return HTTP 404 with explanatory message."""
    r = client.get(run_url("/coverage"))
    assert r.status_code == 404
    detail = r.json()["detail"]
    # Message must name the actual mission_type and explain availability
    assert "fixed" in detail.lower() or "open_ended" in detail


def test_coverage_endpoint_open_ended(open_client) -> None:
    r = open_client.get(run_url("/coverage"))
    assert r.status_code == 200
    data = r.json()
    assert "current_coverage" in data
    assert "coverage_target" in data
    assert "per_angle" in data
    assert isinstance(data["per_angle"], list)
    assert len(data["per_angle"]) == 2  # scanned + handwritten
    assert data["coverage_target"] == pytest.approx(0.90)
    # Each angle entry must have required fields
    for entry in data["per_angle"]:
        assert "angle_id" in entry
        assert "value" in entry
        assert "sota_bar" in entry
        assert "above_sota" in entry


# ── Angle registry (Addendum v2 Pillar 4) ────────────────────────────────────


def test_angle_registry_endpoint(open_client) -> None:
    r = open_client.get(run_url("/angle-registry"))
    assert r.status_code == 200
    registry = r.json()
    assert registry["mission_id"] == MISSION_ID
    angles = registry["angles"]
    assert len(angles) == 2
    # Every angle must carry pretraining_contamination_risk
    valid_risks = {"low", "medium", "high", "unknown"}
    for angle in angles:
        assert "pretraining_contamination_risk" in angle
        assert angle["pretraining_contamination_risk"] in valid_risks
        assert "sota_bar" in angle
        assert "sota_quorum_met" in angle


def test_angle_registry_missing_returns_404(client) -> None:
    """Fixed run without angle-registry.json → 404."""
    r = client.get(run_url("/angle-registry"))
    assert r.status_code == 404


# ── SSE telemetry (base plan) ─────────────────────────────────────────────────


def test_telemetry_sse_headers(client) -> None:
    """Telemetry endpoint must set SSE content-type and emit existing records.

    Default ``tail=false`` — stream closes after replay so the test terminates
    without needing a client-side break or timeout.
    """
    import json as _json

    with client.stream("GET", f"/api/telemetry/{MISSION_ID}/{RUN_ID}/{NODE_A}") as r:
        assert r.status_code == 200
        assert "text/event-stream" in r.headers["content-type"]
        assert r.headers.get("cache-control") == "no-cache"
        # Collect all lines — stream closes once fixture records are exhausted
        data_lines = [
            ln for ln in r.iter_lines() if ln.startswith("data:")
        ]

    assert len(data_lines) == 5, f"Expected 5 telemetry events, got {len(data_lines)}"
    first_record = _json.loads(data_lines[0][len("data:"):].strip())
    assert first_record["node_id"] == NODE_A
    assert "step" in first_record
    assert "train_loss" in first_record


def test_telemetry_missing_node_returns_error_event(client) -> None:
    """Telemetry for a node with no telemetry.jsonl emits a single SSE error event."""
    import json as _json

    with client.stream("GET", f"/api/telemetry/{MISSION_ID}/{RUN_ID}/no-such-node") as r:
        assert r.status_code == 200
        assert "text/event-stream" in r.headers["content-type"]
        data_lines = [
            ln for ln in r.iter_lines() if ln.startswith("data:")
        ]

    assert len(data_lines) == 1
    error_event = _json.loads(data_lines[0][len("data:"):].strip())
    assert "error" in error_event


# ── Not-found cases ───────────────────────────────────────────────────────────


def test_run_not_found(client) -> None:
    r = client.get(f"/api/runs/{MISSION_ID}/nonexistent-run-xyz/tree")
    assert r.status_code == 404


def test_mission_not_found(client) -> None:
    r = client.get("/api/runs/no-such-mission/no-such-run/frontier")
    assert r.status_code == 404
