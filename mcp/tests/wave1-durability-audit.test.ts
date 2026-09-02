/**
 * mcp/tests/wave1-durability-audit.test.ts
 *
 * Wave-1 RED — category 4: durability and audit (MCP side).
 *
 * The theme of this category is the DURABLE RECORD. In the field run the agents
 * reported honestly in conversation — lane I found zero overclaim and zero
 * fabrication — while the artifacts that survive the session recorded almost
 * none of it. These tests assert that a materially significant action leaves a
 * trace that outlives the conversation.
 *
 * Findings under test:
 *   I-01  decision-log.md held a header plus per-node stubs and nothing else, in
 *         all three missions. Two mission restarts, an evaluator rewritten and
 *         re-sealed three times, and four gate changes left no entry anywhere.
 *   I-11  Until one write at 2026-08-24T00:13:36Z all three missions read
 *         status "running"; `failed` + `superseded_by` + `superseded_reason`
 *         were typed into two of them at once, 14h39m after the fact.
 *   O-09  Same write, seen from the concurrency angle: the successor mission was
 *         created and running 40 seconds BEFORE its predecessors were recorded
 *         as dead.
 *   P-02  Live run state was written inside the installed plugin cache and the
 *         marketplace clone.
 *   A-04  ~3,000 lines of live plugin behaviour exist only in the installed
 *   P-01  cache and the marketplace clone, in no commit on any branch.
 *
 * These are expected to FAIL. No production file is modified by this suite.
 * `dist-freshness.test.ts` already covers dist-vs-src; the provenance block
 * here extends that idea to source-vs-commit and is deliberately disjoint
 * from it.
 */

import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "fs";
import { join, dirname, resolve } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { stateWrite, RunStatePatchSchema } from "../src/tools/state.js";
import { ensureRunDirs } from "../src/run-store.js";
import { registerComputeTools } from "../src/tools/compute.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ── Lifecycle ───────────────────────────────────────────────────────────────

const MISSION = "binarization-r1";
const RUN = "run-live-01";

let tmpRoot: string;
let savedEvorRoot: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "evor-durability-"));
  savedEvorRoot = process.env.EVOR_ROOT;
  process.env.EVOR_ROOT = tmpRoot;
});

