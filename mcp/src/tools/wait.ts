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

import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveRunPaths } from "../run-store.js";
import { resolveRunId } from "../active-run.js";
import { err, ok } from "../tool-result.js";
import { jobStatus } from "./compute.js";
import { artifactPathFor, VALID_AGENTS } from "./artifact.js";

/** Upper bound for one call. Kept under ten minutes so no host tool timeout is near. */
export const MAX_WAIT_S = 540;
/** A heartbeat runs as a background task and returns only on a stall, or at this cap. */
export const HEARTBEAT_MAX_S = 6 * 3600;
const DEFAULT_WAIT_S = 300;
const POLL_MS = 5_000;

/** How long a finished transcript must stay quiet before its agent counts as stopped. */
const STOPPED_QUIET_MS = 15_000;

/**
 * Has the agent with this id stopped? Finds subagents/agent-<id>.jsonl under any
 * session of ~/.claude/projects and reads its last record. True only for a final
 * assistant message that is not a tool call, in a transcript quiet for
 * STOPPED_QUIET_MS. Anything unreadable counts as running, so the wait goes on.
 */
export function agentStopped(agentId: string, projectsDir = join(homedir(), ".claude", "projects"), now = Date.now()): boolean {
  return agentOutcome(agentId, projectsDir, now).stopped;
}

/**
 * Whether the agent stopped, and its final message when it did. A child with no
 * artifact slot (forge-junior) reports only through that message, and an async
 * spawn delivers it as a notice after the parent's turn ends. Returning it here
 * lets the parent wait for the child and read its result in the same turn, which
 * is what a foreground spawn used to do.
 */
export function agentOutcome(
  agentId: string,
  projectsDir = join(homedir(), ".claude", "projects"),
  now = Date.now(),
): { stopped: boolean; found: boolean; text?: string } {
  if (!/^[A-Za-z0-9_-]+$/.test(agentId)) return { stopped: false, found: false };
  let projects: string[];
  try { projects = readdirSync(projectsDir); } catch { return { stopped: false, found: false }; }
  for (const proj of projects) {
    let sessions: string[];
    try { sessions = readdirSync(join(projectsDir, proj)); } catch { continue; }
    for (const sess of sessions) {
      const path = join(projectsDir, proj, sess, "subagents", `agent-${agentId}.jsonl`);
      if (!existsSync(path)) continue;
      try {
        if (now - statSync(path).mtimeMs < STOPPED_QUIET_MS) return { stopped: false, found: true };
        const lines = readFileSync(path, "utf8").trimEnd().split("\n");
        const last = JSON.parse(lines[lines.length - 1]);
        const reason = last?.message?.stop_reason;
        const stopped = last?.type === "assistant" && typeof reason === "string" && reason !== "tool_use";
        if (!stopped) return { stopped: false, found: true };
        const content = last?.message?.content;
        const text = Array.isArray(content)
          ? content.filter((c: { type?: string }) => c?.type === "text").map((c: { text?: string }) => c.text ?? "").join("\n")
          : typeof content === "string" ? content : "";
        return { stopped: true, found: true, text };
      } catch {
        return { stopped: false, found: true };
      }
    }
  }
  return { stopped: false, found: false };
}

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
/**
 * Newest modification time among the files that move while a tick makes progress:
 * the run's state and artifacts, its jobs and node telemetry, and the trainers'
 * logs in the worktrees beside it. Bounded depth keeps one scan cheap.
 */
/** Present while a heartbeat wait runs; the stop hook reads it to see one is armed. */
export const HEARTBEAT_FILE = "heartbeat.json";

export function lastActivity(runDir: string): number {
  let newest = 0;
  const visit = (dir: string, depth: number) => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (e === HEARTBEAT_FILE || e.startsWith("stop-blocks-")) continue;
      const p = join(dir, e);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { if (depth > 0) visit(p, depth - 1); }
      else if (st.mtimeMs > newest) newest = st.mtimeMs;
    }
  };
  visit(runDir, 4);
  // <evor root>/runs/<mission>/<run> → <evor root>/worktrees/<node>/{train.log,telemetry.jsonl,...}
  visit(join(runDir, "..", "..", "..", "worktrees"), 1);
  return newest;
}

