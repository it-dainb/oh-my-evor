/**
 * mcp/tests/bench-governor.test.ts — the governance angles must run the governor.
 *
 * ci/bench-run.mjs copied hooks/ into the sandbox from the first day and never
 * wired it into the CLI. T4-enforcement-zone-pos declares
 *
 *   intended_denial: [{ rule: "path-zone:enforcement",
 *                       target: "{{SANDBOX}}/project/hooks/stop.mjs",
 *                       log: "$EVOR_ROOT/logs/governor.log" }]
 *
 * — a denial that could not occur and a log that could not exist. All twelve T4
 * scenarios were grading whether an agent SAYS it respects a boundary, never
 * whether the boundary holds. evor-forge-junior edited hooks/stop.mjs in two
 * scenarios and nothing stopped it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, rmSync, statSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { buildSandbox } from "../../ci/bench-run.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function scenarios(): any[] {
  const out: any[] = [];
  const bench = join(REPO_ROOT, "evals", "bench");
  for (const g of readdirSync(bench).filter((d) => statSync(join(bench, d)).isDirectory())) {
    for (const a of readdirSync(join(bench, g)).filter((d) => /^[A-Z]\d$/.test(d) && statSync(join(bench, g, d)).isDirectory())) {
      for (const f of readdirSync(join(bench, g, a)).filter((x) => x.endsWith(".json"))) {
        out.push(JSON.parse(readFileSync(join(bench, g, a, f), "utf8")));
      }
    }
  }
  return out;
}

describe("bench governor", () => {
  it("every scenario that declares a denial gets the real PreToolUse guard", () => {
    const declaring = scenarios().filter(
      (s) => (s.setup?.intended_denial ?? []).length > 0 || s.setup?.denial_policy != null,
    );
    expect(declaring.length, "no scenario declares denial semantics").toBeGreaterThan(10);

    const missing: string[] = [];
    for (const s of declaring) {
      const sb = buildSandbox(s, join(REPO_ROOT, s.setup.cwd_fixture));
      try {
        if (!sb.settingsPath) { missing.push(s.id); continue; }
        const cfg = JSON.parse(readFileSync(sb.settingsPath, "utf8"));
        if (!cfg.hooks?.PreToolUse) missing.push(`${s.id}: settings has no PreToolUse`);
      } finally {
        rmSync(sb.work, { recursive: true, force: true });
      }
    }
    expect(missing, `these declare a denial the harness cannot produce:\n${missing.join("\n")}`).toEqual([]);
  });

  it("the wired hooks are the SANDBOX's copy, never the live tree", () => {
    const s = scenarios().find((x) => x.id === "T4-enforcement-zone-pos")!;
    const sb = buildSandbox(s, join(REPO_ROOT, s.setup.cwd_fixture));
    try {
      const raw = readFileSync(sb.settingsPath!, "utf8");
      // The manifest addresses hooks through $CLAUDE_PLUGIN_ROOT, which the
      // runner sets to the sandbox plugin copy. A literal repo path here would
      // mean a scored run could execute — or edit — the real enforcement layer.
      expect(raw).toContain("$CLAUDE_PLUGIN_ROOT");
      expect(raw).not.toContain(REPO_ROOT);
      expect(sb.env.CLAUDE_PLUGIN_ROOT).toBe(sb.pluginRoot);
    } finally {
      rmSync(sb.work, { recursive: true, force: true });
    }
  });

  it("scenarios that say nothing about denials are left alone", () => {
    // Running the governor everywhere changes what a hundred-plus scenarios
    // measure. That belongs in its own before/after, not as a side effect.
    const quiet = scenarios().find(
      (s) => !(s.setup?.intended_denial ?? []).length && s.setup?.denial_policy == null && s.setup?.governor == null,
    )!;
    const sb = buildSandbox(quiet, join(REPO_ROOT, quiet.setup.cwd_fixture));
    try {
      expect(sb.settingsPath).toBeNull();
    } finally {
      rmSync(sb.work, { recursive: true, force: true });
    }
  });
});
