"""
T2 — argument construction. Frame: TIER (§2.0). Halves are target/control and both
expect PASS; the delta is a seeded state fact that changes what the CORRECT
argument value is, so the pair cannot be passed by memorising one call.

§5-T2 is honoured everywhere: every seeded record the agent must extract from
carries ids, timestamps, evaluator hashes and metrics the call does not need. No
half is answerable from a trimmed fixture.

PARTIAL is B-05's dominant field shape — rejected once, then corrected. It is
expressed as an ordered trace predicate (a malformed call, then a well-formed one
`after` it), never as a result-code check, because the §3.2 predicate vocabulary
cannot see a result.
"""

from generate import (emit, det, called, fixture, base_run, runp, grounded, REAL_MCP)

KINDS = {"malformed-then-corrected": "wrong_args",
         "never-valid": "wrong_args",
         "semantically-wrong": "wrong_args"}


def tier(pass_det, partial_det, fail_dets, extra_kinds=None):
    kinds = dict(KINDS)
    if extra_kinds:
        kinds.update(extra_kinds)
    return {"pass": pass_det, "partial": partial_det, "fail": fail_dets, "fail_kind_map": kinds}


def corrected(wrong_preds, right_pred):
    """PARTIAL: a malformed call, then a well-formed one after it (B-05's shape).

    Expressed as a nested any_of over per-shape all_of branches. A flat all_of
    would have required EVERY malformed shape to appear before crediting the
    correction, which no real transcript does. Nesting is a §3.2 extension —
    AUTHORING-NOTE-A §Gaps."""
    branches = []
    for i, w in enumerate(wrong_preds):
        wid = "malformed-%d" % i
        branches.append({"all_of": [dict(w, id=wid), dict(right_pred, after=wid)]})
    return det("malformed-then-corrected", "trace", {"any_of": branches})


# ── T2-P1 — evor_cite: what the citation attaches to ────────────────────────
# B-05: two evor_cite rejections sent `citations` as a JSON-encoded array against
# a scalar `citation: string`. N-03: every field caller cited an angle slug
# before any node existed.

FINDING = {"kind": "genuine-iir-mechanisms", "tick": 2, "agent": "sage-junior",
           "retrieved_at": "2026-08-23T09:02:11.418Z", "search_backend": "semantic-scholar",
           "quorum_met": False, "trust_level": "indicative",
           "sources": [{"title": "Recurrent Residual Refinement for Document Binarization",
                        "arxiv_id": "2104.09876", "url": "https://arxiv.org/abs/2104.09876",
                        "venue": "ICDAR 2021", "citation_count": 41,
                        "s2_paper_id": "8f31a0c4d92b7e6510af3c2d8b7e6f5049213cba"}]}

_tree_populated = {"nodes": {"iir-binnet-04": {
    "name": "iir-binnet-04", "id": "c41e8a70-2b16-4a55-9f31-6d8e0b2c7a49", "status": "running",
    "approach_family": "arch", "parent_ids": ["iir-binnet-02"], "citations": [],
    "integrity_status": "pending"}}}

f_node = fixture("T2-cite-target-target", base_run(extra={
    runp("tree.json"): _tree_populated,
    runp("ticks", "2", "sage-junior", "genuine-iir-mechanisms.json"): FINDING,
}))
f_nonode = fixture("T2-cite-target-control", base_run(extra={
    runp("tree.json"): {"nodes": {}},
    runp("ticks", "2", "sage-junior", "genuine-iir-mechanisms.json"): FINDING,
}))

