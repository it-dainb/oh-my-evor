/**
 * Every hook must actually LOAD.
 *
 * Written after routing eleven hooks through the shared root resolver (1.3) and
 * shipping ten of them without the import. `node --check` passed on all ten —
 * it validates syntax, not name resolution — so nothing caught it until a test
 * that ran a hook failed with an exit code instead of an assertion.
 *
 * That is a whole class of defect this repo is exposed to: a hook that throws at
 * module load emits nothing, exits non-zero, and the host treats a crashed
 * governor the same as a permissive one. K-14's argument, one level lower down —
 * an inert guard and an absent guard are indistinguishable from outside.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { tmpdir, homedir } from "os";

const HOOKS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../hooks");
const HOOKS = readdirSync(HOOKS_DIR).filter((f) => f.endsWith(".mjs"));

describe("every hook loads and exits cleanly", () => {
  it("finds the hooks (the harvest is not stale)", () => {
    expect(HOOKS.length).toBeGreaterThan(8);
  });

  for (const hook of HOOKS) {
    it(`${hook} runs without a load-time error`, () => {
      const dir = mkdtempSync(join(tmpdir(), "evor-hookload-"));
      try {
        const project = join(dir, "project");
        const plugin = join(dir, "plugin");
        const runDir = join(project, ".evor", "runs", "m1", "r1");
        mkdirSync(runDir, { recursive: true });
        mkdirSync(join(plugin, ".evor"), { recursive: true });
        writeFileSync(join(project, ".evor", "active-run.json"), JSON.stringify({ run_id: "r1", mission_id: "m1" }));
        writeFileSync(join(runDir, "tick-state.json"), JSON.stringify({ tick: 1, current_step: 3 }));
        writeFileSync(join(runDir, "mission-state.json"), JSON.stringify({ status: "running" }));
        writeFileSync(join(runDir, "run-state.json"), JSON.stringify({ run_id: "r1", status: "running", tick_count: 1, frontier_ids: [] }));

        const r = spawnSync(process.execPath, [join(HOOKS_DIR, hook)], {
          input: JSON.stringify({
            session_id: "s1",
            agent_type: "oh-my-evor:evor-sage",
            tool_name: "Bash",
            tool_input: { command: "ls" },
            prompt: "hello",
          }),
          cwd: project,
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: homedir(), CLAUDE_PLUGIN_ROOT: plugin },
          encoding: "utf8",
          timeout: 20_000,
        });

        const stderr = r.stderr ?? "";
        expect(
          /ReferenceError|SyntaxError|Cannot find module|ERR_MODULE_NOT_FOUND/.test(stderr),
          `${hook} failed to load:\n${stderr.slice(0, 600)}`,
        ).toBe(false);
        expect(
          r.status,
          `${hook} exited ${r.status}. Hooks signal by 0 (proceed) or 2 (block); anything ` +
            `else is a crash, and a crashed governor is indistinguishable from a permissive one.`,
        ).toBeLessThanOrEqual(2);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
