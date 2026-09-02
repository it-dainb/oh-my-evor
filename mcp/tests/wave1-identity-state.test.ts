/**
 * mcp/tests/wave1-identity-state.test.ts — Wave 1, category 3 (identity & state
 * coupling), JS/hook layer. RED phase: every test here asserts the invariant the
 * field trace says was violated, not the behaviour that was observed.
 *
 * Finding Q-01 (BLOCKER, lane Q): `hooks/lib/active-run.mjs:29` resolves
 *
 *     join(process.env.CLAUDE_PLUGIN_ROOT ?? process.cwd(), '.evor')
 *
 * and `CLAUDE_PLUGIN_ROOT` is *always* set for plugin hooks, so the
 * `process.cwd()` arm is dead code. For 19 hours all 14 hooks read a leftover
 * `frontier-1ms` self-test mission living inside the installed plugin cache
 * instead of the live project's `.evor/`. `[EVOR SUBAGENT WARNING]` therefore
 * never fired once across 97 agents, 18 of which died without a deliverable.
 *
 * The scenarios below reproduce the exact field configuration: EVOR_ROOT unset,
 * CLAUDE_PLUGIN_ROOT pointing at a plugin dir that has its OWN `.evor/`, and the
 * process cwd being a project dir that also has one. The project's must win.
 *
 * Hook invocation follows the subprocess pattern of `hooks.test.ts` and
 * `hooks-runid-fallback.test.ts`: spawnSync with a minimal env so nothing leaks
 * in from the real session.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";

const HOOKS_DIR = resolve(process.cwd(), "../hooks");
const RESOLVER = join(HOOKS_DIR, "lib", "active-run.mjs");
const SUBAGENT_STOP = join(HOOKS_DIR, "subagent-stop.mjs");

const PROJECT_RUN_ID = "run-project-live-01";
const PROJECT_MISSION_ID = "binarization-worldmodel";
const PLUGIN_RUN_ID = "run-live-01";
const PLUGIN_MISSION_ID = "frontier-1ms";

/**
 * The field configuration, materialised on disk.
 *
 *   <tmp>/plugin/.evor/runs/frontier-1ms/run-live-01/    ← leftover self-test
 *   <tmp>/project/.evor/runs/binarization-…/run-project-live-01/  ← the live run
 *
 * The plugin-side run is deliberately made *complete* (tick-state present, the
 * sage artifact present and non-trivial) and the project-side run deliberately
 * *incomplete* (no artifact). A hook that resolves to the plugin therefore stays
 * silent — which is precisely what happened in the field — while a hook that
 * resolves to the project must warn. That asymmetry is the non-vacuity guard:
 * the test cannot pass by accident on an inert fixture.
 */
function buildFieldLayout(root: string) {
  const pluginRoot = join(root, "plugin");
  const projectRoot = join(root, "project");

  const pluginEvor = join(pluginRoot, ".evor");
  const pluginRunDir = join(pluginEvor, "runs", PLUGIN_MISSION_ID, PLUGIN_RUN_ID);
  mkdirSync(join(pluginRunDir, "ticks", "1", "sage"), { recursive: true });
  writeFileSync(
    join(pluginEvor, "active-run.json"),
    JSON.stringify({ run_id: PLUGIN_RUN_ID, mission_id: PLUGIN_MISSION_ID, status: "paused" }),
  );
  writeFileSync(join(pluginRunDir, "tick-state.json"), JSON.stringify({ tick: 1, current_step: 2 }));
  writeFileSync(
    join(pluginRunDir, "mission-state.json"),
    JSON.stringify({ objective: "Beat the CIFAR-10 accuracy/latency frontier", status: "paused" }),
  );
  // Plugin-side artifact PRESENT and non-trivial → mis-resolution is silent.
  writeFileSync(
    join(pluginRunDir, "ticks", "1", "sage", "findings.json"),
    JSON.stringify({ findings: ["leftover self-test artifact, unrelated to the project"] }),
  );

  const projectEvor = join(projectRoot, ".evor");
  const projectRunDir = join(projectEvor, "runs", PROJECT_MISSION_ID, PROJECT_RUN_ID);
  mkdirSync(join(projectRunDir, "ticks", "1"), { recursive: true });
  writeFileSync(
    join(projectEvor, "active-run.json"),
    JSON.stringify({ run_id: PROJECT_RUN_ID, mission_id: PROJECT_MISSION_ID, status: "running" }),
  );
  writeFileSync(join(projectRunDir, "tick-state.json"), JSON.stringify({ tick: 1, current_step: 4 }));
  writeFileSync(
    join(projectRunDir, "mission-state.json"),
    JSON.stringify({ objective: "Binarize document images", status: "running" }),
  );
  // Project-side artifact ABSENT → correct resolution must warn.

  return { pluginRoot, projectRoot, pluginEvor, projectEvor, pluginRunDir, projectRunDir };
}

/**
 * Ask the shared resolver, in a fresh subprocess, what it resolves to under a
 * given env and cwd. Returns the parsed JSON the probe prints.
 */
