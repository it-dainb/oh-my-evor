/**
 * mcp/tests/schema-expressiveness.test.ts — C5 Stage 3
 *
 * Rubric rule 1: design expressive tool interfaces instead of documenting usage
 * in prose. Where a constraint can live in the schema, prose describing it is
 * both redundant and unenforced.
 *
 * Three concrete instances, each verified against the real source:
 *
 *  - `evor_state_write` accepts `mission_status: "locked"`, which is exactly the
 *    escape hatch `evor_lock_mission`'s description warns against in prose
 *    ("always call this instead of writing mission_status='locked' directly").
 *    Removing the enum member replaces a paragraph with an impossibility.
 *    Safe: `lockMission` sets `ms.status = "locked"` directly (state.ts), never
 *    through this patch schema — checked before changing it.
 *
 *  - `evor_wiki_get_relevant` / `evor_wiki_query` REQUIRE a `run_id` they never
 *    use: destructured, echoed back, never passed to the query function. Agents
 *    were failing schema validation on a field the tool discards.
 *
 *  - `evor_cite` / `evor_write_artifact` / `evor_signal_emit` require `run_id`
 *    with no fallback, while `evor_run_status` already resolves `job_id` from
 *    active-run.json and `evor_signal_emit` already gives `mission_id` that
 *    treatment. Optional-with-fallback removes the 3x-repeated `evor_cite`
 *    failure by construction; format hints would only make it more diagnosable.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const TOOLS = resolve(dirname(fileURLToPath(import.meta.url)), "../src/tools");
const read = (f: string) => readFileSync(join(TOOLS, f), "utf8");

/** Body of a `server.tool("name", ...)` registration, up to the next one. */
function toolBlock(src: string, name: string): string {
  const start = src.indexOf(`"${name}"`);
  if (start === -1) throw new Error(`tool ${name} not found`);
  const next = src.indexOf("server.tool(", start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

describe("evor_state_write cannot be used to self-lock a mission", () => {
  it("mission_status enum excludes 'locked'", () => {
    const src = read("state.ts");
    const enumLine = src.match(/z\.enum\(\[[^\]]*"draft"[^\]]*\]\)/);
    expect(enumLine, "mission_status enum not found").toBeTruthy();
    expect(
      enumLine![0],
      "'locked' must be reachable only through evor_lock_mission — the enum is the enforcement, the prose warning is not",
    ).not.toMatch(/"locked"/);
  });

  it("still permits the ordinary lifecycle states", () => {
    const enumLine = read("state.ts").match(/z\.enum\(\[[^\]]*"draft"[^\]]*\]\)/)![0];
    for (const s of ["draft", "running", "paused", "completed", "failed"]) {
      expect(enumLine).toMatch(new RegExp(`"${s}"`));
    }
  });
});

describe("wiki query tools do not require a run_id they discard", () => {
  // evor_wiki_get_relevant was folded into evor_wiki_query (see the merge suite
  // below), so only the surviving tool is checked here.
  for (const tool of ["evor_wiki_query"]) {
    it(`${tool}: run_id is optional`, () => {
      const block = toolBlock(read("wiki.ts"), tool);
      const m = block.match(/run_id:\s*z\.string\(\)([^,\n]*)/);
      expect(m, `${tool} has no run_id param`).toBeTruthy();
      // Kept and ignored rather than deleted: removing a parameter is not
      // automatically backward-compatible, since a caller still passing it can
      // be rejected by strict-object validation (pre-mortem PM3).
      expect(
        m![0],
        `${tool} still REQUIRES a run_id it never uses — agents fail validation on a discarded field`,
      ).toMatch(/optional\(\)/);
    });
  }

  it("evor_wiki_add keeps run_id required — it genuinely uses it", () => {
    const block = toolBlock(read("wiki.ts"), "evor_wiki_add");
    expect(block).toMatch(/run_id:\s*z\.string\(\)/);
    expect(block.match(/run_id:\s*z\.string\(\)([^,\n]*)/)![0]).not.toMatch(/optional\(\)/);
  });
});

describe("run_id resolves from the active run instead of failing validation", () => {
  const cases: Array<[string, string]> = [
    ["cite.ts", "evor_cite"],
    ["artifact.ts", "evor_write_artifact"],
    ["signals.ts", "evor_signal_emit"],
  ];
  for (const [file, tool] of cases) {
    it(`${tool}: run_id is optional with an active-run fallback`, () => {
      const block = toolBlock(read(file), tool);
      const m = block.match(/run_id:\s*z\.string\(\)([^,\n]*)/);
      expect(m, `${tool} has no run_id param`).toBeTruthy();
      expect(m![0], `${tool} requires run_id with no fallback`).toMatch(/optional\(\)/);
    });
  }

  it("a shared resolver exists rather than three ad-hoc lookups", () => {
    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../src/active-run.ts"),
      "utf8",
    );
    expect(src).toMatch(/export function resolveRunId/);
  });
});

describe("wiki search is one tool with a mode, not two that recommend each other", () => {
  // Rubric rule 1: two tools whose descriptions cross-recommend each other
  // ("Prefer this over evor_wiki_query…" / "Prefer evor_wiki_get_relevant…") are
  // a design smell, not a documentation problem. An enum states the choice in the
  // interface and removes the prose entirely.
  //
  // Safe to fold get_relevant into query: it has ZERO references anywhere in
  // agents/ or skills/, while evor_wiki_query is referenced in 6 files. Removing
  // the referenced one would have been the breaking direction.
  const wiki = readFileSync(join(TOOLS, "wiki.ts"), "utf8");

  it("no longer registers evor_wiki_get_relevant", () => {
    expect(wiki).not.toMatch(/server\.tool\(\s*\n?\s*"evor_wiki_get_relevant"/);
  });

  it("evor_wiki_query takes a mode enum", () => {
    const block = toolBlock(wiki, "evor_wiki_query");
    expect(block).toMatch(/mode:\s*z\s*\n?\s*\.enum\(\["semantic",\s*"keyword"\]\)/);
  });

  it("carries no cross-recommending prose", () => {
    // The enum IS the preference statement.
    expect(wiki).not.toMatch(/Prefer (this over )?evor_wiki/);
  });
});
