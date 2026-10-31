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
    // additionalContext is the PreToolUse field the model reads; a systemMessage
    // nested in hookSpecificOutput is dropped by the CLI.
    expect(String(call(spawn).hook.additionalContext ?? "")).toMatch(/name/i);
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

describe("§4.7 — read-only exploration is not a reason to spawn an agent", () => {
  const tick = (command: string) =>
    call({ tool_name: "Bash", agent_type: "oh-my-evor:evor-tick", tool_input: { command } });

  for (const cmd of ["find . -name '*.json'", "ls -la nodes/", "wc -l tree.json", "grep -rn TODO src/"]) {
    it(`allows evor-tick: ${cmd}`, () => {
      // Denied Bash, evor-tick spawned a whole general-purpose agent to run
      // `find` — a denial producing a more expensive version of the same act,
      // and an ungoverned generic agent in the tree as a side effect.
      expect(tick(cmd).hook.permissionDecision).not.toBe("deny");
    });
  }

  it("does not become a write channel", () => {
    // The allowlist is anchored and excludes redirection, `&&`, pipes and
    // substitution, so it cannot be used to smuggle a write past §0.2.
    for (const cmd of ["cat x > /etc/passwd", "ls && rm -rf nodes", "echo hi | tee out.json"]) {
      const d = tick(cmd).hook.permissionDecision;
      expect(d === "deny" || d === undefined).toBe(true);
    }
  });
});

describe("§4.3 — a generic spawn inherits its spawner's constraints", () => {
  it("grafts the constraints onto the child's prompt", () => {
    // One agent reported "BLOCKED on authoring … I did not route around it", and
    // 51 seconds later the orchestrator re-issued the identical edit as
    // `subagent_type: "claude"` and it succeeded — four more times after that.
    const { hook } = call({
      tool_name: "Task",
      agent_type: "oh-my-evor:evor-mutagen",
      tool_input: { subagent_type: "general-purpose", prompt: "go find the frontier" },
    });
    expect(hook.updatedInput).toBeDefined();
    expect(hook.updatedInput.prompt).toMatch(/inherit its constraints/i);
    expect(hook.updatedInput.prompt).toMatch(/go find the frontier/);
  });

  it("the inherited text is specific to the spawner", () => {
    const asMutagen = call({
      tool_name: "Task",
      agent_type: "oh-my-evor:evor-mutagen",
      tool_input: { subagent_type: "claude", prompt: "x" },
    }).hook.updatedInput.prompt;
    // Mutagen never researches; a child of Mutagen must not either.
    expect(asMutagen).toMatch(/may not gather evidence/i);
  });

  it("an evor-to-evor spawn is not rewritten — those already have rules", () => {
    const { hook } = call({
      tool_name: "Task",
      agent_type: "oh-my-evor:evor-tick",
      tool_input: { subagent_type: "oh-my-evor:evor-sage", prompt: "x" },
    });
    expect(hook.updatedInput).toBeUndefined();
  });

  it("a top-level generic spawn is untouched — there is no parent to inherit from", () => {
    const { hook } = call({
      tool_name: "Task",
      tool_input: { subagent_type: "general-purpose", prompt: "x" },
    });
    expect(hook.updatedInput).toBeUndefined();
  });
});

describe("research edge — Sage reads the queries Mutagen wrote", () => {
  // Mutagen runs before Sage within a tick, and its artifact carries the
  // investigation_queries Sage answers. The guard's PIPELINE put sage upstream of
  // mutagen, so Sage was denied that artifact and exited with nothing to research.
  const read = (agent_type: string, agent: string) => call({
    hook_event_name: "PreToolUse", agent_type,
    tool_name: "mcp__plugin_oh-my-evor_evor__evor_read_artifact",
    tool_input: { run_id: "r1", tick: 3, agent },
  }).hook;

  it("lets evor-sage read mutagen's artifact", () => {
    expect(read("oh-my-evor:evor-sage", "mutagen").permissionDecision).not.toBe("deny");
  });

  it("still keeps evor-sage out of a downstream slot", () => {
    expect(read("oh-my-evor:evor-sage", "forge").permissionDecision).toBe("deny");
  });
});

describe("a reviewer's scratchpad is not candidate code", () => {
  // The forge-critic wrote a check script to its session scratchpad and was refused
  // "author-code" with the target <worktree>/EOF — the heredoc delimiter read as a
  // path (binarization mission, tick 4).
  const bash = (command: string) => call({
    hook_event_name: "PreToolUse", agent_type: "oh-my-evor:evor-forge-critic",
    tool_name: "Bash", tool_input: { command },
  }).hook;

  it("lets a critic write a script to its scratchpad", () => {
    const d = bash("cd /w/.evor/worktrees/t4 && cat > /tmp/claude-1006/-p/s1/scratchpad/check.py <<'EOF'\nprint(1)\nEOF");
    expect(d.permissionDecision).not.toBe("deny");
  });

  it("still refuses a critic writing code into a worktree", () => {
    const d = bash("cat > /w/.evor/worktrees/t4/model/x.py <<'EOF'\nprint(1)\nEOF");
    expect(d.permissionDecision).toBe("deny");
  });
});

