/**
 * mcp/tests/search-quality.test.ts — Phase B1
 *
 * Tests for the instrument itself. An analyzer that silently reports zeros is
 * worse than none: this repo already shipped `IMPROVING TICKS 0/3` from a parser
 * that was reading fitness out of the wrong file, and it read exactly like a
 * finding about the search.
 *
 * So every assertion here is against a fixture with KNOWN answers, and the
 * fixture deliberately reproduces the two shapes that fooled the first version:
 *   - fitness lives in nodes/<id>/results.json, NOT in tree.json (whose `metrics`
 *     are empty on real runs)
 *   - a tick can be missing its sage/ artifact entirely
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = join(REPO, "scripts", "search-quality.mjs");

let runDir: string;

/** A run with a known-correct answer for every metric asserted below. */
beforeAll(() => {
  runDir = mkdtempSync(join(tmpdir(), "evor-sq-"));
  const w = (p: string, o: unknown) => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(o));
  };

  // Three nodes: two improve in sequence, one regresses.
  const nodes = [
    { id: "n1", name: "alpha", fitness: 0.80, integrity: "passed" },
    { id: "n2", name: "beta", fitness: 0.90, integrity: "passed" },
    { id: "n3", name: "gamma", fitness: 0.70, integrity: "passed" },
  ];
  w(join(runDir, "tree.json"), {
    nodes: Object.fromEntries(
      nodes.map((n) => [
        n.id,
        // metrics EMPTY, exactly as real runs write them — the analyzer must not
        // read fitness from here.
        { id: n.id, name: n.name, metrics: {}, integrity_status: n.integrity, approach_family: "algo", status: "done" },
      ]),
    ),
  });
  for (const n of nodes) {
    w(join(runDir, "nodes", n.id, "results.json"), {
      metrics: { accuracy: n.fitness, roc_auc: n.fitness + 0.01 },
      fitness_value: n.fitness,
      status: "success",
    });
  }
  w(join(runDir, "run-state.json"), { run_id: "test-run", best_score: 0.9 });

  // tick 1: 2 proposals, 1 approved, node n1. NO sage artifact.
  w(join(runDir, "ticks", "1", "mutagen", "proposals.json"), {
    wildness_used: 0.3,
    proposals: [
      { approach_family: "algo", mutation_tier: "parametric", mutation_locus: { path: "model/a.py" } },
      { approach_family: "data", mutation_tier: "structural", mutation_locus: { path: "data/b.py" } },
    ],
  });
  w(join(runDir, "ticks", "1", "selector", "verdict.json"), {
    reviews: [
      { proposal_id: "p1", critic_review: { verdict: "approved" } },
      { proposal_id: "p2", critic_review: { verdict: "rejected", h003_intra_tick_diversity: "fail" } },
    ],
  });
  w(join(runDir, "ticks", "1", "forge", "forge-report.json"), { node_id: "n1" });

  // tick 2: sage present, one finding proactive (investigation_query_ref: null).
  w(join(runDir, "ticks", "2", "mutagen", "proposals.json"), {
    wildness_used: 0.6,
    proposals: [{ approach_family: "algo", mutation_tier: "parametric", mutation_locus: { path: "model/a.py" } }],
  });
  w(join(runDir, "ticks", "2", "selector", "verdict.json"), {
    reviews: [{ proposal_id: "p3", critic_review: { verdict: "approved" } }],
  });
  w(join(runDir, "ticks", "2", "sage", "findings.json"), {
    findings: [
      { finding: "x improves y", investigation_query_ref: "q1" },
      { finding: "no evidence found for z", investigation_query_ref: null },
    ],
  });
  w(join(runDir, "ticks", "2", "forge", "forge-report.json"), { node_id: "n2" });

  // tick 3: regression — gamma scores below the running best.
  w(join(runDir, "ticks", "3", "mutagen", "proposals.json"), {
    wildness_used: 0.7,
    proposals: [{ approach_family: "arch", mutation_tier: "structural", mutation_locus: { path: "model/c.py" } }],
  });
  w(join(runDir, "ticks", "3", "selector", "verdict.json"), {
    reviews: [{ proposal_id: "p4", critic_review: { verdict: "approved" } }],
  });
  w(join(runDir, "ticks", "3", "forge", "forge-report.json"), { node_id: "n3" });
});

