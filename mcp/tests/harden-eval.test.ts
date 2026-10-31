/**
 * mcp/tests/harden-eval.test.ts — the metric-hardening path, end to end.
 *
 * A running mission that finds its metric gameable may replace the evaluator
 * with a STRICTER one under a new eval_version. Everything here runs the real
 * harness (no mocked Python): evor_harden_eval writes, records and seals the new
 * version; a node is re-locked onto the sealed hardened evaluator and re-scored;
 * evor_record_eval's integrity check then passes eval_version_consistent and
 * not_softer_than_parent — or fails the latter when the "hardened" evaluator
 * scores higher than its parent. The governor half pins who may apply it.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { registerComputeTools, lockEvaluate, relockForRescore } from "../src/tools/compute.js";
import { recordEval, readResult, updateBestScore } from "../src/tools/record.js";
import { integrityCheck, evalVersionCache, frozenSplitHashCache } from "../src/tools/integrity.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const HARNESS = resolve(TEST_DIR, "../../harness");
const PRE_TOOL_USE = resolve(TEST_DIR, "../../hooks/pre-tool-use.mjs");
const UUID = "22222222-3333-4444-8555-666666666666";
const NAME = "n1-seed";
const INTENT = "Faint strokes must be preserved: never trade ink recall for stroke-width match.";
const GROUNDING = "never trade ink recall for stroke-width match";
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

const PARENT_SRC = [
  "import json, os",
  "from pathlib import Path",
  'LABEL_SEMANTICS = "foreground_is_1"',
  'v = float(Path(os.environ["EVOR_WORKTREE"], "score.txt").read_text())',
  'print(json.dumps({"metrics": {"accuracy": v}, "per_domain": {}, "eval_version": os.environ["EVOR_EVAL_VERSION"]}))',
  "",
].join("\n");
const HARDENED_SRC = PARENT_SRC.replace('{"accuracy": v}', '{"accuracy": v * 0.5}');
const SOFTENED_SRC = PARENT_SRC.replace('{"accuracy": v}', '{"accuracy": min(1.0, v + 0.05)}');

let root: string;
let runDir: string;
let nodeWt: string;
let saved: string | undefined;

const contract = () => JSON.parse(readFileSync(join(runDir, "goal-contract.json"), "utf8"));

async function tool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const handlers = new Map<string, (a: never) => Promise<{ content: { text: string }[] }>>();
  registerComputeTools({ tool: (n: string, _d: string, _s: unknown, h: never) => handlers.set(n, h) } as never);
  const res = await handlers.get(name)!({ mission_id: "m1", ...args } as never);
  return JSON.parse(res.content[0].text);
}

function hardenerWorktree(src: string, name = "harden-v2"): string {
  const wt = join(root, "worktrees", name);
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(wt, "evaluate.py"), src);
  return name;
}

const harden = (extra: Record<string, unknown> = {}) => tool("evor_harden_eval", {
  run_id: "r1", from_version: "v1", to_version: "v2",
  source_worktree: hardenerWorktree(HARDENED_SRC),
  rationale: "recall floor on the worst domain: S is zeroed below r_skel 0.9",
  contract_grounding: GROUNDING,
  evidence: ["lesson-faint-ink-erasure", "probe@tick4"],
  tick: 4,
  ...extra,
});

/** Run the evaluation synchronously — the same command the detached job runs. */
function evorRun(evalVersion: string): void {
  const r = spawnSync("python3", [
    "-m", "evor", "run", "--node-id", UUID, "--run-id", "r1", "--worktree", nodeWt,
    "--run-dir", runDir, "--no-selfheal", "--eval-version", evalVersion,
  ], { encoding: "utf8", env: { ...process.env, PYTHONPATH: HARNESS }, timeout: 120_000 });
  expect([0, 4], r.stderr).toContain(r.status);
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "evor-harden-"));
  saved = process.env.EVOR_ROOT;
  process.env.EVOR_ROOT = root;
  evalVersionCache.clear();
  frozenSplitHashCache.clear();
  runDir = join(root, "runs", "m1", "r1");
  mkdirSync(join(runDir, "eval-suites"), { recursive: true });
  writeFileSync(join(runDir, "goal-contract.json"), JSON.stringify({
    mission_id: "m1", mode: "from-scratch", mission_type: "fixed",
    task_description: `Binarize scanned pages. ${INTENT}`, dataset_ref: "/data/x",
    metric_specs: [{
      metric_name: "accuracy", direction: "higher", domain_applicability: "all",
      aggregation_rule: "macro_avg", role: "primary_fitness",
    }],
    fitness_mode: "aggregate", eval_version: "v1", baseline_value: 0.1, target_value: 1.0,
    stop_condition: { type: "target" }, wildness: 0.5,
    budget: { max_iterations: 20, plateau_window: 5, circuit_breaker: 20, max_cost_usd: 50 },
    locked_split_hash: "deadbeef", allowed_licenses: ["MIT"],
  }, null, 2));
  writeFileSync(join(runDir, "mission-state.json"), JSON.stringify({ status: "running" }));
  writeFileSync(join(runDir, "run-state.json"), JSON.stringify({
    run_id: "r1", tick_count: 4, frontier_ids: [UUID], current_eval_version: "v1",
  }));
  writeFileSync(join(runDir, "tree.json"), JSON.stringify({
    updated_at: "2026-10-31T00:00:00Z",
    nodes: { [UUID]: {
      id: UUID, name: NAME, parent_ids: [], approach_family: "arch", hypothesis_id: "h1",
      code_ref: "x", genome_ref: "g", data_version_ref: "d", config: {}, metrics: { accuracy: 0.8 },
      eval_version: "v1", fitness_value: 0.8, integrity_status: "passed", status: "done",
    } },
  }));
  writeFileSync(join(runDir, "eval-suites", "v1.json"), JSON.stringify({
    eval_version: "v1", mission_id: "m1",
    domains: [{ domain_id: "primary", description: "p", metric_specs: [], added_at_eval_version: "v1" }],
    split_hashes: {}, created_at: "2026-10-31T00:00:00Z", created_by: "user", consent_log_ref: "setup-session",
  }));
  // A frozen split and sane telemetry, so a clean node's verdict can pass.
  mkdirSync(join(runDir, "frozen-splits"), { recursive: true });
  writeFileSync(join(runDir, "frozen-splits", "v1-test.json"), JSON.stringify({
    split_id: "s1", mission_id: "m1", split_type: "test", split_hash: "deadbeef",
    per_sample_hashes: {}, item_count: 0, frozen_at: "2026-10-31T00:00:00Z", storage_path: "", eval_version: "v1",
  }));
  mkdirSync(join(runDir, "frozen-splits", "v1-test"), { recursive: true });
  writeFileSync(join(runDir, "frozen-splits", "v1-test", "item0.png"), "x");
  chmodSync(join(runDir, "frozen-splits", "v1-test", "item0.png"), 0o444);
  mkdirSync(join(runDir, "nodes", UUID), { recursive: true });
  writeFileSync(join(runDir, "nodes", UUID, "telemetry.jsonl"), [1, 2, 3].map((step) => JSON.stringify({
    step, loss: 1 / step, grad_norm: 1.0, timestamp: "2026-10-31T00:00:00Z",
  })).join("\n") + "\n");
  writeFileSync(join(runDir, "eval-suites", "v1.py"), PARENT_SRC);
  expect((await tool("evor_seal_eval_script", { run_id: "r1", eval_version: "v1" })).ok).toBe(true);

  nodeWt = join(root, "worktrees", NAME);
  mkdirSync(nodeWt, { recursive: true });
  copyFileSync(join(runDir, "eval-suites", "v1.py"), join(nodeWt, "evaluate.py"));
  writeFileSync(join(nodeWt, "score.txt"), "0.8");
  expect(lockEvaluate("r1", NAME, "m1").ok).toBe(true);
});

