/**
 * mcp/tests/tick-yield-and-completeness.test.ts
 *
 * TWO invariants, opposite in direction, which is the point.
 *
 * 1. A YIELD IS NOT A RETURN. evor-tick spans hours and ~10 async agent
 *    boundaries with no blocking primitive (TaskOutput is unregistered for a
 *    sub-agent), so its only way to wait is to end its turn and be re-activated.
 *    The platform does that reliably: in the field `evor-sage` yielded SEVEN
 *    times with five live juniors and resumed every time. `evor-tick` yielded
 *    eight times and died on the eighth — and the only difference was that the
 *    SubagentStop return contract matched evor-tick and had no word for waiting.
 *    So a yielding tick had to claim a terminal outcome, picked `failed` because
 *    it is the only one that carries an explanation, and emitted
 *    `{"outcome":"failed","error":"...No blocking primitive available..."}`
 *    three times. Main read a dead tick and re-spawned it, losing its context.
 *
 * 2. A TERMINAL RETURN MAY NOT OWE A CANDIDATE. Every proposal the selector
 *    SELECTED owes a trained and evaluated node. The field selector selected
 *    h001 and h003, only h001 was forged, and h003 went into a `carry_forward`
 *    key defined nowhere and read by nothing.
 *
 * The guards pull in opposite directions on purpose: loose on a yield, strict on
 * a finish. A guard that fires on a yield forbids the only way a tick can wait.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const HOOKS = resolve(dirname(fileURLToPath(import.meta.url)), "../../hooks");
const FINISHED = JSON.stringify({ type: "assistant", message: { role: "assistant", stop_reason: "end_turn" } });
const LIVE = JSON.stringify({ type: "user", message: { role: "user" } });

interface Fixture {
  /** reviews as [proposal_id, selected] */
  selected?: Array<[string, boolean]>;
  /** nodes as [hypothesis_id, nodeId, withEval, withFitness, withTelemetry] */
  nodes?: Array<[string, string, boolean, boolean, boolean]>;
  tickState?: Record<string, unknown> | null;
  subagents?: string[];
}

function run(lastMessage: string, fx: Fixture = {}) {
  const root = mkdtempSync(join(tmpdir(), "evor-tickguard-"));
  const runDir = join(root, ".evor", "runs", "m1", "r1");
  mkdirSync(join(runDir, "ticks", "1", "selector"), { recursive: true });
  mkdirSync(join(runDir, "evaluations"), { recursive: true });
  writeFileSync(join(root, ".evor", "active-run.json"), JSON.stringify({ run_id: "r1", mission_id: "m1" }));
  writeFileSync(join(runDir, "mission-state.json"), JSON.stringify({ status: "running" }));
  writeFileSync(join(runDir, "run-state.json"), JSON.stringify({ tick_count: 1, pending_node_ids: [] }));
  writeFileSync(
    join(runDir, "tick-state.json"),
    JSON.stringify(fx.tickState ?? { tick: 1, current_step: 9, step_status: "done" }),
  );
  writeFileSync(
    join(runDir, "ticks", "1", "selector", "verdict.json"),
    JSON.stringify({
      reviews: (fx.selected ?? []).map(([id, sel]) => ({ proposal_id: id, selected: sel })),
      winner: (fx.selected ?? []).find(([, s]) => s)?.[0] ?? null,
    }),
  );
  const nodes: Record<string, unknown> = {};
  for (const [hyp, id, withEval, withFit, withTel] of fx.nodes ?? []) {
    nodes[id] = { id, name: `n-${id}`, hypothesis_id: hyp, ...(withFit ? { fitness_value: 0.5 } : {}) };
    if (withEval) writeFileSync(join(runDir, "evaluations", `${id}.json`), "{}");
    if (withTel) {
      mkdirSync(join(runDir, "nodes", id), { recursive: true });
      writeFileSync(join(runDir, "nodes", id, "telemetry.jsonl"), '{"step":1}\n');
    }
  }
  writeFileSync(join(runDir, "tree.json"), JSON.stringify({ nodes }));

  const transcript = join(root, "session.jsonl");
  writeFileSync(transcript, "");
  const subDir = join(root, "session", "subagents");
  mkdirSync(subDir, { recursive: true });
  (fx.subagents ?? []).forEach((tail, i) => {
    const f = join(subDir, `agent-a${i}.jsonl`);
    writeFileSync(f, tail + "\n");
    if (tail === FINISHED) {
      const old = new Date(Date.now() - 10 * 60_000);
      utimesSync(f, old, old);
    }
  });

  const r = spawnSync("node", [join(HOOKS, "subagent-stop.mjs")], {
    input: JSON.stringify({
      hook_event_name: "SubagentStop",
      agent_type: "oh-my-evor:evor-tick",
      agent_id: `a-${Math.abs(lastMessage.length)}-${root.slice(-6)}`,
      stop_hook_active: false,
      session_id: "s1",
      transcript_path: transcript,
      last_assistant_message: lastMessage,
    }),
    encoding: "utf8",
    env: {
      ...process.env,
      EVOR_ROOT: join(root, ".evor"),
      CLAUDE_PLUGIN_ROOT: resolve(HOOKS, ".."),
      EVOR_STATE_DIR: root,
    },
  });
  rmSync(root, { recursive: true, force: true });
  const out = (r.stdout ?? "").trim();
  let reason = "";
  try {
    const p = JSON.parse(out);
    if (p?.decision === "block") reason = String(p.reason ?? "");
  } catch { /* not a block */ }
  return { code: r.status, blocked: reason !== "", reason, stdout: out };
}

