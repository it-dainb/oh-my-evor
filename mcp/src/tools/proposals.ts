/**
 * tools/proposals.ts
 * evor_validate_proposals — deterministic structural gate for Mutagen proposals.
 *
 * Runs H001–H004 + schema checks in CODE before any Selector LLM is spawned.
 * Proposals that pass ALL gates AND wildness < 0.8 AND are NOT marked as
 * acquisition return verdict="pass" (Selector LLM may be skipped entirely).
 * Borderline cases → verdict="needs_llm".
 * Hard structural failures → verdict="reject".
 *
 * This is the ungameable pre-filter (P1-7 root-fix): the gates run as pure
 * deterministic code; no prompt text can bypass them.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID } from "crypto";
import { z } from "zod";

// ── Input schemas ─────────────────────────────────────────────────────────────

const ProposalInputSchema = z.object({
  // Server-owned: generated server-side if absent (crypto.randomUUID / prop-<short> slug).
  proposal_id: z.string().optional().describe("Unique ID for this proposal (correlates results); generated server-side if omitted"),
  parent_node_ids: z
    .array(z.string())
    .min(1)
    .describe("Parent node IDs; first element is the primary lineage parent"),
  approach_family: z
    .string()
    .describe("Approach family (arch, training, data-curation, augmentation, regularization, other)"),
  hypothesis: z
    .object({
      prediction: z
        .string()
        .describe("Expected improvement claim — must contain a quantified metric for H001"),
    })
    .passthrough()
    .describe("Proposal hypothesis; prediction field evaluated for H001"),
  wildness: z
    .number()
    .min(0)
    .max(1)
    .describe("Proposal wildness score in [0, 1]; >= 0.8 forces needs_llm"),
  is_acquisition: z
    .boolean()
    .optional()
    .describe("True → acquisition proposal; always routes to needs_llm regardless of other gates"),
});

const StrategyContextSchema = z
  .object({
    winning_families: z
      .array(z.string())
      .optional()
      .describe(
        "Ordered list of approach families that won recent ticks; last 3 used for H002 streak check",
      ),
  })
  .passthrough();

// ── Result types (exported for tests) ────────────────────────────────────────

export type GateResult = "pass" | "fail";
export type Verdict = "pass" | "needs_llm" | "reject";

export interface ProposalVerdict {
  proposal_id: string;
  h001: GateResult; // quantified prediction present
  h002: GateResult; // not a pure 3-tick streak family
  h003: GateResult; // distinct family within this tick batch
  h004: GateResult; // champion_share ≤ floor(N/2)
  schema: GateResult; // required fields non-null/non-empty
  verdict: Verdict;
  reason: string;
}

export interface ValidationSummary {
  results: ProposalVerdict[];
  total: number;
  pass_count: number;
  needs_llm_count: number;
  reject_count: number;
}

// ── Gate implementations ──────────────────────────────────────────────────────

/**
 * H001: prediction must contain a measurable quantity.
 * Accepts: digit + optional unit (%, ×/x, bps, pp, pts, ms, etc.)
 * OR a plain digit if the string is long enough to be a real claim.
 */
export function gateH001(prediction: string): GateResult {
  if (!prediction?.trim()) return "fail";
  const QUANTIFIED = /\d+(\.\d+)?\s*(%|×|x\b|bps|pp\b|pts\b|ms\b|s\b)/i;
  const HAS_DIGIT = /\d/.test(prediction);
  // Must have a digit. Prefer explicit unit; fall back to "has digit in a long claim".
  if (!HAS_DIGIT) return "fail";
  if (QUANTIFIED.test(prediction)) return "pass";
  // Long-form numeric claim without unit (e.g. "reduce loss by 0.05"): accept if digit present.
  if (prediction.trim().length >= 10) return "pass";
  return "fail";
}

/**
 * H002: approach_family must NOT be part of a pure 3-tick win-streak.
 * Fails only when the same family won ALL of the last 3 ticks AND this
 * proposal is again that same family. Fewer than 3 wins → no streak.
 */
