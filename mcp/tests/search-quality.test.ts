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
    // `self_directed` is the per-finding marker. The fixture originally used
    // `investigation_query_ref: null`, which is an ARTIFACT-level field — findings
    // never carry it, so the analyzer's count was pinned at 0 on real runs while
    // this fixture "passed" by asserting the same wrong thing the code did.
    findings: [
      { finding: "x improves y", self_directed: false },
      { finding: "no evidence found for z", self_directed: true },
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

describe("C2 — novelty over declared mechanisms discriminates where inferred proxies do not", () => {
  // Both inferred proxies sat at ceiling on real data: every proposal touches a
  // fresh file locus (rate 1.00), and every proposal is worded differently
  // (Jaccard 0.95-0.98) even when the idea is the same. So the proposal declares
  // its own mechanisms and novelty is measured over that space instead.
  //
  // This fixture is the case both inferred proxies get WRONG: two ticks of
  // proposals that are textually different and touch different files, where the
  // second tick is pure re-tread at the mechanism level.
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "evor-sq-tags-"));
    const w = (p: string, o: unknown) => {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify(o));
    };
    w(join(dir, "tree.json"), { nodes: {} });
    w(join(dir, "run-state.json"), { run_id: "tags" });

    // tick 1 — two genuinely distinct mechanisms.
    w(join(dir, "ticks", "1", "mutagen", "proposals.json"), {
      proposals: [
        { idea: "grow a decision tree with gini splits over raw columns",
          mutation_locus: { path: "model/tree.py" }, technique_tags: ["decision-tree", "gini-split"] },
        { idea: "bootstrap resample and average many weak learners together",
          mutation_locus: { path: "model/bag.py" }, technique_tags: ["bagging", "bootstrap-resampling"] },
      ],
    });
    // tick 2 — different wording, different files, SAME mechanisms. A re-tread.
    w(join(dir, "ticks", "2", "mutagen", "proposals.json"), {
      proposals: [
        { idea: "construct a hierarchical partition using impurity reduction criteria",
          mutation_locus: { path: "model/partition.py" }, technique_tags: ["decision-tree", "gini-split"] },
        { idea: "aggregate predictions from resampled sub-populations by voting",
          mutation_locus: { path: "model/vote.py" }, technique_tags: ["bagging"] },
      ],
    });
    // tick 3 — one genuinely new mechanism.
    w(join(dir, "ticks", "3", "mutagen", "proposals.json"), {
      proposals: [
        { idea: "cross pairs of features before fitting",
          mutation_locus: { path: "data/cross.py" }, technique_tags: ["feature-cross"] },
      ],
    });
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const run = () => {
    const r = spawnSync("node", [SCRIPT, dir, "--json"], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
    return JSON.parse(r.stdout);
  };

  it("counts a mechanism-level re-tread as zero exploration", () => {
    const perTick = run().per_tick;
    expect(perTick[0].new_technique_tags).toBe(4);
    expect(perTick[1].new_technique_tags, "tick 2 reuses only mechanisms already seen").toBe(0);
    expect(perTick[2].new_technique_tags).toBe(1);
  });

  it("the inferred proxies call that same re-tread maximally novel — which is the point", () => {
    const perTick = run().per_tick;
    // Different files and different wording, so both cheap measures score it high
    // while the mechanism measure correctly scores it zero.
    expect(perTick[1].novel_loci).toBe(2);
    expect(perTick[1].intra_tick_diversity).toBeGreaterThan(0.9);
  });

  it("tracks the vocabulary of distinct mechanisms across the run", () => {
    expect(run().summary.technique_tag_vocabulary).toBe(5);
  });

  it("reports proposals that declared no tags rather than scoring them as novel", () => {
    const untagged = mkdtempSync(join(tmpdir(), "evor-sq-untagged-"));
    mkdirSync(join(untagged, "ticks", "1", "mutagen"), { recursive: true });
    writeFileSync(join(untagged, "tree.json"), JSON.stringify({ nodes: {} }));
    writeFileSync(join(untagged, "run-state.json"), JSON.stringify({ run_id: "u" }));
    writeFileSync(
      join(untagged, "ticks", "1", "mutagen", "proposals.json"),
      JSON.stringify({ proposals: [{ idea: "something", mutation_locus: { path: "a.py" } }] }),
    );
    const out = run.call(null) && JSON.parse(spawnSync("node", [SCRIPT, untagged, "--json"], { encoding: "utf8" }).stdout);
    rmSync(untagged, { recursive: true, force: true });
    expect(out.summary.proposals_untagged).toBe(1);
    expect(out.summary.technique_tag_vocabulary).toBe(0);
  });
});

