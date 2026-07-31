/**
 * mcp/tests/hooks-runid-fallback.test.ts — Phase 0.1 (RALPLAN-DR REV 5)
 *
 * Root cause under test: `hooks/session-start.mjs` sets EVOR_ACTIVE_RUN_ID on
 * `process.env` inside its OWN subprocess. A hook subprocess cannot propagate an
 * env var to sibling hook subprocesses, so every hook that gates on
 * `process.env.EVOR_ACTIVE_RUN_ID` is permanently inert. Observed consequence in
 * run 29d17abc: the entire enforcement layer never fired (SubagentStop 0/10,
 * PreToolUse 0 denials).
 *
 * The fix is the pattern already shipped in `hooks/pre-compact.mjs`: fall back to
 * `<EVOR_ROOT>/active-run.json`. This suite pins that behaviour two ways:
 *
 *   1. Unit — the shared resolver `hooks/lib/active-run.mjs`, table-driven over
 *      every (env, file) combination including the corrupt/partial cases.
 *   2. Equivalence — for each affected hook, spawning it with the env var UNSET
 *      but active-run.json present must produce the SAME observable behaviour as
 *      spawning it with the env var SET (scenario B ≡ scenario C), and both must
 *      differ from the no-run baseline (scenario C ≢ A — the non-vacuity guard
 *      that stops this test from passing because the fixture is inert anyway).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from "fs";
import { createHash } from "crypto";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

const HOOKS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../hooks");
const RESOLVER = join(HOOKS_DIR, "lib", "active-run.mjs");

const RUN_ID = "run-fallback-test";
const MISSION_ID = "mission-fallback-test";

/** Per-scenario paths handed to a hook's payload builder. */
type Ctx = { evorRoot: string; runDir: string };

/**
 * The 8 hooks that gate on EVOR_ACTIVE_RUN_ID with no file fallback (REV 5 §0.1).
 * Each payload is chosen to reach behaviour that actually depends on the resolved
 * run id — a payload the hook discards early would make the equivalence check
 * below true but meaningless (the non-vacuity guard catches that).
 */
const AFFECTED_HOOKS: Array<{ file: string; stdin: (c: Ctx) => string }> = [
  {
    file: "permission-denied.mjs",
    stdin: () => JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }),
  },
  {
    // Only acts on a forge reviewer artifact batch; anything else exits silently.
    file: "post-tool-batch.mjs",
    stdin: () =>
      JSON.stringify({
        tool_results: [
          {
            tool_name: "mcp__plugin_oh-my-evor_evor__write_artifact",
            tool_input: { agent: "forge-critic", payload: { verdict: "reject", reason: "channel mismatch" } },
          },
        ],
      }),
  },
  {
    file: "pre-tool-use.mjs",
    stdin: () => JSON.stringify({ tool_name: "Bash", tool_input: { command: "python train.py" } }),
  },
  {
    // Flips a non-terminal mission-state to "paused" — an in-place rewrite.
    file: "session-end.mjs",
    stdin: () => JSON.stringify({ reason: "clear" }),
  },
  {
    file: "stop.mjs",
    stdin: () => JSON.stringify({ stop_hook_active: false }),
  },
  {
    // Needs a role (from agent_type) AND a resolvable tick before it checks artifacts.
    file: "subagent-stop.mjs",
    stdin: () => JSON.stringify({ agent_type: "oh-my-evor:evor-sage" }),
  },
  {
    // Intent regexes are strict and anchored — "resume" alone does not match.
    file: "user-prompt-submit.mjs",
    stdin: () => JSON.stringify({ prompt: "resume the evor run" }),
  },
  {
    // Reads the status.json named in its payload; terminal state → wake message.
    file: "job-status-watcher.mjs",
    stdin: (c) => JSON.stringify({ file_path: join(c.runDir, "status.json") }),
  },
  // These two were omitted from the original table, and both still gated on the
  // raw env var with no file fallback — i.e. exactly the defect this suite exists
  // to prevent, left live in the two hooks that fire most often (PostToolUse
  // matches "*"). The omission is why the suite was green.
  {
    // Warns when a recorded node has no results.json / telemetry.jsonl — and it
    // looks for them under runDir(runId), so the warning only appears once the
    // run id resolves.
    file: "post-tool-use.mjs",
    stdin: () =>
      JSON.stringify({
        tool_name: "mcp__plugin_oh-my-evor_evor__evor_record_eval",
        tool_input: { node_id: "node-1" },
        tool_response: { ok: true },
      }),
  },
  {
    // Appends an infrastructure-failure signal to the run's signals-inbox before
    // emitting guidance — the append is what depends on the run id.
    file: "post-tool-use-failure.mjs",
    stdin: () =>
      JSON.stringify({
        tool_name: "mcp__plugin_oh-my-evor_evor__evor_run_start",
        tool_input: { node_id: "node-1" },
        tool_response: { error: "worktree path is not accessible" },
      }),
  },
];

