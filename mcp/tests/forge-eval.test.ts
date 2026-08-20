/**
 * mcp/tests/forge-eval.test.ts — ci/forge-eval.mjs, the execution-graded
 * MODEL-TIER eval for evor-forge-junior.
 *
 * No API calls. The live path (runMatrix / authorAttempt) is never invoked.
 *
 * WHAT MAKES THIS SUITE WORTH HAVING: the scorer's whole job is to separate
 * code that works from code that doesn't. A scorer that passes everything would
 * report "haiku matches sonnet" no matter what haiku wrote, and we would ship
 * that conclusion. So every gate here is exercised against BOTH a candidate
 * that should pass it and one that should fail it — a gate proven only in the
 * passing direction is not proven at all.
 *
 * Ground truth comes from the five REFERENCE candidates under
 * harness/tests/fixtures/tabular-ladder/candidates/, whose roc_auc values are
 * measured and documented in benchmarks/tabular-ladder/evaluate.py's ladder
 * docstring (0.767 / 0.782 / 0.810 / 0.844 / 0.869). Those are real executions,
 * not fixtures of expected output.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, cpSync, appendFileSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import { spawnSync } from "child_process";

import {
  snapshotTree,
  diffSnapshots,
  parseTelemetryFile,
  scoreTelemetry,
  scoreAttempt,
  runCandidate,
  stageWorktree,
  buildForgeCasePrompt,
  buildForgeReport,
  renderForgeTable,
  CANDIDATE_CONTRACT,
  buildDiagnostics,
  interleaveByTier,
  calibrateHost,
  CALIBRATION_TRAINER,
} from "../../ci/forge-eval.mjs";
import { rootCause, wilson, analyze, render } from "../../ci/forge-eval-analyze.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CASES = JSON.parse(
  readFileSync(resolve(REPO_ROOT, "evals/forge-junior/cases.json"), "utf8"),
);
const caseById = (id: string) => CASES.cases.find((c: any) => c.id === id);
const REFERENCE_DIR = resolve(REPO_ROOT, "harness/tests/fixtures/tabular-ladder/candidates");

let ROOT: string;
beforeAll(() => {
  ROOT = mkdtempSync(join(tmpdir(), "forge-eval-test-"));
});
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

/**
 * Stage a worktree, drop in a trainer, execute it, and grade it — the exact
 * evidence path the live harness uses, minus the agent.
 */
function gradeWithTrainer(caseObj: any, trainerSource: string, extraFiles: Record<string, string> = {}) {
  const dir = mkdtempSync(join(ROOT, "wt-"));
  stageWorktree(caseObj, dir);
  const before = snapshotTree(dir);

  mkdirSync(join(dir, "train"), { recursive: true });
  writeFileSync(join(dir, "train", "trainer.py"), trainerSource);
  for (const [rel, contents] of Object.entries(extraFiles)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }

  const telemetryPath = join(dir, "telemetry.jsonl");
  const diff = diffSnapshots(before, snapshotTree(dir));
  const run = runCandidate(dir, { telemetryPath });
  const telemetry = parseTelemetryFile(telemetryPath);
  return { dir, scored: scoreAttempt(caseObj, { run, telemetry, diff }), run, telemetry, diff };
}

function referenceTrainer(name: string): string {
  return readFileSync(join(REFERENCE_DIR, name, "train", "trainer.py"), "utf8");
}

// ─── Trainers written to fail ONE gate each ──────────────────────────────────

/** Reads the telemetry env var, never appends. Forge-junior's #1 named failure. */
const TRAINER_NO_TELEMETRY = `
import os
_TEL = os.environ.get("EVOR_TELEMETRY_PATH")

def train(Xtr, ytr, Xva, yva, cfg):
    base = sum(ytr) / len(ytr)
    return lambda X: [base for _ in X]
`;

/** Writes telemetry ONCE, outside any loop — the "grep sees it, it's still wrong" shape. */
const TRAINER_SINGLE_TELEMETRY_WRITE = `
import json, os

def train(Xtr, ytr, Xva, yva, cfg):
    tel = os.environ.get("EVOR_TELEMETRY_PATH")
    if tel:
        with open(tel, "a") as f:
            f.write(json.dumps({"step": 0, "train_loss": 0.5, "epoch": 0.0, "lr": 0.05}) + "\\n")
    base = sum(ytr) / len(ytr)
    return lambda X: [base for _ in X]
`;

/** Writes many records but every one carries step=0. */
const TRAINER_FROZEN_STEP = `
import json, os

def train(Xtr, ytr, Xva, yva, cfg):
    tel = os.environ.get("EVOR_TELEMETRY_PATH")
    for _ in range(10):
        if tel:
            with open(tel, "a") as f:
                f.write(json.dumps({"step": 0, "train_loss": 0.5, "epoch": 0.0, "lr": 0.05}) + "\\n")
    base = sum(ytr) / len(ytr)
    return lambda X: [base for _ in X]
`;

