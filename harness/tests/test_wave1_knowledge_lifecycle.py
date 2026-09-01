"""harness/tests/test_wave1_knowledge_lifecycle.py — wave 2, category 6 (RED phase)

Failing tests for the Python-side knowledge-lifecycle findings of the v1.2.0
field trace (docs/field-trace-v1.2.0/lanes/lane-n-knowledge-memory.md).

Every test asserts the invariant the system SHOULD hold, never the behaviour the
run exhibited. Nothing is fixed here; this file is the specification.

  N-06  Gotcha `cpu-4k-latency-gate-requires-lt-3kmac-per-pixel` (confidence 1.0)
        encoded r1's gate. r3's contract relaxed that gate 10x and 50x. The gotcha
        was never revised, was retrieved verbatim by five r3 agents, and the
        Selector rejected the two proposals aimed at the actual bottleneck for
        lacking kMAC/px estimates. `occurrences` and `confidence` only ratchet UP:
        there is no decay, contradiction, or supersede-by-contract-change path.

  N-08  r1 wrote 5 mission-scoped gotchas that r2 and r3 could never see, and the
        same agent chose "mission" and "global" for equivalent facts within four
        minutes. Scope must follow a rule, not agent whim.

  N-10  `private-dataloader-test-leakage-iir-binnet-01` was stored at confidence
        0.5 and every r3 query used min_confidence 0.6-0.8, so an UNRESOLVED
        defect was filtered out of all five retrievals. Low confidence in a
        not-yet-diagnosed problem makes it less visible rather than more.

  N-04  CBAM was attributed to arXiv 2006.05595 ("Fitted Q-Learning for Relational
        Domains"). The only check was the junior's own `urls_verified: true`.
        No network access here — the assertion is that a server-side verification
        record exists at all.
"""

from __future__ import annotations

import importlib
from datetime import datetime, timezone
from pathlib import Path

import pytest
from pydantic import ValidationError

from evor.contracts import CitationBackedFinding, GotchaEntry
from evor.gotchas import GotchaStore, make_gotcha

# Portable harness dir (this file lives in <harness>/tests/). Works on the host
# and inside the container — do NOT hardcode.
_HARNESS_DIR = Path(__file__).resolve().parent.parent


# ─────────────────────────────────────────────────────────────────────────────
# Helpers — the r1 gotcha verbatim, so the fixture is the real defect
# ─────────────────────────────────────────────────────────────────────────────


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _stale_latency_gotcha(confidence: float = 1.0) -> GotchaEntry:
    """The r1 gotcha that survived its own invalidation and cost r3 two proposals."""
    return make_gotcha(
        kind="hardware-constraint",
        signature="cpu-4k-latency-gate-requires-lt-3kmac-per-pixel",
        context={"gate": "cpu_4k_latency_s < 0.1", "budget_kmac_per_px": "1-3"},
        resolution="Screen proposals by kMAC/px before training.",
        avoidance="Reject any architecture above ~3 kMAC/px; it cannot meet the 4k CPU gate.",
        scope="global",
        confidence=confidence,
    )


# ─────────────────────────────────────────────────────────────────────────────
# N-06 — stale knowledge must be supersedable
# ─────────────────────────────────────────────────────────────────────────────


