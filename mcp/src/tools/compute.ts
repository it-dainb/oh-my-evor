/**
 * tools/compute.ts
 * Compute-wrapper MCP tools (WS-B): async training-job launcher + sync harness wrappers.
 *
 * evor_run_start       — launch `python -m evor run` detached (EVALUATION of an already-trained
 *                         candidate, not training); returns {status, job_id} instantly
 * evor_run_status      — read job status (no internal paths or cmd exposed)
 * evor_capability      — probe hardware (wraps `evor capability`)
 * evor_preflight       — smoke-test environment (wraps `evor preflight`)
 * evor_validate        — validate run configuration and split integrity
 * evor_doctor          — environment + .evor integrity (wraps `evor doctor`)
 * evor_freeze_splits   — freeze test/val splits (wraps `evor.freeze freeze-splits`)
 * evor_init_eval_suite    — create initial evaluation suite (wraps `evor.benchmark init-eval-suite`)
 * evor_seal_eval_script   — hash the canonical evaluator and lock its sha256 into goal-contract.json
 * evor_harden_eval        — replace the evaluator with a stricter one under a new eval_version
 * evor_meta_evolve        — update strategy.json (wraps `evor.tree meta-evolve`)
 * evor_distill_scan    — brownfield workspace scan (wraps `evor distill scan`)
 * evor_plot_report     — render tree png/html (wraps `evor.plot_tree`)
 * evor_wiki_summarize  — summarise wiki lessons by family/verdict (wraps `evor.wiki summarize`)
 * evor_gotchas_list    — list accumulated gotchas (wraps `evor gotchas`)
 */

import { appendFileSync, chmodSync, existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { basename, join } from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveRunPaths, getEvorRoot, getActiveRunPath } from "../run-store.js";
import { callPythonModule, type PyResult } from "../subprocess-bridge.js";
import { resolveNodeRef, tryResolveNodeRef } from "./node-ref.js";
import { resolveRunId } from "../active-run.js";
import { evalVersionCache } from "./integrity.js";
// Same module the SubagentStop hook imports — one owner for "what does this tick owe".
import { owed, selectedProposals } from "../../../hooks/lib/tick-completeness.mjs";
import { nextState } from "../fsm.js";

// ── Shared helpers ────────────────────────────────────────────────────────────

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function err(msg: string) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: msg }) }] };
}

// ── Core functions (exported for tests) ──────────────────────────────────────

/**
 * Spawn `python -m evor run …` detached via evor.jobs.  Returns {job_id, status_path,
 * log_path} from the jobs start script instantly — the training run itself continues
 * in the background; use evor_run_status to poll it.
 */
export function jobStart(
  nodeId: string,
  runId: string,
  runDir: string,
  worktree: string,
  evalVersion?: string,
  env?: Record<string, string>,
): PyResult {
  const python = process.env.EVOR_PYTHON ?? "python3";
  const cmdArgs: string[] = [
    python, "-m", "evor", "run",
    "--node-id", nodeId,
    "--run-id", runId,
    "--worktree", worktree,
    "--run-dir", runDir,
  ];
  if (evalVersion) cmdArgs.push("--eval-version", evalVersion);

  return callPythonModule("evor.jobs", [
    "start",
    "--run-dir", runDir,
    "--cmd-json", JSON.stringify(cmdArgs),
  ], { extraEnv: env });
}

/**
 * Read jobs/<job_id>/status.json (+ last log lines as tail).
 */
export function jobStatus(jobId: string, runDir: string): PyResult {
  return callPythonModule("evor.jobs", [
    "status",
    "--job-id", jobId,
    "--run-dir", runDir,
  ]);
}

/**
 * Validate run configuration and split integrity.
 */
export function validateRun(runDir: string): PyResult {
  return callPythonModule("evor", [
    "validate",
    "--run-id", runDir,
  ], { timeout: 30_000 });
}

/**
 * Check environment + .evor integrity; optionally repair list-format tree.json.
 */
export function doctorRun(runDir?: string, repair?: boolean): PyResult {
  const args = ["doctor"];
  if (runDir) args.push("--run-id", runDir);
  if (repair) args.push("--repair");
  return callPythonModule("evor", args, { timeout: 60_000 });
}

/**
 * Run the preflight suite.
 *
 * mode="full" (default): 5-step micro-train smoke-test + GPU/import checks.
 * mode="env_only" (P1-9): checks imports + env only — fast, no GPU needed.
 */
export function preflightRun(
  runId: string,
  runDir: string,
  noGpuCheck?: boolean,
  mode?: "full" | "env_only",
): PyResult {
  const args = ["preflight", "--run-id", runId, "--run-dir", runDir];
  if (noGpuCheck) args.push("--no-gpu-check");
  if (mode) args.push("--mode", mode);
  return callPythonModule("evor", args, { timeout: 120_000 });
}

/**
 * Freeze test and val splits from a dataset directory.
 */
export function freezeSplits(
  datasetPath: string,
  evalVersion: string,
  runDir: string,
  missionId?: string,
): PyResult {
  const args = [
    "freeze-splits",
    "--dataset-path", datasetPath,
    "--eval-version", evalVersion,
    "--run-dir", runDir,
  ];
  if (missionId) args.push("--mission-id", missionId);
  return callPythonModule("evor.freeze", args, { timeout: 600_000 });
}

/**
 * Create the initial EvalSuite v1.
 */
export function initEvalSuite(
  missionId: string,
  evalVersion: string,
  taskDescription: string,
  runDir: string,
): PyResult {
  return callPythonModule("evor.benchmark", [
    "init-eval-suite",
    "--mission-id", missionId,
    "--eval-version", evalVersion,
    "--task-description", taskDescription,
    "--run-dir", runDir,
  ], { timeout: 600_000 });
}

/**
 * Run TreeEngine.meta_evolve — update strategy.json from current frontier.
 */
export function metaEvolve(runDir: string): PyResult {
  return callPythonModule("evor.tree", [
    "meta-evolve",
    "--run-id", runDir,
  ], { timeout: 60_000 });
}

/**
 * Deep-scan a workspace for brownfield onboarding.
 */
export function distillScan(path: string, evorRoot?: string): PyResult {
  const args = ["distill", "scan", "--root", path, "--json"];
  if (evorRoot) args.push("--evor-root", evorRoot);
  return callPythonModule("evor", args, { timeout: 300_000 });
}

/**
 * Dispatch multiple candidate EVALUATION jobs in parallel to the compute backend.
 * Returns job results for all candidates immediately without blocking — each
 * job is started via jobStart (evor.jobs start), which spawns a detached
 * supervisor and returns instantly. Poll each with evor_run_status.
 * Use instead of sequential evor_run_start calls when VRAM allows parallel
 * evaluation (P0-3).
 *
 * NOT training, despite the historical name of this symbol: jobStart runs
 * `python -m evor run`, whose subcommand help is "Run evaluation for a candidate
 * node" and whose `_cmd_run` executes `worktree/evaluate.py`. Candidates must be
 * trained before they get here.
 */
export interface BatchCandidate {
  node_id: string;
  worktree: string;
  eval_version?: string;
}

export interface BatchDispatchResult {
  node_id: string;
  ok: boolean;
  job_id: string | null;
  error: string | null;
}

export interface ForgeDispatchBatchResult {
  run_id: string;
  gpu_fraction: number;
  dispatched: BatchDispatchResult[];
}

export function forgeDispatchBatch(
  runId: string,
  candidates: BatchCandidate[],
  runDir: string,
  gpuFraction?: number,
): ForgeDispatchBatchResult {
  const n = candidates.length;
  // Auto-compute gpu_fraction: split evenly, cap at 1.0 per job
  const fraction = gpuFraction ?? Math.min(1.0, 1.0 / n);

  const dispatched: BatchDispatchResult[] = [];
  for (const c of candidates) {
    // Inject EVOR_GPU_FRACTION so the training subprocess knows its VRAM budget.
    // _child_env() in jobs.py propagates os.environ → supervisor → training child,
    // so setting it here means the actual torch/training process sees it.
    const res = jobStart(c.node_id, runId, runDir, c.worktree, c.eval_version, {
      EVOR_GPU_FRACTION: String(fraction),
    });
    const jobData = res.data as Record<string, unknown> | undefined;
    dispatched.push({
      node_id: c.node_id,
      ok: res.ok,
      job_id: typeof jobData?.job_id === "string" ? jobData.job_id : null,
      error: res.ok ? null : (res.error ?? "dispatch failed"),
    });
  }

  return { run_id: runId, gpu_fraction: fraction, dispatched };
}

/**
 * Render the evolution tree as PNG/HTML.
 */
export function plotReport(runId: string, runDir: string, format?: string): PyResult {
  return callPythonModule("evor.plot_tree", [
    "--run-id", runId,
    "--run-dir", runDir,
    "--format", format ?? "png",
  ], { timeout: 300_000 });
}

/**
 * Summarise wiki lessons grouped by approach_family and hypothesis_verdict.
 *
 * returns {confirmed, refuted, inconclusive, by_family}.
 */
