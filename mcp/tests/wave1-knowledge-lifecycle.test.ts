/**
 * mcp/tests/wave1-knowledge-lifecycle.test.ts — wave 2, category 6 (RED phase)
 *
 * Failing tests for the knowledge-lifecycle findings of the v1.2.0 field trace
 * (docs/field-trace-v1.2.0/lanes/lane-n-knowledge-memory.md, N-01..N-10).
 *
 * Each test asserts the invariant the system SHOULD hold, never the behaviour
 * observed in the run. Nothing here is fixed; these are the specification.
 *
 * Findings covered in this file (the Python-side ones live in
 * harness/tests/test_wave1_knowledge_lifecycle.py):
 *
 *   N-03a  evor_cite landed 0/18 calls: the citation-backed mandate is imposed
 *          on a role (sage-junior) that runs BEFORE any tree node exists, and
 *          cites its own angle slug. The tool can never be satisfied by its
 *          only caller.
 *   N-03b  16 of those failures returned {"ok":false,...} inside an
 *          is_error:false envelope, so no caller ever saw a failure or retried.
 *   N-02   A wiki entry with a fabricated performance claim, empirically
 *          refuted twice, still reads verdict:confirmed. There is no refuted /
 *          superseded marker at all.
 *   N-01/N-04  Three of twenty citations are misattributed. Nothing sits
 *          between a junior's self-asserted `urls_verified: true` and
 *          evor_wiki_add. Asserted with a STUB resolver — never the network.
 *   N-09   The wiki-resolution short-circuit is disabled by wildness >= 0.7,
 *          which every real contract set to 1.0, so wiki-resolved angles were
 *          re-researched at full scope.
 */

import { mkdtempSync, rmSync, readFileSync } from "fs";
import { join, dirname, resolve } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { addCitation, registerCiteTools } from "../src/tools/cite.js";
import { wikiAdd, wikiQuery, _resetWikiCache } from "../src/tools/wiki.js";
import { err } from "../src/tool-result.js";
import { LessonEntrySchema } from "../src/contracts.js";
import type { LessonEntry } from "../src/contracts.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// ── Lifecycle ───────────────────────────────────────────────────────────────

let tmpRoot: string;
let savedEvorRoot: string | undefined;
let savedMissionId: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "evor-wave1-knowledge-"));
  savedEvorRoot = process.env.EVOR_ROOT;
  savedMissionId = process.env.EVOR_MISSION_ID;
  process.env.EVOR_ROOT = tmpRoot;
  _resetWikiCache();
});

