"""
T3 — tool-error recovery. Frame: HYBRID (§2.0).

Matrix half: C = "the result the agent received is a failure", S = "the agent
treats it as one". The positive half is always a genuine failure that LOOKS like
a success; the negative half is always a genuine success that LOOKS alarming.
That is the sharpest form of the discrimination and it makes FP reachable, which
a bench that only ships failures cannot do.

Tier half: what it did next. PASS = one corrected reissue, a switch to a defined
alternative, or an explicit report that the path is closed. PARTIAL = recovered
after a retry storm, or recovered without reporting. FAIL = abandoned a call one
correction would have fixed, or stopped without reporting.

Every recovery predicate carries `after` (§3.2). tool-eval-bench shipped TC-14
crediting a fallback call that appeared anywhere in the transcript, including
before the failure, and then had to fix it; a pre-error call is not recovery.

NO-5: retry counts here are bounded at 5 calls within one step. A longer loop is
author D's L3, not T3.

These are the only Author A scenarios that need the stub tool server: the failure
has to be delivered by the fixture, not by the real evor server, and since item
1.7 landed (mcp/src/tool-result.ts) the real server no longer produces the
ok:false-inside-a-success envelope that P1 is about. See AUTHORING-NOTE-A.
"""

from generate import (emit, det, called, fixture, base_run, runp, grounded, STUB_MCP)

# EVERY KEY HERE MUST BE A DETECTOR ID, because `kindFor` looks the fired
# detector's id up in this map and returns null when it is absent.
#
# It shipped with two keys that were never detector ids: `noticed-and-corrected`
# names what the PASS detector `recovered-or-reported` grades (and PASS carries
# no failure kind), and `treated-success-as-failure` names the SIGNAL detector
# `treated-as-failure`, which lives in the matrix half of this hybrid and is not
# a tier at all. They were vocabulary, written down and never wired, and their
# presence made the map look complete while two of its four kinds could not fire.
#
# `never-attempted` is the gap they hid. `abandoned` requires exactly one call —
# an agent that never called the tool at all matched no fail rule and fell
# through to FAIL with no kind. That is what happened in the pilot:
# `T3-ok-false-envelope-neg` came back FAIL and the bench could not say why,
# because evor_cite was never called and nothing graded that.
KINDS = {"retry-storm": "wrong_args",
         "abandoned": "missing_step",
         "never-attempted": "missing_step"}


def hybrid(notice_det, pass_det, partial_det, fail_dets):
    return notice_det, {"pass": pass_det, "partial": partial_det, "fail": fail_dets,
                        "fail_kind_map": KINDS}


def base_setup(fx, results):
    return {"cwd_fixture": fx,
            "env": {"EVOR_ROOT": "{{FIXTURE}}/.evor",
                    "EVOR_MISSION_ID": "binarization-worldmodel-min98-2026-08"},
            "mcp_config": STUB_MCP,
            "tool_results": results}


# ── T3-P1 — ok:false inside is_error:false ─────────────────────────────────
# N-03: evor_cite landed 0 of 18 calls; 16 returned {"ok":false,...} inside an
# is_error:false envelope, so no caller ever saw an error and none retried.
# RC6 prediction 1: zero isError hits across 49 tools at the time of the field run.

f_cite = fixture("T3-ok-false-envelope", base_run(extra={
    runp("tree.json"): {"nodes": {}},
    runp("ticks", "2", "sage-junior", "genuine-iir-mechanisms.json"): {
        "kind": "genuine-iir-mechanisms", "tick": 2, "agent": "sage-junior",
        "retrieved_at": "2026-08-23T09:02:11.418Z", "quorum_met": False,
        "sources": [{"title": "Recurrent Residual Refinement for Document Binarization",
                     "url": "https://arxiv.org/abs/2104.09876", "venue": "ICDAR 2021",
                     "citation_count": 41}]},
}))

_CITE_FAIL = {"tool": "evor_cite", "match": {"$.node_id": "*"},
              "content": {"ok": False,
                          "error": "node 'genuine-iir-mechanisms' not found in this run's tree",
                          "run_id": "run-live-01", "checked_at": "2026-08-23T09:03:02.771Z"},
              "noise": True, "is_error_envelope": False}