describe("a yield is not a return", () => {
  const MID = { tick: 1, current_step: 5, step_status: "running" };

  it("lets a yielding tick end its turn with ordinary prose", () => {
    // The sage behaviour, restored: nothing coerces a shape, so the CLI
    // re-activates it instead of main receiving a value.
    const r = run("Forge is still training h001. Waiting.", {
      tickState: { ...MID, blocked: { on: "artifact:forge@tick1" } },
    });
    expect(r.blocked, r.reason).toBe(false);
    expect(r.code).toBe(0);
  });

  it("lets a yielding tick end its turn with live children and no recorded wait", () => {
    const r = run("still going", { tickState: MID, subagents: [LIVE] });
    expect(r.blocked, r.reason).toBe(false);
  });

  it("accepts outcome:'yielding' as a thing a tick may say", () => {
    const r = run(JSON.stringify({ tick: 1, outcome: "yielding", waiting_on: "artifact:forge@tick1" }), {
      tickState: MID, subagents: [LIVE],
    });
    expect(r.blocked, r.reason).toBe(false);
  });

  it("still enforces the return shape when the tick is NOT yielding", () => {
    // Chain quiet, no recorded wait: this really is a return, so it has a contract.
    const r = run("here is a long prose essay about the tick instead of JSON", {
      tickState: MID, subagents: [FINISHED],
    });
    expect(r.blocked).toBe(true);
    expect(r.reason).toMatch(/violates the tick contract/);
    // And the block must teach the vocabulary whose absence caused the failure.
    expect(r.reason).toMatch(/yielding/);
  });
});

describe("a terminal return may not owe a selected candidate", () => {
  const DONE = { tick: 1, current_step: 9, step_status: "done" };
  const scored = JSON.stringify({ tick: 1, outcome: "scored", node_id: "x", score: 0.5 });

  it("blocks 'scored' when a selected proposal never got a node", () => {
    // Verbatim from the field: h001 and h003 selected, only h001 forged.
    const r = run(scored, {
      tickState: DONE,
      subagents: [FINISHED],
      selected: [["h001", true], ["h003", true]],
      nodes: [["h001", "n1", true, true, true]],
    });
    expect(r.blocked, r.stdout).toBe(true);
    expect(r.reason).toMatch(/h003/);
    expect(r.reason).toMatch(/missing node/);
    expect(r.reason).toMatch(/carry_forward/);
  });

  it("blocks when a node exists but was never evaluated", () => {
    // Forge records the node before training finishes, so a node alone is not a result.
    const r = run(scored, {
      tickState: DONE, subagents: [FINISHED],
      selected: [["h001", true]],
      nodes: [["h001", "n1", false, false, true]],
    });
    expect(r.blocked).toBe(true);
    expect(r.reason).toMatch(/integrity_verdict|fitness/);
  });

  it("allows 'scored' once every selected proposal is discharged", () => {
    const r = run(scored, {
      tickState: DONE, subagents: [FINISHED],
      selected: [["h001", true], ["h003", true]],
      nodes: [["h001", "n1", true, true, true], ["h003", "n2", true, true, true]],
    });
    expect(r.blocked, r.reason).toBe(false);
  });

  it("does not fire mid-tick — there the answer is legitimately 'everything'", () => {
    // Blocking here would forbid the only way a tick can wait through training.
    const r = run(JSON.stringify({ tick: 1, outcome: "yielding", waiting_on: "artifact:forge@tick1" }), {
      tickState: { tick: 1, current_step: 5, step_status: "running", blocked: { on: "artifact:forge@tick1" } },
      selected: [["h001", true], ["h003", true]],
      nodes: [],
    });
    expect(r.blocked, r.reason).toBe(false);
  });

  it("does not block a 'failed' return — a tick that cannot finish is not hiding debt", () => {
    const r = run(JSON.stringify({ tick: 1, outcome: "failed", error: "GPU unavailable" }), {
      tickState: DONE, subagents: [FINISHED],
      selected: [["h001", true]],
      nodes: [],
    });
    expect(r.blocked, r.reason).toBe(false);
  });
});
