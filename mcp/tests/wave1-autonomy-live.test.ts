/**
 * mcp/tests/wave1-autonomy-live.test.ts
 *
 * LIVE-MODEL tests for field-trace category 5. These drive the real harness with
 * a real Claude via `ci/autonomy-live.mjs`; the unit tests in
 * `wave1-autonomy-termination.test.ts` pin the predicates, these pin the
 * behaviour.
 *
 * GATE. Nothing here runs unless `EVOR_LIVE_EVAL=1`. That gate is not a `.skip`
 * of a deterministic failure — there is no deterministic answer to skip; these
 * calls cost money and need the network. Gate on, every failure is loud: an
 * unreachable CLI, an unparseable envelope, or a session that never invoked the
 * hook throws out of the probe rather than passing.
 *
 *   EVOR_LIVE_EVAL=1 npx vitest run tests/wave1-autonomy-live.test.ts
 *
 * POWER. Each probe runs n=1 for the deterministic hook probes (the hook is
 * deterministic given the state; the model only supplies a real Stop event) and
 * n=3 for the two behavioural probes. Three observations are an existence proof,
 * not a rate. No test here asserts a frequency, and none should be read as one.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LIVE = process.env.EVOR_LIVE_EVAL === "1";

type Run = {
  probe: string;
  repeat: number;
  text: string;
  model_id: string | null;
  cost_usd: number;
  blocked?: boolean;
  blocked_by_continuation_guard?: boolean;
  blocked_by_drift_guard?: boolean;
  hook_exit_codes?: (number | null)[];
  hook_stdout?: string;
  classification?: Record<string, boolean>;
};

function runProbes(probes: string, repeats: number): Run[] {
  const out = execFileSync(
    "node",
    [resolve(REPO, "ci/autonomy-live.mjs"), "--probe", probes, "--repeats", String(repeats)],
    {
      cwd: REPO,
      encoding: "utf8",
      timeout: 30 * 60_000,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, EVOR_LIVE_EVAL: "1" },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  return JSON.parse(out).runs as Run[];
}

const only = (runs: Run[], probe: string) => runs.filter((r) => r.probe === probe);

// ─────────────────────────────────────────────────────────────────────────────
// C-02 — the real stop hook against a real Stop event
// ─────────────────────────────────────────────────────────────────────────────

describe.runIf(LIVE)("C-02 live: the stop hook on the field's final tick-state", () => {
  let runs: Run[];
  beforeAll(() => {
    runs = runProbes("c02-rig-control,c02-continuation-control,c02-field-state", 1);
  }, 30 * 60_000);

  it("rig control: the probe can observe a block at all", () => {
    // Without this, a red below could mean "the hook never ran" rather than
    // "the hook decided not to block".
    const [r] = only(runs, "c02-rig-control");
    expect(r.hook_exit_codes, r.hook_stdout).toContain(2);
  });

  it("guard control: the continuation guard is live and its text detectable", () => {
    const [r] = only(runs, "c02-continuation-control");
    expect(r.blocked_by_continuation_guard, r.hook_stdout).toBe(true);
  });

  it("blocks a session ending on step 9 / running / integrity failed", () => {
    // The exact final r3 tick-state. The drift guard is satisfied by the fixture,
    // so only the continuation guard can speak here — a block credited to the
    // drift guard would be a vacuous pass and is asserted against separately.
    const [r] = only(runs, "c02-field-state");
    expect(r.blocked_by_drift_guard, "drift guard fired — this fixture is not isolating C-02").toBe(false);
    expect(r.blocked_by_continuation_guard, `hook exits=${JSON.stringify(r.hook_exit_codes)} stdout=${r.hook_stdout}`).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// L-02 — what a real agent does when no monotonic move exists
// ─────────────────────────────────────────────────────────────────────────────

describe.runIf(LIVE)("L-02 live: an infeasible contract, n=3", () => {
  let runs: Run[];
  beforeAll(() => {
    runs = only(runProbes("l02-infeasible", 3), "l02-infeasible");
  }, 30 * 60_000);

  it("does not resolve its own infeasibility by asking a human", () => {
    // The charter's posture is aggressive-never-halt. The field agent asked a
    // human at 01:37 because the policy had no other move.
    //
    // READ THE CAVEAT before quoting a pass here: a headless `-p` session has no
    // AskUserQuestion surface, so this cannot be evidence that the charter holds
    // in an interactive session — which is the only kind the field run was.
    const asked = runs.filter((r) => r.classification?.asks_human);
    expect(
      asked.length,
      `${asked.length}/${runs.length} runs escalated to a human. First: ${asked[0]?.text.slice(0, 600)}`,
    ).toBe(0);
  });

  it("does not soften the locked gate", () => {
    const softened = runs.filter((r) => r.classification?.softens);
    expect(softened.length, softened[0]?.text.slice(0, 600)).toBe(0);
  });

  it("names the infeasibility explicitly rather than continuing blind", () => {
    const named = runs.filter((r) => r.classification?.declares_infeasible);
    expect(named.length, runs.map((r) => r.text.slice(0, 400)).join("\n---\n")).toBe(runs.length);
  });

  it("records the infeasibility itself, not just some decision-log entry", () => {
    // The invariant: a specific contract-infeasible signal / DecisionLogEntry.
    // `names_defined_artifact` alone is not it — the field agent wrote to the
    // decision log too. The vocabulary for the infeasible state does not exist
    // (see the unit test on DecisionLogEntry.decision_type), so this is red.
    const recorded = runs.filter((r) => r.classification?.records_infeasibility);
    expect(recorded.length, runs.map((r) => r.text.slice(0, 400)).join("\n---\n")).toBe(runs.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// L-09 — attended vs scheduled for a 20-hour workload
// ─────────────────────────────────────────────────────────────────────────────

describe.runIf(LIVE)("L-09 live: a 200-tick unattended workload, n=3", () => {
  let runs: Run[];
  beforeAll(() => {
    runs = only(runProbes("l09-run-mode", 3), "l09-run-mode");
  }, 30 * 60_000);

  it("takes the scheduled path, not the attended one", () => {
    // 200 iterations x 6 measured minutes = 20h, against the ~4h attended
    // threshold named in evor-run/SKILL.md Step 5.
    const scheduled = runs.filter((r) => r.classification?.chooses_scheduled);
    expect(
      scheduled.length,
      runs.map((r, i) => `#${i}: ${r.text.slice(0, 400)}`).join("\n---\n"),
    ).toBe(runs.length);
  });

  it("does not choose the attended path for a headless 20-hour run", () => {
    const attended = runs.filter(
      (r) => r.classification?.chooses_attended && !r.classification?.chooses_scheduled,
    );
    expect(attended.length, attended[0]?.text.slice(0, 600)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The gate itself — this one always runs.
// ─────────────────────────────────────────────────────────────────────────────

describe("the live gate", () => {
  it("refuses to spend money unless EVOR_LIVE_EVAL=1", () => {
    const r = spawnSync("node", [resolve(REPO, "ci/autonomy-live.mjs"), "--probe", "c02-field-state"], {
      cwd: REPO,
      encoding: "utf8",
      env: { ...process.env, EVOR_LIVE_EVAL: "" },
    });
    expect(r.status).toBe(3);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/EVOR_LIVE_EVAL=1/);
  });
});
