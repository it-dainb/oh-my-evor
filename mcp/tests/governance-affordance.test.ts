/**
 * §4.4, 4.5, 4.8, 4.9 — the governor stops answering every question with "no".
 *
 * AF5 §0: the allow/deny binary is NOT an upstream constraint. `allow`, `deny`,
 * `ask`, `defer`, `updatedInput`, `additionalContext` and `systemMessage` all
 * exist, and until v1.2.1 the governor used exactly one of them. Lane J measured
 * the result: ~15 harms prevented, ~19 backfires, ~64 false positives, and the
 * flagship rule converting an auditable `Edit` into an obfuscated write.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { tmpdir, homedir } from "os";

const HOOKS = resolve(dirname(fileURLToPath(import.meta.url)), "../../hooks");
const PRE_TOOL_USE = join(HOOKS, "pre-tool-use.mjs");

function call(payload: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "evor-gov-"));
  try {
    const evorRoot = join(dir, ".evor");
    mkdirSync(join(evorRoot, "runs", "m1", "r1"), { recursive: true });
    writeFileSync(join(evorRoot, "active-run.json"), JSON.stringify({ run_id: "r1", mission_id: "m1" }));
    const r = spawnSync(process.execPath, [PRE_TOOL_USE], {
      input: JSON.stringify(payload),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: homedir(), EVOR_ROOT: evorRoot },
      encoding: "utf8",
      timeout: 10_000,
    });
    const out = (r.stdout ?? "").trim();
    let parsed: any = {};
    if (out) { try { parsed = JSON.parse(out.split("\n").pop()!); } catch { /* leave empty */ } }
    const inbox = join(evorRoot, "signals-inbox.jsonl");
    const signals = existsSync(inbox)
      ? readFileSync(inbox, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
    return { hook: parsed?.hookSpecificOutput ?? {}, status: r.status, signals };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("§4.4 — a spawn carrying `name` is fixed, not refused", () => {
  // Spawned BY evor-tick, which legitimately fans out to leads. Spawning a lead
  // from main is denied by the §3b.0 boundary guard whatever `name` says, and
  // that denial must keep winning — see the last case in this block.
  const spawn = {
    tool_name: "Task",
    agent_type: "oh-my-evor:evor-tick",
    tool_input: { subagent_type: "oh-my-evor:evor-forge", name: "forge-t1", prompt: "build it" },
  };

  it("is no longer denied", () => {
    // 19 of 26 spawn denials in the field run were this rule. It collides with
    // SendMessage addressing: wanting to be addressable is reasonable.
    expect(call(spawn).hook.permissionDecision).not.toBe("deny");
  });

  it("strips `name` via updatedInput so the tier is preserved", () => {
    const { hook } = call(spawn);
    expect(hook.updatedInput, "the reason for the rule is still right — `name` makes it an in-process teammate that inherits the session model").toBeDefined();
    expect("name" in (hook.updatedInput ?? {})).toBe(false);
    expect(hook.updatedInput.subagent_type).toBe("oh-my-evor:evor-forge");
    expect(hook.updatedInput.prompt).toBe("build it");
  });

  it("tells the caller what happened instead of failing silently", () => {
    expect(String(call(spawn).hook.systemMessage ?? "")).toMatch(/name/i);
  });

  it("a spawn without `name` is untouched", () => {
    const { hook } = call({
      tool_name: "Task",
      agent_type: "oh-my-evor:evor-tick",
      tool_input: { subagent_type: "oh-my-evor:evor-forge" },
    });
    expect(hook.updatedInput).toBeUndefined();
    expect(hook.permissionDecision).not.toBe("deny");
  });

  it("THE REPAIR MUST NOT BECOME A BYPASS — a denied spawn stays denied", () => {
    // main spawning a lead directly is denied by the boundary guard. An early
    // `updatedInput` + exit would have skipped that check entirely, turning
    // `name` into a way past it. The strip is therefore applied LAST, only once
    // nothing else has objected.
    const { hook } = call({
      tool_name: "Task",
      tool_input: { subagent_type: "oh-my-evor:evor-forge", name: "forge-t1" },
    });
    expect(hook.permissionDecision).toBe("deny");
    expect(hook.updatedInput).toBeUndefined();
  });
});

describe("§4.5 — a reviewer may read what it was spawned to review", () => {
  const read = (agent: string, slot: string) =>
    call({
      tool_name: "mcp__plugin_oh-my-evor_evor__evor_read_artifact",
      agent_type: `oh-my-evor:${agent}`,
      tool_input: { agent: slot, run_id: "r1", tick: 1 },
    }).hook.permissionDecision;

  for (const reviewer of ["evor-forge-critic", "evor-forge-architect", "evor-forge-analyst"]) {
    it(`${reviewer} may read forge-junior's output — the thing under review`, () => {
      // Five of seven blocked reads in the field were then satisfied by `cat`
      // off disk: the content reached context anyway, without passing the
      // artifact tool, so the denial bought a detour and nothing else.
      expect(read(reviewer, "forge-junior")).not.toBe("deny");
    });

    it(`${reviewer} may read the lead's own report`, () => {
      expect(read(reviewer, "forge")).not.toBe("deny");
    });

    it(`${reviewer} may still read upstream stages`, () => {
      expect(read(reviewer, "mutagen")).not.toBe("deny");
    });
  }

  it("reviewers still may not read each other", () => {
    // Three independent reviews that can see each other's verdicts are one
    // anchored review wearing three hats.
    expect(read("evor-forge-critic", "forge-architect")).toBe("deny");
  });

  it("an unrelated role still may not read the forge slot", () => {
    expect(read("evor-probe", "forge-junior")).toBe("deny");
  });
});

describe("§4.8 — a denial is data", () => {
  it("emits a signal with a dedup signature", () => {
    const { signals } = call({
      tool_name: "mcp__plugin_oh-my-evor_evor__evor_read_artifact",
      agent_type: "oh-my-evor:evor-probe",
      tool_input: { agent: "forge-junior", run_id: "r1", tick: 1 },
    });
    // The field run's top rule fired 82 times and produced no data at all.
    expect(signals.length).toBeGreaterThan(0);
    expect(signals[0].kind).toBe("capability-gap");
    expect(signals[0].signature).toMatch(/^governor-denial:/);
  });

  it("the signature excludes the path, so N agents hitting one rule is one signal", () => {
    const sig = (agent: string) =>
      call({
        tool_name: "mcp__plugin_oh-my-evor_evor__evor_read_artifact",
        agent_type: `oh-my-evor:${agent}`,
        tool_input: { agent: "forge-junior", run_id: "r1", tick: 1 },
      }).signals[0]?.signature;
    expect(sig("evor-probe")).toBe(sig("evor-sage"));
  });
});

describe("§4.9 — the two irreversible decisions ask, rather than deny or allow", () => {
  it("a refreeze asks", () => {
    const { hook } = call({
      tool_name: "mcp__plugin_oh-my-evor_evor__evor_freeze_splits",
      tool_input: { run_id: "r1", allow_refreeze: true },
    });
    expect(hook.permissionDecision).toBe("ask");
    expect(String(hook.permissionDecisionReason)).toMatch(/denominator/i);
  });

  it("an ordinary freeze does not ask", () => {
    const { hook } = call({
      tool_name: "mcp__plugin_oh-my-evor_evor__evor_freeze_splits",
      tool_input: { run_id: "r1" },
    });
    expect(hook.permissionDecision).not.toBe("ask");
  });
});
