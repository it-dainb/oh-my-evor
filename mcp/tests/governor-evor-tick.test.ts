/**
 * mcp/tests/governor-evor-tick.test.ts — Phase 3a (ralplan-evor-v2)
 *
 * `evor-tick` is the per-tick context boundary. In Phase 3a it is a PASSTHROUGH:
 * it must be able to spawn exactly what the orchestrator spawns today, because it
 * runs the identical 9-step loop one level down. Anything the governor lets main
 * spawn but denies to evor-tick is a hole the boundary falls through — the tick
 * would fail mid-loop, and it would fail only at runtime.
 *
 * Conversely the boundary must not become a monolith (PM2): leaf work stays
 * delegated, which is why Bash/Write/Edit are withheld in its frontmatter and
 * asserted here at the governor level too.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

const PRE_TOOL_USE = join(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../hooks"),
  "pre-tool-use.mjs",
);

function callGovernor(payload: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "evor-tick-gov-"));
  try {
    const evorRoot = join(dir, ".evor");
    mkdirSync(join(evorRoot, "runs", "m1", "r1"), { recursive: true });
    writeFileSync(join(evorRoot, "active-run.json"), JSON.stringify({ run_id: "r1", mission_id: "m1" }));
    const r = spawnSync(process.execPath, [PRE_TOOL_USE], {
      input: JSON.stringify(payload),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", EVOR_ROOT: evorRoot },
      encoding: "utf8",
      timeout: 10_000,
    });
    const out = (r.stdout ?? "").trim();
    if (!out) return {};
    const parsed = JSON.parse(out.split("\n").pop()!);
    return {
      decision: parsed?.hookSpecificOutput?.permissionDecision,
      reason: parsed?.hookSpecificOutput?.permissionDecisionReason,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const spawnAs = (agent: string | null, subagent: string) => ({
  tool_name: "Agent",
  tool_input: { subagent_type: `oh-my-evor:${subagent}`, prompt: "…" },
  ...(agent ? { agent_type: `oh-my-evor:${agent}` } : {}),
});

/** Everything the orchestrator spawns during a tick. */
const LEADS = ["evor-sage", "evor-mutagen", "evor-probe", "evor-forge", "evor-selector"];

describe("governor — evor-tick can spawn the whole tick roster", () => {
  it("main can spawn evor-tick", () => {
    expect(callGovernor(spawnAs(null, "evor-tick")).decision).not.toBe("deny");
  });

  for (const lead of LEADS) {
    it(`evor-tick can spawn ${lead}`, () => {
      const d = callGovernor(spawnAs("evor-tick", lead));
      expect(d.decision, `boundary cannot spawn ${lead}: ${d.reason ?? ""}`).not.toBe("deny");
    });
  }

  it("evor-tick can spawn evor-acquirer", () => {
    // The acquirer gate is dual-parent (main OR evor-forge). Once the loop moves
    // behind the boundary, the caller is evor-tick — neither of those — so the
    // harden-test acquisition path dies at runtime unless the gate includes it.
    const d = callGovernor(spawnAs("evor-tick", "evor-acquirer"));
    expect(d.decision, `acquirer gate excludes the boundary: ${d.reason ?? ""}`).not.toBe("deny");
  });
});

describe("governor — evor-tick is a boundary, not a worker (PM2)", () => {
  it("cannot author candidate code", () => {
    expect(
      callGovernor({
        tool_name: "Write",
        tool_input: { file_path: "/w/model.py", content: "x" },
        agent_type: "oh-my-evor:evor-tick",
      }).decision,
    ).toBe("deny");
  });

  it("cannot run training", () => {
    expect(
      callGovernor({
        tool_name: "Bash",
        tool_input: { command: "python train.py" },
        agent_type: "oh-my-evor:evor-tick",
      }).decision,
    ).toBe("deny");
  });

  it("still may not spawn a reviewer directly in Phase 3a", () => {
    // 3a is passthrough only — reviewer re-parenting is 3b.2a and must not land
    // early. Forge still owns its own fan-out until that change ships atomically.
    expect(callGovernor(spawnAs("evor-tick", "evor-forge-critic")).decision).toBe("deny");
  });
});