/** Build a run fixture rich enough that the hooks have something to act on. */
function seedRun(root: string, opts: { pendingNodes?: boolean } = {}) {
  const evorRoot = join(root, ".evor");
  const runDir = join(evorRoot, "runs", MISSION_ID, RUN_ID);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(evorRoot, "active-run.json"),
    JSON.stringify({ run_id: RUN_ID, mission_id: MISSION_ID }),
  );
  writeFileSync(
    join(runDir, "run-state.json"),
    JSON.stringify({
      run_id: RUN_ID,
      tick: 1,
      pending_node_ids: opts.pendingNodes === false ? [] : ["node-1"],
    }),
  );
  writeFileSync(
    join(runDir, "mission-state.json"),
    JSON.stringify({ status: "running", tick: 1 }),
  );
  // subagent-stop resolves the tick from here when EVOR_CURRENT_TICK is unset.
  writeFileSync(join(runDir, "tick-state.json"), JSON.stringify({ tick: 1 }));
  // job-status-watcher reads the status.json named in its payload.
  writeFileSync(
    join(runDir, "status.json"),
    JSON.stringify({ state: "failed", job_id: "job-1", node_id: "node-1", error: "CUDA OOM" }),
  );
  return { evorRoot, runDir };
}

/** Snapshot of everything a hook run is allowed to be judged on. */
type Observable = { status: number | null; stdout: string; stderr: string; files: string[] };

/**
 * path → content digest for every file under `dir`. Content, not just names:
 * `session-end.mjs` rewrites an EXISTING mission-state.json in place, so a
 * name-only snapshot would report "no change" for a hook that did its whole job.
 */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string, prefix: string) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(d, e.name), rel);
      else {
        let body = "";
        try {
          body = readFileSync(join(d, e.name), "utf8");
        } catch {
          body = "<unreadable>";
        }
        out.set(rel, createHash("sha256").update(body).digest("hex").slice(0, 16));
      }
    }
  };
  walk(dir, "");
  return out;
}

/**
 * Runs a hook and reports only what the hook itself changed. `files` is the
 * DELTA against a pre-run snapshot — seeded fixture files must never count as
 * evidence that a hook did something, or the non-vacuity guard below passes for
 * free on any hook that stays inert.
 */
function runHook(script: string, env: Record<string, string>, stdin: string, watchDir: string): Observable {
  const before = snapshot(watchDir);
  const r = spawnSync(process.execPath, [script], {
    input: stdin,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
    encoding: "utf8",
    timeout: 10_000,
  });
  const after = snapshot(watchDir);
  const touched: string[] = [];
  for (const [path, digest] of after) {
    if (before.get(path) !== digest) touched.push(path);
  }
  for (const path of before.keys()) if (!after.has(path)) touched.push(`${path} (deleted)`);
  return {
    status: r.status,
    stdout: (r.stdout ?? "").trim(),
    stderr: (r.stderr ?? "").trim(),
    files: touched.sort(),
  };
}

// ─── 1. Unit: the shared resolver ────────────────────────────────────────────

