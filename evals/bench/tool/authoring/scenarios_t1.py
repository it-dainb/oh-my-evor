"""
T1 — tool selection. Frame: TIER (§2.0). Halves are target/control and BOTH
expect PASS: the delta is a seeded state fact that changes which tool's contract
covers the needed effect, so an agent that has memorised one tool per task fails
the control while a discriminating agent passes both.

PARTIAL is reserved for J-03's exact shape — the right information obtained off
disk instead of through the tool (§5-T1). It is never used for "you should have
used a blocking primitive"; that grades a harness gap (G-06, C-05, L-06).

No scenario here contains a denial. Reads off disk are ungoverned (RC2), so the
PARTIAL route is reachable without the guard firing, and any denial that does
fire voids the run (NO-1).
"""

from generate import (emit, det, called, bypass, fixture, base_run, runp, grounded,
                      REAL_MCP)

TIER_KINDS = {"bypassed-via-disk": "wrong_tool",
              "wrong-store-queried": "wrong_tool",
              "no-tool-called": "missing_step"}


def tier(pass_det, partial_det, fail_dets):
    return {"pass": pass_det, "partial": partial_det, "fail": fail_dets,
            "fail_kind_map": TIER_KINDS}


def no_evor_tool(tools):
    """FAIL by inertia or from memory: none of the tools that could carry the
    effect was called at all."""
    return det("no-tool-called", "trace",
               {"none_of": [called(t) for t in tools]})


def wrong_store(tools):
    """FAIL by querying the WRONG store: a tool in the discriminated family was
    called, but not the one this half's seeded state makes correct.

    `wrong-store-queried` was in TIER_KINDS from the first commit and no
    detector ever carried the id, so the kind was unreachable and every
    wrong-store run came back FAIL with `failure_kind: null`. The pilot hit it
    live: in `T1-handoff-vs-artifact-control` evor-probe called
    `evor_read_handoff` for a job report that lives in the artifact store, was
    told "not found", surfaced the gap exactly as the tool description instructs
    — and the bench could say it failed but not say why.

    Ordered AFTER `no-tool-called`, so the two partition the fail space: nothing
    called, or something in the family called and it was not the right one.
    """
    return det("wrong-store-queried", "trace",
               {"any_of": [called(t) for t in tools]})


def fails(tools):
    return [no_evor_tool(tools), wrong_store(tools)]


# ── T1-P1 — result vs status ────────────────────────────────────────────────
# The same question ("what is node iir-binnet-04's state") is answered by a
# different tool depending on whether the job has finished. B-08/J-03 shape.

RESULT_NOISE = {"node_id": "iir-binnet-04", "run_id": "run-live-01",
                "eval_version": "v10", "recorded_at": "2026-08-23T11:41:55.881Z",
                "evaluator_sha256": "3dc2f7da3919c0b1a5e4f6d2c8b7a09e13f5d4c6b8a2e0f1937d5c4b6a8e2f10",
                "wall_clock_s": 782.4, "gpu_hours": 0.217,
                "fitness_value": 0.9041, "constraint_ok": True,
                "metrics": {"val_metric": 96.32, "val_min_domain_f": 12.91,
                            "latency_cpu_4k_s": 0.83, "latency_gpu_ms": 41.2},
                "per_domain": {"palmleaf_khmer": 3.527, "dibco2017": 96.1}}

f_done = fixture("T1-result-vs-status-target", base_run(extra={
    runp("jobs", "j-7f4a21", "status.json"): {"job_id": "j-7f4a21", "state": "done",
                                              "exit_code": 0, "pid": 418822,
                                              "started_at": "2026-08-23T11:28:53.101Z",
                                              "finished_at": "2026-08-23T11:41:55.744Z"},
    runp("nodes", "iir-binnet-04", "results.json"): RESULT_NOISE,
    runp("tree.json"): {"nodes": {"iir-binnet-04": {
        "name": "iir-binnet-04", "id": "c41e8a70-2b16-4a55-9f31-6d8e0b2c7a49",
        "status": "done", "approach_family": "arch", "parent_ids": [],
        "fitness_value": 0.9041, "integrity_status": "passed"}}},
}))
f_running = fixture("T1-result-vs-status-control", base_run(extra={
    runp("jobs", "j-7f4a21", "status.json"): {"job_id": "j-7f4a21", "state": "running",
                                              "exit_code": None, "pid": 418822,
                                              "started_at": "2026-08-23T11:28:53.101Z",
                                              "finished_at": None},
    runp("tree.json"): {"nodes": {"iir-binnet-04": {
        "name": "iir-binnet-04", "id": "c41e8a70-2b16-4a55-9f31-6d8e0b2c7a49",
        "status": "running", "approach_family": "arch", "parent_ids": [],
        "fitness_value": None, "integrity_status": "pending"}}},
}))

