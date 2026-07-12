/**
 * tests/compute.test.ts
 * Unit tests for tools/compute.ts: compute wrappers.
 *
 * callPythonModule is mocked (vi.mock) so the suite runs without Python.
 * Tests verify:
 *   - jobStart builds the correct module + arg list and is non-blocking
 *     (spawnSync is synchronous by definition, but the Python subprocess
 *      returns immediately because it just spawns a detached supervisor)
 *   - jobStatus builds the correct arg list
 *   - validateRun, doctorRun, preflightRun pass the right args
 *   - all wrappers surface {error} on PyResult failure (never throw)
 *   - evor_run_start tool returns job handle without blocking
 */

import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// vi.mock is hoisted before imports — callPythonModule is replaced for the
// entire compute.ts module before it first loads.
vi.mock("../src/subprocess-bridge.js", () => ({
  callPythonModule: vi.fn(),
  callBridge: vi.fn(),
}));

import {
  jobStart,
  jobStatus,
  validateRun,
  doctorRun,
  preflightRun,
  freezeSplits,
  initEvalSuite,
  metaEvolve,
  distillScan,
  plotReport,
  forgeDispatchBatch,
} from "../src/tools/compute.js";
import { callPythonModule } from "../src/subprocess-bridge.js";

const mockedCall = vi.mocked(callPythonModule);

// ── Lifecycle ─────────────────────────────────────────────────────────────────

let tmpRoot: string;
let savedEvorRoot: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "evor-compute-test-"));
  savedEvorRoot = process.env.EVOR_ROOT;
  process.env.EVOR_ROOT = tmpRoot;
  mockedCall.mockReset();
});

