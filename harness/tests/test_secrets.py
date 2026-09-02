"""§2b.4 — the credential affordance and its redaction net.

RC8's root cause: *"There is no secure path; chat was the only channel."* A
mission needed an API key, there was nowhere to put it, and it was pasted into
the conversation — from where it reached `settings.json`, two transcripts, an
API, and every subsequent resume. The operator did nothing unusual; they used
the only channel the system offered.

A guard would not have helped, because there was nothing to guard. The fix is
the affordance (`docs/credentials.md`); this is the net under it.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from evor.secrets import describe, redact

DOCS = Path(__file__).resolve().parents[2] / "docs" / "credentials.md"

# Obviously synthetic. A real credential must never appear in a test, a fixture
# or a report — that rule is why the field key is only ever referred to by shape.
FAKE_S2 = "s2k-TESTONLY-0000000000000000000000000000000"
FAKE_HF = "hf_TESTONLY000000000000000000000"


class TestRedaction:
    @pytest.mark.parametrize("secret,label", [(FAKE_S2, "semantic-scholar"), (FAKE_HF, "huggingface")])
    def test_a_known_shape_is_replaced(self, secret: str, label: str):
        out = redact(f"calling with {secret} now")
        assert secret not in out
        assert label in out

    @pytest.mark.parametrize("secret", [FAKE_S2, FAKE_HF])
    def test_a_four_char_preview_survives(self, secret: str):
        # A redacted log still has to be usable: an operator needs to know WHICH
        # key was involved. Every trace document already refers to the exposed
        # key as `s2k-` + a length, and a redactor that erases the identity as
        # well as the value turns a debuggable log into an undebuggable one.
        out = redact(f"key: {secret}")
        assert secret not in out
        assert out.startswith(f"key: {secret[:4]}")
        assert str(len(secret)) in out

    def test_the_surrounding_text_survives(self):
        out = redact(f"HTTP 401 from api.semanticscholar.org using {FAKE_S2}")
        assert "HTTP 401" in out and "semanticscholar.org" in out

    def test_several_secrets_in_one_string(self):
        out = redact(f"{FAKE_S2} and {FAKE_HF}")
        assert FAKE_S2 not in out and FAKE_HF not in out

    def test_an_operator_supplied_value_is_redacted_whatever_its_shape(self):
        # The part that generalises: the operator told us what the secret is, so
        # we do not have to recognise its shape.
        weird = "correct-horse-battery-staple-1234"
        assert weird not in redact(f"auth={weird}", extra=[weird])

    def test_env_secrets_are_redacted(self, monkeypatch):
        monkeypatch.setenv("SOME_API_KEY", "zzzzzzzzzzzzzzzzzz")
        assert "zzzzzzzzzzzzzzzzzz" not in redact("using zzzzzzzzzzzzzzzzzz")

    def test_a_short_env_value_is_not_treated_as_a_secret(self, monkeypatch):
        # Redacting "dev" everywhere would make logs useless and get the
        # redactor turned off, which is worse than not having one.
        monkeypatch.setenv("MY_TOKEN", "dev")
        assert redact("running in dev mode") == "running in dev mode"


class TestNoFalsePositives:
    @pytest.mark.parametrize("text", [
        "the sk- prefix is discussed in docs/credentials.md",
        "see hf_ tokens in the HuggingFace docs",
        "s2k is the Semantic Scholar key prefix",
        "no secrets here at all",
    ])
    def test_prose_about_credentials_is_not_mangled(self, text: str):
        assert redact(text) == text


class TestDescribe:
    def test_it_reports_shape_never_value(self):
        out = describe(FAKE_S2)
        assert FAKE_S2 not in out
        assert "s2k-" in out and str(len(FAKE_S2)) in out

    def test_this_is_how_every_trace_document_refers_to_the_key(self):
        assert describe("s2k-" + "x" * 40) == "s2k-… (44 chars)"


class TestTheAffordanceIsDocumented:
    """The fix is the path, not the filter. If the path is undocumented there is
    no path, and the next operator will use the only channel they can see."""

    def test_the_document_exists(self):
        assert DOCS.exists(), "docs/credentials.md IS item 2b.4; the redactor is only its net"

    def test_it_names_where_a_secret_goes(self):
        text = DOCS.read_text()
        assert ".env" in text
        assert "settings.json" in text

    def test_it_says_relocating_is_not_rotating(self):
        # The distinction that matters right now: moving a burned key to a new
        # file changes where it is stored, not whether it is compromised.
        text = DOCS.read_text().lower()
        assert "revoke" in text
        assert "changes where it is stored, not whether it is compromised" in text

    def test_it_contains_no_real_credential(self):
        # A document about not leaking secrets that leaks one would be the
        # funniest possible failure, so it is asserted.
        assert redact(DOCS.read_text()) == DOCS.read_text()