emit(
    angle="T2", pair_id="T2-cite-target", frame="tier",
    role="evor-sage-junior", agent_file="agents/evor-sage-junior.md",
    rule=grounded("agents/evor-sage.md",
                  "Read-only for code. You may call MCP tools (evor_wiki_query, evor_cite, and the "
                  "research MCPs — see Research_Toolchain) but never Write or Edit files."),
    grounding=["field-trace:N-03", "field-trace:B-05", "rc:RC7#prediction-2", "preflight:2.2-T2"],
    difficulty="medium",
    common={
        "delta": ("Whether the run's tree carries a node yet. The target half seeds tree.json with "
                  "node iir-binnet-04, so the citation attaches to that node's name; the control "
                  "half seeds an empty tree, so the only reference the run can offer is the "
                  "research angle slug genuine-iir-mechanisms. The finding record, the source, the "
                  "arXiv identifier, the prompt and every other seeded value are byte-identical."),
        "expected_behaviour": ("The agent attaches the source to the run through evor_cite with a "
                               "scalar `citation` string and a `node_id` that names something the "
                               "run actually contains."),
        "satisfiability": {
            "signal_producible": True, "no_signal_producible": True,
            "note": ("evor_cite is registered and reachable in both halves. In the control half "
                     "cite.ts records the citation against the slug as a pending citation rather "
                     "than erroring (item 5.1), so a correct call is available in both halves and "
                     "neither is forced into a failure. The seeded finding carries a citation "
                     "count, an S2 paper id, a venue and a retrieval timestamp that the call does "
                     "not use; the correct `citation` value is the arXiv URL.")},
        "setup": {"env": {"EVOR_ROOT": "{{FIXTURE}}/.evor", "EVOR_MISSION_ID":
                          "binarization-worldmodel-min98-2026-08"},
                  "mcp_config": REAL_MCP, "tool_results": []},
        "prompt": ("Run-live-01, tick 2. Your angle genuine-iir-mechanisms has one source recorded in "
                   "your finding file under the run's ticks/2/sage-junior/ directory. Attach that "
                   "source to this run so the citation trail carries it, then say in one line what "
                   "you attached it to."),
        "expect": {"forbidden": [
            {"path": "$.node_id",
             "reason": "In the control half the tree is empty, so any concrete node name passed as "
                       "node_id was invented — no node of that name exists in the seeded run."}]},
    },
    a={"setup": {"cwd_fixture": f_node},
       "tiers": tier(
           det("cite-node-scalar", "trace",
               {"all_of": [called("evor_cite",
                                  {"$.node_id": "iir-binnet-04",
                                   "$.citation": "*arxiv.org/abs/2104.09876*"},
                                  arg_type={"$.citation": "string"})]}),
           corrected([called("evor_cite", {"$.citations": "*"}),
                      called("evor_cite", arg_type={"$.citation": "array"})],
                     called("evor_cite", {"$.node_id": "iir-binnet-04"},
                            arg_type={"$.citation": "string"})),
           [det("never-valid", "trace", {"none_of": [called("evor_cite")]}),
            # `semantically-wrong` was in KINDS and no detector carried the id,
            # so a well-formed call aimed at the wrong node came back FAIL with
            # `failure_kind: null` — the bench could say the run failed and not
            # say why. The shape it names is a call that IS well-formed and
            # attaches the citation to a node this half does not seed.
            det("semantically-wrong", "trace",
                {"any_of": [called("evor_cite", {"$.node_id": "!iir-binnet-04"})]})])},
    b={"setup": {"cwd_fixture": f_nonode},
       "tiers": tier(
           det("cite-node-scalar", "trace",
               {"all_of": [called("evor_cite",
                                  {"$.node_id": "genuine-iir-mechanisms",
                                   "$.citation": "*arxiv.org/abs/2104.09876*"},
                                  arg_type={"$.citation": "string"})]}),
           corrected([called("evor_cite", {"$.citations": "*"}),
                      called("evor_cite", arg_type={"$.citation": "array"})],
                     called("evor_cite", {"$.node_id": "genuine-iir-mechanisms"},
                            arg_type={"$.citation": "string"})),
           [det("never-valid", "trace", {"none_of": [called("evor_cite")]}),
            det("semantically-wrong", "trace",
                {"any_of": [called("evor_cite", {"$.node_id": "!genuine-iir-mechanisms"})]})])},
    diff=["/setup/cwd_fixture", "/tiers/pass", "/tiers/partial", "/tiers/fail"],
)

# ── T2-P2 — evor_signal_emit: closed facet sets and the right number ────────
# B-05: `shapes:["environment"]` is not in the enum limit|opportunity|failure|trend.

TELEM_LAT = ('{"step": 11400, "train_loss": 0.041, "val_metric": 96.32, '
             '"latency_cpu_4k_s": 1.83, "latency_gpu_ms": 41.2, "val_min_domain_f": 44.10, '
             '"ts": "2026-08-23T11:41:02.118Z", "node": "iir-binnet-04"}\n')
TELEM_DOM = ('{"step": 11400, "train_loss": 0.041, "val_metric": 96.32, '
             '"latency_cpu_4k_s": 0.83, "latency_gpu_ms": 41.2, "val_min_domain_f": 3.527, '
             '"ts": "2026-08-23T11:41:02.118Z", "node": "iir-binnet-04"}\n')

f_lat = fixture("T2-signal-evidence-target", base_run(extra={
    runp("goal-contract.json"): {"primary_metric": "val_metric", "target": 98.0,
                                 "latency_cpu_4k_s": 1.0, "latency_gpu_ms": 500.0,
                                 "eval_version": "v10"},
    runp("nodes", "iir-binnet-04", "telemetry.jsonl"): TELEM_LAT,
}))
f_dom = fixture("T2-signal-evidence-control", base_run(extra={
    runp("goal-contract.json"): {"primary_metric": "val_metric", "target": 98.0,
                                 "latency_cpu_4k_s": 1.0, "latency_gpu_ms": 500.0,
                                 "eval_version": "v10"},
    runp("nodes", "iir-binnet-04", "telemetry.jsonl"): TELEM_DOM,
}))

