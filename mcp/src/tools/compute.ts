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
 * evor_init_eval_suite — create initial evaluation suite (wraps `evor.benchmark init-eval-suite`)
 * evor_meta_evolve     — update strategy.json (wraps `evor.tree meta-evolve`)
 * evor_distill_scan    — brownfield workspace scan (wraps `evor distill scan`)
 * evor_plot_report     — render tree png/html (wraps `evor.plot_tree`)
 * evor_wiki_summarize  — summarise wiki lessons by family/verdict (wraps `evor.wiki summarize`)
 * evor_gotchas_list    — list accumulated gotchas (wraps `evor gotchas`)
 */

import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { join } from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveRunPaths, getEvorRoot, getActiveRunPath } from "../run-store.js";
import { callPythonModule, type PyResult } from "../subprocess-bridge.js";
import { resolveNodeRef } from "./node-ref.js";

// ── Shared helpers ────────────────────────────────────────────────────────────

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function err(msg: string) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }] };
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
  const nodeId = resolveNodeRef(runId, nodeRef, missionId);
  const worktree = join(getEvorRoot(), "worktrees", nodeId);
  const evalPath = join(worktree, "evaluate.py");
  if (!existsSync(evalPath)) {
    return {
      ok: false,
      node_name: nodeRef,
      error: "evaluate.py is not present in the node worktree — materialize the genome first.",
    };
  }
  try {
    const hash = createHash("sha256").update(readFileSync(evalPath)).digest("hex");
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
  const nodeId = resolveNodeRef(runId, nodeRef, missionId);
  const nodeDir = join(resolveRunPaths(runId, missionId).runDir, "nodes", nodeId);
  const present = (rel: string, minBytes: number): boolean => {
    try {
      const p = join(nodeDir, rel);
      return existsSync(p) && statSync(p).size > minBytes;
    } catch {
      return false;
    }
  };
  const has_results = present("results.json", 2);
  const has_telemetry = present("telemetry.jsonl", 0);
  return { ok: has_results && has_telemetry, node_name: nodeRef, has_results, has_telemetry };
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
      const resolvedNodeId = resolveNodeRef(run_id, node_id, missionId);
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

        // Zero-item guard: a freeze that captured nothing means the location
        // held no data files (usually it points at a folder of sub-folders, or
        // the wrong folder). Freezing an empty eval set silently would let the
        // whole run proceed with nothing to evaluate against — fail loudly with
        // actionable guidance instead of returning a hollow ok:true.
        const testCount = Number(clean.test_item_count ?? 0);
        const valCount = Number(clean.val_item_count ?? 0);
        if (testCount === 0 && valCount === 0) {
          return err(
            "no data items were found to freeze at the given location — nothing was captured. " +
            "The location should directly contain the individual data files (not sub-folders). " +
            "Point it at the folder that holds the files themselves and try again.",
          );
        }

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
      const resolvedCandidates: BatchCandidate[] = candidates.map((c) => {
        const nodeId = resolveNodeRef(run_id, c.node_name, missionId);
        const worktree = join(evorRoot, "worktrees", nodeId);
        return { node_id: nodeId, worktree, eval_version: c.eval_version };
      });

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