export async function waitFor(probe: Probe, waitS: number, pollMs = POLL_MS, signal?: AbortSignal) {
  const started = Date.now();
  const deadline = started + Math.max(0, waitS) * 1000;
  for (;;) {
    if (signal?.aborted) return { done: false, waited_s: Math.round((Date.now() - started) / 1000), cancelled: true };
    const r = probe();
    const waited_s = Math.round((Date.now() - started) / 1000);
    if (r.error) return { done: false, waited_s, error: r.error };
    if (r.done) return { done: true, waited_s, ...(r.detail ?? {}) };
    if (Date.now() + pollMs > deadline) return { done: false, waited_s, ...(r.detail ?? {}) };
    await new Promise<void>((res) => {
      const t = setTimeout(res, pollMs);
      signal?.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true });
    });
  }
}

/** Run dirs with a heartbeat running in THIS server process. */
const armedHere = new Set<string>();

function pidAliveAny(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

export function registerWaitTools(server: McpServer): void {
  server.tool(
    "evor_wait",
    "Wait for a condition: an evor job finishes (job_id), a process exits (pid), a tick " +
      "artifact is written (artifact), an agent stops (agent_id), or the whole run stalls " +
      "(heartbeat). Returns {done:true,...} as soon as it holds, or {done:false} after wait_s " +
      "(default 300, max 540; a heartbeat waits up to six hours). Use it only for what nothing " +
      "will report: an agent you spawned, and a background task you started, wake you when " +
      "they finish. Give exactly one of job_id, pid, artifact, agent_id, heartbeat.",
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
      agent_id: z.string().optional().describe(
        "Wait for this child agent (the agentId in its spawn result) to finish, and return its " +
          "final message as `result`. For children with no artifact slot, e.g. forge-junior.",
      ),
      producer_agent_id: z.string().optional().describe(
        "With artifact: the agentId of the child that owes it (from the spawn result). If that " +
          "child stops without writing it, the wait returns at once with producer_stopped:true " +
          "instead of running out the clock.",
      ),
      heartbeat: z.boolean().optional().describe(
        "Watch the whole run instead of one condition. It runs in the background and returns " +
          "stalled:true only when nothing in the run (tick state, artifacts, jobs, node telemetry, " +
          "trainer logs) has changed for quiet_s; otherwise it keeps waiting, up to wait_s " +
          "(default six hours). One heartbeat at a time: while one runs, a second call returns " +
          "at once with already_armed:true. For the orchestrator, after a tick yields: a lost " +
          "completion notice then still leads back to the tick.",
      ),
      quiet_s: z.number().int().min(60).max(3600).optional().describe(
        "With heartbeat: seconds without any change that count as stalled (default 600)",
      ),
      wait_s: z.number().int().min(0).max(HEARTBEAT_MAX_S).optional()
        .describe(`Seconds to wait at most (default ${DEFAULT_WAIT_S}, max ${MAX_WAIT_S}; a heartbeat defaults to and allows up to ${HEARTBEAT_MAX_S})`),
      mission_id: z.string().optional().describe("Mission id; resolved from the active run when omitted"),
    },
    async ({ run_id, job_id, pid, artifact, wait_s, mission_id, producer_agent_id, agent_id, heartbeat, quiet_s }, extra) => {
      const given = [job_id, pid, artifact, agent_id, heartbeat || undefined].filter((v) => v !== undefined).length;
      if (given !== 1) return err("give exactly one of job_id, pid, artifact, agent_id, heartbeat");
      const waitS = heartbeat ? (wait_s ?? HEARTBEAT_MAX_S) : Math.min(wait_s ?? DEFAULT_WAIT_S, MAX_WAIT_S);

      if (heartbeat) {
        let hbRunDir: string;
        try {
          const rid = resolveRunId(run_id);
          if (!rid) return err("no run_id given and no active run found — pass run_id");
          hbRunDir = resolveRunPaths(rid, mission_id ?? process.env.EVOR_MISSION_ID).runDir;
        } catch (e) {
          return err(`cannot resolve the run: ${String(e)}`);
        }
        const quietMs = (quiet_s ?? 600) * 1000;
        let last = lastActivity(hbRunDir);
        const marker = join(hbRunDir, HEARTBEAT_FILE);
        let armedElsewhere = false;
        try {
          const hb = JSON.parse(readFileSync(marker, "utf8"));
          armedElsewhere = Number(hb.until) > Date.now() && Number(hb.pid) !== process.pid && pidAliveAny(Number(hb.pid));
        } catch { /* none armed */ }
        if (armedHere.has(hbRunDir) || armedElsewhere) {
          return ok({
            condition: "heartbeat",
            already_armed: true,
            next: "a heartbeat is already running and wakes you on a stall: end your turn",
          });
        }
        armedHere.add(hbRunDir);
        try { writeFileSync(marker, JSON.stringify({ armed_at: Date.now(), until: Date.now() + waitS * 1000, pid: process.pid })); } catch { /* the wait works without it */ }
        let r;
        try {
          r = await waitFor(() => {
            last = lastActivity(hbRunDir);
            return { done: Date.now() - last > quietMs };
          }, waitS, 15_000, extra?.signal);
        } finally {
          armedHere.delete(hbRunDir);
          try {
            if (Number(JSON.parse(readFileSync(marker, "utf8")).pid) === process.pid) rmSync(marker, { force: true });
          } catch { /* already gone */ }
        }
        const ageS = Math.round((Date.now() - last) / 1000);
        return ok({
          condition: "heartbeat",
          stalled: r.done,
          waited_s: r.waited_s,
          last_activity_age_s: ageS,
          next: r.done
            ? `nothing in the run has changed for ${ageS}s: if no agent of the tick is running, resume the evor-tick agent with SendMessage and tell it to check its children`
            : "the run is still active: arm the heartbeat again and end your turn",
        });
      }

      if (agent_id !== undefined) {
        let outcome = agentOutcome(agent_id);
        const r = await waitFor(() => {
          outcome = agentOutcome(agent_id);
          return { done: outcome.stopped };
        }, waitS);
        if (!outcome.found) return err(`no transcript found for agent ${agent_id}; pass the agentId from its spawn result`);
        return ok({
          ...r,
          condition: `agent:${agent_id}`,
          ...(r.done ? { result: outcome.text ?? "" } : { next: "still working — end your turn; its completion notice wakes you" }),
        });
      }

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
      if (agent === "forge-junior") {
        return err("forge-junior has no artifact slot: it reports through its final message. Wait with evor_wait({ agent_id: <its agentId> }), which returns that message as `result`.");
      }
      if ((agent === "sage-junior" || agent === "acquirer") && !artifact!.kind) {
        return err(`${agent} artifacts are per kind: pass artifact.kind (the junior's angle slug or the acquirer's source slug)`);
      }
      artifact!.agent = agent;
      const path = artifactPathFor(runDir, artifact!.tick, agent, artifact!.kind);
      let producerStopped = false;
      const r = await waitFor(() => {
        if (existsSync(path)) return { done: true };
        // In the binarization mission's tick 3, Sage exited without its artifact
        // and the tick sat in a 540 s wait for a file nobody would write.
        if (producer_agent_id && agentStopped(producer_agent_id)) {
          producerStopped = existsSync(path) ? false : true;
          return { done: existsSync(path), error: producerStopped ? "__stopped__" : undefined };
        }
        return { done: false };
      }, waitS);
      if (producerStopped) {
        return ok({
          done: false,
          producer_stopped: true,
          waited_s: r.waited_s,
          condition: `artifact:${artifact!.agent}${artifact!.kind ? `/${artifact!.kind}` : ""}@tick${artifact!.tick}`,
          next: "the producing agent stopped without writing this artifact — read its result, then resume it with SendMessage or record the gap; do not wait again",
        });
      }
      return ok({
        ...r,
        condition: `artifact:${artifact!.agent}${artifact!.kind ? `/${artifact!.kind}` : ""}@tick${artifact!.tick}`,
        ...(r.done
          ? { next: "written — read it with evor_read_artifact" }
          : { next: "not written yet — if the agent that owes it is running, end your turn: its completion notice wakes you" }),
      });
    },
  );
}