afterEach(() => {
  if (savedEvorRoot === undefined) delete process.env.EVOR_ROOT;
  else process.env.EVOR_ROOT = savedEvorRoot;
  if (savedMissionId === undefined) delete process.env.EVOR_MISSION_ID;
  else process.env.EVOR_MISSION_ID = savedMissionId;
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeEntry(overrides?: Partial<LessonEntry>): LessonEntry {
  return {
    lesson_id: "lightweight-iir-filters-sota",
    node_id: "iir-binnet-01",
    run_id: "run-live-01",
    mission_id: "mission-r1",
    approach_family: "arch",
    hypothesis_verdict: "confirmed",
    observation:
      "IIR filters give global receptive field at 49K parameters (IIR-BinNet, IEEE Access 2026).",
    actionable_lesson:
      "IIR filters enable global context with <50K parameters, GPU latency <10ms for 4k images.",
    citations: ["doi:10.1109/ACCESS.2026.3681411"],
    tags: ["iir", "latency"],
    created_at: "2026-08-23T09:12:00Z",
    ...overrides,
  } as LessonEntry;
}

/** Capture the handlers a register*Tools() call registers, without a live server. */
function captureTools(register: (server: never) => void): Record<
  string,
  (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>
> {
  const handlers: Record<string, never> = {};
  const fake = {
    tool: (name: string, _desc: unknown, _schema: unknown, handler: never) => {
      handlers[name] = handler;
    },
  };
  register(fake as unknown as never);
  return handlers as never;
}

function payload(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

// ── N-03a — the citation mandate must be satisfiable by the role it binds ────

describe("N-03a — evor_cite is satisfiable by the research role it is imposed on", () => {
  // Sage/Sage-junior run BEFORE any tree node exists (r3's tree had zero nodes
  // at that point) and cite their own ANGLE SLUG, not a node. All 18 real calls
  // came from that role, and all 18 failed. A mandate that its only caller can
  // never satisfy is not a mandate; it is dead code that looks enforced.
  it("accepts an angle slug when the run's tree is still empty", () => {
    const runId = "run-live-01";
    const angleSlug = "genuine-iir-mechanisms"; // a real slug from r3
    // No tree written: Sage runs before the first node is recorded.

    const result = addCitation(runId, angleSlug, "doi:10.1109/ACCESS.2026.3681411", "mission-r3");

    expect(
      result.ok,
      "a sage-junior citing its own angle slug before any node exists must succeed — " +
        "this is the exact shape of all 18 failed calls in the field run",
    ).toBe(true);
  });

  it("persists the pending citation so it is retrievable after the fact", () => {
    const runId = "run-live-01";
    const angleSlug = "palm-leaf-dataset-acquisition";

    addCitation(runId, angleSlug, "arXiv:2101.11674", "mission-r3");
    const second = addCitation(runId, angleSlug, "arXiv:2208.14558", "mission-r3");

    expect(second.ok).toBe(true);
    expect(
      second.citations,
      "citations recorded against a not-yet-existing node must accumulate, " +
        "not evaporate — otherwise the citation-backed mandate records nothing",
    ).toEqual(["arXiv:2101.11674", "arXiv:2208.14558"]);
  });
});

// ── N-03b — an embedded ok:false must be a protocol-level error ──────────────

describe("N-03b — an embedded ok:false must set isError on the MCP envelope", () => {
  // tool-result-envelope.test.ts already pins the PAYLOAD shape
  // ({ok:false, error}). It says nothing about the ENVELOPE, and the envelope
  // is what the agent runtime reads: 16 evor_cite failures arrived as
  // is_error:false, so the model saw a successful tool call and never retried.
  it("err() flags the result as an error, not just the JSON body", () => {
    const result = err("node 'genuine-iir-mechanisms' not found in this run's tree") as {
      isError?: boolean;
    };
    expect(
      result.isError,
      "err() is the single failure path for every evor_* tool; if it does not set " +
        "isError the whole fleet reports failures as successes",
    ).toBe(true);
  });

  it("evor_cite returns isError when its payload says ok:false", async () => {
    // EVOR_MISSION_ID is what the handler reads to resolve run paths; without it
    // resolveRunPaths throws and the test would fail on plumbing, not on the invariant.
    process.env.EVOR_MISSION_ID = "mission-r3";
    const handlers = captureTools(registerCiteTools as unknown as (s: never) => void);
    const cite = handlers["evor_cite"];
    expect(cite, "evor_cite must be registered — this test is stale otherwise").toBeTruthy();

    const result = await cite({
      run_id: "run-live-01",
      node_id: "definitely-not-a-node",
      citation: "arXiv:1807.06521",
    });
    const body = payload(result);

    // Whatever the tool decides about unknown refs, the two flags must agree.
    expect(
      Boolean(result.isError),
      `payload ok=${body.ok} but isError=${result.isError} — a failure the caller reads as success`,
    ).toBe(body.ok === false);
  });
});

// ── N-02 — refuted / superseded knowledge must be markable ──────────────────

describe("N-02 — a wiki entry can be revised when measurement contradicts it", () => {
  it("re-adding the same lesson_id with a corrected verdict replaces the entry", () => {
    const runId = "run-live-01";
    wikiAdd(runId, makeEntry(), "mission-r1");
    wikiAdd(
      runId,
      makeEntry({
        hypothesis_verdict: "refuted",
        actionable_lesson:
          "The <10ms@4k claim is NOT in the source paper; measured 81.4ms and 74.85ms.",
      }),
      "mission-r3",
    );

    const hits = wikiQuery("iir", { limit: 10 });
    expect(hits).toHaveLength(1);
    expect(
      hits[0].hypothesis_verdict,
      "an entry refuted by measurement must not still read 'confirmed'",
    ).toBe("refuted");
  });

  it("the lesson contract can record that an entry was superseded and by what", () => {
    // The r1 entry was falsified TWICE (81.4ms, 74.85ms) and never retracted.
    // Overwriting in place is not enough: the refutation needs a pointer to the
    // evidence, or the next reader cannot tell a stale claim from a live one.
    const fields = Object.keys(LessonEntrySchema.shape);
    expect(
      fields.some((f) => /superseded|refuted_by|retracted/.test(f)),
      `LessonEntry has no supersede marker (fields: ${fields.join(", ")}) — ` +
        "a claim refuted by measurement can only be silently overwritten or left standing",
    ).toBe(true);
  });

  it("a superseded entry is not returned as a confirmed lesson", () => {
    const runId = "run-live-01";
    const superseded = {
      ...makeEntry(),
      superseded_by: "iir-scan-binnet-02-tick1",
    } as unknown as LessonEntry;

    wikiAdd(runId, superseded, "mission-r1");
    const confirmed = wikiQuery("iir", { confirmedOnly: true, limit: 10 });

    expect(
      confirmed,
      "confirmed_only must not surface an entry that has been superseded — " +
        "this entry was cited 23 times across the tree after being falsified",
    ).toEqual([]);
  });
});

// ── N-01 / N-04 — a self-asserted urls_verified is not verification ─────────

describe("N-01/N-04 — citations are resolved before they are persisted", () => {
  // CBAM was credited to arXiv 2006.05595 ("Fitted Q-Learning for Relational
  // Domains") and a topology loss to an infrared diffusion paper. The junior
  // set urls_verified:true itself and nothing checked it. These tests use a
  // STUB resolver: no network, so no flakiness.
  it("wikiAdd runs every citation through an injected resolver", () => {
    const runId = "run-live-01";
    const resolveCitation = vi.fn(() => ({ resolved: true, title: "CBAM: Convolutional Block Attention Module" }));

    const add = wikiAdd as unknown as (
      runId: string,
      entry: LessonEntry,
      missionId?: string,
      opts?: { resolveCitation: (id: string) => unknown },
    ) => unknown;

    add(runId, makeEntry({ citations: ["arXiv:2006.05595"] }), "mission-r1", { resolveCitation });

    expect(
      resolveCitation.mock.calls.length,
      "wikiAdd persisted a citation without ever resolving it — the only check on " +
        "citation identity is the junior's own urls_verified flag",
    ).toBeGreaterThan(0);
  });

  it("an entry whose citation resolves to an unrelated paper is not stored as verified", () => {
    const runId = "run-live-01";
    // Stub: the identifier resolves, but to a paper that does not support the claim.
    const resolveCitation = () => ({
      resolved: true,
      title: "Fitted Q-Learning for Relational Domains",
      supports_claim: false,
    });

    const add = wikiAdd as unknown as (
      runId: string,
      entry: LessonEntry,
      missionId?: string,
      opts?: { resolveCitation: () => unknown },
    ) => { citation_status?: unknown };

    const result = add(
      runId,
      makeEntry({
        lesson_id: "cbam-attention-palm-leaf-focus",
        citations: ["arXiv:2006.05595"],
        actionable_lesson: "Insert CBAM blocks, channel ratio=16, spatial kernel=7.",
      }),
      "mission-r1",
      { resolveCitation },
    );

    expect(
      result.citation_status,
      "wikiAdd must report per-citation resolution status; a misattributed citation " +
        "that writes silently is indistinguishable from a verified one",
    ).toBeDefined();
  });
});

// ── N-09 — the wiki-resolution short-circuit must survive high wildness ─────

describe("N-09 — wiki-resolved angles are never re-researched, at any wildness", () => {
  // r3's handoff: gate=full_scope, reason "wildness=1.0 (>=0.7 threshold) forces
  // full-scope Sage REGARDLESS of wiki resolution". All three contracts set
  // wildness=1.0, so 4 of 8 sage queries re-researched topics already in the wiki.
  const skill = readFileSync(join(REPO, "skills", "evor", "SKILL.md"), "utf8");

  function gateBlock(): string {
    const start = skill.indexOf("P1-8");
    expect(start, "P1-8 gate not found in skills/evor/SKILL.md — this test is stale").toBeGreaterThan(-1);
    const end = skill.indexOf("POST-CONDITION", start);
    return skill.slice(start, end === -1 ? start + 6000 : end);
  }

  it("the full-scope branch still excludes angles the wiki already resolved", () => {
    const block = gateBlock();
    // Today the exclusion instruction is scoped to "When spawning Sage (narrowed
    // scope)". Full scope carries every angle, resolved or not.
    const fullScopeSection = block.slice(block.indexOf("Spawn Sage at FULL scope"));
    expect(
      fullScopeSection,
      "at FULL scope the gate passes wiki-resolved angles back to Sage; wildness must " +
        "widen the scope, not re-open questions the wiki already answered",
    ).toMatch(/wiki-resolved angles[^.]*(excluded|already handled|skip)/i);
  });

});
