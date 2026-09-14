/**
 * mcp/tests/bench-arms.test.ts — a bench arm labelled "shipped" must BE shipped.
 *
 * 32 scenarios declared `{"model":"sonnet","label":"shipped"}` for roles that
 * ship on haiku or opus. Not a deliberate choice — a default, labelled
 * "shipped", that nobody checked. Any result from them describes a
 * configuration that does not exist in production, which is RC7's finding
 * exactly: numbers right about a narrower thing than they were quoted for.
 *
 * `wave1-tier-benchmark.test.ts` §D has enforced this for the `evals/<role>/spec.json` suite
 * since Phase 7 — "a spec whose current arm is not the shipped model measures a
 * retier that did not happen". The bench corpus had no equivalent, so it
 * repeated the defect the older gate exists to prevent.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BENCH = join(REPO_ROOT, "evals", "bench");

const shipped = (role: string) => {
  const p = resolve(REPO_ROOT, "agents", `${role}.md`);
  if (!existsSync(p)) return null; // evor-orchestrator has no agent file: it IS the session
  const head = readFileSync(p, "utf8").slice(0, 3000);
  return {
    model: /^model:\s*(\S+)/m.exec(head)?.[1] ?? null,
    effort: /^effort:\s*(\S+)/m.exec(head)?.[1] ?? null,
  };
};

const scenarios: { file: string; sc: any }[] = [];
for (const g of readdirSync(BENCH, { withFileTypes: true }).filter((d) => d.isDirectory())) {
  const gdir = join(BENCH, g.name);
  for (const a of readdirSync(gdir, { withFileTypes: true })) {
    if (!a.isDirectory() || !/^[A-Z]\d$/.test(a.name)) continue;
    for (const f of readdirSync(join(gdir, a.name))) {
      if (f.endsWith(".json")) {
        scenarios.push({ file: join(gdir, a.name, f), sc: JSON.parse(readFileSync(join(gdir, a.name, f), "utf8")) });
      }
    }
  }
}

describe("bench arms measure the tier that ships", () => {
  it("found the corpus", () => expect(scenarios.length).toBeGreaterThan(100));

  it.each(scenarios.map((s) => [s.sc.id, s]))("%s", (_id, { sc }: any) => {
    const arm = (sc.arms ?? [])[0];
    expect(arm, `${sc.id} declares no arm`).toBeDefined();
    const ship = shipped(sc.role);
    if (!ship) return; // orchestrator: no agent file, model is the session's

    if (/shipped|current/i.test(arm.label ?? "")) {
      expect(
        arm.model,
        `${sc.id} calls \`${arm.model}\` the shipped arm, but agents/${sc.role}.md ships ` +
          `\`${ship.model}\`. Every result from this scenario would describe a configuration ` +
          `that does not run.`,
      ).toBe(ship.model);

      // haiku has no `effort`. v1.2.1 stripped the inert declaration from every
      // haiku agent, and agent-frontmatter.test.ts fails on one — passing it
      // here would reintroduce what that cleanup removed.
      if (ship.model === "haiku") {
        expect(arm.effort, `${sc.id} passes effort to haiku, which does not support it`).toBeUndefined();
      }
    }
  });
});
