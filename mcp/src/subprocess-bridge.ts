/**
 * subprocess-bridge.ts — helpers for calling the Python harness from TypeScript.
 *
 * ADR-006: TS→Python bridge is per-call subprocess JSON (not a persistent socket).
 * Each call spawns `python -m evor.<module> <args>` or a mcp/bridge script and
 * parses the JSON written to stdout.
 */

import { spawnSync, SpawnSyncReturns } from "child_process";
import { resolve } from "path";

// In the esbuild CJS bundle, __dirname is the directory of the output file
// (mcp/dist/).  Bridge scripts live at mcp/bridge/, one level up.
// In tests (run via vitest from mcp/), __dirname is mcp/src/, so we resolve
// relative to that as well — the same join works in both cases because tests
// set EVOR_BRIDGE_DIR if they need a different location.
const _bridgeDir = process.env.EVOR_BRIDGE_DIR
  ?? resolve(__dirname, "..", "bridge");

/** Python executable — overridable for tests and non-default venvs. */
function pythonBin(): string {
  return process.env.EVOR_PYTHON ?? "python3";
}

export interface PyResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  stderr?: string;
  exitCode?: number;
}

function _parseSpawnResult(result: SpawnSyncReturns<string>): PyResult {
  if (result.error) {
    return { ok: false, error: result.error.message };
  }
  const code = result.status ?? 1;
  const stdoutStr = ((result.stdout as string) ?? "").trim();
  if (code !== 0) {
    // Bridge scripts report structured errors (e.g. "node not found in tree.json")
    // as JSON on STDOUT even when they exit non-zero. Surface that message instead
    // of a blank "python exited N" so the caller can act on it (this is what made
    // a missing-node failure look like a mysterious empty-stderr crash).
    let data: unknown = undefined;
    if (stdoutStr) {
      try { data = JSON.parse(stdoutStr); } catch { /* non-JSON stdout */ }
    }
    const structuredError =
      data && typeof data === "object" && "error" in (data as Record<string, unknown>)
        ? String((data as Record<string, unknown>).error)
        : "";
    const stderrStr = ((result.stderr as string) ?? "").trim();
    return {
      ok: false,
      exitCode: code,
      error: structuredError || stderrStr || stdoutStr || `python exited ${code}`,
      data,
      stderr: (result.stderr as string) ?? "",
    };
  }
  const stdout = stdoutStr;
  if (!stdout) {
    return { ok: true, data: null };
  }
  try {
    return { ok: true, data: JSON.parse(stdout) };
  } catch {
    return { ok: false, error: "non-JSON stdout from python", stderr: stdout };
  }
}

/**
 * Run `python -m <module> [...args]` synchronously; parse stdout as JSON.
 *
 * Used for modules that expose a `_cli()` / `if __name__ == "__main__"` entry
 * point (e.g. `python -m evor.tree select --run-id <id>`).
 */
export function callPythonModule(
  module: string,
  args: string[],
  opts?: { timeout?: number; cwd?: string }
): PyResult {
  const result = spawnSync(pythonBin(), ["-m", module, ...args], {
    encoding: "utf8",
    timeout: opts?.timeout ?? 30_000,
    env: process.env as Record<string, string>,
    cwd: opts?.cwd,
  });
  return _parseSpawnResult(result);
}

/**
 * Run a Python bridge script from `mcp/bridge/` synchronously; parse stdout as JSON.
 *
 * Used for harness modules without a standalone CLI (integrity, scheduler).
 * Bridge scripts live in mcp/bridge/ so harness/evor/* is never modified.
 */
export function callBridge(
  scriptName: string,
  args: string[],
  opts?: { timeout?: number; cwd?: string }
): PyResult {
  const script = resolve(_bridgeDir, scriptName);
  const result = spawnSync(pythonBin(), [script, ...args], {
    encoding: "utf8",
    timeout: opts?.timeout ?? 60_000,
    env: process.env as Record<string, string>,
    cwd: opts?.cwd,
  });
  return _parseSpawnResult(result);
}