afterEach(() => {
  if (savedEvorRoot === undefined) {
    delete process.env.EVOR_ROOT;
  } else {
    process.env.EVOR_ROOT = savedEvorRoot;
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

const OK_JOB_HANDLE = {
  ok: true as const,
  data: {
    job_id: "job-abc-123",
    status_path: "/tmp/run/jobs/job-abc-123/status.json",
    log_path: "/tmp/run/jobs/job-abc-123/log.jsonl",
  },
};

const OK_STATUS = {
  ok: true as const,
  data: { state: "running", job_id: "job-abc-123", started_at: "2026-01-01T00:00:00Z" },
};

const FAIL_RESULT = { ok: false as const, error: "python not found" };

// ── jobStart ──────────────────────────────────────────────────────────────────

describe("jobStart", () => {
  it("calls evor.jobs start with correct module + run-dir + cmd-json", () => {
    mockedCall.mockReturnValue(OK_JOB_HANDLE);
    const runDir = join(tmpRoot, "runs", "m1", "r1");
    jobStart("node-1", "run-1", runDir, "/wt/path");

    expect(mockedCall).toHaveBeenCalledOnce();
    const [module, args] = mockedCall.mock.calls[0];
    expect(module).toBe("evor.jobs");
    expect(args[0]).toBe("start");
    expect(args).toContain("--run-dir");
    expect(args).toContain(runDir);
    expect(args).toContain("--cmd-json");
    // cmd-json must embed --node-id, --run-id, --worktree, --run-dir
    const cmdJson = args[args.indexOf("--cmd-json") + 1];
    const cmd = JSON.parse(cmdJson as string) as string[];
    expect(cmd).toContain("--node-id");
    expect(cmd).toContain("node-1");
    expect(cmd).toContain("--worktree");
    expect(cmd).toContain("/wt/path");
  });

  it("appends --eval-version when provided", () => {
    mockedCall.mockReturnValue(OK_JOB_HANDLE);
    const runDir = join(tmpRoot, "runs", "m1", "r1");
    jobStart("n", "r", runDir, "/wt", "v2");
    const [, args] = mockedCall.mock.calls[0];
    const cmdJson = args[args.indexOf("--cmd-json") + 1];
    const cmd = JSON.parse(cmdJson as string) as string[];
    expect(cmd).toContain("--eval-version");
    expect(cmd).toContain("v2");
  });

  it("returns PyResult on success", () => {
    mockedCall.mockReturnValue(OK_JOB_HANDLE);
    const result = jobStart("n", "r", join(tmpRoot, "r"), "/wt");
    expect(result.ok).toBe(true);
    expect((result.data as Record<string, unknown>).job_id).toBeDefined();
  });

  it("returns structured error when callPythonModule fails (never throws)", () => {
    mockedCall.mockReturnValue(FAIL_RESULT);
    expect(() => jobStart("n", "r", tmpRoot, "/wt")).not.toThrow();
    const result = jobStart("n", "r", tmpRoot, "/wt");
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("completes synchronously in <2 s (mock returns instantly)", () => {
    mockedCall.mockReturnValue(OK_JOB_HANDLE);
    const t0 = Date.now();
    jobStart("n", "r", tmpRoot, "/wt");
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});

// ── jobStatus ─────────────────────────────────────────────────────────────────

describe("jobStatus", () => {
  it("calls evor.jobs status with correct args", () => {
    mockedCall.mockReturnValue(OK_STATUS);
    const runDir = join(tmpRoot, "runs", "m1", "r1");
    jobStatus("job-abc-123", runDir);
    const [module, args] = mockedCall.mock.calls[0];
    expect(module).toBe("evor.jobs");
    expect(args[0]).toBe("status");
    expect(args).toContain("--job-id");
    expect(args).toContain("job-abc-123");
    expect(args).toContain("--run-dir");
    expect(args).toContain(runDir);
  });

  it("returns state from successful call", () => {
    mockedCall.mockReturnValue(OK_STATUS);
    const result = jobStatus("j", tmpRoot);
    expect(result.ok).toBe(true);
    expect((result.data as Record<string, unknown>).state).toBe("running");
  });

  it("returns error dict when call fails (never throws)", () => {
    mockedCall.mockReturnValue(FAIL_RESULT);
    expect(() => jobStatus("j", tmpRoot)).not.toThrow();
    const result = jobStatus("j", tmpRoot);
    expect(result.ok).toBe(false);
  });
});

// ── validateRun ───────────────────────────────────────────────────────────────

describe("validateRun", () => {
  it("calls evor validate with --run-id <runDir>", () => {
    mockedCall.mockReturnValue({ ok: true, data: { ok: true, verdict: "VALID" } });
    validateRun("/path/to/run");
    const [module, args] = mockedCall.mock.calls[0];
    expect(module).toBe("evor");
    expect(args[0]).toBe("validate");
    expect(args).toContain("--run-id");
    expect(args).toContain("/path/to/run");
  });

  it("surfaces error on failure", () => {
    mockedCall.mockReturnValue(FAIL_RESULT);
    const r = validateRun("/run");
    expect(r.ok).toBe(false);
    expect(r.error).toBeDefined();
  });
});

// ── doctorRun ─────────────────────────────────────────────────────────────────

describe("doctorRun", () => {
  it("calls evor doctor without run-id when omitted", () => {
    mockedCall.mockReturnValue({ ok: true, data: {} });
    doctorRun();
    const [module, args] = mockedCall.mock.calls[0];
    expect(module).toBe("evor");
    expect(args[0]).toBe("doctor");
    expect(args).not.toContain("--run-id");
  });

  it("appends --run-id and --repair when provided", () => {
    mockedCall.mockReturnValue({ ok: true, data: {} });
    doctorRun("/run", true);
    const [, args] = mockedCall.mock.calls[0];
    expect(args).toContain("--run-id");
    expect(args).toContain("/run");
    expect(args).toContain("--repair");
  });
});

// ── preflightRun ─────────────────────────────────────────────────────────────

describe("preflightRun", () => {
  it("calls evor preflight with run-id and run-dir", () => {
    mockedCall.mockReturnValue({ ok: true, data: { passed: true } });
    preflightRun("run-1", "/runs/run-1");
    const [module, args] = mockedCall.mock.calls[0];
    expect(module).toBe("evor");
    expect(args).toContain("preflight");
    expect(args).toContain("--run-id");
    expect(args).toContain("run-1");
    expect(args).toContain("--run-dir");
    expect(args).toContain("/runs/run-1");
  });

  it("appends --no-gpu-check when requested", () => {
    mockedCall.mockReturnValue({ ok: true, data: { passed: true } });
    preflightRun("r", "/r", true);
    const [, args] = mockedCall.mock.calls[0];
    expect(args).toContain("--no-gpu-check");
  });

  // ── P1-9: mode param ────────────────────────────────────────────────────────
  it("P1-9: passes --mode env_only when mode='env_only'", () => {
    mockedCall.mockReturnValue({ ok: true, data: { passed: true } });
    preflightRun("run-1", "/runs/run-1", false, "env_only");
    const [, args] = mockedCall.mock.calls[0];
    expect(args).toContain("--mode");
    expect(args).toContain("env_only");
  });

  it("P1-9: passes --mode full when mode='full'", () => {
    mockedCall.mockReturnValue({ ok: true, data: { passed: true } });
    preflightRun("run-1", "/runs/run-1", false, "full");
    const [, args] = mockedCall.mock.calls[0];
    expect(args).toContain("--mode");
    expect(args).toContain("full");
  });

  it("P1-9: does not append --mode when mode is omitted (default full behaviour)", () => {
    mockedCall.mockReturnValue({ ok: true, data: { passed: true } });
    preflightRun("run-1", "/runs/run-1");
    const [, args] = mockedCall.mock.calls[0];
    expect(args).not.toContain("--mode");
  });
});

// ── freezeSplits ─────────────────────────────────────────────────────────────

describe("freezeSplits", () => {
  it("calls evor.freeze freeze-splits with required args", () => {
    mockedCall.mockReturnValue({ ok: true, data: { locked_split_hash: "abc" } });
    freezeSplits("/data", "v1", "/runs/r1", "m1");
    const [module, args] = mockedCall.mock.calls[0];
    expect(module).toBe("evor.freeze");
    expect(args).toContain("freeze-splits");
    expect(args).toContain("--dataset-path");
    expect(args).toContain("/data");
    expect(args).toContain("--eval-version");
    expect(args).toContain("v1");
    expect(args).toContain("--run-dir");
    expect(args).toContain("--mission-id");
    expect(args).toContain("m1");
  });
});

// ── initEvalSuite ─────────────────────────────────────────────────────────────

describe("initEvalSuite", () => {
  it("calls evor.benchmark init-eval-suite with correct args", () => {
    mockedCall.mockReturnValue({ ok: true, data: { eval_version: "v1" } });
    initEvalSuite("mission-1", "v1", "Classify CIFAR-10", "/runs/r1");
    const [module, args] = mockedCall.mock.calls[0];
    expect(module).toBe("evor.benchmark");
    expect(args).toContain("init-eval-suite");
    expect(args).toContain("--mission-id");
    expect(args).toContain("mission-1");
    expect(args).toContain("--eval-version");
    expect(args).toContain("v1");
    expect(args).toContain("--task-description");
    expect(args).toContain("Classify CIFAR-10");
  });
});

// ── metaEvolve ───────────────────────────────────────────────────────────────

describe("metaEvolve", () => {
  it("calls evor.tree meta-evolve with --run-id", () => {
    mockedCall.mockReturnValue({ ok: true, data: {} });
    metaEvolve("/runs/r1");
    const [module, args] = mockedCall.mock.calls[0];
    expect(module).toBe("evor.tree");
    expect(args).toContain("meta-evolve");
    expect(args).toContain("--run-id");
    expect(args).toContain("/runs/r1");
  });
});

// ── distillScan ───────────────────────────────────────────────────────────────

describe("distillScan", () => {
  it("calls evor distill scan --json with --root", () => {
    mockedCall.mockReturnValue({ ok: true, data: {} });
    distillScan("/workspace");
    const [module, args] = mockedCall.mock.calls[0];
    expect(module).toBe("evor");
    expect(args).toContain("distill");
    expect(args).toContain("scan");
    expect(args).toContain("--root");
    expect(args).toContain("/workspace");
    expect(args).toContain("--json");
  });

  it("appends --evor-root when provided", () => {
    mockedCall.mockReturnValue({ ok: true, data: {} });
    distillScan("/ws", "/custom/.evor");
    const [, args] = mockedCall.mock.calls[0];
    expect(args).toContain("--evor-root");
    expect(args).toContain("/custom/.evor");
  });
});

// ── plotReport ───────────────────────────────────────────────────────────────

describe("plotReport", () => {
  it("calls evor.plot_tree with run-id, run-dir, format", () => {
    mockedCall.mockReturnValue({ ok: true, data: null });
    plotReport("run-1", "/runs/r1", "html");
    const [module, args] = mockedCall.mock.calls[0];
    expect(module).toBe("evor.plot_tree");
    expect(args).toContain("--run-id");
    expect(args).toContain("run-1");
    expect(args).toContain("--run-dir");
    expect(args).toContain("/runs/r1");
    expect(args).toContain("--format");
    expect(args).toContain("html");
  });

  it("defaults format to png", () => {
    mockedCall.mockReturnValue({ ok: true, data: null });
    plotReport("r", "/r");
    const [, args] = mockedCall.mock.calls[0];
    expect(args).toContain("png");
  });
});

// ── P0-3: evor_forge_dispatch_batch ──────────────────────────────────────────

describe("forgeDispatchBatch (P0-3)", () => {
  const makeJobHandle = (jobId: string) => ({
    ok: true as const,
    data: {
      job_id: jobId,
      status_path: `/tmp/run/jobs/${jobId}/status.json`,
      log_path: `/tmp/run/jobs/${jobId}/log.jsonl`,
    },
  });

  it("returns one result per candidate without blocking (2 candidates)", () => {
    mockedCall
      .mockReturnValueOnce(makeJobHandle("job-c1"))
      .mockReturnValueOnce(makeJobHandle("job-c2"));

    const runDir = join(tmpRoot, "runs", "m1", "r1");
    const result = forgeDispatchBatch("run-1", [
      { node_id: "node-1", worktree: "/wt/c1" },
      { node_id: "node-2", worktree: "/wt/c2" },
    ], runDir);

    expect(result.dispatched).toHaveLength(2);
    expect(result.dispatched[0].node_id).toBe("node-1");
    expect(result.dispatched[0].job_id).toBe("job-c1");
    expect(result.dispatched[0].ok).toBe(true);
    expect(result.dispatched[1].node_id).toBe("node-2");
    expect(result.dispatched[1].job_id).toBe("job-c2");
    expect(result.run_id).toBe("run-1");
    // callPythonModule must be called once per candidate
    expect(mockedCall).toHaveBeenCalledTimes(2);
  });

  it("auto-computes gpu_fraction = 0.5 when 2 candidates and no explicit fraction", () => {
    mockedCall
      .mockReturnValueOnce(makeJobHandle("job-a"))
      .mockReturnValueOnce(makeJobHandle("job-b"));

    const runDir = join(tmpRoot, "runs", "m1", "r1");
    const result = forgeDispatchBatch("run-1", [
      { node_id: "n1", worktree: "/wt/1" },
      { node_id: "n2", worktree: "/wt/2" },
    ], runDir);

    // gpu_fraction passed to each jobStart must reflect 0.5
    expect(result.gpu_fraction).toBeCloseTo(0.5);
  });

  it("respects explicit gpu_fraction=1.0 (sequential intent)", () => {
    mockedCall
      .mockReturnValueOnce(makeJobHandle("job-seq-1"))
      .mockReturnValueOnce(makeJobHandle("job-seq-2"));

    const runDir = join(tmpRoot, "runs", "m1", "r1");
    const result = forgeDispatchBatch("run-1", [
      { node_id: "n1", worktree: "/wt/1" },
      { node_id: "n2", worktree: "/wt/2" },
    ], runDir, 1.0);

    expect(result.gpu_fraction).toBe(1.0);
    // All candidates still dispatched
    expect(result.dispatched).toHaveLength(2);
  });

  // ── P0-3: EVOR_GPU_FRACTION env injection ─────────────────────────────────

  it("P0-3: injects EVOR_GPU_FRACTION≈0.333 into extraEnv of each jobStart call (3 candidates)", () => {
    mockedCall
      .mockReturnValueOnce(makeJobHandle("job-1"))
      .mockReturnValueOnce(makeJobHandle("job-2"))
      .mockReturnValueOnce(makeJobHandle("job-3"));

    const runDir = join(tmpRoot, "runs", "m1", "r1");
    const result = forgeDispatchBatch("run-1", [
      { node_id: "n1", worktree: "/wt/1" },
      { node_id: "n2", worktree: "/wt/2" },
      { node_id: "n3", worktree: "/wt/3" },
    ], runDir);

    expect(result.gpu_fraction).toBeCloseTo(1 / 3, 5);
    expect(mockedCall).toHaveBeenCalledTimes(3);

    for (const call of mockedCall.mock.calls) {
      // callPythonModule(module, args, opts) — opts is the 3rd arg
      const opts = call[2] as { extraEnv?: Record<string, string> } | undefined;
      expect(opts?.extraEnv?.EVOR_GPU_FRACTION).toBeDefined();
      expect(parseFloat(opts!.extraEnv!.EVOR_GPU_FRACTION)).toBeCloseTo(1 / 3, 5);
    }
  });

  it("P0-3: EVOR_GPU_FRACTION in extraEnv reflects explicit gpu_fraction override (0.7)", () => {
    mockedCall.mockReturnValueOnce(makeJobHandle("job-a"));

    const runDir = join(tmpRoot, "runs", "m1", "r1");
    forgeDispatchBatch("run-1", [{ node_id: "n1", worktree: "/wt/1" }], runDir, 0.7);

    const opts = mockedCall.mock.calls[0][2] as { extraEnv?: Record<string, string> } | undefined;
    expect(opts?.extraEnv?.EVOR_GPU_FRACTION).toBeDefined();
    expect(parseFloat(opts!.extraEnv!.EVOR_GPU_FRACTION)).toBeCloseTo(0.7, 5);
  });

  it("P0-3: jobStart passes extraEnv through to callPythonModule", () => {
    mockedCall.mockReturnValue(OK_JOB_HANDLE);
    const runDir = join(tmpRoot, "runs", "m1", "r1");
    jobStart("node-1", "run-1", runDir, "/wt/path", undefined, { EVOR_GPU_FRACTION: "0.5" });

    const opts = mockedCall.mock.calls[0][2] as { extraEnv?: Record<string, string> } | undefined;
    expect(opts?.extraEnv?.EVOR_GPU_FRACTION).toBe("0.5");
  });

  it("surfaces per-candidate errors without throwing when a job fails", () => {
    mockedCall
      .mockReturnValueOnce(makeJobHandle("job-ok"))
      .mockReturnValueOnce({ ok: false as const, error: "OOM on node n2" });

    const runDir = join(tmpRoot, "runs", "m1", "r1");
    // Single call — must not throw even when one candidate fails
    let result!: ReturnType<typeof forgeDispatchBatch>;
    expect(() => {
      result = forgeDispatchBatch("run-1", [
        { node_id: "n1", worktree: "/wt/1" },
        { node_id: "n2", worktree: "/wt/2" },
      ], runDir);
    }).not.toThrow();

    expect(result.dispatched).toHaveLength(2);
    const ok_candidate = result.dispatched.find((d) => d.node_id === "n1");
    expect(ok_candidate?.ok).toBe(true);
    const failed = result.dispatched.find((d) => d.node_id === "n2");
    expect(failed?.ok).toBe(false);
    expect(failed?.error).toBeDefined();
  });
});