export function wikiSummarize(
  runId?: string,
  runDir?: string,
  confirmedOnly?: boolean,
  limit?: number,
  evorRoot?: string,
): PyResult {
  const args = ["summarize"];
  if (runId) args.push("--run-id", runId);
  if (runDir) args.push("--run-dir", runDir);
  if (confirmedOnly) args.push("--confirmed-only", "true");
  if (limit !== undefined) args.push("--limit", String(limit));
  args.push("--evor-root", evorRoot ?? getEvorRoot());
  return callPythonModule("evor.wiki", args, { timeout: 30_000 });
}

/**
 * List accumulated gotchas from the GotchaStore.
 *
 * returns {gotchas: [...], total: N}.
 */
export function gotchasList(
  kind?: string,
  scope?: string,
  minConfidence?: number,
  evorRoot?: string,
  runDir?: string,
): PyResult {
  const args = ["gotchas"];
  if (kind) args.push("--kind", kind);
  if (scope) args.push("--scope", scope);
  if (minConfidence !== undefined) args.push("--min-confidence", String(minConfidence));
  args.push("--evor-root", evorRoot ?? getEvorRoot());
  if (runDir) args.push("--run-dir", runDir);
  return callPythonModule("evor", args, { timeout: 30_000 });
}

// ── Tool registrations ────────────────────────────────────────────────────────

/**
 * The directory a node's worktree actually lives in — O-01 (item 1.5), the
 * `worktrees/<id>/evaluate.py` half of the slug/UUID split-brain.
 *
 * Forge creates `.evor/worktrees/<node_id>` under the only identity it holds:
 * the name it coined. The server owns the UUID entirely and never returns one
 * (`evor_record_node` answers `{ok, name}`), so a worktree on disk is always
 * slug-named. Every server-side reader then resolved that name to the UUID and
 * statted `worktrees/<uuid>/`, a directory that never existed, and reported the
 * candidate as un-materialized — the same false-negative shape O-01 recorded
 * for `nodes/<id>/telemetry.jsonl`, one directory over.
 *
 * Returns only a directory that EXISTS. When none does, the canonical (first)
 * identity is returned so the caller's not-found handling is unchanged: this
 * can rescue a worktree filed under the other identity and can never
 * manufacture one.
 */
function worktreeDir(evorRoot: string, ...refs: (string | null | undefined)[]): string {
  const identities = refs.filter(
    (v, i, a): v is string => !!v && a.indexOf(v) === i,
  );
  for (const identity of identities) {
    const dir = join(evorRoot, "worktrees", identity);
    try {
      if (existsSync(dir)) return dir;
    } catch { /* unreadable under this identity — try the next one */ }
  }
  return join(evorRoot, "worktrees", identities[0] ?? "");
}

/**
 * Lock a node's evaluate.py: make it read-only and record its sha256 fingerprint
 * for later integrity verification. Replaces the agent shelling out `sha256sum`
 * + `chmod 444` (the hash is persisted internally and never surfaced).
 * Fail-open on fs errors — the name-only surface must never crash the agent.
 */
export function lockEvaluate(
  runId: string,
  nodeRef: string,
  missionId?: string,
): { ok: boolean; node_name: string; error?: string } {
  // A verification function: an unknown node is a reportable failure, not a
  // crash. Its return type already carries `error` for exactly this.
  const nodeId = tryResolveNodeRef(runId, nodeRef, missionId);
  // The evaluator is placed and locked during worktree setup, BEFORE
  // evor_record_node registers the node. Requiring registration made the
  // documented order fail every time (binarization mission, tick 4: four refusals).
  // The lock lives in the worktree, so a worktree named for the node is enough.
  const namedWorktree = /^[A-Za-z0-9._-]+$/.test(nodeRef) && existsSync(join(getEvorRoot(), "worktrees", nodeRef));
  if (nodeId === null && !namedWorktree) {
    return {
      ok: false,
      node_name: nodeRef,
      error: `node '${nodeRef}' is not in this run's tree and has no worktree — check the name with evor_tree_read.`,
    };
  }
  const worktree = worktreeDir(getEvorRoot(), nodeId, nodeRef);
  const evalPath = join(worktree, "evaluate.py");
  if (!existsSync(evalPath)) {
    return {
      ok: false,
      node_name: nodeRef,
      error: "evaluate.py is not present in the node worktree — materialize the genome first.",
    };
  }
  // Verify against the mission's locked canonical evaluator hash before locking.
  // Done outside the fs try/catch so resolveRunPaths errors don't mask hash errors.
  let contractHash = "";
  let legacySetAnchorOk = false;
  try {
    const { runDir } = resolveRunPaths(runId, missionId);
    const contractPath = join(runDir, "goal-contract.json");
    if (existsSync(contractPath)) {
      const contract = JSON.parse(readFileSync(contractPath, "utf8")) as Record<string, unknown>;
      contractHash = typeof contract.eval_script_hash === "string" ? contract.eval_script_hash : "";
      // v1.2.6–v1.2.9 sealed a digest over the evaluator's file SET into this
      // field, and this check compares one file's sha256 — so no node could be
      // locked under such a contract. The set digest commits to the same bytes,
      // so it is honoured when the node's copy equals the sealed canonical file.
      const version = typeof contract.eval_version === "string" ? contract.eval_version : "";
      const canonical = join(runDir, "eval-suites", `${version}.py`);
      if (version && existsSync(canonical) && contractHash === digestEvaluator(runDir, version).hash) {
        legacySetAnchorOk =
          createHash("sha256").update(readFileSync(canonical)).digest("hex")
          === createHash("sha256").update(readFileSync(evalPath)).digest("hex");
      }
    }
  } catch {
    // Fail-open: if we can't read the contract (run dir missing, parse error, etc.), proceed.
  }

  try {
    const hash = createHash("sha256").update(readFileSync(evalPath)).digest("hex");

    if (contractHash && contractHash !== hash && !legacySetAnchorOk) {
      return {
        ok: false,
        node_name: nodeRef,
        error: "this node's evaluate.py does not match the mission's locked evaluation script — it must be an exact copy of the canonical evaluator, not a modified or re-authored one",
      };
    }

    // Persist the fingerprint internally; the agent never sees the hash.
    writeFileSync(join(worktree, "evaluate.py.lock"), hash, "utf8");
    chmodSync(evalPath, 0o444);
    return { ok: true, node_name: nodeRef };
  } catch {
    return { ok: false, node_name: nodeRef, error: "could not lock evaluate.py" };
  }
}

/**
 * Install the sealed evaluator of `evalVersion` into a node's worktree and lock
 * it — the re-score path after a metric hardening.
 *
 * evor_lock_evaluate refuses an evaluate.py that differs from the contract's
 * anchor, which is right for a fresh node and wrong for a node re-scored under a
 * hardened version: its worktree still holds the parent's evaluator. The lock may
 * move, but only onto bytes the run has sealed AND the contract anchors for the
 * version in force — never onto a file the caller supplies.
 */