class TestGotchaSupersession:
    def test_entry_contract_can_express_supersession(self) -> None:
        """A gotcha must be able to say it has been invalidated.

        Without a field for it, the only representations available are "delete"
        (loses the history) and "leave standing" (what happened).
        """
        fields = set(GotchaEntry.model_fields)
        assert any(
            key in name
            for name in fields
            for key in ("superseded", "invalidated", "retracted", "status")
        ), (
            "GotchaEntry has no supersession marker "
            f"(fields: {sorted(fields)}) — confidence 1.0 is terminal, so a gotcha "
            "encoding a gate that a later contract relaxed 10x stays authoritative forever"
        )

    def test_store_exposes_a_supersede_path(self, tmp_path: Path) -> None:
        store = GotchaStore(tmp_path / ".evor")
        store.add_gotcha(_stale_latency_gotcha())

        supersede = getattr(store, "supersede_gotcha", None)
        assert callable(supersede), (
            "GotchaStore has no supersede/invalidate method — add_gotcha only ever "
            "ratchets occurrences and confidence UP. The r3 contract relaxed the gate "
            "this gotcha encodes (0.1s -> 1s CPU, 10ms -> 500ms GPU) and nothing in the "
            "store could record that"
        )

    def test_superseded_gotcha_is_not_returned_unflagged(self, tmp_path: Path) -> None:
        """The retrieval path is where the cost was paid: five r3 agents got it verbatim."""
        store = GotchaStore(tmp_path / ".evor")
        store.add_gotcha(_stale_latency_gotcha())

        supersede = getattr(store, "supersede_gotcha", None)
        assert callable(supersede), (
            "no supersede path exists, so a retrieval-time flag cannot exist either — "
            "see test_store_exposes_a_supersede_path"
        )
        supersede(
            signature="cpu-4k-latency-gate-requires-lt-3kmac-per-pixel",
            reason="r3 contract relaxed the gate to latency_cpu_4k_s < 1 / latency_gpu_ms < 500",
        )

        results = store.query_gotchas(min_confidence=0.8)
        for entry in results:
            if entry.signature == "cpu-4k-latency-gate-requires-lt-3kmac-per-pixel":
                dumped = entry.model_dump()
                assert any(
                    "superseded" in str(k) or "invalidated" in str(k) for k in dumped
                ) and any(bool(v) for k, v in dumped.items() if "superseded" in str(k)), (
                    "a superseded gotcha was returned with nothing marking it stale; "
                    "the agent reading it cannot tell it encodes a retired contract gate"
                )

    def test_contradicting_evidence_lowers_confidence(self, tmp_path: Path) -> None:
        """r2 and r3 both recorded that kMAC/px is a poor predictor. Nothing moved."""
        store = GotchaStore(tmp_path / ".evor")
        store.add_gotcha(_stale_latency_gotcha(confidence=1.0))

        contradict = getattr(store, "record_contradiction", None)
        assert callable(contradict), (
            "GotchaStore has no way to record a contradiction. add_gotcha halves the gap "
            "to 1.0 on every repeat, so confidence is monotonically increasing and a fact "
            "measured to be wrong twice keeps its 1.0"
        )
        contradict(
            signature="cpu-4k-latency-gate-requires-lt-3kmac-per-pixel",
            evidence="r2 and r3 lessons: kMAC/px is a poor predictor of measured latency",
        )

        after = [
            e
            for e in store.query_gotchas()
            if e.signature == "cpu-4k-latency-gate-requires-lt-3kmac-per-pixel"
        ]
        assert after and after[0].confidence < 1.0, (
            "confidence did not fall after a recorded contradiction"
        )


# ─────────────────────────────────────────────────────────────────────────────
# N-10 — an unresolved gotcha must not be hidden by the confidence floor
# ─────────────────────────────────────────────────────────────────────────────


class TestUnresolvedGotchaVisibility:
    @pytest.mark.parametrize(
        "resolution",
        ["", "Not yet resolved — audit data/builder.py for the split boundary."],
    )
    def test_unresolved_gotcha_survives_the_min_confidence_floor(
        self, tmp_path: Path, resolution: str
    ) -> None:
        """`private-dataloader-test-leakage-iir-binnet-01`, confidence 0.5.

        Every r3 query used min_confidence 0.6 or 0.8, so an open, undiagnosed
        test-leakage defect was filtered out of all five retrievals. Confidence
        measures how sure we are of the DIAGNOSIS; an unresolved problem is
        low-confidence precisely because it needs attention.
        """
        store = GotchaStore(tmp_path / ".evor")
        store.add_gotcha(
            make_gotcha(
                kind="runtime-failure",
                signature="private-dataloader-test-leakage-iir-binnet-01",
                context={"node": "iir-binnet-01"},
                resolution=resolution,
                avoidance="Audit the data loader split before trusting any score from this node.",
                scope="global",
                confidence=0.5,
            )
        )

        signatures = [e.signature for e in store.query_gotchas(min_confidence=0.8)]
        assert "private-dataloader-test-leakage-iir-binnet-01" in signatures, (
            "an UNRESOLVED gotcha was filtered out by min_confidence=0.8 — this is the "
            "exact retrieval that hid a live test-leakage defect from all five r3 agents"
        )