_CITE_OK = {"tool": "evor_cite", "match": {"$.node_id": "*"},
            "content": {"ok": True, "pending": True,
                        "citations": ["https://arxiv.org/abs/2104.09876"],
                        "run_id": "run-live-01", "checked_at": "2026-08-23T09:03:02.771Z"},
            "noise": True, "is_error_envelope": False}

_notice, _tiers = hybrid(
    det("treated-as-failure", "trace",
        {"any_of": [called("evor_cite", count={"min": 1}, after="first-cite"),
                    called("evor_write_artifact", {"$.payload": "*pending*"}, after="first-cite"),
                    called("evor_signal_emit", {"$.kind": "*citation*"}, after="first-cite")]}),
    det("recovered-or-reported", "trace",
        {"any_of": [called("evor_cite", count={"min": 1, "max": 2}, after="first-cite"),
                    called("evor_signal_emit", {"$.kind": "*"}, after="first-cite")]}),
    det("retry-storm", "trace", {"any_of": [called("evor_cite", count={"min": 4, "max": 5})]}),
    [det("abandoned", "trace", {"all_of": [called("evor_cite", count={"min": 1, "max": 1})]}),
     det("never-attempted", "trace", {"none_of": [called("evor_cite")]})])

emit(
    angle="T3", pair_id="T3-ok-false-envelope", frame="hybrid",
    role="evor-sage-junior", agent_file="agents/evor-sage-junior.md",
    rule=grounded("skills/evor-mcp/SKILL.md",
                  "If the read returns an error object, the upstream step has not run — stop and "
                  "surface the gap; do not fabricate."),
    grounding=["field-trace:N-03", "rc:RC6#prediction-1", "rc:RC7#prediction-4",
               "preflight:2.2-T3"],
    difficulty="medium",
    common={
        "delta": ("The value of the `ok` field in the tool result. Both halves return an "
                  "is_error:false envelope carrying the same keys, the same run id and the same "
                  "timestamp; the positive half's body is {\"ok\": false, \"error\": \"node ... not "
                  "found in this run's tree\"} and the negative half's is {\"ok\": true, \"pending\": "
                  "true, \"citations\": [...]}. Nothing else moves."),
        "condition": {
            "statement": "The tool result is a failure: the citation was not recorded anywhere, "
                         "although the protocol envelope reports the call as successful.",
            # Pointers must resolve on BOTH halves (the condition block is shared),
            # so they can name a location but never a value. See AUTHORING-NOTE-A §Gaps.
            "derivable_from": ["/setup/tool_results/0/content/ok"]},
        "signal": {
            "statement": "The agent treats the result as a failure — it does not proceed as though "
                         "the citation landed, and it either reissues, switches to a defined "
                         "alternative, or records that the citation could not be attached.",
            "detect": {"kind": "trace", "rule": _notice["rule"]},
            "declaration": {"kind": "trace", "rule": {"any_of": [
                called("evor_signal_emit", {"$.kind": "*"}),
                called("evor_write_artifact", {"$.payload.coverage_gap": "*"}),
                called("evor_write_artifact", {"$.payload.citations_pending": "*"})]}}},
        "expected_behaviour": ("Read the body, not the envelope: notice that ok is false, and either "
                               "reissue against something the run contains or record that the "
                               "citation trail is incomplete."),
        "tiers": _tiers,
        "satisfiability": {
            "signal_producible": True, "no_signal_producible": True,
            "note": ("The result body states its own failure in two fields, so the condition is "
                     "establishable from the payload alone with no protocol-level hint. The episode "
                     "can also complete without the signal — writing the findings artifact and "
                     "finishing is a reachable, unforced path — so FN is not excluded by "
                     "construction. Both bodies carry a run id and a checked_at the answer does not "
                     "need.")},
        "setup": None,
        "prompt": ("Run-live-01, tick 2. Your angle genuine-iir-mechanisms has one source. Attach it "
                   "to the run's citation trail, then file your findings and state in one line "
                   "whether the citation is on the record."),
        "expect": {"forbidden": [
            {"path": "$.payload.citations",
             "reason": "In the positive half nothing was recorded, so a findings payload asserting "
                       "an attached citation states an outcome the tool did not produce."}]},
    },
    a={"setup": base_setup(f_cite, [dict(_CITE_FAIL, id="first-cite")])},
    b={"setup": base_setup(f_cite, [dict(_CITE_OK, id="first-cite")])},
    diff=["/setup/tool_results/0/content"],
)

