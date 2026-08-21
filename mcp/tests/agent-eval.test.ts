/**
 * mcp/tests/agent-eval.test.ts — ci/agent-eval.mjs, the per-agent MODEL-TIER
 * eval harness (see evals/selector/cases.json and agents/evor-selector.md).
 *
 * All of this runs WITHOUT calling the API — the harness's live-run path
 * (runMatrix / runOneCall in ci/agent-eval.mjs) is exercised only by
 * `node ci/agent-eval.mjs` with no args, which this suite never invokes.
 * Pure functions are imported directly (mirrors mcp/tests/session-analyze.test.ts's
 * subprocess pattern, but these functions have no top-level side effects so a
 * direct ESM import is safe and avoids spawning a process per assertion).
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import { spawnSync } from "child_process";

import {
  computeCostFromModelUsage,
  costReconciliation,
  checkTierMatch,
  parseVerdictText,
  scoreCase,
  primaryGateForCase,
  extractAgentPromptBlock,
  buildCasePrompt,
  parseTiers,
  buildReport,
  renderTable,
  SHORT_TO_GATE_KEY,
  effortIsInert,
  canonicalTierLabel,
} from "../../ci/agent-eval.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CASES = JSON.parse(
  readFileSync(resolve(REPO_ROOT, "evals/selector/cases.json"), "utf8"),
);
const caseById = (id: string) => CASES.cases.find((c: any) => c.id === id);

/** Build a passing critic_review — every gate "pass", verdict "approved". */
function passReview(proposal_id: string, approach_family = "algo") {
  return {
    proposal_id,
    approach_family,
    critic_review: {
      h001_one_hypothesis: "pass",
      h002_family_streak: "pass",
      h003_intra_tick_diversity: "pass",
      h004_parent_diversity: "pass",
      integrity_risk: "pass",
      instrumentation_check: "pass",
      schema_valid: "pass",
      acquisition_contamination: null,
      gotcha_avoidance: null,
      verdict: "approved",
      rejection_reason: null,
    },
    selected: false,
    selection_note: null,
  };
}

/** Same as passReview but with one named gate flipped to fail/rejected. */
function failReview(proposal_id: string, gateShort: string, approach_family = "algo") {
  const r = passReview(proposal_id, approach_family);
  const key = (SHORT_TO_GATE_KEY as Record<string, string>)[gateShort];
  (r.critic_review as any)[key] = "fail";
  r.critic_review.verdict = "rejected";
  r.critic_review.rejection_reason = `${gateShort} fail: fixture`;
  return r;
}

