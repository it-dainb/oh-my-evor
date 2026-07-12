/**
 * tools/schedule.ts
 * evor_schedule — submit a training job to the ResourceScheduler
 *                 (launches python -m evor run as a background process)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveRunPaths } from "../run-store.js";
import { callBridge } from "../subprocess-bridge.js";

const JobSpecSchema = z.object({
  worktree: z.string().describe("Path to the candidate worktree"),
  node_id: z.string().describe("Node being trained"),
  gpu_ids: z.array(z.number().int()).optional().describe("GPU indices to pin; omit for scheduler choice"),
  timeout_seconds: z.number().int().optional().describe("Hard wall-clock timeout for the job"),
  extra: z.record(z.string(), z.unknown()).optional().describe("Pass-through to harness CLI"),
});

// ── Core logic (exported for tests) ────────────────────────────────────────

/**
 * Submit a training job to the ResourceScheduler.
 * The bridge launches `python -m evor run` as a detached subprocess and
 * returns immediately with {job_id, pid, status: "submitted"}.
 */
export function scheduleJob(
  runId: string,
  nodeId: string,
  worktree: string,
  opts?: { runDir?: string; timeoutSeconds?: number }
): { ok: boolean; jobId?: string; pid?: number; status?: string; error?: string } {
  const bridgeArgs = [
    "--run-id", runId,
    "--node-id", nodeId,
    "--worktree", worktree,
  ];
  if (opts?.runDir) {
    bridgeArgs.push("--run-dir", opts.runDir);
  }
  if (opts?.timeoutSeconds !== undefined) {
    bridgeArgs.push("--timeout", String(opts.timeoutSeconds));
  }

  const result = callBridge("scheduler_bridge.py", bridgeArgs, { timeout: 10_000 });
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  const data = result.data as Record<string, unknown>;
  return {
    ok: true,
    jobId: data.job_id as string,
    pid: data.pid as number | undefined,
    status: data.status as string,
  };
}

// ── Tool registration ───────────────────────────────────────────────────────

export function registerScheduleTools(server: McpServer): void {
  server.tool(
    "evor_schedule",
    "Submit a training job to the ResourceScheduler and return immediately. " +
    "Returns a job_handle to track the job and its current status.",
    {
      run_id: z.string().describe("Active run identifier"),
      node_id: z.string().describe("Node being trained"),
      job_spec: JobSpecSchema.describe("Job specification for the ResourceScheduler"),
    },
    async ({ run_id, node_id, job_spec }) => {
      const missionId = process.env.EVOR_MISSION_ID;
      const paths = resolveRunPaths(run_id, missionId);

      const result = scheduleJob(run_id, node_id, job_spec.worktree, {
        runDir: paths.runDir,
        timeoutSeconds: job_spec.timeout_seconds,
      });

      if (!result.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: result.error ?? "schedule failed" }),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ok: true,
              job_handle: result.jobId ?? null,
              status: result.status ?? "submitted",
            }),
          },
        ],
      };
    }
  );
}