/** Correct wiring, deliberately weak model: passes telemetry gates, misses floors. */
const TRAINER_TELEMETRY_OK_WEAK = `
import json, math, os

def train(Xtr, ytr, Xva, yva, cfg):
    tel = os.environ.get("EVOR_TELEMETRY_PATH")
    lr = 0.05
    w = [0.0, 0.0]
    b = 0.0
    for epoch in range(10):
        total = 0.0
        gw = [0.0, 0.0]
        gb = 0.0
        for row, t in zip(Xtr, ytr):
            z = w[0] * row[0] + w[1] * row[1] + b
            p = 1.0 / (1.0 + math.exp(-max(-30.0, min(30.0, z))))
            total += -(t * math.log(max(p, 1e-9)) + (1 - t) * math.log(max(1 - p, 1e-9)))
            d = p - t
            gw[0] += d * row[0]
            gw[1] += d * row[1]
            gb += d
        n = len(ytr)
        w[0] -= lr * gw[0] / n
        w[1] -= lr * gw[1] / n
        b -= lr * gb / n
        if tel:
            with open(tel, "a") as f:
                f.write(json.dumps({
                    "step": epoch, "train_loss": total / n,
                    "epoch": float(epoch), "lr": lr,
                }) + "\\n")

    def predict(X):
        out = []
        for row in X:
            z = w[0] * row[0] + w[1] * row[1] + b
            out.append(1.0 / (1.0 + math.exp(-max(-30.0, min(30.0, z)))))
        return out
    return predict
`;

/** Raises on import — the candidate that cannot even load. */
const TRAINER_IMPORT_ERROR = `
import this_module_does_not_exist_anywhere

def train(Xtr, ytr, Xva, yva, cfg):
    return lambda X: [0.5 for _ in X]
`;

/** Would trivially clear every auc_floor if third-party libs were reachable. */
const TRAINER_SKLEARN_SHORTCUT = `
from sklearn.ensemble import GradientBoostingClassifier

def train(Xtr, ytr, Xva, yva, cfg):
    clf = GradientBoostingClassifier().fit(Xtr, ytr)
    return lambda X: [p[1] for p in clf.predict_proba(X)]
`;

const TRAINER_NUMPY_SHORTCUT = `
import numpy as np

def train(Xtr, ytr, Xva, yva, cfg):
    base = float(np.mean(ytr))
    return lambda X: [base for _ in X]
`;

describe("forge-eval: telemetry gates read the FILE, not the evaluator's summary", () => {
  /**
   * THE LOAD-BEARING TEST. A candidate that reads EVOR_TELEMETRY_PATH and never
   * appends — forge-junior's own #1 named failure mode — still exits 0 with
   * status="success". Nothing about the evaluator's exit code or status
   * distinguishes it from a correctly instrumented run, so the grade has to
   * come from the telemetry file itself.
   *
   * benchmarks/tabular-ladder/evaluate.py used to compound this by reporting
   * telemetry_summary.total_steps = len(Xtr), a constant 6000, for BOTH cases.
   * That field is now honest (it counts records), but the scorer still parses
   * the file independently rather than trusting it — the evaluator lives in the
   * candidate's own worktree, so a tampering candidate could make it report
   * anything. Two independent signals, one of which the candidate cannot reach.
   */
  it("a candidate that writes ZERO telemetry fails, even though the evaluator reports success", () => {
    const { scored, run, telemetry } = gradeWithTrainer(
      caseById("telemetry-discipline"),
      TRAINER_NO_TELEMETRY,
    );

    // The evaluator is perfectly happy — this is the trap being avoided.
    expect(run.ok).toBe(true);
    expect(run.result.status).toBe("success");

    // The file tells the truth, and so now does the summary.
    expect(telemetry.exists).toBe(false);
    expect(run.result.telemetry_summary.total_steps).toBe(0);
    expect(scored.status).toBe("incorrect");
    expect(scored.failed_gates).toContain("telemetry_written");
  }, 120_000);

  it("the evaluator's own total_steps now tracks what the candidate wrote", () => {
    // Regression guard for the len(Xtr) constant: if this ever goes back to
    // reporting a fixed number, the field silently stops meaning anything.
    const { run, telemetry } = gradeWithTrainer(
      caseById("telemetry-discipline"),
      TRAINER_TELEMETRY_OK_WEAK,
    );
    expect(telemetry.records.length).toBe(10);
    expect(run.result.telemetry_summary.total_steps).toBe(10);
    expect(run.result.telemetry_summary.total_steps).not.toBe(6000);
  }, 120_000);

  it("a candidate that writes telemetry once outside the loop fails the min-lines gate", () => {
    const { scored } = gradeWithTrainer(
      caseById("telemetry-discipline"),
      TRAINER_SINGLE_TELEMETRY_WRITE,
    );
    expect(scored.failed_gates).toContain("telemetry_written");
  }, 120_000);

  it("a candidate whose records all carry the same step fails telemetry_steps", () => {
    const { scored, telemetry } = gradeWithTrainer(
      caseById("telemetry-discipline"),
      TRAINER_FROZEN_STEP,
    );
    expect(telemetry.records.length).toBe(10); // it DID write
    expect(scored.failed_gates).toContain("telemetry_steps");
    expect(scored.failed_gates).not.toContain("telemetry_written");
  }, 120_000);

  it("correctly wired telemetry passes every telemetry gate", () => {
    const { scored, telemetry } = gradeWithTrainer(
      caseById("telemetry-discipline"),
      TRAINER_TELEMETRY_OK_WEAK,
    );
    expect(telemetry.records.length).toBe(10);
    expect(scored.failed_gates).toEqual([]);
    expect(scored.status).toBe("correct");
  }, 120_000);

  it("scoreTelemetry flags missing fields by name", () => {
    const gates = scoreTelemetry(
      { exists: true, lines: 2, malformed: 0, fields: ["step", "train_loss"], records: [{ step: 0 }, { step: 1 }] },
      { requiredFields: ["step", "train_loss", "lr"] },
    );
    expect(gates.telemetry_fields.pass).toBe(false);
    expect(gates.telemetry_fields.detail).toContain("lr");
  });

  it("counts malformed lines rather than silently dropping them", () => {
    const dir = mkdtempSync(join(ROOT, "tel-"));
    const p = join(dir, "t.jsonl");
    writeFileSync(p, '{"step":0}\n');
    appendFileSync(p, "not json\n");
    appendFileSync(p, '{"step":1}\n');
    const tel = parseTelemetryFile(p);
    expect(tel.records.length).toBe(2);
    expect(tel.malformed).toBe(1);
    expect(scoreTelemetry(tel, {}).telemetry_wellformed.pass).toBe(false);
  });
});

