/**
 * mcp/tests/bench-stub-coverage.test.ts — every tool the stub offers can answer.
 *
 * The lite calibration voided 6 of 6 stub-backed runs. 23 of 31 refused calls
 * were orientation reads — `evor_state_read`, `evor_doctor`, `evor_run_status`
 * — that no scenario had scripted, because the corpus scripts the tool under
 * test and nothing else: 46 stub-backed scenarios, none scripting more than
 * three distinct tools, six scripting none.
 *
 * The stub is loud on an unserved call BY DESIGN, and that design is right: a
 * plausible empty result would teach the agent its call succeeded. So the fix
 * is not to soften the stub but to make sure every tool it OFFERS has a
 * truthful answer available — read from the seeded fixture, which cannot
 * fabricate a success, with any scripted entry still winning.
 *
 * This asserts the invariant rather than the fix: a tool added to the surface
 * without a way to answer it goes red here instead of voiding a scored run.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { deriveFromFixture, globMatch } from "../../evals/bench/mcp/stub-server.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const STUB = join(REPO_ROOT, "evals", "bench", "mcp", "stub-server.mjs");

/** Tools that accept and record rather than answer. */
const SINKS = new Set([
  "evor_write_artifact", "evor_signal_emit", "evor_cite",
  "evor_await_artifact", "evor_gotcha_add",
]);

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

describe("stub coverage", () => {
  it("every evor tool the stub offers is derivable, a sink, or scripted where it is used", () => {
    const src = readFileSync(STUB, "utf8");
    const surface = [...src.matchAll(/^  (evor_\w+): S\(/gm)].map((m) => m[1]);
    expect(surface.length).toBeGreaterThan(10);

    const stubbed = scenarios().filter((s) => /stub-[a-z]+\.json$/.test(s.setup?.mcp_config ?? ""));
    expect(stubbed.length, "no stub-backed scenarios found").toBeGreaterThan(40);

    // Probe derivability against a REAL seeded fixture: `deriveFromFixture`
    // reads EVOR_ROOT, and with none set every tool looks underivable.
    const fx = join(REPO_ROOT, "evals/bench/evidence/fixtures/E2/tick-empty-run/.evor");
    const prev = process.env.EVOR_ROOT;
    process.env.EVOR_ROOT = fx;
    const derivable = new Set<string>();
    try {
      for (const tool of surface) if (deriveFromFixture(tool, {}) !== null) derivable.add(tool);
    } finally {
      if (prev === undefined) delete process.env.EVOR_ROOT; else process.env.EVOR_ROOT = prev;
    }

    const unanswerable: string[] = [];
    for (const tool of surface) {
      if (SINKS.has(tool)) continue;
      if (derivable.has(tool)) continue;
      // Otherwise every scenario that references it must script it.
      for (const s of stubbed) {
        if (!JSON.stringify(s).includes(tool)) continue;
        const scripted = (s.setup?.tool_results ?? []).some((e: any) => e.tool === tool);
        if (!scripted) unanswerable.push(`${s.id}: ${tool}`);
      }
    }
    expect(unanswerable, `tools that would refuse a call and void the run:\n${unanswerable.join("\n")}`).toEqual([]);
  });

  it("a widened literature search returns an empty result, never an outage", () => {
    const research = scenarios().filter((s) => String(s.setup?.mcp_config ?? "").includes("stub-research"));
    expect(research.length).toBeGreaterThan(0);
    for (const s of research) {
      for (const tool of ["search_papers", "search_snippets"]) {
        const entries = (s.setup?.tool_results ?? []).filter((e: any) => e.tool === tool);
        const catchAll = entries.find((e: any) => e.match?.query === "*");
        expect(catchAll, `${s.id} has no catch-all for ${tool}`).toBeTruthy();
        // Truthful emptiness — never a fabricated hit.
        const body = JSON.stringify(catchAll.content);
        expect(body).toMatch(/\[\]/);
      }
    }
  });

  it("resolve_doi is deliberately left without a catch-all", () => {
    // Identifier resolution is the condition E1's pairs turn on. A catch-all
    // there would answer the question the scenario is asking.
    const research = scenarios().filter((s) => String(s.setup?.mcp_config ?? "").includes("stub-research"));
    for (const s of research) {
      const wild = (s.setup?.tool_results ?? []).filter((e: any) => e.tool === "resolve_doi" && e.match?.doi === "*");
      expect(wild, `${s.id} gained a resolve_doi catch-all`).toEqual([]);
    }
  });

  it("matching is case-insensitive, so an authored entry fires on natural queries", () => {
    // 8 of the calibration's refused calls were entries that existed and never
    // matched: `*palm-leaf*` against "palm leaf manuscript binarization".
    expect(globMatch("*DIBCO*", "dibco 2017 benchmark")).toBe(true);
    expect(globMatch("*IAM*", "iam handwriting database")).toBe(true);
    expect(globMatch("*palm-leaf*", "PALM-LEAF dataset")).toBe(true);
    // Still a real filter, not a free pass.
    expect(globMatch("*DIBCO*", "palm leaf manuscripts")).toBe(false);
  });

  it("a derived read reports the fixture, and reports absence as absence", () => {
    const fx = join(REPO_ROOT, "evals/bench/evidence/fixtures/E2/tick-empty-run/.evor");
    const prev = process.env.EVOR_ROOT;
    process.env.EVOR_ROOT = fx;
    try {
      const state: any = deriveFromFixture("evor_state_read", { run_id: "run-live-01" });
      expect(state.ok).toBe(true);
      expect(state.state.run_id).toBe("run-live-01");
      // The artifact this fixture does NOT seed must come back not-found — that
      // absence is E2's condition, and inventing a payload would erase it.
      const art: any = deriveFromFixture("evor_read_artifact", { tick: 2, agent: "forge" });
      expect(art.ok).toBe(false);
      expect(art.error).toMatch(/not found/);
    } finally {
      if (prev === undefined) delete process.env.EVOR_ROOT; else process.env.EVOR_ROOT = prev;
    }
  });
});