afterAll(() => rmSync(runDir, { recursive: true, force: true }));

function analyze() {
  const r = spawnSync("node", [SCRIPT, runDir, "--json"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`analyzer exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

describe("fitness is read from results.json, not from the empty tree metrics", () => {
  it("scores every node despite tree.json carrying metrics: {}", () => {
    const { summary } = analyze();
    expect(summary.nodes_total).toBe(3);
    expect(summary.nodes_scored, "reading fitness from tree.json yields 0 here").toBe(3);
  });

  it("reports that the tree metrics are empty rather than hiding it", () => {
    expect(analyze().summary.nodes_with_empty_tree_metrics).toBe(3);
  });
});

describe("improving-tick ratio — the headline search-quality number", () => {
  it("counts only ticks that raised the running best", () => {
    const { summary, trajectory } = analyze();
    // n1=0.80 (improves from nothing), n2=0.90 (improves), n3=0.70 (does not).
    expect(summary.improving_ticks).toBe(2);
    expect(trajectory.at(-1).improved).toBe(false);
  });

  it("a regression does not lower the running best", () => {
    expect(analyze().trajectory.at(-1).running_best).toBe(0.9);
  });
});

describe("the Sage channel", () => {
  it("counts ticks with no sage artifact at all", () => {
    // Absence is a finding: it means the grounding gate is skippable in practice.
    expect(analyze().summary.ticks_without_sage).toBe(2);
  });

  it("counts self-directed findings — the only way a new concept can enter", () => {
    expect(analyze().summary.sage_proactive_total).toBe(1);
  });

  it("counts disconfirming findings, which are worth more than confirmations", () => {
    const t2 = analyze().per_tick.find((t: { tick: number }) => t.tick === 2);
    expect(t2.sage_disconfirming).toBe(1);
  });
});

describe("Mutagen's exploration", () => {
  it("tracks wildness per tick", () => {
    expect(analyze().per_tick.map((t: { wildness: number }) => t.wildness)).toEqual([0.3, 0.6, 0.7]);
  });

  it("counts structurally novel loci, not raw proposal volume", () => {
    // tick 1 introduces model/a.py + data/b.py; tick 2 re-treads model/a.py;
    // tick 3 introduces model/c.py.
    expect(analyze().per_tick.map((t: { novel_loci: number }) => t.novel_loci)).toEqual([2, 0, 1]);
  });
});

describe("Selector", () => {
  it("reports approval rate over all reviews", () => {
    expect(analyze().summary.approval_rate).toBeCloseTo(3 / 4, 5);
  });

  it("attributes rejections to the specific gate that failed", () => {
    const t1 = analyze().per_tick.find((t: { tick: number }) => t.tick === 1);
    expect(t1.rejection_gates).toHaveProperty("h003_intra_tick_diversity", 1);
  });
});

describe("Sage's self-directed angle is stated where Sage will read it", () => {
  // A4 is a prompt change; if the prose goes, the channel goes with it and the
  // analyzer above will just report 0 forever without explaining why.
  const sage = readFileSyncSafe(join(REPO, "agents", "evor-sage.md"));

  it("reserves an angle Mutagen did not ask for", () => {
    expect(sage).toMatch(/investigation_query_ref.*null|null.*investigation_query_ref/s);
    expect(sage).toMatch(/30%/);
  });

  it("says why — Sage cannot otherwise widen the hypothesis space", () => {
    expect(sage).toMatch(/multiplication|adjacent|nobody asked/i);
  });
});

function readFileSyncSafe(p: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("fs").readFileSync(p, "utf8");
}