afterEach(() => {
  if (savedEvorRoot === undefined) delete process.env.EVOR_ROOT;
  else process.env.EVOR_ROOT = savedEvorRoot;
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** Create a mission run directory with the artifacts a live mission holds. */
function seedRun(mission = MISSION, run = RUN): string {
  const paths = ensureRunDirs(run, mission);
  writeFileSync(
    join(paths.runDir, "mission-state.json"),
    JSON.stringify({ status: "running", objective: "binarise", current_tick: 1 }, null, 2),
    "utf8",
  );
  writeFileSync(paths.decisionLogPath, "# Decision Log\n\n- **mission_id**: " + mission + "\n", "utf8");
  writeFileSync(
    join(paths.runDir, "goal-contract.json"),
    JSON.stringify(
      {
        mission_id: mission,
        eval_version: "v1",
        eval_script_hash: "8d7107cf".padEnd(64, "0"),
        locked_split_hash: "cafebabe".padEnd(64, "0"),
      },
      null,
      2,
    ),
    "utf8",
  );
  return paths.runDir;
}

function decisionLog(runDir: string): string {
  const p = join(runDir, "decision-log.md");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

/** Register compute tools against a fake server and return one handler. */
function computeHandler(name: string): (args: never) => Promise<{ content: { text: string }[] }> {
  const handlers = new Map<string, (args: never) => Promise<{ content: { text: string }[] }>>();
  registerComputeTools({
    tool: (n: string, _d: string, _s: unknown, h: never) => {
      handlers.set(n, h as (args: never) => Promise<{ content: { text: string }[] }>);
    },
  } as never);
  const handler = handlers.get(name);
  if (!handler) throw new Error(`tool ${name} was not registered`);
  return handler;
}

// ────────────────────────────────────────────────────────────────────────────
// I-01 — the four event classes that never reached the decision log
// ────────────────────────────────────────────────────────────────────────────

describe("I-01 — a materially significant action reaches decision-log.md", () => {
  it("a mission status transition is recorded in the decision log", () => {
    // `stateWrite` is THE writer for mission_status: it read-modify-writes
    // mission-state.json and touches nothing else. A mission moving from
    // running to failed is the largest single event a run can record, and it
    // is the exact event I-01 found missing twice.
    const runDir = seedRun();
    const before = decisionLog(runDir);

    stateWrite(RUN, { mission_status: "failed" }, MISSION);

    const added = decisionLog(runDir).slice(before.length);
    expect(
      added.trim(),
      "stateWrite flipped mission-state.json to 'failed' and wrote NOTHING to " +
        "decision-log.md — the transition survives only as a mutated field with " +
        "no history (field-trace I-01)",
    ).not.toBe("");
    expect(added).toContain("failed");
  });

  it("re-sealing a changed evaluator is recorded in the decision log", async () => {
    // evor_seal_eval_script hashes eval-suites/<v>.py and patches
    // goal-contract.json's eval_script_hash. When the contract already anchors a
    // DIFFERENT hash, this call is not a first seal — it is an evaluator
    // replacement, silently overwriting the anchor that made the previous
    // mission's scores reproducible. In the field the anchor moved three times
    // (8d7107cf → 3dc2f7da → f123d17c → a3776de4) and f123d17c's evaluator now
    // exists nowhere on disk.
    const runDir = seedRun();
    mkdirSync(join(runDir, "eval-suites"), { recursive: true });
    writeFileSync(join(runDir, "eval-suites", "v1.py"), "def evaluate():\n    return 0.4872\n", "utf8");
    const before = decisionLog(runDir);

    const res = await computeHandler("evor_seal_eval_script")({
      run_id: RUN,
      eval_version: "v1",
      mission_id: MISSION,
    } as never);
    expect(JSON.parse(res.content[0].text).ok, "fixture: seal call failed").toBe(true);

    const contract = JSON.parse(readFileSync(join(runDir, "goal-contract.json"), "utf8"));
    expect(contract.eval_script_hash, "fixture: the seal anchor did not move").not.toBe(
      "8d7107cf".padEnd(64, "0"),
    );

    const added = decisionLog(runDir).slice(before.length);
    expect(
      added.trim(),
      "the sealed evaluator anchor was replaced with no decision-log entry — " +
        "the previous evaluator's scores become unreproducible and nothing " +
        "records that it changed (field-trace I-01)",
    ).not.toBe("");
  });

  it("mutating a sealed goal contract is recorded in the decision log", async () => {
    // Same writer, contract-mutation angle: patchGoalContract is the only code
    // path in the MCP server that rewrites a sealed goal-contract.json field,
    // and it is best-effort and silent by construction. Gate/threshold changes
    // (GPU 10ms→500ms, CPU 0.1s→1.0s, LAT_CPU_THREADS 32→8) were made against
    // this file and left no trace. The comparator that already does this right
    // is harness/evor/benchmark.py, which appends a "## BenchmarkUpgrade" block
    // for every eval-suite upgrade.
    const runDir = seedRun();
    mkdirSync(join(runDir, "eval-suites"), { recursive: true });
    writeFileSync(join(runDir, "eval-suites", "v1.py"), "# evaluator\n", "utf8");
    const contractBefore = readFileSync(join(runDir, "goal-contract.json"), "utf8");
    const logBefore = decisionLog(runDir);

    await computeHandler("evor_seal_eval_script")({
      run_id: RUN,
      eval_version: "v1",
      mission_id: MISSION,
    } as never);

    const contractAfter = readFileSync(join(runDir, "goal-contract.json"), "utf8");
    expect(contractAfter, "fixture: the contract was not mutated").not.toBe(contractBefore);

    const added = decisionLog(runDir).slice(logBefore.length);
    const changedFields = Object.keys(JSON.parse(contractAfter)).filter(
      (k) => JSON.parse(contractAfter)[k] !== JSON.parse(contractBefore)[k],
    );
    expect(
      added,
      `goal-contract.json fields ${JSON.stringify(changedFields)} were rewritten with ` +
        "no entry naming them in decision-log.md",
    ).toContain(changedFields[0]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// I-11 / O-09 — mission state is freely mutable and carries no history
// ────────────────────────────────────────────────────────────────────────────

describe("I-11 / O-09 — mission transitions are auditable", () => {
  it("every transition appends a timestamped, append-only audit entry", () => {
    // Choice of invariant: of the three candidates in the brief — reject a
    // retroactive write, record it as a dated correction, or make every
    // transition append-only — append-only is the one a single writer can
    // actually enforce, and it subsumes the other two: with a durable trail a
    // late correction is still visible AS a late correction, because its own
    // entry carries the time it was made. `updated_at` alone cannot do this: it
    // is overwritten by the next write, which is precisely why the field run's
    // history is unreconstructable from the state tree.
    const runDir = seedRun();

    stateWrite(RUN, { mission_status: "paused" }, MISSION);
    stateWrite(RUN, { mission_status: "failed" }, MISSION);

    const ms = JSON.parse(readFileSync(join(runDir, "mission-state.json"), "utf8"));
    const trail: unknown[] = Array.isArray(ms.status_history)
      ? ms.status_history
      : Array.isArray(ms.transitions)
        ? ms.transitions
        : [];

    expect(
      trail.length,
      "mission-state.json records only the CURRENT status; the running→paused " +
        "transition was overwritten by paused→failed and is gone. Two writes, " +
        `zero surviving history entries (keys: ${JSON.stringify(Object.keys(ms))})`,
    ).toBe(2);

    for (const entry of trail as Record<string, unknown>[]) {
      expect(entry.at ?? entry.timestamp, "an audit entry with no timestamp").toBeTruthy();
      expect(entry.to ?? entry.status, "an audit entry with no target status").toBeTruthy();
    }
  });

  it("a terminal transition carries a reason and names its successor", () => {
    // The field run's `superseded_by` and `superseded_reason` were typed in by
    // hand because the tool surface has no way to express them — the only
    // channel a mission has for "why did this stop" is a free-text edit of the
    // state file, 14 hours late, disagreeing with the run's own
    // tick-state halt_reason. Accepting the reason in the same call that makes
    // the transition is what removes the hand-edit.
    const parsed = RunStatePatchSchema.parse({
      mission_status: "failed",
      mission_status_reason: "sealed evaluator scored paper as ink (inverted GT polarity)",
      superseded_by: "binarization-worldmodel-min98-2026-08-r3",
    }) as Record<string, unknown>;

    expect(
      parsed.mission_status_reason,
      "RunStatePatchSchema silently drops the reason for a terminal transition — " +
        "there is no supported way to record WHY a mission failed, which is why " +
        "it was hand-written into the artifact 14h39m later (field-trace I-11)",
    ).toBeTruthy();
    expect(parsed.superseded_by, "no supported way to link a mission to its successor").toBeTruthy();
  });

  it("two missions in one .evor/ root cannot both be running", () => {
    // Three missions read status "running" concurrently for 15.6 hours. Nothing
    // in the writer prevents it: stateWrite patches whichever mission-state.json
    // the caller names, with no reference to any other mission in the root.
    seedRun("binarization-r1", RUN);
    seedRun("binarization-r2", RUN);

    stateWrite(RUN, { mission_status: "running" }, "binarization-r1");

    expect(
      () => stateWrite(RUN, { mission_status: "running" }, "binarization-r2"),
      "a second mission was marked running while binarization-r1 was already " +
        "running in the same .evor/ root (field-trace O-09)",
    ).toThrow(/running/i);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// P-02 — no MCP writer may put run state inside the installed plugin
// ────────────────────────────────────────────────────────────────────────────

describe("P-02 — the state root never resolves inside the installed plugin", () => {
  /** A directory that is unambiguously an installed Claude Code plugin. */
  function pluginRoot(): string {
    const root = join(tmpRoot, "plugins", "cache", "oh-my-evor", "oh-my-evor", "1.2.0");
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(root, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "oh-my-evor", version: "1.2.0" }),
      "utf8",
    );
    return root;
  }

  it("stateWrite refuses a run whose state root is inside a plugin tree", () => {
    // This is the writer that produced the artifacts P-02 found: active-run.json
    // and runs/frontier-1ms/run-live-01/mission-state.json, live inside BOTH the
    // plugin cache and the marketplace clone. A run recorded there is destroyed
    // by the next `claude plugin update` and leaks into every future project
    // that installs the plugin.
    //
    // (Sibling lane covers the hook-side resolver; this covers the MCP writers.)
    process.env.EVOR_ROOT = join(pluginRoot(), ".evor");

    expect(
      () =>
        stateWrite(
          RUN,
          {
            mission_status: "running",
            active_run: { mission_id: "frontier-1ms", run_id: RUN, run_dir: "x" },
          },
          "frontier-1ms",
        ),
      "stateWrite wrote mission state and active-run.json inside the installed " +
        "plugin tree (field-trace P-02)",
    ).toThrow(/plugin/i);

    expect(
      existsSync(join(pluginRoot(), ".evor", "active-run.json")),
      "active-run.json was written inside the installed plugin tree",
    ).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// A-04 / P-01 — a released plugin tree is verifiable against its commit
// ────────────────────────────────────────────────────────────────────────────

describe("A-04 / P-01 — the shipped tree can be checked against what was released", () => {
  // Scope note: that ~3,000 lines of in-place patching were never committed is a
  // PROCESS gap, and no unit test can commit them. What IS a code gap is that no
  // drift check is even possible: nothing records what the shipped tree is
  // supposed to contain, so a mutated installed tree is undetectable by any
  // means short of a manual `diff -rq` against a fresh clone — which is exactly
  // what lane A and lane P had to do by hand, after the fact.
  //
  // dist-freshness.test.ts asserts dist is not older than src, inside a
  // checkout. It cannot see the installed tree at all. This extends the same
  // idea one step: bind the shipped tree to a recorded commit.

  it("the release records the commit the shipped tree was built from", () => {
    const manifest = JSON.parse(readFileSync(join(REPO, ".claude-plugin", "plugin.json"), "utf8"));
    const provenanceFields = ["commit", "gitCommitSha", "sourceCommit", "revision"].filter(
      (k) => typeof manifest[k] === "string" && manifest[k],
    );
    const sidecars = ["MANIFEST.sha256", "manifest.json", "provenance.json"].filter((f) =>
      existsSync(join(REPO, ".claude-plugin", f)),
    );

    expect(
      [...provenanceFields, ...sidecars],
      "nothing in .claude-plugin/ records the commit or the per-file hashes the " +
        "shipped tree was built from, so an installed tree cannot be compared " +
        "against its release. plugin.json carries only a version string, and a " +
        "version string does not change when 15 files are patched in place " +
        "(field-trace A-04 / P-01)",
    ).not.toEqual([]);
  });

  it("a drift check exists that would flag a modified installed tree", () => {
    // `evor doctor` is the self-check that ships with the plugin and runs INSIDE
    // the installed tree — the only place a drift check could fire for a real
    // user. It currently checks .evor/ layout and mission state and says nothing
    // about the plugin's own files.
    const doctor = readFileSync(join(REPO, "harness", "evor", "doctor.py"), "utf8");
    expect(
      /plugin[_ -]?(tree|drift|provenance)|shipped[_ -]?tree|verify[_ -]?install/i.test(doctor),
      "harness/evor/doctor.py — the check that runs inside the installed tree — " +
        "has no plugin-tree drift check, so 15 modified tracked files and 26 " +
        "leftover .bak-* files went unreported for 19 hours (field-trace A-04 / P-01)",
    ).toBe(true);
  });
});