describe("Selector's artifact has no enforced schema — the analyzer must survive that", () => {
  // Three consecutive ticks of ONE real run used three different shapes:
  //   tick 1  reviews[]              -> critic_review.verdict
  //   tick 2  per_proposal_reviews[] -> verdict: "deferred"
  //   tick 3  reviews[]              -> critic_approved: true
  // Reading only the first shape reported "0 approved" for tick 2 and a confident
  // "0% selector precision" that was pure parser artifact.
  let multi: string;

  beforeAll(() => {
    multi = mkdtempSync(join(tmpdir(), "evor-sq-schema-"));
    const w = (p: string, o: unknown) => {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify(o));
    };
    w(join(multi, "tree.json"), { nodes: {} });
    w(join(multi, "run-state.json"), { run_id: "schema-run" });
    for (const t of [1, 2, 3]) {
      w(join(multi, "ticks", String(t), "mutagen", "proposals.json"), { proposals: [{ approach_family: "a", mutation_tier: "p" }] });
    }
    w(join(multi, "ticks", "1", "selector", "verdict.json"), {
      reviews: [{ proposal_id: "p1", critic_review: { verdict: "approved" } }],
    });
    w(join(multi, "ticks", "2", "selector", "verdict.json"), {
      per_proposal_reviews: [{ proposal_id: "p2", verdict: "approved" }, { proposal_id: "p3", verdict: "deferred" }],
    });
    w(join(multi, "ticks", "3", "selector", "verdict.json"), {
      reviews: [{ proposal_id: "p4", critic_approved: true }],
    });
  });

  afterAll(() => rmSync(multi, { recursive: true, force: true }));

  function run(dir: string) {
    const r = spawnSync("node", [SCRIPT, dir, "--json"], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`analyzer exited ${r.status}: ${r.stderr}`);
    return JSON.parse(r.stdout);
  }

  it("reads approvals from all three shapes", () => {
    expect(run(multi).per_tick.map((t: { approved: number }) => t.approved)).toEqual([1, 1, 1]);
  });

  it("reports the drift instead of silently averaging over it", () => {
    expect(run(multi).summary.selector_schema_drift).toBe(true);
  });

  it("never reports an unrecognised review as a rejection", () => {
    const odd = mkdtempSync(join(tmpdir(), "evor-sq-odd-"));
    mkdirSync(join(odd, "ticks", "1", "selector"), { recursive: true });
    writeFileSync(join(odd, "run-state.json"), JSON.stringify({ run_id: "odd" }));
    writeFileSync(join(odd, "tree.json"), JSON.stringify({ nodes: {} }));
    writeFileSync(
      join(odd, "ticks", "1", "selector", "verdict.json"),
      JSON.stringify({ reviews: [{ proposal_id: "x", some_future_field: "yes" }] }),
    );
    const out = run(odd);
    rmSync(odd, { recursive: true, force: true });
    expect(out.summary.reviews_undecidable, "an unknown shape must be flagged, not counted as rejected").toBe(1);
    expect(out.per_tick[0].approved).toBe(0);
  });

  it("distinguishes an unparseable verdict file from a genuine zero", () => {
    const empty = mkdtempSync(join(tmpdir(), "evor-sq-empty-"));
    mkdirSync(join(empty, "ticks", "1", "selector"), { recursive: true });
    writeFileSync(join(empty, "run-state.json"), JSON.stringify({ run_id: "e" }));
    writeFileSync(join(empty, "tree.json"), JSON.stringify({ nodes: {} }));
    writeFileSync(join(empty, "ticks", "1", "selector", "verdict.json"), JSON.stringify({ unknown_root_key: [] }));
    const out = run(empty);
    rmSync(empty, { recursive: true, force: true });
    expect(out.summary.verdicts_unparsed).toBe(1);
  });
});