describe("agent-eval — cost mirrors scripts/session-analyze.mjs", () => {
  const SCRIPT = resolve(REPO_ROOT, "scripts/session-analyze.mjs");

  function sessionAnalyzeCost(model: string, usage: Record<string, number>) {
    const dir = mkdtempSync(join(tmpdir(), "agent-eval-cost-"));
    try {
      const file = join(dir, "session.jsonl");
      const line = {
        type: "assistant",
        timestamp: "2026-07-26T12:00:00.000Z",
        isSidechain: false,
        message: { id: "msg_1", model, role: "assistant", content: [{ type: "text", text: "x" }], usage },
      };
      writeFileSync(file, JSON.stringify(line) + "\n");
      const r = spawnSync(process.execPath, [SCRIPT, file], { encoding: "utf8", timeout: 60_000 });
      if (r.status !== 0) throw new Error(`session-analyze failed: ${r.stderr}`);
      return JSON.parse(r.stdout).cost.by_model[model];
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("matches session-analyze.mjs for a haiku input/output/cache mix", () => {
    const usage = {
      input_tokens: 12_345,
      output_tokens: 6_789,
      cache_read_input_tokens: 500_000,
      cache_creation_input_tokens: 20_000,
    };
    const expected = sessionAnalyzeCost("claude-haiku-4-5", usage);
    const actual = computeCostFromModelUsage({
      "claude-haiku-4-5": {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadInputTokens: usage.cache_read_input_tokens,
        cacheCreationInputTokens: usage.cache_creation_input_tokens,
      },
    }).by_model["claude-haiku-4-5"];
    expect(actual).toBeCloseTo(expected, 8);
  });

  it("matches session-analyze.mjs for a sonnet cache-read-heavy mix", () => {
    const usage = {
      input_tokens: 0,
      output_tokens: 1_000,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 0,
    };
    const expected = sessionAnalyzeCost("claude-sonnet-5", usage);
    const actual = computeCostFromModelUsage({
      "claude-sonnet-5": {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadInputTokens: usage.cache_read_input_tokens,
        cacheCreationInputTokens: usage.cache_creation_input_tokens,
      },
    }).by_model["claude-sonnet-5"];
    expect(actual).toBeCloseTo(expected, 8);
  });

  // Every cost test above proves the table agrees with session-analyze.mjs —
  // i.e. that our model agrees with our other copy of the same model. Neither
  // is checked against what Anthropic actually billed. On the one artifact
  // where both numbers exist (ci/out/bench-tick-report.json, 2026-08-21) the
  // modelled total was $9.6956 and the CLI's own total_cost_usd was $15.6950:
  // the table understated the bill by 38%. So record the CLI figure alongside
  // the modelled one and let the run say so.
  it("reconciles the modelled cost against the CLI's own total_cost_usd", () => {
    const envelope = {
      total_cost_usd: 15.6950246,
      modelUsage: { "claude-sonnet-5": { inputTokens: 1_000_000, outputTokens: 0 } },
    };
    const r = costReconciliation(envelope);
    expect(r.modeled_usd).toBeCloseTo(2.0, 6);
    expect(r.billed_usd).toBeCloseTo(15.6950246, 6);
    expect(r.ratio).toBeCloseTo(15.6950246 / 2.0, 6);
  });

  it("reports a null billed cost rather than inventing one", () => {
    const r = costReconciliation({ modelUsage: { "claude-sonnet-5": { inputTokens: 1_000_000 } } });
    expect(r.billed_usd).toBeNull();
    expect(r.ratio).toBeNull();
    expect(r.modeled_usd).toBeCloseTo(2.0, 6);
  });

  it("reports unpriced models rather than silently costing them $0", () => {
    const out = computeCostFromModelUsage({ "claude-mystery-9": { inputTokens: 100, outputTokens: 100 } });
    expect(out.by_model["claude-mystery-9"]).toBeNull();
    expect(out.unpriced_models).toBe(1);
    expect(out.total).toBe(0);
  });
});

describe("agent-eval — tier-mismatch guard fails loudly", () => {
  it("passes when the requested alias's model appears in modelUsage", () => {
    const r = checkTierMatch("haiku", { "claude-haiku-4-5": {} });
    expect(r.ok).toBe(true);
    expect(r.model).toBe("claude-haiku-4-5");
  });

  it("fails when a different model was actually used (haiku requested, sonnet reported)", () => {
    const r = checkTierMatch("haiku", { "claude-sonnet-5": {} });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/tier mismatch/);
    expect(r.error).toMatch(/haiku/);
  });

  it("fails when modelUsage is empty", () => {
    const r = checkTierMatch("sonnet", {});
    expect(r.ok).toBe(false);
  });

  it("matches a dated model id via prefix (claude-sonnet-5-20260815)", () => {
    const r = checkTierMatch("sonnet", { "claude-sonnet-5-20260815": {} });
    expect(r.ok).toBe(true);
  });
});

describe("agent-eval — verdict parsing tolerates prose and fences", () => {
  const obj = { reviews: [{ proposal_id: "p1" }], winner: "p1" };

  it("parses a raw JSON object", () => {
    expect(parseVerdictText(JSON.stringify(obj))).toEqual(obj);
  });

  it("parses JSON wrapped in a ```json fence with surrounding prose", () => {
    const text = `Here is the verdict:\n\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\`\n\nDone.`;
    expect(parseVerdictText(text)).toEqual(obj);
  });

  it("finds the outermost JSON object embedded in prose with no fence", () => {
    const text = `Sure, here you go: ${JSON.stringify(obj)} — let me know if you need more.`;
    expect(parseVerdictText(text)).toEqual(obj);
  });

  it("returns null for garbage", () => {
    expect(parseVerdictText("not json at all, sorry")).toBeNull();
    expect(parseVerdictText("")).toBeNull();
    expect(parseVerdictText(undefined as unknown as string)).toBeNull();
  });
});

describe("agent-eval — scoring: a garbage response is unparseable, never wrong", () => {
  it("scores unparseable when reviews is missing", () => {
    const out = scoreCase(caseById("clean-2"), { winner: "p1" });
    expect(out.status).toBe("unparseable");
  });

  it("scores unparseable when reviews is not an array", () => {
    const out = scoreCase(caseById("clean-2"), { reviews: "nope" });
    expect(out.status).toBe("unparseable");
  });

  it("scores unparseable for a totally garbage parse (null)", () => {
    const out = scoreCase(caseById("clean-2"), null);
    expect(out.status).toBe("unparseable");
  });
});

describe("agent-eval — scoring: per-proposal cases", () => {
  it("scores correct when the fixture matches `expect` exactly (clean-2)", () => {
    const c = caseById("clean-2");
    const parsed = { reviews: [passReview("p1"), passReview("p2", "data-curation")], winner: "p1" };
    const out = scoreCase(c, parsed);
    expect(out.status).toBe("correct");
  });

  it("scores incorrect when a proposal that should be rejected is approved (h001-no-digit)", () => {
    const c = caseById("h001-no-digit");
    const parsed = { reviews: [passReview("p1"), passReview("p2", "training")], winner: "p1" };
    const out = scoreCase(c, parsed);
    expect(out.status).toBe("incorrect");
    const p2 = out.per_proposal!.find((p: any) => p.proposal_id === "p2");
    expect(p2.correct).toBe(false);
  });

  it("scores correct when the fixture rejects on the right named gate (h001-no-digit)", () => {
    const c = caseById("h001-no-digit");
    const parsed = { reviews: [passReview("p1"), failReview("p2", "h001", "training")], winner: "p1" };
    const out = scoreCase(c, parsed);
    expect(out.status).toBe("correct");
  });

  it("scores incorrect when rejected for the WRONG gate (right verdict, wrong reason)", () => {
    const c = caseById("h001-no-digit");
    // p2 correctly rejected, but the fixture names schema instead of h001.
    const parsed = { reviews: [passReview("p1"), failReview("p2", "schema", "training")], winner: "p1" };
    const out = scoreCase(c, parsed);
    expect(out.status).toBe("incorrect");
  });

  it("scores incorrect when a proposal has no matching review at all", () => {
    const c = caseById("schema-missing-field");
    const parsed = { reviews: [passReview("p1", "arch")], winner: "p1" }; // p2 missing
    const out = scoreCase(c, parsed);
    expect(out.status).toBe("incorrect");
  });

  it("scores the instrumentation-missing case correctly", () => {
    const c = caseById("instrumentation-missing");
    const parsed = {
      reviews: [passReview("p1", "training"), failReview("p2", "instrumentation", "data-augmentation")],
      winner: "p1",
    };
    expect(scoreCase(c, parsed).status).toBe("correct");
  });
});

describe("agent-eval — scoring: set-level cases (expect_any_rejected_for)", () => {
  it("scores h003-family-collision correct when ANY review is rejected on h003", () => {
    const c = caseById("h003-family-collision");
    const parsed = {
      reviews: [passReview("p1"), failReview("p2", "h003"), passReview("p3")],
      winner: "p1",
    };
    const out = scoreCase(c, parsed);
    expect(out.status).toBe("correct");
    expect(out.named_gate).toBe("h003");
  });

  it("scores h003-family-collision incorrect when nothing is rejected on h003", () => {
    const c = caseById("h003-family-collision");
    const parsed = { reviews: [passReview("p1"), passReview("p2"), passReview("p3")], winner: "p1" };
    const out = scoreCase(c, parsed);
    expect(out.status).toBe("incorrect");
  });

  it("scores h003-family-collision incorrect when rejected but on the wrong gate", () => {
    const c = caseById("h003-family-collision");
    const parsed = {
      reviews: [passReview("p1"), failReview("p2", "schema"), passReview("p3")],
      winner: "p1",
    };
    expect(scoreCase(c, parsed).status).toBe("incorrect");
  });

  it("scores h004-parent-concentration correct when any review is rejected on h004", () => {
    const c = caseById("h004-parent-concentration");
    const parsed = {
      reviews: [passReview("p1"), passReview("p2"), failReview("p3", "h004"), passReview("p4", "arch")],
      winner: "p1",
    };
    expect(scoreCase(c, parsed).status).toBe("correct");
  });

  it("does not require expect_any_rejected_for cases to have an `expect` array", () => {
    const c = caseById("h003-family-collision");
    expect(c.expect).toBeUndefined();
    expect(c.expect_any_rejected_for).toBe("h003");
  });
});

describe("agent-eval — primaryGateForCase", () => {
  it("returns the set-level gate for expect_any_rejected_for cases", () => {
    expect(primaryGateForCase(caseById("h003-family-collision"))).toBe("h003");
    expect(primaryGateForCase(caseById("h004-parent-concentration"))).toBe("h004");
  });

  it("returns the failing gate for per-proposal cases with a rejection", () => {
    expect(primaryGateForCase(caseById("h001-no-digit"))).toBe("h001");
    expect(primaryGateForCase(caseById("schema-missing-field"))).toBe("schema");
    expect(primaryGateForCase(caseById("instrumentation-missing"))).toBe("instrumentation");
  });

  it("returns null for a clean baseline case", () => {
    expect(primaryGateForCase(caseById("clean-2"))).toBeNull();
  });
});

describe("agent-eval — prompt construction", () => {
  it("extracts the <Agent_Prompt> block from the selector agent file", () => {
    const md = readFileSync(resolve(REPO_ROOT, "agents/evor-selector.md"), "utf8");
    const block = extractAgentPromptBlock(md);
    expect(block.startsWith("<Agent_Prompt>")).toBe(true);
    expect(block.endsWith("</Agent_Prompt>")).toBe(true);
    expect(block).toMatch(/Seven_Gate_Checklist/);
  });

  it("throws when the agent file has no <Agent_Prompt> block", () => {
    expect(() => extractAgentPromptBlock("no such block here")).toThrow();
  });

  it("embeds the case's full proposal set and excludes H002/gotcha from grading", () => {
    const c = caseById("h003-family-collision");
    const prompt = buildCasePrompt("<Agent_Prompt>x</Agent_Prompt>", c);
    expect(prompt).toContain('"proposal_id": "p1"');
    expect(prompt).toContain('"proposal_id": "p3"');
    expect(prompt).toMatch(/H002/);
    expect(prompt).toMatch(/Gotcha Avoidance/);
    expect(prompt).toMatch(/no MCP tools/i);
  });
});

describe("agent-eval — tier parsing", () => {
  it("parses the comma-list shorthand", () => {
    expect(parseTiers("sonnet:medium,haiku:high")).toEqual([
      { model: "sonnet", effort: "medium" },
      { model: "haiku", effort: "high" },
    ]);
  });

  it("parses a JSON array", () => {
    expect(parseTiers('[{"model":"opus","effort":"low"}]')).toEqual([{ model: "opus", effort: "low" }]);
  });

  it("returns the documented default matrix when unset", () => {
    const tiers = parseTiers(undefined);
    expect(tiers).toContainEqual({ model: "sonnet", effort: "medium" });
    expect(tiers).toContainEqual({ model: "haiku", effort: "high" });
    expect(tiers).toContainEqual({ model: "haiku", effort: "medium" });
    expect(tiers).toContainEqual({ model: "sonnet", effort: "low" });
  });
});

describe("agent-eval — report assembly and insufficient-evidence verdict", () => {
  function rec(tier: string, case_id: string, status: string, cost_usd = 0.01, wall_ms = 1000) {
    return { tier, case_id, primary_gate: "baseline", repeat: 0, status, cost_usd, wall_ms };
  }

  it("declares insufficient evidence when two tiers have identical small-sample accuracy", () => {
    const tiers = [
      { model: "sonnet", effort: "medium" },
      { model: "haiku", effort: "high" },
    ];
    const records = [
      rec("sonnet-medium", "c1", "correct"),
      rec("sonnet-medium", "c2", "incorrect"),
      rec("haiku-high", "c1", "correct"),
      rec("haiku-high", "c2", "incorrect"),
    ];
    const report = buildReport({ role: "evor-selector", tiers, records });
    expect(report.comparisons[0].verdict).toBe("insufficient evidence");
  });

  it("declares a tier ahead when the accuracy gap is large relative to sample size", () => {
    const tiers = [
      { model: "sonnet", effort: "medium" },
      { model: "haiku", effort: "medium" },
    ];
    const records = [
      ...Array.from({ length: 20 }, () => rec("sonnet-medium", "c1", "correct")),
      ...Array.from({ length: 20 }, () => rec("haiku-medium", "c1", "incorrect")),
    ];
    const report = buildReport({ role: "evor-selector", tiers, records });
    expect(report.comparisons[0].verdict).toMatch(/ahead/);
  });

  it("computes mean cost and wall-clock per tier and renders a readable table", () => {
    const tiers = [{ model: "sonnet", effort: "medium" }];
    const records = [rec("sonnet-medium", "c1", "correct", 0.02, 500), rec("sonnet-medium", "c1", "correct", 0.04, 1500)];
    const report = buildReport({ role: "evor-selector", tiers, records });
    expect(report.tiers[0].mean_cost_usd).toBeCloseTo(0.03, 8);
    expect(report.tiers[0].mean_wall_ms).toBeCloseTo(1000, 8);
    const table = renderTable(report);
    expect(table).toMatch(/sonnet-medium/);
    expect(table).toMatch(/accuracy/);
  });

  it("counts unparseable separately from correct/incorrect in per-case tallies", () => {
    const tiers = [{ model: "haiku", effort: "high" }];
    const records = [rec("haiku-high", "c1", "correct"), rec("haiku-high", "c1", "unparseable")];
    const report = buildReport({ role: "evor-selector", tiers, records });
    const c1 = report.tiers[0].cases.find((c: any) => c.case_id === "c1");
    expect(c1.counts.correct).toBe(1);
    expect(c1.counts.unparseable).toBe(1);
    // accuracy is computed over SCORED (correct+incorrect) calls only.
    expect(report.tiers[0].accuracy).toBe(1);
  });
});

describe("a dial that does nothing must not look like a variable under test", () => {
  /**
   * The first tier matrix ran "haiku-high" and "haiku-medium" as separate tiers and
   * reported two rows. They are one configuration: haiku has no effort dial. The
   * repo's own frontmatter test already said so ("haiku does not support effort —
   * declaring it is inert"), and a controlled check confirmed it — 3 reps each on a
   * reasoning-heavy prompt gave low 1016/947/901 vs high 908/699/1021, high LOWER
   * than low with overlapping ranges.
   *
   * The tier guard verified the MODEL came back as requested and never checked
   * whether the effort could matter, so 60 samples of one arm were presented as a
   * comparison between two.
   */
  it("knows effort is inert on haiku", () => {
    expect(effortIsInert("haiku")).toBe(true);
    expect(effortIsInert("claude-haiku-4-5")).toBe(true);
    expect(effortIsInert("claude-haiku-4-5-20251001"), "dated ids too").toBe(true);
  });

  it("effort is a real variable on sonnet and opus", () => {
    expect(effortIsInert("sonnet")).toBe(false);
    expect(effortIsInert("opus")).toBe(false);
  });

  it("collapses inert-effort tiers to a single label", () => {
    expect(canonicalTierLabel({ model: "haiku", effort: "high" }))
      .toBe(canonicalTierLabel({ model: "haiku", effort: "medium" }));
  });

  it("keeps distinct labels where effort genuinely varies", () => {
    expect(canonicalTierLabel({ model: "sonnet", effort: "low" }))
      .not.toBe(canonicalTierLabel({ model: "sonnet", effort: "medium" }));
  });
});