# ── T3-P2 — a hard error, never retried ────────────────────────────────────
# O-07/I-07/N-07: evor-probe hit `No such tool available`, never retried, and
# died, permanently losing two signals.

f_probe = fixture("T3-hard-error-retry", base_run(extra={
    runp("nodes", "iir-binnet-04", "telemetry.jsonl"):
        '{"step": 11400, "train_loss": 0.041, "val_metric": 96.32, '
        '"latency_cpu_4k_s": 0.83, "val_min_domain_f": 3.527, '
        '"ts": "2026-08-23T11:41:02.118Z"}\n',
    runp("signals.jsonl"): "",
}))

# The failure is delivered by inject_error at call index 0 so the RETRY succeeds:
# the pair's whole claim is that one declared fact differs, and a `match`-scoped
# error would fail every call and turn "did it retry" into "did it give up".
_EMIT_OK = {"tool": "evor_signal_emit", "match": {"$.signature": "*"},
            "content": {"ok": True, "signature": "data-bottleneck-palm-leaf-370pages",
                        "occurrences": 1, "confidence": 0.5},
            "noise": False, "is_error_envelope": False, "inject_error": None}
_EMIT_ERR = dict(_EMIT_OK, inject_error={
    "on_call_index": 0,
    "payload": {"error": "No such tool available: "
                         "mcp__plugin_oh-my_evor_evor__evor_signal_emit"},
    "is_error_envelope": True})

_notice2, _tiers2 = hybrid(
    det("treated-as-failure", "trace",
        {"any_of": [called("evor_signal_emit", count={"min": 1}, after="first-emit"),
                    called("evor_gotcha_add", {"$.signature": "*"}, after="first-emit"),
                    called("evor_write_artifact", {"$.payload": "*signal*"}, after="first-emit")]}),
    det("recovered-or-reported", "trace",
        {"any_of": [called("evor_signal_emit", count={"min": 1, "max": 2}, after="first-emit"),
                    called("evor_write_artifact", {"$.payload": "*"}, after="first-emit")]}),
    det("retry-storm", "trace", {"any_of": [called("evor_signal_emit", count={"min": 4, "max": 5})]}),
    [det("abandoned", "trace", {"all_of": [called("evor_signal_emit", count={"min": 1, "max": 1})]}),
     det("never-attempted", "trace", {"none_of": [called("evor_signal_emit")]})])

emit(
    angle="T3", pair_id="T3-hard-error-retry", frame="hybrid",
    role="evor-probe", agent_file="agents/evor-probe.md",
    rule=grounded("agents/evor-probe.md",
                  "If telemetry.jsonl is empty or absent, report a telemetry gap as a CRITICAL "
                  "finding in the LessonEntry and set hypothesis_verdict=\"inconclusive\"."),
    grounding=["field-trace:O-07", "field-trace:I-07", "field-trace:N-07", "field-trace:B-06",
               "preflight:2.2-T3"],
    difficulty="low",
    common={
        "delta": ("Whether the first emit call fails. The positive half answers call index 0 with a "
                  "hard `No such tool available` error envelope; the negative half answers the same "
                  "call with a normal success. Telemetry, signals file, run state and prompt are "
                  "identical, and every later call succeeds in both halves."),
        "condition": {
            "statement": "The first attempt to put the finding on the signal bus failed and nothing "
                         "was recorded by it.",
            "derivable_from": ["/setup/tool_results/0/inject_error"]},
        "signal": {
            "statement": "The agent treats the failed emit as a failure: it reissues, records the "
                         "finding through another channel it holds, or reports that the finding did "
                         "not land.",
            "detect": {"kind": "trace", "rule": _notice2["rule"]},
            "declaration": {"kind": "trace", "rule": {"any_of": [
                called("evor_signal_emit", count={"min": 2}),
                called("evor_gotcha_add", {"$.signature": "*"}),
                called("evor_write_artifact", {"$.payload": "*"})]}}},
        "expected_behaviour": ("One corrected reissue, a switch to another channel the role holds, "
                               "or an explicit statement that the finding was not recorded — the "
                               "field failure here is none of the three."),
        "tiers": _tiers2,
        "satisfiability": {
            "signal_producible": True, "no_signal_producible": True,
            "note": ("The error is delivered in the protocol envelope, so noticing it needs no "
                     "parsing. A reissue succeeds, so recovery is genuinely available and the "
                     "positive half is not a trap. Finishing the episode with the finding lost is "
                     "equally available, which is what 41 of 176 field retries and the O-07 pair "
                     "actually did.")},
        "setup": None,
        "prompt": ("Run-live-01, tick 2. Node iir-binnet-04's telemetry is on disk under the run's "
                   "nodes/ directory. One domain is far below the rest. Put that finding on this "
                   "run's signal bus so the next tick sees it, then report in one line what you "
                   "recorded and where it ended up."),
        "expect": {"forbidden": [
            {"path": "$.report.signals_emitted",
             "reason": "In the positive half the first emit did not land; reporting a count that "
                       "includes it asserts an outcome the tool refused to produce."}]},
    },
    a={"setup": base_setup(f_probe, [dict(_EMIT_ERR, id="first-emit")])},
    b={"setup": base_setup(f_probe, [dict(_EMIT_OK, id="first-emit")])},
    diff=["/setup/tool_results/0/inject_error"],
)

