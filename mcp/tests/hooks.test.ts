/**
 * mcp/tests/hooks.test.ts — L2 unit tests for M7a hook implementations
 *
 * Tests are subprocess-based: each hook is spawned via spawnSync with a
 * controlled temp directory and environment so the real exit codes and stdout
 * content can be verified without mocking the Node runtime.
 *
 * Coverage:
 *   session-start: valid active-run.json → env JSON emitted;
 *                  missing file → silent exit 0; corrupt → graceful;
 *                  missing run_id → graceful
 *   stop:          EVOR_ACTIVE_RUN_ID unset → exit 0;
 *                  pending_node_ids empty   → exit 0;
 *                  pending_node_ids non-empty → exit 2 + guard message;
 *                  with EVOR_MISSION_ID     → nested dir resolved correctly;
 *                  corrupt run-state.json   → exit 0 (fail-open)
 *   post-tool-use: EVOR_ACTIVE_RUN_ID unset      → exit 0, no output;
 *                  evor_record_eval all files ok  → exit 0, no output;
 *                  telemetry.jsonl missing         → exit 0 + WARNING;
 *                  telemetry.jsonl empty           → exit 0 + WARNING;
 *                  results.json missing            → exit 0 + WARNING;
 *                  evor_record_node tree.json ok   → exit 0, no output;
 *                  evor_record_node tree.json miss → exit 0 + WARNING;
 *                  unrelated tool call             → exit 0, no output
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, readFileSync, existsSync, utimesSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";

// Hooks live at ../../hooks/ relative to this file's directory in the repo.
// process.cwd() is the mcp/ workspace when vitest runs; __dirname is the same.
const HOOKS_DIR = resolve(process.cwd(), "../hooks");
const SESSION_START = join(HOOKS_DIR, "session-start.mjs");
const POST_TOOL_USE = join(HOOKS_DIR, "post-tool-use.mjs");
const STOP = join(HOOKS_DIR, "stop.mjs");
const PRE_COMPACT = join(HOOKS_DIR, "pre-compact.mjs");
const SUBAGENT_STOP = join(HOOKS_DIR, "subagent-stop.mjs");
const PRE_TOOL_USE = join(HOOKS_DIR, "pre-tool-use.mjs");

/** Spawn a hook script as a child process with a minimal, controlled env. */
function runHook(scriptPath: string, env: Record<string, string>) {
  return spawnSync(process.execPath, [scriptPath], {
    // Expose only PATH plus test-specific vars — no accidental leakage from
    // the real session environment (e.g. EVOR_ACTIVE_RUN_ID set by CI).
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
    encoding: "utf8",
    timeout: 5000,
  });
}

/**
 * Like runHook but delivers hook payload via STDIN (the real Claude Code delivery
 * path) rather than the CLAUDE_HOOK_INPUT env-var fallback.
 */
function runHookWithStdin(
  scriptPath: string,
  env: Record<string, string>,
  stdin: string,
) {
  return spawnSync(process.execPath, [scriptPath], {
    input: stdin,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
    encoding: "utf8",
    timeout: 5000,
  });
}

/** Build CLAUDE_HOOK_INPUT JSON as the hook expects it. */
function hookInput(toolName: string, toolInput: Record<string, unknown>): string {
  return JSON.stringify({ tool_name: toolName, tool_input: toolInput });
}

// ─── session-start.mjs ────────────────────────────────────────────────────────

describe("session-start hook", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "evor-hook-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("exports EVOR_PLUGIN_ROOT (but no active-run env) when active-run.json is absent", () => {
    writeFileSync(join(tmpDir, ".deps-ok"), "cached"); // skip the env-dependent dep-check
    writeFileSync(join(tmpDir, ".uv-ok"), "cached");   // skip the env-dependent uv-check
    // Pre-seed workspace-class cache so the scan never touches the OS temp parent,
    // keeping this test deterministic regardless of what sits above tmpDir.
    writeFileSync(join(tmpDir, ".workspace-class"), JSON.stringify({ class: "greenfield", counts: { models: 0, datasets: 0, configs: 0, logs: 0 } }));
    const result = runHook(SESSION_START, { EVOR_ROOT: tmpDir });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout.trim());
    // The plugin root is always exported so slash commands can resolve their SKILL.md.
    expect(output.env.EVOR_PLUGIN_ROOT).toBeTruthy();
    // …but with no mission in flight there is no active-run context or message.
    expect(output.env.EVOR_ACTIVE_RUN_ID).toBeUndefined();
    expect(output.message).toBeUndefined();
  });

  it("exits 0 and emits env JSON when active-run.json is valid", () => {
    writeFileSync(
      join(tmpDir, "active-run.json"),
      JSON.stringify({ run_id: "run-001", mission_id: "mission-001" })
    );
    const result = runHook(SESSION_START, { EVOR_ROOT: tmpDir });
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout.trim());
    expect(output.env.EVOR_ACTIVE_RUN_ID).toBe("run-001");
    expect(output.env.EVOR_MISSION_ID).toBe("mission-001");
    expect(output.env.EVOR_RUN_DIR).toContain("run-001");
    expect(output.env.EVOR_RUN_DIR).toContain("mission-001");
  });

  it("emits a message priming evor context", () => {
    writeFileSync(
      join(tmpDir, "active-run.json"),
      JSON.stringify({ run_id: "run-007", mission_id: "m-007" })
    );
    const result = runHook(SESSION_START, { EVOR_ROOT: tmpDir });
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout.trim());
    expect(output.message).toMatch(/run-007/);
  });

  it("exits 0 gracefully on corrupt active-run.json (invalid JSON)", () => {
    writeFileSync(join(tmpDir, "active-run.json"), "{corrupt: json,,}");
    const result = runHook(SESSION_START, { EVOR_ROOT: tmpDir });
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/corrupt/i);
    const output = JSON.parse(result.stdout.trim());
    expect(output.env.EVOR_ACTIVE_RUN_ID).toBe("");
    expect(output.env.EVOR_MISSION_ID).toBe("");
  });

  it("exits 0 gracefully when active-run.json has no run_id field", () => {
    writeFileSync(
      join(tmpDir, "active-run.json"),
      JSON.stringify({ mission_id: "mission-001" })
    );
    const result = runHook(SESSION_START, { EVOR_ROOT: tmpDir });
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/run_id/i);
    const output = JSON.parse(result.stdout.trim());
    expect(output.env.EVOR_ACTIVE_RUN_ID).toBe("");
  });

  it("accepts a valid active-run.json without mission_id", () => {
    writeFileSync(
      join(tmpDir, "active-run.json"),
      JSON.stringify({ run_id: "run-solo" })
    );
    const result = runHook(SESSION_START, { EVOR_ROOT: tmpDir });
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout.trim());
    expect(output.env.EVOR_ACTIVE_RUN_ID).toBe("run-solo");
    expect(output.env.EVOR_MISSION_ID).toBe("");
    // Without mission_id the run dir should not include an extra segment
    expect(output.env.EVOR_RUN_DIR).toContain("run-solo");
    expect(output.env.EVOR_RUN_DIR).not.toContain("undefined");
  });
});

// ─── stop.mjs — continuation guard ───────────────────────────────────────────