function probeResolver(opts: { cwd: string; env: Record<string, string> }): {
  evorRoot: string;
  runDir: string;
  runId: string;
  missionId: string;
} {
  const probe =
    `import { resolveEvorRoot, resolveActiveRun, resolveRunDir } from ${JSON.stringify(RESOLVER)};\n` +
    `const { runId, missionId } = resolveActiveRun();\n` +
    `process.stdout.write(JSON.stringify({ evorRoot: resolveEvorRoot(), runDir: resolveRunDir(), runId, missionId }));\n`;

  const res = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
    cwd: opts.cwd,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...opts.env },
    encoding: "utf8",
    timeout: 10000,
  });

  expect(res.status, `probe failed: ${res.stderr}`).toBe(0);
  return JSON.parse(res.stdout);
}

/** Spawn a hook with a controlled env, cwd and STDIN payload. */
function runHook(script: string, opts: { cwd: string; env: Record<string, string>; stdin: string }) {
  return spawnSync(process.execPath, [script], {
    cwd: opts.cwd,
    input: opts.stdin,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...opts.env },
    encoding: "utf8",
    timeout: 10000,
  });
}

describe("Q-01 — .evor/ must resolve to the project, never the plugin cache", () => {
  let tmpRoot: string;
  let layout: ReturnType<typeof buildFieldLayout>;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "evor-q01-"));
    layout = buildFieldLayout(tmpRoot);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("resolves to the project's .evor when EVOR_ROOT is unset and CLAUDE_PLUGIN_ROOT has its own .evor", () => {
    const got = probeResolver({
      cwd: layout.projectRoot,
      env: { CLAUDE_PLUGIN_ROOT: layout.pluginRoot },
    });

    expect(got.evorRoot).toBe(layout.projectEvor);
  });

  it("never returns a path inside CLAUDE_PLUGIN_ROOT", () => {
    const got = probeResolver({
      cwd: layout.projectRoot,
      env: { CLAUDE_PLUGIN_ROOT: layout.pluginRoot },
    });

    expect(got.evorRoot.startsWith(layout.pluginRoot)).toBe(false);
    expect(got.runDir.startsWith(layout.pluginRoot)).toBe(false);
  });

  it("resolves the active run from the project's active-run.json, not the plugin's", () => {
    const got = probeResolver({
      cwd: layout.projectRoot,
      env: { CLAUDE_PLUGIN_ROOT: layout.pluginRoot },
    });

    expect(got.runId).toBe(PROJECT_RUN_ID);
    expect(got.missionId).toBe(PROJECT_MISSION_ID);
    expect(got.runDir).toBe(layout.projectRunDir);
  });

  it("still honours an explicit EVOR_ROOT override (no regression)", () => {
    const got = probeResolver({
      cwd: layout.projectRoot,
      env: { CLAUDE_PLUGIN_ROOT: layout.pluginRoot, EVOR_ROOT: layout.projectEvor },
    });

    expect(got.evorRoot).toBe(layout.projectEvor);
    expect(got.runId).toBe(PROJECT_RUN_ID);
  });
});

describe("Q-01 — subagent-stop's missing-artifact advisory under the field configuration", () => {
  let tmpRoot: string;
  let layout: ReturnType<typeof buildFieldLayout>;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "evor-q01-hook-"));
    layout = buildFieldLayout(tmpRoot);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("fires [EVOR SUBAGENT WARNING] when a subagent ends without its owed artifact and EVOR_ROOT is unset", () => {
    const res = runHook(SUBAGENT_STOP, {
      cwd: layout.projectRoot,
      env: { CLAUDE_PLUGIN_ROOT: layout.pluginRoot },
      stdin: JSON.stringify({
        agent_type: "oh-my-evor:evor-sage",
        agent_id: "agent-q01-01",
        last_assistant_message: "done",
      }),
    });

    expect(res.status).toBe(0);
    expect(res.stdout).toContain("[EVOR SUBAGENT WARNING]");
  });

  it("stays silent when the PROJECT's artifact is present, even though the plugin's is not", () => {
    // Mirror image of the test above: the artifact exists on the project side and
    // is missing on the plugin side. A hook reading the plugin would warn here —
    // so this pins the resolution direction rather than just "warns sometimes".
    mkdirSync(join(layout.projectRunDir, "ticks", "1", "sage"), { recursive: true });
    writeFileSync(
      join(layout.projectRunDir, "ticks", "1", "sage", "findings.json"),
      JSON.stringify({ findings: ["real project findings, well over the 10-byte floor"] }),
    );
    rmSync(join(layout.pluginRunDir, "ticks", "1", "sage", "findings.json"));

    const res = runHook(SUBAGENT_STOP, {
      cwd: layout.projectRoot,
      env: { CLAUDE_PLUGIN_ROOT: layout.pluginRoot },
      stdin: JSON.stringify({
        agent_type: "oh-my-evor:evor-sage",
        agent_id: "agent-q01-02",
        last_assistant_message: "done",
      }),
    });

    expect(res.status).toBe(0);
    expect(res.stdout).not.toContain("[EVOR SUBAGENT WARNING]");
  });
});
