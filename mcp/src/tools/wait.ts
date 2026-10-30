/**
 * tools/wait.ts
 * evor_wait — hold the caller's turn until a job finishes, a process exits or an
 * artifact is written, or until `wait_s` runs out.
 *
 * Every other wait in the system depends on the host delivering a notice, and in
 * the 2026-10-30 binarization mission that failed three different ways:
 *   - in a backgrounded session every sub-agent spawn returned at once, so a
 *     foreground `Agent` call stopped being a wait;
 *   - Forge's Monitor posted "TRAINER EXITED" at 07:08 and the notice sat queued
 *     until 08:28, when main happened to message Forge;
 *   - the tick yielded on an `evor_run_start` job, which no host task tracks, so
 *     nothing could ever wake main, and main was not allowed to Monitor it.
 * A call that blocks inside the turn needs no notice. It holds the turn while it
 * runs and returns a definite answer. On a timeout the caller calls it again.
 */

import { existsSync } from "fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveRunPaths } from "../run-store.js";
import { resolveRunId } from "../active-run.js";
import { err, ok } from "../tool-result.js";
import { jobStatus } from "./compute.js";
import { artifactPathFor, VALID_AGENTS } from "./artifact.js";

/** Upper bound for one call. Kept under ten minutes so no host tool timeout is near. */
export const MAX_WAIT_S = 540;
const DEFAULT_WAIT_S = 300;
const POLL_MS = 5_000;

type Probe = () => { done: boolean; detail?: Record<string, unknown>; error?: string };

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Poll `probe` until it reports done, errors, or `waitS` elapses. */
export async function waitFor(probe: Probe, waitS: number, pollMs = POLL_MS) {
  const started = Date.now();
  const deadline = started + Math.max(0, waitS) * 1000;
  for (;;) {
    const r = probe();
    const waited_s = Math.round((Date.now() - started) / 1000);
    if (r.error) return { done: false, waited_s, error: r.error };
    if (r.done) return { done: true, waited_s, ...(r.detail ?? {}) };
    if (Date.now() + pollMs > deadline) return { done: false, waited_s, ...(r.detail ?? {}) };
    await new Promise((res) => setTimeout(res, pollMs));
  }
}

export function registerWaitTools(server: McpServer): void {
  server.tool(
    "evor_wait",
    "BLOCK until a condition holds, holding your turn: an evor job finishes (job_id), a " +
      "process exits (pid), or a tick artifact is written (artifact). Returns {done:true,...} " +
      "as soon as it holds, or {done:false} after wait_s (default 300, max 540). On done:false, " +
      "call evor_wait again — do NOT end your turn to wait, because nothing is guaranteed to " +
      "wake you. Give exactly one of job_id, pid, artifact.",
    {
      run_id: z.string().optional().describe("Active run identifier; resolved from the active run when omitted"),
      job_id: z.string().optional().describe("Wait for this evor_run_start job to leave state 'running'"),
      pid: z.number().int().positive().optional().describe("Wait for this process to exit (e.g. a trainer)"),
      artifact: z
        .object({
          tick: z.number().int().min(0),
          agent: z.string(),
          kind: z.string().optional(),
        })
        .optional()
        .describe("Wait for this tick artifact to be written"),
      wait_s: z.number().int().min(0).max(MAX_WAIT_S).optional()
        .describe(`Seconds to wait at most (default ${DEFAULT_WAIT_S}, max ${MAX_WAIT_S})`),
      mission_id: z.string().optional().describe("Mission id; resolved from the active run when omitted"),
    },
    async ({ run_id, job_id, pid, artifact, wait_s, mission_id }) => {
      const given = [job_id, pid, artifact].filter((v) => v !== undefined).length;
      if (given !== 1) return err("give exactly one of job_id, pid, artifact");
      const waitS = wait_s ?? DEFAULT_WAIT_S;

      if (pid !== undefined) {
        const r = await waitFor(() => ({ done: !pidAlive(pid) }), waitS);
        return ok({ ...r, condition: `pid:${pid}`, ...(r.done ? {} : { next: "still running — call evor_wait again" }) });
      }

      let runDir: string;
      try {
        const rid = resolveRunId(run_id);
        // An empty id would resolve to the mission directory, where no job or
        // artifact ever appears, and the caller would be told to wait forever.
        if (!rid) return err("no run_id given and no active run found — pass run_id");
        runDir = resolveRunPaths(rid, mission_id ?? process.env.EVOR_MISSION_ID).runDir;
      } catch (e) {
        return err(`cannot resolve the run: ${String(e)}`);
      }

      if (job_id !== undefined) {
        const r = await waitFor(() => {
          const s = jobStatus(job_id, runDir);
          if (!s.ok) return { done: false, error: s.error ?? "evor_run_status failed" };
          const data = { ...((s.data ?? {}) as Record<string, unknown>) };
          delete data.cmd;
          // "unknown" means there is no such job: an answer of done would send the
          // caller on to record a result that does not exist.
          if (data.state === "unknown" || typeof data.state !== "string") {
            return { done: false, error: String(data.error ?? `job ${job_id} has no status`) };
          }
          return { done: data.state !== "running", detail: { status: data } };
        }, waitS);
        if (r.error) return err(r.error);
        return ok({ ...r, condition: `job:${job_id}`, ...(r.done ? {} : { next: "still running — call evor_wait again" }) });
      }

      // Waiting on a path no writer produces never ends, so refuse it here.
      const agent = artifact!.agent.replace(/^(oh-my-evor:)?evor-/, "");
      if (!(VALID_AGENTS as readonly string[]).includes(agent)) {
        return err(`unknown artifact agent ${JSON.stringify(artifact!.agent)}; one of ${VALID_AGENTS.join(", ")}`);
      }
      if ((agent === "sage-junior" || agent === "acquirer") && !artifact!.kind) {
        return err(`${agent} artifacts are per kind: pass artifact.kind (the junior's angle slug or the acquirer's source slug)`);
      }
      artifact!.agent = agent;
      const path = artifactPathFor(runDir, artifact!.tick, agent, artifact!.kind);
      const r = await waitFor(() => ({ done: existsSync(path) }), waitS);
      return ok({
        ...r,
        condition: `artifact:${artifact!.agent}${artifact!.kind ? `/${artifact!.kind}` : ""}@tick${artifact!.tick}`,
        ...(r.done
          ? { next: "written — read it with evor_read_artifact" }
          : { next: "not written yet — call evor_wait again" }),
      });
    },
  );
}
