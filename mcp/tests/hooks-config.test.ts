/**
 * mcp/tests/hooks-config.test.ts — Phase 0.2 (RALPLAN-DR REV 5)
 *
 * `hooks/hooks.json` had `"if": "Write|Edit|Bash|Task|Agent|mcp__..."` on the
 * PreToolUse entry. `if` takes permission-rule syntax (`Bash(git *)`), not a bare
 * regex alternation, so the expression was never a valid filter. Tool-name
 * narrowing belongs in `matcher`, which is the documented mechanism and is
 * already a regex.
 *
 * These tests pin the config surface itself — the failure mode here is silent
 * (an invalid `if` does not raise; the hook simply behaves differently than the
 * file appears to say), which is exactly what principle P2 exists to catch.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const HOOKS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../hooks");
const config = JSON.parse(readFileSync(join(HOOKS_DIR, "hooks.json"), "utf8"));

/** Events where an `if` expression is evaluated at all. */
const TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure", "PostToolBatch"]);

type Entry = { matcher?: string; if?: string; hooks?: Array<{ command?: string }> };
const entriesByEvent: Array<[string, Entry]> = Object.entries(
  config.hooks as Record<string, Entry[]>,
).flatMap(([event, list]) => list.map((e) => [event, e] as [string, Entry]));

describe("hooks.json — `if` expressions", () => {
  it("uses permission-rule syntax, never a bare alternation", () => {
    const offenders = entriesByEvent
      .filter(([, e]) => typeof e.if === "string")
      .filter(([, e]) => !/^\w+\([^)]*\)(\s*\|\|\s*\w+\([^)]*\))*$/.test(e.if!))
      .map(([event, e]) => `${event}: ${e.if}`);
    expect(offenders, "an `if` that is not permission-rule syntax is silently ignored").toEqual([]);
  });

  it("only appears on tool events", () => {
    const offenders = entriesByEvent
      .filter(([event, e]) => typeof e.if === "string" && !TOOL_EVENTS.has(event))
      .map(([event]) => event);
    expect(offenders).toEqual([]);
  });
});

describe("hooks.json — matchers", () => {
  it("narrows PreToolUse to the tools the governor actually inspects", () => {
    const pre = (config.hooks.PreToolUse as Entry[])[0];
    // The governor branches on Write/Edit/Bash (delegation + protected paths),
    // Task/Agent (spawn parenting) and the evor MCP tools (run_id injection,
    // artifact identity). Firing on anything else is pure per-call overhead.
    for (const tool of ["Write", "Edit", "Bash", "Task", "Agent", "mcp__plugin_oh-my-evor_evor__write_artifact"]) {
      expect(new RegExp(pre.matcher!).test(tool), `matcher must select ${tool}`).toBe(true);
    }
    for (const tool of ["Read", "Glob", "WebFetch", "TodoWrite"]) {
      expect(new RegExp(pre.matcher!).test(tool), `matcher must not select ${tool}`).toBe(false);
    }
  });

  it("has a compilable regex matcher on every entry", () => {
    for (const [event, e] of entriesByEvent) {
      if (e.matcher === undefined || e.matcher === "*") continue;
      expect(() => new RegExp(e.matcher!), `${event}: ${e.matcher}`).not.toThrow();
    }
  });
});

describe("hooks.json — referenced scripts", () => {
  it("every command points at a script that exists", () => {
    const missing: string[] = [];
    for (const [event, e] of entriesByEvent) {
      for (const h of e.hooks ?? []) {
        const m = (h.command ?? "").match(/hooks\/([\w.-]+\.mjs)/);
        if (!m) continue;
        if (!existsSync(join(HOOKS_DIR, m[1]))) missing.push(`${event} → ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("hooks.json matcher covers every tool the governor can deny", () => {
  // THE GAP THIS CLOSES. Every governor test spawns pre-tool-use.mjs directly
  // with a synthetic payload, which bypasses hooks.json's matcher entirely. Those
  // tests prove the rule's LOGIC; they cannot prove the hook is ever invoked for
  // that tool.
  //
  // That gap shipped a live defect: §3b.0 added a TaskOutput deny, its unit tests
  // passed, and the rule was unreachable — the Stage 0.2 matcher narrowing
  // (^(Write|Edit|Bash|Task|Agent|mcp__...)$) excludes TaskOutput, so the governor
  // never ran for it. A 3-tick measurement was spent before the transcript showed
  // 6 TaskOutput calls sailing through.
  //
  // Fifth instance this session of "reads as enforced, structurally inert" —
  // after EVOR_ACTIVE_RUN_ID, the unregistered agent, the spoofing guard's name
  // mismatch, and best_score never being written.
  const governor = readFileSync(join(HOOKS_DIR, "pre-tool-use.mjs"), "utf8");
  const matcher = new RegExp((config.hooks.PreToolUse as Entry[])[0].matcher!);

  /** Bare tool names the governor compares against, harvested from its source. */
  const referenced = [
    ...governor.matchAll(/toolName[A-Za-z]*\s*===\s*'([A-Za-z][\w-]*)'/g),
  ].map((m) => m[1]);

  it("harvests tool names from the governor source", () => {
    expect(referenced.length, "no tool-name comparisons found — the harvest regex is stale").toBeGreaterThan(0);
  });

  for (const tool of [...new Set(referenced)]) {
    it(`matcher invokes the governor for ${tool}`, () => {
      expect(
        matcher.test(tool),
        `pre-tool-use.mjs has a rule for ${tool}, but hooks.json's matcher never routes it there — ` +
          `the rule is unreachable no matter what its unit test says`,
      ).toBe(true);
    });
  }
});
