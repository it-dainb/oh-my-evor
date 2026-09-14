/**
 * mcp/tests/run-start-does-not-train.test.ts
 *
 * `evor_run_start` EVALUATES. It does not train.
 *
 * The call chain, verified against source: the tool calls `jobStart`, which
 * launches `python -m evor run`; that subcommand's own help string is "Run
 * evaluation for a candidate node", and `_cmd_run` executes
 * `worktree/evaluate.py` through EvaluatorAdapter. There is no training step
 * anywhere in it — training is written and run by evor-forge-junior, before
 * the call.
 *
 * Four places said otherwise, including the tool description the model reads at
 * call time ("launch training (async)"). A mission budgeted 150 from-scratch
 * ticks on the belief that the multi-hour cost sat inside `run_start`; it sits
 * inside Forge. The failure mode is quiet in the other direction too: calling it
 * on an untrained worktree raises no error, it scores whatever weights are on
 * disk.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Docs an agent actually reads before or during a run_start call. */
const SURFACES = [
  "mcp/src/tools/compute.ts",
  "skills/evor-mcp/SKILL.md",
  "agents/evor-forge.md",
];

describe("no surface claims evor_run_start trains", () => {
  it.each(SURFACES)("%s", (p) => {
    const src = read(p);
    for (const line of src.split("\n")) {
      if (!line.includes("run_start") && !line.includes("dispatch_batch")) continue;
      // "does NOT train" / "not training" are the corrections themselves.
      if (/NOT train|not train|does not train/i.test(line)) continue;
      expect(
        line,
        `${p} still ties run_start to launching training:\n  ${line.trim()}`,
      ).not.toMatch(/launch(ing)?\s+training|training\s+job|parallel\s+training/i);
    }
  });
});

describe("the harness is the authority and still says evaluation", () => {
  it("`evor run` describes itself as evaluation", () => {
    // If this ever changes to actually train, the doc fixes above become the
    // wrong ones and this test is where you find that out.
    expect(read("harness/evor/__main__.py")).toMatch(
      /add_parser\("run",\s*help="Run evaluation for a candidate node"\)/,
    );
  });

  it("_cmd_run resolves the candidate's evaluate.py, not a training entrypoint", () => {
    expect(read("harness/evor/__main__.py")).toMatch(/worktree\s*\/\s*"evaluate\.py"/);
  });
});

describe("run_start's own description states the precondition", () => {
  const src = read("mcp/src/tools/compute.ts");
  const desc = src.slice(src.indexOf('"evor_run_start",'), src.indexOf('"evor_run_start",') + 900);

  it("says it evaluates", () => {
    expect(desc).toMatch(/EVALUATES/);
  });

  it("says training must already have happened", () => {
    expect(desc).toMatch(/does NOT train/);
    expect(desc).toMatch(/weights must be on disk|already-trained/i);
  });
});