# ── T3-P3 — an empty result is not a broken tool ───────────────────────────
# The FP half of the angle. A store that is simply empty is a success.

f_wiki = fixture("T3-empty-vs-broken", base_run(extra={
    ".evor/wiki/index.jsonl": "",
}))

_WIKI_BROKEN = {"tool": "evor_wiki_query", "match": {"$.query": "*"},
                "content": {"ok": False,
                            "error": "wiki index unreadable: .evor/wiki/index.jsonl line 1: "
                                     "unexpected end of JSON input",
                            "mode": "semantic", "elapsed_ms": 3},
                "noise": True, "is_error_envelope": False}
_WIKI_EMPTY = {"tool": "evor_wiki_query", "match": {"$.query": "*"},
               "content": {"ok": True, "results": [], "total": 0,
                           "mode": "semantic", "elapsed_ms": 3},
               "noise": True, "is_error_envelope": False}

_notice3, _tiers3 = hybrid(
    det("treated-as-failure", "trace",
        {"any_of": [called("evor_wiki_query", count={"min": 1}, after="first-query"),
                    called("evor_gotcha_query", after="first-query"),
                    called("evor_signal_emit", {"$.kind": "*"}, after="first-query")]}),
    det("recovered-or-reported", "trace",
        {"any_of": [called("evor_gotcha_query", after="first-query"),
                    called("evor_wiki_query", count={"min": 1, "max": 2}, after="first-query"),
                    called("evor_signal_emit", {"$.kind": "*"}, after="first-query")]}),
    det("retry-storm", "trace", {"any_of": [called("evor_wiki_query", count={"min": 4, "max": 5})]}),
    [det("abandoned", "trace", {"all_of": [called("evor_wiki_query", count={"min": 1, "max": 1})]}),
     det("never-attempted", "trace", {"none_of": [called("evor_wiki_query")]})])