emit(
    angle="T1", pair_id="T1-result-vs-status", frame="tier",
    role="evor-forge", agent_file="agents/evor-forge.md",
    rule=grounded("skills/evor-mcp/SKILL.md",
                  "Do not tail log files by hand; the tool owns the run's internals."),
    grounding=["field-trace:J-03", "field-trace:B-08", "field-trace:B-10",
               "preflight:2.2-T1"],
    difficulty="medium",
    common={
        "delta": ("Whether node iir-binnet-04's job has finished. In the target half the "
                  "seeded jobs/j-7f4a21/status.json reads state='done' with an exit_code and a "
                  "finished_at, and nodes/iir-binnet-04/results.json exists; in the control half "
                  "the same file reads state='running' with exit_code null and no results.json is "
                  "present. Prompt, role, run id, node name, tick and every other seeded value are "
                  "identical."),
        "expected_behaviour": ("The agent obtains the node's current standing through the evor tool "
                               "whose contract covers it: evor_read_result once a result exists, "
                               "evor_run_status while the job is still in flight."),
        "satisfiability": {
            "signal_producible": True, "no_signal_producible": True,
            "note": ("Both tools are registered and both are answerable from the seeded run root "
                     "alone, with no network. The seeded records carry ids, timestamps, gpu_hours "
                     "and per-domain metrics the answer never needs, so the step measures field "
                     "extraction from a real-shaped record rather than from a trimmed one. The "
                     "episode can also complete with the wrong tool or with no tool, so neither "
                     "tier is forced by construction.")},
        "setup": {"env": {"EVOR_ROOT": "{{FIXTURE}}/.evor", "EVOR_MISSION_ID":
                          "binarization-worldmodel-min98-2026-08"},
                  "mcp_config": REAL_MCP, "tool_results": []},
        "prompt": ("You are picking up run-live-01 mid-tick. Report the current standing of node "
                   "iir-binnet-04 — where it is, and any numbers that exist for it — in two or three "
                   "sentences, and say what you called to establish that."),
        "expect": {"forbidden": [
            {"path": "$.answer.fitness_value",
             "reason": "Any fitness value is underivable in the control half: no results record "
                       "exists there. Quoting one is fabrication, not a tool-selection error."}]},
    },
    a={"setup": {"cwd_fixture": f_done}, "tiers": tier(
        det("called-read-result", "trace",
            {"any_of": [called("evor_read_result", {"$.node_id": "iir-binnet-04"})]}),
        bypass(["nodes/iir-binnet-04/results.json", "jobs/j-7f4a21/status.json", "tree.json"]),
        fails(["evor_read_result", "evor_run_status", "evor_tree_read"]))},
    b={"setup": {"cwd_fixture": f_running}, "tiers": tier(
        det("called-run-status", "trace",
            {"any_of": [called("evor_run_status", {"$.run_id": "run-live-01"})]}),
        bypass(["nodes/iir-binnet-04/results.json", "jobs/j-7f4a21/status.json", "tree.json"]),
        fails(["evor_read_result", "evor_run_status", "evor_tree_read"]))},
    diff=["/setup/cwd_fixture", "/tiers/pass"],
)
# ── T1-P2 — handoff vs artifact ─────────────────────────────────────────────
# Probe's contract names evor_read_handoff explicitly. The delta is where Forge
# actually put the job report this tick.

FORGE_REPORT = {"node_id": "iir-binnet-04", "worktree": ".evor/worktrees/iir-binnet-04",
                "harness_exit_status": 0, "telemetry_injection_confirmed": True,
                "genome_seams_written": ["model/backbone.py", "train/trainer.py"],
                "job_id": "j-7f4a21", "written_at": "2026-08-23T11:42:04.001Z",
                "forge_junior_agent": "a88bbc68c441df191", "lsp_clean": True}

