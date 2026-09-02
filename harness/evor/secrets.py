"""Redaction at the emission point — plan item 2b.4.

evor handles no credential anywhere, which is why it had neither a filter nor an
affordance for one. RC8's root cause: *"There is no secure path; chat was the
only channel."* A mission needed an API key, there was nowhere to put it, and it
was pasted into the conversation — from where it reached `settings.json`, two
transcripts, an API, and every subsequent resume.

`docs/credentials.md` is the affordance: the documented place a secret goes. This
module is the safety net under it.

**It is incomplete by construction.** Pattern matching cannot know every secret
shape, and a redactor that claimed to is worse than one that does not, because it
invites relying on it. The rule remains: never emit a secret. This catches the
cases where the rule was broken anyway.
"""

from __future__ import annotations

import os
import re
from typing import Iterable

#: Known credential shapes. Each is anchored on a distinctive prefix, so ordinary
#: prose does not trip it — a redactor with false positives gets turned off.
_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("semantic-scholar", re.compile(r"\bs2k-[A-Za-z0-9_-]{20,60}\b")),
    ("huggingface", re.compile(r"\bhf_[A-Za-z0-9_-]{20,60}\b")),
    ("openai", re.compile(r"\bsk-[A-Za-z0-9_-]{20,80}\b")),
    ("anthropic", re.compile(r"\bsk-ant-[A-Za-z0-9_-]{20,120}\b")),
    ("github", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,80}\b")),
    ("aws-access-key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    # Character classes stay permissive: over-matching something credential-shaped
    # costs a placeholder in a log, under-matching costs a leaked key.
    ("slack", re.compile(r"\bxox[abposr]-[A-Za-z0-9-]{10,}\b")),
    ("bearer", re.compile(r"(?i)\b(authorization:\s*bearer)\s+\S+")),
)

#: Environment variables whose VALUES are redacted wherever they appear, however
#: they are shaped. This is the part that generalises: the operator told us what
#: the secret is by putting it here, so we do not have to recognise it.
_SECRET_ENV_HINTS = ("KEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD", "CREDENTIAL")


def describe(secret: str) -> str:
    """How to refer to a secret in prose: shape, never value.

    Every document in `docs/field-trace-v1.2.0/` refers to the exposed key this
    way, including the ones written by agents that had the value in context.
    """
    s = str(secret)
    prefix = s.split("-")[0] + "-" if "-" in s[:8] else s[:4]
    return f"{prefix}… ({len(s)} chars)"


def _env_secrets() -> list[str]:
    out: list[str] = []
    for name, value in os.environ.items():
        if not value or len(value) < 12:
            continue
        if any(hint in name.upper() for hint in _SECRET_ENV_HINTS):
            out.append(value)
    return out


def redact_secrets(text: str, extra: Iterable[str] = ()) -> str:
    """Replace credential-shaped substrings with a labelled placeholder.

    Applied at every point that emits text an operator or a log will see.

    The replacement keeps a FOUR-CHARACTER PREVIEW — `s2k-…` — because a
    redacted log still has to be usable: an operator reading it needs to know
    WHICH key was involved, and every trace document in
    `docs/field-trace-v1.2.0/` already refers to the exposed key that way. A
    redaction that erases the identity as well as the value turns a debuggable
    log into an undebuggable one, and a redactor that makes logs useless is a
    redactor that gets switched off.
    """
    if not text:
        return text
    out = str(text)

    # Exact known values first: an operator-supplied secret is redacted whatever
    # shape it has, which is the only part of this that generalises.
    for value in list(extra) + _env_secrets():
        if value and value in out:
            out = out.replace(value, f"{value[:4]}…[REDACTED:{len(value)} chars]")

    for label, pattern in _PATTERNS:
        out = pattern.sub(
            lambda m, _l=label: f"{m.group(0)[:4]}…[REDACTED:{_l}, {len(m.group(0))} chars]",
            out,
        )
    return out


#: The original name. Kept so existing callers keep working — renaming a
#: redaction helper and leaving a dead call site is how a surface stops being
#: redacted.
redact = redact_secrets