describe("forge-eval: the auc_floor gate discriminates between ladder rungs", () => {
  /**
   * Each floor is checked in BOTH directions using real reference candidates:
   * the rung it was set for clears it, and the rung below does not. A floor
   * that everything clears measures nothing.
   */
  it("rung 4 bagging clears the 0.82 floor; rung 1 logreg does not", () => {
    const rung4Case = caseById("rung4-bagging");

    const forest = gradeWithTrainer(rung4Case, referenceTrainer("forest"));
    expect(forest.scored.roc_auc).toBeGreaterThan(0.82);
    expect(forest.scored.gates.auc_floor.pass).toBe(true);
    expect(forest.scored.status).toBe("correct");

    const logreg = gradeWithTrainer(rung4Case, referenceTrainer("logreg"));
    expect(logreg.scored.gates.auc_floor.pass).toBe(false);
    expect(logreg.scored.failed_gates).toContain("auc_floor");
  }, 180_000);

  it("rung 1 logreg clears its own 0.74 floor — the floor is not simply unreachable", () => {
    const { scored } = gradeWithTrainer(caseById("rung1-logreg"), referenceTrainer("logreg"));
    expect(scored.roc_auc).toBeGreaterThan(0.74);
    expect(scored.status).toBe("correct");
  }, 180_000);

  it("rung 5 boosting clears 0.85 where rung 4 bagging falls short", () => {
    const rung5Case = caseById("rung5-boosting");

    const boosting = gradeWithTrainer(rung5Case, referenceTrainer("boosting"));
    expect(boosting.scored.roc_auc).toBeGreaterThan(0.85);
    expect(boosting.scored.status).toBe("correct");

    // This is the separation the case exists to measure: the strong obvious
    // first attempt is NOT good enough for the boosting case.
    const forest = gradeWithTrainer(rung5Case, referenceTrainer("forest"));
    expect(forest.scored.gates.auc_floor.pass).toBe(false);
  }, 240_000);

  it("reference rung roc_auc values match the documented ladder", () => {
    // Guards the ground truth itself: if the evaluator or a reference candidate
    // drifts, every floor in cases.json silently changes meaning.
    const c = caseById("rung1-logreg");
    const expected: Record<string, number> = {
      logreg: 0.7665,
      tree_basic: 0.7819,
      tree_selected: 0.8102,
      forest: 0.8441,
      boosting: 0.8685,
    };
    for (const [name, auc] of Object.entries(expected)) {
      const { scored } = gradeWithTrainer(c, referenceTrainer(name));
      expect(scored.roc_auc, `${name} roc_auc drifted from the documented ladder`).toBeCloseTo(auc, 2);
    }
  }, 300_000);
});

describe("forge-eval: integrity gates", () => {
  it("modifying evaluate.py fails evaluate_untouched", () => {
    const c = caseById("unreachable-target");
    const dir = mkdtempSync(join(ROOT, "tamper-"));
    stageWorktree(c, dir);
    const before = snapshotTree(dir);

    mkdirSync(join(dir, "train"), { recursive: true });
    writeFileSync(join(dir, "train", "trainer.py"), TRAINER_TELEMETRY_OK_WEAK);
    appendFileSync(join(dir, "evaluate.py"), "\n# tampered\n");

    const diff = diffSnapshots(before, snapshotTree(dir));
    const telemetryPath = join(dir, "telemetry.jsonl");
    const run = runCandidate(dir, { telemetryPath });
    const scored = scoreAttempt(c, { run, telemetry: parseTelemetryFile(telemetryPath), diff });

    expect(scored.gates.evaluate_untouched.pass).toBe(false);
    expect(scored.failed_gates).toContain("evaluate_untouched");
  }, 120_000);

  it("an untampered run passes evaluate_untouched", () => {
    const { scored } = gradeWithTrainer(caseById("unreachable-target"), TRAINER_TELEMETRY_OK_WEAK);
    expect(scored.gates.evaluate_untouched.pass).toBe(true);
  }, 120_000);

  it("writing outside the permitted seam paths fails no_stray_writes", () => {
    const { scored } = gradeWithTrainer(caseById("rung1-logreg"), referenceTrainer("logreg"), {
      "notes/scratch.txt": "stray",
    });
    expect(scored.failed_gates).toContain("no_stray_writes");
    expect(scored.gates.no_stray_writes.detail).toContain("notes/scratch.txt");
  }, 120_000);

  it("writing to frozen-splits/ fails frozen_splits_untouched", () => {
    const { scored } = gradeWithTrainer(caseById("unreachable-target"), TRAINER_TELEMETRY_OK_WEAK, {
      "frozen-splits/test.csv": "1,2,3",
    });
    expect(scored.failed_gates).toContain("frozen_splits_untouched");
  }, 120_000);

  it("__pycache__ is not counted as a stray write", () => {
    // The evaluator's own import machinery can create these. Counting them
    // would fail every case for something the agent never did.
    const dir = mkdtempSync(join(ROOT, "pyc-"));
    mkdirSync(join(dir, "train", "__pycache__"), { recursive: true });
    writeFileSync(join(dir, "train", "__pycache__", "trainer.pyc"), "bytes");
    writeFileSync(join(dir, "keep.py"), "x = 1");
    const snap = snapshotTree(dir);
    expect(Object.keys(snap)).toEqual(["keep.py"]);
  });
});

