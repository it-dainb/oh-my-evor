/**
 * mcp/tests/bench-sandbox.test.ts — the environment a scenario is graded in.
 *
 * Five defects found by reading the pilot's own logs, all of them the runner's
 * and every one of them scored against a model:
 *
 *   1. `setup.overlay` was never applied (31 scenarios, including all eight A3).
 *   2. `setup.plugin_fixture` was never copied (60 scenarios).
 *   3. `{{...}}` in `prompt`/`follow_ups` was never bound (48 scenarios) — the
 *      model was shown the literal braces.
 *   4. The child process inherited the REPO as its working directory, so every
 *      relative Read/Glob/Bash addressed the live tree instead of the sandbox.
 *   5. The control arm referenced a variable from another function, threw, and
 *      was swallowed — so it never ran, and reported "unchanged" regardless.
 *
 * These assert the contract rather than the fix, so a future refactor that
 * loses one of them goes red here.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, rmSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { buildSandbox, bindTemplates } from "../../ci/bench-run.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** A real scenario, so the contract is pinned against the corpus, not a mock. */
function scenario(id: string): any {
  const bench = join(REPO_ROOT, "evals", "bench");
  for (const g of readdirSync(bench, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    for (const a of readdirSync(join(bench, g.name), { withFileTypes: true }).filter((d) => d.isDirectory())) {
      const p = join(bench, g.name, a.name, `${id}.json`);
      if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
    }
  }
  throw new Error(`scenario ${id} not found`);
}

describe("bench sandbox", () => {
  it("applies setup.overlay into the project root", () => {
    // A3-best-score-pos's overlay IS the stimulus: a results.json whose
    // integrity_report.verdict is "failed". Without it the agent answered "the
    // referenced results file and node don't exist anywhere in this run" and
    // was scored FN for declining to fabricate one.
    const sc = scenario("A3-best-score-pos");
    const rel = Object.keys(sc.setup.overlay)[0];
    expect(rel).toContain("results.json");
    const sb = buildSandbox(sc, join(REPO_ROOT, sc.setup.cwd_fixture));
    try {
      const dest = join(sb.projectRoot, rel);
      expect(existsSync(dest), `overlay ${rel} was not written`).toBe(true);
      expect(JSON.parse(readFileSync(dest, "utf8")).integrity_report.verdict).toBe("failed");
    } finally {
      rmSync(sb.work, { recursive: true, force: true });
    }
  });

  it("layers setup.plugin_fixture over the repo trees without erasing them", () => {
    const sc = scenario("A3-best-score-pos");
    expect(sc.setup.plugin_fixture).toBeTruthy();
    const sb = buildSandbox(sc, join(REPO_ROOT, sc.setup.cwd_fixture));
    try {
      // From the fixture — absent from the repo trees the runner copies.
      expect(
        existsSync(join(sb.pluginRoot, ".claude-plugin", "plugin.json")),
        "the plugin fixture's manifest is missing: scenarios about the plugin's declared surface would run against a plugin with none",
      ).toBe(true);
      // From the repo — the fixture names only what it varies.
      expect(existsSync(join(sb.pluginRoot, "skills", "evor", "SKILL.md"))).toBe(true);
    } finally {
      rmSync(sb.work, { recursive: true, force: true });
    }
  });

  it("resolves env templates against the two roots", () => {
    const sc = scenario("A3-best-score-pos");
    const sb = buildSandbox(sc, join(REPO_ROOT, sc.setup.cwd_fixture));
    try {
      expect(sb.env.EVOR_ROOT).toBe(join(sb.projectRoot, ".evor"));
      expect(sb.env.CLAUDE_PLUGIN_ROOT).toBe(sb.pluginRoot);
      expect(JSON.stringify(sb.env)).not.toContain("{{");
    } finally {
      rmSync(sb.work, { recursive: true, force: true });
    }
  });

  it("binds every prompt placeholder and refuses to guess at an unbound one", () => {
    const sc = scenario("A3-hypothesis-verdict-pos");
    expect(sc.prompt).toContain("{{ASK}}");
    const bound = bindTemplates(sc.prompt, { ...sc.setup.substitutions }, "t");
    expect(bound).not.toContain("{{");
    expect(bound).toContain(sc.setup.substitutions.ASK);
    // The mutation: drop the binding and it must throw, not pass the braces on.
    expect(() => bindTemplates(sc.prompt, {}, "A3-hypothesis-verdict-pos: prompt")).toThrow(/\{\{ASK\}\}/);
  });

  it("the runner starts the agent inside the sandbox, never in the repo", () => {
    // Grepping the source is the only offline way to assert a spawn option.
    // The failure it prevents is not hypothetical: pilot runs writing through
    // an inherited repo cwd mutated three fixtures under evals/bench.
    const src = readFileSync(join(REPO_ROOT, "ci", "bench-run.mjs"), "utf8");
    expect(src.match(/cwd: projectRoot/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    for (const f of ["ci/knowledge-live-eval.mjs", "ci/bench-trace.mjs"]) {
      expect(readFileSync(join(REPO_ROOT, f), "utf8")).toContain("...(cwd ? { cwd } : {})");
    }
  });

  it("a control arm that cannot run raises instead of reporting 'unchanged'", () => {
    const src = readFileSync(join(REPO_ROOT, "ci", "bench-run.mjs"), "utf8");
    expect(src).not.toMatch(/\}\s*catch\s*\{\s*\/\* a control arm that cannot run/);
    expect(src).toMatch(/control arm did not run/);
  });
});
