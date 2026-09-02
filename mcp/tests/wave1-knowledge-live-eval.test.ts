/**
 * mcp/tests/wave1-knowledge-live-eval.test.ts — LIVE, MCP-ATTACHED red tests
 * for the knowledge-lifecycle findings. Companion to the unit-level
 * wave1-knowledge-lifecycle.test.ts, which does not replace it.
 *
 * THE DISTINCTION THAT MATTERS. The unit test proves `addCitation()` returns
 * ok:false for an unknown ref. That is the error path, not the defect. The
 * defect is that a REAL evor-sage-junior, following its REAL prompt with the
 * REAL server attached, calls `evor_cite` in the only state its role ever runs
 * in — angle slug, empty tree — and is told the call succeeded. Only an
 * MCP-attached live run shows that.
 *
 * GATING. Everything below is behind EVOR_LIVE_EVAL=1. That gate is not a
 * `.skip` of a deterministic failure: gate off, these do not run at all; gate
 * on, they must fail loudly. `runLive()` throws on a CLI error, an empty stream,
 * or a missing result event — an unreachable model is an error, never a pass.
 *
 * SECRETS. Only the evor MCP server is attached (--strict-mcp-config). No
 * research MCP, no network, no credential is read, printed or written anywhere
 * in this file or its fixtures (R-01 is an open blocker).
 *
 * RUN:
 *   npm --prefix mcp run build
 *   EVOR_LIVE_EVAL=1 npx vitest run tests/wave1-knowledge-live-eval.test.ts
 */

import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import {
  seedEvorRoot,
  staleLatencyGotcha,
  writeMcpConfig,
  agentPromptBlock,
  buildCiteTask,
  buildSelectorTask,
  runLive,
  extractToolCalls,
  tallyCiteOutcomes,
  rejectedForKmac,
  parseFinalJson,
} from "../../ci/knowledge-live-eval.mjs";

const LIVE = process.env.EVOR_LIVE_EVAL === "1";
const describeLive = describe.runIf(LIVE);

// Declared tiers, from the agents' own frontmatter. A live run on the wrong
// model measures a different system than the one that failed in the field.
const SAGE_JUNIOR = { model: "sonnet", effort: "medium", maxTurns: 16 };
const SELECTOR = { model: "haiku", effort: "medium", maxTurns: 12 };

const EVOR_TOOLS = [
  "mcp__evor__evor_cite",
  "mcp__evor__evor_wiki_query",
  "mcp__evor__evor_wiki_add",
  "mcp__evor__evor_gotcha_query",
  "mcp__evor__evor_write_artifact",
  "mcp__evor__evor_tree_read",
  "mcp__evor__evor_state_read",
];

// ── Pure-function coverage: runs with the gate OFF, so the analysis the live
//    assertions depend on is itself proven. A stream parser that silently
//    returns [] would turn every live red into a false green.
describe("live-eval stream analysis (no network)", () => {
  const events = [
    {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "t1", name: "mcp__evor__evor_cite", input: { node_id: "angle-a" } },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            is_error: false,
            content: [{ type: "text", text: '{"run_id":"r","ok":false,"error":"node not found"}' }],
          },
        ],
      },
    },
  ];

  it("pairs a tool_use with its tool_result and reads both flags", () => {
    const calls = extractToolCalls(events, "evor_cite");
    expect(calls).toHaveLength(1);
    expect(calls[0].ok).toBe(false);
    expect(calls[0].is_error).toBe(false);
  });

  it("counts the exact field signature: attempted, landed, silently failed", () => {
    const t = tallyCiteOutcomes(extractToolCalls(events, "evor_cite"));
    expect(t).toEqual({ attempted: 1, landed: 0, silentFailures: 1 });
  });

  it("recognises a kMAC/px rejection ground", () => {
    expect(
      rejectedForKmac({ verdict: "rejected", rejection_reason: "no kMAC/px cost estimate given" }),
    ).toBe(true);
    expect(rejectedForKmac({ verdict: "approved", rejection_reason: null })).toBe(false);
  });

  it("parses a fenced final JSON block", () => {
    expect(parseFinalJson('text\n```json\n{"cite_calls_made": 2}\n```')).toEqual({
      cite_calls_made: 2,
    });
  });
});