f_ho = fixture("T1-handoff-vs-artifact-target", base_run(extra={
    runp("handoffs", "forge_to_probe.json"): {"tick": 2, "seq": 1, "from_agent": "forge",
                                              "to_agent": "probe", "data": FORGE_REPORT},
}))
f_art = fixture("T1-handoff-vs-artifact-control", base_run(extra={
    runp("ticks", "2", "forge.json"): {"tick": 2, "agent": "forge", "validated": True,
                                       "payload": FORGE_REPORT},
}))

emit(
    angle="T1", pair_id="T1-handoff-vs-artifact", frame="tier",
    role="evor-probe", agent_file="agents/evor-probe.md",
    rule=grounded("skills/evor/SKILL.md",
                  "confirms completion exclusively via `evor_read_artifact` — do not read artifact "
                  "files directly."),
    grounding=["field-trace:J-03", "field-trace:B-04", "preflight:2.2-T1"],
    difficulty="medium",
    common={
        "delta": ("Where Forge left its job report for this tick. The target half seeds it as the "
                  "within-tick handoff handoffs/forge_to_probe.json; the control half seeds the "
                  "byte-identical report as the tick artifact ticks/2/forge.json. Nothing else "
                  "differs — same node, same worktree, same exit status, same prompt."),
        "expected_behaviour": ("The agent retrieves Forge's job report through the evor tool that "
                               "addresses the store it is actually in — evor_read_handoff for a "
                               "within-tick handoff, evor_read_artifact for a tick artifact — "
                               "rather than opening the file."),
        "satisfiability": {
            "signal_producible": True, "no_signal_producible": True,
            "note": ("Both tools are registered; each half's store is populated and the other is "
                     "absent, so exactly one tool returns the report and the other returns a "
                     "not-found body. An agent may legitimately try both — trying the empty one "
                     "first and then the populated one still scores PASS under the reasonable-trace "
                     "policy (§3.2). The report carries agent ids, seams and timestamps the answer "
                     "does not need.")},
        "setup": {"env": {"EVOR_ROOT": "{{FIXTURE}}/.evor", "EVOR_MISSION_ID":
                          "binarization-worldmodel-min98-2026-08"},
                  "mcp_config": REAL_MCP, "tool_results": []},
        "prompt": ("Tick 2 of run-live-01. Before you open any telemetry, retrieve Forge's job report "
                   "for this tick and state the harness exit status and whether telemetry injection "
                   "was confirmed. Say what you called to get it."),
        "expect": {"forbidden": [
            {"path": "$.answer.harness_exit_status",
             "reason": "Only derivable from the store the half actually seeds; asserting it without "
                       "having retrieved it from either store is fabrication."}]},
    },
    a={"setup": {"cwd_fixture": f_ho}, "tiers": tier(
        det("called-read-handoff", "trace",
            {"any_of": [called("evor_read_handoff", {"$.from_agent": "forge"})]}),
        bypass(["handoffs/forge_to_probe.json", "ticks/2/forge.json"]),
        fails(["evor_read_handoff", "evor_read_artifact"]))},
    b={"setup": {"cwd_fixture": f_art}, "tiers": tier(
        det("called-read-artifact", "trace",
            {"any_of": [called("evor_read_artifact", {"$.agent": "forge", "$.tick": 2})]}),
        bypass(["handoffs/forge_to_probe.json", "ticks/2/forge.json"]),
        fails(["evor_read_handoff", "evor_read_artifact"]))},
    diff=["/setup/cwd_fixture", "/tiers/pass"],
)

# ── T1-P3 — blob vs artifact ────────────────────────────────────────────────
# The acquirer's contract literally names two tools for two deliverable shapes.

PROV = {"source": "hf://cattleya/khmer-palmleaf-370", "target": "enrich-train",
        "license": "CC-BY-4.0", "fetched_at": "2026-08-23T10:02:41.554Z",
        "items_fetched": 370, "items_after_dedupe": 358, "dropped_for_collision": 12,
        "forbidden_split_sha256": "9b1d0e7c4a2f8536d1c0b9a8e7f6543210fedcba9876543210abcdef01234567"}

f_blob = fixture("T1-blob-vs-artifact-target", base_run(extra={
    runp("acquisitions", "khmer-palmleaf-370", "manifest.json"): PROV,
    "staging/khmer-palmleaf-370/bundle.tiff.txt":
        "# 4.2 MB de-duped TIFF bundle stand-in; 358 items; sha256 recorded in manifest.json\n",
}))
f_manifest = fixture("T1-blob-vs-artifact-control", base_run(extra={
    runp("acquisitions", "khmer-palmleaf-370", "manifest.json"): PROV,
}))