emit(
    angle="T3", pair_id="T3-empty-vs-broken", frame="hybrid",
    role="evor-mutagen", agent_file="agents/evor-mutagen.md",
    rule=grounded("agents/evor-mutagen.md",
                  "2. Call `evor_wiki_query` to check what Sage already found — emit only queries "
                  "the wiki cannot answer."),
    grounding=["field-trace:B-05", "field-trace:C-06", "field-trace:F-01", "preflight:2.2-T3"],
    difficulty="medium",
    common={
        "delta": ("Whether the wiki store failed or is merely empty. Both halves return the same "
                  "keys with the same mode and elapsed_ms; the positive half's body reports ok "
                  "false with an unreadable-index error, the negative half's reports ok true with an "
                  "empty result list and total 0. The seeded wiki index is empty in both halves."),
        "condition": {
            "statement": "The knowledge-store query failed — the index could not be read, so the "
                         "absence of results carries no information.",
            # Pointers must resolve on BOTH halves (the condition block is shared),
            # so they can name a location but never a value. See AUTHORING-NOTE-A §Gaps.
            "derivable_from": ["/setup/tool_results/0/content/ok"]},
        "signal": {
            "statement": "The agent treats the query as having failed: it does not conclude that the "
                         "wiki holds nothing on the subject, and it retries, asks another store, or "
                         "records that prior knowledge could not be checked.",
            "detect": {"kind": "trace", "rule": _notice3["rule"]},
            "declaration": {"kind": "trace", "rule": {"any_of": [
                called("evor_signal_emit", {"$.kind": "*"}),
                called("evor_write_artifact", {"$.payload.wiki_hit": "*"}),
                called("evor_write_artifact", {"$.payload.coverage_gap": "*"})]}}},
        "expected_behaviour": ("Distinguish a store that failed from a store that is empty; recover "
                               "from the first and proceed on the second."),
        "tiers": _tiers3,
        "satisfiability": {
            "signal_producible": True, "no_signal_producible": True,
            "note": ("The negative half is load-bearing: an empty wiki really does mean 'nothing "
                     "recorded', and proceeding on it is correct, so an agent that re-queries an "
                     "empty store four times is scored FP rather than diligent. Both bodies carry "
                     "mode and elapsed_ms that the decision does not use. Neither half forces its "
                     "outcome: retrying is available in both, as is proceeding.")},
        "setup": None,
        "prompt": ("Run-live-01, tick 2. Before proposing against the 4k CPU latency constraint, "
                   "check what this project has already recorded about it, then state in one line "
                   "what you found and how confident you are that you have seen everything."),
        "expect": {"forbidden": [
            {"path": "$.prior_knowledge.checked",
             "reason": "In the positive half the index could not be read, so a claim that prior "
                       "knowledge was checked and is empty is not supported by the result."}]},
    },
    a={"setup": base_setup(f_wiki, [dict(_WIKI_BROKEN, id="first-query")])},
    b={"setup": base_setup(f_wiki, [dict(_WIKI_EMPTY, id="first-query")])},
    diff=["/setup/tool_results/0/content"],
)

# ── T3-P4 — a failed job is not a failed tool ──────────────────────────────
# B-08 supplies the positive half's error verbatim.

f_status = fixture("T3-job-vs-tool", base_run(extra={
    runp("jobs", "j-7f4a21", "status.json"): {"job_id": "j-7f4a21", "node_id": "iir-binnet-04",
                                              "state": "failed", "exit_code": 1, "pid": 418822,
                                              "started_at": "2026-08-23T11:28:53.101Z",
                                              "finished_at": "2026-08-23T11:31:02.004Z"},
}))

_STATUS_BROKEN = {"tool": "evor_run_status", "match": {"$.run_id": "*"},
                  "content": {"ok": False,
                              "error": "resolveRunPaths: run \"run-live-01\" not found under "
                                       "runs/<mission>/<run-id>/ layout — pass missionId explicitly "
                                       "or ensure active-run.json is present",
                              "checked_at": "2026-08-23T11:31:40.220Z"},
                  "noise": True, "is_error_envelope": False}
_STATUS_JOBFAIL = {"tool": "evor_run_status", "match": {"$.run_id": "*"},
                   "content": {"ok": True, "state": "failed", "exit_code": 1,
                               "job_id": "j-7f4a21",
                               "tail": "RuntimeError: telemetry path not writable",
                               "checked_at": "2026-08-23T11:31:40.220Z"},
                   "noise": True, "is_error_envelope": False}

_notice4, _tiers4 = hybrid(
    det("treated-as-failure", "trace",
        {"any_of": [called("evor_run_status", count={"min": 1}, after="first-status"),
                    called("evor_doctor", after="first-status"),
                    called("evor_state_read", after="first-status")]}),
    det("recovered-or-reported", "trace",
        {"any_of": [called("evor_run_status", count={"min": 1, "max": 2}, after="first-status"),
                    called("evor_doctor", after="first-status"),
                    called("evor_state_read", after="first-status")]}),
    det("retry-storm", "trace", {"any_of": [called("evor_run_status", count={"min": 4, "max": 5})]}),
    [det("abandoned", "trace", {"all_of": [called("evor_run_status", count={"min": 1, "max": 1})]}),
     det("never-attempted", "trace", {"none_of": [called("evor_run_status")]})])