// ── N-03 live — evor-sage-junior, empty tree, angle slug, server attached ────

describeLive("N-03 LIVE — a real sage-junior's citations must land", () => {
  let root: string;
  let run: ReturnType<typeof seedEvorRoot>;
  let calls: ReturnType<typeof extractToolCalls>;
  let live: ReturnType<typeof runLive>;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "evor-live-cite-"));
    run = seedEvorRoot(root);
    const cfg = writeMcpConfig(join(root, "mcp.json"), {
      EVOR_ROOT: run.evorRoot,
      EVOR_MISSION_ID: run.missionId,
      EVOR_ACTIVE_RUN_ID: run.runId,
    });

    live = runLive({
      prompt: [
        agentPromptBlock("agents/evor-sage-junior.md"),
        buildCiteTask({ runId: run.runId, angleSlug: "genuine-iir-mechanisms" }),
      ].join("\n\n"),
      model: SAGE_JUNIOR.model,
      effort: SAGE_JUNIOR.effort,
      maxTurns: SAGE_JUNIOR.maxTurns,
      timeoutMs: 600000,
      mcpConfigPath: cfg,
      allowedTools: EVOR_TOOLS,
      env: {
        EVOR_ROOT: run.evorRoot,
        EVOR_MISSION_ID: run.missionId,
        EVOR_ACTIVE_RUN_ID: run.runId,
      },
    });
    calls = extractToolCalls(live.events, "evor_cite");
    // Provenance for the report. No credential is in scope here.
    console.log(
      `[live] sage-junior model=${live.model} turns=${live.num_turns} ` +
        `cost=$${live.cost_usd.toFixed(4)} wall=${(live.wall_ms / 1000).toFixed(1)}s ` +
        `cite_calls=${calls.length}`,
    );
  }, 660000);

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("ran on its declared tier", () => {
    // A live eval that silently ran a different model measures nothing.
    expect(live.model, `expected a ${SAGE_JUNIOR.model} model, got ${live.model}`).toMatch(
      /sonnet/,
    );
  });

  it("the role actually reached for evor_cite", () => {
    // Not an assertion about the defect — an assertion that the scenario was
    // exercised at all. Zero attempts means an inconclusive run, and an
    // inconclusive live run must fail, not quietly pass.
    expect(
      calls.length,
      "the agent never called evor_cite, so this run proves nothing about whether " +
        "citations land — check the allowedTools list and the MCP attachment",
    ).toBeGreaterThan(0);
  });

  it("N-03a — every attempted citation lands (field ratio was 0 of 18)", () => {
    const t = tallyCiteOutcomes(calls);
    expect(
      t.landed,
      `${t.landed} of ${t.attempted} citations landed. Errors: ` +
        JSON.stringify(calls.map((c) => c.error).filter(Boolean)),
    ).toBe(t.attempted);
  });

  it("N-03b — no failure is delivered inside a success envelope", () => {
    const t = tallyCiteOutcomes(calls);
    expect(
      t.silentFailures,
      `${t.silentFailures} call(s) returned ok:false with is_error:false — the agent was ` +
        "told a failure had succeeded, which is why none of the 18 field calls was retried",
    ).toBe(0);
  });

  it("N-01/N-04 — a citation persisted by the run carries a verification record", () => {
    // Stub-free and network-free: the assertion is that SOMETHING recorded who
    // checked the identifier. Today nothing does, so the only signal is the
    // junior's self-asserted urls_verified.
    const indexPath = join(run.wikiDir, "index.jsonl");
    const rows = existsSync(indexPath)
      ? readFileSync(indexPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
    const persisted = [...rows, ...calls.map((c) => c.input)];
    expect(
      persisted.length,
      "the run persisted no citation at all, so verification cannot be assessed",
    ).toBeGreaterThan(0);
    expect(
      persisted.some((r: Record<string, unknown>) =>
        Object.keys(r).some((k) => /verif|resolved/i.test(k)),
      ),
      "no citation record carries any resolution/verification field — nothing sat between " +
        "the junior's finding and the store, which is how CBAM was credited to an RL paper",
    ).toBe(true);
  });
});