export function relockForRescore(
  runId: string,
  worktree: string,
  evalVersion: string,
  missionId?: string,
): { ok: true; replaced: boolean } | { ok: false; error: string } {
  if (!/^v\d+$/.test(evalVersion)) return { ok: false, error: `'${evalVersion}' is not an eval version (expected v<N>).` };
  const { runDir } = resolveRunPaths(runId, missionId);
  let contract: Record<string, unknown>;
  try {
    contract = JSON.parse(readFileSync(join(runDir, "goal-contract.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return { ok: false, error: "the goal contract is unreadable, so the evaluator to install cannot be verified." };
  }
  if (contract.eval_version !== evalVersion) {
    return {
      ok: false,
      error: `eval_version ${evalVersion} is not the version in force (${String(contract.eval_version)}); ` +
        `nodes are re-scored only under the contract's current eval_version.`,
    };
  }
  const canonical = join(runDir, "eval-suites", `${evalVersion}.py`);
  let sealedHash: string | undefined;
  let canonicalBytes: Buffer;
  try {
    const receipt = JSON.parse(readFileSync(join(runDir, "eval-suites", `${evalVersion}.sealed.json`), "utf8")) as {
      hash?: string; files?: Record<string, string>;
    };
    sealedHash = receipt.files?.[`${evalVersion}.py`] ?? receipt.hash;
    canonicalBytes = readFileSync(canonical);
  } catch {
    return {
      ok: false,
      error: `the ${evalVersion} evaluator has no seal receipt. Verify eval-suites/${evalVersion}.py ` +
        `against the contract's eval_script_hash first (evor_integrity_check reports a mismatch as ` +
        `no_eval_shift); seal it only if it matches, since a seal records whatever is on disk.`,
    };
  }
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  const hash = sha(canonicalBytes);
  if (!sealedHash || sealedHash !== hash || contract.eval_script_hash !== hash) {
    return {
      ok: false,
      error: `the ${evalVersion} evaluator on disk does not match its seal and the contract anchor; ` +
        `refusing to lock a node onto it.`,
    };
  }
  const evalPath = join(worktree, "evaluate.py");
  try {
    const current = existsSync(evalPath) ? sha(readFileSync(evalPath)) : "";
    const replaced = current !== hash;
    if (replaced) {
      if (existsSync(evalPath)) chmodSync(evalPath, 0o644);
      const tmp = `${evalPath}.rescore-tmp`;
      writeFileSync(tmp, canonicalBytes);
      renameSync(tmp, evalPath);
    }
    writeFileSync(join(worktree, "evaluate.py.lock"), hash, "utf8");
    chmodSync(evalPath, 0o444);
    if (replaced) {
      appendDecision(runDir, `evaluate.py re-locked to sealed ${evalVersion} for a re-score`,
        `worktree ${basename(worktree)} now carries the evaluator the contract anchors`);
    }
    return { ok: true, replaced };
  } catch {
    return { ok: false, error: "could not install the sealed evaluator into the node worktree." };
  }
}

/**
 * Verify a node externalized its training deliverables. Returns booleans only —
 * no filesystem paths cross to the agent. Replaces the agent walking
 * `nodes/<id>/results.json` / `telemetry.jsonl` by hand.
 */
export function verifyArtifacts(
  runId: string,
  nodeRef: string,
  missionId?: string,
): { ok: boolean; node_name: string; has_results: boolean; has_telemetry: boolean } {
  // A reporting function: an unknown node yields "found nothing", not a crash.
  const nodeId = tryResolveNodeRef(runId, nodeRef, missionId);
  const runDir = resolveRunPaths(runId, missionId).runDir;

  // ── O-01 (item 1.5): look under BOTH identities ──────────────────────────
  //
  // The trainer writes `nodes/<slug>/telemetry.jsonl`; this looked only under
  // `nodes/<uuid>/`. Neither writer was wrong — the slug is the right name for a
  // directory a human reads, the UUID the right key for a machine — but nothing
  // owned the mapping, so the reader guessed. A guess that resolves to a missing
  // path fails in the direction of "the candidate is bad", which is what makes
  // it expensive: good work discarded, quietly, as a verdict.
  //
  // This is the harness fix (`evor/node_identity.py`) applied to the TypeScript
  // reader. It only ever finds files that EXIST, so it can rescue a misfiled
  // artifact and can never manufacture one.
  const identities = [nodeId, nodeRef].filter((v, i, a): v is string => !!v && a.indexOf(v) === i);
  const present = (rel: string, minBytes: number): boolean => {
    for (const identity of identities) {
      try {
        const p = join(runDir, "nodes", identity, rel);
        if (existsSync(p) && statSync(p).size > minBytes) return true;
      } catch { /* try the next identity */ }
    }
    return false;
  };
  const has_results = present("results.json", 2);
  const has_telemetry = present("telemetry.jsonl", 0);
  return { ok: has_results && has_telemetry, node_name: nodeRef, has_results, has_telemetry };
}

/**
 * Persist server-owned integrity anchors into goal-contract.json.
 *
 * The freeze + eval-suite tools compute hashes that the integrity gate later
 * verifies (split_hash_match, no_eval_shift). These anchors are SERVER-OWNED:
 * the agent never carries them, but they MUST be written into the contract so
 * the gate has a real value to compare against. Without this, those checks
 * compare a real hash against `null` and can never pass — the gate is inert.
 *
 * Only known GoalContract fields are patched; the file is read-modify-written so
 * every other field is preserved, and failures are non-fatal (the gate still
 * fails closed if the anchor is missing).
 */
/**
 * Append one line to `decision-log.md` (item I-01).
 *
 * Best-effort: an unwritable log must not fail the write it describes. The log
 * is evidence, not a gate.
 */
function appendDecision(runDir: string, what: string, why: string): void {
  try {
    appendFileSync(
      `${runDir}/decision-log.md`,
      `- \`${new Date().toISOString()}\` **${what}** — ${why}\n`,
    );
  } catch {
    // best-effort by design
  }
}

/**
 * Rewrite fields of a sealed goal contract — and SAY SO (item I-01).
 *
 * This is the only code path in the MCP server that rewrites a sealed
 * `goal-contract.json`, and it was best-effort and silent by construction. Gate
 * and threshold changes were made through it — GPU 10ms→500ms, CPU 0.1s→1.0s,
 * LAT_CPU_THREADS 32→8 — and left no trace anywhere.
 *
 * The `eval_script_hash` case is the sharpest: when the contract already anchors
 * a DIFFERENT hash, this is not a first seal, it is an evaluator REPLACEMENT
 * that silently overwrites the anchor making the previous scores reproducible.
 * In the field the anchor moved three times (8d7107cf → 3dc2f7da → f123d17c →
 * a3776de4) and f123d17c's evaluator now exists nowhere on disk. Every number
 * scored under it is unreproducible, and nothing recorded that it changed.
 *
 * `harness/evor/benchmark.py` already gets this right — it appends a
 * "## BenchmarkUpgrade" block for every eval-suite upgrade. This is that,
 * applied to the writer that needed it.
 */
function patchGoalContract(runDir: string, patch: Record<string, string>): void {
  const contractPath = `${runDir}/goal-contract.json`;
  if (!existsSync(contractPath)) return;
  try {
    const contract = JSON.parse(readFileSync(contractPath, "utf8")) as Record<string, unknown>;
    const changes: string[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v && contract[k] !== v) {
        const previous = contract[k];
        contract[k] = v;
        // The PREVIOUS value is what makes the entry useful: it is the only
        // surviving record of an anchor whose evaluator may no longer exist.
        changes.push(
          previous === undefined
            ? `${k} set to ${String(v).slice(0, 24)}`
            : `${k} ${String(previous).slice(0, 24)} -> ${String(v).slice(0, 24)}`,
        );
      }
    }
    if (changes.length) {
      writeFileSync(contractPath, JSON.stringify(contract, null, 2), "utf8");
      appendDecision(
        runDir,
        `sealed goal-contract mutated: ${changes.join(", ")}`,
        Object.keys(patch).includes("eval_script_hash")
          ? "the evaluator anchor moved; scores recorded under the previous anchor are no longer reproducible"
          : "contract field rewritten through evor_seal_eval_script",
      );
    }
  } catch {
    // Best-effort: the integrity gate still fails closed if the anchor is absent.
  }
}


/**
 * Digest over every file the evaluator comprises.
 *
 * MIRROR of `evor.eval_contract.evaluator_digest` — kept honest by
 * `mcp/tests/eval-contract-parity.test.ts`, which runs both over one fixture.
 * The digest is over `name\0sha256\n` lines so adding, removing or renaming a
 * constituent file changes it, not only editing one.
 */
function digestEvaluator(runDir: string, evalVersion: string): {
  hash: string;
  files: Record<string, string>;
} {
  const base = join(runDir, "eval-suites");
  const candidates = [join(base, `${evalVersion}.py`), join(base, "score_plugin.py")];
  const files: Record<string, string> = {};
  const acc = createHash("sha256");
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
    files[basename(path)] = digest;
    acc.update(basename(path));
    acc.update(Buffer.from([0]));
    acc.update(digest);
    acc.update("\n");
  }
  return { hash: acc.digest("hex"), files };
}

/**
 * Seal `eval-suites/<evalVersion>.py` into the contract — the body of
 * evor_seal_eval_script, shared with evor_harden_eval so a hardened evaluator
 * is sealed by exactly the path every other evaluator is.
 */
/**
 * During a mission, a NEW eval version is introduced only by evor_harden_eval,
 * which carries the reviewed source, the rationale and the evidence. Writing or
 * sealing an evaluator for a version that is not in force — or replacing the
 * shared score_plugin.py — through the general tools would stage an unreviewed
 * evaluator for adoption. Setup (before the mission runs) is not affected.
 */
function evaluatorWriteRefusal(runDir: string, evalVersion: string, target: "evaluator" | "score_plugin"): string | null {
  if (!/^v\d+$/.test(evalVersion)) return `'${evalVersion}' is not an eval version (expected v<N>).`;
  let status = "";
  let inForce: unknown;
  try { status = String(JSON.parse(readFileSync(join(runDir, "mission-state.json"), "utf8")).status ?? ""); } catch { /* setup */ }
  try { inForce = JSON.parse(readFileSync(join(runDir, "goal-contract.json"), "utf8")).eval_version; } catch { /* setup */ }
  if (status !== "running" && status !== "paused") return null;
  if (target === "score_plugin") {
    return "score_plugin.py is the metric every eval version of this mission shares; it is not " +
      "replaced while the mission runs. A stricter metric is a new evaluator applied with " +
      "evor_harden_eval.";
  }
  if (typeof inForce === "string" && inForce !== evalVersion) {
    return `${evalVersion} is not the eval version in force (${inForce}). A new eval version is ` +
      `introduced during a mission only by evor_harden_eval, which takes the reviewed evaluator ` +
      `with its rationale and evidence and writes and seals it itself.`;
  }
  return null;
}

export function sealEvalScript(
  runDir: string,
  eval_version: string,
): { ok: true; eval_version: string; hash: string; plugin_hash?: string; files: Record<string, string> }
  | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error });
  const refusal = evaluatorWriteRefusal(runDir, eval_version, "evaluator");
  if (refusal) return fail(refusal);
  const evalScriptPath = `${runDir}/eval-suites/${eval_version}.py`;
  if (!existsSync(evalScriptPath)) {
    return fail(
      "no evaluation script found for this version — write the canonical evaluator before sealing it, then try again.",
    );
  }
  const content = readFileSync(evalScriptPath);

  // ── Two anchors, one per file — never one digest over both ───────────
  //
  // `eval_script_hash` is sha256(<v>.py), byte for byte. Three readers
  // compute exactly that and compare: integrity check 4 (no_eval_shift),
  // ForgeStructureGate.eval_locked, and the evaluator install check above.
  //
  // v1.2.6 replaced it with a digest over the evaluator's whole FILE SET, to
  // bring score_plugin.py — the actual metric — under custody. The goal was
  // right and the move was wrong: it changed what the anchor MEANS and none of
  // the three readers moved with it, so every node failed no_eval_shift from
  // v1.2.6 on and nothing could ever be promoted. A parity test pinned the seal
  // to evor.eval_contract and nothing pinned it to the gate that reads it. The
  // first live tick on a current CLI found it.
  //
  // So the plugin gets its OWN anchor, `eval_plugin_hash`, and the anchor every
  // reader already understands keeps its meaning. The per-file manifest still
  // goes in the receipt.
  const fileSha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const hash = fileSha(evalScriptPath);
  const pluginPath = `${runDir}/eval-suites/score_plugin.py`;
  const pluginHash = existsSync(pluginPath) ? fileSha(pluginPath) : undefined;
  const { files } = digestEvaluator(runDir, eval_version);

  // ── J-01: re-sealing must not launder an out-of-band rewrite ─────────
  //
  // The seal was four lines: hash, patch, done. When the contract ALREADY
  // anchors a different hash, this call is not a first seal — it is an
  // evaluator replacement, and re-running it rewrites the anchor so the
  // tampered file becomes "the sealed one". In the field an agent edited
  // the evaluator at 23:49 and the seal was re-applied over it; the
  // integrity gate then compared the new file against the new hash and
  // passed.
  //
  // Identical content is a no-op success, deliberately: setup flows call
  // the seal twice legitimately, and locking them out would make this a
  // worse failure than the one it fixes.
  // The question is not "does the contract anchor a different hash" — a
  // contract can carry a placeholder anchor that never matched any file, and
  // sealing into that is a FIRST seal. The question is whether THIS RUN
  // previously sealed this version, and the file has changed since.
  //
  // That needs a record the run owns, for the same reason O-09 needed one:
  // `goal-contract.json` is state other things write, so reading it cannot
  // distinguish "we sealed this" from "someone wrote a hash here". The
  // receipt is written by the seal and by nothing else.
  const receiptPath = `${runDir}/eval-suites/${eval_version}.sealed.json`;
  let receipt: {
    hash?: string; plugin_hash?: string; files?: Record<string, string>; sealed_at?: string;
  } | null = null;
  try { receipt = JSON.parse(readFileSync(receiptPath, "utf8")); } catch { receipt = null; }

  // Compare CONTENT, file by file. A receipt from v1.2.6–v1.2.9 carries a
  // set digest in `hash` and the per-file shas in `files`; reading `files`
  // first is what lets such a run re-seal in place and get a correct anchor,
  // instead of being refused as a tamper over bytes that never changed.
  const sealedMain = receipt?.files?.[`${eval_version}.py`] ?? receipt?.hash;
  const sealedPlugin = receipt?.files?.["score_plugin.py"] ?? receipt?.plugin_hash;

  // The plugin is shared by every version: sealing this one with a plugin that
  // differs from the one another version was sealed with would re-anchor the
  // metric under that version too.
  try {
    for (const f of readdirSync(join(runDir, "eval-suites")).filter((n) => n.endsWith(".sealed.json"))) {
      if (f === `${eval_version}.sealed.json`) continue;
      const other = JSON.parse(readFileSync(join(runDir, "eval-suites", f), "utf8")) as {
        files?: Record<string, string>; plugin_hash?: string;
      };
      const theirs = other.files?.["score_plugin.py"] ?? other.plugin_hash;
      if (theirs && theirs !== pluginHash) {
        return fail(
          `refusing to seal ${eval_version}: score_plugin.py differs from the one ` +
          `${f.split(".")[0]} was sealed with. The plugin is shared by every version, so ` +
          `sealing it would change that version's metric too.`,
        );
      }
    }
  } catch { /* no other receipts */ }
  if (sealedPlugin && pluginHash && sealedPlugin !== pluginHash) {
    return fail(
      `refusing to re-seal ${eval_version}: score_plugin.py changed after it was sealed ` +
      `(${sealedPlugin.slice(0, 12)}… → ${pluginHash.slice(0, 12)}…). The plugin is the ` +
      `metric; replacing it under the same anchor would revalidate every score already ` +
      `recorded. Seal the new metric under a NEW eval_version.`,
    );
  }

  if (sealedMain && sealedMain !== hash) {
    return fail(
      `refusing to re-seal ${eval_version}: this run sealed it at ` +
      `${String(receipt?.sealed_at ?? "an earlier time")} with hash ` +
      `${sealedMain.slice(0, 12)}…, and the file on disk now hashes to ${hash.slice(0, 12)}…. ` +
      `The evaluator changed after it was sealed. Re-sealing would make the changed file ` +
      `the sealed one and retroactively validate every score recorded under the old anchor. ` +
      `If replacing the evaluator is ` +
      `intended, seal it under a NEW eval_version so existing scores keep the evaluator ` +
      `they were measured with.`,
    );
  }

  // ── M-01 / I-02 (item 2.7): custody — break the hardlink ─────────────
  //
  // All three runs' `eval-suites/v1.py` were ONE inode with nlink 5, shared
  // with the project root. The seal never inspected `st_nlink` and never
  // copied, so a write through the UNPROTECTED alias reached every sealed
  // copy — and a 23:49 rewrite retroactively replaced r1's and r2's sealed
  // evaluators, months after those runs ended.
  //
  // The `.evor/runs/**` write guard could never have caught this: the write
  // did not go through a guarded path. Custody closes it with no new matcher
  // — copy the bytes, so the sealed file is the run's own inode and an alias
  // elsewhere is just a different file.
  try {
    if (statSync(evalScriptPath).nlink > 1) {
      const tmp = `${evalScriptPath}.seal-tmp`;
      writeFileSync(tmp, content);
      renameSync(tmp, evalScriptPath);   // atomic: replaces the link, not the target
    }
  } catch (e) {
    return fail(
      `could not take custody of ${eval_version}: ${String(e)}. The evaluator is ` +
      `hardlinked outside the run, so sealing it would anchor a file another path can ` +
      `still rewrite.`,
    );
  }

  // The contract anchors the version IN FORCE. Sealing a version that is not
  // (a hardened evaluator written ahead of its adoption) writes the receipt only:
  // moving the anchor would fail no_eval_shift for every node of the version
  // that is still in force. evor_harden_eval adopts it and anchors it then.
  let inForce = true;
  try {
    const v = (JSON.parse(readFileSync(`${runDir}/goal-contract.json`, "utf8")) as Record<string, unknown>).eval_version;
    inForce = typeof v !== "string" || v === eval_version;
  } catch { /* no readable contract: patchGoalContract is a no-op anyway */ }
  if (inForce) {
    patchGoalContract(runDir, {
      eval_script_hash: hash,
      ...(pluginHash !== undefined ? { eval_plugin_hash: pluginHash } : {}),
    });
  }

  // The receipt is what makes the NEXT call able to tell a tamper from a
  // first seal. Written after custody, so it attests the file this run owns.
  try {
    writeFileSync(
      receiptPath,
      JSON.stringify(
        {
          eval_version, hash,
          ...(pluginHash !== undefined ? { plugin_hash: pluginHash } : {}),
          files, sealed_at: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch { /* unwritable run dir — the contract anchor still stands */ }

  return {
    ok: true, eval_version, hash,
    ...(pluginHash !== undefined ? { plugin_hash: pluginHash } : {}),
    files,
  };
}

export function registerComputeTools(server: McpServer): void {

  // ── evor_run_start ──────────────────────────────────────────────────────────
  server.tool(
    "evor_run_start",
    "EVALUATES an ALREADY-TRAINED candidate: runs the sealed evaluate.py against the "
    + "worktree as a detached background job. It does NOT train. Training is written and "
    + "run by evor-forge-junior, and its weights must be on disk before you call this — "
    + "calling it on an untrained worktree scores whatever is there, usually as a failure. "
    + "Returns {status, job_id} instantly — poll progress with evor_run_status.",
    {
      run_id: z.string().describe("Active run identifier"),
      node_id: z.string().describe("The node's name (e.g. 'immune-memory-02')"),
      run_dir: z.string().optional().describe(
        "Absolute path to the run directory; derived from run_id when omitted",
      ),
      worktree: z.string().describe("Absolute path to the candidate git worktree"),
      eval_version: z.string().optional().describe(
        "Eval version to score under — the contract's current one. Pass it to re-score an "
        + "existing node after a metric hardening: the worktree's evaluate.py is replaced by "
        + "that version's sealed evaluator and re-locked before the job starts.",
      ),
    },
    async ({ run_id, node_id, run_dir, worktree, eval_version }) => {
      const missionId = process.env.EVOR_MISSION_ID;
      const resolvedDir = run_dir ?? resolveRunPaths(run_id, missionId).runDir;
      // Strict here on purpose: launching training for a node the tree does not
      // know would create its artifacts under an unregistered identity, which is
      // O-01 happening again at the other end.
      let resolvedNodeId: string;
      try {
        resolvedNodeId = resolveNodeRef(run_id, node_id, missionId);
      } catch (e) {
        return err(String(e instanceof Error ? e.message : e));
      }
      // A named eval_version is a (re-)score under that version: the worktree
      // gets that version's sealed evaluator first, so a node scored under a
      // hardened version runs the hardened bytes and nothing else.
      if (eval_version) {
        const relock = relockForRescore(run_id, worktree, eval_version, missionId);
        if (!relock.ok) return err(relock.error);
      }
      const result = jobStart(resolvedNodeId, run_id, resolvedDir, worktree, eval_version);
      if (!result.ok) return err(result.error ?? "evor_run_start failed");

      // Record job_id + run_dir into active-run.json so the run-watcher monitor
      // can locate jobs/<job_id>/log.jsonl without needing EVOR_RUN_DIR injected.
      const jobData = result.data as Record<string, unknown>;
      const jobId = typeof jobData?.job_id === "string" ? jobData.job_id : undefined;
      if (jobId) {
        try {
          const arPath = getActiveRunPath();
          let existing: Record<string, unknown> = {};
          if (existsSync(arPath)) {
            try { existing = JSON.parse(readFileSync(arPath, "utf8")); } catch { /* ignore */ }
          }
          const ar: Record<string, unknown> = {
            ...existing,
            run_id,
            run_dir: resolvedDir,
            job_id: jobId,
          };
          if (missionId && !ar.mission_id) ar.mission_id = missionId;
          const arTmp = `${arPath}.tmp`;
          writeFileSync(arTmp, JSON.stringify(ar, null, 2), "utf8");
          renameSync(arTmp, arPath);
        } catch {
          // fail-open — never block the caller on an active-run write error
        }
      }

      // ── 1.9c: the mission enters `running` HERE, server-side ──────────────
      //
      // `skills/evor-run/SKILL.md:80` already asked the orchestrator to call
      // `evor_state_write({ mission_status: "running" })`. That is a prose
      // obligation, and §2's whole thesis is that an obligation stated in prose
      // to an agent is one the system has decided not to have — in the field it
      // was not honoured, `mission-state` stayed `locked` for the entire run,
      // and `stop.mjs`'s M-2 comment recorded that as though it were the design.
      //
      // It has to be true here rather than requested there, because the three
      // stop-hook gates re-home onto mission liveness in this same phase. A
      // governance check pointed at a field only a cooperating agent sets is not
      // a check.
      //
      // Best-effort: launching the job succeeded, and failing the caller because
      // a status write did not land would be worse than the stale status.
      try {
        const msPath = join(resolvedDir, "mission-state.json");
        let ms: Record<string, unknown> = {};
        if (existsSync(msPath)) {
          try { ms = JSON.parse(readFileSync(msPath, "utf8")); } catch { /* start fresh */ }
        }
        const from = String(ms.status ?? "locked");
        if (from !== "running" && nextState("mission", from, "start_run") === "running") {
          ms.status = "running";
          ms.updated_at = new Date().toISOString();
          ms.entered_at = ms.updated_at;
          const msTmp = `${msPath}.tmp`;
          writeFileSync(msTmp, JSON.stringify(ms, null, 2), "utf8");
          renameSync(msTmp, msPath);
          appendFileSync(
            join(resolvedDir, "transitions.jsonl"),
            JSON.stringify({
              at: ms.updated_at,
              entity: "mission",
              from,
              to: "running",
              actor: "evor_run_start",
              reason: `job ${jobId ?? "?"} launched for node ${node_id}`,
            }) + "\n",
          );
        }
      } catch {
        // fail-open — see above
      }

      // Return only the job handle the agent needs — strip internal paths.
      return ok({ status: "started", job_id: jobId ?? null });
    },
  );

  // ── evor_run_status ─────────────────────────────────────────────────────────
  server.tool(
    "evor_run_status",
    "Read status for a running or completed job. "
    + "Returns {state, exit_code?, started_at?, finished_at?, tail?}.",
    {
      run_id: z.string().describe("Active run identifier"),
      job_id: z.string().optional().describe(
        "Job identifier; looked up from active-run state when omitted",
      ),
      run_dir: z.string().optional().describe(
        "Explicit run directory; derived from run_id when omitted",
      ),
    },
    async ({ run_id, job_id, run_dir }) => {
      const missionId = process.env.EVOR_MISSION_ID;
      const resolvedDir = run_dir ?? resolveRunPaths(run_id, missionId).runDir;

      // Resolve job_id from active-run state when the caller omits it.
      let resolvedJobId = job_id;
      if (!resolvedJobId) {
        try {
          const arPath = getActiveRunPath();
          if (existsSync(arPath)) {
            const ar = JSON.parse(readFileSync(arPath, "utf8")) as Record<string, unknown>;
            if (typeof ar.job_id === "string") resolvedJobId = ar.job_id;
          }
        } catch {
          // fail-open — fall through; jobStatus will surface its own error
        }
      }
      if (!resolvedJobId) return err("job_id required: no active job found for run_id");

      const result = jobStatus(resolvedJobId, resolvedDir);
      if (!result.ok) return err(result.error ?? "evor_run_status failed");

      // Strip internal `cmd` field (contains full FS path + python invocation).
      const data = result.data as Record<string, unknown> | undefined;
      if (data && "cmd" in data) {
        const { cmd: _cmd, ...clean } = data;
        return ok(clean);
      }
      return ok(result.data);
    },
  );

  // ── evor_capability ─────────────────────────────────────────────────────────
  server.tool(
    "evor_capability",
    "Probe hardware and write .evor/capability.json. "
    + "Idempotent — safe to call at mission startup before preflight.",
    {
      evor_root: z.string().optional().describe(
        "Path to .evor/ root (default: EVOR_ROOT env or cwd/.evor)",
      ),
    },
    async ({ evor_root }) => {
      const root = evor_root ?? getEvorRoot();
      const result = callPythonModule("evor", [
        "capability",
        "--evor-root", root,
      ], { timeout: 30_000 });
      // evor capability exits 0 and writes capability.json but emits human text on
      // stdout, not JSON.  exitCode is set only on non-zero exit.
      if (result.exitCode !== undefined && result.exitCode !== 0) {
        return err(result.error ?? "evor capability failed");
      }
      try {
        const cap = JSON.parse(readFileSync(join(root, "capability.json"), "utf8"));
        return ok(cap);
      } catch {
        return err(
          "evor capability succeeded but capability.json was not written — check EVOR_ROOT configuration."
          + (result.stderr ? ` (${result.stderr})` : ""),
        );
      }
    },
  );

  // ── evor_preflight ──────────────────────────────────────────────────────────
  server.tool(
    "evor_preflight",
    "Smoke-test the run environment before committing GPU time. "
    + "Two modes: mode='full' (default) checks import_ok and gpu_active, and reports "
    + "loss_decreasing — which is ALWAYS null at setup: the micro-train needs a candidate "
    + "worktree and none exists yet. A null check is listed in `unverified`; it was not "
    + "run and must not be read as passed. Returns {run_id, checks, passed, unverified?}. "
    + "mode='env_only' checks imports + env variables only — fast, no GPU required, "
    + "safe to call on CPU-only nodes or before evor_capability. "
    + "Pass no_gpu_check=true to skip GPU utilisation even in full mode.",
    {
      run_id: z.string().describe("Active run identifier"),
      run_dir: z.string().optional().describe("Explicit run_dir override"),
      no_gpu_check: z.boolean().optional().describe(
        "Skip GPU utilisation check (useful in CPU-only environments)",
      ),
      mode: z.enum(["full", "env_only"]).optional().describe(
        "Preflight mode: 'full' (default) runs 5-step micro-train; "
        + "'env_only' checks imports + env only (fast, no GPU needed)",
      ),
    },
    async ({ run_id, run_dir, no_gpu_check, mode }) => {
      const missionId = process.env.EVOR_MISSION_ID;
      const resolvedDir = run_dir ?? resolveRunPaths(run_id, missionId).runDir;
      const result = preflightRun(run_id, resolvedDir, no_gpu_check, mode);
      if (!result.ok) return err(result.error ?? "evor preflight failed");
      return ok(result.data);
    },
  );

  // ── evor_validate ───────────────────────────────────────────────────────────
  server.tool(
    "evor_validate",
    "Validate run configuration and split integrity. Returns a JSON ValidationReport.",
    {
      run_id: z.string().describe("Active run identifier"),
    },
    async ({ run_id }) => {
      const missionId = process.env.EVOR_MISSION_ID;
      const { runDir } = resolveRunPaths(run_id, missionId);
      const result = validateRun(runDir);
      if (!result.ok) return err(result.error ?? "evor validate failed");
      return ok(result.data);
    },
  );

  // ── evor_doctor ─────────────────────────────────────────────────────────────
  server.tool(
    "evor_doctor",
    "Health-check the run and environment: Python, torch, Node.js, env vars, "
    + "tree consistency, mission state, orphan pending nodes, and frozen-split integrity. "
    + "Pass repair=true to auto-fix obvious issues.",
    {
      run_id: z.string().optional().describe(
        "Active run identifier (omit for env-only check)",
      ),
      repair: z.boolean().optional().describe(
        "Auto-repair obvious issues found during the health check",
      ),
    },
    async ({ run_id, repair }) => {
      const missionId = process.env.EVOR_MISSION_ID;
      const runDir = run_id
        ? resolveRunPaths(run_id, missionId).runDir
        : undefined;
      const result = doctorRun(runDir, repair);
      if (!result.ok) return err(result.error ?? "evor doctor failed");
      return ok(result.data);
    },
  );

  // ── evor_freeze_splits ──────────────────────────────────────────────────────
  server.tool(
    "evor_freeze_splits",
    "Freeze the test and val splits for reproducible evaluation. "
    + "Returns {ok, test_item_count, val_item_count}.",
    {
      dataset_ref: z.string().describe("Path to dataset directory or file"),
      eval_version: z.string().describe("Eval version string (e.g. v1)"),
      run_id: z.string().describe("Active run identifier"),
      mission_id: z.string().optional().describe("Mission ID carried into split_id"),
    },
    async ({ dataset_ref, eval_version, run_id, mission_id }) => {
      const resolvedMission = mission_id ?? process.env.EVOR_MISSION_ID;
      const { runDir } = resolveRunPaths(run_id, resolvedMission);
      const result = freezeSplits(dataset_ref, eval_version, runDir, resolvedMission);
      if (!result.ok) return err(result.error ?? "evor_freeze_splits failed");

      // Strip internal hash fields — the agent must not carry them.
      const data = result.data as Record<string, unknown> | undefined;
      if (data) {
        const { locked_split_hash: _lh, val_split_hash: _vh, ...clean } = data;

        // Persist the server-owned split hash into the contract so the integrity
        // gate's split_hash_match check verifies against a real value. It stays
        // stripped from the agent-facing payload above — the agent never carries
        // it, but the gate reads it from goal-contract.json.
        if (typeof _lh === "string" && _lh) {
          patchGoalContract(runDir, { locked_split_hash: _lh });
        }

        // ── Item 2.10: guard the SHAPE that actually failed ──────────────────
        //
        // This caught `test === 0 && val === 0`. The real failure returned 5 and
        // 2 — a freeze of `corpora/v10`'s seven top-level METADATA files, split
        // 80/20 — and sailed through, because a non-zero count looked like
        // success. Every fitness number in a 19-hour run was then computed
        // against `dataset_card.yaml` and `test.txt`.
        //
        // Fixing the predicate rather than the outcome, as the plan requires. A
        // count is not evidence that the right things were counted, so the guard
        // now asks whether the split can answer the question the contract poses:
        // an eval set too small to be one, or one carrying no domain labels when
        // the corpus is organised by domain, is not a small answer — it is an
        // answer to a different question.
        const testCount = Number(clean.test_item_count ?? 0);
        const valCount = Number(clean.val_item_count ?? 0);
        if (testCount === 0 && valCount === 0) {
          return err(
            "no data items were found to freeze at the given location — nothing was captured. " +
            "The location should directly contain the individual data files (not sub-folders). " +
            "Point it at the folder that holds the files themselves and try again.",
          );
        }

        // NO ITEM-COUNT FLOOR HERE, and the reason is the finding itself.
        //
        // A floor was written and removed: it rejected `test=3, val=0`, which
        // `compute.test.ts` asserts must be allowed, and it was right to. "Few
        // items" is not the metadata-freeze signature — a genuinely small corpus
        // is small. The signature is that the frozen files ARE the corpus's
        // manifests, and only the freeze can see that, because only the freeze
        // knows their names.
        //
        // So the refusal lives at `_refuse_if_metadata_only` in
        // harness/evor/freeze.py, keyed on `dataset_card.yaml`, `manifest.json`,
        // `test.txt` and friends. AF1's warning is exactly this: "the guard is
        // not too weak; it is reasoning over a representation that cannot carry
        // the distinction it needs to make." A count cannot carry it.

        return ok({ ok: true, ...clean });
      }
      return ok(result.data);
    },
  );

  // ── evor_init_eval_suite ────────────────────────────────────────────────────
  server.tool(
    "evor_init_eval_suite",
    "Create the initial evaluation suite for a new mission. Call AFTER evor_freeze_splits: "
    + "its domains are read from the frozen test split (one per distinct per-sample domain), "
    + "and before a freeze it can only produce a single placeholder 'primary' domain. "
    + "Returns {eval_version, mission_id, domains, created_at}.",
    {
      mission_id: z.string().describe("Mission identifier"),
      eval_version: z.string().describe("Eval version string (e.g. v1)"),
      task_description: z.string().describe("Task description for domain derivation"),
      run_id: z.string().describe("Active run identifier"),
    },
    async ({ mission_id, eval_version, task_description, run_id }) => {
      const resolvedMission = mission_id ?? process.env.EVOR_MISSION_ID;
      const { runDir } = resolveRunPaths(run_id, resolvedMission);
      const result = initEvalSuite(mission_id, eval_version, task_description, runDir);
      if (!result.ok) return err(result.error ?? "evor_init_eval_suite failed");

      // Arm eval-shift detection: if the canonical eval script for this version
      // has been materialised, lock its hash into the contract so the integrity
      // gate's no_eval_shift check verifies against a real value. If the script
      // does not exist yet (a from-scratch mission whose evaluator is authored
      // during the run), the anchor is left unset and arms when the suite is
      // re-sealed after the script lands — the gate fails closed until then.
      const evalScriptPath = `${runDir}/eval-suites/${eval_version}.py`;
      if (existsSync(evalScriptPath)) {
        const hash = createHash("sha256").update(readFileSync(evalScriptPath)).digest("hex");
        patchGoalContract(runDir, { eval_script_hash: hash });
      }

      return ok(result.data);
    },
  );

  // ── evor_seal_eval_script ───────────────────────────────────────────────────
  server.tool(
    "evor_seal_eval_script",
    "Seal the canonical evaluator into goal-contract.json: eval_script_hash = sha256 of "
    + "eval-suites/<eval_version>.py, and — when the mission has one — eval_plugin_hash = "
    + "sha256 of score_plugin.py, the metric itself. The integrity gate's no_eval_shift "
    + "check verifies both. Call once after the canonical evaluator is written. Sealing a "
    + "version that is not the contract's eval_version writes its seal receipt only; "
    + "evor_harden_eval adopts it and moves the anchor.",
    {
      run_id: z.string().describe("Active run identifier"),
      eval_version: z.string().describe("Eval version string (e.g. v1)"),
      mission_id: z.string().optional().describe("Mission ID; defaults to EVOR_MISSION_ID env"),
    },
    async ({ run_id, eval_version, mission_id }) => {
      const resolvedMission = mission_id ?? process.env.EVOR_MISSION_ID;
      const { runDir } = resolveRunPaths(run_id, resolvedMission);
      const sealed = sealEvalScript(runDir, eval_version);
      return sealed.ok ? ok(sealed) : err(sealed.error);
    },
  );

  // ── evor_tick_completeness ──────────────────────────────────────────────────
  //
  // Lets the tick ask what it still owes instead of discovering it at the
  // SubagentStop guard. Both callers import the SAME module
  // (hooks/lib/tick-completeness.mjs) — a tool and a hook holding separate
  // opinions about the same predicate is exactly how the evaluator ended up
  // with four disagreeing beliefs about its own interface.
  server.tool(
    "evor_tick_completeness",
    "What this tick still owes: every proposal the selector SELECTED needs a trained, "
    + "evaluated, integrity-checked node, not just the winner. Returns the undischarged "
    + "ones. Call it before returning a terminal outcome — the SubagentStop guard checks "
    + "the same thing and will block a \"scored\" return that still owes a candidate.",
    {
      run_id: z.string().optional().describe("Active run identifier; resolved from the active run when omitted"),
      tick: z.number().int().min(1).describe("The tick to check"),
      mission_id: z.string().optional().describe("Mission id; resolved from the active run when omitted"),
    },
    async ({ run_id, tick, mission_id }) => {
      let resolvedRun: string;
      try {
        resolvedRun = resolveRunId(run_id);
      } catch (e) {
        return err(String(e instanceof Error ? e.message : e));
      }
      const { runDir } = resolveRunPaths(resolvedRun, mission_id ?? process.env.EVOR_MISSION_ID);
      const selected = selectedProposals(runDir, tick);
      const debt = owed(runDir, tick);
      return ok({
        ok: true,
        tick,
        selected,
        complete: debt.length === 0,
        owed: debt,
        // Said explicitly because "complete: true" with an empty selection is the
        // shape that let an entire tick pass having forged nothing.
        note: selected.length === 0
          ? "the selector selected NOTHING this tick — complete is vacuous; outcome should be 'rejected' or 'skipped', not 'scored'"
          : undefined,
      });
    },
  );

  // ── evor_write_eval_script ──────────────────────────────────────────────────
  //
  // The writer that did not exist. `skills/evor-setup/SKILL.md` instructs the
  // agent to write `eval-suites/<v>.py`, and `evor_scaffold_evaluator` says "the
  // mission then writes ONLY score(pred, gt) in score_plugin.py" — while both
  // paths sit under `.evor/runs/`, where PROTECTED_RUNS_RE denies Write and Edit
  // for every role, and no MCP tool targeted either file. `evor_write_artifact`
  // writes `ticks/<tick>/<agent>/*.json` and nothing else.
  //
  // So both documented paths dead-ended at the same guard, and a mission setup
  // could only be completed by the operator typing `cp` — the shell being the
  // one actor outside the PreToolUse hook.
  //
  // The guard is NOT relaxed. Run artifacts are written through their owning
  // tool; this is that tool, and it validates what the hand-written column got
  // wrong in the field before the bytes land.
  server.tool(
    "evor_write_eval_script",
    "Write the canonical evaluator into the run — the file every node will share. "
    + "This is the owning writer for eval-suites/<eval_version>.py and for "
    + "score_plugin.py; direct Write/Edit under .evor/runs/ is denied by design. "
    + "Validates that the source compiles and conforms to the evaluator contract "
    + "(no positional argv, prints one JSON object) before writing. Seal it afterwards "
    + "with evor_seal_eval_script, which anchors every file the evaluator comprises.",
    {
      run_id: z.string().describe("Active run identifier"),
      eval_version: z.string().describe("Eval version this evaluator is for (e.g. v1)"),
      source: z.string().min(1).describe("Complete Python source of the file"),
      target: z.enum(["evaluator", "score_plugin"]).default("evaluator").describe(
        "'evaluator' writes eval-suites/<eval_version>.py; 'score_plugin' writes "
        + "eval-suites/score_plugin.py, the mission-owned metric of the generated shape",
      ),
      mission_id: z.string().optional().describe("Mission id; resolved from the active run when omitted"),
    },
    async ({ run_id, eval_version, source, target, mission_id }) => {
      const resolvedMission = mission_id ?? process.env.EVOR_MISSION_ID;
      const { runDir } = resolveRunPaths(run_id, resolvedMission);
      const refusal = evaluatorWriteRefusal(runDir, eval_version, target === "score_plugin" ? "score_plugin" : "evaluator");
      if (refusal) return err(refusal);
      const dir = join(runDir, "eval-suites");
      const name = target === "score_plugin" ? "score_plugin.py" : `${eval_version}.py`;
      const dest = join(dir, name);

      // Refuse to overwrite a SEALED evaluator. Re-sealing is already guarded;
      // silently replacing the sealed bytes and leaving the anchor behind would
      // route around that guard instead of tripping it.
      const receipt = join(dir, `${eval_version}.sealed.json`);
      if (existsSync(receipt)) {
        return err(
          `${eval_version} is already sealed. Replacing the evaluator under a sealed ` +
          `anchor would retroactively revalidate every score measured with the old one. ` +
          `Write a NEW eval_version so existing scores keep the evaluator they were ` +
          `measured with.`,
        );
      }

      const check = callPythonModule("evor.eval_contract_writer", [
        "write", "--run-dir", runDir, "--eval-version", eval_version,
        "--target", target, "--stdin-source",
      ], { stdin: source });
      if (!check.ok) return err(check.error ?? "evaluator source rejected");
      return ok({ ok: true, path: dest, ...(check.data as object ?? {}) });
    },
  );

  // ── evor_harden_eval ────────────────────────────────────────────────────────
  //
  // The wired path for the charter's ALLOWED move "reconcile a mis-specified
  // guard/spec to the contract's stated intent" when the guard is the metric
  // itself. A sealed evaluator cannot be replaced in place (evor_write_eval_script
  // and the seal both refuse), and BenchmarkManager.apply_upgrade only adds
  // domains, so a mission that found its metric gameable had no move at all.
  //
  // One harness call does all of it — validate, write, seal, record, adopt — as
  // a single transaction (BenchmarkManager.apply_hardening): a failure anywhere
  // leaves the run on the parent version with every prior file intact. Splitting
  // it across a TS seal and a Python record left half-adopted states in between.
  // The receipt it writes has the shape evor_seal_eval_script writes.
  server.tool(
    "evor_harden_eval",
    "Replace the run's evaluator with a STRICTER one under a new eval_version, mid-mission. "
    + "Use when the metric is gameable: fitness rises while the contract's stated intent "
    + "regresses. Takes the reviewed evaluator (source or source_worktree), validates it, and "
    + "in one all-or-nothing step writes and seals eval-suites/<to_version>.py, records "
    + "EvalSuite <to_version> (same domains, same frozen split, parent <from_version>), moves "
    + "the contract and run state to it (best_score restarts under the new version), logs "
    + "the decision, and returns the frontier nodes to re-score. No consent step: making "
    + "evaluation harder is pre-authorized. Only stricter is accepted — every node scored "
    + "under <to_version> is also scored by the sealed parent, and integrity fails it when "
    + "the hardened fitness or primary metric is better. A stricter metric may reorder the "
    + "frontier. The new evaluator reads the parent's frozen split "
    + "(frozen-splits/<from_version>-test) and must emit eval_version=<to_version>. Then "
    + "re-score each returned node with evor_run_start(eval_version=<to_version>) and "
    + "record it with evor_record_eval.",
    {
      run_id: z.string().describe("Active run identifier"),
      from_version: z.string().regex(/^v\d+$/).describe("The eval_version in force (e.g. v1)"),
      to_version: z.string().regex(/^v\d+$/).describe("The new, stricter eval_version (e.g. v2)"),
      source: z.string().min(1).optional().describe(
        "Complete Python source of the reviewed hardened evaluator. Give exactly one of "
        + "source and source_worktree.",
      ),
      source_worktree: z.string().optional().describe(
        "Name of the worktree whose evaluate.py holds the hardened evaluator (as written "
        + "by forge-junior and reviewed by forge-critic).",
      ),
      rationale: z.string().min(1).describe(
        "The gate the hardened evaluator adds and the metric artefact it closes",
      ),
      contract_grounding: z.string().min(12).describe(
        "A verbatim quote from the goal contract stating the intent the current metric "
        + "fails to enforce. Refused when the contract does not contain it.",
      ),
      evidence: z.array(z.string().min(1)).min(1).describe(
        "What found the metric artefact: wiki lesson ids and/or the probe proposal pointer "
        + "(e.g. 'probe@tick7'). Recorded in the decision log beside the parent version.",
      ),
      proposed_by: z.enum(["probe", "sage", "policy"]).default("probe").describe(
        "Who proposed the hardening",
      ),
      rescore_deadline_ticks: z.number().int().min(0).default(3).describe(
        "Ticks within which the frontier is to be re-scored under the new version",
      ),
      tick: z.number().int().min(0).optional().describe("The tick applying it"),
      mission_id: z.string().optional().describe("Mission id; resolved from the active run when omitted"),
    },
    async ({
      run_id, from_version, to_version, source, source_worktree, rationale,
      contract_grounding, evidence, proposed_by, rescore_deadline_ticks, tick, mission_id,
    }) => {
      const resolvedMission = mission_id ?? process.env.EVOR_MISSION_ID;
      const { runDir } = resolveRunPaths(run_id, resolvedMission);
      for (const v of [from_version, to_version]) {
        if (!/^v\d+$/.test(String(v))) return err(`'${String(v)}' is not an eval version (expected v<N>).`);
      }
      if (proposed_by !== undefined && !["probe", "sage", "policy"].includes(proposed_by)) {
        return err(`proposed_by '${String(proposed_by)}' is not one of probe, sage, policy.`);
      }
      if ((source === undefined) === (source_worktree === undefined)) {
        return err(
          "give exactly one of source or source_worktree: the reviewed evaluator. A file " +
          "already on disk for the new version is never adopted on its own say-so.",
        );
      }
      let code = source ?? "";
      if (source_worktree !== undefined) {
        if (!/^[A-Za-z0-9._-]+$/.test(source_worktree)) {
          return err("source_worktree must be a worktree name, not a path.");
        }
        try {
          code = readFileSync(join(getEvorRoot(), "worktrees", source_worktree, "evaluate.py"), "utf8");
        } catch {
          return err(`worktree '${source_worktree}' has no evaluate.py to harden with.`);
        }
      }

      const hardened = callPythonModule("evor.benchmark", [
        "harden", "--run-dir", runDir,
        "--from-version", from_version, "--to-version", to_version,
        "--rationale", rationale, "--contract-grounding", contract_grounding,
        "--proposed-by", proposed_by ?? "probe",
        "--rescore-deadline-ticks", String(rescore_deadline_ticks ?? 3),
        ...evidence.flatMap((e) => ["--evidence", e]),
        ...(tick !== undefined ? ["--tick", String(tick)] : []),
        "--stdin-source",
      ], { stdin: code });
      if (!hardened.ok) return err(hardened.error ?? "evor_harden_eval failed");

      // The integrity tool caches the contract's eval_version per run; the
      // version just moved, so the next check must read it again.
      evalVersionCache.delete(run_id);

      const data = hardened.data as {
        rescore?: string[]; upgrade_id?: string; frontier_order_before?: string[];
      } | null;
      return ok({
        ok: true,
        from_version,
        to_version,
        upgrade_id: data?.upgrade_id,
        rescore: data?.rescore ?? [],
        frontier_order_before: data?.frontier_order_before ?? [],
        next: `re-score each node in rescore with evor_run_start(eval_version="${to_version}"), ` +
          `then evor_record_eval; integrity passes it only when its ${to_version} scores are ` +
          `no better than its ${from_version} scores.`,
      });
    },
  );

  // ── evor_scaffold_evaluator (item 2.5) ──────────────────────────────────────
  server.tool(
    "evor_scaffold_evaluator",
    "Generate the evaluator harness for this run from the goal contract, eval suite and "
    + "frozen index. The mission then writes ONLY score(pred, gt) in score_plugin.py. "
    + "Deterministic: the server can regenerate and byte-compare, which is what makes the "
    + "seal custody rather than an assertion.",
    {
      run_id: z.string().describe("Active run identifier"),
      eval_version: z.string().default("v1").describe("Eval suite version"),
      mission_id: z.string().optional().describe("Mission id; resolved from the active run when omitted"),
      overwrite_plugin: z.boolean().optional().describe(
        "Replace an existing score_plugin.py. Off by default — the plugin is the mission's own work.",
      ),
    },
    async ({ run_id, eval_version, mission_id, overwrite_plugin }) => {
      // AF2 §4.1: every field failure lived in the column the agent hand-wrote —
      // polarity, gate scope, the domain join — while the parts identical across
      // every mission were re-derived by hand beside them. The server owns the
      // harness; the mission owns one function.
      const resolvedMission = mission_id ?? process.env.EVOR_MISSION_ID;
      const { runDir } = resolveRunPaths(run_id, resolvedMission);
      const result = callPythonModule("evor.scaffold_evaluator", [
        "generate", "--run-dir", runDir, "--eval-version", eval_version,
        ...(overwrite_plugin ? ["--overwrite-plugin"] : []),
      ]);
      if (!result.ok || result.data == null) {
        return err(result.error ?? "evor_scaffold_evaluator failed");
      }
      return ok(result.data);
    },
  );

  // ── evor_meta_evolve ────────────────────────────────────────────────────────
  server.tool(
    "evor_meta_evolve",
    "Run TreeEngine.meta_evolve to update strategy.json based on the current frontier. "
    + "Returns the updated StrategyState.",
    {
      run_id: z.string().describe("Active run identifier"),
    },
    async ({ run_id }) => {
      const missionId = process.env.EVOR_MISSION_ID;
      const { runDir } = resolveRunPaths(run_id, missionId);
      const result = metaEvolve(runDir);
      if (!result.ok) return err(result.error ?? "evor_meta_evolve failed");
      return ok(result.data);
    },
  );

  // ── evor_distill_scan ───────────────────────────────────────────────────────
  server.tool(
    "evor_distill_scan",
    "Deep-scan a workspace for brownfield onboarding. "
    + "Returns a StartingPointReport and writes .evor/starting-point.json.",
    {
      path: z.string().describe("Workspace root directory to scan"),
      evor_root: z.string().optional().describe(
        "EVOR root (.evor/ dir); defaults to <path>/.evor/",
      ),
    },
    async ({ path, evor_root }) => {
      const result = distillScan(path, evor_root);
      if (!result.ok) return err(result.error ?? "evor distill scan failed");
      return ok(result.data);
    },
  );

  // ── evor_plot_report ────────────────────────────────────────────────────────
  server.tool(
    "evor_plot_report",
    "Render the evolution tree as a PNG and/or HTML report. "
    + "Writes report/tree.<ext> under the run directory.",
    {
      run_id: z.string().describe("Active run identifier"),
      format: z.enum(["ascii", "png", "html"]).optional().describe(
        "Output format (default: png)",
      ),
    },
    async ({ run_id, format }) => {
      const missionId = process.env.EVOR_MISSION_ID;
      const { runDir } = resolveRunPaths(run_id, missionId);
      const result = plotReport(run_id, runDir, format);
      if (!result.ok) return err(result.error ?? "evor_plot_report failed");
      return ok(result.data ?? { ok: true, format: format ?? "png" });
    },
  );

  // ── evor_forge_dispatch_batch ───────────────────────────────────────────────
  server.tool(
    "evor_forge_dispatch_batch",
    "Dispatch multiple candidate EVALUATION jobs in parallel to the compute backend. "
    + "Same path as evor_run_start (it does NOT train) — each candidate must already be "
    + "trained with weights on disk. "
    + "Returns job_ids for all candidates immediately without waiting for completion. "
    + "Poll each job with evor_run_status. "
    + "Use instead of sequential evor_run_start calls when VRAM allows parallel evaluation.",
    {
      run_id: z.string().describe("Active run identifier"),
      candidates: z.array(z.object({
        node_name: z.string().describe("Logical node name (e.g. 'immune-memory-02')"),
        eval_version: z.string().optional().describe("Eval suite version override (e.g. v1)"),
      })).min(1).max(8).describe("Candidate nodes to train in parallel (max 8)"),
      gpu_fraction: z.number().min(0.1).max(1.0).optional().describe(
        "VRAM fraction per job (default: 1.0/n_candidates, auto-computed). "
        + "Set to 1.0 if jobs must run sequentially.",
      ),
    },
    async ({ run_id, candidates, gpu_fraction }) => {
      const missionId = process.env.EVOR_MISSION_ID;
      const evorRoot = getEvorRoot();
      const { runDir } = resolveRunPaths(run_id, missionId);

      // Resolve each logical node name → node_id + worktree path server-side.
      let resolvedCandidates: BatchCandidate[];
      try {
        resolvedCandidates = candidates.map((c) => {
          const nodeId = resolveNodeRef(run_id, c.node_name, missionId);
          // Same O-01 resolution as lockEvaluate: dispatching a UUID-named
          // worktree that was created under the slug launches training against
          // an empty directory.
          const worktree = worktreeDir(evorRoot, nodeId, c.node_name);
          return { node_id: nodeId, worktree, eval_version: c.eval_version };
        });
      } catch (e) {
        // One unknown candidate fails the batch: a partial launch would leave
        // the caller believing every candidate started.
        return err(String(e instanceof Error ? e.message : e));
      }

      const result = forgeDispatchBatch(run_id, resolvedCandidates, runDir, gpu_fraction);
      return ok(result);
    },
  );

  // ── evor_wiki_summarize ─────────────────────────────────────────────────────
  server.tool(
    "evor_wiki_summarize",
    "Summarise wiki lessons by approach_family and hypothesis_verdict. "
    + "Returns {confirmed, refuted, inconclusive, by_family}.",
    {
      run_id: z.string().optional().describe("Active run identifier (used to locate evor_root)"),
      confirmed_only: z.boolean().optional().describe(
        "If true, only include confirmed-hypothesis lessons (default false)",
      ),
      limit: z.number().int().min(1).optional().describe(
        "Maximum lessons to include in the summary (default 100)",
      ),
      evor_root: z.string().optional().describe(
        "Path to .evor/ root (default: EVOR_ROOT env or cwd/.evor)",
      ),
    },
    async ({ run_id, confirmed_only, limit, evor_root }) => {
      const missionId = process.env.EVOR_MISSION_ID;
      const runDir = run_id ? resolveRunPaths(run_id, missionId).runDir : undefined;
      const result = wikiSummarize(run_id, runDir, confirmed_only, limit, evor_root);
      if (!result.ok) return err(result.error ?? "evor_wiki_summarize failed");
      return ok(result.data);
    },
  );

  // ── evor_gotchas_list ───────────────────────────────────────────────────────
  server.tool(
    "evor_gotchas_list",
    "List accumulated gotchas from the GotchaStore. "
    + "Returns {gotchas: [...], total: N} sorted by confidence descending.",
    {
      run_id: z.string().optional().describe(
        "Active run identifier; if provided, also reads mission-scoped gotchas",
      ),
      evor_root: z.string().optional().describe(
        "Path to .evor/ root (default: EVOR_ROOT env or cwd/.evor)",
      ),
      kind: z
        .enum(["runtime-failure", "hardware-constraint", "approach-deadend"])
        .optional()
        .describe("Filter by gotcha kind; omit for all kinds"),
      scope: z.enum(["global", "mission"]).optional().describe(
        "Filter by scope; omit for all scopes",
      ),
      min_confidence: z.number().min(0).max(1).optional().describe(
        "Minimum confidence threshold (0.0–1.0); default 0.0",
      ),
    },
    async ({ run_id, evor_root, kind, scope, min_confidence }) => {
      const missionId = process.env.EVOR_MISSION_ID;
      const runDir = run_id ? resolveRunPaths(run_id, missionId).runDir : undefined;
      const result = gotchasList(kind, scope, min_confidence, evor_root, runDir);
      if (!result.ok) return err(result.error ?? "evor_gotchas_list failed");
      return ok(result.data);
    },
  );

  // ── evor_lock_evaluate ────────────────────────────────────────────────────────
  server.tool(
    "evor_lock_evaluate",
    "Lock a node's evaluate.py so it cannot be mutated after evaluation begins. "
    + "Fingerprints the script and makes it read-only. Call once, right before "
    + "scoring a node. Returns {ok, node_name}.",
    {
      run_id: z.string().describe("Active run identifier"),
      node: z.string().describe("The node's name (e.g. 'immune-memory-02')"),
    },
    async ({ run_id, node }) => {
      const missionId = process.env.EVOR_MISSION_ID;
      const result = lockEvaluate(run_id, node, missionId);
      return ok(result);
    },
  );

  // ── evor_verify_artifacts ─────────────────────────────────────────────────────
  server.tool(
    "evor_verify_artifacts",
    "Confirm a node externalized its training deliverables (results + telemetry). "
    + "Returns {ok, has_results, has_telemetry, node_name} — booleans only. "
    + "Use after a node finishes to verify it actually produced output.",
    {
      run_id: z.string().describe("Active run identifier"),
      node: z.string().describe("The node's name (e.g. 'immune-memory-02')"),
    },
    async ({ run_id, node }) => {
      const missionId = process.env.EVOR_MISSION_ID;
      const result = verifyArtifacts(run_id, node, missionId);
      return ok(result);
    },
  );
}