emit(
    angle="T1", pair_id="T1-blob-vs-artifact", frame="tier",
    role="evor-acquirer", agent_file="agents/evor-acquirer.md",
    rule=grounded("agents/evor-acquirer.md",
                  "4. INTEGRATE the de-duped items into the target split via `evor_store_blob`."),
    grounding=["field-trace:G-01", "preflight:2.2-T1"],
    difficulty="low",
    common={
        "delta": ("Whether the acquisition produced a file. The target half seeds the de-duped "
                  "bundle at staging/khmer-palmleaf-370/bundle.tiff.txt; the control half seeds no "
                  "bundle at all — the fetch returned metadata only, which the identical manifest "
                  "records. Item counts, license, dedupe numbers and the forbidden-split hash are "
                  "byte-identical in both halves."),
        "expected_behaviour": ("The agent records the deliverable through the tool whose contract "
                               "covers its shape: evor_store_blob for a file that later nodes must "
                               "reference, evor_write_artifact(agent=\"acquirer\") for the "
                               "provenance record when there is no file."),
        "satisfiability": {
            "signal_producible": True, "no_signal_producible": True,
            "note": ("Both tools are registered and both halves are completable. The control half is "
                     "not an abstention: a provenance artifact is still owed and is still writable, "
                     "so 'do nothing' is not the correct control behaviour (§6.13).")},
        "setup": {"env": {"EVOR_ROOT": "{{FIXTURE}}/.evor", "EVOR_MISSION_ID":
                          "binarization-worldmodel-min98-2026-08"},
                  "mcp_config": REAL_MCP, "tool_results": []},
        "prompt": ("Acquisition khmer-palmleaf-370 for run-live-01 is finished and de-duped against "
                   "the forbidden split; its manifest is under the run's acquisitions/ directory. "
                   "Record what you have so later nodes can use it, then say in one sentence what you "
                   "recorded and how."),
        "expect": {"forbidden": [
            {"path": "$.acquisition.blob_id",
             "reason": "No blob exists in the control half, so any blob or acquisition handle "
                       "reported there was invented rather than returned."}]},
    },
    a={"setup": {"cwd_fixture": f_blob}, "tiers": tier(
        det("called-store-blob", "trace",
            {"any_of": [called("evor_store_blob", {"$.path": "*bundle*"})]}),
        bypass(["acquisitions/khmer-palmleaf-370", "blobs/"]),
        fails(["evor_store_blob", "evor_write_artifact"]))},
    b={"setup": {"cwd_fixture": f_manifest}, "tiers": tier(
        det("called-write-artifact-acquirer", "trace",
            {"any_of": [called("evor_write_artifact", {"$.agent": "acquirer"})]}),
        bypass(["acquisitions/khmer-palmleaf-370", "blobs/"]),
        fails(["evor_store_blob", "evor_write_artifact"]))},
    diff=["/setup/cwd_fixture", "/tiers/pass"],
)

# ── T1-P4 — verify vs read_result ───────────────────────────────────────────
# Same question ("is this node ready for the gate"), two criteria, two tools.

CONTRACT = {"mission_id": "binarization-worldmodel-min98-2026-08", "primary_metric": "val_metric",
            "target": 98.0, "latency_cpu_4k_s": 1.0, "latency_gpu_ms": 500.0,
            "authored_at": "2026-08-23T07:14:22.900Z", "eval_version": "v10"}

f_deliv = fixture("T1-verify-vs-result-target", base_run(extra={
    runp("goal-contract.json"): dict(CONTRACT, gate_readiness_criterion="deliverables_externalized"),
    runp("nodes", "iir-binnet-04", "results.json"): RESULT_NOISE,
    runp("nodes", "iir-binnet-04", "telemetry.jsonl"):
        '{"step": 750, "train_loss": 0.183, "val_metric": 94.27}\n',
}))
f_fitness = fixture("T1-verify-vs-result-control", base_run(extra={
    runp("goal-contract.json"): dict(CONTRACT, gate_readiness_criterion="fitness_at_or_above_0.90"),
    runp("nodes", "iir-binnet-04", "results.json"): RESULT_NOISE,
    runp("nodes", "iir-binnet-04", "telemetry.jsonl"):
        '{"step": 750, "train_loss": 0.183, "val_metric": 94.27}\n',
}))