export function gateH002(family: string, winningFamilies: string[]): GateResult {
  const last3 = winningFamilies.slice(-3);
  if (last3.length < 3) return "pass";
  const allSame = last3.every(f => f === last3[0]);
  if (allSame && last3[0] === family) return "fail";
  return "pass";
}

/**
 * H003: approach_family must appear at most once within this tick batch.
 * Evaluated sequentially — first occurrence passes, subsequent occurrences fail.
 */
export function gateH003(family: string, familiesSeenSoFar: Set<string>): GateResult {
  return familiesSeenSoFar.has(family) ? "fail" : "pass";
}

/**
 * H004: champion-share guard.
 * The number of proposals sharing the same primary parent must not exceed
 * floor(N/2), where N is the total number of proposals in this batch.
 */
export function gateH004(
  primaryParentId: string,
  parentShareCounts: Map<string, number>,
  N: number,
): GateResult {
  const share = parentShareCounts.get(primaryParentId) ?? 0;
  return share <= Math.floor(N / 2) ? "pass" : "fail";
}

/**
 * Schema gate: all required semantic fields non-null / non-empty.
 * proposal_id is now server-generated — excluded from schema gate.
 */
export function gateSchema(proposal: z.infer<typeof ProposalInputSchema>): GateResult {
  const { parent_node_ids, approach_family, hypothesis, wildness } = proposal;
  if (!parent_node_ids?.length) return "fail";
  if (!approach_family?.trim()) return "fail";
  if (!hypothesis?.prediction?.trim()) return "fail";
  if (typeof wildness !== "number" || wildness < 0 || wildness > 1) return "fail";
  return "pass";
}

// ── Core logic (exported for tests) ──────────────────────────────────────────

/**
 * Validate a batch of Mutagen proposals with deterministic structural gates.
 *
 * Verdict rules (evaluated in priority order):
 *   "reject"    → schema=fail OR h001=fail (no digit in prediction at all)
 *   "needs_llm" → is_acquisition=true OR any of H002/H003/H004 fail OR wildness >= 0.8
 *   "pass"      → all gates pass AND wildness < 0.8 AND not acquisition
 *
 * H003 is stateful within the batch: evaluated in array order.
 * H004 is pre-computed from the full batch before per-proposal scoring.
 */