afterEach(() => {
  if (saved === undefined) delete process.env.EVOR_ROOT; else process.env.EVOR_ROOT = saved;
  evalVersionCache.clear();
  frozenSplitHashCache.clear();
  rmSync(root, { recursive: true, force: true });
});

describe("evor_harden_eval", () => {
  it("writes, records and seals the stricter version and names the frontier to re-score", async () => {
    const out = await harden();
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(out.rescore).toEqual([NAME]);

    const v2 = readFileSync(join(runDir, "eval-suites", "v2.py"));
    expect(v2.toString()).toBe(HARDENED_SRC);
    const c = contract();
    expect(c.eval_version).toBe("v2");
    expect(c.eval_script_hash).toBe(sha(v2));
    expect(existsSync(join(runDir, "eval-suites", "v2.sealed.json"))).toBe(true);
    const suite = JSON.parse(readFileSync(join(runDir, "eval-suites", "v2.json"), "utf8"));
    expect(suite).toMatchObject({ kind: "metric_hardening", parent_eval_version: "v1" });
    expect(JSON.parse(readFileSync(join(runDir, "run-state.json"), "utf8")).current_eval_version).toBe("v2");
    const log = readFileSync(join(runDir, "decision-log.md"), "utf8");
    expect(log).toMatch(/harden-eval/);
    expect(log).toMatch(/parent: v1/);
    expect(log).toMatch(/lesson-faint-ink-erasure/);
    expect(readFileSync(join(runDir, "eval-suites", "v1.py"), "utf8"), "v1 stays untouched").toBe(PARENT_SRC);
  });

  it("refuses without evidence", async () => {
    const out = await harden({ evidence: [" "] });
    expect(out.ok).toBe(false);
    expect(contract().eval_version).toBe("v1");
  });

  it("refuses a grounding the contract does not contain, and leaves nothing behind", async () => {
    const out = await harden({ contract_grounding: "maximise the number on the leaderboard" });
    expect(out.ok).toBe(false);
    expect(String(out.error)).toMatch(/contract_grounding/);
    expect(existsSync(join(runDir, "eval-suites", "v2.py"))).toBe(false);
    expect(contract().eval_version).toBe("v1");
    // The corrected retry is not blocked by the failed attempt.
    expect((await harden()).ok).toBe(true);
  });

  it("refuses non-conformant source before anything is written", async () => {
    const out = await harden({ source_worktree: hardenerWorktree("import sys\nx = sys.argv[1]\n", "bad") });
    expect(out.ok).toBe(false);
    expect(existsSync(join(runDir, "eval-suites", "v2.json"))).toBe(false);
    expect(contract().eval_version).toBe("v1");
  });

  it("refuses to write or seal a version not in force, or the shared plugin, while the mission runs", async () => {
    const write = await tool("evor_write_eval_script", { run_id: "r1", eval_version: "v2", source: HARDENED_SRC, target: "evaluator" });
    expect(write.ok).toBe(false);
    expect(String(write.error)).toMatch(/evor_harden_eval/);
    expect(existsSync(join(runDir, "eval-suites", "v2.py"))).toBe(false);
    writeFileSync(join(runDir, "eval-suites", "v2.py"), HARDENED_SRC);
    const seal = await tool("evor_seal_eval_script", { run_id: "r1", eval_version: "v2" });
    expect(seal.ok).toBe(false);
    expect(existsSync(join(runDir, "eval-suites", "v2.sealed.json"))).toBe(false);
    const plugin = await tool("evor_write_eval_script", {
      run_id: "r1", eval_version: "v1", target: "score_plugin", source: "def score(p, g, **k):\n    return {'f': 1}\n",
    });
    expect(plugin.ok).toBe(false);
    expect(String(plugin.error)).toMatch(/score_plugin/);
  });

  it("never adopts a draft on its own say-so, and restores it when a hardening is refused", async () => {
    // A draft left on disk before this tool existed: v2.py, never sealed.
    writeFileSync(join(runDir, "eval-suites", "v2.py"), SOFTENED_SRC);
    const bare = await harden({ source_worktree: undefined });
    expect(bare.ok).toBe(false);
    expect(String(bare.error)).toMatch(/reviewed evaluator/);
    expect(String(bare.error), "never suggests sealing the draft").not.toMatch(/evor_seal_eval_script/);

    const refused = await harden({ contract_grounding: "something the contract never said at all" });
    expect(refused.ok).toBe(false);
    expect(readFileSync(join(runDir, "eval-suites", "v2.py"), "utf8"), "the draft is put back").toBe(SOFTENED_SRC);
    expect(contract().eval_version).toBe("v1");

    const done = await harden();
    expect(done.ok, JSON.stringify(done)).toBe(true);
    expect(readFileSync(join(runDir, "eval-suites", "v2.py"), "utf8"), "the reviewed source replaced it").toBe(HARDENED_SRC);
    expect(contract().eval_script_hash).toBe(sha(HARDENED_SRC));
  });

  it("adopts a pre-sealed v2 only as the reviewed bytes, and never one changed after its seal", async () => {
    const v2 = join(runDir, "eval-suites", "v2.py");
    writeFileSync(v2, HARDENED_SRC);
    writeFileSync(join(runDir, "eval-suites", "v2.sealed.json"), JSON.stringify({
      eval_version: "v2", hash: sha(HARDENED_SRC), files: { "v2.py": sha(HARDENED_SRC) },
    }));
    const mismatch = await harden({ source: SOFTENED_SRC, source_worktree: undefined });
    expect(mismatch.ok).toBe(false);
    expect(String(mismatch.error)).toMatch(/different bytes/);

    writeFileSync(v2, SOFTENED_SRC);
    const tampered = await harden();
    expect(tampered.ok).toBe(false);
    expect(String(tampered.error)).toMatch(/no longer matches/);

    writeFileSync(v2, HARDENED_SRC);
    const adopted = await harden();
    expect(adopted.ok, JSON.stringify(adopted)).toBe(true);
  });

  it("refuses a mission that is not running", async () => {
    writeFileSync(join(runDir, "mission-state.json"), JSON.stringify({ status: "paused" }));
    const out = await harden();
    expect(out.ok).toBe(false);
    expect(String(out.error)).toMatch(/paused, not running/);
  });

  it("rejects a path in place of a version", async () => {
    const out = await harden({ to_version: "../escape" });
    expect(out.ok).toBe(false);
    expect(existsSync(join(runDir, "escape.py"))).toBe(false);
  });

  it("takes exactly one source and creates a version once", async () => {
    expect((await harden({ source: HARDENED_SRC })).ok).toBe(false);
    expect((await harden()).ok).toBe(true);
    const again = await harden();
    expect(again.ok).toBe(false);
    expect(String(again.error)).toMatch(/already exists|not the contract's current/);
  });
});

describe("re-scoring a node under the hardened version", () => {
  it("re-locks onto the sealed hardened evaluator, and check 10 passes after the re-score", async () => {
    // Populate the integrity tool's per-run cache under v1 first: the hardening
    // must invalidate it, or the next check reads the old version's paths.
    integrityCheck("r1", UUID, "m1");
    // A v1 score on record before the hardening.
    evorRun("v1");
    const v1 = recordEval("r1", UUID, JSON.parse(readFileSync(join(runDir, "nodes", UUID, "results.evaluator.json"), "utf8")), "m1");
    expect(v1.integrityReport).toBeTruthy();
    const v1Fitness = JSON.parse(readFileSync(join(runDir, "nodes", UUID, "results.json"), "utf8")).fitness_value;
    expect((await harden()).ok).toBe(true);

    // The plain lock refuses: the worktree still holds the parent evaluator.
    expect(lockEvaluate("r1", NAME, "m1").ok).toBe(false);
    const relock = relockForRescore("r1", nodeWt, "v2", "m1");
    expect(relock).toEqual({ ok: true, replaced: true });
    const installed = readFileSync(join(nodeWt, "evaluate.py"));
    expect(sha(installed)).toBe(contract().eval_script_hash);
    expect(readFileSync(join(nodeWt, "evaluate.py.lock"), "utf8")).toBe(sha(installed));
    expect(statSync(join(nodeWt, "evaluate.py")).mode & 0o777).toBe(0o444);
    expect(lockEvaluate("r1", NAME, "m1").ok, "the ordinary lock agrees afterwards").toBe(true);

    evorRun("v2");
    const evaluated = JSON.parse(readFileSync(join(runDir, "nodes", UUID, "results.evaluator.json"), "utf8"));
    expect(evaluated).toMatchObject({ eval_version: "v2", parent_eval_version: "v1" });

    // The recording agent's copy cannot raise the parent's score.
    const rec = recordEval("r1", UUID, { ...evaluated, parent_fitness_value: 99 }, "m1");
    expect(rec.evaluatorValuesKept).toContain("parent_fitness_value");
    const checks = (rec.integrityReport as { checks: Record<string, unknown> }).checks;
    expect(checks.eval_version_consistent, JSON.stringify(rec.integrityReport)).toBe(true);
    expect(checks.no_eval_shift).toBe(true);
    expect(checks.not_softer_than_parent).toBe(true);
    expect(rec.integrityVerdict, JSON.stringify(rec.integrityReport)).toBe("passed");

    const tree = JSON.parse(readFileSync(join(runDir, "tree.json"), "utf8"));
    expect(tree.nodes[UUID].eval_version).toBe("v2");
    const upgrade = JSON.parse(readFileSync(join(runDir, "benchmark-upgrades", "harden-v1-to-v2.json"), "utf8"));
    expect(upgrade.rescore_status).toBe("complete");
    expect(readFileSync(join(runDir, "decision-log.md"), "utf8")).toMatch(/frontier order under v2: n1-seed/);

    // Evidence, not override: the v1 score is still readable after the v2 re-score.
    const v1Read = readResult("r1", UUID, "m1", "v1");
    expect(v1Read.ok).toBe(true);
    expect(v1Read.data).toMatchObject({ eval_version: "v1", fitness_value: v1Fitness });
    expect(readResult("r1", UUID, "m1").data).toMatchObject({ eval_version: "v2" });
    expect(tree.nodes[UUID].scores_by_version).toEqual({
      v1: v1Fitness, v2: (readResult("r1", UUID, "m1").data as { fitness_value: number }).fitness_value,
    });
  });

  it("a 'hardened' evaluator that scores higher than its parent fails integrity", async () => {
    expect((await harden({ source_worktree: hardenerWorktree(SOFTENED_SRC, "soft-v2") })).ok).toBe(true);
    expect(relockForRescore("r1", nodeWt, "v2", "m1").ok).toBe(true);
    evorRun("v2");
    const evaluated = JSON.parse(readFileSync(join(runDir, "nodes", UUID, "results.evaluator.json"), "utf8"));
    const rec = recordEval("r1", UUID, evaluated, "m1");
    const report = rec.integrityReport as { verdict: string; checks: Record<string, unknown>; failure_reason?: string };
    expect(report.checks.not_softer_than_parent).toBe(false);
    expect(report.verdict).toBe("failed");
    expect(report.failure_reason).toMatch(/may only be stricter/);
    // The failed re-score does not replace the node's record under v1.
    const node = JSON.parse(readFileSync(join(runDir, "tree.json"), "utf8")).nodes[UUID];
    expect(node.eval_version).toBe("v1");
    expect(node.fitness_value).toBe(0.8);
    const upgrade = JSON.parse(readFileSync(join(runDir, "benchmark-upgrades", "harden-v1-to-v2.json"), "utf8"));
    expect(upgrade.rescore_status).toBe("partial");
    expect(upgrade.rescore_failed_node_ids).toEqual([UUID]);
  });

  it("an errored re-score is not a score", async () => {
    expect((await harden()).ok).toBe(true);
    const rec = recordEval("r1", UUID, {
      eval_version: "v2", metrics: {}, per_domain: {}, fitness_value: 0, status: "error",
      benchmark_raw: "boom", telemetry_summary: { total_steps: 0 },
    }, "m1");
    const node = JSON.parse(readFileSync(join(runDir, "tree.json"), "utf8")).nodes[UUID];
    expect(node.scores_by_version?.v2).toBeUndefined();
    const upgrade = JSON.parse(readFileSync(join(runDir, "benchmark-upgrades", "harden-v1-to-v2.json"), "utf8"));
    expect(upgrade.rescore_status).not.toBe("complete");
    expect(upgrade.rescore_failed_node_ids).toContain(UUID);
  });

  it("best_score is kept per eval version", async () => {
    expect((await harden()).ok).toBe(true);
    const v1Result = { eval_version: "v1", metrics: { accuracy: 0.99 }, fitness_value: 0.99 };
    updateBestScore("r1", UUID, v1Result, "passed", "m1");
    expect(JSON.parse(readFileSync(join(runDir, "run-state.json"), "utf8")).best_score).toBeUndefined();
    updateBestScore("r1", UUID, { ...v1Result, eval_version: "v2", metrics: { accuracy: 0.4 } }, "passed", "m1");
    expect(JSON.parse(readFileSync(join(runDir, "run-state.json"), "utf8")).best_score).toBe(0.4);
  });

  it("a stored version never builds a path, and the reader takes only v<N>", async () => {
    mkdirSync(join(runDir, "nodes", UUID), { recursive: true });
    writeFileSync(join(runDir, "nodes", UUID, "results.json"), JSON.stringify({ eval_version: "../../../escape" }));
    recordEval("r1", UUID, {
      eval_version: "v1", metrics: { accuracy: 0.8 }, per_domain: {}, fitness_value: 0.8, status: "success",
      benchmark_raw: "", telemetry_summary: { total_steps: 0 },
    }, "m1");
    const found = spawnSync("find", [root, "-name", "*escape*"], { encoding: "utf8" }).stdout.trim();
    expect(found, "no file is named by the stored version").toBe("");
    expect(readResult("r1", UUID, "m1", "../x").ok).toBe(false);
  });

  it("a receipt-less version is told to verify against the anchor before sealing", () => {
    const out = relockForRescore("r1", nodeWt, "v7", "m1");
    expect(out.ok).toBe(false);
    writeFileSync(join(runDir, "goal-contract.json"), JSON.stringify({ ...contract(), eval_version: "v7" }));
    const msg = relockForRescore("r1", nodeWt, "v7", "m1");
    expect(msg.ok).toBe(false);
    expect((msg as { error: string }).error).toMatch(/Verify eval-suites\/v7.py against the contract/);
  });

  it("never re-locks onto a file that does not match its seal", async () => {
    expect((await harden()).ok).toBe(true);
    const canonical = join(runDir, "eval-suites", "v2.py");
    chmodSync(canonical, 0o644);
    writeFileSync(canonical, HARDENED_SRC.replace("v * 0.5", "v * 2"));
    const before = readFileSync(join(nodeWt, "evaluate.py"));
    const relock = relockForRescore("r1", nodeWt, "v2", "m1");
    expect(relock.ok).toBe(false);
    expect(readFileSync(join(nodeWt, "evaluate.py")).equals(before)).toBe(true);
  });

  it("evor_run_start refuses a version that is not in force before launching anything", async () => {
    const out = await tool("evor_run_start", { run_id: "r1", node_id: NAME, worktree: nodeWt, eval_version: "v2" });
    expect(out.ok).toBe(false);
    expect(String(out.error)).toMatch(/not the version in force/);
    expect(existsSync(join(runDir, "jobs"))).toBe(false);
  });
});

describe("governor — the tick applies a hardening", () => {
  function governor(
    agent: string | null, live: boolean,
    tool = "mcp__plugin_oh-my-evor_evor__evor_harden_eval",
    toolInput: Record<string, unknown> = { run_id: "r1", from_version: "v1", to_version: "v2" },
  ) {
    const dir = mkdtempSync(join(tmpdir(), "evor-harden-gov-"));
    try {
      const evorRoot = join(dir, ".evor");
      const rd = join(evorRoot, "runs", "m1", "r1");
      mkdirSync(rd, { recursive: true });
      writeFileSync(join(evorRoot, "active-run.json"), JSON.stringify({ run_id: "r1", mission_id: "m1" }));
      if (!live) writeFileSync(join(rd, "mission-state.json"), JSON.stringify({ status: "completed" }));
      writeFileSync(join(rd, "goal-contract.json"), JSON.stringify({ eval_version: "v1" }));
      const r = spawnSync(process.execPath, [PRE_TOOL_USE], {
        input: JSON.stringify({
          tool_name: tool,
          tool_input: toolInput,
          ...(agent ? { agent_type: `oh-my-evor:${agent}` } : {}),
        }),
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", EVOR_ROOT: evorRoot },
        encoding: "utf8",
        timeout: 10_000,
      });
      const last = (r.stdout ?? "").trim().split("\n").pop();
      return last ? JSON.parse(last)?.hookSpecificOutput : undefined;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("allows evor-tick", () => {
    expect(governor("evor-tick", true)?.permissionDecision).not.toBe("deny");
  });

  for (const role of ["evor-probe", "evor-sage", "evor-forge", "evor-forge-junior", "evor-mutagen", "evor-selector"]) {
    it(`denies ${role}, naming the tick as the route`, () => {
      const out = governor(role, true);
      expect(out?.permissionDecision).toBe("deny");
      expect(out?.permissionDecisionReason).toMatch(/evor-tick/);
    });
  }

  it("denies writing or sealing a version not in force, or the plugin, during a live mission", () => {
    const W = "mcp__plugin_oh-my-evor_evor__evor_write_eval_script";
    const S = "mcp__plugin_oh-my-evor_evor__evor_seal_eval_script";
    for (const agent of [null, "evor-tick", "evor-forge"]) {
      expect(governor(agent, true, W, { run_id: "r1", eval_version: "v2", source: "x" })?.permissionDecision).toBe("deny");
      expect(governor(agent, true, S, { run_id: "r1", eval_version: "v2" })?.permissionDecision).toBe("deny");
      expect(governor(agent, true, W, { run_id: "r1", eval_version: "v1", target: "score_plugin", source: "x" })?.permissionDecision).toBe("deny");
    }
    expect(governor(null, true, S, { run_id: "r1", eval_version: "v1" })?.permissionDecision).not.toBe("deny");
    expect(governor(null, false, W, { run_id: "r1", eval_version: "v2", source: "x" })?.permissionDecision, "setup is not gated").not.toBe("deny");
  });

  it("denies main during a live mission and allows it outside one", () => {
    const live = governor(null, true);
    expect(live?.permissionDecision).toBe("deny");
    expect(live?.permissionDecisionReason).toMatch(/evor-tick/);
    expect(governor(null, false)?.permissionDecision).not.toBe("deny");
  });
});
