/**
 * tools/compute.ts
 * Compute-wrapper MCP tools (WS-B): async training-job launcher + sync harness wrappers.
 *
 * evor_run_start       — launch `python -m evor run` detached; returns {status, job_id} instantly
 * evor_run_status      — read job status (no internal paths or cmd exposed)
 * evor_capability      — probe hardware (wraps `evor capability`)
 * evor_preflight       — smoke-test environment (wraps `evor preflight`)
 * evor_validate        — validate run configuration and split integrity
 * evor_doctor          — environment + .evor integrity (wraps `evor doctor`)
 * evor_freeze_splits   — freeze test/val splits (wraps `evor.freeze freeze-splits`)
 * evor_init_eval_suite    — create initial evaluation suite (wraps `evor.benchmark init-eval-suite`)
 * evor_seal_eval_script   — hash the canonical evaluator and lock its sha256 into goal-contract.json
 * evor_meta_evolve        — update strategy.json (wraps `evor.tree meta-evolve`)
 * evor_distill_scan    — brownfield workspace scan (wraps `evor distill scan`)
 * evor_plot_report     — render tree png/html (wraps `evor.plot_tree`)
 * evor_wiki_summarize  — summarise wiki lessons by family/verdict (wraps `evor.wiki summarize`)
 * evor_gotchas_list    — list accumulated gotchas (wraps `evor gotchas`)
 */

import { appendFileSync, chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { join } from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveRunPaths, getEvorRoot, getActiveRunPath } from "../run-store.js";
import { callPythonModule, type PyResult } from "../subprocess-bridge.js";
import { resolveNodeRef, tryResolveNodeRef } from "./node-ref.js";
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
 * Dispatch multiple candidate training jobs in parallel to the compute backend.
 * Returns job results for all candidates immediately without blocking — each
 * job is started via jobStart (evor.jobs start), which spawns a detached
 * supervisor and returns instantly. Poll each with evor_run_status.
 * Use instead of sequential evor_run_start calls when VRAM allows parallel
 * training (P0-3).
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
  if (nodeId === null) {
    return {
      ok: false,
      node_name: nodeRef,
      error: `node '${nodeRef}' is not in this run's tree — check the name with evor_tree_read.`,
    };
  }
  const worktree = join(getEvorRoot(), "worktrees", nodeId);
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
  try {
    const { runDir } = resolveRunPaths(runId, missionId);
    const contractPath = join(runDir, "goal-contract.json");
    if (existsSync(contractPath)) {
      const contract = JSON.parse(readFileSync(contractPath, "utf8")) as Record<string, unknown>;
      contractHash = typeof contract.eval_script_hash === "string" ? contract.eval_script_hash : "";
    }
  } catch {
    // Fail-open: if we can't read the contract (run dir missing, parse error, etc.), proceed.
  }

  try {
    const hash = createHash("sha256").update(readFileSync(evalPath)).digest("hex");

    if (contractHash && contractHash !== hash) {
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

export function registerComputeTools(server: McpServer): void {

  // ── evor_run_start ──────────────────────────────────────────────────────────
  server.tool(
    "evor_run_start",
    "Launch candidate node as a detached background job. "
    + "Returns {status, job_id} instantly — poll progress with evor_run_status.",
    {
      run_id: z.string().describe("Active run identifier"),
      node_id: z.string().describe("The node's name (e.g. 'immune-memory-02')"),
      run_dir: z.string().optional().describe(
        "Absolute path to the run directory; derived from run_id when omitted",
      ),
      worktree: z.string().describe("Absolute path to the candidate git worktree"),
      eval_version: z.string().optional().describe("Eval suite version override (e.g. v1)"),
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
    + "Two modes: mode='full' (default) runs the 5-step micro-train + import/GPU checks — "
    + "checks: import_ok, loss_decreasing, gpu_active; returns {run_id, checks, passed}. "
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
    "Create the initial evaluation suite for a new mission. "
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
    "Hash the canonical evaluator script (eval-suites/<eval_version>.py) and lock its "
    + "sha256 into goal-contract.json so the integrity gate's no_eval_shift check "
    + "verifies against a real value. Call once after the canonical evaluator is written.",
    {
      run_id: z.string().describe("Active run identifier"),
      eval_version: z.string().describe("Eval version string (e.g. v1)"),
      mission_id: z.string().optional().describe("Mission ID; defaults to EVOR_MISSION_ID env"),
    },
    async ({ run_id, eval_version, mission_id }) => {
      const resolvedMission = mission_id ?? process.env.EVOR_MISSION_ID;
      const { runDir } = resolveRunPaths(run_id, resolvedMission);
      const evalScriptPath = `${runDir}/eval-suites/${eval_version}.py`;
      if (!existsSync(evalScriptPath)) {
        return err(
          "no evaluation script found for this version — write the canonical evaluator before sealing it, then try again.",
        );
      }
      const content = readFileSync(evalScriptPath);
      const hash = createHash("sha256").update(content).digest("hex");

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
      let receipt: { hash?: string; sealed_at?: string } | null = null;
      try { receipt = JSON.parse(readFileSync(receiptPath, "utf8")); } catch { receipt = null; }

      if (receipt?.hash && receipt.hash !== hash) {
        return err(
          `refusing to re-seal ${eval_version}: this run sealed it at ` +
          `${String(receipt.sealed_at ?? "an earlier time")} with hash ` +
          `${receipt.hash.slice(0, 12)}…, and the file on disk now hashes to ${hash.slice(0, 12)}…. ` +
          `The evaluator changed after it was sealed. Re-sealing would make the changed file ` +
          `the sealed one and retroactively validate every score recorded under the old anchor — ` +
          `which is what happened at 23:49 in the field run. If replacing the evaluator is ` +
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
        return err(
          `could not take custody of ${eval_version}: ${String(e)}. The evaluator is ` +
          `hardlinked outside the run, so sealing it would anchor a file another path can ` +
          `still rewrite.`,
        );
      }

      patchGoalContract(runDir, { eval_script_hash: hash });

      // The receipt is what makes the NEXT call able to tell a tamper from a
      // first seal. Written after custody, so it attests the file this run owns.
      try {
        writeFileSync(
          receiptPath,
          JSON.stringify({ eval_version, hash, sealed_at: new Date().toISOString() }, null, 2),
          "utf8",
        );
      } catch { /* unwritable run dir — the contract anchor still stands */ }

      return ok({ ok: true, eval_version });
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
    "Dispatch multiple candidate training jobs in parallel to the compute backend. "
    + "Returns job_ids for all candidates immediately without waiting for completion. "
    + "Poll each job with evor_run_status. "
    + "Use instead of sequential evor_run_start calls when VRAM allows parallel training.",
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
          const worktree = join(evorRoot, "worktrees", nodeId);
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
