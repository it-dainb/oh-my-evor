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
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";

// Hooks live at ../../hooks/ relative to this file's directory in the repo.
// process.cwd() is the mcp/ workspace when vitest runs; __dirname is the same.
const HOOKS_DIR = resolve(process.cwd(), "../hooks");
const SESSION_START = join(HOOKS_DIR, "session-start.mjs");
const POST_TOOL_USE = join(HOOKS_DIR, "post-tool-use.mjs");
const STOP = join(HOOKS_DIR, "stop.mjs");

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

  it("exits 0 silently when active-run.json is absent (no active run)", () => {
    const result = runHook(SESSION_START, { EVOR_ROOT: tmpDir });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    // stdout is empty when no active run
    expect(result.stdout.trim()).toBe("");
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