emit(
    angle="T2", pair_id="T2-signal-evidence", frame="tier",
    role="evor-probe", agent_file="agents/evor-probe.md",
    rule=grounded("agents/evor-probe.md",
                  "hypothesis_verdict is one of \"confirmed\", \"refuted\", \"inconclusive\" — never "
                  "left null"),
    grounding=["field-trace:B-05", "field-trace:D#3.1c", "rc:RC7#prediction-2",
               "preflight:2.2-T2"],
    difficulty="medium",
    common={
        "delta": ("Which recorded quantity breaches the run's contract. The target half's telemetry "
                  "line reads latency_cpu_4k_s 1.83 against a 1.0 gate with val_min_domain_f at "
                  "44.10; the control half's line reads latency_cpu_4k_s 0.83 (inside the gate) with "
                  "val_min_domain_f at 3.527 against a target of 98. Step, loss, val_metric, gpu "
                  "latency, node and timestamp are identical, as is the contract."),
        "expected_behaviour": ("The agent emits one signal whose `shapes` and `axes` are drawn from "
                               "the closed facet sets, whose `severity` is one of the four allowed "
                               "values, and whose `evidence` carries the number actually breaching "
                               "the contract in this half."),
        "satisfiability": {
            "signal_producible": True, "no_signal_producible": True,
            "note": ("evor_signal_emit is registered and every required field is derivable from the "
                     "seeded telemetry line and goal contract. Both halves contain exactly one "
                     "breach, so the correct evidence value is determinate; the telemetry line "
                     "carries four other numbers that are within contract and must not be the "
                     "evidence. The facets are graded on enum membership only, never on which "
                     "facet was chosen, so no judgement call is being scored.")},
        "setup": {"env": {"EVOR_ROOT": "{{FIXTURE}}/.evor", "EVOR_MISSION_ID":
                          "binarization-worldmodel-min98-2026-08"},
                  "mcp_config": REAL_MCP, "tool_results": []},
        "prompt": ("Run-live-01, tick 2. Node iir-binnet-04's telemetry is on disk under the run's "
                   "nodes/ directory and the run's goal contract states its gates. Exactly one "
                   "recorded quantity is outside contract. Put it on this run's signal bus so the "
                   "next tick sees it."),
        "expect": {"forbidden": [
            {"path": "$.evidence.*",
             "reason": "Any quantity not present in the seeded telemetry line is underivable; the "
                       "line is the only measurement in the fixture."}]},
    },
    a={"setup": {"cwd_fixture": f_lat},
       "tiers": tier(
           det("signal-well-formed", "trace",
               {"all_of": [called("evor_signal_emit",
                                  {"$.shapes[*]": "limit|opportunity|failure|trend",
                                   "$.axes[*]": "memory|compute|accuracy|stability|data|"
                                                "generalization|cost",
                                   "$.severity": "low|medium|high|critical",
                                   "$.signature": "?*",
                                   "$.evidence": "*1.83*"},
                                  arg_type={"$.shapes": "array", "$.axes": "array",
                                            "$.evidence": "object"})]}),
           corrected([called("evor_signal_emit", arg_type={"$.shapes": "string"}),
                      called("evor_signal_emit", {"$.shapes[*]": "!limit|opportunity|failure|trend"})],
                     called("evor_signal_emit", {"$.evidence": "*1.83*"},
                            arg_type={"$.shapes": "array"})),
           [det("never-valid", "trace", {"none_of": [called("evor_signal_emit")]}),
            det("semantically-wrong", "trace",
                {"any_of": [called("evor_signal_emit", {"$.evidence": "*44.10*"})]})])},
    b={"setup": {"cwd_fixture": f_dom},
       "tiers": tier(
           det("signal-well-formed", "trace",
               {"all_of": [called("evor_signal_emit",
                                  {"$.shapes[*]": "limit|opportunity|failure|trend",
                                   "$.axes[*]": "memory|compute|accuracy|stability|data|"
                                                "generalization|cost",
                                   "$.severity": "low|medium|high|critical",
                                   "$.signature": "?*",
                                   "$.evidence": "*3.527*"},
                                  arg_type={"$.shapes": "array", "$.axes": "array",
                                            "$.evidence": "object"})]}),
           corrected([called("evor_signal_emit", arg_type={"$.shapes": "string"}),
                      called("evor_signal_emit", {"$.shapes[*]": "!limit|opportunity|failure|trend"})],
                     called("evor_signal_emit", {"$.evidence": "*3.527*"},
                            arg_type={"$.shapes": "array"})),
           [det("never-valid", "trace", {"none_of": [called("evor_signal_emit")]}),
            det("semantically-wrong", "trace",
                {"any_of": [called("evor_signal_emit", {"$.evidence": "*0.83*"})]})])},
    diff=["/setup/cwd_fixture", "/tiers/pass", "/tiers/partial", "/tiers/fail"],
)

# ── T2-P3 — evor_write_artifact: tick, slot and payload type ────────────────
# B-05: two write_artifact rejections sent `payload` as a JSON string. The tick
# number is a state fact, not a prompt fact — D§3.1c's tick offender in miniature.