# ─────────────────────────────────────────────────────────────────────────────
# N-08 — scope must follow a rule, not agent whim
# ─────────────────────────────────────────────────────────────────────────────


class TestGotchaScopeIsRuleDetermined:
    def test_a_deterministic_scope_rule_exists(self) -> None:
        """r1 wrote 5 mission-scoped gotchas, invisible to r2 and r3.

        Three of the five duplicate a global twin the SAME agent wrote minutes
        earlier, so the scope choice was not carrying any distinction — it was
        whim. If scope is agent-chosen with a silent default, equivalent facts
        land in different stores and some are lost at mission boundaries.
        """
        gotchas = importlib.import_module("evor.gotchas")
        rule = next(
            (
                getattr(gotchas, name)
                for name in ("scope_for_gotcha", "choose_scope", "resolve_scope")
                if callable(getattr(gotchas, name, None))
            ),
            None,
        )
        assert rule is not None, (
            "evor.gotchas exports no scope-selection rule; scope is a free parameter "
            "with a default, so the same agent scoped equivalent facts 'mission' and "
            "'global' within ~4 minutes and the mission-scoped five were lost at the "
            "r1 -> r2 boundary"
        )

    def test_the_rule_is_stable_for_equivalent_facts(self) -> None:
        gotchas = importlib.import_module("evor.gotchas")
        rule = next(
            (
                getattr(gotchas, name)
                for name in ("scope_for_gotcha", "choose_scope", "resolve_scope")
                if callable(getattr(gotchas, name, None))
            ),
            None,
        )
        assert rule is not None, "no scope rule to test — see test_a_deterministic_scope_rule_exists"

        # Two of r1's real pairs: a mission-scoped entry and its global twin.
        a = rule(kind="hardware-constraint", signature="cpu-4k-100ms-gate-implies-3kmac-per-pixel-ceiling")
        b = rule(kind="hardware-constraint", signature="cpu-4k-latency-gate-implies-hard-macs-per-pixel-budget")
        assert a == b, (
            f"the rule scopes two equivalent hardware constraints differently ({a!r} vs {b!r})"
        )


# ─────────────────────────────────────────────────────────────────────────────
# N-04 — a self-asserted urls_verified flag is not verification
# ─────────────────────────────────────────────────────────────────────────────


class TestCitationVerificationIsServerSide:
    def test_finding_carries_a_server_side_verification_record(self) -> None:
        """CBAM -> arXiv 2006.05595 ("Fitted Q-Learning for Relational Domains").

        The junior emitted `urls_verified: true` about its own work and nothing
        checked it. The contract needs a field the SERVER fills from a resolver,
        distinct from anything the agent can assert about itself.
        """
        fields = set(CitationBackedFinding.model_fields)
        assert any(
            key in name
            for name in fields
            for key in ("verification", "resolved_titles", "verified_sources")
        ), (
            "CitationBackedFinding has no server-filled citation-verification field "
            f"(fields: {sorted(fields)}) — the only signal of citation integrity in the "
            "whole pipeline is the junior's own urls_verified flag, and 3 of 20 sampled "
            "citations were misattributed"
        )

    def test_the_agent_cannot_self_assert_verification(self) -> None:
        """`urls_verified` must not be a claim the emitting agent can make.

        evor-sage-junior.md tells the junior to emit `"urls_verified": true`. The
        field is not in the contract at all, so pydantic silently drops it: the
        agent believes it declared verification, the store records nothing, and
        the pipeline treats the finding exactly as it treats a checked one.
        """
        try:
            CitationBackedFinding(
                title="CBAM focuses strokes on palm-leaf",
                source_url="https://arxiv.org/abs/2006.05595",
                sources=["https://arxiv.org/abs/2006.05595"],
                finding="CBAM channel+spatial attention focuses on engraved strokes.",
                evidence="Reported in the cited paper.",
                confidence="high",
                trust_level="authoritative",
                applicable_families=["arch"],
                quorum_met=True,
                urls_verified=True,
            )
        except ValidationError:
            return
        pytest.fail(
            "CitationBackedFinding silently accepted and discarded a self-asserted "
            "urls_verified=True. An agent-authored verification claim must be rejected "
            "outright, not swallowed — this is the only 'check' that stood between a "
            "junior finding and evor_wiki_add"
        )