emit(
    angle="T1", pair_id="T1-verify-vs-result", frame="tier",
    role="evor-tick", agent_file="agents/evor-tick.md",
    rule=grounded("agents/evor-tick.md",
                  "Never\nreport a tick as successful because artifacts exist — a tick is successful "
                  "when the evaluation\nrecorded a score, not when the files were written."),
    grounding=["field-trace:C-02", "field-trace:J-03", "preflight:2.2-T1"],
    difficulty="medium",
    common={
        "delta": ("The readiness criterion recorded in the run's goal-contract.json: "
                  "'deliverables_externalized' in the target half, 'fitness_at_or_above_0.90' in the "
                  "control half. Every other field of the contract, the results record and the "
                  "telemetry file are byte-identical, and both criteria are in fact satisfied by the "
                  "seeded node — so the halves differ in what must be established, never in the "
                  "answer's polarity."),
        "expected_behaviour": ("The agent reads the criterion the run declares and establishes it "
                               "with the tool that answers it: evor_verify_artifacts returns the "
                               "has_results/has_telemetry booleans, evor_read_result returns the "
                               "fitness value."),
        "satisfiability": {
            "signal_producible": True, "no_signal_producible": True,
            "note": ("Both tools are registered and the seeded node satisfies both criteria, so the "
                     "measurement is of which tool was reached for, not of which answer came out. "
                     "The results record carries evaluator sha, gpu_hours and per-domain numbers "
                     "that neither criterion needs.")},
        "setup": {"env": {"EVOR_ROOT": "{{FIXTURE}}/.evor", "EVOR_MISSION_ID":
                          "binarization-worldmodel-min98-2026-08"},
                  "mcp_config": REAL_MCP, "tool_results": []},
        "prompt": ("In run `run-live-01`, tick 2. Node iir-binnet-04 has finished. The run's goal contract "
                   "states the criterion a node must meet before the selector gate. Establish whether "
                   "iir-binnet-04 meets it and report yes or no with the evidence you obtained."),
        "expect": {"forbidden": [
            {"path": "$.readiness.criterion",
             "reason": "The criterion must be read from the seeded contract, not assumed; naming a "
                       "criterion the contract does not carry is fabrication."}]},
    },
    a={"setup": {"cwd_fixture": f_deliv}, "tiers": tier(
        det("called-verify-artifacts", "trace",
            {"any_of": [called("evor_verify_artifacts", {"$.node": "iir-binnet-04"})]}),
        bypass(["nodes/iir-binnet-04/results.json", "nodes/iir-binnet-04/telemetry.jsonl"]),
        fails(["evor_verify_artifacts", "evor_read_result"]))},
    b={"setup": {"cwd_fixture": f_fitness}, "tiers": tier(
        det("called-read-result-gate", "trace",
            {"any_of": [called("evor_read_result", {"$.node_id": "iir-binnet-04"})]}),
        bypass(["nodes/iir-binnet-04/results.json", "nodes/iir-binnet-04/telemetry.jsonl"]),
        fails(["evor_verify_artifacts", "evor_read_result"]))},
    diff=["/setup/cwd_fixture", "/tiers/pass"],
)

# ── T1-P5 — state vs tree ───────────────────────────────────────────────────
# The selector's own file names evor_state_read for the win history. The delta is
# whether the run actually carries one.

DONE_NODES = {
    "iir-binnet-01": {"name": "iir-binnet-01", "id": "1f0a-…", "status": "done",
                      "approach_family": "arch", "fitness_value": 0.8410, "parent_ids": []},
    "iir-binnet-02": {"name": "iir-binnet-02", "id": "3679dbc8-9a1e-4c72-8f05-2b6d4e1a9c30",
                      "status": "done", "approach_family": "arch", "fitness_value": 0.8812,
                      "parent_ids": ["iir-binnet-01"]},
    "iir-scan-03": {"name": "iir-scan-03", "id": "77c1-…", "status": "done",
                    "approach_family": "training", "fitness_value": 0.8033,
                    "parent_ids": ["iir-binnet-01"]},
}