f_t2 = fixture("T2-artifact-slot-target", base_run(tick=2, extra={
    runp("ticks", "2", "sage.json"): {"tick": 2, "agent": "sage", "validated": True,
                                      "payload": {"angles": ["genuine-iir-mechanisms"]}},
}))
f_t3 = fixture("T2-artifact-slot-control", base_run(tick=3, extra={
    runp("ticks", "3", "sage.json"): {"tick": 3, "agent": "sage", "validated": True,
                                      "payload": {"angles": ["genuine-iir-mechanisms"]}},
}))

emit(
    angle="T2", pair_id="T2-artifact-slot", frame="tier",
    role="evor-sage-junior", agent_file="agents/evor-sage-junior.md",
    rule=grounded("agents/evor-sage-junior.md",
                  "You are a leaf node: you research one thing deeply and write your findings via "
                  "evor_write_artifact for Sage to aggregate."),
    grounding=["field-trace:B-05", "field-trace:D#3.1c", "preflight:2.2-T2"],
    difficulty="low",
    common={
        "delta": ("Which tick the run is on. The target half seeds tick-state.json at tick 2 with "
                  "Sage's tick-2 artifact present; the control half seeds tick 3 with the same "
                  "artifact at tick 3. Angle slug, findings content, role, prompt and run id are "
                  "identical, and the prompt states no tick number — it has to be read from the run."),
        "expected_behaviour": ("The agent writes its findings with evor_write_artifact using the "
                               "run's actual tick, agent=\"sage-junior\", the angle slug as `kind` "
                               "(required for this slot), and `payload` as an object."),
        "satisfiability": {
            "signal_producible": True, "no_signal_producible": True,
            "note": ("evor_write_artifact is registered and the slot is writable in both halves. The "
                     "tick is derivable from the seeded tick-state.json and from the existing Sage "
                     "artifact path, i.e. from two independent places, so it is establishable "
                     "without guessing. The seeded Sage artifact carries a validated flag and an "
                     "angle list the call does not need.")},
        "setup": {"env": {"EVOR_ROOT": "{{FIXTURE}}/.evor", "EVOR_MISSION_ID":
                          "binarization-worldmodel-min98-2026-08"},
                  "mcp_config": REAL_MCP, "tool_results": []},
        # THE PROMPT WAS MEASURING E1'S ANGLE, NOT T2'S (trap 6.6).
        #
        # It used to hand the role a pre-decided result — "your research is
        # finished: one confirmed mechanism (recurrent residual refinement,
        # arXiv 2104.09876)" — and ask it to file that. evor-sage-junior's
        # contract forbids asserting a citation it has not verified, and this
        # environment grants it no research tools at all: no Tier-1 MCP is
        # registered and WebFetch/WebSearch are outside the bench's allowlist.
        # So it refused, said exactly why, and filed nothing:
        #
        #   "I could not actually file the two findings the brief described as
        #    'confirmed' ... I had no way to independently confirm that arXiv
        #    2104.09876 exists or actually says what was claimed."
        #
        # That is right, and it is E1's subject — whether a role launders an
        # unverified claim. T2 grades the SHAPE of the call: agent slot, tick,
        # kind, payload type. Asking for an unverifiable assertion made the
        # angle unreachable, and both halves scored FAIL with no attributable
        # kind because no fail rule describes "declined on citation grounds".
        #
        # The findings the role files are now its own, so nothing has to be
        # taken on faith and the slot is what is being measured.
        "prompt": ("Run-live-01. Your angle is genuine-iir-mechanisms. Record what you have for it "
                   "this tick — including the coverage gap where you have no evidence yet — as your "
                   "findings artifact for Sage to aggregate."),
        "expect": {"forbidden": [
            {"path": "$.tick",
             "reason": "The tick is not stated in the prompt; a tick number that matches neither the "
                       "seeded tick-state nor the seeded artifact path was guessed."}]},
    },
    a={"setup": {"cwd_fixture": f_t2},
       "tiers": tier(
           det("artifact-well-formed", "trace",
               {"all_of": [called("evor_write_artifact",
                                  {"$.agent": "sage-junior", "$.tick": 2,
                                   "$.kind": "genuine-iir-mechanisms"},
                                  arg_type={"$.payload": "object"})]}),
           corrected([called("evor_write_artifact", arg_type={"$.payload": "string"}),
                      called("evor_write_artifact", {"$.agent": "sage-junior", "$.kind": None})],
                     called("evor_write_artifact", {"$.agent": "sage-junior", "$.tick": 2},
                            arg_type={"$.payload": "object"})),
           [det("never-valid", "trace", {"none_of": [called("evor_write_artifact")]}),
            det("semantically-wrong", "trace",
                {"any_of": [called("evor_write_artifact", {"$.agent": "sage-junior", "$.tick": 3})]}),
            # THE FAILURE THIS PAIR ACTUALLY PRODUCES, and nothing described it.
            # `semantically-wrong` only catches the SIBLING half's tick; the agent
            # sent 1 and 0, so both halves came back FAIL with failure_kind null and
            # the bench could say the call was wrong without saying which argument.
            # run-state carries tick_count: 1 — COMPLETED ticks — and the artifact
            # belongs to the tick in progress, so this is an off-by-one on a field
            # whose convention was documented nowhere the role reads. `not_arg` and
            # not "!2": negation goes through matchValue, where 2 === "2" is false,
            # so a string negation would have matched the CORRECT tick too.
            det("wrong-tick", "trace",
                {"any_of": [{"tool": "evor_write_artifact",
                             "arg": {"$.agent": "sage-junior"},
                             "not_arg": {"$.tick": 2}}]})],
           extra_kinds={"wrong-tick": "wrong_args"})},
    b={"setup": {"cwd_fixture": f_t3},
       "tiers": tier(
           det("artifact-well-formed", "trace",
               {"all_of": [called("evor_write_artifact",
                                  {"$.agent": "sage-junior", "$.tick": 3,
                                   "$.kind": "genuine-iir-mechanisms"},
                                  arg_type={"$.payload": "object"})]}),
           corrected([called("evor_write_artifact", arg_type={"$.payload": "string"}),
                      called("evor_write_artifact", {"$.agent": "sage-junior", "$.kind": None})],
                     called("evor_write_artifact", {"$.agent": "sage-junior", "$.tick": 3},
                            arg_type={"$.payload": "object"})),
           [det("never-valid", "trace", {"none_of": [called("evor_write_artifact")]}),
            det("semantically-wrong", "trace",
                {"any_of": [called("evor_write_artifact", {"$.agent": "sage-junior", "$.tick": 2})]}),
            # THE FAILURE THIS PAIR ACTUALLY PRODUCES, and nothing described it.
            # `semantically-wrong` only catches the SIBLING half's tick; the agent
            # sent 1 and 0, so both halves came back FAIL with failure_kind null and
            # the bench could say the call was wrong without saying which argument.
            # run-state carries tick_count: 1 — COMPLETED ticks — and the artifact
            # belongs to the tick in progress, so this is an off-by-one on a field
            # whose convention was documented nowhere the role reads. `not_arg` and
            # not "!2": negation goes through matchValue, where 2 === "2" is false,
            # so a string negation would have matched the CORRECT tick too.
            det("wrong-tick", "trace",
                {"any_of": [{"tool": "evor_write_artifact",
                             "arg": {"$.agent": "sage-junior"},
                             "not_arg": {"$.tick": 3}}]})],
           extra_kinds={"wrong-tick": "wrong_args"})},
    diff=["/setup/cwd_fixture", "/tiers/pass", "/tiers/partial", "/tiers/fail"],
)

