/**
 * mcp/tests/wave1-identity-live-eval.test.ts — LIVE, hook-active and
 * MCP-attached red tests for category 3 (identity & state coupling).
 * Companion to the unit-level `wave1-identity-state.test.ts` and
 * `harness/tests/test_wave1_identity_state.py`, which it does not replace.
 *
 * THE DISTINCTION THAT MATTERS. The unit suite proves `resolveEvorRoot()`,
 * called directly with a constructed environment, returns the plugin's path.
 * That is the same shape of evidence `test_compaction_survival.py` already had
 * and it is exactly why Q-01 survived: a test that builds its own environment
 * can only ever check the branch it chose to build. The live probe launches a
 * REAL session the way the plugin loader does — hooks registered, a decoy
 * `CLAUDE_PLUGIN_ROOT` that has its own `.evor/`, and `EVOR_ROOT` deliberately
 * REMOVED from the child environment — and then reads the filesystem. That is
 * how you see the damage the unit test cannot express: another project's
 * mission-state being rewritten.
 *
 * GATING. Everything live is behind EVOR_LIVE_EVAL=1. That gate is not a
 * `.skip` of a deterministic failure: gate off, these do not run at all; gate
 * on, they must fail loudly. The probes throw on a CLI error, an unparseable
 * envelope, or a session in which no hook fired — an unreachable model is an
 * error, never a pass.
 *
 * FLAKINESS. The Q-01 probe is deterministic given that the hooks fire; its
 * assertions are on a filesystem diff and on the hook's own announced run dir,
 * neither of which depends on what the model chose to say. The O-02 arms are
 * not deterministic, and are labelled corroboration: the primary, forced-
 * interleaving evidence lives in the Python suite. The `mixed` arm carries its
 * own validity check — an arm whose writers never overlapped in time reports
 * `inconclusive-no-overlap` and fails as inconclusive rather than passing.
 *
 * SECRETS. One mkdtemp per probe; only the evor MCP server is attached
 * (--strict-mcp-config). No keyed server, no credential read or written.
 *
 * RUN:
 *   npm --prefix mcp run build
 *   EVOR_LIVE_EVAL=1 npx vitest run tests/wave1-identity-live-eval.test.ts
 */

import { describe, it, expect, beforeAll } from "vitest";

import {
  evorHookRecords,
  classifyResolvedRunDirs,
  missingSignatures,
  overlapWindow,
  emitTimes,
  probeHookRootResolution,
  probeSignalConcurrency,
  HOOK_MARK,
  DECOY_OBJECTIVE,
  PROJECT_OBJECTIVE,
} from "../../ci/identity-live-eval.mjs";

import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const LIVE = process.env.EVOR_LIVE_EVAL === "1";
const describeLive = describe.runIf(LIVE);

const LIVE_TIMEOUT = 900_000;

// ─────────────────────────────────────────────────────────────────────────────
// Analysis coverage — runs with the gate OFF.
//
// Every live assertion below is only as good as the parser underneath it. A
// transcript reader that silently returns [] would turn each live red into a
// false green, so the parsers are pinned without the network.
// ─────────────────────────────────────────────────────────────────────────────