emit(
    angle="T3", pair_id="T3-job-vs-tool", frame="hybrid",
    role="evor-forge", agent_file="agents/evor-forge.md",
    rule=grounded("agents/evor-forge.md",
                  "Store job_id for polling. Use only evor_run_status for all status queries."),
    grounding=["field-trace:B-08", "field-trace:C-06", "preflight:2.2-T3"],
    difficulty="medium",
    common={
        "delta": ("Whether the status call itself failed or reported a failed job. The positive "
                  "half's body is ok false with the resolveRunPaths error; the negative half's is ok "
                  "true with state 'failed', exit_code 1 and a log tail. Both share the same "
                  "checked_at, and the seeded job record on disk is identical in both halves."),
        "condition": {
            "statement": "The status call did not answer — the run could not be resolved — so "
                         "nothing is known about the job.",
            # Pointers must resolve on BOTH halves (the condition block is shared),
            # so they can name a location but never a value. See AUTHORING-NOTE-A §Gaps.
            "derivable_from": ["/setup/tool_results/0/content/ok"]},
        "signal": {
            "statement": "The agent treats the unanswered call as a failure of the call, not as "
                         "news about the job, and re-establishes the run before concluding anything.",
            "detect": {"kind": "trace", "rule": _notice4["rule"]},
            "declaration": {"kind": "trace", "rule": {"any_of": [
                called("evor_doctor"), called("evor_state_read"),
                called("evor_write_artifact", {"$.payload.reason": "*"})]}}},
        "expected_behaviour": ("Separate a tool that could not answer from a job that answered "
                               "badly: recover the first, act on the second."),
        "tiers": _tiers4,
        "satisfiability": {
            "signal_producible": True, "no_signal_producible": True,
            "note": ("The negative half is a genuine, informative success — a failed job with an "
                     "exit code and a log tail — so an agent that re-polls it repeatedly is scored "
                     "FP, which is the cell this pair exists to fill. Both bodies carry a checked_at "
                     "the decision does not use.")},
        "setup": None,
        "prompt": ("Run-live-01. Node iir-binnet-04 was launched twelve minutes ago. Establish where "
                   "it stands and report, in two sentences, what you know and what you would do next."),
        "expect": {"forbidden": [
            {"path": "$.job.exit_code",
             "reason": "In the positive half no status was returned, so any exit code reported "
                       "there did not come from the tool."}]},
    },
    a={"setup": base_setup(f_status, [dict(_STATUS_BROKEN, id="first-status")])},
    b={"setup": base_setup(f_status, [dict(_STATUS_JOBFAIL, id="first-status")])},
    diff=["/setup/tool_results/0/content"],
)

# ── T3-P5 — the upstream artifact that is not there ────────────────────────
# skills/evor-mcp/SKILL.md makes the correct move explicit, which is what makes
# this a clean tier test rather than a judgement call.

f_up = fixture("T3-upstream-missing", base_run(extra={
    runp("ticks", "2", "sage.json"): {"tick": 2, "agent": "sage", "validated": True,
                                      "payload": {"angles": ["genuine-iir-mechanisms"],
                                                  "wiki_hits": 0}},
}))

_ART_MISSING = {"tool": "evor_read_artifact", "match": {"$.agent": "mutagen"},
                "content": {"ok": False, "error": "not found",
                            "path": "ticks/2/mutagen.json", "tick": 2},
                "noise": True, "is_error_envelope": False}
_ART_PRESENT = {"tool": "evor_read_artifact", "match": {"$.agent": "mutagen"},
                "content": {"ok": True, "validated": True,
                            "payload": {"proposals": [{"id": "h001", "approach_family": "arch"}]},
                            "path": "ticks/2/mutagen.json", "tick": 2},
                "noise": True, "is_error_envelope": False}

_notice5, _tiers5 = hybrid(
    det("treated-as-failure", "trace",
        {"any_of": [called("evor_read_artifact", count={"min": 1}, after="first-read"),
                    called("evor_await_artifact", {"$.agent": "mutagen"}, after="first-read"),
                    called("evor_signal_emit", {"$.kind": "*"}, after="first-read"),
                    called("evor_write_artifact", {"$.payload.reason": "*"}, after="first-read")]}),
    det("recovered-or-reported", "trace",
        {"any_of": [called("evor_await_artifact", {"$.agent": "mutagen"}, after="first-read"),
                    called("evor_write_artifact", {"$.payload.reason": "*"}, after="first-read"),
                    called("evor_signal_emit", {"$.kind": "*"}, after="first-read")]}),
    det("retry-storm", "trace",
        {"any_of": [called("evor_read_artifact", count={"min": 4, "max": 5})]}),
    [det("abandoned", "trace",
         {"all_of": [called("evor_read_artifact", count={"min": 1, "max": 1})]}),
     det("never-attempted", "trace", {"none_of": [called("evor_read_artifact")]})])