function readFileSyncSafe(p: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("fs").readFileSync(p, "utf8");
}

describe("a node whose tick ended without a final forge report is not lost", () => {
  // The ladder run ended tick 3 with only `forge-report-partial.json`. Attribution
  // looked solely at `forge-report.json`, so that tick's node — fitness 0.905302,
  // the best in the run — was attributed to no tick and reported as
  // "tick 3: nodes 0 · no gain". That reads as a search that stalled. It had not.
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "evor-sq-partial-"));
    const w = (p: string, o: unknown) => {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify(o));
    };
    w(join(dir, "tree.json"), {
      nodes: { z1: { id: "z1", name: "late-node", metrics: {}, integrity_status: "passed", status: "done" } },
    });
    w(join(dir, "nodes", "z1", "results.json"), { fitness_value: 0.9, metrics: { roc_auc: 0.9 }, status: "success" });
    w(join(dir, "run-state.json"), { run_id: "partial", best_score: 0.9 });
    w(join(dir, "ticks", "1", "mutagen", "proposals.json"), { proposals: [{ idea: "x", technique_tags: ["t"] }] });
    // ONLY a partial report, and the node is named in the critic artifact instead.
    w(join(dir, "ticks", "1", "forge", "forge-report-partial.json"), { status: "in_progress" });
    w(join(dir, "ticks", "1", "forge", "critic.json"), { node_id: "z1", verdict: "ok" });
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const run = () => JSON.parse(spawnSync("node", [SCRIPT, dir, "--json"], { encoding: "utf8" }).stdout);

  it("attributes the node by scanning every artifact in the tick, not just forge-report.json", () => {
    expect(run().trajectory[0].nodes).toBe(1);
  });

  it("counts nothing as unattributed once it can be placed", () => {
    expect(run().summary.scored_nodes_not_attributed_to_a_tick).toBe(0);
  });
});

describe("gains below the metric's noise floor are not called improvements", () => {
  // The ladder run's tick 3 gained +0.001446 against a bootstrap sd of ~0.006-0.010
  // at n=2000. Raw comparison says 3/3 ticks improved; only 2 of those are real.
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "evor-sq-noise-"));
    const w = (p: string, o: unknown) => {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify(o));
    };
    const nodes = { a: 0.80, b: 0.90, c: 0.9005 }; // c beats b by 0.0005 — noise.
    w(join(dir, "tree.json"), {
      nodes: Object.fromEntries(
        Object.keys(nodes).map((k) => [k, { id: k, name: k, metrics: {}, integrity_status: "passed", status: "done" }]),
      ),
    });
    for (const [k, v] of Object.entries(nodes)) {
      w(join(dir, "nodes", k, "results.json"), { fitness_value: v, status: "success" });
    }
    w(join(dir, "run-state.json"), { run_id: "noise", best_score: 0.9005 });
    let t = 0;
    for (const k of Object.keys(nodes)) {
      t++;
      w(join(dir, "ticks", String(t), "mutagen", "proposals.json"), { proposals: [{ idea: k, technique_tags: [k] }] });
      w(join(dir, "ticks", String(t), "forge", "forge-report.json"), { node_id: k });
    }
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const run = () => JSON.parse(spawnSync("node", [SCRIPT, dir, "--json"], { encoding: "utf8" }).stdout);

  it("counts the raw improvements", () => {
    expect(run().summary.improving_ticks).toBe(3);
  });

  it("but reports separately how many clear the noise floor", () => {
    // 1, not 2. Tick 1 arrives from nothing, so there is no previous best and no
    // delta to compare against the floor — counting it would assert a gain that
    // cannot be computed. Only tick 2 (+0.10) clears; tick 3 (+0.0005) does not.
    expect(run().summary.improving_ticks_above_noise, "0.0005 is resampling, not a gain").toBe(1);
  });

  it("the first scored tick has no gain, because there is nothing to gain over", () => {
    expect(run().trajectory[0].improved).toBe(true);
    expect(run().trajectory[0].gain).toBeNull();
  });

  it("labels the sub-noise gain in the trajectory", () => {
    expect(run().trajectory[2].gain).toBeLessThan(run().summary.noise_floor);
  });
});