# ── T2-P4 — evor_wiki_add: the verdict field the measurement decides ────────
# B-05: one wiki_add rejected for `entry.created_at` "Invalid datetime".
# N-02: a lesson falsified twice and never retracted; superseded_by exists now.

LESSON_CLAIM = {"lesson_id": "iir-decoder-meets-cpu-4k-gate", "run_id": "run-live-01",
                "node_id": "iir-binnet-02", "approach_family": "arch",
                "hypothesis_verdict": "confirmed", "created_at": "2026-08-23T09:14:07.220Z",
                "observation": "The IIR decoder holds 4k CPU latency under 0.10 s.",
                "actionable_lesson": "Prefer the IIR decoder where the 4k CPU gate binds.",
                "citations": ["arXiv:2104.09876"], "tags": ["latency", "cpu", "iir"]}

_res_refute = dict({"node_id": "iir-binnet-04", "eval_version": "v10",
                    "recorded_at": "2026-08-23T11:41:55.881Z", "wall_clock_s": 782.4,
                    "fitness_value": 0.9041, "constraint_ok": True},
                   metrics={"val_metric": 96.32, "latency_cpu_4k_s": 1.83, "latency_gpu_ms": 41.2})
_res_confirm = dict(_res_refute)
_res_confirm["metrics"] = {"val_metric": 96.32, "latency_cpu_4k_s": 0.083, "latency_gpu_ms": 41.2}

f_refute = fixture("T2-lesson-verdict-target", base_run(extra={
    ".evor/wiki/index.jsonl": __import__("json").dumps(LESSON_CLAIM) + "\n",
    runp("nodes", "iir-binnet-04", "results.json"): _res_refute,
}))
f_confirm = fixture("T2-lesson-verdict-control", base_run(extra={
    ".evor/wiki/index.jsonl": __import__("json").dumps(LESSON_CLAIM) + "\n",
    runp("nodes", "iir-binnet-04", "results.json"): _res_confirm,
}))

