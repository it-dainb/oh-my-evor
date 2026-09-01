/**
 * mcp/tests/durability-live.test.ts
 *
 * Wave-1 RED — category 4, LIVE lane. Wrapper around `ci/durability-live.mjs`.
 *
 * The sibling suite (`wave1-durability-audit.test.ts`) calls the writers
 * directly. That proves what a writer does when something calls it. The field
 * defect is the other shape: over 19 real hours, materially significant actions
 * happened and nothing called the decision-log writer at all. Reproducing THAT
 * needs a real model driving the real tool surface, followed by a diff of "what
 * changed on disk" against "what the durable record captured".
 *
 * GATING. This suite is opt-in behind EVOR_LIVE_EVAL=1 because it spends real
 * money and needs credentials. That gate is not a `.skip` of a failing
 * assertion: with the gate off nothing runs; with it on every assertion is
 * mandatory and an unreachable model is a hard error, never a pass. The probe
 * itself exits non-zero when it cannot run (no CLI, no credentials, no bundle),
 * and this suite turns that into a failure rather than a skip.
 *
 *   EVOR_LIVE_EVAL=1 npx vitest run tests/durability-live.test.ts
 *
 * Cost and shape of one run, as measured 2026-09-01:
 *   model claude-sonnet-5, n=1 session, 5 turns, 34.6 s, $0.218 billed.
 */

import { execFileSync } from "child_process";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "fs";
import { join, dirname, resolve } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LIVE = process.env.EVOR_LIVE_EVAL === "1";
const TIMEOUT_MS = 900_000;

interface Event {
  event: string;
  control: boolean;
  happened: boolean;
  recorded: boolean;
  evidence: string;
  log_must_mention: string[];
}

interface Report {
  verdict: "RED" | "GREEN" | "harness_error";
  harness_ok: boolean;
  control: Event;
  events: Event[];
  decision_log_added: string;
  observed_models: string[];
  num_turns: number | null;
  cli_cost_usd: number | null;
  wall_ms: number;
  tool_calls: string[];
  tool_errors: { tool: string; detail: string }[];
  containment: { run_state_leak: string[]; concurrent_noise: string[] };
  final_state: Record<string, unknown>;
}

let report: Report;
let sandbox: string;
let outPath: string;

beforeAll(() => {
  if (!LIVE) return;
  sandbox = mkdtempSync(join(tmpdir(), "evor-durability-live-vitest-"));
  outPath = join(sandbox, "report.json");
  // Let the probe's own stdout through: when a live run misbehaves, the tool
  // trace it prints is the only thing that explains why.
  execFileSync("node", [join(REPO, "ci", "durability-live.mjs")], {
    cwd: REPO,
    stdio: "inherit",
    timeout: TIMEOUT_MS,
    env: {
      ...process.env,
      DURABILITY_LIVE_DIR: join(sandbox, "project"),
      DURABILITY_LIVE_OUT: outPath,
    },
  });
  expect(existsSync(outPath), "the probe produced no report").toBe(true);
  report = JSON.parse(readFileSync(outPath, "utf8")) as Report;
}, TIMEOUT_MS);

afterAll(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

describe.runIf(LIVE)("LIVE — a real session's actions reach the durable record", () => {
  it("fixture: the session reached the model and drove the real tool surface", () => {
    // Everything downstream is meaningless if this fails, so it is asserted
    // first and explicitly. A model that was never reached is an error.
    expect(report.observed_models.length, "no model usage reported").toBeGreaterThan(0);
    expect(report.tool_calls.filter((t) => t.startsWith("mcp__evor")).length,
      `the session called no evor MCP tool at all: ${JSON.stringify(report.tool_calls)}`,
    ).toBeGreaterThan(0);
    expect(report.tool_errors, "an evor tool returned an error; the run is not a clean observation")
      .toEqual([]);
  }, TIMEOUT_MS);

  it("positive control: evor_record_node did reach decision-log.md", () => {
    // The one event class that IS wired to the log. If this fails the probe has
    // a broken fixture and says nothing about the classes that are not wired —
    // which is why it is a control and not a finding.
    expect(report.control.happened, `control action did not occur: ${report.control.evidence}`).toBe(true);
    expect(
      report.control.recorded,
      "the control event did not reach the decision log either — this is a harness " +
        `failure, not a finding. log delta was:\n${report.decision_log_added}`,
    ).toBe(true);
    expect(report.harness_ok).toBe(true);
  }, TIMEOUT_MS);

  it("I-01 LIVE: every state change a real session made is in the decision log", () => {
    // The ground truth is the state delta, not the model's narration: an action
    // that did not change an artifact is not counted as having happened, so a
    // model that claims work it did not do cannot manufacture a pass.
    const happened = report.events.filter((e) => e.happened);
    expect(
      happened.length,
      "no graded action changed any artifact — the session did nothing to observe",
    ).toBeGreaterThan(0);

    const unrecorded = happened.filter((e) => !e.recorded);
    expect(
      unrecorded.map((e) => `${e.event} (${e.evidence})`),
      "these state changes were made by a real session and left NO entry in " +
        `decision-log.md. Everything the log gained was:\n${report.decision_log_added}`,
    ).toEqual([]);
  }, TIMEOUT_MS);

  it("P-02 LIVE: nothing wrote run state outside the sandbox", () => {
    // Behavioural rather than by enumeration of known writers: the session has
    // no Bash, Write or Edit, so a run-state file appearing in the repo or in
    // the installed plugin tree can only have come from an evor writer that
    // resolved its state root somewhere it should not have.
    expect(
      report.containment.run_state_leak,
      "run state was written outside the sandbox",
    ).toEqual([]);
  }, TIMEOUT_MS);
});

// With the gate off, this is the whole suite: one assertion that the live lane
// exists and is runnable, so the gate can never silently rot into a no-op.
describe.runIf(!LIVE)("LIVE lane (gated off)", () => {
  it("the live probe is present and syntactically loadable", () => {
    const probe = join(REPO, "ci", "durability-live.mjs");
    expect(existsSync(probe)).toBe(true);
    execFileSync("node", ["--check", probe], { timeout: 60_000 });
  });
});
