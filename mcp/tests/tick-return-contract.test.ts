/**
 * mcp/tests/tick-return-contract.test.ts
 *
 * evor-tick's return value IS the product — it is the only thing that survives
 * the context boundary into the orchestrator. Prose in agents/evor-tick.md asks
 * for "a compact status"; prose is not enforcement (five separate defects this
 * session read as enforced and were structurally inert).
 *
 * Mechanism, established by probe against CLI 2.1.220:
 *   PostToolUse.updatedToolOutput  → documented, INERT. Cannot rewrite a return.
 *   SubagentStop decision:"block"  → WORKS. The subagent resumes and re-emits.
 * So the contract is enforced by rejection-and-retry, not by rewriting.
 *
 * The payload carries `last_assistant_message` directly (probed), so validation
 * needs no transcript parsing.
 *
 * Retry MUST be capped: an agent that cannot produce conforming output would
 * otherwise be blocked forever, burning the mission's budget on one tick.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import { readFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const HOOKS = resolve(dirname(fileURLToPath(import.meta.url)), "../../hooks");
const HOOK = join(HOOKS, "subagent-stop.mjs");

type Payload = Record<string, unknown>;

/** Run the hook with a SubagentStop payload; returns its parsed stdout JSON (or null). */
function run(payload: Payload, env: Record<string, string> = {}) {
  const r = spawnSync("node", [HOOK], {
    input: JSON.stringify({
      hook_event_name: "SubagentStop",
      agent_type: "oh-my-evor:evor-tick",
      agent_id: "agent-test",
      stop_hook_active: false,
      ...payload,
    }),
    encoding: "utf8",
    env: { ...process.env, EVOR_STATE_DIR: stateDir, ...env },
  });
  const out = (r.stdout ?? "").trim();
  let json: any = null;
  try {
    json = out.startsWith("{") ? JSON.parse(out) : null;
  } catch {
    /* non-JSON stdout is the advisory-warning path, not a decision */
  }
  return { code: r.status, stdout: out, json };
}

let stateDir = mkdtempSync(join(tmpdir(), "evor-tick-contract-"));
/** Fresh retry-counter scope so cases do not inherit each other's attempts. */
function freshScope() {
  rmSync(stateDir, { recursive: true, force: true });
  stateDir = mkdtempSync(join(tmpdir(), "evor-tick-contract-"));
}

const VALID = JSON.stringify({
  tick: 7,
  outcome: "scored",
  node_id: "n-0042",
  score: 0.813,
  pointers: [{ run_id: "run-live-01", tick: 7, agent: "forge" }],
});

describe("evor-tick return contract — conforming returns pass through", () => {
  it("a valid compact status is allowed to stop", () => {
    freshScope();
    const { json, code } = run({ last_assistant_message: VALID });
    expect(code).toBe(0);
    expect(json?.decision).not.toBe("block");
  });

  it("accepts the same object inside a ```json fence", () => {
    freshScope();
    const { json } = run({ last_assistant_message: "```json\n" + VALID + "\n```" });
    expect(json?.decision).not.toBe("block");
  });

  it("accepts a failed tick — failure is a normal outcome, not a violation", () => {
    freshScope();
    const msg = JSON.stringify({
      tick: 7,
      outcome: "failed",
      error: "eval harness exited 137",
      pointers: [{ run_id: "r", tick: 7, agent: "forge" }],
    });
    expect(run({ last_assistant_message: msg }).json?.decision).not.toBe("block");
  });
});

describe("evor-tick return contract — violations are blocked", () => {
  const bad: Array<[string, string]> = [
    ["prose instead of JSON", "Tick 7 completed successfully and the winner scored 0.81."],
    ["missing tick", JSON.stringify({ outcome: "scored", pointers: [] })],
    ["missing outcome", JSON.stringify({ tick: 7, pointers: [] })],
    ["unknown outcome", JSON.stringify({ tick: 7, outcome: "great", pointers: [] })],
    ["tick not a number", JSON.stringify({ tick: "seven", outcome: "scored", pointers: [] })],
    ["pointers not an array", JSON.stringify({ tick: 7, outcome: "scored", pointers: "forge" })],
  ];
  for (const [label, msg] of bad) {
    it(`blocks: ${label}`, () => {
      freshScope();
      const { json } = run({ last_assistant_message: msg });
      expect(json?.decision, label).toBe("block");
      expect(String(json?.reason), "reason must state the exact required shape").toMatch(/outcome/);
    });
  }

  it("blocks an oversized return — the whole point is what the orchestrator carries", () => {
    freshScope();
    const msg = JSON.stringify({
      tick: 7,
      outcome: "scored",
      node_id: "n-1",
      pointers: [],
      notes: "x".repeat(4000), // a narrative pasted in place of a pointer
    });
    const { json } = run({ last_assistant_message: msg });
    expect(json?.decision).toBe("block");
    expect(String(json?.reason)).toMatch(/\d+/); // names the budget it exceeded
  });
});