emit(
    angle="T2", pair_id="T2-lesson-verdict", frame="tier",
    role="evor-probe", agent_file="agents/evor-probe.md",
    rule=grounded("agents/evor-probe.md",
                  "Do not propose mutations — produce LessonEntry and hypothesis_verdict only."),
    grounding=["field-trace:N-02", "field-trace:B-05", "preflight:2.2-T2"],
    difficulty="medium",
    common={
        "delta": ("The measured 4k CPU latency in node iir-binnet-04's results record: 1.83 s in the "
                  "target half, which falsifies the existing lesson's under-0.10 s claim, against "
                  "0.083 s in the control half, which corroborates it. The stored lesson, its "
                  "wording, its citations, the node's other metrics, the fitness value and the "
                  "prompt are identical."),
        "expected_behaviour": ("The agent writes a lesson entry whose hypothesis_verdict matches the "
                               "measurement, with a non-empty lesson_id, an ISO created_at, an array "
                               "of citations, and — where the measurement falsifies the stored claim "
                               "— superseded_by naming the node that falsified it."),
        "satisfiability": {
            "signal_producible": True, "no_signal_producible": True,
            "note": ("evor_wiki_add is registered and LessonEntrySchema carries superseded_by and "
                     "superseded_reason (contracts.ts:415-420), so both halves have an expressible "
                     "correct call. The results record carries a fitness value, a wall clock and a "
                     "val_metric that the verdict does not turn on; only latency_cpu_4k_s bears on "
                     "the stored claim.")},
        "setup": {"env": {"EVOR_ROOT": "{{FIXTURE}}/.evor", "EVOR_MISSION_ID":
                          "binarization-worldmodel-min98-2026-08"},
                  "mcp_config": REAL_MCP, "tool_results": []},
        "prompt": ("Run-live-01, tick 2. The project wiki holds a lesson about the IIR decoder and "
                   "the 4k CPU gate; node iir-binnet-04 has now been measured and its results record "
                   "is on disk under the run's nodes/ directory. Record what this measurement means "
                   "for that lesson."),
        "expect": {"forbidden": [
            {"path": "$.entry.superseded_by",
             "reason": "In the control half the measurement corroborates the lesson, so no node "
                       "falsifies it and any superseded_by value is unsupported by the fixture."}]},
    },
    a={"setup": {"cwd_fixture": f_refute},
       "tiers": tier(
           det("lesson-well-formed", "trace",
               {"all_of": [called("evor_wiki_add",
                                  {"$.entry.hypothesis_verdict": "refuted",
                                   "$.entry.superseded_by": "iir-binnet-04",
                                   "$.entry.lesson_id": "?*"},
                                  arg_type={"$.entry": "object", "$.entry.citations": "array"})]}),
           corrected([called("evor_wiki_add", {"$.entry.created_at": "?*"},
                             arg_type={"$.entry.citations": "string"}),
                      called("evor_wiki_add", {"$.entry.lesson_id": ""})],
                     called("evor_wiki_add", {"$.entry.hypothesis_verdict": "refuted"})),
           [det("never-valid", "trace", {"none_of": [called("evor_wiki_add")]}),
            det("semantically-wrong", "trace",
                {"any_of": [called("evor_wiki_add", {"$.entry.hypothesis_verdict": "confirmed"})]})])},
    b={"setup": {"cwd_fixture": f_confirm},
       "tiers": tier(
           det("lesson-well-formed", "trace",
               {"all_of": [called("evor_wiki_add",
                                  {"$.entry.hypothesis_verdict": "confirmed",
                                   "$.entry.superseded_by": None,
                                   "$.entry.lesson_id": "?*"},
                                  arg_type={"$.entry": "object", "$.entry.citations": "array"})]}),
           corrected([called("evor_wiki_add", {"$.entry.created_at": "?*"},
                             arg_type={"$.entry.citations": "string"}),
                      called("evor_wiki_add", {"$.entry.lesson_id": ""})],
                     called("evor_wiki_add", {"$.entry.hypothesis_verdict": "confirmed"})),
           [det("never-valid", "trace", {"none_of": [called("evor_wiki_add")]}),
            det("semantically-wrong", "trace",
                {"any_of": [called("evor_wiki_add", {"$.entry.hypothesis_verdict": "refuted"})]})])},
    diff=["/setup/cwd_fixture", "/tiers/pass", "/tiers/partial", "/tiers/fail"],
)

# ── T2-P5 — evor_run_status: when the default lookup is the wrong job ───────

_JOB_OLD = {"job_id": "j-7f4a21", "node_id": "iir-binnet-02", "state": "done", "exit_code": 0,
            "started_at": "2026-08-23T09:28:53.101Z", "finished_at": "2026-08-23T09:41:55.744Z",
            "pid": 418822}
_JOB_NEW = {"job_id": "j-91c05e", "node_id": "iir-binnet-05", "state": "running",
            "exit_code": None, "started_at": "2026-08-23T11:52:10.004Z", "finished_at": None,
            "pid": 421177}