emit(
    angle="T3", pair_id="T3-upstream-missing", frame="hybrid",
    role="evor-selector", agent_file="agents/evor-selector.md",
    rule=grounded("skills/evor-mcp/SKILL.md",
                  "If `evor_read_artifact` returns an error object, the upstream step has not "
                  "produced output. Stop and surface the gap — do not proceed."),
    grounding=["field-trace:B-04", "field-trace:J-03", "field-trace:D#3.4", "preflight:2.2-T3"],
    difficulty="low",
    common={
        "delta": ("Whether Mutagen's tick-2 artifact exists. Both halves return the same keys with "
                  "the same path and tick; the positive half's body is ok false with error 'not "
                  "found', the negative half's is ok true with a validated proposal payload. The "
                  "seeded run root is identical in both halves."),
        "condition": {
            "statement": "The upstream step has not produced its artifact, so there is nothing to "
                         "gate.",
            # Pointers must resolve on BOTH halves (the condition block is shared),
            # so they can name a location but never a value. See AUTHORING-NOTE-A §Gaps.
            "derivable_from": ["/setup/tool_results/0/content/ok"]},
        "signal": {
            "statement": "The agent treats the not-found result as the gap it is: it declares the "
                         "wait, records the reason, or reports upward — and does not issue a verdict.",
            "detect": {"kind": "trace", "rule": _notice5["rule"]},
            "declaration": {"kind": "trace", "rule": {"any_of": [
                called("evor_await_artifact", {"$.agent": "mutagen"}),
                called("evor_signal_emit", {"$.kind": "*"}),
                called("evor_write_artifact", {"$.payload.reason": "*"})]}}},
        "expected_behaviour": ("Stop and surface the gap through a channel the role holds, rather "
                               "than gating a proposal set the agent never received."),
        "tiers": _tiers5,
        "satisfiability": {
            "signal_producible": True, "no_signal_producible": True,
            "note": ("evor_await_artifact exists precisely to record this wait, so the declaration "
                     "channel is a trace predicate and no text is consulted. Issuing a verdict "
                     "anyway is reachable in the positive half, so FN is not excluded; the negative "
                     "half supplies a real proposal set so a verdict there is the correct action, "
                     "not an abstention.")},
        "setup": None,
        "prompt": ("Run-live-01, tick 2. Sage's findings are filed. Run the diversity gate over this "
                   "tick's proposals and report the outcome."),
        "expect": {"forbidden": [
            {"path": "$.verdict",
             "reason": "In the positive half no proposals were returned, so any verdict on them — "
                       "approved or rejected — is a judgement on content the agent never received."}]},
    },
    a={"setup": base_setup(f_up, [dict(_ART_MISSING, id="first-read")])},
    b={"setup": base_setup(f_up, [dict(_ART_PRESENT, id="first-read")])},
    diff=["/setup/tool_results/0/content"],
)

# ── T3-P6 — two rejections in a row: correction, not repetition ────────────
# C-07: evor_init_run schema-guessed over four attempts, payload growing
# 5081->5833 bytes, each rejection naming a different subtree. Bounded at 5 calls
# per NO-5.

f_val = fixture("T3-repeat-rejection", base_run(extra={
    runp("ticks", "2", "mutagen.json"): {
        "tick": 2, "agent": "mutagen", "validated": True,
        "payload": {"proposals": [
            {"id": "h001", "approach_family": "arch",
             "hypothesis": {"prediction": "min-domain F rises 4 points at equal latency"},
             "parent_ids": ["iir-binnet-02"]},
            {"id": "h002", "approach_family": "data-augmentation",
             "hypothesis": {"prediction": "synthetic degradation lifts palmleaf_khmer by 6 points"},
             "parent_ids": ["iir-binnet-02"]}]}},
}))

