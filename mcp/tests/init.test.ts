/**
 * tests/init.test.ts
 * Unit tests for tools/init.ts: initRun + evor_init_run tool registration.
 *
 * NOTE: harness/evor/init_run.py was under parallel development at the time
 * these tests were written. callPythonModule is stubbed via vi.mock so the
 * suite runs without Python. The stubs verify:
 *   - the correct module + arg order is passed to callPythonModule
 *   - optional flags (--run-id, --mission-id, --run-dir) are appended only
 *     when the caller supplies them
 *   - the temp answers file path is passed as the --answers argument
 *   - validation errors from the harness reach the caller (never swallowed)
 *   - the fallback sentinel fires when PyResult.error is undefined
 *
 * Once init_run.py ships, a companion integration test can be added that
 * sets EVOR_PYTHON + EVOR_HARNESS_DIR and asserts the real artifacts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync } from "fs";

// vi.mock is hoisted by vitest before all imports, so callPythonModule is
// already replaced when tools/init.ts is first imported.
vi.mock("../src/subprocess-bridge.js", () => ({
  callPythonModule: vi.fn(),
  callBridge: vi.fn(),
}));

import { initRun } from "../src/tools/init.js";
import { callPythonModule } from "../src/subprocess-bridge.js";

const mockedCallPythonModule = vi.mocked(callPythonModule);

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Minimal complete GoalContract-shaped answers (mirrors contracts.ts / contracts.py). */
const VALID_ANSWERS: Record<string, unknown> = {
  mission_id: "m-test-001",
  mode: "from-scratch",
  mission_type: "fixed",
  task_description: "Maximise accuracy on CIFAR-10",
  dataset_ref: "cifar10-v1",
  metrics: [{ name: "accuracy", direction: "higher", primary: true }],
  metric_specs: [
    {
      metric_name: "accuracy",
      direction: "higher",
      domain_applicability: "all",
      aggregation_rule: "macro_avg",
      role: "primary_fitness",
    },
  ],
  fitness_mode: "aggregate",
  eval_version: "v1",
  baseline_value: 0.72,
  stop_condition: { type: "beat-baseline" },
  wildness: 0.3,
  budget: {
    max_iterations: 20,
    plateau_window: 5,
    circuit_breaker: 10,
    max_cost_usd: 50.0,
  },
  locked_split_hash: "abc123",
  eval_script_hash: "def456",
  allowed_licenses: ["MIT", "Apache-2.0"],
  created_at: "2026-01-01T00:00:00Z",
};

const MOCK_SUMMARY = {
  ok: true as const,
  mission_id: "m-test-001",
  run_id: "m-test-001-20260101T000000",
  run_dir: "/tmp/evor/runs/m-test-001/m-test-001-20260101T000000",
  goal_contract_path:
    "/tmp/evor/runs/m-test-001/m-test-001-20260101T000000/goal-contract.json",
};

// ── Success path ─────────────────────────────────────────────────────────────