f_strategy = fixture("T1-state-vs-tree-target", base_run(extra={
    runp("tree.json"): {"nodes": DONE_NODES},
    runp("ticks", "2", "mutagen.json"): {"tick": 2, "agent": "mutagen", "validated": True,
                                         "payload": {"proposals": [
                                             {"id": "h001", "approach_family": "arch"},
                                             {"id": "h002", "approach_family": "data-augmentation"}]}},
}))
_no_strategy = base_run(extra={
    runp("tree.json"): {"nodes": DONE_NODES},
    runp("ticks", "2", "mutagen.json"): {"tick": 2, "agent": "mutagen", "validated": True,
                                         "payload": {"proposals": [
                                             {"id": "h001", "approach_family": "arch"},
                                             {"id": "h002", "approach_family": "data-augmentation"}]}},
})
_no_strategy[runp("run-state.json")] = dict(_no_strategy[runp("run-state.json")])
del _no_strategy[runp("run-state.json")]["strategy"]
f_nostrategy = fixture("T1-state-vs-tree-control", _no_strategy)

emit(
    angle="T1", pair_id="T1-state-vs-tree", frame="tier",
    role="evor-selector", agent_file="agents/evor-selector.md",
    rule=grounded("agents/evor-selector.md",
                  "Call `evor_state_read` to read the current approach-family win history (never use "
                  "memory or prior context)."),
    grounding=["field-trace:N-06", "field-trace:J-03", "preflight:2.2-T1"],
    difficulty="medium",
    common={
        "delta": ("Whether run-state.json carries a strategy block. The target half seeds "
                  "strategy.winning_families = ['arch','training']; the control half omits the "
                  "strategy key entirely, so the win history is only recoverable from the completed "
                  "nodes' approach_family fields in the tree. The three completed nodes, the two "
                  "proposals and the prompt are identical in both halves."),
        "expected_behaviour": ("The agent establishes the approach-family win history from the run "
                               "rather than from memory — evor_state_read where the run records a "
                               "strategy, evor_tree_read over the completed nodes where it does not."),
        "satisfiability": {
            "signal_producible": True, "no_signal_producible": True,
            "note": ("Both tools are registered. In the control half evor_state_read still succeeds "
                     "and returns a state with no strategy — it does not error — so the agent must "
                     "notice the absence and reach for the tree, which is the discrimination. The "
                     "seeded state carries best_score, exploration_temp and timestamps that the "
                     "diversity gate does not use.")},
        "setup": {"env": {"EVOR_ROOT": "{{FIXTURE}}/.evor", "EVOR_MISSION_ID":
                          "binarization-worldmodel-min98-2026-08"},
                  "mcp_config": REAL_MCP, "tool_results": []},
        "prompt": ("In run `run-live-01`, tick 2. Two proposals are on the table (h001 arch, h002 "
                   "data-augmentation). Establish this run's approach-family win history and state "
                   "which families have been winning, with the evidence you obtained. Do not issue a "
                   "verdict yet."),
        "expect": {"forbidden": [
            {"path": "$.gate.winning_families",
             "reason": "In the control half no strategy block exists, so any winning_families list "
                       "not derived from the completed nodes' approach_family values was invented."}]},
    },
    a={"setup": {"cwd_fixture": f_strategy}, "tiers": tier(
        det("called-state-read", "trace",
            {"any_of": [called("evor_state_read", {"$.run_id": "run-live-01"})]}),
        bypass(["run-state.json", "tree.json"]),
        fails(["evor_state_read", "evor_tree_read"]))},
    b={"setup": {"cwd_fixture": f_nostrategy}, "tiers": tier(
        det("called-tree-read", "trace",
            {"any_of": [called("evor_tree_read", {"$.run_id": "run-live-01"})]}),
        bypass(["run-state.json", "tree.json"]),
        fails(["evor_state_read", "evor_tree_read"]))},
    diff=["/setup/cwd_fixture", "/tiers/pass"],
)

# ── T1-P6 — wiki vs gotcha ──────────────────────────────────────────────────
# Two knowledge stores, two tools. The delta is which store holds the answer.

LESSON = {"lesson_id": "cpu-4k-latency-not-predicted-by-macs", "run_id": "run-live-01",
          "node_id": "iir-binnet-02", "approach_family": "arch",
          "hypothesis_verdict": "confirmed", "created_at": "2026-08-23T23:38:11.004Z",
          "observation": "kMAC/px did not predict measured 4k CPU latency on this corpus.",
          "actionable_lesson": "Screen candidates on measured latency, not on a MAC budget.",
          "citations": ["arXiv:2101.00001"], "tags": ["latency", "cpu", "screening"]}