describe("evor-tick return contract — retry is bounded", () => {
  it("stops blocking after the cap and lets the tick through", () => {
    freshScope();
    const junk = { last_assistant_message: "still not JSON" };
    const decisions = [run(junk).json?.decision, run(junk).json?.decision, run(junk).json?.decision];
    expect(decisions.slice(0, 2), "first two attempts must be corrected").toEqual(["block", "block"]);
    expect(decisions[2], "an agent that cannot conform must not loop forever").not.toBe("block");
  });

  it("honours stop_hook_active as an independent loop guard", () => {
    freshScope();
    const { json } = run({ last_assistant_message: "not JSON", stop_hook_active: true });
    expect(json?.decision).not.toBe("block");
  });
});

describe("every other spawn is size-bounded, but not schema-bounded (S5)", () => {
  // The tick contract governs one doorway. A single generic Explore spawn returned
  // 9,306 chars into the orchestrator — 4x all four evor-tick returns combined —
  // so bounding only evor-tick does not bound the orchestrator's context.
  const long = "x".repeat(2500);

  it("prose is fine for other agents — no schema is imposed", () => {
    freshScope();
    for (const t of ["oh-my-evor:evor-sage", "oh-my-evor:evor-forge", "general-purpose", "Explore"]) {
      const { json } = run({ agent_type: t, last_assistant_message: "free-form prose is fine here" });
      expect(json?.decision, t).not.toBe("block");
    }
  });

  it("but an oversized return is blocked, whatever the agent type", () => {
    for (const t of ["oh-my-evor:evor-sage", "general-purpose", "Explore"]) {
      freshScope();
      const { json } = run({ agent_type: t, last_assistant_message: long });
      expect(json?.decision, t).toBe("block");
      expect(String(json?.reason)).toMatch(/pointer/i);
    }
  });

  it("the generic bound is looser than the tick bound", () => {
    freshScope();
    // 1,800 chars: over evor-tick's 1500 budget, under the generic 2000.
    const mid = "y".repeat(1800);
    expect(run({ agent_type: "Explore", last_assistant_message: mid }).json?.decision).not.toBe("block");
    freshScope();
    expect(run({ agent_type: "oh-my-evor:evor-tick", last_assistant_message: mid }).json?.decision).toBe("block");
  });

  it("gives up after the cap here too — an agent that cannot shrink must not loop", () => {
    freshScope();
    const d = [1, 2, 3].map(() => run({ agent_type: "Explore", last_assistant_message: long }).json?.decision);
    expect(d.slice(0, 2)).toEqual(["block", "block"]);
    expect(d[2]).not.toBe("block");
  });

  it("respects the kill switches", () => {
    freshScope();
    for (const env of [{ DISABLE_EVOR: "1" }, { EVOR_SKIP_HOOKS: "subagent-stop" }]) {
      expect(run({ last_assistant_message: "not JSON" }, env).json?.decision).not.toBe("block");
    }
  });
});

describe("the contract is reachable at runtime", () => {
  // The defect class this session kept producing: a rule whose unit tests pass
  // while hooks.json never routes the event to it.
  const config = JSON.parse(readFileSync(join(HOOKS, "hooks.json"), "utf8"));
  const declared = config.hooks.SubagentStop[0].matcher;
  // "*" is the wildcard, not a regex — `new RegExp("*")` throws "Nothing to repeat".
  const matcher = { test: (t: string) => declared === "*" || new RegExp(declared).test(t) };

  it("hooks.json routes evor-tick to subagent-stop.mjs", () => {
    expect(matcher.test("oh-my-evor:evor-tick")).toBe(true);
  });

  it("and routes generic spawns too — S5 is worthless if they are not matched", () => {
    // The TaskOutput deny earlier this session had passing unit tests and was
    // unreachable because the matcher excluded it. Same failure shape, so: pin it.
    for (const t of ["general-purpose", "Explore", "oh-my-evor:evor-forge-junior"]) {
      expect(matcher.test(t), `${t} is not routed to subagent-stop.mjs`).toBe(true);
    }
  });

  it("agents/evor-tick.md documents the same required keys the hook enforces", () => {
    const md = readFileSync(join(HOOKS, "../agents/evor-tick.md"), "utf8");
    for (const key of ["tick", "outcome", "pointers"]) {
      expect(md, `agent file must state the '${key}' field it will be blocked for omitting`).toMatch(
        new RegExp(`\\b${key}\\b`),
      );
    }
    for (const outcome of ["scored", "failed"]) {
      expect(md).toMatch(new RegExp(`"${outcome}"`));
    }
  });
});
