# Credentials — the documented, non-chat path

**Plan item 2b.4.** Closes the condition that produced finding **R-01**.

## Why this document exists

evor handles no credential anywhere. It has neither a filter nor an affordance
for one, and RC8's root cause is the consequence:

> **There is no secure path; chat was the only channel.**

A mission needed a Semantic Scholar API key. There was nowhere to put it, so it
was pasted into the conversation — where it was written to `settings.json`,
captured verbatim in two transcripts, sent to an API, and replayed on every
resume. The operator did nothing unusual. They used the only channel the system
offered.

A guard would not have helped. There was nothing to guard: no slot, no reader, no
redaction point, because the system had no concept of a secret at all. This is
the affordance-gap shape exactly — the system could not express something real,
so a human improvised outside it, and the improvisation is now catalogued as a
security finding.

## Where a secret goes

**Never in chat, never in a skill file, never in a contract, never in an agent
prompt.** Those are all captured in transcripts.

### 1. A `.env` beside the mission

```
~/your-project/.env          # gitignored; the harness reads it, nothing echoes it
SEMANTIC_SCHOLAR_API_KEY=...
HF_TOKEN=...
```

`.evor/.env` works the same way and has been gitignored since before v1.2.1. The
project-root `.env` was **not** ignored until this release — it sat one
`git add -A` away from history, which is its own instance of the same gap.

### 2. The environment, for MCP servers

`.mcp.json` used to carry:

```json
"headers": { "Authorization": "Bearer ${user_config.hf_token}" }
```

If `hf_token` is unset, that placeholder does not disappear — the header goes on
the wire as the literal string `"Bearer "`. A malformed credential is worse than
no credential: the request is not anonymous, it is broken, and the server's
rejection describes a problem that is not the real one. Finding **R-14**.

It is removed. `HF_TOKEN` belongs in `.env`, where the harness reads it and
nothing echoes it — which is this document's whole point. A config placeholder
that silently degrades to a broken value is not a credential path.

### 3. The host's own config, for host-level tools

MCP servers configured in `settings.json` take their secrets through the `env`
block of their own server definition. That file is read by the host, not by an
agent, and never enters a transcript unless something prints it.

## Rules for anything that touches one

1. **Read from the environment, never from a parameter.** A secret passed as a
   tool argument is in the tool-call record, which is in the transcript.
2. **Never echo one.** Not in an error, not in a debug line, not in a retry
   message. `redact()` below is the single emission point.
3. **Refer to a secret by shape, never by value** — `s2k-` + 44 chars. Every
   document in `docs/field-trace-v1.2.0/` refers to the exposed key this way,
   including the ones written by agents that had it in context.
4. **Rotation is the operator's action.** No agent may rotate, and no agent
   should claim a key is safe because it has been moved. Relocating a key
   changes where it is stored, not whether it is compromised.

## Redaction

`harness/evor/secrets.py` provides `redact(text)`, applied at every point that
emits text an operator or a log will see. It is pattern-based and therefore
incomplete by construction — it is a safety net under rule 2, not a substitute
for it.

## If a key has been exposed

1. **Revoke it at the provider.** This is the only step that makes the old value
   worthless, and nothing else on this list substitutes for it.
2. Issue a new one and put it in `.env`.
3. Scrub the transcripts (`~/.claude/projects/**/*.jsonl`) — this reduces further
   spread; it does not undo the exposure.

Steps 2 and 3 without step 1 leave a live credential in every place it has
already reached.