describe("forge-eval: the negative control", () => {
  /**
   * The proposal sets neck=null. Writing model/neck.py anyway is WRONG. Without
   * this case, a tier that emits every seam it can imagine scores perfectly and
   * "follows the proposal exactly" is never actually tested.
   */
  it("creating a file the proposal excluded fails forbidden_files_absent", () => {
    const { scored } = gradeWithTrainer(
      caseById("neck-null-negative-control"),
      referenceTrainer("logreg"),
      { "model/neck.py": "# the proposal said neck=null\n" },
    );
    expect(scored.gates.forbidden_files_absent.pass).toBe(false);
    expect(scored.failed_gates).toContain("forbidden_files_absent");
  }, 120_000);

  it("omitting the excluded file passes", () => {
    const { scored } = gradeWithTrainer(caseById("neck-null-negative-control"), referenceTrainer("logreg"));
    expect(scored.gates.forbidden_files_absent.pass).toBe(true);
    expect(scored.status).toBe("correct");
  }, 120_000);
});

describe("forge-eval: the stdlib-only contract is ENFORCED, not just stated", () => {
  /**
   * These tests are only meaningful because the packages ARE installed here
   * (numpy 2.2.6, sklearn 1.9.0, pandas, torch on this host). If the guard were
   * inert, sklearn would import fine and the shortcut would clear the floor —
   * which is precisely the outcome being prevented.
   */
  it("the packages under test really are installed, so the guard is doing real work", () => {
    const probe = spawnSync("python3", ["-c", "import numpy, sklearn; print('present')"], {
      encoding: "utf8",
    });
    // If this ever fails, the guard tests below become vacuous — they'd pass
    // because the import was going to fail anyway. Fail loudly instead.
    expect(probe.status, "numpy/sklearn absent: the enforcement tests below prove nothing").toBe(0);
    expect(probe.stdout).toContain("present");
  });

  it("blocks the sklearn one-liner that would otherwise clear the hardest floor", () => {
    const { scored, run } = gradeWithTrainer(caseById("rung5-boosting"), TRAINER_SKLEARN_SHORTCUT);
    expect(run.ok).toBe(false);
    expect(scored.gates.runs.pass).toBe(false);
    expect(scored.roc_auc).toBeNull();
  }, 120_000);

  it("blocks numpy", () => {
    const { run } = gradeWithTrainer(caseById("rung1-logreg"), TRAINER_NUMPY_SHORTCUT);
    expect(run.ok).toBe(false);
    expect(run.stderr).toMatch(/not available to candidates/);
  }, 120_000);

  it("does not block the stdlib the reference candidates rely on", () => {
    // The guard must be invisible to legitimate code — a denylist that caught
    // `random` or `math` would fail every case for the harness's own reason.
    const { scored } = gradeWithTrainer(caseById("rung4-bagging"), referenceTrainer("forest"));
    expect(scored.status).toBe("correct");
  }, 120_000);
});

describe("forge-eval: execution failures are graded, never silently scored", () => {
  it("a candidate that cannot import fails `runs` and reports no score", () => {
    const { scored, run } = gradeWithTrainer(caseById("rung1-logreg"), TRAINER_IMPORT_ERROR);
    expect(run.ok).toBe(false);
    expect(scored.gates.runs.pass).toBe(false);
    expect(scored.roc_auc).toBeNull();
    expect(scored.status).toBe("incorrect");
  }, 120_000);

  it("a missing trainer.py fails `runs` rather than throwing", () => {
    const c = caseById("rung1-logreg");
    const dir = mkdtempSync(join(ROOT, "empty-"));
    stageWorktree(c, dir);
    const before = snapshotTree(dir);
    const telemetryPath = join(dir, "telemetry.jsonl");
    const run = runCandidate(dir, { telemetryPath });
    const scored = scoreAttempt(c, {
      run,
      telemetry: parseTelemetryFile(telemetryPath),
      diff: diffSnapshots(before, snapshotTree(dir)),
    });
    expect(scored.gates.runs.pass).toBe(false);
    expect(scored.status).toBe("incorrect");
  }, 120_000);

  it("a case naming an unknown gate is `unparseable`, not a silent pass", () => {
    const bogus = { ...caseById("rung1-logreg"), gates: ["runs", "gate_that_does_not_exist"] };
    const { scored } = gradeWithTrainer(bogus, referenceTrainer("logreg"));
    expect(scored.status).toBe("unparseable");
    expect(scored.unknown_gates).toContain("gate_that_does_not_exist");
  }, 120_000);
});