describe("initRun — success path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedCallPythonModule.mockReturnValue({ ok: true, data: MOCK_SUMMARY });
  });

  it("returns the parsed summary on success", () => {
    const result = initRun(VALID_ANSWERS);
    expect(result).toMatchObject({ ok: true, mission_id: "m-test-001" });
  });

  it("calls callPythonModule with module='evor'", () => {
    initRun(VALID_ANSWERS);
    const [module] = mockedCallPythonModule.mock.calls[0];
    expect(module).toBe("evor");
  });

  it("passes 'init-run' as the first arg followed by '--answers <path>'", () => {
    initRun(VALID_ANSWERS);
    const [, args] = mockedCallPythonModule.mock.calls[0];
    expect(args[0]).toBe("init-run");
    expect(args[1]).toBe("--answers");
    // Third arg is the temp file path — must be an absolute path ending in .json
    expect(args[2]).toMatch(/\.json$/);
    expect(args[2]).toMatch(/evor-init-answers-/);
  });

  it("omits optional flags when no opts are supplied", () => {
    initRun(VALID_ANSWERS);
    const [, args] = mockedCallPythonModule.mock.calls[0];
    expect(args).not.toContain("--run-id");
    expect(args).not.toContain("--mission-id");
    expect(args).not.toContain("--run-dir");
  });

  it("appends --run-id when runId is provided", () => {
    initRun(VALID_ANSWERS, { runId: "my-run-42" });
    const [, args] = mockedCallPythonModule.mock.calls[0];
    const idx = args.indexOf("--run-id");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("my-run-42");
  });

  it("appends --mission-id when missionId is provided", () => {
    initRun(VALID_ANSWERS, { missionId: "mission-override" });
    const [, args] = mockedCallPythonModule.mock.calls[0];
    const idx = args.indexOf("--mission-id");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("mission-override");
  });

  it("appends --run-dir when runDir is provided", () => {
    initRun(VALID_ANSWERS, { runDir: "/custom/run/dir" });
    const [, args] = mockedCallPythonModule.mock.calls[0];
    const idx = args.indexOf("--run-dir");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("/custom/run/dir");
  });

  it("appends all three optional flags together when all opts are provided", () => {
    initRun(VALID_ANSWERS, {
      runId: "r1",
      missionId: "m1",
      runDir: "/some/dir",
    });
    const [, args] = mockedCallPythonModule.mock.calls[0];
    expect(args).toContain("--run-id");
    expect(args).toContain("--mission-id");
    expect(args).toContain("--run-dir");
  });
});

// ── Error surfacing (never swallows) ─────────────────────────────────────────

describe("initRun — error surfacing", () => {
  it("returns {ok:false, error} when harness exits 1 with a validation message", () => {
    // Mirrors: harness prints {"error":"..."} on stdout + exits 1;
    // _parseSpawnResult extracts it into PyResult.error.
    mockedCallPythonModule.mockReturnValue({
      ok: false,
      error: "1 validation error for GoalContract\nbaseline_value\n  Field required",
      data: { error: "1 validation error for GoalContract\nbaseline_value\n  Field required" },
      exitCode: 1,
    });
    const result = initRun({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/validation error/i);
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it("surfaces a non-empty error when Python fails to spawn (ENOENT)", () => {
    mockedCallPythonModule.mockReturnValue({
      ok: false,
      error: "spawn python3 ENOENT",
    });
    const result = initRun(VALID_ANSWERS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeTruthy();
    }
  });

  it("uses the sentinel 'evor init-run failed' when PyResult.error is undefined", () => {
    // Worst case: bridge returns ok:false but no error string.
    mockedCallPythonModule.mockReturnValue({ ok: false });
    const result = initRun(VALID_ANSWERS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("evor init-run failed");
    }
  });

  it("returns {ok:false} when callPythonModule returns ok:true but data is null", () => {
    // _parseSpawnResult returns {ok:true, data:null} on empty stdout + exit 0.
    mockedCallPythonModule.mockReturnValue({ ok: true, data: null });
    const result = initRun(VALID_ANSWERS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/no JSON output/i);
    }
  });
});

// ── Temp file lifecycle ──────────────────────────────────────────────────────

describe("initRun — temp file cleanup", () => {
  it("deletes the temp answers file after a successful call", () => {
    let capturedPath: string | undefined;
    mockedCallPythonModule.mockImplementationOnce((_mod, args) => {
      capturedPath = args[2]; // the --answers value
      return { ok: true, data: MOCK_SUMMARY };
    });

    initRun(VALID_ANSWERS);

    // File must be gone after the call (finally block ran)
    expect(capturedPath).toBeDefined();
    if (capturedPath) {
      expect(existsSync(capturedPath)).toBe(false);
    }
  });

  it("deletes the temp answers file even when the harness returns an error", () => {
    let capturedPath: string | undefined;
    mockedCallPythonModule.mockImplementationOnce((_mod, args) => {
      capturedPath = args[2];
      return { ok: false, error: "bad input", exitCode: 1 };
    });

    initRun({});

    expect(capturedPath).toBeDefined();
    if (capturedPath) {
      expect(existsSync(capturedPath)).toBe(false);
    }
  });
});