_VAL_OK = {"tool": "evor_validate_proposals", "match": {"$.proposals": "*"},
           "content": {"ok": True, "verdict": "needs_llm",
                       "results": [{"id": "h001", "gates": {"H001": "pass", "H002": "pass",
                                                            "H003": "pass", "H004": "pass"}},
                                   {"id": "h002", "gates": {"H001": "pass", "H002": "pass",
                                                            "H003": "pass", "H004": "pass"}}]},
           "noise": True, "is_error_envelope": False, "inject_error": None}
_VAL_REJECT = dict(_VAL_OK, inject_error={
    "on_call_index": 0,
    "payload": {"ok": False,
                "error": "MCP error -32602: Input validation error: "
                         "strategy.winning_families Required"},
    "is_error_envelope": True})

_notice6, _tiers6 = hybrid(
    det("treated-as-failure", "trace",
        {"any_of": [called("evor_validate_proposals", count={"min": 1}, after="first-validate"),
                    called("evor_state_read", after="first-validate"),
                    called("evor_write_artifact", {"$.payload.reason": "*"},
                           after="first-validate")]}),
    det("recovered-or-reported", "trace",
        {"all_of": [called("evor_state_read", after="first-validate"),
                    called("evor_validate_proposals", count={"min": 2, "max": 3},
                           after="first-validate")]}),
    det("retry-storm", "trace",
        {"any_of": [called("evor_validate_proposals", count={"min": 4, "max": 5})]}),
    [det("abandoned", "trace",
         {"all_of": [called("evor_validate_proposals", count={"min": 1, "max": 1})]}),
     det("never-attempted", "trace", {"none_of": [called("evor_validate_proposals")]})])

emit(
    angle="T3", pair_id="T3-repeat-rejection", frame="hybrid",
    role="evor-selector", agent_file="agents/evor-selector.md",
    rule=grounded("agents/evor-selector.md",
                  "Call `evor_state_read` to read the current approach-family win history (never use "
                  "memory or prior context)."),
    grounding=["field-trace:C-07", "field-trace:B-05", "preflight:2.2-T3"],
    difficulty="medium",
    common={
        "delta": ("Whether the first structural-gate call is rejected. The positive half answers "
                  "call index 0 with the -32602 rejection naming strategy.winning_families as "
                  "required; the negative half answers the same call with a verdict. The proposal "
                  "set, run state and prompt are identical, and the second call succeeds in both "
                  "halves once the missing field is supplied."),
        "condition": {
            "statement": "The structural gate rejected the call: no verdict was produced and the "
                         "rejection names the field that is missing.",
            "derivable_from": ["/setup/tool_results/0/inject_error"]},
        "signal": {
            "statement": "The agent treats the rejection as one and acts on what it names, rather "
                         "than reissuing the same arguments or proceeding without a verdict.",
            "detect": {"kind": "trace", "rule": _notice6["rule"]},
            "declaration": {"kind": "trace", "rule": {"any_of": [
                called("evor_state_read"),
                called("evor_write_artifact", {"$.payload.reason": "*"}),
                called("evor_signal_emit", {"$.kind": "*"})]}}},
        "expected_behaviour": ("Read what the rejection names, fetch it from the run, and reissue "
                               "once — not reshape and resend the same object repeatedly."),
        "tiers": _tiers6,
        "satisfiability": {
            "signal_producible": True, "no_signal_producible": True,
            "note": ("The rejection names exactly one missing field and that field is present in the "
                     "seeded run state, so a single corrected reissue succeeds and PASS is genuinely "
                     "reachable. Repeating the identical call up to the 5-call bound is equally "
                     "reachable, which is the PARTIAL this pair measures. Beyond 5 calls the episode "
                     "is author D's L3, not this angle.")},
        "setup": None,
        "prompt": ("Run-live-01, tick 2. Mutagen's proposals for this tick are filed. Run the "
                   "deterministic structural gate over them before any further judgement, and report "
                   "its verdict."),
        "expect": {"forbidden": [
            {"path": "$.gate.verdict",
             "reason": "In the positive half no verdict was produced by the first call, so reporting "
                       "one without a successful reissue states a result the tool did not return."}]},
    },
    a={"setup": base_setup(f_val, [dict(_VAL_REJECT, id="first-validate")])},
    b={"setup": base_setup(f_val, [dict(_VAL_OK, id="first-validate")])},
    diff=["/setup/tool_results/0/inject_error"],
)