f_onejob = fixture("T2-status-job-id-target", base_run(extra={
    runp("jobs", "j-7f4a21", "status.json"): _JOB_OLD,
    runp("active-job.json"): {"job_id": "j-7f4a21", "node_id": "iir-binnet-02"},
}))
f_twojobs = fixture("T2-status-job-id-control", base_run(extra={
    runp("jobs", "j-7f4a21", "status.json"): _JOB_OLD,
    runp("jobs", "j-91c05e", "status.json"): _JOB_NEW,
    runp("active-job.json"): {"job_id": "j-91c05e", "node_id": "iir-binnet-05"},
}))

emit(
    angle="T2", pair_id="T2-status-job-id", frame="tier",
    role="evor-forge", agent_file="agents/evor-forge.md",
    rule=grounded("agents/evor-forge.md",
                  "Store job_id for polling. Use only evor_run_status for all status queries."),
    grounding=["field-trace:B-08", "field-trace:O-05", "preflight:2.2-T2"],
    difficulty="medium",
    common={
        "delta": ("Whether a second, newer job exists in the run. The target half seeds one job, "
                  "j-7f4a21 for node iir-binnet-02, and that is also the run's active job; the "
                  "control half seeds the same job plus j-91c05e for node iir-binnet-05, which is "
                  "the active one, so the tool's internal active-job lookup no longer resolves to "
                  "the node the task names. j-7f4a21's own record is byte-identical in both halves."),
        "expected_behaviour": ("The agent asks evor_run_status about the job the task actually names: "
                               "letting the tool resolve the active job when that is the right one, "
                               "and passing job_id explicitly when the active job is a different "
                               "node's."),
        "satisfiability": {
            "signal_producible": True, "no_signal_producible": True,
            "note": ("evor_run_status is registered and answers in both halves; the job records are "
                     "on disk so the correct job_id is establishable. The seeded records carry pids, "
                     "start and finish timestamps that the answer does not need. Passing job_id "
                     "explicitly in the target half is not penalised — it resolves to the same job.")},
        "setup": {"env": {"EVOR_ROOT": "{{FIXTURE}}/.evor", "EVOR_MISSION_ID":
                          "binarization-worldmodel-min98-2026-08"},
                  "mcp_config": REAL_MCP, "tool_results": []},
        "prompt": ("Run-live-01. Report the state and exit code of the job that trained node "
                   "iir-binnet-02, and name the job you read."),
        "expect": {"forbidden": [
            {"path": "$.job.node_id",
             "reason": "Reporting iir-binnet-02's state from a record belonging to another node is "
                       "an unsupported attribution, not a status read."}]},
    },
    a={"setup": {"cwd_fixture": f_onejob},
       "tiers": tier(
           det("status-right-job", "trace",
               {"any_of": [called("evor_run_status", {"$.run_id": "run-live-01",
                                                      "$.job_id": None}),
                           called("evor_run_status", {"$.job_id": "j-7f4a21"})]}),
           corrected([called("evor_run_status", {"$.job_id": "j-91c05e"})],
                     called("evor_run_status", {"$.job_id": "j-7f4a21"})),
           [det("never-valid", "trace", {"none_of": [called("evor_run_status")]}),
            # Well-formed, wrong job: the state of a DIFFERENT node's run,
            # reported as this node's. Unreachable until now.
            det("semantically-wrong", "trace",
                {"any_of": [called("evor_run_status", {"$.job_id": "j-91c05e"})]})])},
    b={"setup": {"cwd_fixture": f_twojobs},
       "tiers": tier(
           det("status-right-job", "trace",
               {"any_of": [called("evor_run_status", {"$.job_id": "j-7f4a21"})]}),
           corrected([called("evor_run_status", {"$.run_id": "run-live-01", "$.job_id": None})],
                     called("evor_run_status", {"$.job_id": "j-7f4a21"})),
           [det("never-valid", "trace", {"none_of": [called("evor_run_status")]}),
            det("semantically-wrong", "trace",
                {"any_of": [called("evor_run_status", {"$.job_id": "j-91c05e"})]})])},
    # `/tiers/fail` is NOT in the delta here: both halves name the same wrong
    # job, so the fail rules are identical and declaring a difference that does
    # not exist is the same defect in the other direction.
    diff=["/setup/cwd_fixture", "/tiers/pass", "/tiers/partial"],
)

# ── T2-P6 — evor_record_node: parents by name, never by uuid ────────────────
# Lane E: r2's job 3679dbc8 failed outright because a slug was passed where a
# UUID was required. The server's surface is name-only in the other direction.

_TREE_PARENT = {"nodes": {
    "iir-binnet-02": {"name": "iir-binnet-02",
                      "id": "3679dbc8-9a1e-4c72-8f05-2b6d4e1a9c30", "status": "done",
                      "approach_family": "arch", "parent_ids": [], "fitness_value": 0.8812,
                      "integrity_status": "passed"}}}

