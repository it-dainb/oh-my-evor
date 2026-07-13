/**
 * tests/acquire.test.ts
 * Unit tests for tools/acquire.ts: evor_check_leakage tool wrapper.
 *
 * callPythonModule is mocked (vi.mock) so the suite runs without Python.
 * Tests verify:
 *   - checkLeakage builds the correct module + arg list
 *   - near_dup / intra_batch booleans are serialised as "true"/"false" strings
 *   - tool handler returns accepted_paths + drop counts on success
 *   - tool handler returns {ok:false, error} on PyResult failure
 *   - collision_log path is stripped to basename (no internal path leaks)
 *   - tool is registered under name "evor_check_leakage"
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/subprocess-bridge.js", () => ({
  callPythonModule: vi.fn(),
}));

import { checkLeakage, registerAcquireTools } from "../src/tools/acquire.js";
import { callPythonModule } from "../src/subprocess-bridge.js";

const mockedCall = vi.mocked(callPythonModule);

// ── Fake McpServer helper ─────────────────────────────────────────────────────

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;

function captureAcquireHandlers(): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  const fakeServer = {
    tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  };
  registerAcquireTools(fakeServer as never);
  return handlers;
}

async function callTool(
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const handler = captureAcquireHandlers().get(name);
  if (!handler) throw new Error(`tool "${name}" was not registered`);
  const res = await handler(args);
  return JSON.parse(res.content[0].text) as Record<string, unknown>;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

let tmpRoot: string;
let savedEvorRoot: string | undefined;
let runDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "evor-acquire-test-"));
  savedEvorRoot = process.env.EVOR_ROOT;
  process.env.EVOR_ROOT = tmpRoot;
  // Create a minimal run directory so resolveRunPaths succeeds
  mkdirSync(join(tmpRoot, "runs", "test-mission", "run-acq-001"), { recursive: true });
  writeFileSync(
    join(tmpRoot, "active-run.json"),
    JSON.stringify({ run_id: "run-acq-001", mission_id: "test-mission" })
  );
  runDir = join(tmpRoot, "runs", "test-mission", "run-acq-001");
  process.env.EVOR_MISSION_ID = "test-mission";
  mockedCall.mockReset();
});

afterEach(() => {
  if (savedEvorRoot === undefined) {
    delete process.env.EVOR_ROOT;
  } else {
    process.env.EVOR_ROOT = savedEvorRoot;
  }
  delete process.env.EVOR_MISSION_ID;
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── checkLeakage wrapper ──────────────────────────────────────────────────────

describe("checkLeakage", () => {
  it("calls python -m evor.acquire check-leakage with correct args", () => {
    mockedCall.mockReturnValue({ ok: true, data: { ok: true, accepted_paths: [] } });

    checkLeakage(
      ["/data/c1.txt", "/data/c2.txt"],
      "text",
      "/splits/v1-test.json",
      runDir,
      true,
      true,
    );

    expect(mockedCall).toHaveBeenCalledOnce();
    const [module, args] = mockedCall.mock.calls[0];
    expect(module).toBe("evor.acquire");
    expect(args[0]).toBe("check-leakage");
    expect(args).toContain("--candidate-paths");
    expect(args).toContain(JSON.stringify(["/data/c1.txt", "/data/c2.txt"]));
    expect(args).toContain("--modality");
    expect(args).toContain("text");
    expect(args).toContain("--forbidden-split");
    expect(args).toContain("/splits/v1-test.json");
    expect(args).toContain("--near-dup");
    expect(args).toContain("true");
    expect(args).toContain("--intra-batch");
    expect(args).toContain("true");
  });

  it("serialises near_dup=false as string 'false'", () => {
    mockedCall.mockReturnValue({ ok: true, data: null });

    checkLeakage([], "image", "/splits/v1-test.json", runDir, false, false);

    const [, args] = mockedCall.mock.calls[0];
    const ndIdx = args.indexOf("--near-dup");
    expect(args[ndIdx + 1]).toBe("false");
    const ibIdx = args.indexOf("--intra-batch");
    expect(args[ibIdx + 1]).toBe("false");
  });

  it("passes timeout of 120 seconds", () => {
    mockedCall.mockReturnValue({ ok: true, data: null });

    checkLeakage([], "tabular", "/splits/v1-test.json", runDir);

    const [, , opts] = mockedCall.mock.calls[0];
    expect((opts as { timeout?: number })?.timeout).toBe(120_000);
  });

  it("surfaces PyResult failure without throwing", () => {
    mockedCall.mockReturnValue({ ok: false, error: "python not found" });

    const result = checkLeakage([], "text", "/splits/v1-test.json", runDir);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("python not found");
  });
});

// ── evor_check_leakage tool ───────────────────────────────────────────────────

describe("evor_check_leakage tool", () => {
  it("is registered under the correct name", () => {
    const handlers = captureAcquireHandlers();
    expect(handlers.has("evor_check_leakage")).toBe(true);
  });

  it("returns accepted_paths and drop counts on success", async () => {
    mockedCall.mockReturnValue({
      ok: true,
      data: {
        ok: true,
        total_candidates: 3,
        dropped_for_collision: 1,
        dropped_for_near_dup: 0,
        dropped_intra_batch: 0,
        accepted_paths: ["/data/c2.txt", "/data/c3.txt"],
        collision_log: [{ path: "/data/c1.txt", collision_type: "exact_collision" }],
      },
    });

    const result = await callTool("evor_check_leakage", {
      run_id: "run-acq-001",
      candidate_paths: ["/data/c1.txt", "/data/c2.txt", "/data/c3.txt"],
      modality: "text",
      forbidden_split: "/splits/v1-test.json",
    });

    expect(result.ok).toBe(true);
    expect(result.total_candidates).toBe(3);
    expect(result.dropped_for_collision).toBe(1);
    expect(result.accepted_paths).toEqual(["/data/c2.txt", "/data/c3.txt"]);
  });

  it("strips full path to basename in collision_log (no internal path leaks)", async () => {
    mockedCall.mockReturnValue({
      ok: true,
      data: {
        ok: true,
        total_candidates: 1,
        dropped_for_collision: 1,
        dropped_for_near_dup: 0,
        dropped_intra_batch: 0,
        accepted_paths: [],
        collision_log: [
          { path: "/storages_local/research/.evor/runs/m/r/data/secret.txt", collision_type: "exact_collision" },
        ],
      },
    });

    const result = await callTool("evor_check_leakage", {
      run_id: "run-acq-001",
      candidate_paths: ["/data/secret.txt"],
      modality: "text",
      forbidden_split: "/splits/v1-test.json",
    });

    const log = result.collision_log as Array<{ path: string; collision_type: string }>;
    expect(log).toHaveLength(1);
    // Basename only — no directory components
    expect(log[0].path).toBe("secret.txt");
    expect(log[0].path).not.toContain("/");
    expect(log[0].collision_type).toBe("exact_collision");
  });

  it("returns {ok:false, error} when Python bridge fails", async () => {
    mockedCall.mockReturnValue({ ok: false, error: "evor.acquire module not found" });

    const result = await callTool("evor_check_leakage", {
      run_id: "run-acq-001",
      candidate_paths: ["/data/c.txt"],
      modality: "text",
      forbidden_split: "/splits/v1-test.json",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("defaults near_dup and intra_batch to true when omitted", async () => {
    mockedCall.mockReturnValue({
      ok: true,
      data: {
        ok: true,
        total_candidates: 0,
        dropped_for_collision: 0,
        dropped_for_near_dup: 0,
        dropped_intra_batch: 0,
        accepted_paths: [],
        collision_log: [],
      },
    });

    await callTool("evor_check_leakage", {
      run_id: "run-acq-001",
      candidate_paths: [],
      modality: "image",
      forbidden_split: "/splits/v1-test.json",
      // near_dup and intra_batch intentionally omitted
    });

    const [, args] = mockedCall.mock.calls[0];
    const ndIdx = args.indexOf("--near-dup");
    expect(args[ndIdx + 1]).toBe("true");
    const ibIdx = args.indexOf("--intra-batch");
    expect(args[ibIdx + 1]).toBe("true");
  });

  it("handles empty collision_log from harness gracefully", async () => {
    mockedCall.mockReturnValue({
      ok: true,
      data: {
        ok: true,
        total_candidates: 1,
        dropped_for_collision: 0,
        dropped_for_near_dup: 0,
        dropped_intra_batch: 0,
        accepted_paths: ["/data/c.txt"],
        collision_log: [],
      },
    });

    const result = await callTool("evor_check_leakage", {
      run_id: "run-acq-001",
      candidate_paths: ["/data/c.txt"],
      modality: "tabular",
      forbidden_split: "/splits/v1-test.json",
    });

    expect(result.collision_log).toEqual([]);
    expect(result.accepted_paths).toEqual(["/data/c.txt"]);
  });
});