describe("a heredoc body is interpreter input, not shell", () => {
  // `len(json.dumps(v))>200` in a python heredoc read as a shell redirect, so an
  // architect's read-only JSON comparison "wrote" a node's results.json
  // (binarization mission, tick 4).
  const bash = (command: string) => call({
    hook_event_name: "PreToolUse", agent_type: "oh-my-evor:evor-forge-architect",
    tool_name: "Bash", tool_input: { command },
  }).hook;

  it("allows a read-only python heredoc that compares with >", () => {
    const d = bash('R=/w/.evor/runs/m/r/nodes/n; python3 - <<EOF\nimport json\na=json.load(open("$R/results.json"))\nprint(len(json.dumps(a))>200)\nEOF');
    expect(d.permissionDecision).not.toBe("deny");
  });

  it("still refuses a python heredoc that writes run state", () => {
    const d = bash('cd /w/.evor/runs && python3 - <<EOF\nopen("mission-state.json","w").write("x")\nEOF');
    expect(d.permissionDecision).toBe("deny");
  });
});

describe("analysis edge and python -c", () => {
  const read = (agent_type: string, agent: string) => call({
    hook_event_name: "PreToolUse", agent_type,
    tool_name: "mcp__plugin_oh-my-evor_evor__evor_read_artifact",
    tool_input: { run_id: "r1", tick: 4, agent },
  }).hook;

  it("lets evor-probe read the forge reviewers' reports", () => {
    for (const slot of ["forge-critic", "forge-architect", "forge-analyst"]) {
      expect(read("oh-my-evor:evor-probe", slot).permissionDecision).not.toBe("deny");
    }
  });

  it("still keeps reviewers out of each other's reports", () => {
    expect(read("oh-my-evor:evor-forge-analyst", "forge-critic").permissionDecision).toBe("deny");
  });

  it("does not read a python -c string literal containing -> as a redirect", () => {
    const d = call({
      hook_event_name: "PreToolUse", agent_type: "oh-my-evor:evor-probe", tool_name: "Bash",
      tool_input: { command: `cat /w/.evor/runs/m/r/nodes/n/telemetry.jsonl | python3 -I -c "import sys; print('first->last %', 1)"` },
    }).hook;
    expect(d.permissionDecision).not.toBe("deny");
  });
});

describe("the zero-poll job wait is allowed", () => {
  it("lets Forge wait on a job with a background until-loop over status.json", () => {
    const d = call({
      hook_event_name: "PreToolUse", agent_type: "oh-my-evor:evor-forge", tool_name: "Bash",
      tool_input: { command: `until ! grep -q '"state": "running"' /w/.evor/runs/m/r/jobs/j1/status.json; do sleep 30; done`, run_in_background: true },
    }).hook;
    expect(d.permissionDecision).not.toBe("deny");
  });
});

describe("forge-junior can launch its trainer", () => {
  // The launch redirects the trainer's log (`> train_out.log`) and later reads the
  // telemetry file with `head -1 $T`. Read as one unit, the redirect made $T —
  // under .evor/runs — a "write", and the launch was refused (tick 4).
  it("allows a trainer launch that names the telemetry path in an env assignment and a read", () => {
    const command = [
      "W=/w/.evor/worktrees/t4",
      "T=/w/.evor/runs/m/r/nodes/n/telemetry.jsonl",
      "cd $W && EVOR_TELEMETRY_PATH=$T setsid nohup python train/trainer.py > $W/train_out.log 2>&1 &",
      "head -1 $T",
    ].join("\n");
    const d = call({ hook_event_name: "PreToolUse", agent_type: "oh-my-evor:evor-forge-junior", tool_name: "Bash", tool_input: { command } }).hook;
    expect(d.permissionDecision).not.toBe("deny");
  });

  it("still refuses a junior writing run state through a variable", () => {
    const d = call({ hook_event_name: "PreToolUse", agent_type: "oh-my-evor:evor-forge-junior", tool_name: "Bash",
      tool_input: { command: "T=/w/.evor/runs/m/r/run-state.json; echo {} > $T" } }).hook;
    expect(d.permissionDecision).toBe("deny");
  });
});

describe("evor.watch runs as a background task", () => {
  const bash = (agent_type: string, command: string) => call({
    hook_event_name: "PreToolUse", agent_type, tool_name: "Bash", tool_input: { command, run_in_background: true },
  }).hook;

  it("lets forge-junior run python -m evor.watch", () => {
    const d = bash("oh-my-evor:evor-forge-junior", 'python -m evor.watch --telemetry "$EVOR_TELEMETRY_PATH" --pid 4242 --val-key val_min_S');
    expect(d.permissionDecision).not.toBe("deny");
  });

  it("still blocks other python -m evor invocations", () => {
    const d = bash("oh-my-evor:evor-forge-junior", "python -m evor run --node-id n1");
    expect(d.permissionDecision).toBe("deny");
  });
});
