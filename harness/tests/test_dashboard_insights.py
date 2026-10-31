"""Researcher-view endpoints: recipes, verdicts, alerts, timeline, learnings,
evidence, steer inbox, and the static snapshot export.

Every test builds its own run under ``tmp_path``; none reads a live mission.
``test_live_run_copy`` is opt-in: set ``EVOR_DASHBOARD_LIVE_RUN`` to a run dir
and it copies that run (minus frozen splits) into tmp and exercises it there.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

MISSION = "viz-mission-2026-10"
RUN = "viz-mission-2026-10-20261030T000000Z"
BASELINE = 0.010
TOKEN = "test-steer-token"


# ── fixture builder ───────────────────────────────────────────────────────────


def _w(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(data if isinstance(data, str) else json.dumps(data, indent=1))


def _domains(livememory: dict, others_S: float = 80.0) -> dict:
    base = {"S": others_S, "fmeasure": 85.0, "recall": 0.85, "precision": 0.86, "stroke_width_ratio": 1.0, "n": 4}
    return {"dibco_2013": dict(base), "office_scan": dict(base, S=others_S + 5), "livememory": dict(base, **livememory)}


def build_viz_run(root: Path, stale_minutes: float = 5.0, mission_status: str = "running") -> Path:
    run = root / "runs" / MISSION / RUN
    now = datetime.now(timezone.utc)
    t0 = now - timedelta(hours=6)
    iso = lambda dt: dt.isoformat().replace("+00:00", "Z")  # noqa: E731

    _w(run / "goal-contract.json", {
        "mission_id": MISSION, "mission_type": "fixed", "fitness_mode": "worst-domain", "eval_version": "v1",
        "baseline_value": BASELINE, "created_at": iso(t0), "task_description": "Binarize documents </script> robustly.",
        "budget": {"plateau_window": 6},
        "metric_specs": json.dumps([
            {"metric_name": "min_domain_S", "direction": "higher", "role": "primary_fitness"},
            {"metric_name": "fmeasure", "direction": "higher", "role": "secondary_reported"},
        ]),
    })
    _w(run / "mission-state.json", {"status": mission_status})
    _w(run / "strategy.json", {"selection_policy": "ucb1", "wildness": 1.0, "family_mix": {"training": 1.0}, "meta_evolve_requested": False})

    # Nodes ------------------------------------------------------------------
    # base-01           tick 1   0.004           (root)
    # base-seed7-01     tick 2   0.002           seed replicate of base-01  -> joins its recipe
    # ema-s42/s7/s123   tick 2   0.040/0.006/0.0001  seed siblings, s42 is lucky
    # band-s42/s7       tick 3   0.020/0.022     gaming: livememory S up, recall/F down
    # bad-01            tick 3   0.090           integrity failed (would lead)
    # alt-a / alt-b     tick 3   0.012/0.014     same parent+hypothesis, no seed token
    def node(nid, name, parent, hyp, fit, created, integrity="passed", status="done", family="training", cfg=None):
        return {"id": nid, "name": name, "parent_ids": [parent] if parent else ["root/baseline"], "approach_family": family,
                "hypothesis_id": hyp, "mutation_tier": "structural", "mutation_locus": {"family": family, "path": "train/"},
                "data_version_ref": "corpora/v1", "config": cfg or {}, "genome_ref": "", "eval_version": "v1",
                "fitness_value": fit, "integrity_status": integrity, "status": status, "is_crossover": False,
                "created_at": iso(created), "metrics": {"fmeasure": 80.0}}

    nodes = [
        node("u-base", "base-01", None, "h-base", 0.004, t0 + timedelta(minutes=10)),
        node("u-base7", "base-seed7-01", "u-base", "h-base7", 0.002, t0 + timedelta(minutes=70)),
        node("u-e42", "ema-s42-01", "u-base", "h-ema", 0.040, t0 + timedelta(minutes=71), cfg={"seed": 42}),
        node("u-e7", "ema-s7-01", "u-base", "h-ema", 0.006, t0 + timedelta(minutes=72), cfg={"seed": 7}),
        node("u-e123", "ema-s123-01", "u-base", "h-ema", 0.0001, t0 + timedelta(minutes=73), cfg={"seed": 123}),
        node("u-b42", "band-s42-01", "u-base", "h-band", 0.020, t0 + timedelta(minutes=130)),
        node("u-b7", "band-s7-01", "u-base", "h-band", 0.022, t0 + timedelta(minutes=131)),
        node("u-bad", "bad-01", "u-base", "h-bad", 0.090, t0 + timedelta(minutes=132), integrity="failed"),
        node("u-alta", "alt-a", "u-e42", "h-alt", 0.012, t0 + timedelta(minutes=133), family="algo"),
        node("u-altb", "alt-b", "u-e42", "h-alt", 0.014, t0 + timedelta(minutes=134), family="algo"),
    ]
    _w(run / "tree.json", {"nodes": {n["id"]: n for n in nodes}, "updated_at": iso(now)})
    _w(run / "run-state.json", {
        "tick_count": 3, "best_score": 0.040, "frontier_ids": ["u-e42"], "current_eval_version": "v1",
        "tick_records": [{"tick": 1, "outcome": "scored", "score": 0.004}, {"tick": 2, "outcome": "scored", "score": 0.040},
                         {"tick": 3, "outcome": "scored", "score": 0.022}],
    })
    _w(run / "tick-state.json", {"tick": 4, "current_step": 5, "step_status": "running",
                                 "updated_at": iso(now - timedelta(minutes=stale_minutes)), "blocked": {"on": "job:abc", "since": iso(now)}})

    # Results ----------------------------------------------------------------
    parent_pd = _domains({"S": 3.0, "fmeasure": 68.0, "recall": 0.70})
    results = {
        "u-base": (0.004, parent_pd),
        "u-base7": (0.002, _domains({"S": 2.0, "fmeasure": 66.0, "recall": 0.69})),
        "u-e42": (0.040, _domains({"S": 40.0, "fmeasure": 70.0, "recall": 0.72})),
        "u-e7": (0.006, _domains({"S": 6.0, "fmeasure": 69.0, "recall": 0.71})),
        "u-e123": (0.0001, _domains({"S": 0.1, "fmeasure": 60.0, "recall": 0.69})),
        # erasure: livememory S rises 3 -> 25 while recall 0.70 -> 0.22 and F 68 -> 31
        "u-b42": (0.020, _domains({"S": 25.0, "fmeasure": 31.0, "recall": 0.22})),
        "u-b7": (0.022, _domains({"S": 26.0, "fmeasure": 35.0, "recall": 0.25})),
        "u-bad": (0.090, _domains({"S": 90.0, "fmeasure": 90.0, "recall": 0.9})),
        "u-alta": (0.012, _domains({"S": 12.0})),
        "u-altb": (0.014, _domains({"S": 14.0})),
    }
    for nid, (fit, pd) in results.items():
        _w(run / "nodes" / nid / "results.json", {"eval_version": "v1", "fitness_value": fit, "metrics": {"fmeasure": 80.0 + fit * 10, "recall": 0.8}, "per_domain": pd})
    tel = "\n".join(json.dumps({"step": s, "train_loss": 1.0 / s, "val_metric": 0.5 + s / 100, "lr": 1e-3}) for s in range(1, 30)) + "\n"
    _w(run / "nodes" / "u-e42" / "telemetry.jsonl", tel)
    _w(run / "nodes" / "u-base" / "telemetry.jsonl", tel)
    png = bytes.fromhex("89504e470d0a1a0a0000000d4948445200000001000000010806000000" "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082")
    (run / "nodes" / "u-e42" / "samples").mkdir(parents=True, exist_ok=True)
    (run / "nodes" / "u-e42" / "samples" / "page1.png").write_bytes(png)
    genome = "model: {name: small_unet}\nloss: {name: dice}\n"
    sha = hashlib.sha256(genome.encode()).hexdigest()
    _w(run / "artifacts" / sha[:2] / sha[2:], genome)
    tree = json.loads((run / "tree.json").read_text())
    tree["nodes"]["u-e42"]["genome_ref"] = sha
    _w(run / "tree.json", tree)
    _w(run / "evaluations" / "u-bad.json", {"node_id": "u-bad", "eval_version": "v1", "checks": {"telemetry_sane": False},
                                             "verdict": "failed", "failure_reason": "telemetry_sane: NaN loss", "verified_at": iso(now)})

    # Tick artifacts -----------------------------------------------------------
    def prop(pid, hid, parent, family="training", idea="Do the thing. More detail."):
        return {"proposal_id": pid, "parent_node_ids": [parent], "approach_family": family, "mutation_tier": "structural",
                "idea": idea, "hypothesis": {"id": hid, "statement": f"Statement {hid}.", "prediction": f"Prediction {hid}."}}

    _w(run / "ticks/1/mutagen/proposals.json", {"proposals": [prop("p-base", "h-base", "root/baseline")]})
    _w(run / "ticks/1/selector/verdict.json", {"reviews": [{"proposal_id": "p-base", "selected": True, "critic_review": {"verdict": "approved", "schema_valid": "pass"}}], "winner": "p-base"})
    _w(run / "ticks/1/forge/base-01/forge-report.json", {"node_id": "base-01", "status": "success", "fitness_value": 0.004})
    _w(run / "ticks/1/probe/findings.json", {"hypothesis_verdict": "inconclusive", "evidence": "No parent to compare."})

    _w(run / "ticks/2/mutagen/proposals.json", {"proposals": [
        prop("p-ema", "h-ema", "base-01", idea="Long EMA schedule. Three seeds."),
        prop("p-rej", "h-rej", "base-01", family="arch", idea="Huge transformer."),
    ]})
    _w(run / "ticks/2/selector/verdict.json", {"reviews": [
        {"proposal_id": "p-ema", "selected": True, "critic_review": {"verdict": "approved", "h001_one_hypothesis": "pass"}, "selection_note": "Primary."},
        {"proposal_id": "p-rej", "selected": False, "critic_review": {"verdict": "rejected", "integrity_risk": "fail", "rejection_reason": "Exceeds the latency gate."}},
    ], "winner": "p-ema"})
    for nm, fit in (("ema-s42-01", 0.040), ("ema-s7-01", 0.006), ("ema-s123-01", 0.0001), ("base-seed7-01", 0.002)):
        _w(run / f"ticks/2/forge/{nm}/forge-report.json", {"node_id": nm, "status": "success", "fitness_value": fit})
    _w(run / "ticks/2/probe/findings.json", {"proposal_id": "p-ema", "hypothesis_verdict": "confirmed", "evidence": "Median beats the parent."})

    _w(run / "ticks/3/mutagen/proposals.json", {"proposals": [prop("p-band", "h-band", "base-01"), prop("p-alt", "h-alt", "ema-s42-01", family="algo")]})
    _w(run / "ticks/3/selector/verdict.json", {"reviews": [{"proposal_id": "p-band", "selected": True}, {"proposal_id": "p-alt", "selected": True}], "winner": "p-band"})
    for nm in ("band-s42-01", "band-s7-01", "bad-01", "alt-a", "alt-b"):
        _w(run / f"ticks/3/forge/{nm}/forge-report.json", {"node_id": nm, "status": "success"})
    _w(run / "ticks/3/probe/findings.json", {
        "hypothesis_verdicts": [{"hypothesis": "h-band", "nodes": "band-s42-01, band-s7-01", "verdict": "refuted", "evidence": "Recall collapsed."},
                                {"hypothesis": "h-alt", "nodes": ["alt-a", "alt-b"], "verdict": "refuted", "evidence": "No gain."}],
        "band_audit": {"verdict": "artefact (livememory erasure)"},
        "verdict_summary": "band is an erasure artefact.",
    })
    _w(run / "ticks/4/mutagen/proposals.json", {"proposals": []})
    # Tick start times: one hour apart, in order.
    for t in (1, 2, 3, 4):
        ts = (t0 + timedelta(minutes=60 * (t - 1) + 1)).timestamp()
        for p in (run / "ticks" / str(t)).rglob("*.json"):
            os.utime(p, (ts, ts))

    # Knowledge ---------------------------------------------------------------
    _w(run / "wiki/lesson-band-erasure.md",
       "# Lesson: lesson-band-erasure\n\n**Node:** band-s42-01  |  **Run:**   |  **Mission:** \n**Family:** training  |  **Verdict:** refuted\n"
       f"**Created:** {iso(t0 + timedelta(minutes=170))}\n\n## Observation\n\nS rose because ink was erased </script>.\n\n"
       "## Actionable Lesson\n\nJudge floor domains by recall.\n\n**Tags:** band, metric-artefact, erasure\n")
    _w(run / "wiki/ema-confirmed.md",
       "# Lesson: ema-confirmed\n\n**Node:** ema-s7-01  |  **Run:**   |  **Mission:** \n**Family:** training  |  **Verdict:** confirmed\n"
       f"**Created:** {iso(t0 + timedelta(minutes=100))}\n\n## Observation\n\nEMA helps.\n\n## Actionable Lesson\n\nKeep EMA.\n\n**Tags:** ema, tick2\n")
    _w(run / "gotchas/mission.jsonl", json.dumps({"gotcha_id": "g1", "kind": "oom", "signature": "bs512-oom", "avoidance": "Use batch 256.",
                                                   "first_seen": iso(t0 + timedelta(minutes=75)), "occurrences": 2}) + "\n")
    _w(run / "signals.jsonl", "\n".join(json.dumps(s) for s in [
        {"signal_id": "s1", "kind": "eval-weakness", "signature": "ew", "shapes": ["limit"], "axes": ["accuracy"], "severity": "high",
         "evidence": {"description": "S rewards erasure"}, "source": "evor-probe", "tick": 3, "first_seen": iso(t0 + timedelta(minutes=150)), "last_seen": iso(now), "occurrences": 1, "confidence": 0.5},
    ]) + "\n")
    _w(run / "decision-log.md",
       "# Decision Log\n\n"
       f"- `{iso(t0)}` **mission locked -> running** — fresh start\n\n"
       f"## record {iso(t0 + timedelta(minutes=71))}\n- node_id: u-e42\n- approach_family: training\n- status: running\n\n"
       f"## record {iso(t0 + timedelta(minutes=132))}\n- node_id: u-bad\n- approach_family: training\n- status: pruned\n")
    return run


@pytest.fixture()
def viz(tmp_path: Path):
    root = tmp_path / ".evor"
    run = build_viz_run(root)
    from fastapi.testclient import TestClient

    from evor.dashboard.server import create_app

    return TestClient(create_app(root, default_run_dir=run, steer_token=TOKEN), headers={"X-Evor-Steer-Token": TOKEN}), run, root


def url(suffix: str) -> str:
    return f"/api/runs/{MISSION}/{RUN}{suffix}"


def _recipe(recipes, label):
    return next(r for r in recipes if r["label"] == label)


# ── recipes ───────────────────────────────────────────────────────────────────


def test_seed_siblings_fold_into_one_recipe_with_median(viz) -> None:
    client, _, _ = viz
    recipes = client.get(url("/recipes")).json()
    ema = _recipe(recipes, "ema")
    assert {m["name"] for m in ema["members"]} == {"ema-s42-01", "ema-s7-01", "ema-s123-01"}
    assert ema["median"] == pytest.approx(0.006)
    assert ema["spread"] == pytest.approx(0.040 / 0.0001)
    assert "seed-spread" in ema["badges"]
    lucky = next(m for m in ema["members"] if m["name"] == "ema-s42-01")
    assert "lucky-seed" in lucky["badges"]


def test_seed_replicate_of_parent_joins_parent_recipe(viz) -> None:
    client, _, _ = viz
    base = _recipe(client.get(url("/recipes")).json(), "base")
    assert {m["name"] for m in base["members"]} == {"base-01", "base-seed7-01"}
    assert base["median"] == pytest.approx(0.003)


def test_same_parent_and_hypothesis_groups_unsuffixed_names(viz) -> None:
    client, _, _ = viz
    recipes = client.get(url("/recipes")).json()
    alt = next(r for r in recipes if {m["name"] for m in r["members"]} == {"alt-a", "alt-b"})
    assert alt["n"] == 2
    assert alt["parent_recipe"] == _recipe(recipes, "ema")["id"]


def test_integrity_failed_node_is_excluded_from_median(viz) -> None:
    client, _, _ = viz
    bad = _recipe(client.get(url("/recipes")).json(), "bad")
    assert bad["median"] is None and bad["credible"] is False
    assert "integrity-failed" in bad["badges"] and "pruned" in bad["badges"]


# ── verdicts ──────────────────────────────────────────────────────────────────


def test_verdicts_from_probe_and_wiki(viz) -> None:
    client, _, _ = viz
    recipes = client.get(url("/recipes")).json()
    assert _recipe(recipes, "ema")["verdict"] == "confirmed"          # single verdict + proposal_id
    assert _recipe(recipes, "ema")["verdict_source"] == "probe:tick2"
    # One seed tagged metric-artefact by a wiki lesson + a recipe-wide audit:
    # the recipe keeps its Probe verdict, is flagged suspect, and still counts.
    band = _recipe(recipes, "band")
    assert band["verdict"] == "refuted" and band["verdict_source"] == "probe:tick3"
    assert band["suspect"] is True and "artefact-suspect" in band["badges"]
    tagged = {m["name"]: m["artefact"] for m in band["members"]}
    assert tagged == {"band-s42-01": True, "band-s7-01": False}
    assert band["median"] == pytest.approx(0.022) and band["n_valid"] == 1 and band["credible"] is True
    alt = next(r for r in recipes if r["members"][0]["name"] == "alt-a")
    assert alt["verdict"] == "refuted"                                # hypothesis_verdicts list
    assert _recipe(recipes, "base")["verdict"] == "inconclusive"      # no-target verdict -> selected proposal
    assert _recipe(recipes, "bad")["verdict"] == "pending"


# ── alerts ────────────────────────────────────────────────────────────────────


def test_gaming_alert_detects_score_up_recall_down_on_floor(viz) -> None:
    client, _, _ = viz
    alerts = client.get(url("/alerts")).json()
    game = next(a for a in alerts if a["kind"] == "metric-gaming")
    flagged = {i["name"] for i in game["items"]}
    assert {"band-s42-01", "band-s7-01"} <= flagged
    item = next(i for i in game["items"] if i["name"] == "band-s42-01")
    assert item["domain"] == "livememory" and item["which"] == "parent floor"
    assert {d["metric"] for d in item["drops"]} >= {"recall", "fmeasure"}
    # A score rise WITHOUT the quality drop is not gaming.
    assert "ema-s42-01" not in flagged
    assert "bad-01" not in flagged  # integrity-failed nodes are already excluded


def test_seed_spread_lucky_integrity_alerts(viz) -> None:
    client, _, _ = viz
    kinds = {a["kind"]: a for a in client.get(url("/alerts")).json()}
    assert "seed-spread" in kinds
    assert "integrity" in kinds and kinds["integrity"]["severity"] == "high"  # bad-01 would lead
    assert "telemetry_sane" in kinds["integrity"]["detail"]
    assert "agent-signals" in kinds


def test_stall_alert_and_paused_suppresses_it(tmp_path: Path) -> None:
    from evor.dashboard.insights import RunInsights

    run = build_viz_run(tmp_path / "a" / ".evor", stale_minutes=200)
    stall = RunInsights(run).stall()
    assert stall["level"] == "critical" and "job:abc" in stall["detail"]
    assert any(a["kind"] == "stalled" for a in RunInsights(run).alerts())
    run2 = build_viz_run(tmp_path / "b" / ".evor", stale_minutes=200, mission_status="paused")
    assert RunInsights(run2).stall()["level"] == "ok"


def test_plateau_counts_ticks_since_robust_best(tmp_path: Path) -> None:
    from evor.dashboard.insights import RunInsights

    run = build_viz_run(tmp_path / ".evor")
    for t in range(5, 12):
        (run / "ticks" / str(t) / "mutagen").mkdir(parents=True)
        (run / "ticks" / str(t) / "mutagen" / "proposals.json").write_text('{"proposals": []}')
    p = RunInsights(run).plateau()
    assert p["level"] in ("warn", "critical") and p["ticks_since"] >= 6


# ── overview / progress / points ──────────────────────────────────────────────


def test_overview_reads_robust_median_not_lucky_seed(viz) -> None:
    client, _, _ = viz
    body = client.get(url("/overview")).json()
    ov = body["overview"]
    assert ov["metric"]["name"] == "min_domain_S" and ov["metric"]["baseline"] == BASELINE
    assert ov["best_node"]["name"] == "ema-s42-01" and "lucky-seed" in ov["best_node"]["badges"]
    # band is an artefact and bad-01 failed integrity, so the robust best is alt (median 0.013).
    assert ov["robust_best"]["label"] == "alt"
    assert ov["robust_best"]["median"] == pytest.approx(0.013)
    assert ov["first_beat_tick"] == 3
    assert ov["status"] in ("on-track", "watch", "off-track")
    ticks = [p["tick"] for p in body["progress"]]
    assert ticks == [1, 2, 3, 4]
    assert body["progress"][1]["robust_best"]["label"] == "ema"


def test_points_carry_metrics_lineage_and_flags(viz) -> None:
    client, _, _ = viz
    body = client.get(url("/points")).json()
    assert [m["name"] for m in body["metrics"]] == ["min_domain_S", "fmeasure"]
    pts = {p["name"]: p for p in body["points"]}
    assert pts["ema-s7-01"]["tick"] == 2 and pts["band-s42-01"]["tick"] == 3
    assert pts["ema-s7-01"]["values"]["min_domain_S"] == pytest.approx(0.006)
    assert pts["ema-s7-01"]["values"]["fmeasure"] is not None
    assert pts["alt-a"]["parents"] == [{"id": "u-e42", "name": "ema-s42-01"}]
    assert pts["bad-01"]["integrity_failed"] is True
    assert pts["band-s42-01"]["artefact"] is True     # explicitly tagged node
    assert pts["band-s7-01"]["artefact"] is False     # its sibling still counts
    assert pts["band-s7-01"]["suspect"] is True


# ── timeline / learnings ──────────────────────────────────────────────────────


def test_timeline_restates_each_tick(viz) -> None:
    client, _, _ = viz
    tl = {t["tick"]: t for t in client.get(url("/timeline")).json()}
    t2 = tl[2]
    rej = next(p for p in t2["proposals"] if p["proposal_id"] == "p-rej")
    assert rej["selected"] is False and rej["rejection_reason"] == "Exceeds the latency gate."
    assert rej["failed_gates"] == ["integrity_risk"]
    assert next(p for p in t2["proposals"] if p["proposal_id"] == "p-ema")["winner"] is True
    assert {f["name"] for f in t2["forge"]} >= {"ema-s42-01", "ema-s7-01"}
    assert t2["probe"][0]["verdict"] == "confirmed"
    assert [l["lesson_id"] for l in t2["lessons"]] == ["ema-confirmed"]
    assert [g["signature"] for g in t2["gotchas"]] == ["bs512-oom"]
    assert any("ema-s42-01" in d["text"] for d in t2["decisions"])
    t3 = tl[3]
    assert any(p["audit"] and p["verdict"] == "artefact" for p in t3["probe"])
    assert [s["kind"] for s in t3["signals"]] == ["eval-weakness"]
    assert "Probe: refuted" in t3["headline"]
    assert tl[4]["in_progress"] is True


def test_learnings_groups_what_worked_and_what_did_not(viz) -> None:
    client, _, _ = viz
    L = client.get(url("/learnings")).json()
    assert [l["lesson_id"] for l in L["worked"]] == ["ema-confirmed"]
    assert [l["lesson_id"] for l in L["artefacts"]] == ["lesson-band-erasure"]
    assert L["recipes_artefact"] == []
    assert [r["label"] for r in L["recipes_suspect"]] == ["band"]
    kinds = {s["kind"] for s in L["suspicious"]}
    assert {"metric-gaming", "lucky-seed", "artefact", "artefact-suspect"} <= kinds
    assert L["gotchas"][0]["signature"] == "bs512-oom"
    assert any("locked" in d["text"] for d in L["decisions"])


# ── evidence ──────────────────────────────────────────────────────────────────


def test_node_evidence_per_domain_vs_parent_and_makeup(viz) -> None:
    client, _, _ = viz
    ev = client.get(url("/nodes/ema-s42-01/evidence")).json()   # by name
    assert ev["node"]["id"] == "u-e42"
    assert ev["columns"][:3] == ["S", "fmeasure", "recall"]
    assert ev["per_domain"][0]["domain"] == "livememory" and ev["per_domain"][0]["is_floor"]
    assert ev["per_domain"][0]["parent"]["S"] == pytest.approx(3.0)
    assert ev["parent"]["name"] == "base-01"
    assert len(ev["telemetry"]["train_loss"]) == 29 and ev["parent_telemetry"]["val_metric"]
    mk = ev["makeup"]
    assert mk["idea"].startswith("Long EMA") and mk["prediction"] == "Prediction h-ema."
    assert mk["selector"]["selected"] is True and mk["forge"]["tick"] == 2
    assert "small_unet" in mk["genome"]
    assert {"key": "seed", "parent": None, "node": 42} in mk["config_changes"]
    assert ev["samples"] == [{"name": "samples/page1.png", "bytes": 66}]


def test_sample_endpoint_serves_listed_files_only(viz) -> None:
    client, _, _ = viz
    r = client.get(url("/nodes/u-e42/samples/samples/page1.png"))
    assert r.status_code == 200 and r.content.startswith(b"\x89PNG")
    assert client.get(url("/nodes/u-e42/samples/results.json")).status_code == 404
    assert client.get(url("/nodes/u-e42/samples/..%2F..%2Ftree.json")).status_code == 404
    assert client.get(url("/nodes/nope/evidence")).status_code == 404


def test_bundle_and_default_run(viz) -> None:
    client, _, _ = viz
    b = client.get(url("/bundle")).json()
    assert {"overview", "progress", "alerts", "recipes", "timeline", "learnings", "points", "metrics", "steers"} <= set(b)
    assert b["steer_enabled"] is True
    assert client.get("/api/runs").json()[0]["default"] is True


# ── steer ─────────────────────────────────────────────────────────────────────


def _tree_state(run: Path) -> dict[str, float]:
    return {str(p.relative_to(run)): p.stat().st_mtime_ns for p in run.rglob("*") if p.is_file()}


def test_steer_appends_one_inbox_line_and_nothing_else(viz) -> None:
    client, run, root = viz
    before = _tree_state(run)
    root_before = {str(p) for p in root.rglob("*")}
    r = client.post(url("/steer"), json={"note": "Try a recall floor in the loss.", "author": "dai", "axis": "generalization"})
    assert r.status_code == 201
    after = _tree_state(run)
    changed = {k for k in after if before.get(k) != after[k]}
    assert changed == {"signals-inbox.jsonl"}
    assert {str(p) for p in root.rglob("*")} - root_before == {str(run / "signals-inbox.jsonl")}
    lines = (run / "signals-inbox.jsonl").read_text().splitlines()
    assert len(lines) == 1
    line = json.loads(lines[0])
    # Same keys as the hook-written lines drain_inbox reads.
    assert set(line) == {"kind", "signature", "shapes", "axes", "severity", "evidence", "source", "created_at"}
    assert line["kind"] == "human-steer" and line["signature"].startswith("human-steer:")
    assert line["evidence"]["note"] == "Try a recall floor in the loss." and line["evidence"]["author"] == "dai"
    assert line["axes"] == ["generalization"] and line["created_at"].endswith("Z")

    notes = client.get(url("/steer")).json()["notes"]
    assert notes[0]["status"] == "queued" and notes[0]["author"] == "dai"


def test_steer_is_drained_by_the_tick_loop(viz) -> None:
    client, run, _ = viz
    client.post(url("/steer"), json={"note": "Stop tuning ckpt selection.", "author": "lan"})
    from evor.signals import drain_inbox

    assert drain_inbox(run) == 1
    assert not (run / "signals-inbox.jsonl").exists()
    bus = [json.loads(l) for l in (run / "signals.jsonl").read_text().splitlines() if l.strip()]
    steer = next(s for s in bus if s["kind"] == "human-steer")
    assert steer["evidence"]["note"] == "Stop tuning ckpt selection." and steer["severity"] == "high"
    note = client.get(url("/steer")).json()["notes"][0]
    assert note["status"] == "drained" and note["drained_at"]
    assert note["picked_up_tick"] == 4  # drained while tick 4 runs


def test_steer_validation_and_disable(viz, tmp_path: Path) -> None:
    client, run, _ = viz
    assert client.post(url("/steer"), json={"note": "  ", "author": "x"}).status_code == 422
    assert client.post(url("/steer"), json={"note": "ok", "author": "x", "axis": "governance"}).status_code == 422
    assert not (run / "signals-inbox.jsonl").exists()
    from fastapi.testclient import TestClient

    from evor.dashboard.server import create_app

    locked = TestClient(create_app(run.parent.parent.parent, allow_steer=False))
    assert locked.post(url("/steer"), json={"note": "hi", "author": "x"}).status_code == 403
    assert locked.get(url("/steer")).json()["enabled"] is False


# ── export ────────────────────────────────────────────────────────────────────


def test_export_cli_writes_one_self_contained_file(tmp_path: Path) -> None:
    import re

    run = build_viz_run(tmp_path / ".evor")
    before = _tree_state(run)
    out = tmp_path / "share" / "snap.html"
    harness = Path(__file__).resolve().parents[1]
    proc = subprocess.run([sys.executable, "-m", "evor.dashboard", "--run-dir", str(run), "--export", str(out)],
                          cwd=harness, capture_output=True, text=True, timeout=120)
    assert proc.returncode == 0, proc.stderr
    assert _tree_state(run) == before  # export never writes into the run
    html = out.read_text()
    m = re.search(r'<script id="evor-snapshot" type="application/json">(.*?)</script>', html, re.S)
    assert m, "snapshot JSON not inlined"
    snap = json.loads(m.group(1))
    assert snap["steer_enabled"] is False
    assert set(snap["evidence"]) >= {"u-e42", "u-b42"}
    assert snap["evidence"]["u-e42"]["samples"][0]["data_uri"].startswith("data:image/png;base64,")
    assert "</script> robustly" not in m.group(1)  # data cannot close the script tag early
    assert "Binarize documents <\\/script> robustly" in m.group(1)
    assert html.count("<!--EVOR_SNAPSHOT-->") == 0
    # The only external fetches are the pinned d3 build and the font stylesheet.
    srcs = re.findall(r'<script[^>]+src="([^"]+)"', html)
    assert srcs == ["https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js"]


def test_export_requires_specific_run(tmp_path: Path) -> None:
    root = tmp_path / ".evor"
    build_viz_run(root)
    harness = Path(__file__).resolve().parents[1]
    proc = subprocess.run([sys.executable, "-m", "evor.dashboard", "--run-dir", str(root), "--export", str(tmp_path / "x.html")],
                          cwd=harness, capture_output=True, text=True, timeout=60)
    assert proc.returncode != 0 and "specific run" in proc.stderr


# ── opt-in: a copy of a real run ──────────────────────────────────────────────


@pytest.mark.skipif(not os.environ.get("EVOR_DASHBOARD_LIVE_RUN"), reason="set EVOR_DASHBOARD_LIVE_RUN to a run dir")
def test_live_run_copy(tmp_path: Path) -> None:
    src = Path(os.environ["EVOR_DASHBOARD_LIVE_RUN"]).resolve()
    dst = tmp_path / ".evor" / "runs" / src.parent.name / src.name
    shutil.copytree(src, dst, ignore=shutil.ignore_patterns("frozen-splits", "jobs", "*.ckpt", "*.pt"))
    from fastapi.testclient import TestClient

    from evor.dashboard.server import create_app

    client = TestClient(create_app(tmp_path / ".evor", default_run_dir=dst, steer_token=TOKEN), headers={"X-Evor-Steer-Token": TOKEN})
    base = f"/api/runs/{src.parent.name}/{src.name}"
    t = time.time()
    b = client.get(f"{base}/bundle").json()
    assert time.time() - t < 10
    assert b["recipes"] and b["timeline"] and b["points"]
    for p in b["points"][:5]:
        assert client.get(f"{base}/nodes/{p['id']}/evidence").status_code == 200
    r = client.post(f"{base}/steer", json={"note": "copy-run steer test", "author": "pytest"})
    assert r.status_code == 201
    steers = [json.loads(l) for l in (dst / "signals-inbox.jsonl").read_text().splitlines() if "human-steer" in l]
    assert [s["evidence"]["note"] for s in steers] == ["copy-run steer test"]
    assert not (src / "signals-inbox.jsonl").exists() or "copy-run steer test" not in (src / "signals-inbox.jsonl").read_text()


def test_uvicorn_app_attribute_reads_env(tmp_path: Path, monkeypatch) -> None:
    run = build_viz_run(tmp_path / ".evor")
    monkeypatch.setenv("EVOR_RUN_DIR", str(run))
    monkeypatch.setenv("EVOR_DASHBOARD_NO_STEER", "1")
    from fastapi.testclient import TestClient

    from evor.dashboard import server

    client = TestClient(server._app_from_env())
    assert client.get("/api/runs").json()[0]["default"] is True
    assert client.post(url("/steer"), json={"note": "x", "author": "y"}).status_code == 403


# ── robustness (review findings) ──────────────────────────────────────────────


def test_non_finite_and_odd_shapes_do_not_break_bundle_or_export(tmp_path: Path) -> None:
    from fastapi.testclient import TestClient

    from evor.dashboard.export import build_snapshot, render_snapshot_html
    from evor.dashboard.server import create_app

    run = build_viz_run(tmp_path / ".evor")
    tree = json.loads((run / "tree.json").read_text())
    tree["nodes"]["u-e7"]["config"] = "not-a-dict"
    tree["nodes"]["u-e7"]["metrics"] = ["odd"]
    tree["nodes"]["u-e123"]["config"] = {"seed": 0}
    (run / "tree.json").write_text(json.dumps(tree))
    (run / "nodes/u-e42/results.json").write_text(
        '{"fitness_value": 0.04, "metrics": {"fmeasure": NaN, "vram": Infinity}, "per_domain": {"a": {"S": NaN}, "b": "x"}}')
    (run / "nodes/u-b7/results.json").write_text('{"fitness_value": 0.022, "per_domain": ["not", "a", "dict"]}')
    client = TestClient(create_app(tmp_path / ".evor"))
    assert client.get(url("/bundle")).status_code == 200
    ev = client.get(url("/nodes/u-e42/evidence")).json()
    assert ev["metrics"]["fmeasure"] is None and ev["metrics"]["vram"] is None
    assert client.get(url("/nodes/u-e7/evidence")).status_code == 200
    ema = _recipe(client.get(url("/recipes")).json(), "ema")
    assert next(m for m in ema["members"] if m["id"] == "u-e123")["seed"] == "0"
    render_snapshot_html(build_snapshot(run))  # allow_nan=False must not raise


def test_lower_is_better_flips_best_and_lucky(tmp_path: Path) -> None:
    from evor.dashboard.insights import RunInsights

    run = build_viz_run(tmp_path / ".evor")
    gc = json.loads((run / "goal-contract.json").read_text())
    gc["metric_specs"] = json.dumps([{"metric_name": "error", "direction": "lower", "role": "primary_fitness"}])
    (run / "goal-contract.json").write_text(json.dumps(gc))
    ins = RunInsights(run)
    assert ins.best_node()["name"] == "ema-s123-01"            # lowest credible fitness
    ema = next(r for r in ins.recipes() if r["label"] == "ema")
    lucky = [m["name"] for m in ema["members"] if "lucky-seed" in m["badges"]]
    assert lucky == ["ema-s123-01"]
    assert ins.progress()[-1]["best_node"]["name"] == "ema-s123-01"


def test_run_path_traversal_and_cross_origin_steer_rejected(viz) -> None:
    client, run, _ = viz
    assert client.get(f"/api/runs/..%2F..%2F/{RUN}/bundle").status_code == 404
    assert client.get(f"/api/runs/{MISSION}/..%2F{MISSION}%2F{RUN}/bundle").status_code == 404
    r = client.post(url("/steer"), json={"note": "x", "author": "y"}, headers={"Origin": "http://evil.example"})
    assert r.status_code == 403
    assert not (run / "signals-inbox.jsonl").exists()
    ok = client.post(url("/steer"), json={"note": "x", "author": "y"}, headers={"Origin": "http://testserver"})
    assert ok.status_code == 201


# ── node-level artefacts, steer token, run listing ────────────────────────────


def test_recipe_is_artefact_only_when_every_seed_is_tagged(tmp_path: Path) -> None:
    from evor.dashboard.insights import RunInsights

    run = build_viz_run(tmp_path / ".evor")
    (run / "wiki/lesson-band-s7.md").write_text(
        "# Lesson: lesson-band-s7\n\n**Node:** band-s7-01  |  **Run:**   |  **Mission:** \n**Family:** training  |  **Verdict:** refuted\n"
        "**Created:** 2026-10-30T00:00:00Z\n\n## Actionable Lesson\n\nErasure again.\n\n**Tags:** metric-artefact\n")
    ins = RunInsights(run)
    band = next(r for r in ins.recipes() if r["label"] == "band")
    assert band["verdict"] == "artefact" and band["median"] is None and band["credible"] is False
    assert all(p["artefact"] for p in ins.points() if p["name"].startswith("band"))
    assert ins.overview()["robust_best"]["label"] == "alt"


def test_steer_token_required(tmp_path: Path) -> None:
    from fastapi.testclient import TestClient

    from evor.dashboard.server import create_app

    run = build_viz_run(tmp_path / ".evor")
    app = create_app(tmp_path / ".evor", steer_token=TOKEN)
    client = TestClient(app)
    body = {"note": "Try a recall floor.", "author": "dai"}
    assert client.post(url("/steer"), json=body).status_code == 401
    assert client.post(url("/steer"), json=body, headers={"X-Evor-Steer-Token": "wrong"}).status_code == 401
    assert client.post(url("/steer"), json=dict(body, token="wrong")).status_code == 401
    assert not (run / "signals-inbox.jsonl").exists()
    assert client.post(url("/steer"), json=body, headers={"X-Evor-Steer-Token": TOKEN}).status_code == 201
    assert client.post(url("/steer"), data=dict(body, token=TOKEN)).status_code == 201       # form field
    assert client.post(url("/steer"), json=dict(body, token=TOKEN)).status_code == 201       # JSON field
    lines = (run / "signals-inbox.jsonl").read_text().splitlines()
    assert len(lines) == 3 and all(TOKEN not in l for l in lines)   # the token is never written
    assert client.get(url("/steer")).json()["token_required"] is True


def test_generated_token_is_random_and_printed_once(tmp_path: Path, capsys) -> None:
    from evor.dashboard.server import _announce_token, create_app

    build_viz_run(tmp_path / ".evor")
    a, b = create_app(tmp_path / ".evor"), create_app(tmp_path / ".evor")
    assert a.state.steer_token and a.state.steer_token != b.state.steer_token and len(a.state.steer_token) >= 20
    _announce_token(a)
    out = capsys.readouterr().out
    assert out.count(a.state.steer_token) == 1
    assert create_app(tmp_path / ".evor", allow_steer=False).state.steer_token is None


def test_run_listing_skips_non_run_folders(tmp_path: Path) -> None:
    from fastapi.testclient import TestClient

    from evor.dashboard.server import create_app

    root = tmp_path / ".evor"
    build_viz_run(root)
    (root / "runs" / MISSION / "jobs" / "abc").mkdir(parents=True)
    runs = TestClient(create_app(root)).get("/api/runs").json()
    assert [r["run_id"] for r in runs] == [RUN]


def test_headline_robust_best_skips_suspect_recipes(tmp_path: Path) -> None:
    from evor.dashboard.insights import RunInsights

    run = build_viz_run(tmp_path / ".evor")
    # A third band seed gives the suspect band recipe two counted seeds
    # (s7 0.022, s123 0.030: median 0.026), beating alt's 0.013.
    tree = json.loads((run / "tree.json").read_text())
    s123 = dict(tree["nodes"]["u-b7"], id="u-b123", name="band-s123-01", fitness_value=0.030)
    tree["nodes"]["u-b123"] = s123
    (run / "tree.json").write_text(json.dumps(tree))
    (run / "nodes" / "u-b123").mkdir(parents=True)
    (run / "nodes" / "u-b123" / "results.json").write_text(json.dumps({"fitness_value": 0.030, "per_domain": {}}))
    ins = RunInsights(run)
    band = next(r for r in ins.recipes() if r["label"] == "band")
    assert band["suspect"] and band["median"] == pytest.approx(0.026)
    ov = ins.overview()
    assert ov["robust_best"]["label"] == "alt"
    assert ov["suspect_leader"]["label"] == "band"
    assert ov["suspect_note"].startswith("band leads on score") and "suspect" in ov["suspect_note"]
    assert all(p["robust_best"] is None or p["robust_best"]["label"] != "band" for p in ins.progress())
    # still shown everywhere else, flagged
    assert any(p["name"] == "band-s123-01" and p["suspect"] for p in ins.points())
    # without a suspect leader there is no note
    assert RunInsights(build_viz_run(tmp_path / "b" / ".evor")).overview()["suspect_note"] is None