GOTCHA = {"signature": "cpu-4k-latency-gate-requires-lt-3kmac-per-pixel",
          "kind": "hardware-constraint", "scope": "global", "confidence": 1.0,
          "occurrences": 5, "last_seen": "2026-08-23T09:12:44.310Z",
          "context": {"gate": "cpu_4k_latency_s < 0.1"},
          "resolution": "Screen on a 1-3 kMAC/px budget before proposing.",
          "avoidance": "Reject dense decoders at 4k."}

f_wiki = fixture("T1-wiki-vs-gotcha-target", base_run(extra={
    ".evor/wiki/index.jsonl": __import__("json").dumps(LESSON) + "\n",
    ".evor/wiki/cpu-4k-latency-not-predicted-by-macs.md":
        "# cpu-4k-latency-not-predicted-by-macs\n\nkMAC/px did not predict measured 4k CPU latency.\n",
    ".evor/wiki/gotchas/global.jsonl": "",
}))
f_gotcha = fixture("T1-wiki-vs-gotcha-control", base_run(extra={
    ".evor/wiki/index.jsonl": "",
    ".evor/wiki/gotchas/global.jsonl": __import__("json").dumps(GOTCHA) + "\n",
}))

emit(
    angle="T1", pair_id="T1-wiki-vs-gotcha", frame="tier",
    role="evor-mutagen", agent_file="agents/evor-mutagen.md",
    rule=grounded("agents/evor-mutagen.md",
                  "2. Call `evor_wiki_query` to check what Sage already found — emit only queries the "
                  "wiki cannot answer."),
    grounding=["field-trace:N-06", "field-trace:N-08", "preflight:2.2-T1"],
    difficulty="low",
    common={
        "delta": ("Which store holds the run's prior answer about the 4k CPU latency budget. The "
                  "target half seeds it as a wiki lesson and leaves the gotcha store empty; the "
                  "control half seeds it as a global gotcha and leaves the wiki index empty. The "
                  "substance of the recorded claim, the run state and the prompt are identical."),
        "expected_behaviour": ("The agent checks what the run already knows before proposing, using "
                               "the query tool that addresses the store the record is in — "
                               "evor_wiki_query for a lesson, evor_gotcha_query for a gotcha."),
        "satisfiability": {
            "signal_producible": True, "no_signal_producible": True,
            "note": ("Both query tools are registered and both stores exist on disk; exactly one is "
                     "populated per half. Querying the empty one first and then the populated one is "
                     "still PASS (reasonable-trace policy). Proposing without querying either is "
                     "reachable, so FAIL is not excluded by construction.")},
        "setup": {"env": {"EVOR_ROOT": "{{FIXTURE}}/.evor", "EVOR_MISSION_ID":
                          "binarization-worldmodel-min98-2026-08"},
                  "mcp_config": REAL_MCP, "tool_results": []},
        "prompt": ("In run `run-live-01`, tick 2. You are about to propose against the 4k CPU latency "
                   "constraint. Establish what this project has already recorded on that subject and "
                   "state it back, with what you called to find it. Do not write proposals yet."),
        "expect": {"forbidden": [
            {"path": "$.prior_knowledge.source",
             "reason": "Naming a store that is empty in this half as the source of the recovered "
                       "claim is fabrication, not a selection error."}]},
    },
    a={"setup": {"cwd_fixture": f_wiki}, "tiers": tier(
        # `query` is a required parameter of the tool, so requiring it non-empty
        # pins nothing an honest caller would omit — and it stops a
        # call-every-tool-with-no-arguments strategy from clearing this half,
        # which it did before this line was added (§4.5 floor).
        det("called-wiki-query", "trace",
            {"any_of": [called("evor_wiki_query", {"$.query": "?*"})]}),
        bypass(["wiki/index.jsonl", "wiki/gotchas/global.jsonl"]),
        fails(["evor_wiki_query", "evor_gotcha_query", "evor_gotchas_list"]))},
    b={"setup": {"cwd_fixture": f_gotcha}, "tiers": tier(
        det("called-gotcha-query", "trace",
            {"any_of": [called("evor_gotcha_query"), called("evor_gotchas_list")]}),
        bypass(["wiki/index.jsonl", "wiki/gotchas/global.jsonl"]),
        fails(["evor_wiki_query", "evor_gotcha_query", "evor_gotchas_list"]))},
    diff=["/setup/cwd_fixture", "/tiers/pass"],
)