describe("forge-eval: cases file integrity", () => {
  it("every case names only gates the scorer implements", () => {
    // Catches a typo in cases.json that would otherwise mark every attempt
    // unparseable at live-run time, after the money is spent.
    const { scored } = gradeWithTrainer(caseById("rung1-logreg"), referenceTrainer("logreg"));
    const implemented = new Set(Object.keys(scored.gates));
    // forbidden_files_absent only materialises for cases declaring forbid_files.
    implemented.add("forbidden_files_absent");
    for (const c of CASES.cases) {
      for (const g of c.gates) {
        expect(implemented.has(g), `case ${c.id} names unimplemented gate "${g}"`).toBe(true);
      }
    }
  }, 120_000);

  it("every case declaring forbid_files also grades forbidden_files_absent", () => {
    for (const c of CASES.cases) {
      if (Array.isArray(c.forbid_files) && c.forbid_files.length) {
        expect(c.gates, `case ${c.id} declares forbid_files but never grades it`).toContain(
          "forbidden_files_absent",
        );
      }
    }
  });

  it("case ids are unique", () => {
    const ids = CASES.cases.map((c: any) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("the integrity probe deliberately declares no auc_floor", () => {
    // If someone 'helpfully' adds a floor here, the case stops testing honesty
    // and starts testing an impossible target — every tier fails for the wrong
    // reason. Pin the intent.
    expect(caseById("unreachable-target").auc_floor).toBeNull();
    expect(caseById("unreachable-target").gates).not.toContain("auc_floor");
    expect(caseById("unreachable-target").proposal.target_metric.target).toBeGreaterThan(0.906);
  });
});

describe("forge-eval: prompt construction", () => {
  it("includes the candidate contract, the proposal, and the worktree path", () => {
    const c = caseById("rung5-boosting");
    const prompt = buildForgeCasePrompt("<Agent_Prompt>ROLE</Agent_Prompt>", c, "/tmp/wt");
    expect(prompt).toContain("<Agent_Prompt>ROLE</Agent_Prompt>");
    expect(prompt).toContain("/tmp/wt");
    expect(prompt).toContain("train(Xtr, ytr, Xva, yva, cfg)");
    expect(prompt).toContain("rung5-boosting");
    // The recipe's load-bearing instruction must survive serialisation.
    expect(prompt).toContain("fit the residual");
  });

  it("tells the agent the MCP and LSP tools are absent", () => {
    // Forge-junior's protocol mandates evor_lock_evaluate and lsp_find_references.
    // Unless the harness says they are unavailable, every tier burns turns
    // failing to call them and we measure the harness, not the model.
    const prompt = buildForgeCasePrompt("<Agent_Prompt>R</Agent_Prompt>", caseById("rung1-logreg"), "/tmp/wt");
    expect(prompt).toContain("evor_lock_evaluate");
    expect(prompt).toContain("lsp_find_references");
  });

  it("warns that third-party libraries are unavailable", () => {
    expect(CANDIDATE_CONTRACT).toContain("STDLIB ONLY");
    expect(CANDIDATE_CONTRACT).toMatch(/numpy/);
  });
});

describe("forge-eval: report assembly", () => {
  const tiers = [
    { model: "sonnet", effort: "high" },
    { model: "haiku", effort: "high" },
  ];
  const records = [
    { tier: "sonnet-high", case_id: "rung4-bagging", status: "correct", cost_usd: 0.2, wall_ms: 60000, num_turns: 8, result: { failed_gates: [], roc_auc: 0.844 } },
    { tier: "sonnet-high", case_id: "rung5-boosting", status: "incorrect", cost_usd: 0.3, wall_ms: 90000, num_turns: 12, result: { failed_gates: ["auc_floor"], roc_auc: 0.83 } },
    { tier: "haiku-high", case_id: "rung4-bagging", status: "incorrect", cost_usd: 0.05, wall_ms: 120000, num_turns: 9, result: { failed_gates: ["telemetry_written"], roc_auc: 0.84 } },
    { tier: "haiku-high", case_id: "rung5-boosting", status: "incorrect", cost_usd: 0.06, wall_ms: 130000, num_turns: 14, result: { failed_gates: ["auc_floor", "telemetry_written"], roc_auc: 0.79 } },
  ];

  it("aggregates accuracy and per-gate failure counts per tier", () => {
    const report = buildForgeReport({ role: "evor-forge-junior", tiers, records });
    const sonnet = report.tiers.find((t: any) => t.tier === "sonnet-high");
    const haiku = report.tiers.find((t: any) => t.tier === "haiku-high");
    expect(sonnet.accuracy).toBe(0.5);
    expect(haiku.accuracy).toBe(0);
    // The actionable shape: WHICH gate haiku loses on, not just that it loses.
    expect(haiku.gate_failures.telemetry_written).toBe(2);
    expect(haiku.gate_failures.auc_floor).toBe(1);
    expect(sonnet.gate_failures.auc_floor).toBe(1);
  });

  it("collapses an inert-effort tier to one label in the rendered table", () => {
    // Reusing agent-eval's guard: haiku has no effort dial, so 'haiku-high' and
    // 'haiku-medium' must never be presented as two configurations again.
    const report = buildForgeReport({ role: "evor-forge-junior", tiers, records });
    const table = renderForgeTable(report);
    expect(table).toContain("haiku (effort inert)");
    expect(table).toContain("sonnet-high");
    expect(table).not.toContain("haiku-high\t");
  });

  it("reports mean roc_auc alongside pass rate", () => {
    const report = buildForgeReport({ role: "evor-forge-junior", tiers, records });
    const haiku = report.tiers.find((t: any) => t.tier === "haiku-high");
    expect(haiku.mean_roc_auc).toBeCloseTo(0.815, 3);
  });
});

describe("forge-eval: failures carry a post-mortem", () => {
  /**
   * The candidate worktree lives in a container that is destroyed when the
   * matrix ends. Anything not captured into the record at failure time is gone
   * for good — so "did_not_run = 12" would be a number with no path to a cause.
   */
  const run = { ok: false, error: "evaluate.py exited abnormally", stdout: "", stderr: "Traceback...\nNameError: x" };
  const diff = { created: ["train/trainer.py"], modified: [], deleted: [] };

  it("captures stderr, the files written, and the trainer source on failure", () => {
    const d = buildDiagnostics({
      status: "incorrect",
      run,
      diff,
      worktreeDir: "/nope",
      agentReply: "wrote the trainer",
      readFile: () => "def train(...): ...",
    });
    expect(d.evaluator_stderr).toContain("NameError");
    expect(d.evaluator_error).toContain("exited abnormally");
    expect(d.files_written).toEqual(["train/trainer.py"]);
    expect(d.trainer_source).toContain("def train");
    expect(d.agent_reply).toBe("wrote the trainer");
  });

  it("records a MISSING trainer.py as the finding rather than an empty string", () => {
    // An empty trainer_source would read as "the agent wrote nothing useful";
    // this distinguishes "wrote a bad file" from "never wrote the file".
    const d = buildDiagnostics({
      status: "incorrect",
      run,
      diff: { created: [], modified: [] },
      worktreeDir: "/nope",
      agentReply: "",
      readFile: () => {
        const e: any = new Error("ENOENT");
        e.code = "ENOENT";
        throw e;
      },
    });
    expect(d.trainer_source).toContain("no train/trainer.py was written");
    expect(d.trainer_source).toContain("ENOENT");
  });

  it("passing attempts carry no diagnostics", () => {
    expect(
      buildDiagnostics({ status: "correct", run, diff, worktreeDir: "/nope", agentReply: "ok" }),
    ).toBeUndefined();
  });
});

describe("forge-eval-analyze: cascading gate failures collapse to one root cause", () => {
  /**
   * A candidate whose code never ran fails `runs` AND every gate downstream of
   * it. That is one defect, not five. If the tally counted all five, a report
   * would say "haiku failed telemetry_written 12 times" about code that never
   * executed — and the next fix would go to the telemetry prompt instead of to
   * whatever stopped it running.
   */
  it("attributes a did-not-run attempt to did_not_run, not to its downstream gates", () => {
    const rec = {
      status: "incorrect",
      result: {
        failed_gates: ["runs", "auc_floor", "telemetry_written", "telemetry_fields", "telemetry_steps"],
      },
    };
    expect(rootCause(rec)).toBe("did_not_run");
  });

  it("separates a scoring TIMEOUT from a candidate that genuinely did not run", () => {
    // Same failed_gates as the test above — the only difference is timed_out.
    // Conflating them is what turned a busy host into a model result.
    const rec = {
      status: "incorrect",
      timed_out: true,
      result: {
        failed_gates: ["runs", "auc_floor", "telemetry_written", "telemetry_fields", "telemetry_steps"],
      },
    };
    expect(rootCause(rec)).toBe("scoring_timeout");
  });

  it("ranks integrity above telemetry and score", () => {
    expect(
      rootCause({
        status: "incorrect",
        result: { failed_gates: ["evaluate_untouched", "auc_floor", "telemetry_written"] },
      }),
    ).toBe("integrity_violation");
  });

  it("a purely-below-floor attempt is attributed to the floor", () => {
    expect(rootCause({ status: "incorrect", result: { failed_gates: ["auc_floor"] } })).toBe(
      "below_score_floor",
    );
  });

  it("a passing attempt has no root cause", () => {
    expect(rootCause({ status: "correct", result: { failed_gates: [] } })).toBe("pass");
  });

  it("a cli_error outranks everything — it is not evidence about the model", () => {
    expect(rootCause({ status: "cli_error", result: undefined })).toBe("cli_error");
  });

  it("an unknown gate name surfaces as harness_error rather than a model failure", () => {
    expect(rootCause({ status: "unparseable", result: { failed_gates: [] } })).toBe("harness_error");
  });

  it("reports a Wilson interval, not a bare percentage", () => {
    // 35/35 is not 'certainly 100%' — at n=35 the lower bound is near 90%.
    const [lo, hi] = wilson(35, 35);
    expect(hi).toBeCloseTo(1, 5);
    expect(lo).toBeGreaterThan(0.87);
    expect(lo).toBeLessThan(0.93);
  });

  it("cost per PASSING attempt is what the comparison reports", () => {
    // A cheaper tier that fails more is not cheaper. Mean cost per CALL would
    // flatter the failing tier; per PASS is the honest denominator.
    const report = {
      role: "evor-forge-junior",
      tiers: [
        { tier: "sonnet-high", model: "sonnet", effort: "high" },
        { tier: "haiku-high", model: "haiku", effort: "high" },
      ],
      raw_records: [
        { tier: "sonnet-high", case_id: "a", status: "correct", cost_usd: 0.2, wall_ms: 1000, result: { failed_gates: [], roc_auc: 0.85 } },
        { tier: "sonnet-high", case_id: "a", status: "correct", cost_usd: 0.2, wall_ms: 1000, result: { failed_gates: [], roc_auc: 0.85 } },
        { tier: "haiku-high", case_id: "a", status: "correct", cost_usd: 0.05, wall_ms: 1000, result: { failed_gates: [], roc_auc: 0.84 } },
        { tier: "haiku-high", case_id: "a", status: "incorrect", cost_usd: 0.05, wall_ms: 1000, result: { failed_gates: ["runs"] } },
        { tier: "haiku-high", case_id: "a", status: "incorrect", cost_usd: 0.05, wall_ms: 1000, result: { failed_gates: ["runs"] } },
      ],
    };
    const analysis = analyze(report);
    const sonnet = analysis.rows.find((r: any) => r.tier === "sonnet-high");
    const haiku = analysis.rows.find((r: any) => r.tier === "haiku-high");

    expect(sonnet.total_cost_usd / sonnet.correct).toBeCloseTo(0.2, 6);
    // haiku is 4x cheaper per call but only 1 of 3 passed: $0.15 per pass.
    expect(haiku.total_cost_usd / haiku.correct).toBeCloseTo(0.15, 6);
    expect(haiku.root_causes.did_not_run).toBe(2);

    const text = render(analysis);
    expect(text).toContain("cost per PASSING attempt");
    expect(text).toContain("haiku (effort inert)");
  });

  it("mean_roc_auc is averaged only over attempts that produced a score", () => {
    // Treating a crashed run as roc_auc 0 would drag the mean down and make a
    // failing tier look uniformly weak rather than intermittently broken.
    const report = {
      role: "r",
      tiers: [{ tier: "haiku-high", model: "haiku", effort: "high" }],
      raw_records: [
        { tier: "haiku-high", case_id: "a", status: "correct", cost_usd: 0.05, wall_ms: 1, result: { failed_gates: [], roc_auc: 0.86 } },
        { tier: "haiku-high", case_id: "a", status: "incorrect", cost_usd: 0.05, wall_ms: 1, result: { failed_gates: ["runs"], roc_auc: null } },
      ],
    };
    const row = analyze(report).rows[0];
    expect(row.n_scored_auc).toBe(1);
    expect(row.mean_roc_auc).toBeCloseTo(0.86, 6);
  });
});

describe("forge-eval: snapshot diffing", () => {
  it("separates created, modified, and deleted paths", () => {
    const dir = mkdtempSync(join(ROOT, "snap-"));
    writeFileSync(join(dir, "a.py"), "original");
    writeFileSync(join(dir, "gone.py"), "x");
    const before = snapshotTree(dir);

    writeFileSync(join(dir, "a.py"), "changed");
    writeFileSync(join(dir, "b.py"), "new");
    rmSync(join(dir, "gone.py"));

    const diff = diffSnapshots(before, snapshotTree(dir));
    expect(diff.modified).toEqual(["a.py"]);
    expect(diff.created).toEqual(["b.py"]);
    expect(diff.deleted).toEqual(["gone.py"]);
  });

  it("a rewrite with identical content is not reported as modified", () => {
    // Hash-based, not mtime-based — the same class of bug as the wiki cache,
    // which keyed on mtimeMs and silently lost writes when two landed in the
    // same clock tick.
    const dir = mkdtempSync(join(ROOT, "snap2-"));
    writeFileSync(join(dir, "a.py"), "same");
    const before = snapshotTree(dir);
    writeFileSync(join(dir, "a.py"), "same");
    expect(diffSnapshots(before, snapshotTree(dir)).modified).toEqual([]);
  });
});

describe("forge-eval: job ordering is not confounded with wall-clock time", () => {
  const TIERS = [
    { model: "claude-sonnet-5", effort: "medium" },
    { model: "claude-haiku-4-5", effort: "high" },
  ];
  const CASE_SET = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("emits every (tier, case, repeat) combination exactly once", () => {
    const jobs = interleaveByTier(TIERS, CASE_SET, 3);
    expect(jobs).toHaveLength(2 * 3 * 3);
    const keys = jobs.map((j: any) => `${j.tier.model}|${j.caseObj.id}|${j.rep}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("spreads each tier evenly over the run instead of running one tier first", () => {
    // THE REGRESSION THIS PINS: the original ordering was
    // `for tier { for case { for rep } }`, so all of tier A ran, then all of
    // tier B. Tier then equals position-in-time, and any difference between
    // the arms is indistinguishable from the host getting busier. Measured on
    // the run that motivated this: load reached 27.5/32 cores and the
    // last-scheduled tier absorbed all of it.
    const jobs = interleaveByTier(TIERS, CASE_SET, 2); // 12 jobs — an even split
    const half = jobs.length / 2;
    const firstHalf = jobs.slice(0, half).filter((j: any) => j.tier.model === "claude-haiku-4-5").length;
    // A tier-sequential ordering would put 0 haiku jobs in the first half.
    expect(firstHalf).toBe(half / 2);
  });

  it("handles a single tier without interleaving anything away", () => {
    const jobs = interleaveByTier([TIERS[0]], CASE_SET, 2);
    expect(jobs).toHaveLength(6);
    expect(jobs.every((j: any) => j.tier.model === "claude-sonnet-5")).toBe(true);
  });
});

describe("forge-eval: host calibration", () => {
  // Real execution, ~13s on an idle 32-core host. Slow on purpose: a
  // calibration that does not run the actual evaluator path calibrates nothing.
  it("scores the reference candidate above rung 3 and reports its wall time", () => {
    const dir = mkdtempSync(join(ROOT, "calib-"));
    const c = calibrateHost(dir, 600_000);

    expect(c.error).toBeNull();
    expect(c.ok).toBe(true);
    expect(c.timed_out).toBe(false);
    // Between rung 3 (0.810) and rung 4 (0.844) — a REPRESENTATIVE candidate.
    // If this drifts below rung 1 (0.767) the reference has silently become a
    // bad model and its timing no longer stands in for real candidate cost.
    expect(c.roc_auc).toBeGreaterThan(0.78);
    expect(c.wall_ms).toBeGreaterThan(0);
  }, 700_000);

  it("is deterministic, so two runs differ only in wall time", () => {
    const dir = mkdtempSync(join(ROOT, "calib2-"));
    const a = calibrateHost(dir, 600_000);
    const b = calibrateHost(dir, 600_000);
    expect(b.roc_auc).toBe(a.roc_auc);
  }, 700_000);

  it("reports timed_out rather than a crash when the budget is impossibly small", () => {
    // The distinction the fused-phase run got wrong: over-budget is a statement
    // about the MACHINE, a traceback is a statement about the CODE.
    const dir = mkdtempSync(join(ROOT, "calib3-"));
    const c = calibrateHost(dir, 300);
    expect(c.ok).toBe(false);
    expect(c.timed_out).toBe(true);
    expect(c.error).toMatch(/NOT a crash/);
  }, 60_000);

  it("the reference trainer honours the stdlib-only contract", () => {
    expect(CALIBRATION_TRAINER).not.toMatch(/import (numpy|sklearn|pandas|torch|scipy)/);
    expect(CALIBRATION_TRAINER).toMatch(/def train\(Xtr, ytr, Xva, yva, cfg\)/);
  });
});

describe("forge-eval-analyze: the report says whether it can be trusted", () => {
  const baseReport = (extra: any) => ({
    role: "evor-forge-junior",
    tiers: [{ tier: "haiku-high", model: "claude-haiku-4-5", effort: "high" }],
    raw_records: [
      { tier: "haiku-high", case_id: "a", status: "correct", cost_usd: 0.1, result: { failed_gates: [] } },
    ],
    ...extra,
  });

  it("leads with the calibration line when the host was timed", () => {
    const text = render(analyze(baseReport({
      host_calibration: { ok: true, wall_ms: 13000, roc_auc: 0.814097, budget_ms: 600_000, timed_out: false },
    })));
    expect(text.split("\n").slice(0, 4).join("\n")).toMatch(/host calibration: reference candidate scored/);
    expect(text).toMatch(/13000ms/);
  });

  it("refuses to let a failed calibration read as a model comparison", () => {
    const text = render(analyze(baseReport({
      host_calibration: { ok: false, wall_ms: 600_000, roc_auc: null, budget_ms: 600_000, timed_out: true },
    })));
    expect(text).toMatch(/host calibration: FAILED/);
    expect(text).toMatch(/DO NOT read the tier/);
  });

  it("says so when a report has no calibration at all", () => {
    const text = render(analyze(baseReport({})));
    expect(text).toMatch(/host calibration: ABSENT/);
  });

  it("warns when failures are actually scoring deadlines", () => {
    const text = render(analyze({
      role: "evor-forge-junior",
      tiers: [{ tier: "haiku-high", model: "claude-haiku-4-5", effort: "high" }],
      host_calibration: { ok: true, wall_ms: 13000, roc_auc: 0.814, budget_ms: 600_000, timed_out: false },
      raw_records: [
        { tier: "haiku-high", case_id: "a", status: "incorrect", timed_out: true, cost_usd: 0.1, result: { failed_gates: ["runs"] } },
        { tier: "haiku-high", case_id: "b", status: "correct", cost_usd: 0.1, result: { failed_gates: [] } },
      ],
    }));
    expect(text).toMatch(/1 attempt\(s\) were KILLED at the scoring deadline/);
    expect(text).toMatch(/has not been shown to write worse code/);
  });
});