// ── N-06 live — a stale gotcha must not be served as still-valid ─────────────

describeLive("N-06 LIVE — a superseded gotcha must not drive a rejection", () => {
  let root: string;
  let live: ReturnType<typeof runLive>;
  let reviews: Array<{ proposal_id: string; verdict: string; rejection_reason: string | null }>;
  let gotchaCalls: ReturnType<typeof extractToolCalls>;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "evor-live-gotcha-"));
    const run = seedEvorRoot(root, { gotchas: [staleLatencyGotcha()] });
    const cfg = writeMcpConfig(join(root, "mcp.json"), {
      EVOR_ROOT: run.evorRoot,
      EVOR_MISSION_ID: run.missionId,
      EVOR_ACTIVE_RUN_ID: run.runId,
    });

    live = runLive({
      prompt: [agentPromptBlock("agents/evor-selector.md"), buildSelectorTask()].join("\n\n"),
      model: SELECTOR.model,
      effort: SELECTOR.effort,
      maxTurns: SELECTOR.maxTurns,
      timeoutMs: 600000,
      mcpConfigPath: cfg,
      allowedTools: EVOR_TOOLS,
      env: {
        EVOR_ROOT: run.evorRoot,
        EVOR_MISSION_ID: run.missionId,
        EVOR_ACTIVE_RUN_ID: run.runId,
      },
    });
    gotchaCalls = extractToolCalls(live.events, "evor_gotcha_query");
    reviews = (parseFinalJson(String(live.result.result ?? ""), "reviews")?.reviews ??
      []) as typeof reviews;
    console.log(
      `[live] selector model=${live.model} turns=${live.num_turns} ` +
        `cost=$${live.cost_usd.toFixed(4)} wall=${(live.wall_ms / 1000).toFixed(1)}s ` +
        `gotcha_queries=${gotchaCalls.length} reviews=${reviews.length}`,
    );
  }, 660000);

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("ran on its declared tier", () => {
    expect(live.model, `expected a ${SELECTOR.model} model, got ${live.model}`).toMatch(/haiku/);
  });

  it("the store served the stale gotcha with a staleness marker", () => {
    expect(
      gotchaCalls.length,
      "the selector never queried the gotcha store, so this run proves nothing",
    ).toBeGreaterThan(0);
    const served = gotchaCalls.map((c) => c.text).join("\n");
    expect(
      served.includes("cpu-4k-latency-gate-requires-lt-3kmac-per-pixel"),
      "the seeded gotcha was not returned at all — check the store seeding",
    ).toBe(true);
    expect(
      /superseded|invalidated|stale|contract_changed/i.test(served),
      "the store served a confidence-1.0 gotcha encoding a retired contract gate with " +
        "nothing marking it stale — this is the payload five r3 agents received verbatim",
    ).toBe(true);
  });

  it("neither proposal is rejected for lacking a kMAC/px estimate", () => {
    expect(
      reviews.length,
      `the selector emitted no parseable reviews: ${String(live.result.result ?? "").slice(0, 300)}`,
    ).toBeGreaterThan(0);
    const bad = reviews.filter(rejectedForKmac).map((r) => `${r.proposal_id}: ${r.rejection_reason}`);
    expect(
      bad,
      "a proposal aimed at the actual bottleneck was rejected on a budget the contract in " +
        "force had already relaxed 10x — the exact r3 selection error",
    ).toEqual([]);
  });
});