describe("hooks/lib/active-run.mjs — run-id resolution", () => {
  let tmpDir: string;
  let evorRoot: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "evor-runid-"));
    evorRoot = join(tmpDir, ".evor");
    mkdirSync(evorRoot, { recursive: true });
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  /** Invoke the resolver in a child process with a controlled env. */
  function resolveIn(env: Record<string, string>) {
    const code = `
      import { resolveActiveRun } from ${JSON.stringify(RESOLVER)};
      process.stdout.write(JSON.stringify(resolveActiveRun()));
    `;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", EVOR_ROOT: evorRoot, ...env },
      encoding: "utf8",
      timeout: 10_000,
    });
    if (r.status !== 0) throw new Error(`resolver failed: ${r.stderr}`);
    return JSON.parse(r.stdout);
  }

  const writeActiveRun = (body: string) =>
    writeFileSync(join(evorRoot, "active-run.json"), body);

  it("uses the env var when it is set (env wins — no file read needed)", () => {
    expect(resolveIn({ EVOR_ACTIVE_RUN_ID: "env-run", EVOR_MISSION_ID: "env-mission" }))
      .toEqual({ runId: "env-run", missionId: "env-mission" });
  });

  it("falls back to active-run.json when the env var is unset", () => {
    writeActiveRun(JSON.stringify({ run_id: RUN_ID, mission_id: MISSION_ID }));
    expect(resolveIn({})).toEqual({ runId: RUN_ID, missionId: MISSION_ID });
  });

  it("takes mission_id from the file when only the run id is in the env", () => {
    writeActiveRun(JSON.stringify({ run_id: "ignored", mission_id: MISSION_ID }));
    expect(resolveIn({ EVOR_ACTIVE_RUN_ID: "env-run" }))
      .toEqual({ runId: "env-run", missionId: MISSION_ID });
  });

  it("returns an empty run id when neither env nor file is present", () => {
    expect(resolveIn({})).toEqual({ runId: "", missionId: "" });
  });

  it("fails open (empty, no throw) on a corrupt active-run.json", () => {
    writeActiveRun("{not json");
    expect(resolveIn({})).toEqual({ runId: "", missionId: "" });
  });

  it("fails open when active-run.json is valid JSON but has no run_id", () => {
    writeActiveRun(JSON.stringify({ mission_id: MISSION_ID }));
    expect(resolveIn({}).runId).toBe("");
  });

  it("tolerates a missing mission_id (flat run layout)", () => {
    writeActiveRun(JSON.stringify({ run_id: RUN_ID }));
    expect(resolveIn({})).toEqual({ runId: RUN_ID, missionId: "" });
  });
});

// ─── 2. Equivalence: every affected hook behaves the same via file as via env ──

describe("hook run-id fallback — file path is equivalent to the env var", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "evor-hookeq-"));
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  for (const hook of AFFECTED_HOOKS) {
    it(`${hook.file}: env-unset + active-run.json ≡ env-set, and both ≢ no-run`, () => {
      const script = join(HOOKS_DIR, hook.file);
      expect(existsSync(script)).toBe(true);

      // Each scenario gets its own root so file side effects never cross over.
      const mk = (name: string) => {
        const root = join(tmpDir, name);
        mkdirSync(root, { recursive: true });
        return root;
      };

      // Scenario A — no active run at all (baseline: hook must be inert).
      const rootA = mk("a");
      const evorRootA = join(rootA, ".evor");
      mkdirSync(evorRootA, { recursive: true });

      // Scenario B — env UNSET, active-run.json present (the fix).
      const rootB = mk("b");
      const seedB = seedRun(rootB);

      // Scenario C — env SET (the behaviour B must match).
      const rootC = mk("c");
      const seedC = seedRun(rootC);

      // job-status-watcher dedups terminal notifications in a shared temp dir
      // keyed by run id. Without isolation, whichever scenario runs first takes
      // the lock and silences the others.
      const base = (name: string) => ({
        CLAUDE_SESSION_ID: "eqtest",
        CLAUDE_PLUGIN_ROOT: "/nonexistent-plugin-root",
        EVOR_DEDUP_DIR: join(tmpDir, `dedup-${name}`),
      });

      const a = runHook(
        script,
        { ...base("a"), EVOR_ROOT: evorRootA },
        hook.stdin({ evorRoot: evorRootA, runDir: join(evorRootA, "runs", MISSION_ID, RUN_ID) }),
        evorRootA,
      );
      const b = runHook(
        script,
        { ...base("b"), EVOR_ROOT: seedB.evorRoot },
        hook.stdin(seedB),
        seedB.evorRoot,
      );
      const c = runHook(
        script,
        { ...base("c"), EVOR_ROOT: seedC.evorRoot, EVOR_ACTIVE_RUN_ID: RUN_ID, EVOR_MISSION_ID: MISSION_ID },
        hook.stdin(seedC),
        seedC.evorRoot,
      );

      // Non-vacuity: if C matches the inert baseline, the fixture is not
      // exercising this hook and the equivalence assertion below is worthless.
      expect(
        { status: c.status, stdout: c.stdout, files: c.files },
        `fixture is inert for ${hook.file}: scenario C (env set) is identical to the no-run baseline, so the equivalence check would pass vacuously`,
      ).not.toEqual({ status: a.status, stdout: a.stdout, files: a.files });

      // The actual property: resolving from the file is indistinguishable from
      // resolving from the env.
      expect({ status: b.status, stdout: b.stdout, files: b.files })
        .toEqual({ status: c.status, stdout: c.stdout, files: c.files });
    });
  }
});