describe("stop hook (continuation guard)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "evor-hook-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("exits 0 with no output when EVOR_ACTIVE_RUN_ID is unset (guard inert)", () => {
    const result = runHook(STOP, { EVOR_ROOT: tmpDir });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("exits 0 when run-state.json does not exist yet", () => {
    const result = runHook(STOP, {
      EVOR_ACTIVE_RUN_ID: "run-001",
      EVOR_ROOT: tmpDir,
    });
    expect(result.status).toBe(0);
  });

  it("exits 0 when pending_node_ids is an empty array", () => {
    const runDir = join(tmpDir, "runs", "run-001");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "run-state.json"),
      JSON.stringify({ tick_count: 3, pending_node_ids: [], status: "running" })
    );
    const result = runHook(STOP, {
      EVOR_ACTIVE_RUN_ID: "run-001",
      EVOR_ROOT: tmpDir,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("exits 2 and outputs continuation guard when pending_node_ids is non-empty", () => {
    const runDir = join(tmpDir, "runs", "run-001");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "run-state.json"),
      JSON.stringify({ tick_count: 5, pending_node_ids: ["n1", "n2"], status: "running" })
    );
    const result = runHook(STOP, {
      EVOR_ACTIVE_RUN_ID: "run-001",
      EVOR_ROOT: tmpDir,
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toMatch(/EVOR CONTINUATION GUARD/);
    expect(result.stdout).toMatch(/n1/);
    expect(result.stdout).toMatch(/n2/);
    expect(result.stdout).toMatch(/evor_record_node/);
  });

  it("includes the correct tick count in the guard message", () => {
    const runDir = join(tmpDir, "runs", "run-001");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "run-state.json"),
      JSON.stringify({ tick_count: 7, pending_node_ids: ["node-abc"], status: "running" })
    );
    const result = runHook(STOP, {
      EVOR_ACTIVE_RUN_ID: "run-001",
      EVOR_ROOT: tmpDir,
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toMatch(/Tick 7/);
    expect(result.stdout).toMatch(/node-abc/);
  });

  it("resolves the nested run directory when EVOR_MISSION_ID is set", () => {
    const runDir = join(tmpDir, "runs", "mission-001", "run-001");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "run-state.json"),
      JSON.stringify({ tick_count: 1, pending_node_ids: ["n1"], status: "running" })
    );
    const result = runHook(STOP, {
      EVOR_ACTIVE_RUN_ID: "run-001",
      EVOR_MISSION_ID: "mission-001",
      EVOR_ROOT: tmpDir,
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toMatch(/n1/);
  });

  it("exits 0 (fail-open) on corrupt run-state.json and logs to stderr", () => {
    const runDir = join(tmpDir, "runs", "run-001");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "run-state.json"), "{corrupt");
    const result = runHook(STOP, {
      EVOR_ACTIVE_RUN_ID: "run-001",
      EVOR_ROOT: tmpDir,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/corrupt/i);
  });

  it("exits 0 when pending_node_ids field is absent (treat as empty)", () => {
    const runDir = join(tmpDir, "runs", "run-001");
    mkdirSync(runDir, { recursive: true });
    // run-state.json without pending_node_ids key
    writeFileSync(
      join(runDir, "run-state.json"),
      JSON.stringify({ tick_count: 2, status: "running" })
    );
    const result = runHook(STOP, {
      EVOR_ACTIVE_RUN_ID: "run-001",
      EVOR_ROOT: tmpDir,
    });
    expect(result.status).toBe(0);
  });
});

// ─── post-tool-use.mjs ────────────────────────────────────────────────────────

describe("post-tool-use hook", () => {
  let tmpDir: string;
  const RUN_ID = "run-001";
  const NODE_ID = "550e8400-e29b-41d4-a716-446655440000";

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "evor-hook-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("exits 0 with no output when EVOR_ACTIVE_RUN_ID is unset", () => {
    const result = runHook(POST_TOOL_USE, {
      EVOR_ROOT: tmpDir,
      CLAUDE_HOOK_INPUT: hookInput("evor_record_eval", { run_id: RUN_ID, node_id: NODE_ID }),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("exits 0 with no warning when results.json and telemetry.jsonl both present (non-empty)", () => {
    const nodeDir = join(tmpDir, "runs", RUN_ID, "nodes", NODE_ID);
    mkdirSync(nodeDir, { recursive: true });
    writeFileSync(join(nodeDir, "results.json"), '{"ok":true}');
    writeFileSync(
      join(nodeDir, "telemetry.jsonl"),
      '{"step":1,"node_id":"x","run_id":"r","timestamp":"2026-01-01T00:00:00Z"}\n'
    );
    const result = runHook(POST_TOOL_USE, {
      EVOR_ACTIVE_RUN_ID: RUN_ID,
      EVOR_ROOT: tmpDir,
      CLAUDE_HOOK_INPUT: hookInput("evor_record_eval", { run_id: RUN_ID, node_id: NODE_ID }),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("exits 0 with WARNING when telemetry.jsonl is absent", () => {
    const nodeDir = join(tmpDir, "runs", RUN_ID, "nodes", NODE_ID);
    mkdirSync(nodeDir, { recursive: true });
    writeFileSync(join(nodeDir, "results.json"), '{"ok":true}');
    // telemetry.jsonl intentionally not created

    const result = runHook(POST_TOOL_USE, {
      EVOR_ACTIVE_RUN_ID: RUN_ID,
      EVOR_ROOT: tmpDir,
      CLAUDE_HOOK_INPUT: hookInput("evor_record_eval", { run_id: RUN_ID, node_id: NODE_ID }),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/EVOR WARNING/);
    expect(result.stdout).toMatch(/telemetry/i);
  });

  it("exits 0 with WARNING when telemetry.jsonl exists but is empty (0 bytes)", () => {
    const nodeDir = join(tmpDir, "runs", RUN_ID, "nodes", NODE_ID);
    mkdirSync(nodeDir, { recursive: true });
    writeFileSync(join(nodeDir, "results.json"), '{"ok":true}');
    writeFileSync(join(nodeDir, "telemetry.jsonl"), ""); // zero bytes

    const result = runHook(POST_TOOL_USE, {
      EVOR_ACTIVE_RUN_ID: RUN_ID,
      EVOR_ROOT: tmpDir,
      CLAUDE_HOOK_INPUT: hookInput("evor_record_eval", { run_id: RUN_ID, node_id: NODE_ID }),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/EVOR WARNING/);
    expect(result.stdout).toMatch(/telemetry/i);
  });

  it("exits 0 with WARNING when results.json is absent", () => {
    const nodeDir = join(tmpDir, "runs", RUN_ID, "nodes", NODE_ID);
    mkdirSync(nodeDir, { recursive: true });
    // results.json intentionally not created
    writeFileSync(
      join(nodeDir, "telemetry.jsonl"),
      '{"step":1,"node_id":"x","run_id":"r","timestamp":"2026-01-01T00:00:00Z"}\n'
    );
    const result = runHook(POST_TOOL_USE, {
      EVOR_ACTIVE_RUN_ID: RUN_ID,
      EVOR_ROOT: tmpDir,
      CLAUDE_HOOK_INPUT: hookInput("evor_record_eval", { run_id: RUN_ID, node_id: NODE_ID }),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/EVOR WARNING/);
    expect(result.stdout).toMatch(/results\.json/i);
  });

  it("exits 0 with no warning when tree.json exists and was recently written (evor_record_node)", () => {
    const runDir = join(tmpDir, "runs", RUN_ID);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "tree.json"), '{"nodes":{}}'); // mtime = now

    const result = runHook(POST_TOOL_USE, {
      EVOR_ACTIVE_RUN_ID: RUN_ID,
      EVOR_ROOT: tmpDir,
      CLAUDE_HOOK_INPUT: hookInput("evor_record_node", { run_id: RUN_ID, node: { id: NODE_ID } }),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("exits 0 with WARNING when tree.json is missing after evor_record_node", () => {
    mkdirSync(join(tmpDir, "runs", RUN_ID), { recursive: true });
    // tree.json intentionally not created

    const result = runHook(POST_TOOL_USE, {
      EVOR_ACTIVE_RUN_ID: RUN_ID,
      EVOR_ROOT: tmpDir,
      CLAUDE_HOOK_INPUT: hookInput("evor_record_node", { run_id: RUN_ID, node: { id: NODE_ID } }),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/EVOR WARNING/);
    expect(result.stdout).toMatch(/tree\.json/i);
  });

  it("exits 0 silently for unrelated tool calls (e.g. Read)", () => {
    const result = runHook(POST_TOOL_USE, {
      EVOR_ACTIVE_RUN_ID: RUN_ID,
      EVOR_ROOT: tmpDir,
      CLAUDE_HOOK_INPUT: hookInput("Read", { file_path: "/some/file.txt" }),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("exits 0 safely on malformed CLAUDE_HOOK_INPUT", () => {
    const result = runHook(POST_TOOL_USE, {
      EVOR_ACTIVE_RUN_ID: RUN_ID,
      EVOR_ROOT: tmpDir,
      CLAUDE_HOOK_INPUT: "{not valid json",
    });
    expect(result.status).toBe(0);
  });
});

// ─── Phase-2: kill switches (all three hooks) ─────────────────────────────────

describe("kill switches — DISABLE_EVOR", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "evor-hook-kill-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stop: DISABLE_EVOR=1 exits 0 even with pending nodes", () => {
    const runDir = join(tmpDir, "runs", "run-kill-001");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "run-state.json"),
      JSON.stringify({ tick_count: 3, pending_node_ids: ["n1", "n2"], status: "running" })
    );
    const result = runHook(STOP, {
      DISABLE_EVOR: "1",
      EVOR_ACTIVE_RUN_ID: "run-kill-001",
      EVOR_ROOT: tmpDir,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("stop: EVOR_SKIP_HOOKS=stop exits 0 even with pending nodes", () => {
    const runDir = join(tmpDir, "runs", "run-skip-001");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "run-state.json"),
      JSON.stringify({ tick_count: 2, pending_node_ids: ["n1"], status: "running" })
    );
    const result = runHook(STOP, {
      EVOR_SKIP_HOOKS: "stop",
      EVOR_ACTIVE_RUN_ID: "run-skip-001",
      EVOR_ROOT: tmpDir,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("stop: EVOR_SKIP_HOOKS=other-hook does NOT skip stop", () => {
    const runDir = join(tmpDir, "runs", "run-skip-002");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "run-state.json"),
      JSON.stringify({ tick_count: 1, pending_node_ids: ["n-x"], status: "running" })
    );
    const result = runHook(STOP, {
      EVOR_SKIP_HOOKS: "session-start",
      EVOR_ACTIVE_RUN_ID: "run-skip-002",
      EVOR_ROOT: tmpDir,
    });
    // stop is not in the skip list — continuation guard should fire
    expect(result.status).toBe(2);
  });

  it("session-start: DISABLE_EVOR=1 exits 0 silently", () => {
    writeFileSync(
      join(tmpDir, "active-run.json"),
      JSON.stringify({ run_id: "run-001", mission_id: "m-001" })
    );
    const result = runHook(SESSION_START, {
      DISABLE_EVOR: "1",
      EVOR_ROOT: tmpDir,
    });
    expect(result.status).toBe(0);
    // Should NOT emit env JSON (exited before that logic)
    expect(result.stdout).toBe("");
  });

  it("session-start: EVOR_SKIP_HOOKS=session-start exits 0 silently", () => {
    writeFileSync(
      join(tmpDir, "active-run.json"),
      JSON.stringify({ run_id: "run-002", mission_id: "m-002" })
    );
    const result = runHook(SESSION_START, {
      EVOR_SKIP_HOOKS: "session-start",
      EVOR_ROOT: tmpDir,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("post-tool-use: DISABLE_EVOR=1 exits 0 silently", () => {
    const result = runHook(POST_TOOL_USE, {
      DISABLE_EVOR: "1",
      EVOR_ACTIVE_RUN_ID: "run-001",
      EVOR_ROOT: tmpDir,
      CLAUDE_HOOK_INPUT: hookInput("evor_record_eval", { run_id: "run-001", node_id: "n1" }),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("post-tool-use: EVOR_SKIP_HOOKS=post-tool-use exits 0 silently", () => {
    const result = runHook(POST_TOOL_USE, {
      EVOR_SKIP_HOOKS: "post-tool-use",
      EVOR_ACTIVE_RUN_ID: "run-001",
      EVOR_ROOT: tmpDir,
      CLAUDE_HOOK_INPUT: hookInput("evor_record_eval", { run_id: "run-001", node_id: "n1" }),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });
});

// ─── Phase-2: drift-guard in stop.mjs ────────────────────────────────────────

describe("stop hook — drift-guard (Phase 2)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "evor-drift-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("exits 2 when a done node has no evaluations/<id>.json (unrecorded integrity)", () => {
    const runId = "run-drift-001";
    const nodeId = "node-drift-aaaa";
    const runDir = join(tmpDir, "runs", runId);
    const nodesDir = join(runDir, "nodes", nodeId);
    mkdirSync(nodesDir, { recursive: true });
    mkdirSync(join(runDir, "evaluations"), { recursive: true });

    // run-state: no pending nodes (continuation guard passes)
    writeFileSync(
      join(runDir, "run-state.json"),
      JSON.stringify({ tick_count: 2, pending_node_ids: [], status: "running" })
    );

    // tree.json DICT format: one "done" node WITHOUT an evaluations/<id>.json
    const node = { id: nodeId, status: "done", integrity_status: "pending" };
    writeFileSync(
      join(runDir, "tree.json"),
      JSON.stringify({ nodes: { [nodeId]: node }, updated_at: new Date().toISOString() })
    );
    // evaluations/<nodeId>.json intentionally absent

    const result = runHook(STOP, {
      EVOR_ACTIVE_RUN_ID: runId,
      EVOR_ROOT: tmpDir,
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toMatch(/EVOR DRIFT GUARD/);
    expect(result.stdout).toMatch(nodeId);
    expect(result.stdout).toMatch(/integrity/i);
  });

  it("exits 2 when evaluated node has missing telemetry.jsonl", () => {
    const runId = "run-drift-002";
    const nodeId = "node-drift-bbbb";
    const runDir = join(tmpDir, "runs", runId);
    const nodesDir = join(runDir, "nodes", nodeId);
    mkdirSync(nodesDir, { recursive: true });
    mkdirSync(join(runDir, "evaluations"), { recursive: true });

    writeFileSync(
      join(runDir, "run-state.json"),
      JSON.stringify({ tick_count: 3, pending_node_ids: [], status: "running" })
    );

    const node = { id: nodeId, status: "done", integrity_status: "passed" };
    writeFileSync(
      join(runDir, "tree.json"),
      JSON.stringify({ nodes: { [nodeId]: node }, updated_at: new Date().toISOString() })
    );
    // evaluations/<nodeId>.json present (integrity passed)
    writeFileSync(
      join(runDir, "evaluations", `${nodeId}.json`),
      JSON.stringify({ verdict: "passed", node_id: nodeId })
    );
    // telemetry.jsonl intentionally absent

    const result = runHook(STOP, {
      EVOR_ACTIVE_RUN_ID: runId,
      EVOR_ROOT: tmpDir,
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toMatch(/EVOR DRIFT GUARD/);
    expect(result.stdout).toMatch(/telemetry/i);
  });

  it("exits 2 when telemetry.jsonl exists but is empty (0 bytes)", () => {
    const runId = "run-drift-003";
    const nodeId = "node-drift-cccc";
    const runDir = join(tmpDir, "runs", runId);
    mkdirSync(join(runDir, "nodes", nodeId), { recursive: true });
    mkdirSync(join(runDir, "evaluations"), { recursive: true });

    writeFileSync(
      join(runDir, "run-state.json"),
      JSON.stringify({ tick_count: 1, pending_node_ids: [], status: "running" })
    );
    writeFileSync(
      join(runDir, "tree.json"),
      JSON.stringify({ nodes: { [nodeId]: { id: nodeId, status: "done" } } })
    );
    writeFileSync(join(runDir, "evaluations", `${nodeId}.json`), "{}");
    writeFileSync(join(runDir, "nodes", nodeId, "telemetry.jsonl"), ""); // 0 bytes

    const result = runHook(STOP, {
      EVOR_ACTIVE_RUN_ID: runId,
      EVOR_ROOT: tmpDir,
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toMatch(/EVOR DRIFT GUARD/);
    expect(result.stdout).toMatch(/telemetry/i);
  });

  it("exits 2 when tick-state current_step < 9 and run-state status is running (M-2 fix)", () => {
    // M-2 fix: check (c) reads runState.status (run-state.json) NOT mission-state.json.
    // Proof: mission-state.json is seeded with status="locked" (not "running").
    // The guard must still fire because run-state.json has status="running".
    const runId = "run-drift-004";
    const runDir = join(tmpDir, "runs", runId);
    mkdirSync(join(runDir, "evaluations"), { recursive: true });

    // run-state.json has status="running" — this drives check (c)
    writeFileSync(
      join(runDir, "run-state.json"),
      JSON.stringify({ tick_count: 4, pending_node_ids: [], status: "running" })
    );
    // tree.json with no done nodes (so (a)+(b) don't fire)
    writeFileSync(
      join(runDir, "tree.json"),
      JSON.stringify({ nodes: {}, updated_at: new Date().toISOString() })
    );
    // tick-state: mid-flight (step 5 of 9)
    writeFileSync(
      join(runDir, "tick-state.json"),
      JSON.stringify({ tick: 4, current_step: 5, updated_at: new Date().toISOString() })
    );
    // mission-state is "locked" (NOT "running") — proves code uses run-state, not mission-state
    writeFileSync(
      join(runDir, "mission-state.json"),
      JSON.stringify({ status: "locked", current_tick: 4 })
    );

    const result = runHook(STOP, {
      EVOR_ACTIVE_RUN_ID: runId,
      EVOR_ROOT: tmpDir,
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toMatch(/EVOR DRIFT GUARD/);
    expect(result.stdout).toMatch(/tick.*mid-flight|current_step.*5/i);
  });

  it("exits 2 (check c) even without mission-state.json when run-state is running", () => {
    // M-2 fix: check (c) only needs tick-state.json + run-state.json (already loaded).
    // mission-state.json need not exist for the guard to fire.
    const runId = "run-drift-004b";
    const runDir = join(tmpDir, "runs", runId);
    mkdirSync(join(runDir, "evaluations"), { recursive: true });

    writeFileSync(
      join(runDir, "run-state.json"),
      JSON.stringify({ tick_count: 3, pending_node_ids: [], status: "running" })
    );
    writeFileSync(
      join(runDir, "tree.json"),
      JSON.stringify({ nodes: {}, updated_at: new Date().toISOString() })
    );
    writeFileSync(
      join(runDir, "tick-state.json"),
      JSON.stringify({ tick: 3, current_step: 2, updated_at: new Date().toISOString() })
    );
    // mission-state.json intentionally absent

    const result = runHook(STOP, {
      EVOR_ACTIVE_RUN_ID: runId,
      EVOR_ROOT: tmpDir,
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toMatch(/EVOR DRIFT GUARD/);
  });

  it("exits 0 when tick-state current_step = 9 (tick completed)", () => {
    const runId = "run-drift-005";
    const runDir = join(tmpDir, "runs", runId);
    mkdirSync(join(runDir, "evaluations"), { recursive: true });
    // A compliant completed tick carries its sub-agent artifacts (Mutagen + Selector
    // ran). All proposals rejected → 0 nodes is legitimate (no forge-report), so the
    // inline-shortcut guard must NOT fire.
    mkdirSync(join(runDir, "ticks", "4", "mutagen"), { recursive: true });
    mkdirSync(join(runDir, "ticks", "4", "selector"), { recursive: true });
    writeFileSync(
      join(runDir, "ticks", "4", "mutagen", "proposals.json"),
      JSON.stringify({ proposals: [] })
    );
    writeFileSync(
      join(runDir, "ticks", "4", "selector", "verdict.json"),
      JSON.stringify({ verdict: "rejected" })
    );

    writeFileSync(
      join(runDir, "run-state.json"),
      JSON.stringify({ tick_count: 4, pending_node_ids: [], status: "running" })
    );
    writeFileSync(
      join(runDir, "tree.json"),
      JSON.stringify({ nodes: {}, updated_at: new Date().toISOString() })
    );
    writeFileSync(
      join(runDir, "tick-state.json"),
      JSON.stringify({ tick: 4, current_step: 9, updated_at: new Date().toISOString() })
    );
    writeFileSync(
      join(runDir, "mission-state.json"),
      JSON.stringify({ status: "running", current_tick: 4 })
    );

    const result = runHook(STOP, {
      EVOR_ACTIVE_RUN_ID: runId,
      EVOR_ROOT: tmpDir,
    });
    expect(result.status).toBe(0);
  });

  it("exits 0 (fail-open) when tree.json is corrupt", () => {
    const runId = "run-drift-006";
    const runDir = join(tmpDir, "runs", runId);
    mkdirSync(runDir, { recursive: true });

    writeFileSync(
      join(runDir, "run-state.json"),
      JSON.stringify({ tick_count: 1, pending_node_ids: [], status: "running" })
    );
    writeFileSync(join(runDir, "tree.json"), "{corrupt json,,}");

    const result = runHook(STOP, {
      EVOR_ACTIVE_RUN_ID: runId,
      EVOR_ROOT: tmpDir,
    });
    expect(result.status).toBe(0); // fail-open
  });

  it("skips pruned and pending nodes (only 'done' nodes checked)", () => {
    const runId = "run-drift-007";
    const runDir = join(tmpDir, "runs", runId);
    mkdirSync(join(runDir, "evaluations"), { recursive: true });

    writeFileSync(
      join(runDir, "run-state.json"),
      JSON.stringify({ tick_count: 2, pending_node_ids: [], status: "running" })
    );

    // pruned and pending nodes without evaluations — should NOT trigger drift-guard
    writeFileSync(
      join(runDir, "tree.json"),
      JSON.stringify({
        nodes: {
          "n-pruned": { id: "n-pruned", status: "pruned" },
          "n-pending": { id: "n-pending", status: "pending" },
        },
        updated_at: new Date().toISOString(),
      })
    );

    const result = runHook(STOP, {
      EVOR_ACTIVE_RUN_ID: runId,
      EVOR_ROOT: tmpDir,
    });
    expect(result.status).toBe(0);
  });

  it("exits 0 when all done nodes have integrity verdicts and telemetry", () => {
    const runId = "run-drift-008";
    const nodeId = "node-clean-0001";
    const runDir = join(tmpDir, "runs", runId);
    mkdirSync(join(runDir, "nodes", nodeId), { recursive: true });
    mkdirSync(join(runDir, "evaluations"), { recursive: true });

    writeFileSync(
      join(runDir, "run-state.json"),
      JSON.stringify({ tick_count: 1, pending_node_ids: [], status: "running" })
    );
    writeFileSync(
      join(runDir, "tree.json"),
      JSON.stringify({ nodes: { [nodeId]: { id: nodeId, status: "done" } } })
    );
    writeFileSync(
      join(runDir, "evaluations", `${nodeId}.json`),
      JSON.stringify({ verdict: "passed" })
    );
    writeFileSync(
      join(runDir, "nodes", nodeId, "telemetry.jsonl"),
      '{"step":1}\n'
    );

    const result = runHook(STOP, {
      EVOR_ACTIVE_RUN_ID: runId,
      EVOR_ROOT: tmpDir,
    });
    expect(result.status).toBe(0);
  });
});

// ─── pre-compact.mjs ──────────────────────────────────────────────────────────

describe("pre-compact hook", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "evor-precompact-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("exits 0 silently when no active run exists", () => {
    const result = runHook(PRE_COMPACT, { EVOR_ROOT: tmpDir });
    expect(result.status).toBe(0);
    // No active-run.json → no output, no error
    expect(result.stderr).toBe("");
  });

  it("exits 0 when EVOR_ACTIVE_RUN_ID is set but run dir has no state files", () => {
    // Run dir doesn't need to exist — hook should fail-open
    const result = runHook(PRE_COMPACT, {
      EVOR_ROOT: tmpDir,
      EVOR_ACTIVE_RUN_ID: "run-precompact-001",
    });
    expect(result.status).toBe(0);
  });

  it("emits systemMessage with <evor-restore> when active run + state files exist", () => {
    const runId = "run-pc-001";
    const missionId = "mission-pc-001";
    const runDir = join(tmpDir, "runs", missionId, runId);
    mkdirSync(runDir, { recursive: true });

    writeFileSync(
      join(tmpDir, "active-run.json"),
      JSON.stringify({ run_id: runId, mission_id: missionId })
    );
    writeFileSync(
      join(runDir, "mission-state.json"),
      JSON.stringify({ objective: "maximise val_acc on CIFAR-10", status: "running" })
    );
    writeFileSync(
      join(runDir, "tick-state.json"),
      JSON.stringify({ tick: 3, current_step: 5, step_status: "running" })
    );
    writeFileSync(
      join(runDir, "run-state.json"),
      JSON.stringify({ tick_count: 3, best_score: 0.87, best_node_id: "node-abc", pending_node_ids: [] })
    );

    const result = runHook(PRE_COMPACT, {
      EVOR_ROOT: tmpDir,
      EVOR_ACTIVE_RUN_ID: runId,
      EVOR_MISSION_ID: missionId,
    });
    expect(result.status).toBe(0);

    const output = JSON.parse(result.stdout.trim());
    expect(output.continue).toBe(true);
    expect(output.systemMessage).toContain("<evor-restore>");
    expect(output.systemMessage).toContain("</evor-restore>");
    expect(output.systemMessage).toContain(runId.slice(0, 20));
    expect(output.systemMessage).toContain("Tick 3");
    // systemMessage must be ≤ 500 chars
    expect(output.systemMessage.length).toBeLessThanOrEqual(500);
  });

  it("writes a checkpoint file to checkpoints/ directory", () => {
    const runId = "run-pc-002";
    const runDir = join(tmpDir, "runs", runId);
    mkdirSync(runDir, { recursive: true });

    writeFileSync(
      join(tmpDir, "active-run.json"),
      JSON.stringify({ run_id: runId })
    );
    writeFileSync(
      join(runDir, "run-state.json"),
      JSON.stringify({ tick_count: 2, best_score: 0.75, best_node_id: "node-xyz", pending_node_ids: [] })
    );

    const result = runHook(PRE_COMPACT, {
      EVOR_ROOT: tmpDir,
      EVOR_ACTIVE_RUN_ID: runId,
    });
    expect(result.status).toBe(0);

    // Checkpoint file should exist in checkpoints/
    const checkpointsDir = join(runDir, "checkpoints");
    const files = readdirSync(checkpointsDir);
    expect(files.length).toBeGreaterThan(0);
    expect(files[0]).toMatch(/^precompact-.*\.json$/);

    // Checkpoint must contain required fields
    const checkpoint = JSON.parse(
      readFileSync(join(checkpointsDir, files[0]), "utf8")
    );
    expect(checkpoint).toHaveProperty("current_tick");
    expect(checkpoint).toHaveProperty("best_score");
    expect(checkpoint).toHaveProperty("flushed_at");
    expect(checkpoint).toHaveProperty("run_id", runId);
  });

  it("honors DISABLE_EVOR kill switch", () => {
    writeFileSync(
      join(tmpDir, "active-run.json"),
      JSON.stringify({ run_id: "run-pc-ks", mission_id: "m-ks" })
    );
    const result = runHook(PRE_COMPACT, {
      EVOR_ROOT: tmpDir,
      DISABLE_EVOR: "1",
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("honors EVOR_SKIP_HOOKS=pre-compact kill switch", () => {
    writeFileSync(
      join(tmpDir, "active-run.json"),
      JSON.stringify({ run_id: "run-pc-skip" })
    );
    const result = runHook(PRE_COMPACT, {
      EVOR_ROOT: tmpDir,
      EVOR_SKIP_HOOKS: "pre-compact",
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("exits 0 (fail-open) when mission-state.json is corrupt", () => {
    const runId = "run-pc-corrupt";
    const runDir = join(tmpDir, "runs", runId);
    mkdirSync(runDir, { recursive: true });

    writeFileSync(join(tmpDir, "active-run.json"), JSON.stringify({ run_id: runId }));
    writeFileSync(join(runDir, "mission-state.json"), "NOT VALID JSON{{");

    const result = runHook(PRE_COMPACT, {
      EVOR_ROOT: tmpDir,
      EVOR_ACTIVE_RUN_ID: runId,
    });
    expect(result.status).toBe(0);
  });
});

// ─── subagent-stop.mjs ────────────────────────────────────────────────────────

describe("subagent-stop hook", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "evor-subagent-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("exits 0 silently when EVOR_ACTIVE_RUN_ID is unset", () => {
    const result = runHook(SUBAGENT_STOP, { EVOR_ROOT: tmpDir });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("exits 0 silently when EVOR_AGENT_ROLE is unset", () => {
    const result = runHook(SUBAGENT_STOP, {
      EVOR_ROOT: tmpDir,
      EVOR_ACTIVE_RUN_ID: "run-sa-001",
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("emits warning when artifact is missing for sage role", () => {
    const runId = "run-sa-002";
    const runDir = join(tmpDir, "runs", runId);
    mkdirSync(runDir, { recursive: true });

    writeFileSync(
      join(runDir, "tick-state.json"),
      JSON.stringify({ tick: 4, current_step: 2 })
    );

    const result = runHook(SUBAGENT_STOP, {
      EVOR_ROOT: tmpDir,
      EVOR_ACTIVE_RUN_ID: runId,
      EVOR_AGENT_ROLE: "sage",
    });
    expect(result.status).toBe(0); // advisory — never blocks
    expect(result.stdout).toContain("[EVOR SUBAGENT WARNING]");
    expect(result.stdout).toContain("sage");
    expect(result.stdout).toContain("findings.json");
  });

  it("exits 0 silently when artifact is present and non-trivially sized", () => {
    const runId = "run-sa-003";
    const tick = 2;
    const runDir = join(tmpDir, "runs", runId);
    const artifactDir = join(runDir, "ticks", String(tick), "mutagen");
    mkdirSync(artifactDir, { recursive: true });

    writeFileSync(
      join(runDir, "tick-state.json"),
      JSON.stringify({ tick, current_step: 3 })
    );
    // Write a non-trivially-sized artifact (> 10 bytes)
    writeFileSync(
      join(artifactDir, "proposals.json"),
      JSON.stringify({ proposals: [{ id: "p1" }] })
    );

    const result = runHook(SUBAGENT_STOP, {
      EVOR_ROOT: tmpDir,
      EVOR_ACTIVE_RUN_ID: runId,
      EVOR_AGENT_ROLE: "mutagen",
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("emits warning when artifact is trivially small (stub)", () => {
    const runId = "run-sa-004";
    const tick = 1;
    const runDir = join(tmpDir, "runs", runId);
    const artifactDir = join(runDir, "ticks", String(tick), "probe");
    mkdirSync(artifactDir, { recursive: true });

    writeFileSync(
      join(runDir, "tick-state.json"),
      JSON.stringify({ tick, current_step: 7 })
    );
    // Trivially small — 5 bytes (less than MIN_ARTIFACT_BYTES=10)
    writeFileSync(join(artifactDir, "findings.json"), "{}");

    const result = runHook(SUBAGENT_STOP, {
      EVOR_ROOT: tmpDir,
      EVOR_ACTIVE_RUN_ID: runId,
      EVOR_AGENT_ROLE: "probe",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[EVOR SUBAGENT WARNING]");
  });

  it("honors DISABLE_EVOR kill switch", () => {
    const result = runHook(SUBAGENT_STOP, {
      EVOR_ROOT: tmpDir,
      EVOR_ACTIVE_RUN_ID: "run-sa-ks",
      EVOR_AGENT_ROLE: "sage",
      DISABLE_EVOR: "1",
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("honors EVOR_SKIP_HOOKS=subagent-stop kill switch", () => {
    const result = runHook(SUBAGENT_STOP, {
      EVOR_ROOT: tmpDir,
      EVOR_ACTIVE_RUN_ID: "run-sa-skip",
      EVOR_AGENT_ROLE: "forge",
      EVOR_SKIP_HOOKS: "subagent-stop",
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("uses EVOR_CURRENT_TICK env var when tick-state.json is absent", () => {
    const runId = "run-sa-005";
    const tick = 7;
    const runDir = join(tmpDir, "runs", runId);
    const artifactDir = join(runDir, "ticks", String(tick), "selector");
    mkdirSync(artifactDir, { recursive: true });
    // No tick-state.json — role+tick from env
    writeFileSync(
      join(artifactDir, "verdict.json"),
      JSON.stringify({ approved: ["prop-1"], rejected: [] })
    );

    const result = runHook(SUBAGENT_STOP, {
      EVOR_ROOT: tmpDir,
      EVOR_ACTIVE_RUN_ID: runId,
      EVOR_AGENT_ROLE: "selector",
      EVOR_CURRENT_TICK: String(tick),
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });
});

// ─── session-start evor-restore injection ────────────────────────────────────

describe("session-start hook — evor-restore injection", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "evor-restore-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("injects <evor-restore> block in message when state files exist", () => {
    const runId = "run-restore-001";
    const missionId = "mission-restore-001";
    const runDir = join(tmpDir, "runs", missionId, runId);
    mkdirSync(runDir, { recursive: true });

    writeFileSync(
      join(tmpDir, "active-run.json"),
      JSON.stringify({ run_id: runId, mission_id: missionId })
    );
    writeFileSync(
      join(runDir, "mission-state.json"),
      JSON.stringify({ objective: "beat baseline on MNIST", status: "running" })
    );
    writeFileSync(
      join(runDir, "tick-state.json"),
      JSON.stringify({ tick: 5, current_step: 3, step_status: "running" })
    );
    writeFileSync(
      join(runDir, "run-state.json"),
      JSON.stringify({ tick_count: 5, best_score: 0.92, best_node_id: "node-best", pending_node_ids: [] })
    );

    const result = runHook(SESSION_START, { EVOR_ROOT: tmpDir });
    expect(result.status).toBe(0);

    const output = JSON.parse(result.stdout.trim());
    expect(output.message).toContain("<evor-restore>");
    expect(output.message).toContain("</evor-restore>");
    expect(output.message).toContain("beat baseline on MNIST");
    expect(output.message).toContain("Tick 5");
  });

  it("does not inject evor-restore when no state files exist (new run)", () => {
    const runId = "run-restore-002";
    const runDir = join(tmpDir, "runs", runId);
    mkdirSync(runDir, { recursive: true });

    // active-run.json exists but no state files
    writeFileSync(
      join(tmpDir, "active-run.json"),
      JSON.stringify({ run_id: runId })
    );

    const result = runHook(SESSION_START, { EVOR_ROOT: tmpDir });
    expect(result.status).toBe(0);

    const output = JSON.parse(result.stdout.trim());
    // message may or may not include evor-restore; just must not error
    expect(output.env.EVOR_ACTIVE_RUN_ID).toBe(runId);
  });
});

// ─── STDIN delivery path — post-tool-use and pre-compact ─────────────────────
//
// Existing tests pass input via CLAUDE_HOOK_INPUT env var (the old/fallback path).
// These tests prove the real production path — STDIN — also works correctly.
// A bug here would mean fixes to readFileSync(0) did nothing in practice.

describe("post-tool-use — STDIN delivery path", () => {
  let tmpDir: string;
  const RUN_ID = "run-stdin-001";
  const NODE_ID = "node-stdin-0001";

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "evor-stdin-ptu-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads evor_record_eval payload from STDIN (no CLAUDE_HOOK_INPUT env)", () => {
    // results.json present; telemetry absent → must warn via STDIN-parsed tool_name
    const nodeDir = join(tmpDir, "runs", RUN_ID, "nodes", NODE_ID);
    mkdirSync(nodeDir, { recursive: true });
    writeFileSync(join(nodeDir, "results.json"), '{"ok":true}');
    // telemetry.jsonl intentionally absent

    const result = runHookWithStdin(
      POST_TOOL_USE,
      // Note: NO CLAUDE_HOOK_INPUT — only STDIN carries the payload
      { EVOR_ACTIVE_RUN_ID: RUN_ID, EVOR_ROOT: tmpDir },
      JSON.stringify({ tool_name: "evor_record_eval", tool_input: { run_id: RUN_ID, node_id: NODE_ID } }),
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/EVOR WARNING/);
    expect(result.stdout).toMatch(/telemetry/i);
  });

  it("exits 0 silently for unrelated tool via STDIN (no env fallback)", () => {
    const result = runHookWithStdin(
      POST_TOOL_USE,
      { EVOR_ACTIVE_RUN_ID: RUN_ID, EVOR_ROOT: tmpDir },
      JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/foo.txt" } }),
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("exits 0 safely on empty STDIN (fail-open; no env fallback)", () => {
    const result = runHookWithStdin(
      POST_TOOL_USE,
      { EVOR_ACTIVE_RUN_ID: RUN_ID, EVOR_ROOT: tmpDir },
      "",
    );
    expect(result.status).toBe(0);
  });

  it("exits 0 safely on malformed STDIN JSON (fail-open)", () => {
    const result = runHookWithStdin(
      POST_TOOL_USE,
      { EVOR_ACTIVE_RUN_ID: RUN_ID, EVOR_ROOT: tmpDir },
      "{not valid json,,",
    );
    expect(result.status).toBe(0);
  });
});

describe("pre-compact — STDIN delivery path", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "evor-stdin-pc-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads trigger field from STDIN (no CLAUDE_HOOK_INPUT env)", () => {
    const runId = "run-pc-stdin-001";
    const runDir = join(tmpDir, "runs", runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(tmpDir, "active-run.json"), JSON.stringify({ run_id: runId }));
    writeFileSync(
      join(runDir, "run-state.json"),
      JSON.stringify({ tick_count: 1, best_score: 0.5, best_node_id: "n1", pending_node_ids: [] }),
    );

    // Deliver trigger via STDIN only — no CLAUDE_HOOK_INPUT
    const result = runHookWithStdin(
      PRE_COMPACT,
      { EVOR_ROOT: tmpDir, EVOR_ACTIVE_RUN_ID: runId },
      JSON.stringify({ trigger: "manual" }),
    );
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout.trim());
    expect(out.continue).toBe(true);
    expect(out.systemMessage).toContain("<evor-restore>");

    // The checkpoint must record trigger="manual" (from STDIN, not default "auto")
    const checkpointsDir = join(runDir, "checkpoints");
    const files = readdirSync(checkpointsDir);
    const cp = JSON.parse(readFileSync(join(checkpointsDir, files[0]), "utf8"));
    expect(cp.trigger).toBe("manual");
  });

  it("defaults trigger to 'auto' on empty STDIN (no env fallback)", () => {
    const runId = "run-pc-stdin-002";
    const runDir = join(tmpDir, "runs", runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(tmpDir, "active-run.json"), JSON.stringify({ run_id: runId }));
    writeFileSync(
      join(runDir, "run-state.json"),
      JSON.stringify({ tick_count: 1, pending_node_ids: [] }),
    );

    const result = runHookWithStdin(
      PRE_COMPACT,
      { EVOR_ROOT: tmpDir, EVOR_ACTIVE_RUN_ID: runId },
      "",
    );
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout.trim());
    expect(out.continue).toBe(true);

    const checkpointsDir = join(runDir, "checkpoints");
    const files = readdirSync(checkpointsDir);
    const cp = JSON.parse(readFileSync(join(checkpointsDir, files[0]), "utf8"));
    expect(cp.trigger).toBe("auto");
  });
});

// ─── subagent-stop — STDIN agent_type fallback ────────────────────────────────
//
// BUG: subagent-stop.mjs only checked EVOR_AGENT_ROLE env var; if it was unset
// (the default when not explicitly configured), the hook was always dormant.
// Fix: parse agent_type from the SubagentStop STDIN payload as a fallback.

describe("subagent-stop — STDIN agent_type fallback", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "evor-sa-stdin-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("warns when EVOR_AGENT_ROLE is unset but agent_type=evor-sage arrives on STDIN and artifact missing", () => {
    const runId = "run-sa-stdin-001";
    const runDir = join(tmpDir, "runs", runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "tick-state.json"), JSON.stringify({ tick: 3, current_step: 5 }));
    // sage artifact intentionally absent

    const result = runHookWithStdin(
      SUBAGENT_STOP,
      // No EVOR_AGENT_ROLE — role must be inferred from STDIN payload
      { EVOR_ROOT: tmpDir, EVOR_ACTIVE_RUN_ID: runId },
      JSON.stringify({ agent_type: "oh-my-evor:evor-sage", session_id: "sess-xyz" }),
    );
    expect(result.status).toBe(0); // advisory — never blocks
    expect(result.stdout).toContain("[EVOR SUBAGENT WARNING]");
    expect(result.stdout).toContain("sage");
    expect(result.stdout).toContain("findings.json");
  });

  it("warns for evor-forge via STDIN when forge-report.json is absent", () => {
    const runId = "run-sa-stdin-002";
    const tick = 2;
    const runDir = join(tmpDir, "runs", runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "tick-state.json"), JSON.stringify({ tick, current_step: 8 }));
    // forge-report.json intentionally absent

    const result = runHookWithStdin(
      SUBAGENT_STOP,
      { EVOR_ROOT: tmpDir, EVOR_ACTIVE_RUN_ID: runId },
      JSON.stringify({ agent_type: "oh-my-evor:evor-forge" }),
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[EVOR SUBAGENT WARNING]");
    expect(result.stdout).toContain("forge-report.json");
  });

  it("exits 0 silently when STDIN agent_type is a sub-sub-agent (evor-forge-junior, untracked)", () => {
    const runId = "run-sa-stdin-003";
    const runDir = join(tmpDir, "runs", runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "tick-state.json"), JSON.stringify({ tick: 1, current_step: 3 }));

    const result = runHookWithStdin(
      SUBAGENT_STOP,
      { EVOR_ROOT: tmpDir, EVOR_ACTIVE_RUN_ID: runId },
      JSON.stringify({ agent_type: "oh-my-evor:evor-forge-junior" }),
    );
    // forge-junior has no tracked artifact — hook must exit 0 silently
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("exits 0 silently on empty STDIN when EVOR_AGENT_ROLE also unset (fail-open)", () => {
    const runId = "run-sa-stdin-004";
    mkdirSync(join(tmpDir, "runs", runId), { recursive: true });

    const result = runHookWithStdin(
      SUBAGENT_STOP,
      { EVOR_ROOT: tmpDir, EVOR_ACTIVE_RUN_ID: runId },
      "",
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("EVOR_AGENT_ROLE env var still takes precedence over STDIN agent_type", () => {
    const runId = "run-sa-stdin-005";
    const tick = 4;
    const runDir = join(tmpDir, "runs", runId);
    const artifactDir = join(runDir, "ticks", String(tick), "selector");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(join(runDir, "tick-state.json"), JSON.stringify({ tick, current_step: 9 }));
    writeFileSync(
      join(artifactDir, "verdict.json"),
      JSON.stringify({ approved: ["p1"], rejected: [] }),
    );

    // STDIN says "sage" but env says "selector" — env wins; selector artifact present → no warning
    const result = runHookWithStdin(
      SUBAGENT_STOP,
      { EVOR_ROOT: tmpDir, EVOR_ACTIVE_RUN_ID: runId, EVOR_AGENT_ROLE: "selector" },
      JSON.stringify({ agent_type: "oh-my-evor:evor-sage" }),
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(""); // selector artifact present → no warning
  });
});

// ─── pre-tool-use hook (capability governor) ─────────────────────────────────
//
// This hook is security-critical: it enforces the Orchestrator_Contract by making
// the wrong agent physically unable to do a specialist's job. It reads its payload
// exclusively from STDIN (no env fallback), so all tests use runHookWithStdin.

describe("pre-tool-use hook — kill switches and inert guard", () => {
  const ACTIVE_ENV = { EVOR_ACTIVE_RUN_ID: "run-gov-001" };

  it("exits 0 silently (DISABLE_EVOR) even with a deny-worthy payload", () => {
    const result = runHookWithStdin(
      PRE_TOOL_USE,
      { DISABLE_EVOR: "1", ...ACTIVE_ENV },
      JSON.stringify({ tool_name: "Write", tool_input: { file_path: "/x/model.py" } }),
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("exits 0 silently (EVOR_SKIP_HOOKS=pre-tool-use) even with a deny-worthy payload", () => {
    const result = runHookWithStdin(
      PRE_TOOL_USE,
      { EVOR_SKIP_HOOKS: "pre-tool-use", ...ACTIVE_ENV },
      JSON.stringify({ tool_name: "Write", tool_input: { file_path: "/x/model.py" } }),
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("exits 0 silently when EVOR_ACTIVE_RUN_ID is unset (governor is inert)", () => {
    const result = runHookWithStdin(
      PRE_TOOL_USE,
      {}, // no active run
      JSON.stringify({ tool_name: "Write", tool_input: { file_path: "/x/model.py" } }),
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("exits 0 (fail-open) on malformed STDIN JSON", () => {
    const result = runHookWithStdin(PRE_TOOL_USE, ACTIVE_ENV, "{not valid json,,");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("exits 0 (fail-open) on empty STDIN", () => {
    const result = runHookWithStdin(PRE_TOOL_USE, ACTIVE_ENV, "");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });
});

describe("pre-tool-use hook — main Evor code-authoring restrictions", () => {
  const ACTIVE_ENV = { EVOR_ACTIVE_RUN_ID: "run-gov-002" };

  it("denies Write of a .py file by main Evor (no agent_type)", () => {
    const result = runHookWithStdin(
      PRE_TOOL_USE,
      ACTIVE_ENV,
      JSON.stringify({ tool_name: "Write", tool_input: { file_path: "/runs/r1/nodes/n1/model.py" } }),
    );
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout.trim());
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/orchestrator-only/i);
  });

  it("denies Edit of a .py file by main Evor", () => {
    const result = runHookWithStdin(
      PRE_TOOL_USE,
      ACTIVE_ENV,
      JSON.stringify({ tool_name: "Edit", tool_input: { file_path: "/runs/r1/train.py" } }),
    );
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout.trim());
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("denies Bash training command (python3 train.py) by main Evor", () => {
    const result = runHookWithStdin(
      PRE_TOOL_USE,
      ACTIVE_ENV,
      JSON.stringify({ tool_name: "Bash", tool_input: { command: "python3 train.py --epochs 10" } }),
    );
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout.trim());
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/evor-forge/i);
  });

  it("denies Bash with torch training pattern by main Evor", () => {
    const result = runHookWithStdin(
      PRE_TOOL_USE,
      ACTIVE_ENV,
      JSON.stringify({ tool_name: "Bash", tool_input: { command: "python3 runner.py --model torch" } }),
    );
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout.trim());
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("allows main Evor to run the evor CLI (python -m evor ...)", () => {
    const result = runHookWithStdin(
      PRE_TOOL_USE,
      ACTIVE_ENV,
      JSON.stringify({ tool_name: "Bash", tool_input: { command: "python3 -m evor run --run-id abc" } }),
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("allows main Evor to run evor sub-module (python -m evor.wiki ...)", () => {
    const result = runHookWithStdin(
      PRE_TOOL_USE,
      ACTIVE_ENV,
      JSON.stringify({ tool_name: "Bash", tool_input: { command: "python3 -m evor.wiki context --mission-id m1" } }),
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("allows main Evor to Write a non-.py file (e.g. run-state.json)", () => {
    const result = runHookWithStdin(
      PRE_TOOL_USE,
      ACTIVE_ENV,
      JSON.stringify({ tool_name: "Write", tool_input: { file_path: "/runs/r1/run-state.json" } }),
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("deny JSON has the required hookSpecificOutput shape", () => {
    const result = runHookWithStdin(
      PRE_TOOL_USE,
      ACTIVE_ENV,
      JSON.stringify({ tool_name: "Write", tool_input: { file_path: "/x/model.py" } }),
    );
    const out = JSON.parse(result.stdout.trim());
    expect(out).toHaveProperty("hookSpecificOutput");
    expect(out.hookSpecificOutput).toHaveProperty("hookEventName", "PreToolUse");
    expect(out.hookSpecificOutput).toHaveProperty("permissionDecision", "deny");
    expect(typeof out.hookSpecificOutput.permissionDecisionReason).toBe("string");
    expect(out.hookSpecificOutput.permissionDecisionReason.length).toBeGreaterThan(0);
  });
});

describe("pre-tool-use hook — non-Forge sub-agent code restrictions", () => {
  const ACTIVE_ENV = { EVOR_ACTIVE_RUN_ID: "run-gov-003" };

  it("denies evor-sage from writing .py files", () => {
    const result = runHookWithStdin(
      PRE_TOOL_USE,
      ACTIVE_ENV,
      JSON.stringify({
        tool_name: "Write",
        tool_input: { file_path: "/nodes/n1/model.py" },
        agent_type: "oh-my-evor:evor-sage",
      }),
    );
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout.trim());
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("denies evor-mutagen from writing .py files", () => {
    const result = runHookWithStdin(
      PRE_TOOL_USE,
      ACTIVE_ENV,
      JSON.stringify({
        tool_name: "Edit",
        tool_input: { file_path: "/nodes/n1/model.py" },
        agent_type: "oh-my-evor:evor-mutagen",
      }),
    );
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout.trim());
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("denies evor-forge (lead) from directly writing .py files and names evor-forge-junior", () => {
    const result = runHookWithStdin(
      PRE_TOOL_USE,
      ACTIVE_ENV,
      JSON.stringify({
        tool_name: "Write",
        tool_input: { file_path: "/nodes/n1/model.py" },
        agent_type: "oh-my-evor:evor-forge",
      }),
    );
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout.trim());
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/evor-forge-junior/i);
  });

  it("allows evor-forge-junior to write .py files (it is the code author)", () => {
    const result = runHookWithStdin(
      PRE_TOOL_USE,
      ACTIVE_ENV,
      JSON.stringify({
        tool_name: "Write",
        tool_input: { file_path: "/nodes/n1/model.py" },
        agent_type: "oh-my-evor:evor-forge-junior",
      }),
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("allows evor-forge-junior to run training Bash commands", () => {
    const result = runHookWithStdin(
      PRE_TOOL_USE,
      ACTIVE_ENV,
      JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "python3 train.py --epochs 5" },
        agent_type: "oh-my-evor:evor-forge-junior",
      }),
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("denies evor-forge (lead) from running raw training (not evor CLI)", () => {
    const result = runHookWithStdin(
      PRE_TOOL_USE,
      ACTIVE_ENV,
      JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "python3 train.py --epochs 10" },
        agent_type: "oh-my-evor:evor-forge",
      }),
    );
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout.trim());
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    // Deny message should guide toward evor CLI or delegate to junior
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/python -m evor/i);
  });

  it("allows evor-forge (lead) to run evor CLI harness", () => {
    const result = runHookWithStdin(
      PRE_TOOL_USE,
      ACTIVE_ENV,
      JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "python3 -m evor run --run-id r1" },
        agent_type: "oh-my-evor:evor-forge",
      }),
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });
});

describe("pre-tool-use hook — spawn hierarchy gate", () => {
  const ACTIVE_ENV = { EVOR_ACTIVE_RUN_ID: "run-gov-004" };

  it("denies main Evor from spawning evor-sage-junior directly", () => {
    const result = runHookWithStdin(
      PRE_TOOL_USE,
      ACTIVE_ENV,
      JSON.stringify({
        tool_name: "Task",
        tool_input: { subagent_type: "oh-my-evor:evor-sage-junior", prompt: "research X" },
      }),
    );
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout.trim());
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/evor-sage/i);
  });

  it("allows evor-sage to spawn evor-sage-junior", () => {
    const result = runHookWithStdin(
      PRE_TOOL_USE,
      ACTIVE_ENV,
      JSON.stringify({
        tool_name: "Task",
        tool_input: { subagent_type: "oh-my-evor:evor-sage-junior", prompt: "research X" },
        agent_type: "oh-my-evor:evor-sage",
      }),
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("denies evor-mutagen from spawning evor-forge-junior (wrong parent)", () => {
    const result = runHookWithStdin(
      PRE_TOOL_USE,
      ACTIVE_ENV,
      JSON.stringify({
        tool_name: "Task",
        tool_input: { subagent_type: "oh-my-evor:evor-forge-junior", prompt: "code X" },
        agent_type: "oh-my-evor:evor-mutagen",
      }),
    );
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout.trim());
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/evor-forge/i);
  });

  it("allows evor-forge to spawn all of its sub-team members", () => {
    const forgeSubs = [
      "evor-forge-junior",
      "evor-forge-architect",
      "evor-forge-critic",
      "evor-forge-analyst",
    ];
    for (const sub of forgeSubs) {
      const result = runHookWithStdin(
        PRE_TOOL_USE,
        ACTIVE_ENV,
        JSON.stringify({
          tool_name: "Task",
          tool_input: { subagent_type: `oh-my-evor:${sub}`, prompt: "..." },
          agent_type: "oh-my-evor:evor-forge",
        }),
      );
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(""); // must not deny
    }
  });

  it("denies evor-sage from spawning a Forge sub-team member (evor-forge-critic)", () => {
    const result = runHookWithStdin(
      PRE_TOOL_USE,
      ACTIVE_ENV,
      JSON.stringify({
        tool_name: "Task",
        tool_input: { subagent_type: "oh-my-evor:evor-forge-critic", prompt: "..." },
        agent_type: "oh-my-evor:evor-sage",
      }),
    );
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout.trim());
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("also blocks spawning via the Agent tool name (not just Task)", () => {
    const result = runHookWithStdin(
      PRE_TOOL_USE,
      ACTIVE_ENV,
      JSON.stringify({
        tool_name: "Agent",
        tool_input: { subagent_type: "oh-my-evor:evor-sage-junior", prompt: "..." },
        // no agent_type → main Evor
      }),
    );
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout.trim());
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  });
});

describe("pre-tool-use hook — evor-acquirer dual-parent gate", () => {
  const ACTIVE_ENV = { EVOR_ACTIVE_RUN_ID: "run-gov-005" };

  it("allows main Evor to spawn evor-acquirer (harden-test path)", () => {
    const result = runHookWithStdin(
      PRE_TOOL_USE,
      ACTIVE_ENV,
      JSON.stringify({ tool_name: "Task", tool_input: { subagent_type: "oh-my-evor:evor-acquirer", prompt: "..." } }),
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("allows evor-forge to spawn evor-acquirer (enrich-train path)", () => {
    const result = runHookWithStdin(
      PRE_TOOL_USE,
      ACTIVE_ENV,
      JSON.stringify({
        tool_name: "Task",
        tool_input: { subagent_type: "oh-my-evor:evor-acquirer", prompt: "..." },
        agent_type: "oh-my-evor:evor-forge",
      }),
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("denies evor-sage from spawning evor-acquirer", () => {
    const result = runHookWithStdin(
      PRE_TOOL_USE,
      ACTIVE_ENV,
      JSON.stringify({
        tool_name: "Task",
        tool_input: { subagent_type: "oh-my-evor:evor-acquirer", prompt: "..." },
        agent_type: "oh-my-evor:evor-sage",
      }),
    );
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout.trim());
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/evor-acquirer/i);
  });

  it("denies evor-mutagen from spawning evor-acquirer", () => {
    const result = runHookWithStdin(
      PRE_TOOL_USE,
      ACTIVE_ENV,
      JSON.stringify({
        tool_name: "Task",
        tool_input: { subagent_type: "oh-my-evor:evor-acquirer", prompt: "..." },
        agent_type: "oh-my-evor:evor-mutagen",
      }),
    );
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout.trim());
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  });
});

describe("pre-tool-use hook — Mutagen research-tool denial", () => {
  const ACTIVE_ENV = { EVOR_ACTIVE_RUN_ID: "run-gov-006" };
  const MUTAGEN_ENV = { ...ACTIVE_ENV, ...{ agent_type: "ignored-via-stdin" } };

  it("denies evor-mutagen from using WebSearch", () => {
    const result = runHookWithStdin(
      PRE_TOOL_USE,
      ACTIVE_ENV,
      JSON.stringify({
        tool_name: "WebSearch",
        tool_input: { query: "latest ML papers" },
        agent_type: "oh-my-evor:evor-mutagen",
      }),
    );
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout.trim());
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/Mutagen/i);
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/investigation_queries/i);
  });

  it("denies evor-mutagen from using WebFetch", () => {
    const result = runHookWithStdin(
      PRE_TOOL_USE,
      ACTIVE_ENV,
      JSON.stringify({
        tool_name: "WebFetch",
        tool_input: { url: "https://arxiv.org/abs/1234.5678" },
        agent_type: "oh-my-evor:evor-mutagen",
      }),
    );
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout.trim());
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("denies evor-mutagen from using Exa web search tool", () => {
    const result = runHookWithStdin(
      PRE_TOOL_USE,
      ACTIVE_ENV,
      JSON.stringify({
        tool_name: "mcp__claude_ai_Exa__web_search_exa",
        tool_input: { query: "..." },
        agent_type: "oh-my-evor:evor-mutagen",
      }),
    );
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout.trim());
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("denies evor-mutagen from using Consensus search", () => {
    const result = runHookWithStdin(
      PRE_TOOL_USE,
      ACTIVE_ENV,
      JSON.stringify({
        tool_name: "mcp__claude_ai_Consensus__search",
        tool_input: { query: "..." },
        agent_type: "oh-my-evor:evor-mutagen",
      }),
    );
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout.trim());
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("allows evor-sage (not mutagen) to use WebSearch", () => {
    const result = runHookWithStdin(
      PRE_TOOL_USE,
      ACTIVE_ENV,
      JSON.stringify({
        tool_name: "WebSearch",
        tool_input: { query: "ML papers" },
        agent_type: "oh-my-evor:evor-sage",
      }),
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("allows evor-sage-junior (researcher) to use WebSearch", () => {
    const result = runHookWithStdin(
      PRE_TOOL_USE,
      ACTIVE_ENV,
      JSON.stringify({
        tool_name: "WebSearch",
        tool_input: { query: "residual networks" },
        agent_type: "oh-my-evor:evor-sage-junior",
      }),
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });
});

// ─── BUG G: signal inbox signature ───────────────────────────────────────────
// Every <evor-signal> inbox entry must carry a deterministic `signature` field
// so the Python SignalBus drain can dedup recurring pain-points.
// Format: kind + ':' + sha256(description).slice(0,16)

describe("post-tool-use — signal inbox: signature (BUG G)", () => {
  let tmpDir: string;
  const RUN_ID = "run-sig-001";
  const MISSION_ID = "mission-sig-001";

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "evor-sig-"));
    mkdirSync(join(tmpDir, "runs", MISSION_ID, RUN_ID), { recursive: true });
    writeFileSync(
      join(tmpDir, "active-run.json"),
      JSON.stringify({ run_id: RUN_ID, mission_id: MISSION_ID }),
    );
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes a signature field to each signal inbox entry", () => {
    const result = runHookWithStdin(
      POST_TOOL_USE,
      { EVOR_ACTIVE_RUN_ID: RUN_ID, EVOR_MISSION_ID: MISSION_ID, EVOR_ROOT: tmpDir },
      JSON.stringify({
        tool_name: "Write",
        tool_input: {},
        tool_response:
          '<evor-signal kind="limit" shapes="memory" axes="compute" severity="high">GPU OOM at batch 32</evor-signal>',
      }),
    );
    expect(result.status).toBe(0);

    const inboxPath = join(tmpDir, "runs", MISSION_ID, RUN_ID, "signals-inbox.jsonl");
    const entry = JSON.parse(readFileSync(inboxPath, "utf8").trim().split("\n")[0]);
    expect(entry).toHaveProperty("signature");
    expect(typeof entry.signature).toBe("string");
    // Format: "kind:hex16"
    expect(entry.signature).toMatch(/^limit:[0-9a-f]{16}$/);
  });

  it("identical evidence produces identical signature (dedup stability)", () => {
    const tag =
      '<evor-signal kind="limit" shapes="memory" axes="compute" severity="high">GPU OOM at batch 32</evor-signal>';
    const result = runHookWithStdin(
      POST_TOOL_USE,
      { EVOR_ACTIVE_RUN_ID: RUN_ID, EVOR_MISSION_ID: MISSION_ID, EVOR_ROOT: tmpDir },
      JSON.stringify({ tool_name: "Write", tool_input: {}, tool_response: tag + "\n" + tag }),
    );
    expect(result.status).toBe(0);

    const lines = readFileSync(
      join(tmpDir, "runs", MISSION_ID, RUN_ID, "signals-inbox.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(lines.length).toBe(2);
    const [e1, e2] = lines.map((l) => JSON.parse(l));
    // Same evidence → same signature → drain can dedup
    expect(e1.signature).toBe(e2.signature);
  });

  it("different descriptions produce different signatures", () => {
    const result = runHookWithStdin(
      POST_TOOL_USE,
      { EVOR_ACTIVE_RUN_ID: RUN_ID, EVOR_MISSION_ID: MISSION_ID, EVOR_ROOT: tmpDir },
      JSON.stringify({
        tool_name: "Write",
        tool_input: {},
        tool_response: [
          '<evor-signal kind="limit">OOM at batch 32</evor-signal>',
          '<evor-signal kind="limit">OOM at batch 64</evor-signal>',
        ].join("\n"),
      }),
    );
    expect(result.status).toBe(0);

    const lines = readFileSync(
      join(tmpDir, "runs", MISSION_ID, RUN_ID, "signals-inbox.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(lines.length).toBe(2);
    const [e1, e2] = lines.map((l) => JSON.parse(l));
    expect(e1.signature).not.toBe(e2.signature);
  });

  it("entry contains required drain contract fields: kind, signature, shapes, axes, severity, evidence, source, created_at", () => {
    const result = runHookWithStdin(
      POST_TOOL_USE,
      { EVOR_ACTIVE_RUN_ID: RUN_ID, EVOR_MISSION_ID: MISSION_ID, EVOR_ROOT: tmpDir },
      JSON.stringify({
        tool_name: "Bash",
        tool_input: {},
        tool_response:
          '<evor-signal kind="failure" shapes="divergence" axes="loss" severity="critical">training diverged</evor-signal>',
      }),
    );
    expect(result.status).toBe(0);

    const entry = JSON.parse(
      readFileSync(
        join(tmpDir, "runs", MISSION_ID, RUN_ID, "signals-inbox.jsonl"),
        "utf8",
      ).trim(),
    );
    expect(entry).toHaveProperty("kind", "failure");
    expect(entry).toHaveProperty("signature");
    expect(entry).toHaveProperty("shapes");
    expect(entry).toHaveProperty("axes");
    expect(entry).toHaveProperty("severity", "critical");
    expect(entry).toHaveProperty("evidence");
    expect(entry).toHaveProperty("source");
    expect(entry).toHaveProperty("created_at");
    // Fields the hook must NOT synthesize (drain's job)
    expect(entry).not.toHaveProperty("signal_id");
    expect(entry).not.toHaveProperty("confidence");
    expect(entry).not.toHaveProperty("occurrences");
    expect(entry).not.toHaveProperty("first_seen");
    expect(entry).not.toHaveProperty("last_seen");
  });
});

// ─── BUG H: signal inbox path resolution when EVOR_MISSION_ID is unset ───────
// runDir() previously used only the EVOR_MISSION_ID env var; when unset it wrote
// to a flat runs/<runId>/ path that the MCP drain never reads (it expects the
// canonical nested runs/<mission>/<runId>/ layout).
// Fix mirrors run-store.ts:lookupMissionId — active-run.json first, dir scan second.

describe("post-tool-use — signal inbox path resolution (BUG H)", () => {
  const RUN_ID = "run-bugH-001";
  const MISSION_ID = "mission-bugH-001";
  let tmpDir: string;

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves nested path via active-run.json when EVOR_MISSION_ID env is unset", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "evor-bugH-ar-"));
    mkdirSync(join(tmpDir, "runs", MISSION_ID, RUN_ID), { recursive: true });
    writeFileSync(
      join(tmpDir, "active-run.json"),
      JSON.stringify({ run_id: RUN_ID, mission_id: MISSION_ID }),
    );

    const result = runHookWithStdin(
      POST_TOOL_USE,
      // NO EVOR_MISSION_ID — must be recovered from active-run.json
      { EVOR_ACTIVE_RUN_ID: RUN_ID, EVOR_ROOT: tmpDir },
      JSON.stringify({
        tool_name: "Bash",
        tool_input: {},
        tool_response: '<evor-signal kind="failure">training diverged</evor-signal>',
      }),
    );
    expect(result.status).toBe(0);

    // Inbox must land at canonical nested path
    expect(existsSync(join(tmpDir, "runs", MISSION_ID, RUN_ID, "signals-inbox.jsonl"))).toBe(true);
    // Must NOT land at flat path
    expect(existsSync(join(tmpDir, "runs", RUN_ID, "signals-inbox.jsonl"))).toBe(false);
  });

  it("resolves nested path via directory scan when active-run.json names a different run", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "evor-bugH-scan-"));
    mkdirSync(join(tmpDir, "runs", MISSION_ID, RUN_ID), { recursive: true });
    // active-run.json points to a different run — scan fallback must find MISSION_ID
    writeFileSync(
      join(tmpDir, "active-run.json"),
      JSON.stringify({ run_id: "other-run", mission_id: "other-mission" }),
    );

    const result = runHookWithStdin(
      POST_TOOL_USE,
      { EVOR_ACTIVE_RUN_ID: RUN_ID, EVOR_ROOT: tmpDir },
      JSON.stringify({
        tool_name: "Bash",
        tool_input: {},
        tool_response: '<evor-signal kind="failure">loss exploded</evor-signal>',
      }),
    );
    expect(result.status).toBe(0);

    expect(existsSync(join(tmpDir, "runs", MISSION_ID, RUN_ID, "signals-inbox.jsonl"))).toBe(true);
  });

  it("falls back to flat path when no active-run.json and no nested dir exist (bare/legacy run)", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "evor-bugH-flat-"));
    // Only flat layout — no mission nesting, no active-run.json
    mkdirSync(join(tmpDir, "runs", RUN_ID), { recursive: true });

    const result = runHookWithStdin(
      POST_TOOL_USE,
      { EVOR_ACTIVE_RUN_ID: RUN_ID, EVOR_ROOT: tmpDir },
      JSON.stringify({
        tool_name: "Bash",
        tool_input: {},
        tool_response: '<evor-signal kind="observation">step 10 loss 2.1</evor-signal>',
      }),
    );
    expect(result.status).toBe(0);

    expect(existsSync(join(tmpDir, "runs", RUN_ID, "signals-inbox.jsonl"))).toBe(true);
  });

  it("exits 0 safely (fail-open) when EVOR_ROOT does not exist", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "evor-bugH-noroot-"));
    // EVOR_ROOT points to a nonexistent subdir — resolution must not throw
    const result = runHookWithStdin(
      POST_TOOL_USE,
      { EVOR_ACTIVE_RUN_ID: RUN_ID, EVOR_ROOT: join(tmpDir, "nonexistent") },
      JSON.stringify({
        tool_name: "Bash",
        tool_input: {},
        tool_response: '<evor-signal kind="observation">test</evor-signal>',
      }),
    );
    expect(result.status).toBe(0);
  });
});

// ─── session-start hook — workspace classification (distill nudge) ────────────
//
// Each test builds a controlled workspace dir and sets EVOR_ROOT to its .evor/
// subdirectory.  The hook derives workspaceRoot = dirname(evorRoot) so the scan
// lands exactly where the test places ML artifacts.
// .deps-ok is pre-seeded in each evorRoot so the dep-check doesn't interfere.

describe("session-start hook — workspace classification (distill nudge)", () => {
  let workspaceDir: string;
  let evorRootDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "evor-ws-test-"));
    evorRootDir  = join(workspaceDir, ".evor");
    mkdirSync(evorRootDir, { recursive: true });
    // Skip dep-check and uv-check so only workspace classification logic is exercised.
    writeFileSync(join(evorRootDir, ".deps-ok"), "cached");
    writeFileSync(join(evorRootDir, ".uv-ok"), "cached");
    // No active-run.json → hook takes the no-active-run / classification path.
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("emits distill nudge for a brownfield workspace (model.pt + data/ + config.yaml)", () => {
    // model.pt with an old mtime so it is NOT in the "recent" window → brownfield, not possibly-training.
    writeFileSync(join(workspaceDir, "model.pt"), "fake weights");
    const oldDate = new Date(Date.now() - 2 * 3600 * 1000); // 2 hours ago
    utimesSync(join(workspaceDir, "model.pt"), oldDate, oldDate);

    mkdirSync(join(workspaceDir, "data"), { recursive: true });
    writeFileSync(join(workspaceDir, "data", "train.csv"), "label,x\n1,0.5\n");
    writeFileSync(join(workspaceDir, "config.yaml"), "lr: 0.001\nbatch_size: 32\n");

    const result = runHook(SESSION_START, { EVOR_ROOT: evorRootDir });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");

    const output = JSON.parse(result.stdout.trim());
    expect(output.message).toBeDefined();
    expect(output.message).toMatch(/oh-my-evor/);
    expect(output.message).toMatch(/existing ML project/);
    expect(output.message).toMatch(/evor-distill/);
    expect(output.message).toMatch(/evor-setup/);
    expect(output.message).toMatch(/Nothing has been changed/);
    // Must NOT include the possibly-training warning
    expect(output.message).not.toMatch(/run may be active/);
  });

  it("stays silent (no nudge) for a greenfield workspace with no ML artifacts", () => {
    mkdirSync(join(workspaceDir, "src"), { recursive: true });
    writeFileSync(join(workspaceDir, "src", "app.py"), "print('hello')\n");
    writeFileSync(join(workspaceDir, "README.md"), "# My App\n");

    const result = runHook(SESSION_START, { EVOR_ROOT: evorRootDir });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");

    const output = JSON.parse(result.stdout.trim());
    // Greenfield: no nudge, no message at all (dep-check also skipped)
    const msg = output.message ?? "";
    expect(msg).not.toMatch(/evor-distill/);
    expect(msg).not.toMatch(/existing ML project/);
  });

  it("includes 'run may be active' warning for possibly-training workspace (recent checkpoint)", () => {
    // checkpoint.pt written right now → mtime is within the 600 s window → possibly-training
    writeFileSync(join(workspaceDir, "checkpoint.pt"), "fake ckpt data");
    mkdirSync(join(workspaceDir, "data"), { recursive: true });

    const result = runHook(SESSION_START, { EVOR_ROOT: evorRootDir });
    expect(result.status).toBe(0);

    const output = JSON.parse(result.stdout.trim());
    expect(output.message).toBeDefined();
    expect(output.message).toMatch(/existing ML project/);
    expect(output.message).toMatch(/run may be active/);
    expect(output.message).toMatch(/EVOR will not touch it/);
  });

  it("exits 0 and emits valid JSON on a totally missing EVOR_ROOT (fail-open)", () => {
    // EVOR_ROOT points to a path that does not exist — nothing should throw.
    const missingRoot = join(tmpdir(), `evor-missing-${Date.now()}`);

    const result = runHook(SESSION_START, { EVOR_ROOT: missingRoot });
    expect(result.status).toBe(0);
    // Must still emit valid JSON with env
    const output = JSON.parse(result.stdout.trim());
    expect(output.env).toBeDefined();
    expect(output.env.EVOR_PLUGIN_ROOT).toBeTruthy();
  });
});