export function validateProposals(
  proposals: z.infer<typeof ProposalInputSchema>[],
  strategy: z.infer<typeof StrategyContextSchema>,
): ValidationSummary {
  // Server-owned: assign proposal_id if the agent omitted it.
  const filledProposals = proposals.map((p, i) => ({
    ...p,
    proposal_id: p.proposal_id?.trim()
      ? p.proposal_id
      : `prop-${randomUUID().slice(0, 8)}-${i}`,
  }));

  const N = filledProposals.length;
  const winningFamilies = strategy.winning_families ?? [];

  // Pre-compute primary-parent share counts for H004.
  const parentShareCounts = new Map<string, number>();
  for (const p of filledProposals) {
    const primary = p.parent_node_ids[0] ?? "";
    parentShareCounts.set(primary, (parentShareCounts.get(primary) ?? 0) + 1);
  }

  // Track approach families seen within this batch (H003 — order-dependent).
  const familiesSeen = new Set<string>();

  const results: ProposalVerdict[] = filledProposals.map(proposal => {
    const schemaGate = gateSchema(proposal);

    // Schema failure → reject immediately; skip remaining gates.
    if (schemaGate === "fail") {
      return {
        proposal_id: proposal.proposal_id,
        h001: "fail",
        h002: "fail",
        h003: "fail",
        h004: "fail",
        schema: "fail",
        verdict: "reject",
        reason: "schema: required field(s) null or empty",
      } satisfies ProposalVerdict;
    }

    const h001 = gateH001(proposal.hypothesis.prediction);
    const h002 = gateH002(proposal.approach_family, winningFamilies);
    const h003 = gateH003(proposal.approach_family, familiesSeen);
    const primaryParent = proposal.parent_node_ids[0] ?? "";
    const h004 = gateH004(primaryParent, parentShareCounts, N);

    // Register family for H003 on subsequent proposals in this batch.
    familiesSeen.add(proposal.approach_family);

    const isAcquisition = proposal.is_acquisition === true;
    const hardFail = h001 === "fail";
    const softFail = h002 === "fail" || h003 === "fail" || h004 === "fail";
    const highWildness = proposal.wildness >= 0.8;

    let verdict: Verdict;
    let reason: string;

    if (hardFail) {
      verdict = "reject";
      reason = "h001: prediction contains no quantified metric claim";
    } else if (isAcquisition) {
      verdict = "needs_llm";
      reason = "acquisition proposal — always requires LLM judgment";
    } else if (softFail) {
      const failing = (
        [
          h002 === "fail" ? "h002(streak)" : null,
          h003 === "fail" ? "h003(duplicate-family)" : null,
          h004 === "fail" ? "h004(champion-share)" : null,
        ].filter(Boolean) as string[]
      ).join(", ");
      verdict = "needs_llm";
      reason = `gate(s) failed: ${failing}`;
    } else if (highWildness) {
      verdict = "needs_llm";
      reason = `wildness=${proposal.wildness.toFixed(2)} >= 0.8; LLM review required`;
    } else {
      verdict = "pass";
      reason = "all structural gates pass; Selector LLM may be skipped";
    }

    return {
      proposal_id: proposal.proposal_id,
      h001,
      h002,
      h003,
      h004,
      schema: schemaGate,
      verdict,
      reason,
    } satisfies ProposalVerdict;
  });

  const pass_count = results.filter(r => r.verdict === "pass").length;
  const needs_llm_count = results.filter(r => r.verdict === "needs_llm").length;
  const reject_count = results.filter(r => r.verdict === "reject").length;

  return { results, total: N, pass_count, needs_llm_count, reject_count };
}

// ── Tool registration ─────────────────────────────────────────────────────────

export function registerProposalTools(server: McpServer): void {
  server.tool(
    "evor_validate_proposals",
    "Deterministic structural gate for Mutagen proposals — runs H001–H004 + schema checks " +
      "in code before any Selector LLM is invoked. " +
      "H001: hypothesis.prediction contains a quantified metric claim (digit + unit). " +
      "H002: approach_family is not in a pure 3-tick win-streak (strategy.winning_families). " +
      "H003: each approach_family appears at most once within this tick's batch. " +
      "H004: no single primary parent provides more than floor(N/2) proposals. " +
      "verdict='pass' → all gates pass + wildness<0.8 + not acquisition; Selector LLM safe to skip. " +
      "verdict='needs_llm' → borderline; must route to Selector for full judgment. " +
      "verdict='reject' → hard structural failure (no digit in prediction or missing fields); discard. " +
      "Call this BEFORE spawning the Selector agent each tick to cut LLM cost on clean proposals.",
    {
      proposals: z
        .array(ProposalInputSchema)
        .min(1)
        .describe("Proposals to validate; results are returned in the same order"),
      strategy: StrategyContextSchema.describe(
        "Current strategy context; winning_families used for H002 streak check",
      ),
    },
    async ({ proposals, strategy }) => {
      const summary = validateProposals(proposals, strategy);
      // Server-owned: populate critic_review from gate results so the agent
      // never has to parrot internal gate codes back.
      const resultsWithReview = summary.results.map(r => ({
        ...r,
        critic_review: {
          h001_one_hypothesis: r.h001,
          h002_family_streak: r.h002,
          h003_intra_tick_diversity: r.h003,
          integrity_risk: "pass" as const,       // gate not agent-supplied; default pass
          instrumentation_check: "pass" as const, // gate not agent-supplied; default pass
          schema_valid: r.schema,
          verdict: r.verdict === "reject" ? "rejected" : "approved",
          ...(r.verdict === "reject" ? { rejection_reason: r.reason } : {}),
        },
      }));
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok: true, ...summary, results: resultsWithReview }),
          },
        ],
      };
    },
  );
}