describe("identity live-eval analysis (no network)", () => {
  const line = (attachment: unknown) => JSON.stringify({ attachment });

  it("recovers each hook's OWN exit code from the marker tail", () => {
    const records = evorHookRecords([
      line({ hookEvent: "SessionStart", stdout: "{}", stderr: `${HOOK_MARK}=session-start:0\n` }),
      line({ hookEvent: "Stop", stdout: "", stderr: `${HOOK_MARK}=stop:2\n` }),
      // A hook from someone else's plugin carries no marker and must be ignored.
      line({ hookEvent: "Stop", stdout: "", stderr: "unrelated hook\n" }),
      "",
      "not json",
    ]);
    expect(records.map((r) => [r.hook, r.exitCode])).toEqual([
      ["session-start", 0],
      ["stop", 2],
    ]);
  });

  it("reads the run dir the hooks announced, and attributes it to a root", () => {
    const decoy = "/tmp/sb/plugin/.evor";
    const project = "/tmp/sb/project/.evor";
    const records = evorHookRecords([
      line({
        hookEvent: "SessionStart",
        stdout: JSON.stringify({
          env: { EVOR_RUN_DIR: `${decoy}/runs/frontier-1ms/run-live-01` },
        }),
        stderr: `${HOOK_MARK}=session-start:0\n`,
      }),
    ]);
    const got = classifyResolvedRunDirs(records, decoy, project);
    expect(got.underDecoy).toHaveLength(1);
    expect(got.underProject).toHaveLength(0);
  });

  it("counts a signature as missing only when it is absent from signals.jsonl", () => {
    const dir = mkdtempSync(join(tmpdir(), "evor-missing-"));
    const p = join(dir, "signals.jsonl");
    writeFileSync(
      p,
      [
        JSON.stringify({ signature: "a0-s0", first_seen: "2026-09-01T00:00:00Z" }),
        JSON.stringify({ signature: "a0-s1", first_seen: "2026-09-01T00:00:01Z" }),
      ].join("\n") + "\n",
    );
    expect(missingSignatures(p, ["a0-s0", "a0-s1", "a0-s2"])).toEqual(["a0-s2"]);
    expect(emitTimes(p, (s: string) => s.startsWith("a0"))).toHaveLength(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports zero overlap for windows that do not meet — the vacuity guard", () => {
    const early = ["2026-09-01T00:00:00Z", "2026-09-01T00:00:01Z"];
    const late = ["2026-09-01T00:00:10Z", "2026-09-01T00:00:12Z"];
    expect(overlapWindow(early, late)).toBe(0);
    expect(overlapWindow([], late)).toBe(0);
    expect(
      overlapWindow(["2026-09-01T00:00:00Z", "2026-09-01T00:00:11Z"], late),
    ).toBe(1000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Q-01 LIVE — a real session must resolve .evor/ to the project it runs in
// ─────────────────────────────────────────────────────────────────────────────

describeLive("Q-01 LIVE — hook root resolution in a real session", () => {
  let probe: ReturnType<typeof probeHookRootResolution>;

  beforeAll(() => {
    probe = probeHookRootResolution();
    console.log(
      `[live] q01 model=${probe.model_id} turns=${probe.turns} ` +
        `cost=$${probe.cost_usd.toFixed(4)} wall=${(probe.wall_ms / 1000).toFixed(1)}s ` +
        `hooks=${probe.hooks_fired.join("+")} (${probe.hook_invocations} invocations)`,
    );
  }, LIVE_TIMEOUT);

  it("the rig actually measured the hooks", () => {
    // Not an assertion about the defect — an assertion that the scenario ran.
    // A session in which no evor hook fired is a harness error, not a result.
    expect(
      probe.hook_invocations,
      "no evor hook fired in the live session; the --settings wiring did not register",
    ).toBeGreaterThan(0);
    expect(probe.hooks_fired).toContain("session-start");
  });

  it("ran on a real model", () => {
    expect(probe.model_id, "no model id in the CLI envelope").toBeTruthy();
  });

  it("the hooks announced a run dir at all", () => {
    // Without this the two assertions below would be vacuously satisfiable by a
    // hook that resolved nothing.
    expect(
      probe.resolved_run_dirs.length,
      "the hooks announced no run dir; nothing about resolution can be read from this run",
    ).toBeGreaterThan(0);
  });

  it("Q-01a — the resolved run dir is the PROJECT's, not the plugin's", () => {
    expect(
      probe.resolved_under_decoy,
      `hooks resolved ${probe.resolved_under_decoy} run dir(s) inside CLAUDE_PLUGIN_ROOT: ` +
        JSON.stringify(probe.resolved_run_dirs),
    ).toBe(0);
    expect(probe.resolved_under_project).toBeGreaterThan(0);
  });

  it("Q-01b — the restore block names the project's mission, not the decoy's", () => {
    expect(
      probe.restore_names_decoy,
      `<evor-restore> named the decoy mission ("${DECOY_OBJECTIVE}") — this is the payload ` +
        "the orchestrator was handed for 19 hours",
    ).toBe(false);
    expect(
      probe.restore_names_project,
      `<evor-restore> never named the live mission ("${PROJECT_OBJECTIVE}")`,
    ).toBe(true);
  });

  it("Q-01c — no hook writes into another project's .evor/", () => {
    // The durability half, and the strongest evidence in the probe: it does not
    // depend on anything the model said. session-end.mjs stamps `paused_by` into
    // whatever mission-state it resolved, which is how a binarization session
    // came to modify this repo's own frontier-1ms run.
    expect(
      probe.decoy_changed,
      "the session mutated files inside CLAUDE_PLUGIN_ROOT/.evor",
    ).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// O-02 LIVE — concurrent writers on one signals.jsonl
// ─────────────────────────────────────────────────────────────────────────────

describeLive("O-02 LIVE — concurrent real writers must not lose signals", () => {
  let mcpOnly: Awaited<ReturnType<typeof probeSignalConcurrency>>;
  let mixed: Awaited<ReturnType<typeof probeSignalConcurrency>>;

  beforeAll(async () => {
    mcpOnly = await probeSignalConcurrency({ arm: "mcp-only" });
    mixed = await probeSignalConcurrency({ arm: "mixed" });
    for (const r of [mcpOnly, mixed]) {
      console.log(
        `[live] signals arm=${r.arm} model=${r.model_id} cost=$${r.cost_usd.toFixed(4)} ` +
          `expected=${r.expected_count} missing=${r.missing_count} ` +
          `overlap_ms=${r.overlap_ms ?? "n/a"} verdict=${r.verdict}`,
      );
    }
  }, LIVE_TIMEOUT);

  it("every emitting agent completed", () => {
    for (const r of [mcpOnly, mixed]) {
      const bad = r.agents.filter((a) => a.exit_code !== 0 || a.is_error);
      expect(bad.map((a) => a.agentId), `arm ${r.arm}: agents failed`).toEqual([]);
    }
  });

  it("the agents actually emitted — an arm with no writes proves nothing", () => {
    expect(mcpOnly.agent_emits_landed, "no agent emit landed in the mcp-only arm").toBeGreaterThan(0);
  });

  it("O-02a — N concurrent MCP writers lose nothing", () => {
    // The TS path takes withRunLock (mcp/src/lock.ts). This arm measures whether
    // that lock holds under real, concurrently scheduled agents.
    expect(
      mcpOnly.missing_count,
      `${mcpOnly.missing_count} of ${mcpOnly.expected_count} signals lost: ` +
        JSON.stringify(mcpOnly.missing),
    ).toBe(0);
  });

  it("the mixed arm's writers overlapped in time", () => {
    // The validity gate. Two writers that never wrote simultaneously cannot show
    // anything about a race, and "0 lost" without overlap is scheduling luck —
    // which is the exact reading lane O warns against.
    expect(
      mixed.verdict,
      "the Python and MCP write windows did not meet; this arm measured nothing",
    ).not.toBe("inconclusive-no-overlap");
    expect(mixed.overlap_ms).toBeGreaterThan(0);
  });

  it("O-02b — an MCP writer and the harness's own Python writer lose nothing", () => {
    // `hooks/subagent-stop.mjs` shells out to `python3 -m evor.signals drain`,
    // which reaches SignalBus.emit — a whole-file rewrite that never takes
    // .tree.lock. So the lock the TS side holds does not serialise the two
    // writers of the same file against each other.
    expect(
      mixed.missing_count,
      `${mixed.missing_count} of ${mixed.expected_count} signals lost across ` +
        `${mixed.overlap_ms}ms of overlap: ${JSON.stringify(mixed.missing)}`,
    ).toBe(0);
  });
});