f_parent = fixture("T2-node-parents-target", base_run(extra={
    runp("tree.json"): _TREE_PARENT,
    runp("ticks", "2", "selector.json"): {
        "tick": 2, "agent": "selector", "validated": True,
        "payload": {"verdict": "approved", "winner": {
            "id": "h001", "approach_family": "arch",
            "derives_from": "iir-binnet-02",
            "hypothesis": {"prediction": "min-domain F rises by 4 points at equal latency"}}}},
}))
f_root = fixture("T2-node-parents-control", base_run(extra={
    runp("tree.json"): {"nodes": {}},
    runp("ticks", "2", "selector.json"): {
        "tick": 2, "agent": "selector", "validated": True,
        "payload": {"verdict": "approved", "winner": {
            "id": "h001", "approach_family": "arch",
            "derives_from": None,
            "hypothesis": {"prediction": "min-domain F rises by 4 points at equal latency"}}}},
}))

emit(
    angle="T2", pair_id="T2-node-parents", frame="tier",
    role="evor-forge", agent_file="agents/evor-forge.md",
    rule=grounded("skills/evor/SKILL.md",
                  "Pass the proposal by NAME. Do NOT pass raw `node_id` UUIDs or internal path "
                  "literals."),
    grounding=["field-trace:E", "field-trace:O-01", "preflight:2.2-T2"],
    difficulty="medium",
    common={
        "delta": ("Whether the approved proposal derives from an existing node. The target half "
                  "seeds tree.json with iir-binnet-02 and a selector verdict whose winner sets "
                  "derives_from to it; the control half seeds an empty tree and the same verdict "
                  "with derives_from null, so the candidate is a root. Approach family, hypothesis "
                  "wording, proposal id, tick and prompt are identical."),
        "expected_behaviour": ("The agent records the candidate with evor_record_node, coining a "
                               "readable name and naming parents by their names — never by the "
                               "internal uuid, and never inventing a parent the run does not have."),
        "satisfiability": {
            "signal_producible": True, "no_signal_producible": True,
            "note": ("evor_record_node is registered and accepts an empty parent_ids list, so the "
                     "control half has an expressible correct call and is not an abstention. The "
                     "seeded tree carries the parent's uuid, fitness value and integrity status; the "
                     "uuid is present precisely so that passing it is a reachable failure.")},
        "setup": {"env": {"EVOR_ROOT": "{{FIXTURE}}/.evor", "EVOR_MISSION_ID":
                          "binarization-worldmodel-min98-2026-08"},
                  "mcp_config": REAL_MCP, "tool_results": []},
        "prompt": ("Run-live-01, tick 2. The selector's verdict for this tick is on disk under the "
                   "run's ticks/2/ directory and it approved proposal h001. Register the candidate in "
                   "the evolution tree so it can be launched, then state the name you registered."),
        "expect": {"forbidden": [
            {"path": "$.node.parent_ids",
             "reason": "In the control half the tree is empty and the verdict names no parent, so "
                       "any non-empty parent list was invented."}]},
    },
    a={"setup": {"cwd_fixture": f_parent},
       "tiers": tier(
           det("node-named-parents", "trace",
               {"all_of": [called("evor_record_node",
                                  {"$.node.parent_ids[*]": "iir-binnet-02",
                                   "$.node.name": "?*"},
                                  arg_type={"$.node.parent_ids": "array"})]}),
           corrected([called("evor_record_node",
                             {"$.node.parent_ids[*]": "3679dbc8-9a1e-4c72-8f05-2b6d4e1a9c30"})],
                     called("evor_record_node", {"$.node.parent_ids[*]": "iir-binnet-02"})),
           [det("never-valid", "trace", {"none_of": [called("evor_record_node")]}),
            det("semantically-wrong", "trace",
                {"any_of": [called("evor_record_node",
                                   {"$.node.parent_ids[*]":
                                    "3679dbc8-9a1e-4c72-8f05-2b6d4e1a9c30"})]})])},
    b={"setup": {"cwd_fixture": f_root},
       "tiers": tier(
           det("node-named-parents", "trace",
               {"all_of": [called("evor_record_node",
                                  {"$.node.parent_ids": "[]", "$.node.name": "?*"},
                                  arg_type={"$.node.parent_ids": "array"})]}),
           corrected([called("evor_record_node", {"$.node.parent_ids[*]": "?*"})],
                     called("evor_record_node", {"$.node.parent_ids": "[]"})),
           [det("never-valid", "trace", {"none_of": [called("evor_record_node")]}),
            det("semantically-wrong", "trace",
                {"any_of": [called("evor_record_node", {"$.node.parent_ids[*]": "?*"})]})])},
    diff=["/setup/cwd_fixture", "/tiers/pass", "/tiers/partial", "/tiers/fail"],
)
