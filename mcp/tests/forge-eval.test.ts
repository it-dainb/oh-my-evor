/**
 * mcp/tests/forge-eval.test.ts — ci/forge-eval.mjs, the execution-graded
 * MODEL-TIER eval for evor-forge-junior.
 *
 * No API calls. The live path (runMatrix / runOneAttempt) is never invoked.
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
} from "../../ci/forge-eval.mjs";

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
   * THE LOAD-BEARING TEST. benchmarks/tabular-ladder/evaluate.py:305 reports
   * telemetry_summary.total_steps = len(Xtr) — a constant 6000 — regardless of
   * whether the candidate wrote any telemetry at all. If the scorer trusted
   * that field, this gate would pass the exact failure mode it exists to catch.
   */
  it("a candidate that writes ZERO telemetry fails, even though the evaluator reports success and a nonzero total_steps", () => {
    const { scored, run, telemetry } = gradeWithTrainer(
      caseById("telemetry-discipline"),
      TRAINER_NO_TELEMETRY,
    );

    // The evaluator is perfectly happy — this is the trap being avoided.
    expect(run.ok).toBe(true);
    expect(run.result.status).toBe("success");
    expect(run.result.telemetry_summary.total_steps).toBeGreaterThan(0);

    // The file tells the truth.
    expect(telemetry.exists).toBe(false);
    expect(scored.status).toBe("incorrect");
    expect(scored.failed_gates).toContain("telemetry_written");
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
